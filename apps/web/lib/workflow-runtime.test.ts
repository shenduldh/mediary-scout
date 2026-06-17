import { describe, expect, it } from "vitest";
import {
  getLlmConfig,
  getQualityPreference,
  getTmdbAccesses,
  TMDB_API_KEY_SETTING_KEY,
} from "./workflow-runtime";

function repoWith(value: string | null) {
  return { getSetting: async () => value };
}

function repoMap(map: Record<string, string>) {
  return { getSetting: async (key: string) => map[key] ?? null };
}

describe("getLlmConfig", () => {
  it("unset → all undefined (falls back to env)", async () => {
    expect(await getLlmConfig(repoWith(null))).toEqual({
      baseURL: undefined,
      apiKey: undefined,
      modelId: undefined,
    });
  });

  it("reads + trims the three app_settings keys", async () => {
    const cfg = await getLlmConfig(
      repoMap({
        llm_base_url: " https://api.example.com/v1 ",
        llm_api_key: " sk-abc ",
        llm_model_id: " gpt-4o-mini ",
      }),
    );
    expect(cfg).toEqual({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-abc",
      modelId: "gpt-4o-mini",
    });
  });

  it("blank strings → undefined (not empty string)", async () => {
    const cfg = await getLlmConfig(repoMap({ llm_base_url: "   ", llm_api_key: "", llm_model_id: "x" }));
    expect(cfg.baseURL).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.modelId).toBe("x");
  });
});

describe("getQualityPreference", () => {
  it("unset → undefined (default 不限, no quality injection)", async () => {
    expect(await getQualityPreference(repoWith(null))).toBeUndefined();
  });

  it("'any' → undefined", async () => {
    expect(await getQualityPreference(repoWith("any"))).toBeUndefined();
  });

  it("'high'/'medium' pass through (trimmed)", async () => {
    expect(await getQualityPreference(repoWith("high"))).toBe("high");
    expect(await getQualityPreference(repoWith(" medium "))).toBe("medium");
  });

  it("garbage (incl. legacy '4K') → undefined (safe)", async () => {
    expect(await getQualityPreference(repoWith("4K"))).toBeUndefined();
    expect(await getQualityPreference(repoWith("ultra"))).toBeUndefined();
  });
});

describe("getTmdbAccesses", () => {
  it("puts the user key first, then env token, then the proxy", async () => {
    const accesses = await getTmdbAccesses(
      repoMap({ [TMDB_API_KEY_SETTING_KEY]: "userkey" }),
      { TMDB_READ_TOKEN: "envkey", TMDB_PROXY_BASE_URL: "https://proxy.example" } as unknown as NodeJS.ProcessEnv,
    );
    expect(accesses.map((a) => a.readToken)).toEqual(["userkey", "envkey", undefined]);
    expect(accesses[2]?.baseURL).toBe("https://proxy.example");
    expect(accesses[0]?.baseURL).toBe("https://api.themoviedb.org/3");
  });

  it("omits the user access when no key is set, keeping env + proxy", async () => {
    const accesses = await getTmdbAccesses(
      repoMap({}),
      { TMDB_READ_TOKEN: "envkey" } as unknown as NodeJS.ProcessEnv,
    );
    expect(accesses.map((a) => a.readToken)).toEqual(["envkey", undefined]);
  });

  it("always ends with the default proxy when nothing is configured", async () => {
    const accesses = await getTmdbAccesses(repoMap({}), {} as NodeJS.ProcessEnv);
    expect(accesses).toHaveLength(1);
    expect(accesses[0]?.readToken).toBeUndefined();
    expect(accesses[0]?.baseURL).toMatch(/^https:\/\//);
  });
});
