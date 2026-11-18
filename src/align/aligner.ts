/**
 * Aligner: transfers accurate word-level timestamps from an ASR transcript onto the
 * richer LLM transcript (diarized, tone-annotated).
 *
 * Approach (ts-aligner): align the ENTIRE LLM token stream (all segments, in order)
 * against the ASR word stream in a single edit-distance DP pass, then split the
 * timed result back into segments. Long, ordered sequences pin common words ("the",
 * "as") to their correct occurrence — a per-segment windowed alignment scatters them
 * to later occurrences and drifts. One DP over the chunk is O(tokens × asrWords).
 */
import type { ParsedLlmSegment } from "../transcribe/llm-transcribe.js";
import type { TimestampedWord } from "../core/types.js";
import { normalizeWord, tokenize } from "./normalize.js";
import { alignWords, type AlignOp } from "./edit-distance.js";

export interface AlignedWord {
  text: string;
  start: number;
  end: number;
  matched: boolean;
}

export interface AlignedSegment {
  speaker: string;
  /** Display name (set by the consistency/identification pass). */
  speakerName?: string;
  start: number; // accurate absolute seconds
  end: number;
  text: string; // LLM text preserved
  tone: string[];
  confidence: number; // exact-match ratio in [0,1]
  timingSource: "aligned" | "interpolated" | "coarse" | "timestamped";
  words: AlignedWord[];
  sourceIndex: number;
}

export interface AlignOptions {
  /** Below this confidence, mark timing as interpolated (flag for repair). */
  confidenceThreshold?: number;
  /** Gate ASR to words within this many seconds of the LLM span (0 = use all). */
  timeMarginSec?: number;
}

interface AsrTok {
  text: string;
  start: number;
  end: number;
  norm: string;
}

interface LlmTok {
  original: string;
  norm: string;
  segIdx: number;
  window?: { lo: number; hi: number };
}

/** Slack around a chunk's audio range for words straddling its boundary (seconds). */
const WINDOW_SLACK_SEC = 2;
/** How far an unanchored segment's interpolated time may sit from the LLM's own timestamp
 * before the LLM's timestamp is trusted instead (seconds). On chunks every model completed,
 * LLM segment starts were within ~3 s of an independent ASR at the 90th percentile. */
const UNANCHORED_MAX_DRIFT_SEC = 15;
/** A segment longer than max(STRETCH_MIN_SEC, STRETCH_SEC_PER_WORD × its words) was
 * stretched by a far-away match; ordinary speech runs ~0.4 s a word with pauses. */
const STRETCH_MIN_SEC = 30;
const STRETCH_SEC_PER_WORD = 3;
/** Within a stretched segment, timed words more than this far apart start a new run. */
const MAX_INNER_GAP_SEC = 8;
/** A segment none of whose words the ASR confirmed gets SPOKEN_SEC_PER_WORD a word (at
 * least 1 s) once its interpolated span is longer than max(UNCONFIRMED_MAX_SEC, 3× that). */
const SPOKEN_SEC_PER_WORD = 0.5;
const UNCONFIRMED_MAX_SEC = 5;

function toAsrTokens(words: TimestampedWord[]): AsrTok[] {
  return words.map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
    norm: normalizeWord(w.text),
  }));
}

/** Assign times to every LLM token from the aligned ops; interpolate inserts. */
function transferTiming(
  llm: LlmTok[],
  asr: AsrTok[],
  ops: AlignOp[],
): { start: number; end: number; matched: boolean }[] {
  const times = llm.map(() => ({ start: NaN, end: NaN, matched: false }));
  for (const op of ops) {
    if (op.type === "match" || op.type === "substitute") {
      const a = asr[op.asr]!;
      times[op.llm] = {
        start: a.start,
        end: a.end,
        matched: op.type === "match" && !op.fuzzy,
      };
    }
  }
  // Interpolate inserted (unmatched) tokens from neighboring matched tokens.
  for (let k = 0; k < times.length; k++) {
    if (!isNaN(times[k]!.start)) continue;
    let prevEnd: number | null = null;
    for (let p = k - 1; p >= 0; p--) {
      if (!isNaN(times[p]!.start)) {
        prevEnd = times[p]!.end;
        break;
      }
    }
    let nextStart: number | null = null;
    for (let q = k + 1; q < times.length; q++) {
      if (!isNaN(times[q]!.start)) {
        nextStart = times[q]!.start;
        break;
      }
    }
    if (prevEnd !== null && nextStart !== null) {
      // Bound the run to the current segment so interpolation doesn't bleed across
      // a segment boundary.
      const segIdx = llm[k]!.segIdx;
      let runLen = 0;
      for (
        let r = k;
        r < times.length && isNaN(times[r]!.start) && llm[r]!.segIdx === segIdx;
        r++
      )
        runLen++;
      const step = (nextStart - prevEnd) / (runLen + 1);
      for (let r = 0; r < runLen; r++) {
        const pt = prevEnd + step * (r + 1);
        times[k + r] = { start: pt, end: pt, matched: false };
      }
      k += runLen - 1;
    } else if (nextStart !== null) {
      times[k] = { start: nextStart, end: nextStart, matched: false };
    } else if (prevEnd !== null) {
      times[k] = { start: prevEnd, end: prevEnd, matched: false };
    }
  }
  return times;
}

/** Align LLM segments to ASR words (single DP over the chunk). Segments need not be sorted. */
export function alignSegments(
  llmSegments: ParsedLlmSegment[],
  asrWords: TimestampedWord[],
  opts: AlignOptions = {},
): AlignedSegment[] {
  const confThreshold = opts.confidenceThreshold ?? 0.5;
  const margin = opts.timeMarginSec ?? 0;

  const sorted = [...llmSegments]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.startSec - b.s.startSec);

  // Build flat LLM token stream + per-segment token ranges.
  const flat: LlmTok[] = [];
  const segRanges: { src: number; start: number; end: number }[] = [];
  for (const { s, i } of sorted) {
    const toks = tokenize(s.text);
    const start = flat.length;
    // A segment's words can only be in the audio it was transcribed from.
    const window =
      s.chunkStart !== undefined && s.chunkEnd !== undefined
        ? { lo: s.chunkStart - WINDOW_SLACK_SEC, hi: s.chunkEnd + WINDOW_SLACK_SEC }
        : undefined;
    for (const t of toks)
      flat.push({ original: t.original, norm: t.norm, segIdx: i, window });
    segRanges.push({ src: i, start, end: flat.length });
  }

  if (flat.length === 0 || asrWords.length === 0) {
    return sorted.map(({ s, i }) => ({
      speaker: s.speaker,
      start: s.startSec,
      end: s.endSec,
      text: s.text,
      tone: s.tone,
      confidence: 0,
      timingSource: "coarse" as const,
      words: [],
      sourceIndex: i,
    }));
  }

  // Optionally gate ASR to the LLM span (±margin) to shrink the DP.
  let asr = toAsrTokens(asrWords);
  if (margin > 0) {
    const lo = sorted[0]!.s.startSec - margin;
    const hi = sorted[sorted.length - 1]!.s.endSec + margin;
    asr = asr.filter((w) => w.end >= lo && w.start <= hi);
  }

  const result = alignWords(flat, asr);
  const times = transferTiming(flat, asr, result.ops);

  if (process.env.ALIGN_DEBUG) {
    console.error(
      `[align] flat=${flat.length} asr=${asr.length} exact=${result.exactMatches} fuzzy=${result.fuzzyMatches} subs=${result.substitutions} ins=${result.insertions} del=${result.deletions}`,
    );
  }

  const out: AlignedSegment[] = [];
  for (let si = 0; si < sorted.length; si++) {
    const { s, i } = sorted[si]!;
    const range = segRanges[si]!;
    const segTimes = times.slice(range.start, range.end);
    const segOps = result.ops.filter(
      (op) =>
        (op.type === "match" || op.type === "substitute") &&
        op.llm >= range.start &&
        op.llm < range.end,
    );
    const exact = segOps.filter((op) => op.type === "match" && !op.fuzzy).length;
    const tokenCount = range.end - range.start;

    const firstTimed = segTimes.find((t) => !isNaN(t.start));
    const lastTimed = [...segTimes].reverse().find((t) => !isNaN(t.end));

    let start: number;
    let end: number;
    let timingSource: AlignedSegment["timingSource"];
    const confidence = tokenCount ? exact / tokenCount : 0;
    // When none of the segment's words was found in the ASR, its interpolated time is only
    // a position between anchors. That position is kept while it agrees with where the LLM
    // put the segment (a backchannel between two aligned turns); far from it, the anchors
    // say nothing about this segment (e.g. ASR that heard a Korean meeting as English) and
    // the LLM's own timestamps are the better estimate.
    const unanchoredDrift =
      segOps.length === 0 && firstTimed ? Math.abs(firstTimed.start - s.startSec) : 0;

    if (firstTimed && lastTimed && unanchoredDrift <= UNANCHORED_MAX_DRIFT_SEC) {
      start = firstTimed.start;
      end = lastTimed.end;
      timingSource = confidence >= confThreshold ? "aligned" : "interpolated";
      // A few words can't take minutes to say. When one of them matched the same common
      // word far away ("um", "yeah"), the segment stretches over everything between and
      // hides that stretch from gap-fill (a 6-word line spanned 65 s over a dropped chunk; a
      // 4-word one 91 s over a "[silence]" placeholder). Keep the run of words with the
      // most exact matches, split where two timed words are more than 8 s apart.
      if (end - start > Math.max(STRETCH_MIN_SEC, STRETCH_SEC_PER_WORD * tokenCount)) {
        const runs: { start: number; end: number; matched: number }[] = [];
        for (const t of segTimes) {
          if (isNaN(t.start)) continue;
          const run = runs[runs.length - 1];
          if (run && t.start - run.end <= MAX_INNER_GAP_SEC) {
            run.end = Math.max(run.end, t.end);
            if (t.matched) run.matched++;
          } else {
            runs.push({ start: t.start, end: t.end, matched: t.matched ? 1 : 0 });
          }
        }
        const best = runs.reduce((a, b) =>
          b.matched > a.matched ||
          (b.matched === a.matched &&
            Math.abs(b.start - s.startSec) < Math.abs(a.start - s.startSec))
            ? b
            : a,
        );
        start = best.start;
        end = best.end;
      }
      // With no word of its own confirmed, a segment knows its order but not its length:
      // its words are spread between the nearest confirmed ones, which can be far apart.
      // Spread that way, a 3-word goodbye covered 22 s of other talk and hid it from
      // gap-fill. It keeps a speaking-length span at its start instead.
      const spoken = Math.max(1, SPOKEN_SEC_PER_WORD * tokenCount);
      if (exact === 0 && end - start > Math.max(UNCONFIRMED_MAX_SEC, 3 * spoken)) {
        end = start + spoken;
      }
    } else {
      start = s.startSec;
      end = s.endSec;
      timingSource = "coarse";
    }

    // Coarse words are spread evenly over the segment, so SRT blocks built from word
    // times stay inside it; other words stay inside the segment's (possibly narrowed) span.
    const step = timingSource === "coarse" && tokenCount ? (end - start) / tokenCount : 0;
    const inside = (x: number) => Math.min(Math.max(x, start), end);
    const words: AlignedWord[] = segTimes.map((t, idx) =>
      timingSource === "coarse"
        ? {
            text: flat[range.start + idx]!.original,
            start: start + step * idx,
            end: start + step * (idx + 1),
            matched: false,
          }
        : {
            text: flat[range.start + idx]!.original,
            start: isNaN(t.start) ? start : inside(t.start),
            end: isNaN(t.end) ? end : inside(t.end),
            matched: t.matched,
          },
    );

    out.push({
      speaker: s.speaker,
      start,
      end,
      text: s.text,
      tone: s.tone,
      confidence,
      timingSource,
      words,
      sourceIndex: i,
    });
  }

  return out;
}

/** A segment anchors its chunk's clock only when the ASR confirms at least this many of
 * its words, and this share of them. Half was too little: a line the ASR heard worded
 * differently matched its common words a minute away and moved its whole chunk there. */
const CLOCK_ANCHOR_MIN_WORDS = 3;
const CLOCK_ANCHOR_MIN_SHARE = 0.6;

/**
 * Puts each LLM segment's own timestamps on the ASR's clock, chunk by chunk, before the
 * pipeline decides which chunk owns an overlap. Gemini sometimes runs a chunk's clock early
 * or late: one chunk's first line was stamped 59 s before it was spoken, so ownership,
 * decided on that clock, threw it away as the previous chunk's overlap, and the previous
 * chunk had stopped at the hand-over. Each chunk's segments are aligned against the ASR
 * words in that chunk's own audio; a segment the ASR confirms moves to its aligned start,
 * and every other segment moves by the shift of its nearest confirmed neighbour.
 */
export function toAsrClock(
  segments: ParsedLlmSegment[],
  asrWords: TimestampedWord[],
): ParsedLlmSegment[] {
  if (!asrWords.length) return segments;
  const chunks = new Map<number, ParsedLlmSegment[]>();
  for (const s of segments) {
    if (s.chunkIndex === undefined) continue;
    const group = chunks.get(s.chunkIndex);
    if (group) group.push(s);
    else chunks.set(s.chunkIndex, [s]);
  }

  const moved = new Map<ParsedLlmSegment, ParsedLlmSegment>();
  for (const group of chunks.values()) {
    const lo =
      Math.min(...group.map((s) => s.chunkStart ?? s.startSec)) - WINDOW_SLACK_SEC;
    const hi = Math.max(...group.map((s) => s.chunkEnd ?? s.endSec)) + WINDOW_SLACK_SEC;
    const aligned = alignSegments(
      group,
      asrWords.filter((w) => w.end >= lo && w.start <= hi),
    );
    const shifts = aligned.map((a) =>
      a.confidence >= CLOCK_ANCHOR_MIN_SHARE &&
      a.words.filter((w) => w.matched).length >= CLOCK_ANCHOR_MIN_WORDS
        ? a.start - group[a.sourceIndex]!.startSec
        : undefined,
    );
    for (let k = 0; k < aligned.length; k++) {
      let shift = shifts[k];
      for (let r = 1; shift === undefined && r < aligned.length; r++) {
        shift = shifts[k - r] ?? shifts[k + r];
      }
      const s = group[aligned[k]!.sourceIndex]!;
      moved.set(s, {
        ...s,
        startSec: s.startSec + (shift ?? 0),
        endSec: s.endSec + (shift ?? 0),
      });
    }
  }
  return segments.map((s) => moved.get(s) ?? s);
}
