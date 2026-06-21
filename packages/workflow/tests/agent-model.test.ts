import { describe, expect, it } from "vitest";
import {
  createAgentProviderConfig,
  createAgentModelFromEnv,
  normalizeLlmBaseUrl,
  sanitizeLlmApiKey,
} from "../src/agent-model.js";

/**
 * The live vercel-ai model factory — RESTORED after Phase 8 (764ae19) deleted it
 * with the dead structured-output agent. It is NOT dead: apps/web `getAgentModel`
 * calls createAgentModelFromEnv for every real (vercel-ai) run, and the §6a
 * interrogation script uses it. Losing it breaks live e2e at runtime even though
 * tsc stayed green (the web typechecked against a stale dist .d.ts).
 */
describe("agent-model — the live OpenAI-compatible (MiMo) LanguageModel factory", () => {
  it("maps options to provider settings with the MiMo defaults", () => {
    const { providerSettings, modelId } = createAgentProviderConfig({});
    expect(modelId).toBe("mimo-v2.5-pro");
    expect(providerSettings.name).toBe("agent-model");
    expect(providerSettings.baseURL).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
  });

  it("honors explicit apiKey / baseURL / modelId overrides", () => {
    const { providerSettings, modelId } = createAgentProviderConfig({
      apiKey: "secret",
      baseURL: "https://example.test/v1",
      modelId: "custom-model",
    });
    expect(modelId).toBe("custom-model");
    expect(providerSettings.baseURL).toBe("https://example.test/v1");
    expect(providerSettings.headers).toEqual({ "api-key": "secret" });
  });

  it("builds a model from AGENT_MODEL_* env (XIAOMI_MIMO_* as fallback)", () => {
    const model = createAgentModelFromEnv({
      AGENT_MODEL_API_KEY: "k",
      AGENT_MODEL_ID: "mimo-v2.5-pro",
    } as NodeJS.ProcessEnv);
    expect(model).toBeDefined();
    expect((model as { modelId?: string }).modelId).toBe("mimo-v2.5-pro");

    const fallback = createAgentModelFromEnv({ XIAOMI_MIMO_API_KEY: "k2" } as NodeJS.ProcessEnv);
    expect((fallback as { modelId?: string }).modelId).toBe("mimo-v2.5-pro");
  });
});

describe("normalizeLlmBaseUrl — provider appends /chat/completions itself", () => {
  it.each([
    ["https://x/v1/chat/completions", "https://x/v1"],
    ["https://x/v1/chat/completions/", "https://x/v1"],
    ["https://x/v1/", "https://x/v1"],
    ["https://x/v1", "https://x/v1"],
    ["  https://x/v1  ", "https://x/v1"],
    ["", ""],
    ["   ", ""],
  ])("normalizes %j -> %j", (input, expected) => {
    expect(normalizeLlmBaseUrl(input)).toBe(expected);
  });
});

describe("sanitizeLlmApiKey — strips paste contamination (keys are whitespace-free)", () => {
  it.each([
    ["tp-abc", "tp-abc"],
    [" tp-abc ", "tp-abc"],
    ["tp- ab\tc\n", "tp-abc"],
    ["", ""],
  ])("strips ASCII whitespace from %j", (input, expected) => {
    expect(sanitizeLlmApiKey(input)).toBe(expected);
  });

  it("strips invisible chars: NBSP, zero-width space, BOM (built from codepoints)", () => {
    const nbsp = String.fromCharCode(0x00a0);
    const zwsp = String.fromCharCode(0x200b);
    const bom = String.fromCharCode(0xfeff);
    const contaminated = `tp-${nbsp}ab${zwsp}c${bom}`;
    expect(contaminated.length).toBeGreaterThan("tp-abc".length);
    expect(sanitizeLlmApiKey(contaminated)).toBe("tp-abc");
  });
});
