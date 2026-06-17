import { describe, it, expect } from "vitest";
import { handleTmdbProxy, type KvLike } from "./handler";

function fakeKv(initial: Record<string, string> = {}): KvLike & { puts: Array<{ key: string; ttl?: number }> } {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; ttl?: number }> = [];
  return {
    puts,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, options) {
      store.set(key, value);
      puts.push({ key, ttl: options?.expirationTtl });
    },
  };
}

describe("handleTmdbProxy — proxy & guards", () => {
  it("rejects non-GET with 405", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278", { method: "POST" }),
      kv: fakeKv(),
      token: "authorkey",
      originFetch: async () => new Response("{}"),
    });
    expect(res.status).toBe(405);
  });

  it("rejects non-allowlisted paths with 404", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/account/secret"),
      kv: fakeKv(),
      token: "authorkey",
      originFetch: async () => new Response("{}"),
    });
    expect(res.status).toBe(404);
  });

  it("proxies an allowlisted path, injecting the author bearer token", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278?language=zh-CN"),
      kv: fakeKv(),
      token: "authorkey",
      originFetch: async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return new Response(JSON.stringify({ id: 278 }), { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://api.themoviedb.org/3/movie/278?language=zh-CN");
    expect(seenAuth).toBe("Bearer authorkey");
    expect(await res.json()).toEqual({ id: 278 });
  });

  it("passes through TMDB non-2xx without caching", async () => {
    const kv = fakeKv();
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "authorkey",
      originFetch: async () => new Response('{"status_message":"invalid"}', { status: 401 }),
    });
    expect(res.status).toBe(401);
    expect(kv.puts).toHaveLength(0);
  });
});
