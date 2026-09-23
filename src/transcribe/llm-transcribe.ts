/**
 * Per-chunk LLM transcription: call Gemini (streamed), parse relative mm:ss timestamps to
 * absolute seconds (chunk offset), validate span + reject repetition loops, retry on
 * failure (hotter after a loop).
 */
import { GeminiClient, type GeminiUsage } from "../providers/gemini.js";
import {
  TRANSCRIPT_SCHEMA,
  transcriptionPrompt,
  type LlmTranscriptJson,
} from "./prompts.js";
import { parseMmSs } from "../utils/time.js";
import { logger } from "../utils/logger.js";
import {
  DEGENERATE_COMPRESSION_RATIO,
  maxCompressionRatio,
  tailIsDegenerate,
  transcriptTextOf,
} from "./degeneration.js";

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
  /** Source chunk index (set by the pipeline; used for ownership partitioning). */
  chunkIndex?: number;
  /** Trusted-start (absolute) of the source chunk — content before this is overlap
   * owned by the previous chunk. Segments whose center is before this are dropped to
   * avoid double-printing the overlap region. */
  trustedStart?: number;
  /** Absolute audio range of the source chunk (set by the pipeline): the only audio
   * this segment can have been heard in. Alignment keeps its words inside it. */
  chunkStart?: number;
  chunkEnd?: number;
}

export interface ChunkTranscriptionResult {
  segments: ParsedLlmSegment[];
  raw: string;
  usage: GeminiUsage;
  validation: {
    isValid: boolean;
    /** The output was a repetition loop (still so after every retry). The pipeline
     * drops such chunks when ASR can refill their range with what was actually said. */
    degenerate?: boolean;
    spanSec: number;
    segmentCount: number;
    message: string;
  };
  error?: string;
}

const MIN_SEGMENTS = 3;
const MIN_SPAN_RATIO = 0.6;

function toAbsolute(mmSs: string, offset: number): number | null {
  const s = parseMmSs(mmSs.trim());
  return s === null ? null : s + offset;
}

/**
 * Ownership partition: drop segments whose center time falls in the overlap region owned
 * by the PREVIOUS chunk (center < trustedStart). Segments without a trustedStart (e.g.
 * gap-fill inserts) are kept. This structurally guarantees every word is emitted by exactly
 * one chunk — no overlap double-printing — which fuzzy dedup can miss (e.g. when overlap
 * duplicates map to different speakers). Kept as the primary dedup; finalize's fuzzy dedup
 * is a safety net.
 */
export function partitionByOwnership(segments: ParsedLlmSegment[]): ParsedLlmSegment[] {
  return segments.filter((s) => {
    if (s.trustedStart === undefined) return true; // no chunk info -> keep
    const center = (s.startSec + s.endSec) / 2;
    return center >= s.trustedStart;
  });
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
      logger.debug(
        `[llm] dropping segment (bad time ${seg.start}-${seg.end}): "${(seg.text || "").slice(0, 40)}"`,
      );
      continue;
    }
    out.push({
      speaker: (seg.speaker || "Unknown").trim(),
      startSec: start,
      endSec: end,
      text: (seg.text || "").trim(),
      tone: Array.isArray(seg.tone)
        ? seg.tone.map((t) => String(t).trim()).filter(Boolean)
        : [],
      rawStart: seg.start,
      rawEnd: seg.end,
    });
  }
  return { segments: out, dropped };
}

function validate(segments: ParsedLlmSegment[], chunkDuration: number) {
  // A repetition loop is invalid no matter how much of the chunk it spans — the fluent
  // "conversation" around a loop is usually invented too (field report 1).
  const compression = maxCompressionRatio(segments.map((s) => s.text).join(" "));
  if (compression > DEGENERATE_COMPRESSION_RATIO) {
    return {
      isValid: false,
      degenerate: true,
      spanSec: segments.length
        ? segments[segments.length - 1]!.endSec - segments[0]!.startSec
        : 0,
      segmentCount: segments.length,
      message: `degenerate repetition (compression ratio ${compression.toFixed(1)} > ${DEGENERATE_COMPRESSION_RATIO})`,
    };
  }
  if (segments.length < MIN_SEGMENTS) {
    return {
      isValid: false,
      spanSec: 0,
      segmentCount: segments.length,
      message: `only ${segments.length} segments (min ${MIN_SEGMENTS})`,
    };
  }
  const first = segments[0]!.startSec;
  const last = segments[segments.length - 1]!.endSec;
  const span = last - first;
  const minSpan = chunkDuration * MIN_SPAN_RATIO;
  if (span < minSpan) {
    return {
      isValid: false,
      spanSec: span,
      segmentCount: segments.length,
      message: `span ${span.toFixed(0)}s < ${minSpan.toFixed(0)}s required (${MIN_SPAN_RATIO * 100}% of chunk)`,
    };
  }
  return {
    isValid: true,
    spanSec: span,
    segmentCount: segments.length,
    message: `ok (${segments.length} segments, ${span.toFixed(0)}s span)`,
  };
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
  // Whisper-style temperature fallback: a repetition loop at low temperature tends to
  // recur verbatim, so each retry after a loop samples a little hotter.
  let temperature = opts.temperature ?? 0.2;
  // Streaming guard: stop a generation as soon as its spoken text starts looping rather
  // than paying for (and waiting on) a runaway to maxOutputTokens. Checked every ~800
  // streamed characters — cheap, and well under one detection window of lag.
  let loopAborted = false;
  let checkedAt = 0;
  const shouldAbort = (raw: string): string | null => {
    if (raw.length - checkedAt < 800) return null;
    checkedAt = raw.length;
    if (!tailIsDegenerate(transcriptTextOf(raw))) return null;
    loopAborted = true;
    return "degenerate repetition";
  };

  let lastResult: ChunkTranscriptionResult | undefined;

  for (let attempt = 0; attempt <= validationRetries; attempt++) {
    loopAborted = false;
    checkedAt = 0;
    const gen = await client.generateJson<LlmTranscriptJson>(
      model,
      prompt,
      [{ path: chunkPath }],
      TRANSCRIPT_SCHEMA as Record<string, unknown>,
      {
        temperature,
        maxRetries: 3,
        logKind: "transcribe",
        logChunk: ctx.index - 1,
        shouldAbort,
      },
    );

    if (gen.error || !gen.data) {
      lastResult = {
        segments: [],
        raw: gen.raw,
        usage: gen.usage,
        validation: {
          isValid: false,
          degenerate: loopAborted,
          spanSec: 0,
          segmentCount: 0,
          message: gen.error || "no data",
        },
        error: gen.error,
      };
      logger.warn(
        `[llm] chunk ${ctx.index} attempt ${attempt + 1}: API/parse error — ${gen.error}`,
      );
      if (loopAborted) temperature = Math.min(1, temperature + 0.3);
      continue;
    }

    const { segments, dropped } = parseLlmSegments(gen.data, chunkStartSec);
    const v = validate(segments, opts.chunkDurationSec);
    lastResult = { segments, raw: gen.raw, usage: gen.usage, validation: v };

    if (v.isValid) {
      logger.info(
        `[llm] chunk ${ctx.index} ok: ${v.message}${dropped ? `, dropped ${dropped}` : ""}`,
      );
      return lastResult;
    }
    logger.warn(
      `[llm] chunk ${ctx.index} attempt ${attempt + 1} validation: ${v.message}`,
    );
    if (v.degenerate) temperature = Math.min(1, temperature + 0.3);
  }

  // Return the last (invalid) result so the caller can decide to fall back.
  logger.error(
    `[llm] chunk ${ctx.index} failed validation after ${validationRetries + 1} attempts`,
  );
  return lastResult!;
}
