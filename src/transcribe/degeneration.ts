/**
 * Degenerate-repetition detection for LLM transcripts — the "Bye. See ya. Take care. You
 * too. Bye. Bye. See ya…" loop a multimodal model can fall into on hard audio (faint or
 * distant speech). Same idea as Whisper's compression-ratio check: text that compresses
 * too well is a loop, not speech. Measured over sliding windows, so a loop inside an
 * otherwise normal 10-minute chunk still trips it.
 *
 * Pure JS (an LZ77 parse, no entropy coding) rather than zlib: this module is reachable
 * from the browser bundle, which must not grow another Node builtin import.
 *
 * Calibrated on 103 real 10-minute chunks (field report 1): every legitimate chunk peaked
 * at ≤ 1.73; the three hallucinated ones at 2.72, 6.45 and 8.16.
 */

export const DEGENERATE_COMPRESSION_RATIO = 2.2;
const WINDOW_CHARS = 400;
const STEP_CHARS = 200;
const MIN_MATCH = 4;
const MAX_MATCH = 258;
/** Cost of one back-reference, in "bytes" (vs 1 per literal character). */
const REF_COST = 3;

/** Compression ratio of a greedy LZ77 parse of `s` (search window = the text before). */
function ratio(s: string): number {
  let cost = 0;
  for (let i = 0; i < s.length; ) {
    let best = 0;
    for (let j = Math.max(0, i - WINDOW_CHARS); j < i; j++) {
      let k = 0;
      while (i + k < s.length && k < MAX_MATCH && s[j + k] === s[i + k]) k++;
      if (k > best) best = k;
    }
    if (best >= MIN_MATCH) {
      cost += REF_COST;
      i += best;
    } else {
      cost += 1;
      i += 1;
    }
  }
  return s.length / cost;
}

/** Max compression ratio over sliding windows (0 when shorter than one window — short
 * strings don't carry enough signal, and loops are long). */
export function maxCompressionRatio(text: string): number {
  if (text.length < WINDOW_CHARS) return 0;
  let max = 0;
  for (let i = 0; i + WINDOW_CHARS <= text.length; i += STEP_CHARS) {
    max = Math.max(max, ratio(text.slice(i, i + WINDOW_CHARS)));
  }
  return Math.max(max, ratio(text.slice(-WINDOW_CHARS))); // cover the tail window too
}

/** True when the last two windows of a growing transcript both compress like a loop —
 * i.e. the repetition has persisted, not just one phrase said twice. For aborting a
 * streaming generation early instead of paying for a 65k-token runaway. */
export function tailIsDegenerate(text: string): boolean {
  if (text.length < 2 * WINDOW_CHARS) return false;
  return (
    ratio(text.slice(-WINDOW_CHARS)) > DEGENERATE_COMPRESSION_RATIO &&
    ratio(text.slice(-2 * WINDOW_CHARS, -WINDOW_CHARS)) > DEGENERATE_COMPRESSION_RATIO
  );
}

/** The spoken text inside a (possibly incomplete, still-streaming) transcript JSON: the
 * `"text"` string values, joined — INCLUDING a final value that hasn't closed yet. That
 * unterminated value is exactly where a runaway lives: a live run looped inside a single
 * segment's text for 145k characters, which a completed-values-only reader never sees.
 * (Raw JSON can't be measured directly — its repeated keys compress well regardless of
 * what was said.) */
export function transcriptTextOf(partialJson: string): string {
  const out: string[] = [];
  for (const m of partialJson.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/g))
    out.push(m[1]!);
  return out.join(" ");
}
