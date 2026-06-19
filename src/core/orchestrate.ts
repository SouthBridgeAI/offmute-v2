/**
 * Shared diarize→align→merge orchestration, used by BOTH the Node and browser
 * pipelines (previously duplicated in each — the review's "most likely source of
 * future divergence"). Everything provider/media/disk-specific is injected via
 * `diarizeChunk` (produce the raw LLM text for one chunk) and `onChunk` (side
 * effects like saving intermediates / partial output). Browser-safe.
 */
import type { AsrResult, LlmLine, TimeChunk } from "../types.js";
import { calculateChunks, chunkOwnership, mergeChunkSegments, type MergeableSegment } from "./chunk.js";
import { buildAsrHint, buildDiarizationPrompt } from "./prompts.js";
import { parseDiarizedText } from "./parse-diarized.js";
import { alignTurnsToSegments, type PlainSegment } from "./assemble.js";

/** Build a minimal AsrResult whose utterances fall within [start,end]; when
 * `relative`, times are shifted to be relative to `start` so the hint matches the
 * chunk-relative timestamps we ask the LLM to emit. */
export function sliceAsrWindow(asr: AsrResult, start: number, end: number, relative: boolean): AsrResult {
  const off = relative ? start : 0;
  const utterances = asr.utterances
    .filter((u) => u.end >= start && u.start <= end)
    .map((u) => ({ ...u, start: u.start - off, end: u.end - off }));
  return { ...asr, utterances, words: [] };
}

/** Merge per-chunk label→ASR-speaker counts into an accumulator (in place). */
export function mergeVoiceDist(
  target: Record<string, Record<string, number>>,
  source: Record<string, Record<string, number>>
): void {
  for (const [label, counts] of Object.entries(source)) {
    target[label] ??= {};
    for (const [sp, n] of Object.entries(counts)) target[label]![sp] = (target[label]![sp] ?? 0) + n;
  }
}

export interface ChunkContext {
  chunk: TimeChunk;
  index: number;
  total: number;
  chunked: boolean;
  /** the assembled diarization prompt for this chunk */
  prompt: string;
}

export interface OrchestrateOptions {
  asr?: AsrResult;
  durationSeconds: number;
  instructions?: string;
  subSegment: boolean;
  maxSinglePassSeconds: number;
  chunkSeconds: number;
  overlapSeconds: number;
  /** AbortSignal-like; checked at each chunk boundary */
  signal?: { throwIfAborted(): void };
  onProgress?: (message: string, index: number, total: number) => void;
  /** produce the raw diarization text for one chunk (audio + LLM + caching) — injected */
  diarizeChunk: (ctx: ChunkContext) => Promise<string>;
  /** called after each chunk is parsed+aligned (e.g. save intermediates / partial output) */
  onChunk?: (info: {
    index: number;
    total: number;
    chunked: boolean;
    rawText: string;
    turns: LlmLine[];
    /** all ownership-filtered segments accumulated so far, sorted by start */
    segmentsSoFar: PlainSegment[];
  }) => void | Promise<void>;
}

export interface OrchestrateResult {
  segments: PlainSegment[];
  allTurns: LlmLine[];
  voiceDist: Record<string, Record<string, number>>;
  chunkCount: number;
}

const toPlain = (m: MergeableSegment): PlainSegment => ({
  start: m.start,
  end: m.end,
  speakerLabel: m.speakerLabel,
  tone: m.tone,
  text: m.text,
  matchRatio: m.matchRatio,
});

export async function orchestrateChunks(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const { asr, durationSeconds, instructions, subSegment, signal, onProgress, diarizeChunk, onChunk } = opts;

  const timeChunks: TimeChunk[] =
    durationSeconds <= opts.maxSinglePassSeconds
      ? [{ index: 0, startSeconds: 0, endSeconds: durationSeconds }]
      : calculateChunks(durationSeconds, opts.chunkSeconds, opts.overlapSeconds);
  const chunked = timeChunks.length > 1;
  const ownership = chunked ? chunkOwnership(timeChunks, durationSeconds) : null;

  const allTurns: LlmLine[] = [];
  const mergeable: MergeableSegment[] = [];
  const voiceDist: Record<string, Record<string, number>> = {};
  let previousTail = "";

  for (const ch of timeChunks) {
    signal?.throwIfAborted();
    onProgress?.(chunked ? `Diarizing chunk ${ch.index + 1}/${timeChunks.length}` : `Diarizing`, ch.index, timeChunks.length);

    const windowHint = asr && asr.diarized ? buildAsrHint(sliceAsrWindow(asr, ch.startSeconds, ch.endSeconds, chunked)) : undefined;
    const prompt = buildDiarizationPrompt({
      instructions,
      asrHint: windowHint,
      chunk: chunked ? { index: ch.index, total: timeChunks.length, startSeconds: ch.startSeconds } : undefined,
      previousTail: chunked ? previousTail : undefined,
    });

    const rawText = await diarizeChunk({ chunk: ch, index: ch.index, total: timeChunks.length, chunked, prompt });
    const turns = parseDiarizedText(rawText);
    if (turns.length === 0) throw new Error(`No diarized turns parsed from LLM output${chunked ? ` (chunk ${ch.index})` : ""}`);
    previousTail = turns.slice(-3).map((t) => `${t.speaker}: ${t.text}`).join("\n");
    // chunk timestamps are chunk-relative — make absolute so the no-ASR fallback orders correctly
    if (chunked) for (const t of turns) if (t.approxStart !== undefined) t.approxStart += ch.startSeconds;
    allTurns.push(...turns);

    if (asr) {
      const windowWords = chunked
        ? asr.words.filter((w) => w.start >= ch.startSeconds - 2 && w.start <= ch.endSeconds + 2)
        : asr.words;
      const { segments, voiceDist: vd } = alignTurnsToSegments(turns, windowWords, durationSeconds, subSegment);
      mergeVoiceDist(voiceDist, vd);
      const own = ownership?.[ch.index];
      for (const s of segments) {
        if (own) {
          const center = (s.start + s.end) / 2;
          if (center < own.start || center >= own.end) continue; // emitted by the owning chunk only
        }
        mergeable.push({ ...s, chunkIndex: ch.index });
      }
    }

    if (onChunk) {
      const segmentsSoFar = [...mergeable].sort((a, b) => a.start - b.start).map(toPlain);
      await onChunk({ index: ch.index, total: timeChunks.length, chunked, rawText, turns, segmentsSoFar });
    }
  }

  let segments: PlainSegment[];
  if (asr) {
    const merged = chunked ? mergeChunkSegments(mergeable, timeChunks) : mergeable;
    segments = merged.map(toPlain);
  } else {
    segments = alignTurnsToSegments(allTurns, undefined, durationSeconds, subSegment).segments;
  }
  return { segments, allTurns, voiceDist, chunkCount: timeChunks.length };
}
