import type { ParsedRoute } from "./config";

export function matchRoute(pathname: string, routes: ParsedRoute[]) {
  return routes.find((route) => {
    if (route.normalizedPrefix === "/") {
      return true;
    }

    return (
      pathname === route.normalizedPrefix ||
      pathname.startsWith(`${route.normalizedPrefix}/`)
    );
  });
}

export function buildTargetUrl(requestUrl: URL, route: ParsedRoute): URL {
  const target = new URL(route.target.toString());
  const matchedPrefix = route.normalizedPrefix;
  const strippedPath =
    matchedPrefix === "/"
      ? requestUrl.pathname
      : requestUrl.pathname.slice(matchedPrefix.length) || "/";

  target.pathname = joinPaths(target.pathname, strippedPath);
  target.search = requestUrl.search;

  return target;
}

function joinPaths(basePath: string, suffixPath: string): string {
  const normalizedBase = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;
  const normalizedSuffix = suffixPath.startsWith("/")
    ? suffixPath
    : `/${suffixPath}`;

  const joined = `${normalizedBase}${normalizedSuffix}`;
  return joined === "" ? "/" : joined;
}

export function createProxyHeaders(
  request: Request,
  requestUrl: URL,
  targetUrl: URL,
  forwardedPrefix: string,
): Headers {
  const headers = new Headers(request.headers);

  headers.set("host", targetUrl.host);
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-port", requestUrl.port || defaultPortForProtocol(requestUrl.protocol));
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
  headers.set("x-forwarded-for", request.headers.get("x-forwarded-for") ?? "unknown");
  headers.set("x-forwarded-prefix", forwardedPrefix);
  headers.set("x-forwarded-uri", requestUrl.pathname + requestUrl.search);

  return headers;
}

export function createUpstreamWebSocketHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();

    if (
      lowerKey === "connection" ||
      lowerKey === "upgrade" ||
      lowerKey === "host" ||
      lowerKey.startsWith("sec-websocket-")
    ) {
      continue;
    }

    headers[key] = value;
  }

  return headers;
}

export function isWebSocketUpgradeRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export function toWebSocketUrl(targetUrl: URL): string {
  const websocketUrl = new URL(targetUrl.toString());

  websocketUrl.protocol =
    websocketUrl.protocol === "https:" ? "wss:" : "ws:";

  return websocketUrl.toString();
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === "https:") {
    return "443";
  }

  return "80";
}
