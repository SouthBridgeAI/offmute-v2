/**
 * Word tokenization + normalization for alignment matching.
 * Matching is case- and punctuation-insensitive; original text is preserved for output.
 */
export interface Token {
  /** Original word as it appeared. */
  original: string;
  /** Normalized form used for matching (lowercase, no surrounding punctuation). */
  norm: string;
}

/** Strip surrounding punctuation; keep internal apostrophes/hyphens. */
function normalize(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, "")
    .replace(/'+$/g, "")
    .replace(/^'+/g, "");
}

/** Tokenize text into matchable tokens. Drops tokens that normalize to empty. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    const norm = normalize(raw);
    if (norm) out.push({ original: raw, norm });
  }
  return out;
}

/** Quick fuzzy equality: equal, or equal after stripping a trailing 's' / minor edits. */
export function fuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
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
