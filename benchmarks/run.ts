import { createGatewayServer, type GatewayWebSocketOptions } from "../src/index";
import { parseRoutesFromEnv } from "../src/config";

type BenchmarkResult = {
  scenario: string;
  routeCount: number;
  headerCount: number;
  durationMs: number;
  requestsPerSecond?: number;
  averageLatencyMs?: number;
  p95LatencyMs?: number;
  sseConnectionsPerSecond?: number;
  sseAverageConnectMs?: number;
  wsMessagesPerSecond?: number;
  wsAverageRttMs?: number;
  wsClosedClients?: number;
  notes?: string;
};

type GatewayInstance = ReturnType<typeof createGatewayServer>;

const encoder = new TextEncoder();

async function main() {
  const upstream = createUpstreamServer();
  const results: BenchmarkResult[] = [];

  try {
    const routeCounts = [1, 100, 1000];
    const headerCounts = [0, 20, 100];

    for (const routeCount of routeCounts) {
      for (const headerCount of headerCounts) {
        const gateway = createGateway({
          routeCount,
          upstreamPort: upstream.port,
        });

        try {
          results.push(
            await benchmarkHttp({
              gatewayPort: gateway.server.port,
              routeCount,
              headerCount,
              requests: 2000,
              concurrency: 100,
            }),
          );

          results.push(
            await benchmarkSse({
              gatewayPort: gateway.server.port,
              routeCount,
              headerCount,
              clients: 40,
              eventsPerClient: 10,
            }),
          );

          results.push(
            await benchmarkWebSocket({
              gatewayPort: gateway.server.port,
              routeCount,
              headerCount,
              clients: 80,
              messagesPerClient: 20,
            }),
          );
        } finally {
          gateway.server.stop(true);
        }
      }
    }

    const mixedGateway = createGateway({
      routeCount: 500,
      upstreamPort: upstream.port,
    });

    try {
      results.push(
        await benchmarkMixedLoad({
          gatewayPort: mixedGateway.server.port,
          routeCount: 500,
          headerCount: 20,
        }),
      );
    } finally {
      mixedGateway.server.stop(true);
    }

    const backpressureScenarios: Array<{
      name: string;
      websocket: GatewayWebSocketOptions;
    }> = [
      {
        name: "ws-backpressure-buffer",
        websocket: {
          backpressureLimit: 16 * 1024 * 1024,
          closeOnBackpressureLimit: false,
          idleTimeout: 0,
        },
      },
      {
        name: "ws-backpressure-close",
        websocket: {
          backpressureLimit: 256 * 1024,
          closeOnBackpressureLimit: true,
          idleTimeout: 0,
        },
      },
    ];

    for (const scenario of backpressureScenarios) {
      const gateway = createGateway({
        routeCount: 50,
        upstreamPort: upstream.port,
        websocket: scenario.websocket,
      });

      try {
        results.push(
          await benchmarkWebSocketBackpressure({
            scenario: scenario.name,
            gatewayPort: gateway.server.port,
          }),
        );
      } finally {
        gateway.server.stop(true);
      }
    }

    renderResults(results);
  } finally {
    upstream.stop(true);
  }
}

function createGateway(options: {
  routeCount: number;
  upstreamPort: number;
  websocket?: GatewayWebSocketOptions;
}): GatewayInstance {
  const routes = buildRoutes(options.routeCount, options.upstreamPort);
  return createGatewayServer({
    port: 0,
    config: parseRoutesFromEnv({
      PROXY_ROUTES: JSON.stringify(routes),
    }),
    websocket: options.websocket,
  });
}

function buildRoutes(routeCount: number, upstreamPort: number) {
  const routes = Array.from({ length: routeCount }, (_, index) => ({
    prefix: `/unused-${index}`,
    target: `http://127.0.0.1:${upstreamPort}/discard/${index}`,
  }));

  routes.push(
    { prefix: "/api", target: `http://127.0.0.1:${upstreamPort}/http` },
    { prefix: "/events", target: `http://127.0.0.1:${upstreamPort}/sse` },
    { prefix: "/ws", target: `http://127.0.0.1:${upstreamPort}/ws` },
    { prefix: "/burst", target: `http://127.0.0.1:${upstreamPort}/burst` },
  );

  return routes;
}

function createUpstreamServer() {
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/burst")) {
        const upgraded = server.upgrade(request, {
          data: {
            mode: url.pathname.startsWith("/burst") ? "burst" : "echo",
          },
        });

        if (upgraded) {
          return;
        }
      }

      if (url.pathname.startsWith("/discard/")) {
        return new Response("ok");
      }

      if (url.pathname.startsWith("/http")) {
        return Response.json({
          ok: true,
          path: url.pathname,
          query: url.searchParams.get("q") ?? "",
        });
      }

      if (url.pathname.startsWith("/sse")) {
        const eventCount = Number(url.searchParams.get("count") ?? "10");
        const intervalMs = Number(url.searchParams.get("interval") ?? "10");
        let sent = 0;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const timer = setInterval(() => {
              sent += 1;
              controller.enqueue(
                encoder.encode(`event: tick\ndata: ${sent}\n\n`),
              );

              if (sent >= eventCount) {
                clearInterval(timer);
                controller.close();
              }
            }, intervalMs);
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      data: {} as { mode: "echo" | "burst" },
      open(ws) {
        if (ws.data.mode !== "burst") {
          return;
        }

        const chunk = "x".repeat(32 * 1024);
        for (let index = 0; index < 512; index += 1) {
          ws.sendText(chunk);
        }
      },
      message(ws, message) {
        if (ws.data.mode === "echo") {
          ws.send(typeof message === "string" ? message : message);
        }
      },
    },
  });
}

async function benchmarkHttp(options: {
  gatewayPort: number;
  routeCount: number;
  headerCount: number;
  requests: number;
  concurrency: number;
}): Promise<BenchmarkResult> {
  const headers = buildHeaders(options.headerCount);
  const latencies: number[] = [];
  let nextRequest = 0;

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: options.concurrency }, async () => {
      while (true) {
        const requestId = nextRequest;
        nextRequest += 1;

        if (requestId >= options.requests) {
          break;
        }

        const requestStart = performance.now();
        const response = await fetch(
          `http://127.0.0.1:${options.gatewayPort}/api/resource?q=${requestId}`,
          {
            headers,
          },
        );
        await response.text();
        latencies.push(performance.now() - requestStart);
      }
    }),
  );
  const durationMs = performance.now() - startedAt;

  return {
    scenario: "http",
    routeCount: options.routeCount,
    headerCount: options.headerCount,
    durationMs,
    requestsPerSecond: (options.requests / durationMs) * 1000,
    averageLatencyMs: average(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

async function benchmarkSse(options: {
  gatewayPort: number;
  routeCount: number;
  headerCount: number;
  clients: number;
  eventsPerClient: number;
}): Promise<BenchmarkResult> {
  const headers = buildHeaders(options.headerCount);
  const connectLatencies: number[] = [];

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: options.clients }, async (_, index) => {
      const connectStart = performance.now();
      const response = await fetch(
        `http://127.0.0.1:${options.gatewayPort}/events/stream?count=${options.eventsPerClient}&interval=5&client=${index}`,
        { headers },
      );
      connectLatencies.push(performance.now() - connectStart);

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("SSE response body is missing.");
      }

      let events = 0;
      let buffer = "";

      while (events < options.eventsPerClient) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += new TextDecoder().decode(value);
        events += (buffer.match(/\n\n/g) ?? []).length;

        if (events >= options.eventsPerClient) {
          await reader.cancel();
          break;
        }
      }
    }),
  );
  const durationMs = performance.now() - startedAt;

  return {
    scenario: "sse",
    routeCount: options.routeCount,
    headerCount: options.headerCount,
    durationMs,
    sseConnectionsPerSecond: (options.clients / durationMs) * 1000,
    sseAverageConnectMs: average(connectLatencies),
  };
}

async function benchmarkWebSocket(options: {
  gatewayPort: number;
  routeCount: number;
  headerCount: number;
  clients: number;
  messagesPerClient: number;
}): Promise<BenchmarkResult> {
  const headerEntries = Object.entries(buildHeaders(options.headerCount));
  const rtts: number[] = [];

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: options.clients }, async (_, clientIndex) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${options.gatewayPort}/ws/socket?client=${clientIndex}`,
        {
          headers: Object.fromEntries(headerEntries),
        } as any,
      );

      await waitForSocketOpen(socket);

      for (let messageIndex = 0; messageIndex < options.messagesPerClient; messageIndex += 1) {
        const payload = `${clientIndex}:${messageIndex}:${"x".repeat(64)}`;
        const sentAt = performance.now();
        const received = new Promise<void>((resolve, reject) => {
          socket.addEventListener(
            "message",
            (event) => {
              if (String(event.data) === payload) {
                rtts.push(performance.now() - sentAt);
                resolve();
              }
            },
            { once: true },
          );
          socket.addEventListener(
            "close",
            (event) =>
              reject(
                new Error(`WebSocket closed early (${event.code}: ${event.reason})`),
              ),
            { once: true },
          );
        });

        socket.send(payload);
        await received;
      }

      socket.close(1000, "done");
      await waitForSocketClose(socket);
    }),
  );
  const durationMs = performance.now() - startedAt;
  const totalMessages = options.clients * options.messagesPerClient;

  return {
    scenario: "ws",
    routeCount: options.routeCount,
    headerCount: options.headerCount,
    durationMs,
    wsMessagesPerSecond: (totalMessages / durationMs) * 1000,
    wsAverageRttMs: average(rtts),
  };
}

async function benchmarkMixedLoad(options: {
  gatewayPort: number;
  routeCount: number;
  headerCount: number;
}): Promise<BenchmarkResult> {
  const startedAt = performance.now();

  const [httpResult, sseResult, wsResult] = await Promise.all([
    benchmarkHttp({
      gatewayPort: options.gatewayPort,
      routeCount: options.routeCount,
      headerCount: options.headerCount,
      requests: 1200,
      concurrency: 60,
    }),
    benchmarkSse({
      gatewayPort: options.gatewayPort,
      routeCount: options.routeCount,
      headerCount: options.headerCount,
      clients: 20,
      eventsPerClient: 8,
    }),
    benchmarkWebSocket({
      gatewayPort: options.gatewayPort,
      routeCount: options.routeCount,
      headerCount: options.headerCount,
      clients: 40,
      messagesPerClient: 12,
    }),
  ]);

  const durationMs = performance.now() - startedAt;

  return {
    scenario: "mixed",
    routeCount: options.routeCount,
    headerCount: options.headerCount,
    durationMs,
    requestsPerSecond: httpResult.requestsPerSecond,
    sseConnectionsPerSecond: sseResult.sseConnectionsPerSecond,
    wsMessagesPerSecond: wsResult.wsMessagesPerSecond,
    notes: "parallel http+sse+ws",
  };
}

async function benchmarkWebSocketBackpressure(options: {
  scenario: string;
  gatewayPort: number;
}): Promise<BenchmarkResult> {
  const clients = 24;
  let closedClients = 0;
  let receivedMessages = 0;

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async (_, index) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${options.gatewayPort}/burst/channel?client=${index}`,
      );

      await waitForSocketOpen(socket);

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.close(1000, "timeout");
        }, 750);

        socket.addEventListener("message", () => {
          receivedMessages += 1;
          const busyUntil = performance.now() + 2;
          while (performance.now() < busyUntil) {
            // keep the client intentionally slow so backpressure can build
          }
        });

        socket.addEventListener(
          "close",
          (event) => {
            clearTimeout(timeout);
            if (event.code !== 1000) {
              closedClients += 1;
            }
            resolve();
          },
          { once: true },
        );
      });
    }),
  );

  return {
    scenario: options.scenario,
    routeCount: 50,
    headerCount: 0,
    durationMs: performance.now() - startedAt,
    wsClosedClients: closedClients,
    wsMessagesPerSecond: (receivedMessages / (performance.now() - startedAt)) * 1000,
    notes: "slow consumers against upstream burst",
  };
}

function buildHeaders(count: number): Record<string, string> {
  const headers: Record<string, string> = {};

  for (let index = 0; index < count; index += 1) {
    headers[`x-bench-${index}`] = `value-${index}`;
  }

  return headers;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function waitForSocketOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket failed to open.")),
      { once: true },
    );
  });
}

function waitForSocketClose(socket: WebSocket) {
  return new Promise<void>((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    socket.addEventListener("close", () => resolve(), { once: true });
  });
}

function renderResults(results: BenchmarkResult[]) {
  console.log("\nBenchmark results\n");

  for (const result of results) {
    console.log(
      [
        `scenario=${result.scenario}`,
        `routes=${result.routeCount}`,
        `headers=${result.headerCount}`,
        `duration_ms=${result.durationMs.toFixed(2)}`,
        result.requestsPerSecond
          ? `http_rps=${result.requestsPerSecond.toFixed(2)}`
          : undefined,
        result.averageLatencyMs
          ? `http_avg_ms=${result.averageLatencyMs.toFixed(2)}`
          : undefined,
        result.p95LatencyMs
          ? `http_p95_ms=${result.p95LatencyMs.toFixed(2)}`
          : undefined,
        result.sseConnectionsPerSecond
          ? `sse_conn_s=${result.sseConnectionsPerSecond.toFixed(2)}`
          : undefined,
        result.sseAverageConnectMs
          ? `sse_avg_connect_ms=${result.sseAverageConnectMs.toFixed(2)}`
          : undefined,
        result.wsMessagesPerSecond
          ? `ws_msg_s=${result.wsMessagesPerSecond.toFixed(2)}`
          : undefined,
        result.wsAverageRttMs
          ? `ws_avg_rtt_ms=${result.wsAverageRttMs.toFixed(2)}`
          : undefined,
        result.wsClosedClients !== undefined
          ? `ws_closed_clients=${result.wsClosedClients}`
          : undefined,
        result.notes,
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
}

await main();
