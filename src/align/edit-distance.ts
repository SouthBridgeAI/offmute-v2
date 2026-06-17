/**
 * Word-level sequence alignment via dynamic programming (Needleman-Wunsch / edit
 * distance). Aligns an LLM word sequence to an ASR word sequence, returning the
 * match/substitute/insert/delete operations for timing transfer.
 *
 * Costs (×2 to stay integer): exact match = 0, fuzzy match (1-char) = 1,
 * substitute = 2, indel = 2. Exact is strictly preferred over fuzzy over sub so
 * ties don't scatter common words to later occurrences.
 */
import { fuzzyEqual } from "./normalize.js";

/** Minimal token shape needed for alignment (both Token and AsrToken satisfy it). */
export interface AlignToken {
  norm: string;
}

export type AlignOp =
  | { type: "match"; llm: number; asr: number; fuzzy: boolean }
  | { type: "substitute"; llm: number; asr: number }
  | { type: "insert"; llm: number } // LLM word with no corresponding ASR word
  | { type: "delete"; asr: number }; // ASR word skipped (not in LLM)

export interface AlignResult {
  ops: AlignOp[];
  exactMatches: number;
  fuzzyMatches: number;
  substitutions: number;
  insertions: number;
  deletions: number;
}

const INDEL = 2;

function matchCost(a: AlignToken, b: AlignToken): { cost: number; fuzzy: boolean } {
  if (a.norm === b.norm) return { cost: 0, fuzzy: false };
  if (fuzzyEqual(a.norm, b.norm)) return { cost: 1, fuzzy: true };
  return { cost: 2, fuzzy: false }; // substitute
}

/** Align two token sequences. Returns ops + counts. */
export function alignWords(llm: AlignToken[], asr: AlignToken[]): AlignResult {
  const m = llm.length;
  const n = asr.length;
  // dp[i][j] = min cost to align llm[:i] with asr[:j].
  const dp: Int32Array[] = new Array(m + 1);
  for (let i = 0; i <= m; i++) {
    const row = new Int32Array(n + 1);
    row[0] = i * INDEL;
    dp[i] = row;
  }
  const firstRow = dp[0]!;
  for (let j = 0; j <= n; j++) firstRow[j] = j * INDEL;

  for (let i = 1; i <= m; i++) {
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      const { cost } = matchCost(llm[i - 1]!, asr[j - 1]!);
      const sub = prev[j - 1]! + cost;
      const ins = prev[j]! + INDEL;
      const del = row[j - 1]! + INDEL;
      row[j] = Math.min(sub, ins, del);
    }
  }

  // Backtrace.
  const ops: AlignOp[] = [];
  let i = m;
  let j = n;
  let exact = 0;
  let fuzzy = 0;
  let subs = 0;
  let ins = 0;
  let del = 0;
  while (i > 0 || j > 0) {
    const cur = dp[i]!;
    if (i > 0 && j > 0) {
      const { cost } = matchCost(llm[i - 1]!, asr[j - 1]!);
      const sub = dp[i - 1]![j - 1]! + cost;
      if (cur[j]! === sub) {
        if (cost === 0) {
          ops.push({ type: "match", llm: i - 1, asr: j - 1, fuzzy: false });
          exact++;
        } else if (cost === 1) {
          ops.push({ type: "match", llm: i - 1, asr: j - 1, fuzzy: true });
          fuzzy++;
        } else {
          ops.push({ type: "substitute", llm: i - 1, asr: j - 1 });
          subs++;
        }
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && cur[j]! === dp[i - 1]![j]! + INDEL) {
      ops.push({ type: "insert", llm: i - 1 });
      ins++;
      i--;
      continue;
    }
    ops.push({ type: "delete", asr: j - 1 });
    del++;
    j--;
  }

  ops.reverse();
  return {
    ops,
    exactMatches: exact,
    fuzzyMatches: fuzzy,
    substitutions: subs,
    insertions: ins,
    deletions: del,
  };
}
