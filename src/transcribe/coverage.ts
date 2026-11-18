/**
 * Coverage: did the LLM transcribe as much of a chunk as the ASR heard?
 *
 * The LLM's failures on real meetings were mostly omissions that passed every structural
 * check: a final chunk that stopped after 26 s of 10.5 minutes, a chunk that wrote one
 * "[silence]" segment over 8.5 minutes of conversation, a chunk that looped on "Um...".
 * Each still "spanned the chunk". Counting words catches all three: the LLM wrote 0.04,
 * 0.17 and 0.39 words per ASR word in those chunks, against 0.94–1.61 in the 80 good
 * chunks of the same 17 meetings that had enough speech to judge (offmute code review,
 * Nov 2026). Quiet chunks aren't judged, so a pause in a call can't trip it.
 */
import type { TimestampedWord } from "../core/types.js";
import { tokenize } from "../align/normalize.js";

/** Below this many LLM words per ASR word, a chunk lost speech. */
export const MIN_COVERAGE_RATIO = 0.6;
/** Chunks where the ASR heard fewer words than this aren't judged. */
const MIN_ASR_WORDS = 200;

export interface ChunkCoverage {
  llmWords: number;
  asrWords: number;
  /** llmWords / asrWords (Infinity when the ASR heard nothing). */
  ratio: number;
  /** Whether there was enough ASR speech to judge. */
  judged: boolean;
  /** Judged, and below MIN_COVERAGE_RATIO. */
  low: boolean;
}

export function chunkCoverage(
  segments: { text: string }[],
  asrWords: TimestampedWord[],
  start: number,
  end: number,
): ChunkCoverage {
  // Bracketed annotations ([inaudible], [silence]) are the LLM's notes, not speech.
  const llmWords = segments.reduce(
    (n, s) => n + tokenize(s.text.replace(/\[[^\]]*\]/g, " ")).length,
    0,
  );
  const asrCount = asrWords.reduce(
    (n, w) => n + (w.start >= start && w.start < end ? tokenize(w.text).length : 0),
    0,
  );
  const ratio = asrCount ? llmWords / asrCount : Infinity;
  const judged = asrCount >= MIN_ASR_WORDS;
  return {
    llmWords,
    asrWords: asrCount,
    ratio,
    judged,
    low: judged && ratio < MIN_COVERAGE_RATIO,
  };
}
