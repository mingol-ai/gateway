export type RouteConfig = {
  prefix: string;
  target: string;
};

export type ParsedRoute = {
  prefix: string;
  normalizedPrefix: string;
  prefixLength: number;
  target: URL;
  targetBasePath: string;
  targetHttpBase: string;
  targetWebSocketBase: string;
};

type RouteMatcherNode = {
  children: Map<string, RouteMatcherNode>;
  route?: ParsedRoute;
};

export type RouteMatcher = {
  rootRoute?: ParsedRoute;
  tree: RouteMatcherNode;
};

export type GatewayConfig = {
  matcher: RouteMatcher;
  routes: ParsedRoute[];
};

const ROUTES_ENV_NAME = "PROXY_ROUTES";

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();

  if (!trimmed.startsWith("/")) {
    throw new Error(`Route prefix "${prefix}" must start with "/".`);
  }

  if (trimmed === "/") {
    return "/";
  }

  return trimmed.replace(/\/+$/, "");
}

function parseRouteEntry(entry: RouteConfig, index: number): ParsedRoute {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Route #${index + 1} must be an object.`);
  }

  if (typeof entry.prefix !== "string" || entry.prefix.trim() === "") {
    throw new Error(`Route #${index + 1} is missing a valid "prefix".`);
  }

  if (typeof entry.target !== "string" || entry.target.trim() === "") {
    throw new Error(`Route #${index + 1} is missing a valid "target".`);
  }

  const normalizedPrefix = normalizePrefix(entry.prefix);
  const target = new URL(entry.target);
  const targetBasePath = normalizeTargetBasePath(target.pathname);

  return {
    prefix: entry.prefix,
    normalizedPrefix,
    prefixLength: normalizedPrefix.length,
    target,
    targetBasePath,
    targetHttpBase: `${target.origin}${targetBasePath}`,
    targetWebSocketBase: `${toWebSocketOrigin(target)}${targetBasePath}`,
  };
}

export function parseRoutesFromEnv(env = process.env): GatewayConfig {
  const raw = env[ROUTES_ENV_NAME];

  if (!raw) {
    throw new Error(
      `Missing ${ROUTES_ENV_NAME}. Example: ` +
        `'[{"prefix":"/api","target":"http://api:8080"}]'`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${ROUTES_ENV_NAME} must be valid JSON. ` +
        `Received: ${(error as Error).message}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${ROUTES_ENV_NAME} must be a non-empty JSON array.`);
  }

  const routes = parsed.map((entry, index) =>
    parseRouteEntry(entry as RouteConfig, index),
  );

  const duplicatePrefixes = new Set<string>();
  const seenPrefixes = new Set<string>();

  for (const route of routes) {
    if (seenPrefixes.has(route.normalizedPrefix)) {
      duplicatePrefixes.add(route.normalizedPrefix);
    }
    seenPrefixes.add(route.normalizedPrefix);
  }

  if (duplicatePrefixes.size > 0) {
    throw new Error(
      `Duplicate route prefixes found: ${Array.from(duplicatePrefixes).join(", ")}`,
    );
  }

  routes.sort(
    (left, right) =>
      right.normalizedPrefix.length - left.normalizedPrefix.length,
  );

  return {
    routes,
    matcher: buildRouteMatcher(routes),
  };
}

function normalizeTargetBasePath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function toWebSocketOrigin(target: URL): string {
  if (target.protocol === "https:") {
    return `wss://${target.host}`;
  }

  return `ws://${target.host}`;
}

function buildRouteMatcher(routes: ParsedRoute[]): RouteMatcher {
  const tree: RouteMatcherNode = {
    children: new Map<string, RouteMatcherNode>(),
  };
  let rootRoute: ParsedRoute | undefined;

  for (const route of routes) {
    if (route.normalizedPrefix === "/") {
      rootRoute = route;
      continue;
    }

    let node = tree;
    for (const char of route.normalizedPrefix) {
      let child = node.children.get(char);
      if (!child) {
        child = {
          children: new Map<string, RouteMatcherNode>(),
        };
        node.children.set(char, child);
      }
      node = child;
    }
    node.route = route;
  }

  return {
    rootRoute,
    tree,
  };
}
