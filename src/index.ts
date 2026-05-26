import { parseRoutesFromEnv } from "./config";
import {
  buildTargetUrl,
  createProxyHeaders,
  createUpstreamWebSocketHeaders,
  isWebSocketUpgradeRequest,
  matchRoute,
  toWebSocketUrl,
} from "./proxy";

type ProxyWebSocketSession = {
  upstream: WebSocket;
  clientOpened: boolean;
  pendingFromUpstream: Array<string | Buffer>;
  clientClosed: boolean;
  upstreamClosed: boolean;
};

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
  payload: string | ArrayBufferLike | ArrayBufferView,
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

  const upstream = new WebSocket(toWebSocketUrl(targetUrl), {
    protocols,
    headers: createUpstreamWebSocketHeaders(request),
  });

  upstream.binaryType = "nodebuffer";

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
  routes?: ReturnType<typeof parseRoutesFromEnv>;
}) {
  const port = options?.port ?? Number(process.env.PORT ?? 3000);
  const routes = options?.routes ?? parseRoutesFromEnv();

  const server = Bun.serve<ProxyWebSocketSession>({
    port,
    async fetch(request, server) {
      const requestUrl = new URL(request.url);

      if (requestUrl.pathname === "/health") {
        return Response.json({
          ok: true,
          routes: routes.map((route) => ({
            prefix: route.normalizedPrefix,
            target: route.target.origin + route.target.pathname,
          })),
        });
      }

      const matchedRoute = matchRoute(requestUrl.pathname, routes);

      if (!matchedRoute) {
        return new Response("No proxy route matched.", { status: 404 });
      }

      const targetUrl = buildTargetUrl(requestUrl, matchedRoute);

      if (isWebSocketUpgradeRequest(request)) {
        try {
          const upstream = await openUpstreamWebSocket(request, targetUrl);
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
              target: toWebSocketUrl(targetUrl),
            },
            { status: 502 },
          );
        }
      }

      const upstreamRequest = new Request(targetUrl, {
        method: request.method,
        headers: createProxyHeaders(
          request,
          requestUrl,
          targetUrl,
          matchedRoute.normalizedPrefix,
        ),
        body: request.body,
        redirect: "manual",
        duplex: "half",
      });

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
          ws.data.upstream.ping(data);
        }
      },
      pong(ws, data) {
        if (ws.data.upstream.readyState === WebSocket.OPEN) {
          ws.data.upstream.pong(data);
        }
      },
      idleTimeout: 0,
    },
  });

  return server;
}

const sessionClientMap = new WeakMap<
  ProxyWebSocketSession,
  ServerWebSocket<ProxyWebSocketSession>
>();

if (import.meta.main) {
  const routes = parseRoutesFromEnv();
  const server = createGatewayServer({ routes });

  console.log(`Gateway listening on port ${server.port}`);
  console.log(
    `Configured routes: ${routes
      .map((route) => `${route.normalizedPrefix} -> ${route.target.toString()}`)
      .join(", ")}`,
  );
}
