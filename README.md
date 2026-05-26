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
