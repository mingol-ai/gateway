import { describe, expect, test } from "bun:test";
import { parseRoutesFromEnv } from "./config";
import {
  buildTargetUrl,
  createUpstreamWebSocketHeaders,
  isWebSocketUpgradeRequest,
  matchRoute,
  toWebSocketUrl,
} from "./proxy";

describe("parseRoutesFromEnv", () => {
  test("sorts routes by longest prefix first", () => {
    const routes = parseRoutesFromEnv({
      PROXY_ROUTES: JSON.stringify([
        { prefix: "/api", target: "http://api:8080" },
        { prefix: "/api/admin", target: "http://admin:8080" },
      ]),
    });

    expect(routes.map((route) => route.normalizedPrefix)).toEqual([
      "/api/admin",
      "/api",
    ]);
  });

  test("rejects duplicate normalized prefixes", () => {
    expect(() =>
      parseRoutesFromEnv({
        PROXY_ROUTES: JSON.stringify([
          { prefix: "/api", target: "http://api:8080" },
          { prefix: "/api/", target: "http://other:8080" },
        ]),
      }),
    ).toThrow("Duplicate route prefixes found: /api");
  });
});

describe("matchRoute", () => {
  const routes = parseRoutesFromEnv({
    PROXY_ROUTES: JSON.stringify([
      { prefix: "/api", target: "http://api:8080" },
      { prefix: "/app", target: "http://app:3000" },
    ]),
  });

  test("matches exact prefix", () => {
    expect(matchRoute("/api", routes)?.normalizedPrefix).toBe("/api");
  });

  test("matches nested path", () => {
    expect(matchRoute("/api/users/1", routes)?.normalizedPrefix).toBe("/api");
  });

  test("does not match partial segment", () => {
    expect(matchRoute("/apiv2", routes)).toBeUndefined();
  });
});

describe("buildTargetUrl", () => {
  test("strips the matched prefix and keeps the remaining path", () => {
    const [route] = parseRoutesFromEnv({
      PROXY_ROUTES: JSON.stringify([
        { prefix: "/api", target: "http://api:8080" },
      ]),
    });

    const targetUrl = buildTargetUrl(
      new URL("https://example.com/api/users?id=1"),
      route,
    );

    expect(targetUrl.toString()).toBe("http://api:8080/users?id=1");
  });

  test("supports target base paths", () => {
    const [route] = parseRoutesFromEnv({
      PROXY_ROUTES: JSON.stringify([
        { prefix: "/api", target: "http://api:8080/internal" },
      ]),
    });

    const targetUrl = buildTargetUrl(
      new URL("https://example.com/api/users"),
      route,
    );

    expect(targetUrl.toString()).toBe("http://api:8080/internal/users");
  });
});

describe("websocket helpers", () => {
  test("detects websocket upgrade request", () => {
    const request = new Request("https://example.com/socket", {
      headers: {
        upgrade: "websocket",
      },
    });

    expect(isWebSocketUpgradeRequest(request)).toBe(true);
  });

  test("converts upstream target URL to ws scheme", () => {
    expect(toWebSocketUrl(new URL("http://api:8080/socket"))).toBe(
      "ws://api:8080/socket",
    );
    expect(toWebSocketUrl(new URL("https://api.example.com/socket"))).toBe(
      "wss://api.example.com/socket",
    );
  });

  test("filters websocket handshake headers for upstream client", () => {
    const headers = createUpstreamWebSocketHeaders(
      new Request("https://example.com/socket", {
        headers: {
          Host: "example.com",
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "abc",
          Authorization: "Bearer token",
          Cookie: "a=1",
        },
      }),
    );

    expect(headers).toEqual({
      authorization: "Bearer token",
      cookie: "a=1",
    });
  });
});
