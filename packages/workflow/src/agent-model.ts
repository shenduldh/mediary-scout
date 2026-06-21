import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * The live acquisition agent model factory — a bare OpenAI-compatible (MiMo)
 * LanguageModel that drives the V2 sandbox tool-loop. This was lost in Phase 8
 * (764ae19) when the dead structured-output agent (`ai-sdk-agent.ts`) was deleted
 * wholesale; but the FACTORY is live — `apps/web` `getAgentModel` calls
 * createAgentModelFromEnv for every real (vercel-ai) run, and the §6a
 * interrogation script uses it too. Restored here as a focused, dependency-light
 * module (no dead agent attached).
 *
 * The MiMo OpenAI-compatible endpoint does NOT support `response_format`; the V2
 * agent never relies on it (it uses the AI SDK tool-loop with zod inputSchemas),
 * so a bare model is all that is needed.
 */

const DEFAULT_PROVIDER_NAME = "agent-model";
const DEFAULT_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";
const DEFAULT_MODEL_ID = "mimo-v2.5-pro";

export interface AgentModelOptions {
  apiKey?: string;
  baseURL?: string;
  modelId?: string;
  providerName?: string;
}

/** Map options (with MiMo defaults) onto OpenAI-compatible provider settings. */
export function createAgentProviderConfig(options: AgentModelOptions = {}): {
  providerSettings: OpenAICompatibleProviderSettings;
  modelId: string;
} {
  const providerSettings: OpenAICompatibleProviderSettings = {
    name: options.providerName ?? DEFAULT_PROVIDER_NAME,
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    ...(options.apiKey === undefined ? {} : { headers: { "api-key": options.apiKey } }),
  };
  return { providerSettings, modelId: options.modelId ?? DEFAULT_MODEL_ID };
}

/** Build the live LanguageModel from explicit options (DB settings), with the
 *  built-in MiMo defaults filling any gap. Used by the web layer to honor the
 *  user's Settings → AI 模型 config (BYO-key self-host). */
export function createAgentModel(options: AgentModelOptions = {}): LanguageModel {
  const { providerSettings, modelId } = createAgentProviderConfig(options);
  return createOpenAICompatible(providerSettings)(modelId);
}

/**
 * Build the live LanguageModel from env. Reads AGENT_MODEL_* with XIAOMI_MIMO_*
 * as the fallback (same precedence the web/worker and interrogation use).
 */
export function createAgentModelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const options: AgentModelOptions = {};
  const apiKey = env.AGENT_MODEL_API_KEY ?? env.XIAOMI_MIMO_API_KEY;
  const baseURL = env.AGENT_MODEL_BASE_URL ?? env.XIAOMI_MIMO_BASE_URL;
  const modelId = env.AGENT_MODEL_ID ?? env.XIAOMI_MIMO_MODEL_ID;
  if (apiKey !== undefined) options.apiKey = apiKey;
  if (baseURL !== undefined) options.baseURL = baseURL;
  if (modelId !== undefined) options.modelId = modelId;
  const { providerSettings, modelId: id } = createAgentProviderConfig(options);
  return createOpenAICompatible(providerSettings)(id);
}

/**
 * Normalize a user-entered OpenAI-compatible base URL. The provider appends
 * `/chat/completions` itself, so a pasted full endpoint (or trailing slashes)
 * must be stripped — otherwise requests hit `…/chat/completions/chat/completions`
 * (404). Empty / whitespace-only → "".
 */
export function normalizeLlmBaseUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/chat\/completions$/i, "");
  s = s.replace(/\/+$/, "");
  return s;
}

// Invisible codepoints not covered by the regex \s class: zero-width space,
// zero-width non-joiner, zero-width joiner. (NBSP U+00A0 and BOM U+FEFF ARE in \s.)
const INVISIBLE_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

/**
 * Strip ALL whitespace + invisible characters from a pasted API key (keys are
 * whitespace-free tokens). Defends against web-copy contamination — spaces,
 * tabs, newlines, NBSP, zero-width chars, BOM — that would otherwise silently
 * store a wrong value and make the user think their key is bad. Built from
 * codepoints (no invisible literals in source — those are exactly what we strip).
 */
export function sanitizeLlmApiKey(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (/\s/.test(ch)) continue;
    if (INVISIBLE_CODEPOINTS.has(ch.codePointAt(0) ?? -1)) continue;
    out += ch;
  }
  return out;
}
