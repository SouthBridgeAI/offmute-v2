/**
 * Alignment layer — the crux of offmute-v2.
 *
 * The multimodal LLM gives high-quality diarized text but only coarse/sparse
 * timestamps. The ASR gives precise word-level timings but unreliable diarization.
 * We align the LLM's token stream to the ASR's word stream (both describe the same
 * audio, so the sequences are ~90%+ similar) and read precise timings off the ASR
 * words that match each LLM segment. This is "forced alignment" using an existing
 * ASR transcript as the timing reference rather than an acoustic model.
 *
 * Browser-safe (pure functions, no deps).
 */
import type { TimedWord } from "../types.js";

/** Normalize a token for matching: lowercase, strip non-alphanumerics. */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Split text into raw word tokens (keeps surface form). */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

export interface AlignPair {
  /** index into sequence A (LLM tokens), or null if A had a gap (ASR-only word) */
  ai: number | null;
  /** index into sequence B (ASR words), or null if B had a gap (LLM-only token) */
  bi: number | null;
  /** true if ai and bi are a real (normalized-equal) match */
  match: boolean;
}

/**
 * Global sequence alignment (Needleman–Wunsch) on normalized tokens.
 * Returns the alignment path as a list of pairs. O(n*m) time/space — fine for
 * chunk-sized inputs (a few thousand tokens). For whole-file we align per chunk.
 *
 * To bound cost on large inputs we use a Hirschberg-free banded variant: if both
 * inputs are long and similar length, we still run full DP but with Int32 arrays.
 */
export function alignTokens(a: string[], b: string[]): AlignPair[] {
  const n = a.length;
  const m = b.length;
  const MATCH = 2;
  const MISMATCH = -1;
  const GAP = -1;

  // DP score matrix (n+1) x (m+1) using a flat Int32Array
  const w = m + 1;
  const score = new Int32Array((n + 1) * w);
  // backpointer: 0=diag,1=up(gap in b),2=left(gap in a)
  const back = new Uint8Array((n + 1) * w);

  for (let i = 1; i <= n; i++) {
    score[i * w] = i * GAP;
    back[i * w] = 1;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = j * GAP;
    back[j] = 2;
  }

  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]!;
    const rowOff = i * w;
    const prevRowOff = (i - 1) * w;
    for (let j = 1; j <= m; j++) {
      const isMatch = ai === b[j - 1];
      const diag = score[prevRowOff + j - 1]! + (isMatch ? MATCH : MISMATCH);
      const up = score[prevRowOff + j]! + GAP;
      const left = score[rowOff + j - 1]! + GAP;
      let best = diag;
      let dir = 0;
      if (up > best) {
        best = up;
        dir = 1;
      }
      if (left > best) {
        best = left;
        dir = 2;
      }
      score[rowOff + j] = best;
      back[rowOff + j] = dir;
    }
  }

  // traceback
  const pairs: AlignPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && back[i * w + j] === 0) {
      pairs.push({ ai: i - 1, bi: j - 1, match: a[i - 1] === b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || back[i * w + j] === 1)) {
      pairs.push({ ai: i - 1, bi: null, match: false });
      i--;
    } else {
      pairs.push({ ai: null, bi: j - 1, match: false });
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

// ---------------------------------------------------------------------------
// Token-level alignment (richer API used by the real pipeline)
// ---------------------------------------------------------------------------

export interface AlignedToken {
  /** original LLM surface token (with punctuation) */
  surface: string;
  norm: string;
  /** index of the turn this token belongs to */
  turnIndex: number;
  /** matched ASR word time (seconds), or null if unmatched (filled by interpolation) */
  start: number | null;
  end: number | null;
  matched: boolean;
  /** ASR speaker label of the matched word (for voice-anchored identity) */
  asrSpeaker?: string;
}

/** Something with text we can tokenize (an LLM turn). */
export interface HasText {
  text: string;
}

/**
 * Align the concatenated LLM turn token stream to ASR words and return every LLM
 * token tagged with its turn index and matched ASR time (null where unmatched).
 */
export function alignLlmToAsr(turns: HasText[], asrWords: TimedWord[]): AlignedToken[] {
  const tokens: AlignedToken[] = [];
  turns.forEach((turn, turnIndex) => {
    for (const surface of tokenize(turn.text)) {
      const norm = normalizeToken(surface);
      if (!norm) continue; // skip pure-punctuation tokens for alignment
      tokens.push({ surface, norm, turnIndex, start: null, end: null, matched: false });
    }
  });

  const asrNorm = asrWords.map((w) => normalizeToken(w.text));
  const pairs = alignTokens(
    tokens.map((t) => t.norm),
    asrNorm
  );

  for (const p of pairs) {
    if (p.ai === null) continue; // ASR-only word (gap in LLM) — ignore
    // p.ai indexes the llm token array (same order as `tokens`)
    const tok = tokens[p.ai]!;
    if (p.match && p.bi !== null) {
      const w = asrWords[p.bi]!;
      tok.start = w.start;
      tok.end = w.end;
      tok.matched = true;
      if (w.speaker) tok.asrSpeaker = w.speaker;
    }
  }
  return tokens;
}

/**
 * Fill null token times by interpolating between matched neighbors. Tokens before
 * the first match take the first matched start; after the last match take the last
 * matched end. Returns the same array (mutated).
 */
export function fillTokenTimes(tokens: AlignedToken[], totalDuration: number): AlignedToken[] {
  const n = tokens.length;
  if (n === 0) return tokens;
  // find anchor indices
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) if (tokens[i]!.matched) anchors.push(i);
  if (anchors.length === 0) {
    // no matches at all — spread across whole duration
    for (let i = 0; i < n; i++) {
      tokens[i]!.start = (i / n) * totalDuration;
      tokens[i]!.end = ((i + 1) / n) * totalDuration;
    }
    return tokens;
  }
  // leading
  const first = anchors[0]!;
  for (let i = 0; i < first; i++) {
    tokens[i]!.start = tokens[first]!.start;
    tokens[i]!.end = tokens[first]!.start;
  }
  // trailing
  const last = anchors[anchors.length - 1]!;
  for (let i = last + 1; i < n; i++) {
    tokens[i]!.start = tokens[last]!.end;
    tokens[i]!.end = tokens[last]!.end;
  }
  // between consecutive anchors
  for (let a = 0; a < anchors.length - 1; a++) {
    const lo = anchors[a]!;
    const hi = anchors[a + 1]!;
    const t0 = tokens[lo]!.end ?? tokens[lo]!.start ?? 0;
    const t1 = tokens[hi]!.start ?? t0;
    const gap = hi - lo;
    for (let i = lo + 1; i < hi; i++) {
      const frac = (i - lo) / gap;
      const t = t0 + frac * (t1 - t0);
      tokens[i]!.start = t;
      tokens[i]!.end = t;
    }
  }
  return tokens;
}

export interface AlignedSegment {
  turnIndex: number;
  start: number;
  end: number;
  text: string;
  /** fraction of tokens that matched an ASR word */
  matchRatio: number;
  tokenCount: number;
  matchedTokens: number;
}

export interface SegmentOptions {
  /** split into display-sized cues (sentence / gap / length). Default false = one segment per turn. */
  subSegment?: boolean;
  /** max characters per display cue */
  maxChars?: number;
  /** max seconds per display cue */
  maxDuration?: number;
  /** split when the gap before the next token exceeds this (seconds) */
  gapSplit?: number;
  /** minimum characters before allowing a sentence-boundary split */
  minChars?: number;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

/**
 * Group aligned tokens into output segments. Tokens already carry filled times.
 * One segment per turn by default; if subSegment, cut turns into readable cues.
 */
export function buildSegmentsFromTokens(
  turns: HasText[],
  tokens: AlignedToken[],
  options: SegmentOptions = {}
): AlignedSegment[] {
  const {
    subSegment = false,
    maxChars = 90,
    maxDuration = 7,
    gapSplit = 1.0,
    minChars = 24,
  } = options;

  // group tokens by turn
  const byTurn = new Map<number, AlignedToken[]>();
  for (const t of tokens) {
    const arr = byTurn.get(t.turnIndex);
    if (arr) arr.push(t);
    else byTurn.set(t.turnIndex, [t]);
  }

  const segments: AlignedSegment[] = [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const toks = byTurn.get(turnIndex);
    if (!toks || toks.length === 0) continue;

    if (!subSegment) {
      segments.push(makeSegment(turnIndex, toks));
      continue;
    }

    // accumulate tokens into cues
    let cur: AlignedToken[] = [];
    let curChars = 0;
    const flush = () => {
      if (cur.length > 0) {
        segments.push(makeSegment(turnIndex, cur));
        cur = [];
        curChars = 0;
      }
    };
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i]!;
      cur.push(tok);
      curChars += tok.surface.length + 1;
      const next = toks[i + 1];
      const curStart = cur[0]!.start ?? 0;
      const curEnd = tok.end ?? curStart;
      const dur = curEnd - curStart;
      // Only trust the inter-token gap when BOTH tokens are real ASR matches —
      // interpolated tokens are spread evenly and would trigger spurious splits.
      const bothMatched = tok.matched && (next?.matched ?? false);
      const gapToNext = bothMatched && next && next.start !== null && tok.end !== null ? next.start - tok.end : 0;

      const sentenceBreak = SENTENCE_END.test(tok.surface) && curChars >= minChars;
      const tooLong = curChars >= maxChars || dur >= maxDuration;
      const bigGap = gapToNext >= gapSplit && curChars >= minChars;

      if (sentenceBreak || tooLong || bigGap) flush();
    }
    flush();
  }
  return segments;
}

/**
 * For each LLM turn label, count which ASR speakers its matched words belong to.
 * Used for voice-anchored speaker canonicalization (labels sharing a dominant ASR
 * speaker are likely the same person, even if the LLM labeled them inconsistently).
 */
export function asrSpeakerByLabel(
  tokens: AlignedToken[],
  labelByTurn: string[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const tok of tokens) {
    if (!tok.matched || !tok.asrSpeaker) continue;
    const label = labelByTurn[tok.turnIndex];
    if (label === undefined) continue;
    (out[label] ??= {});
    out[label]![tok.asrSpeaker] = (out[label]![tok.asrSpeaker] ?? 0) + 1;
  }
  return out;
}

function makeSegment(turnIndex: number, toks: AlignedToken[]): AlignedSegment {
  const matched = toks.filter((t) => t.matched);
  const starts = toks.map((t) => t.start).filter((x): x is number => x !== null);
  const ends = toks.map((t) => t.end).filter((x): x is number => x !== null);
  const start = starts.length ? Math.min(...starts) : 0;
  const end = ends.length ? Math.max(...ends) : start;
  return {
    turnIndex,
    start,
    end: Math.max(end, start),
    text: toks.map((t) => t.surface).join(" "),
    matchRatio: toks.length ? matched.length / toks.length : 0,
    tokenCount: toks.length,
    matchedTokens: matched.length,
  };
}

