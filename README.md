# gateway

A Bun-based reverse proxy for Zeabur internal services.

## What it does

Use one public domain and forward different path prefixes to internal service URLs.

Example:

- `https://example.com/api/users` -> `http://api:8080/users`
- `https://example.com/app` -> `http://frontend:3000/`

## HTTP support

- request method is forwarded as-is, so normal HTTP methods like `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS` work
- request body is streamed to upstream with `request.body`, so upload and large payload streaming are not buffered in this gateway
- upstream response is returned directly, so SSE and chunked response streaming pass through
- request headers are copied through by default, then proxy headers like `Host` and `X-Forwarded-*` are added or updated
- upstream response headers are returned as-is
- WebSocket upgrade requests are proxied to `ws://` or `wss://` based on the configured upstream target
- Socket.IO long-polling works through the normal HTTP proxy path, and Socket.IO WebSocket transport works through the WebSocket proxy path

Current non-goals:

- HTTP `CONNECT` tunneling is not implemented

## Environment variables

### `PORT`

Optional. Defaults to `3000`.

### `PROXY_ROUTES`

Required. JSON array of route definitions:

```json
[
  {
    "prefix": "/api",
    "target": "http://api:8080"
  },
  {
    "prefix": "/app",
    "target": "http://frontend:3000"
  }
]
```

Rules:

- `prefix` must start with `/`
- the matched prefix is removed before forwarding
- longer prefixes win first, so `/api/admin` is matched before `/api`
- `target` can include a base path, for example `http://api:8080/internal`

### Optional WebSocket tuning

These are optional and mainly useful when you want to compare behavior under different WebSocket pressure patterns:

- `WS_MAX_PAYLOAD_LENGTH`
- `WS_BACKPRESSURE_LIMIT`
- `WS_CLOSE_ON_BACKPRESSURE_LIMIT`
- `WS_IDLE_TIMEOUT`

## Run locally

```bash
bun install
```

```bash
$env:PROXY_ROUTES='[{"prefix":"/api","target":"http://api:8080"}]'
bun run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## Zeabur example

Set these environment variables on the gateway service:

```env
PORT=3000
PROXY_ROUTES=[{"prefix":"/api","target":"http://api:8080"},{"prefix":"/app","target":"http://frontend:3000"}]
```

Then expose only this gateway service publicly on Zeabur.

## Deploy on Zeabur

This repo is ready to deploy as a Bun service. Zeabur only needs:

- install command: `bun install`
- start command: `bun run start`
- public port: `PORT`

If you prefer container deployment, use the included `Dockerfile`.

### Recommended Zeabur setup

1. Create one service for this gateway.
2. Keep your app services internal only, for example `api`, `frontend`, `realtime`.
3. Expose only the gateway service publicly.
4. Set `PROXY_ROUTES` to map public paths to internal service URLs.

Example:

```env
PORT=3000
PROXY_ROUTES=[{"prefix":"/api","target":"http://api:8080"},{"prefix":"/app","target":"http://frontend:3000"},{"prefix":"/socket.io","target":"http://realtime:3001"},{"prefix":"/ws","target":"http://realtime:3001"}]
```

Notes:

- `socket.io` can use both HTTP long-polling and WebSocket through this gateway
- if your upstream service expects the original prefix, do not strip it in the app; this gateway removes the matched prefix before forwarding
- keep health checks on the gateway itself, for example `/health`

## Performance notes

This gateway is optimized as a pragmatic Bun implementation, not as a maximum-benchmark proxy.

Current performance-oriented choices:

- routes are parsed and compiled once at startup
- route matching uses a prebuilt prefix matcher instead of scanning every route on every request
- HTTP target URL and WebSocket target URL are built from precomputed route fields
- HTTP request and response bodies are streamed through
- WebSocket messages are relayed without app-level buffering in the normal path

Still possible if you need higher throughput:

- benchmark with your real route count and connection mix
- add per-route or global timeout controls
- add overload protection and explicit backpressure policy for heavy WebSocket fan-in
- compare this Bun gateway against nginx, caddy, or envoy if raw proxy throughput is the main goal

## Benchmarking

Run the built-in benchmark harness:

```bash
bun run benchmark
```

The harness spins up:

- a local mock upstream with HTTP, SSE, WebSocket echo, and WebSocket burst endpoints
- a gateway instance with generated route tables
- scenario groups that vary:
  - route count
  - forwarded header count
  - HTTP / SSE / WebSocket traffic type
  - mixed parallel load
  - WebSocket backpressure settings

Current default matrix:

- route counts: `1`, `100`, `1000`
- header counts: `0`, `20`, `100`
- HTTP benchmark: throughput + average/p95 latency
- SSE benchmark: connection throughput + average connect latency
- WebSocket benchmark: message throughput + average RTT
- mixed benchmark: concurrent HTTP + SSE + WebSocket
- backpressure benchmark: slow WebSocket consumers against upstream burst traffic

Interpretation notes:

- if route count barely moves the numbers, route matching is probably not your bottleneck
- if header count drops throughput, object/header work is a bigger factor than route lookup
- if mixed load degrades sharply relative to isolated HTTP or WS runs, cross-traffic contention is real
- if backpressure scenarios do not diverge, the current message size and client slowness are not enough to trigger the configured limit on your machine
