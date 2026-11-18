/**
 * ASR grounding: is a chunk's LLM text about what the audio's ASR actually heard?
 *
 * The multimodal LLM is the better listener — but over faint or distant speech it can
 * write a fluent conversation that never happened (field report 1: a neighbouring
 * table's muffled meeting came back as an invented one — "customer testimonials… let's
 * touch base next week"). ASR doesn't fail that way: it transcribes what is acoustically
 * there, however clumsily. So when most of a chunk's content words appear nowhere in the
 * ASR transcript of the same time range, the chunk's text isn't grounded in the audio.
 *
 * Calibrated on 103 real 10-minute chunks: the three fabricated ones scored 0.05–0.26;
 * every legitimate chunk ≥ 0.37 (a sparse, mostly-[inaudible] pre-meeting chunk) and
 * typically 0.8–0.95. The threshold is deliberately conservative — this is a backstop
 * behind the repetition check (degeneration.ts), which caught all three on its own.
 */
import type { TimestampedWord } from "../core/types.js";
import type { ParsedLlmSegment } from "./llm-transcribe.js";

/** Below this share of LLM content tokens corroborated by ASR, the text is ungrounded. */
export const MIN_GROUNDED_PRECISION = 0.3;
/** Too little text on either side to judge. */
const MIN_TOKENS = 30;
/** Max difference in non-Latin-script share between the two sides before the scripts
 * are considered different (e.g. ASR emitting Chinese characters for romanized
 * Malayalam) — then the ASR is the unreliable side and no judgment is made. */
const MAX_SCRIPT_SHARE_GAP = 0.2;

// English function words: they match by chance and would mask fabricated content.
const STOP_WORDS: Record<string, true> = Object.fromEntries(
  (
    "the a an and or but so to of in on at for with is it's it i you we they he she that " +
    "this be are was were do don't not yeah yes okay ok like uh um mm hmm mhm oh just " +
    "i'm you're that's"
  )
    .split(" ")
    .map((w) => [w, true]),
);
const NON_LATIN = /[^\u0000-\u024F\u2000-\u206F]/u;

export interface ChunkGrounding {
  /** Content tokens in the LLM text, and in the ASR words of the same time range. */
  llmTokens: number;
  asrTokens: number;
  /** Share of the LLM's content tokens the ASR also heard (multiset overlap). */
  precision: number;
  /** Whether a judgment was made (enough text on both sides, matching scripts). */
  judged: boolean;
  grounded: boolean;
}

function contentTokens(words: string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const w of words) {
    const t = w
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")
      .replace(/^'+|'+$/g, "");
    if (t && !STOP_WORDS[t]) bag.set(t, (bag.get(t) ?? 0) + 1);
  }
  return bag;
}

export function chunkGrounding(
  segments: ParsedLlmSegment[],
  asrWords: TimestampedWord[],
  start: number,
  end: number,
): ChunkGrounding {
  const asrInRange = asrWords.filter((w) => w.start >= start && w.start < end);
  // Bracketed annotations ([inaudible], [music]) are the LLM's notes, not claimed speech.
  const llmWords = segments
    .map((s) => s.text.replace(/\[[^\]]*\]/g, " "))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
  const llm = contentTokens(llmWords);
  const asr = contentTokens(asrInRange.map((w) => w.text));
  let llmTokens = 0;
  let asrTokens = 0;
  let shared = 0;
  for (const n of llm.values()) llmTokens += n;
  for (const n of asr.values()) asrTokens += n;
  for (const [t, n] of llm) shared += Math.min(n, asr.get(t) ?? 0);

  const share = (ws: string[]) =>
    ws.length ? ws.filter((w) => NON_LATIN.test(w)).length / ws.length : 0;
  const scriptsMatch =
    Math.abs(share(llmWords) - share(asrInRange.map((w) => w.text))) <=
    MAX_SCRIPT_SHARE_GAP;
  const judged = llmTokens >= MIN_TOKENS && asrTokens >= MIN_TOKENS && scriptsMatch;
  const precision = llmTokens ? shared / llmTokens : 1;
  return {
    llmTokens,
    asrTokens,
    precision,
    judged,
    grounded: !judged || precision >= MIN_GROUNDED_PRECISION,
  };
}
