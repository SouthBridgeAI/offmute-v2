/**
 * Word tokenization + normalization for alignment matching.
 * Matching is case- and punctuation-insensitive; original text is preserved for output.
 *
 * Normalization is Unicode-aware: letters and digits of any script survive (Hangul,
 * Malayalam, Devanagari, Cyrillic, accented Latin). An ASCII-only version emptied every
 * non-Latin word, so a Korean meeting could not anchor a single word to the ASR clock and
 * "café" matched as "caf". Scripts written without spaces (Chinese, Japanese) still arrive
 * as one token per run of characters; splitting them is not done here.
 */
export interface Token {
  /** Original word as it appeared. */
  original: string;
  /** Normalized form used for matching (lowercase, no surrounding punctuation). */
  norm: string;
}

/** Lowercase, NFKC, curly apostrophes straightened; surrounding punctuation stripped while
 * internal apostrophes/hyphens are kept. Combining marks count as part of the word: a
 * Malayalam or Hindi word can end in a vowel sign. The one normalization every matcher
 * shares. */
export function normalizeWord(word: string): string {
  return word
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{M}\p{N}']+|[^\p{L}\p{M}\p{N}']+$/gu, "")
    .replace(/^'+|'+$/g, "");
}

/** Tokenize text into matchable tokens. Drops tokens that normalize to empty. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    const norm = normalizeWord(raw);
    if (norm) out.push({ original: raw, norm });
  }
  return out;
}

/** Quick fuzzy equality: equal, or equal after stripping a trailing 's' / minor edits. */
export function fuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  // An empty form (a word that was only punctuation) must not fuzzy-match every
  // one-letter word ("I", "a") by being one edit away from it.
  if (!a || !b) return false;
  // Tolerate a single-character difference for short ASR typos.
  if (Math.abs(a.length - b.length) <= 1) {
    return editDistanceChars(a, b, 1) <= 1;
  }
  return false;
}

function editDistanceChars(a: string, b: string, max: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = cur[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > max) return max + 1; // early exit
    prev = cur;
  }
  return prev[n]!;
}
