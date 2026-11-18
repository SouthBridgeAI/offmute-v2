/**
 * Re-transcribe a chunk whose transcript lost speech, as two halves.
 *
 * On the two real chunks where gemini-3.1-pro-preview dropped most of the speech in 6 of 6
 * full-chunk attempts (one "[silence]" segment over 8.5 minutes of talk; a final chunk cut
 * off after 26–85 s), the same model and prompt on each half kept the speech in 4 of 4
 * attempts (docs/field-report-2, §8). Node-only: it cuts audio with ffmpeg.
 */
import { existsSync } from "node:fs";
import { extractChunk } from "../audio/ffmpeg.js";
import type { ChunkPlan } from "./types.js";
import type { GeminiClient } from "../providers/gemini.js";
import type { ChunkContext } from "../transcribe/prompts.js";
import {
  transcribeChunk,
  type ChunkTranscriptionResult,
} from "../transcribe/llm-transcribe.js";

/** Each half runs this far past the midpoint, so no word is cut in two (seconds). */
const HALF_OVERLAP_SEC = 5;

export async function transcribeInHalves(opts: {
  client: GeminiClient;
  model: string;
  audioPath: string;
  chunk: ChunkPlan;
  /** Where the halves' audio goes, e.g. `<llmDir>/chunk_07` → chunk_07_half_a.mp3. */
  pathPrefix: string;
  ctx: ChunkContext;
  audioOpts: { format: "mp3"; bitrate: string };
}): Promise<ChunkTranscriptionResult> {
  const { chunk } = opts;
  const mid = (chunk.start + chunk.end) / 2;
  const halves = [
    { name: "a", from: chunk.start, to: Math.min(chunk.end, mid + HALF_OVERLAP_SEC) },
    { name: "b", from: Math.max(chunk.start, mid - HALF_OVERLAP_SEC), to: chunk.end },
  ];
  const results: ChunkTranscriptionResult[] = [];
  for (const h of halves) {
    const path = `${opts.pathPrefix}_half_${h.name}.mp3`;
    if (!existsSync(path))
      await extractChunk(opts.audioPath, path, h.from, h.to, opts.audioOpts);
    results.push(
      await transcribeChunk(opts.client, opts.model, path, h.from, opts.ctx, {
        chunkDurationSec: h.to - h.from,
        validationRetries: 0,
      }),
    );
  }
  const [a, b] = results as [ChunkTranscriptionResult, ChunkTranscriptionResult];
  // Each half owns its side of the midpoint.
  const center = (s: { startSec: number; endSec: number }) => (s.startSec + s.endSec) / 2;
  const segments = [
    ...a.segments.filter((s) => center(s) < mid),
    ...b.segments.filter((s) => center(s) >= mid),
  ];
  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    segments,
    raw: JSON.stringify({ halves: [a.raw, b.raw] }),
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      thoughtTokens: (a.usage.thoughtTokens ?? 0) + (b.usage.thoughtTokens ?? 0),
      totalTokens: a.usage.totalTokens + b.usage.totalTokens,
    },
    validation: {
      isValid: a.validation.isValid && b.validation.isValid,
      degenerate: Boolean(a.validation.degenerate || b.validation.degenerate),
      spanSec: first && last ? last.endSec - first.startSec : 0,
      segmentCount: segments.length,
      message: `halves: ${a.validation.message} | ${b.validation.message}`,
    },
    ...(a.error || b.error
      ? { error: [a.error, b.error].filter(Boolean).join(" | ") }
      : {}),
  };
}
