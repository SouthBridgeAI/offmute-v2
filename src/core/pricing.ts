/**
 * Pricing: predictive cost estimates (before the run) and actual receipts (after).
 *
 * Prices are point-in-time list prices, marked with PRICES_AS_OF and displayed with a
 * "~" — they exist so the tool is honest about spend, not to be an invoice. Unknown
 * models simply drop out of the math (shown as "unpriced") rather than guessing.
 */
import type { LlmUsageRecord } from "../providers/llm-log.js";

export const PRICES_AS_OF = "2026-07";

/** USD per 1M tokens. `audioIn` falls back to `textIn` when a model prices uniformly. */
interface ModelPrice {
  textIn: number;
  audioIn?: number;
  out: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  // Gemini (ai.google.dev/gemini-api/docs/pricing, standard tier, <=200k prompts)
  "gemini-3.1-pro-preview": { textIn: 2.0, out: 12.0 },
  "gemini-3-pro-preview": { textIn: 2.0, out: 12.0 },
  "gemini-3.5-flash": { textIn: 1.5, out: 9.0 },
  "gemini-3-flash-preview": { textIn: 0.5, audioIn: 1.0, out: 3.0 },
  "gemini-2.5-pro": { textIn: 1.25, out: 10.0 },
  "gemini-2.5-flash": { textIn: 0.3, audioIn: 1.0, out: 2.5 },
  "gemini-2.5-flash-lite": { textIn: 0.1, audioIn: 0.3, out: 0.4 },
  // Moving aliases — priced as their current targets.
  "gemini-pro-latest": { textIn: 2.0, out: 12.0 },
  "gemini-flash-latest": { textIn: 1.5, out: 9.0 },
  "gemini-flash-lite-latest": { textIn: 0.25, audioIn: 0.5, out: 1.5 },
  // Text reasoners
  "deepseek-chat": { textIn: 0.28, out: 0.42 },
  "deepseek-reasoner": { textIn: 0.28, out: 0.42 },
  "gpt-4o-mini": { textIn: 0.15, out: 0.6 },
  "glm-4.7": { textIn: 0.6, out: 2.2 },
};

/** USD per hour of audio. */
const ASR_HOURLY: Record<string, number> = {
  assemblyai: 0.15, // universal-2, diarization included
  elevenlabs: 0.4, // scribe v2 (standard tier; business tier is lower)
  "whisper-groq": 0.04, // whisper-large-v3-turbo
  none: 0,
};

/** Gemini charges audio at ~32 tokens per second. */
export const AUDIO_TOKENS_PER_SEC = 32;

function priceFor(model: string): ModelPrice | null {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Prefix match handles dated/preview variants (e.g. -preview-05-2026).
  const hit = Object.keys(MODEL_PRICES).find((k) => model.startsWith(k));
  return hit ? MODEL_PRICES[hit]! : null;
}

export function asrCost(provider: string, durationSec: number): number | null {
  const hourly = ASR_HOURLY[provider];
  if (hourly === undefined) return null;
  return (durationSec / 3600) * hourly;
}

export interface CostEstimate {
  totalUsd: number;
  lines: string[];
  /** true when some component had no price and is excluded. */
  incomplete: boolean;
}

/**
 * Predict the cost of a run from the media duration and the chosen models.
 * Token model: audio ≈ 32 tok/s (per chunk, overlap re-billed), prompt overhead ≈ 1.5k
 * tok/chunk, output ≈ 150 tok per audio-minute, describe ≈ one ~6-min sample set,
 * identify ≈ 8k in / 1k out.
 */
export function estimateRunCost(opts: {
  durationSec: number;
  model: string;
  reasoner?: string;
  tsProvider: string;
  chunkSec: number;
  overlapSec: number;
  identify: boolean;
}): CostEstimate {
  const lines: string[] = [];
  let total = 0;
  let incomplete = false;

  const p = priceFor(opts.model);
  const chunks = Math.max(
    1,
    Math.ceil((opts.durationSec - opts.overlapSec) / (opts.chunkSec - opts.overlapSec)),
  );
  // Overlap seconds get transcribed twice; describe adds ~370s of samples.
  const billedAudioSec =
    opts.durationSec + Math.max(0, chunks - 1) * opts.overlapSec + Math.min(370, opts.durationSec);
  if (p) {
    const audioTok = billedAudioSec * AUDIO_TOKENS_PER_SEC;
    const promptTok = chunks * 1500;
    const outTok = (opts.durationSec / 60) * 150 + 1500;
    const inRate = p.audioIn ?? p.textIn;
    const llmUsd =
      (audioTok * inRate + promptTok * p.textIn + outTok * p.out) / 1_000_000;
    total += llmUsd;
    lines.push(
      `${opts.model}: ${chunks} chunk${chunks > 1 ? "s" : ""} + describe ≈ $${llmUsd.toFixed(2)}`,
    );
  } else {
    incomplete = true;
    lines.push(`${opts.model}: unpriced`);
  }

  const asr = asrCost(opts.tsProvider, opts.durationSec);
  if (asr !== null && opts.tsProvider !== "none") {
    total += asr;
    lines.push(`${opts.tsProvider}: ${(opts.durationSec / 60).toFixed(0)}min ≈ $${asr.toFixed(2)}`);
  }

  if (opts.identify && opts.reasoner) {
    const rp = priceFor(opts.reasoner);
    if (rp) {
      const idUsd = (8000 * rp.textIn + 1000 * rp.out) / 1_000_000;
      total += idUsd;
      lines.push(`${opts.reasoner} (identify) ≈ $${idUsd.toFixed(3)}`);
    }
  }

  return { totalUsd: total, lines, incomplete };
}

export interface CostReceipt {
  totalUsd: number;
  llmUsd: number;
  asrUsd: number | null;
  lines: string[];
  totals: { calls: number; inputTokens: number; outputTokens: number };
  /** USD per model (ASR included under the provider id). */
  perModel: Record<string, number>;
  incomplete: boolean;
}

/** Compute the actual receipt from collected usage + ASR duration. */
export function computeReceipt(
  usage: LlmUsageRecord[],
  tsProvider: string,
  durationSec: number,
): CostReceipt {
  let llmUsd = 0;
  let incomplete = false;
  const lines: string[] = [];
  const perModel: Record<string, number> = {};
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const byModel = new Map<string, { in: number; out: number; calls: number }>();
  for (const r of usage) {
    totals.calls += r.calls;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    const m = byModel.get(r.model) ?? { in: 0, out: 0, calls: 0 };
    m.in += r.inputTokens;
    m.out += r.outputTokens;
    m.calls += r.calls;
    byModel.set(r.model, m);
  }
  for (const [model, m] of byModel) {
    const p = priceFor(model);
    if (!p) {
      incomplete = true;
      lines.push(`${model}: ${m.calls} calls · ${fmtTok(m.in)} in / ${fmtTok(m.out)} out · unpriced`);
      continue;
    }
    // Transcription input is predominantly audio — bill input at the audio rate when
    // the model prices audio separately (slightly conservative for mixed prompts).
    const usd = (m.in * (p.audioIn ?? p.textIn) + m.out * p.out) / 1_000_000;
    llmUsd += usd;
    perModel[model] = usd;
    lines.push(
      `${model}: ${m.calls} call${m.calls > 1 ? "s" : ""} · ${fmtTok(m.in)} in / ${fmtTok(m.out)} out · $${usd.toFixed(2)}`,
    );
  }
  const asrUsd = tsProvider === "none" ? 0 : asrCost(tsProvider, durationSec);
  if (asrUsd !== null && tsProvider !== "none") {
    perModel[tsProvider] = asrUsd;
    lines.push(`${tsProvider}: ${(durationSec / 60).toFixed(0)}min · $${asrUsd.toFixed(2)}`);
  }
  return {
    totalUsd: llmUsd + (asrUsd ?? 0),
    llmUsd,
    asrUsd,
    lines,
    totals,
    perModel,
    incomplete,
  };
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
