/**
 * Per-chunk LLM transcription: call Gemini, parse relative mm:ss timestamps to
 * absolute seconds (chunk offset), validate span + monotonicity, retry on failure.
 */
import { GeminiClient, type GeminiUsage } from "../providers/gemini.js";
import { TRANSCRIPT_SCHEMA, transcriptionPrompt, type LlmTranscriptJson } from "./prompts.js";
import { parseMmSs } from "../utils/time.js";
import { logger } from "../utils/logger.js";

export interface ParsedLlmSegment {
  speaker: string;
  /** Absolute start (seconds), chunk offset applied. */
  startSec: number;
  /** Absolute end (seconds). */
  endSec: number;
  text: string;
  tone: string[];
  rawStart: string;
  rawEnd: string;
}

export interface ChunkTranscriptionResult {
  segments: ParsedLlmSegment[];
  raw: string;
  usage: GeminiUsage;
  validation: { isValid: boolean; spanSec: number; segmentCount: number; message: string };
  error?: string;
}

const MIN_SEGMENTS = 3;
const MIN_SPAN_RATIO = 0.6;

function toAbsolute(mmSs: string, offset: number): number | null {
  const s = parseMmSs(mmSs.trim());
  return s === null ? null : s + offset;
}

/** Parse + offset-adjust raw LLM segments. Drops unparseable ones (with a warning). */
export function parseLlmSegments(
  data: LlmTranscriptJson,
  chunkOffsetSec: number,
): { segments: ParsedLlmSegment[]; dropped: number } {
  const out: ParsedLlmSegment[] = [];
  let dropped = 0;
  for (const seg of data.segments || []) {
    const start = toAbsolute(seg.start, chunkOffsetSec);
    const end = toAbsolute(seg.end, chunkOffsetSec);
    if (start === null || end === null || end < start) {
      dropped++;
      logger.debug(`[llm] dropping segment (bad time ${seg.start}-${seg.end}): "${(seg.text || "").slice(0, 40)}"`);
      continue;
    }
    out.push({
      speaker: (seg.speaker || "Unknown").trim(),
      startSec: start,
      endSec: end,
      text: (seg.text || "").trim(),
      tone: Array.isArray(seg.tone) ? seg.tone.map((t) => String(t).trim()).filter(Boolean) : [],
      rawStart: seg.start,
      rawEnd: seg.end,
    });
  }
  return { segments: out, dropped };
}

function validate(segments: ParsedLlmSegment[], chunkDuration: number) {
  if (segments.length < MIN_SEGMENTS) {
    return { isValid: false, spanSec: 0, segmentCount: segments.length, message: `only ${segments.length} segments (min ${MIN_SEGMENTS})` };
  }
  const first = segments[0]!.startSec;
  const last = segments[segments.length - 1]!.endSec;
  const span = last - first;
  const minSpan = chunkDuration * MIN_SPAN_RATIO;
  if (span < minSpan) {
    return { isValid: false, spanSec: span, segmentCount: segments.length, message: `span ${span.toFixed(0)}s < ${minSpan.toFixed(0)}s required (${MIN_SPAN_RATIO * 100}% of chunk)` };
  }
  return { isValid: true, spanSec: span, segmentCount: segments.length, message: `ok (${segments.length} segments, ${span.toFixed(0)}s span)` };
}

export interface TranscribeChunkOptions {
  chunkDurationSec: number;
  /** Retries on validation failure. */
  validationRetries?: number;
  temperature?: number;
}

/** Transcribe one audio chunk → parsed, validated, absolute-timestamped segments. */
export async function transcribeChunk(
  client: GeminiClient,
  model: string,
  chunkPath: string,
  chunkStartSec: number,
  ctx: Parameters<typeof transcriptionPrompt>[0],
  opts: TranscribeChunkOptions,
): Promise<ChunkTranscriptionResult> {
  const validationRetries = opts.validationRetries ?? 1;
  const prompt = transcriptionPrompt(ctx);

  let lastResult: ChunkTranscriptionResult | undefined;

  for (let attempt = 0; attempt <= validationRetries; attempt++) {
    const gen = await client.generateJson<LlmTranscriptJson>(
      model,
      prompt,
      [{ path: chunkPath }],
      TRANSCRIPT_SCHEMA as Record<string, unknown>,
      {
        temperature: opts.temperature ?? 0.2,
        maxRetries: 3,
        logKind: "transcribe",
        logChunk: ctx.index - 1,
      },
    );

    if (gen.error || !gen.data) {
      lastResult = {
        segments: [],
        raw: gen.raw,
        usage: gen.usage,
        validation: { isValid: false, spanSec: 0, segmentCount: 0, message: gen.error || "no data" },
        error: gen.error,
      };
      logger.warn(`[llm] chunk ${ctx.index} attempt ${attempt + 1}: API/parse error — ${gen.error}`);
      continue;
    }

    const { segments, dropped } = parseLlmSegments(gen.data, chunkStartSec);
    const v = validate(segments, opts.chunkDurationSec);
    lastResult = { segments, raw: gen.raw, usage: gen.usage, validation: v };

    if (v.isValid) {
      logger.info(`[llm] chunk ${ctx.index} ok: ${v.message}${dropped ? `, dropped ${dropped}` : ""}`);
      return lastResult;
    }
    logger.warn(`[llm] chunk ${ctx.index} attempt ${attempt + 1} validation: ${v.message}`);
  }

  // Return the last (invalid) result so the caller can decide to fall back.
  logger.error(`[llm] chunk ${ctx.index} failed validation after ${validationRetries + 1} attempts`);
  return lastResult!;
}
