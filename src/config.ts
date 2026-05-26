export type RouteConfig = {
  prefix: string;
  target: string;
};

export type ParsedRoute = {
  prefix: string;
  normalizedPrefix: string;
  target: URL;
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

  return {
    prefix: entry.prefix,
    normalizedPrefix,
    target,
  };
}

export function parseRoutesFromEnv(env = process.env): ParsedRoute[] {
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

  return routes.sort(
    (left, right) =>
      right.normalizedPrefix.length - left.normalizedPrefix.length,
  );
}
