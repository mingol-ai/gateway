import type { ParsedRoute, RouteMatcher } from "./config";

export function matchRoute(pathname: string, matcher: RouteMatcher) {
  let matched = matcher.rootRoute;
  let node = matcher.tree;

  for (let index = 0; index < pathname.length; index += 1) {
    const child = node.children.get(pathname[index]);

    if (!child) {
      break;
    }

    node = child;

    if (node.route) {
      const nextChar = pathname[index + 1];
      if (nextChar === undefined || nextChar === "/") {
        matched = node.route;
      }
    }
  }

  return matched;
}

export function buildTargetUrl(requestUrl: URL, route: ParsedRoute): string {
  const matchedPrefix = route.normalizedPrefix;
  const strippedPath =
    matchedPrefix === "/"
      ? requestUrl.pathname
      : requestUrl.pathname.slice(route.prefixLength) || "/";

  return `${route.targetHttpBase}${joinPaths(strippedPath)}${requestUrl.search}`;
}

export function buildTargetWebSocketUrl(requestUrl: URL, route: ParsedRoute): string {
  const matchedPrefix = route.normalizedPrefix;
  const strippedPath =
    matchedPrefix === "/"
      ? requestUrl.pathname
      : requestUrl.pathname.slice(route.prefixLength) || "/";

  return `${route.targetWebSocketBase}${joinPaths(strippedPath)}${requestUrl.search}`;
}

function joinPaths(suffixPath: string): string {
  return suffixPath.startsWith("/") ? suffixPath : `/${suffixPath}`;
}

export function createProxyHeaders(
  request: Request,
  requestUrl: URL,
  targetHost: string,
  forwardedPrefix: string,
): Headers {
  const headers = new Headers(request.headers);

  headers.set("host", targetHost);
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
