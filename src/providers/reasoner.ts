/**
 * Reasoner resolution: map a model name to an OpenAI-compatible endpoint + key.
 *
 * Every text-reasoning pass (identify, summary, adjudication) goes through this one
 * seam. All supported providers expose an OpenAI-compatible /chat/completions —
 * including Gemini (generativelanguage .../v1beta/openai) and Anthropic — so the
 * whole pool shares the fetch client, retries, and llm-call logging.
 */
import { OpenAICompatClient } from "./openai-compat.js";
import type { ApiKeys } from "../core/config.js";

export interface ReasonerInfo {
  /** Provider id, e.g. "deepseek", "gemini", "zai". */
  provider: string;
  /** Resolved model name sent to the API. */
  model: string;
  /** Which ApiKeys field this provider needs. */
  keyName: keyof ApiKeys;
  baseUrl: string;
}

const PROVIDERS: Record<string, { baseUrl: string; keyName: keyof ApiKeys }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keyName: "deepseek" },
  openai: { baseUrl: "https://api.openai.com/v1", keyName: "openai" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyName: "groq" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyName: "gemini",
  },
  zai: { baseUrl: "https://api.z.ai/api/paas/v4", keyName: "zai" },
  kimi: { baseUrl: "https://api.moonshot.ai/v1", keyName: "kimi" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", keyName: "anthropic" },
};

/** Infer the provider from a model name ("glm-4.7" → zai, "gemini-…" → gemini, …). */
export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("gemini") || m.startsWith("gemma")) return "gemini";
  if (m.startsWith("glm")) return "zai";
  if (m.startsWith("kimi") || m.startsWith("moonshot")) return "kimi";
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"))
    return "openai";
  if (m.includes("llama") || m.includes("mixtral")) return "groq";
  return "openai";
}

/** Resolve a reasoner spec ("deepseek-chat", "provider:model", …) to endpoint info. */
export function resolveReasonerInfo(spec: string): ReasonerInfo {
  let provider: string;
  let model: string;
  const colon = spec.indexOf(":");
  if (colon > 0 && PROVIDERS[spec.slice(0, colon)]) {
    provider = spec.slice(0, colon);
    model = spec.slice(colon + 1);
  } else {
    model = spec;
    provider = inferProvider(spec);
  }
  const p = PROVIDERS[provider] ?? PROVIDERS.openai!;
  return { provider, model, keyName: p.keyName, baseUrl: p.baseUrl };
}

/** The key (if present) for a reasoner spec. Gemini accepts the google alias. */
export function reasonerKey(info: ReasonerInfo, keys: ApiKeys): string | undefined {
  if (info.keyName === "gemini") return keys.gemini || keys.google;
  return keys[info.keyName];
}

export interface ResolvedReasoner {
  client: OpenAICompatClient;
  info: ReasonerInfo;
}

/**
 * Build a reasoner client for `spec`, or fall back to a model whose key exists.
 * Fallback order: requested → deepseek-chat → gemini-flash-latest (whose key is
 * guaranteed in practice, since transcription requires it). Returns null only when
 * no reasoner-capable key exists at all.
 */
export function resolveReasoner(
  spec: string | undefined,
  keys: ApiKeys,
): ResolvedReasoner | null {
  const candidates = [spec, "deepseek-chat", "gemini-flash-latest"].filter(
    (s): s is string => !!s,
  );
  for (const c of candidates) {
    const info = resolveReasonerInfo(c);
    const key = reasonerKey(info, keys);
    if (key) {
      return {
        client: new OpenAICompatClient(info.baseUrl, key, info.model, info.provider),
        info,
      };
    }
  }
  return null;
}

/**
 * Pick a second-opinion reasoner from a DIFFERENT provider family than the first
 * (a same-family second opinion mostly re-samples the same failure modes).
 */
export function resolveSecondReasoner(
  first: ReasonerInfo,
  keys: ApiKeys,
): ResolvedReasoner | null {
  const candidates = ["gemini-flash-latest", "deepseek-chat", "glm-4.7", "gpt-4o-mini"];
  for (const c of candidates) {
    const info = resolveReasonerInfo(c);
    if (info.provider === first.provider) continue;
    const key = reasonerKey(info, keys);
    if (key) {
      return {
        client: new OpenAICompatClient(info.baseUrl, key, info.model, info.provider),
        info,
      };
    }
  }
  return null;
}

/** Reasoner presets surfaced by `offmute-v2 models`. */
export const REASONER_PRESETS: { model: string; note: string }[] = [
  { model: "deepseek-chat", note: "default — cheap, strong text reasoner" },
  { model: "gemini-flash-latest", note: "fallback — uses the same key as transcription" },
  { model: "glm-4.7", note: "z.ai" },
  { model: "kimi-k2-turbo-preview", note: "Moonshot" },
  { model: "gpt-4o-mini", note: "OpenAI" },
  { model: "claude-sonnet-4-5", note: "Anthropic (OpenAI-compat endpoint)" },
];
