const TMDB_ORIGIN = "https://api.themoviedb.org/3";

// Only the metadata read paths the app actually uses — keeps the worker from
// being abusable as a general HTTP proxy. Prefix match after the leading slash.
const ALLOWED_PREFIXES = ["movie/", "tv/", "search/", "discover/", "find/", "genre/", "configuration"];

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface HandleTmdbProxyDeps {
  request: Request;
  kv: KvLike;
  token: string;
  originFetch?: typeof fetch;
}

function pathOf(request: Request): string {
  return new URL(request.url).pathname.replace(/^\/+/, "");
}

function isAllowed(path: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

function jsonHeaders(cache: "HIT" | "MISS"): Record<string, string> {
  return { "Content-Type": "application/json;charset=utf-8", "X-Cache": cache };
}

export async function handleTmdbProxy(deps: HandleTmdbProxyDeps): Promise<Response> {
  const { request, token } = deps;
  const originFetch = deps.originFetch ?? fetch;

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const path = pathOf(request);
  if (!isAllowed(path)) {
    return new Response("Not Found", { status: 404 });
  }

  const search = new URL(request.url).search; // includes leading "?" or ""
  const originUrl = `${TMDB_ORIGIN}/${path}${search}`;
  const originResponse = await originFetch(originUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json;charset=utf-8" },
  });

  const body = await originResponse.text();
  if (!originResponse.ok) {
    return new Response(body, { status: originResponse.status, headers: jsonHeaders("MISS") });
  }
  return new Response(body, { status: 200, headers: jsonHeaders("MISS") });
}
