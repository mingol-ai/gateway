import type {
  BufferSource as BunBufferSource,
  ServerWebSocket,
  WebSocketHandler,
} from "bun";
import type { GatewayConfig } from "./config";
import { parseRoutesFromEnv } from "./config";
import {
  buildTargetUrl,
  buildTargetWebSocketUrl,
  createProxyHeaders,
  createUpstreamWebSocketHeaders,
  isWebSocketUpgradeRequest,
  matchRoute,
} from "./proxy";

type ProxyWebSocketSession = {
  upstream: WebSocket;
  clientOpened: boolean;
  pendingFromUpstream: Array<string | Buffer>;
  clientClosed: boolean;
  upstreamClosed: boolean;
};

export type GatewayWebSocketOptions = Pick<
  WebSocketHandler<ProxyWebSocketSession>,
  "maxPayloadLength" | "backpressureLimit" | "closeOnBackpressureLimit" | "idleTimeout"
>;

function normalizeCloseReason(reason: string): string {
  return reason.length > 123 ? reason.slice(0, 123) : reason;
}

function closeClientSocket(
  ws: ServerWebSocket<ProxyWebSocketSession>,
  code = 1011,
  reason = "Upstream socket closed",
) {
  if (!ws.data.clientClosed) {
    ws.data.clientClosed = true;
    ws.close(code, normalizeCloseReason(reason));
  }
}

function closeUpstreamSocket(
  session: ProxyWebSocketSession,
  code = 1000,
  reason?: string,
) {
  if (!session.upstreamClosed && session.upstream.readyState < WebSocket.CLOSING) {
    session.upstreamClosed = true;
    session.upstream.close(code, reason);
  }
}

function sendToClient(
  ws: ServerWebSocket<ProxyWebSocketSession>,
  payload: string | BunBufferSource,
) {
  if (typeof payload === "string") {
    ws.sendText(payload);
    return;
  }

  ws.sendBinary(payload);
}

async function openUpstreamWebSocket(request: Request, targetUrl: URL) {
  const protocols = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);

  const upstream = new WebSocket(targetUrl.toString(), {
    protocols,
    headers: createUpstreamWebSocketHeaders(request),
  } as any);

  (upstream as any).binaryType = "nodebuffer";

  await new Promise<void>((resolve, reject) => {
    upstream.addEventListener("open", () => resolve(), { once: true });
    upstream.addEventListener(
      "error",
      () => reject(new Error("Failed to connect upstream WebSocket.")),
      { once: true },
    );
    upstream.addEventListener(
      "close",
      (event) =>
        reject(
          new Error(
            `Upstream WebSocket closed during handshake (${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
          ),
        ),
      { once: true },
    );
  });

  return upstream;
}

export function createGatewayServer(options?: {
  port?: number;
  config?: GatewayConfig;
  websocket?: GatewayWebSocketOptions;
}) {
  const port = options?.port ?? Number(process.env.PORT ?? 3000);
  const config = options?.config ?? parseRoutesFromEnv();
  const websocketOptions = options?.websocket ?? parseWebSocketOptionsFromEnv();
  const healthPayload = {
    ok: true,
    routes: config.routes.map((route) => ({
      prefix: route.normalizedPrefix,
      target: `${route.target.origin}${route.targetBasePath || "/"}`,
    })),
  };
  const configuredRoutesLine = config.routes
    .map((route) => `${route.normalizedPrefix} -> ${route.target.toString()}`)
    .join(", ");

  const server = Bun.serve<ProxyWebSocketSession>({
    port,
    async fetch(request, server) {
      const requestUrl = new URL(request.url);

      if (requestUrl.pathname === "/health") {
        return Response.json(healthPayload);
      }

      const matchedRoute = matchRoute(requestUrl.pathname, config.matcher);

      if (!matchedRoute) {
        return new Response("No proxy route matched.", { status: 404 });
      }

      if (isWebSocketUpgradeRequest(request)) {
        try {
          const upstreamTargetUrl = buildTargetWebSocketUrl(requestUrl, matchedRoute);
          const upstream = await openUpstreamWebSocket(
            request,
            new URL(upstreamTargetUrl),
          );
          const session: ProxyWebSocketSession = {
            upstream,
            clientOpened: false,
            pendingFromUpstream: [],
            clientClosed: false,
            upstreamClosed: false,
          };

          upstream.addEventListener("message", (event) => {
            const payload = event.data as string | Buffer;

            if (!session.clientOpened) {
              session.pendingFromUpstream.push(payload);
              return;
            }

            const clientSocket = sessionClientMap.get(session);
            if (!clientSocket || session.clientClosed) {
              return;
            }

            sendToClient(clientSocket, payload);
          });

          upstream.addEventListener("close", (event) => {
            session.upstreamClosed = true;
            const clientSocket = sessionClientMap.get(session);
            if (clientSocket) {
              closeClientSocket(
                clientSocket,
                event.code || 1000,
                event.reason || "Upstream WebSocket closed",
              );
            }
          });

          upstream.addEventListener("error", () => {
            const clientSocket = sessionClientMap.get(session);
            closeUpstreamSocket(session, 1011, "Upstream WebSocket error");
            if (clientSocket) {
              closeClientSocket(clientSocket, 1011, "Upstream WebSocket error");
            }
          });

          const responseHeaders = new Headers();
          if (upstream.protocol) {
            responseHeaders.set("Sec-WebSocket-Protocol", upstream.protocol);
          }

          const upgraded = server.upgrade(request, {
            headers: responseHeaders,
            data: session,
          });

          if (!upgraded) {
            closeUpstreamSocket(session, 1011, "Client upgrade failed");
            return new Response("WebSocket upgrade failed.", { status: 400 });
          }

          return;
        } catch (error) {
          return Response.json(
            {
              error: "Bad gateway",
              message: error instanceof Error ? error.message : "Unknown error",
              target: buildTargetWebSocketUrl(requestUrl, matchedRoute),
            },
            { status: 502 },
          );
        }
      }

      const targetUrl = buildTargetUrl(requestUrl, matchedRoute);
      const upstreamRequest = new Request(targetUrl, {
        method: request.method,
        headers: createProxyHeaders(
          request,
          requestUrl,
          matchedRoute.target.host,
          matchedRoute.normalizedPrefix,
        ),
        body: request.body,
        redirect: "manual",
        duplex: "half",
      } as any);

      try {
        return await fetch(upstreamRequest);
      } catch (error) {
        return Response.json(
          {
            error: "Bad gateway",
            message: error instanceof Error ? error.message : "Unknown error",
            target: targetUrl.toString(),
          },
          { status: 502 },
        );
      }
    },
    websocket: {
      data: {} as ProxyWebSocketSession,
      open(ws) {
        ws.data.clientOpened = true;
        sessionClientMap.set(ws.data, ws);

        for (const payload of ws.data.pendingFromUpstream) {
          sendToClient(ws, payload);
        }

        ws.data.pendingFromUpstream = [];
      },
      message(ws, message) {
        if (ws.data.clientClosed || ws.data.upstream.readyState !== WebSocket.OPEN) {
          closeClientSocket(ws, 1011, "Upstream WebSocket unavailable");
          return;
        }

        ws.data.upstream.send(message);
      },
      close(ws, code, reason) {
        sessionClientMap.delete(ws.data);
        ws.data.clientClosed = true;
        closeUpstreamSocket(ws.data, code, reason);
      },
      ping(ws, data) {
        if (ws.data.upstream.readyState === WebSocket.OPEN) {
          (ws.data.upstream as any).ping(data);
        }
      },
      pong(ws, data) {
        if (ws.data.upstream.readyState === WebSocket.OPEN) {
          (ws.data.upstream as any).pong(data);
        }
      },
      maxPayloadLength: websocketOptions.maxPayloadLength,
      backpressureLimit: websocketOptions.backpressureLimit,
      closeOnBackpressureLimit: websocketOptions.closeOnBackpressureLimit,
      idleTimeout: websocketOptions.idleTimeout ?? 0,
    },
  });

  return {
    server,
    config,
    configuredRoutesLine,
  };
}

const sessionClientMap = new WeakMap<
  ProxyWebSocketSession,
  ServerWebSocket<ProxyWebSocketSession>
>();

function parseWebSocketOptionsFromEnv(
  env = process.env,
): GatewayWebSocketOptions {
  return {
    maxPayloadLength: parseOptionalInteger(env.WS_MAX_PAYLOAD_LENGTH),
    backpressureLimit: parseOptionalInteger(env.WS_BACKPRESSURE_LIMIT),
    closeOnBackpressureLimit: parseOptionalBoolean(env.WS_CLOSE_ON_BACKPRESSURE_LIMIT),
    idleTimeout: parseOptionalInteger(env.WS_IDLE_TIMEOUT) ?? 0,
  };
}

function parseOptionalInteger(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Expected non-negative integer, received "${raw}".`);
  }

  return Math.trunc(value);
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`Expected boolean "true" or "false", received "${raw}".`);
}

if (import.meta.main) {
  const config = parseRoutesFromEnv();
  const gateway = createGatewayServer({ config });

  console.log(`Gateway listening on port ${gateway.server.port}`);
  console.log(`Configured routes: ${gateway.configuredRoutesLine}`);
}
