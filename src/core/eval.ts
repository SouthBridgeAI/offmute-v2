/**
 * Evaluation harness — quantitative comparison of a hypothesis transcript against
 * a reference (ground-truth SRT). Measures:
 *   - WER (word error rate) via token alignment
 *   - speaker accuracy (word-level, after optimal speaker label mapping)
 *   - timestamp error (median/p90 of |hyp.start - ref.start| over matched words)
 * Browser-safe.
 */
import { alignTokens, normalizeToken, tokenize } from "./align.js";

export interface EvalWord {
  norm: string;
  start: number;
  end: number;
  speaker: string;
}

/** A timed, speaker-labelled segment (cue/turn) → expand to per-word with interpolated times. */
export interface TimedSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/** Expand segments into words, linearly interpolating each word's time within its segment. */
export function segmentsToWords(segments: TimedSegment[]): EvalWord[] {
  const words: EvalWord[] = [];
  for (const seg of segments) {
    const toks = tokenize(seg.text).map((t) => normalizeToken(t)).filter(Boolean);
    if (toks.length === 0) continue;
    const span = Math.max(0, seg.end - seg.start);
    for (let i = 0; i < toks.length; i++) {
      const frac = toks.length === 1 ? 0 : i / toks.length;
      const fracEnd = toks.length === 1 ? 1 : (i + 1) / toks.length;
      words.push({
        norm: toks[i]!,
        start: seg.start + frac * span,
        end: seg.start + fracEnd * span,
        speaker: seg.speaker,
      });
    }
  }
  return words;
}

export interface EvalResult {
  refWords: number;
  hypWords: number;
  correct: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  wer: number;
  /** word-level speaker accuracy over aligned (matched) words, after mapping */
  speakerAccuracy: number;
  /** mapping hypSpeaker -> refSpeaker chosen to maximize agreement */
  speakerMapping: Record<string, string>;
  matchedForSpeaker: number;
  /** timestamp error stats (seconds) over matched words */
  timeMedian: number;
  timeP90: number;
  timeMean: number;
  timedMatches: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/**
 * Evaluate hypothesis words against reference words.
 * Both arrays must carry norm/start/speaker.
 */
export function evaluateWords(ref: EvalWord[], hyp: EvalWord[]): EvalResult {
  const pairs = alignTokens(
    ref.map((w) => w.norm),
    hyp.map((w) => w.norm)
  );

  let correct = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  // collect matched (ref,hyp) index pairs for speaker + timing analysis
  const matched: Array<{ ri: number; hi: number; correct: boolean }> = [];

  for (const p of pairs) {
    if (p.ai !== null && p.bi !== null) {
      if (p.match) {
        correct++;
        matched.push({ ri: p.ai, hi: p.bi, correct: true });
      } else {
        substitutions++;
        matched.push({ ri: p.ai, hi: p.bi, correct: false });
      }
    } else if (p.ai !== null) {
      deletions++;
    } else if (p.bi !== null) {
      insertions++;
    }
  }

  const refWords = ref.length;
  const wer = refWords > 0 ? (substitutions + deletions + insertions) / refWords : 0;

  // --- Speaker mapping (greedy, maximizing agreement over all matched pairs) ---
  const refSpeakers = [...new Set(ref.map((w) => w.speaker))];
  const hypSpeakers = [...new Set(hyp.map((w) => w.speaker))];
  // confusion[hypSpeaker][refSpeaker] = count over matched pairs
  const confusion = new Map<string, Map<string, number>>();
  for (const hs of hypSpeakers) confusion.set(hs, new Map());
  for (const m of matched) {
    const hs = hyp[m.hi]!.speaker;
    const rs = ref[m.ri]!.speaker;
    const row = confusion.get(hs)!;
    row.set(rs, (row.get(rs) ?? 0) + 1);
  }
  const speakerMapping: Record<string, string> = {};
  for (const hs of hypSpeakers) {
    const row = confusion.get(hs)!;
    let best = "";
    let bestN = -1;
    for (const rs of refSpeakers) {
      const n = row.get(rs) ?? 0;
      if (n > bestN) {
        bestN = n;
        best = rs;
      }
    }
    speakerMapping[hs] = best;
  }
  let speakerAgree = 0;
  for (const m of matched) {
    const mappedHyp = speakerMapping[hyp[m.hi]!.speaker];
    if (mappedHyp === ref[m.ri]!.speaker) speakerAgree++;
  }
  const speakerAccuracy = matched.length > 0 ? speakerAgree / matched.length : 0;

  // --- Timestamp error over correct matches ---
  const timeErrors: number[] = [];
  for (const m of matched) {
    if (!m.correct) continue;
    timeErrors.push(Math.abs(hyp[m.hi]!.start - ref[m.ri]!.start));
  }
  timeErrors.sort((a, b) => a - b);
  const timeMean =
    timeErrors.length > 0 ? timeErrors.reduce((a, b) => a + b, 0) / timeErrors.length : 0;

  return {
    refWords,
    hypWords: hyp.length,
    correct,
    substitutions,
    deletions,
    insertions,
    wer,
    speakerAccuracy,
    speakerMapping,
    matchedForSpeaker: matched.length,
    timeMedian: percentile(timeErrors, 50),
    timeP90: percentile(timeErrors, 90),
    timeMean,
    timedMatches: timeErrors.length,
  };
}
