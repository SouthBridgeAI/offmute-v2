import { describe, it, expect } from "vitest";
import { alignWords } from "../src/align/edit-distance.js";
import { tokenize } from "../src/align/normalize.js";
import { alignSegments, toAsrClock } from "../src/align/aligner.js";
import { partitionByOwnership } from "../src/transcribe/llm-transcribe.js";
import type { ParsedLlmSegment } from "../src/transcribe/llm-transcribe.js";
import type { TimestampedWord } from "../src/core/types.js";

describe("alignWords", () => {
  it("matches an identical sequence exactly", () => {
    const a = tokenize("the quick brown fox");
    const b = tokenize("the quick brown fox");
    const r = alignWords(a, b);
    expect(r.exactMatches).toBe(4);
    expect(r.insertions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.substitutions).toBe(0);
  });

  it("handles insertions (LLM has extra words)", () => {
    const a = tokenize("hello world today");
    const b = tokenize("hello world");
    const r = alignWords(a, b);
    expect(r.exactMatches).toBe(2);
    expect(r.insertions).toBe(1);
  });

  it("handles deletions (ASR has extra words)", () => {
    const a = tokenize("hello world");
    const b = tokenize("hello there world");
    const r = alignWords(a, b);
    expect(r.exactMatches).toBe(2);
    expect(r.deletions).toBe(1);
  });

  it("fuzzy-matches a 1-char typo but counts it separately from exact", () => {
    const a = tokenize("Rishi runs Southbridge");
    const b = tokenize("Rishy runs Southbridge");
    const r = alignWords(a, b);
    expect(r.exactMatches).toBe(2);
    expect(r.fuzzyMatches).toBe(1);
  });

  it("prefers the earliest exact match over a later fuzzy one (no scatter)", () => {
    // "it" could fuzzy-match "is" later, but should exact-match "it" early.
    const a = tokenize("get it actually");
    const b = tokenize("get it so by the way is actually");
    const r = alignWords(a, b);
    expect(r.exactMatches).toBe(3); // get, it, actually
    expect(r.fuzzyMatches).toBe(0);
  });

  it("matches words in non-Latin scripts and accented Latin", () => {
    // An ASCII-only normalizer emptied these words, so nothing could anchor.
    const a = tokenize("네, 맞아요. 캔버스 café നമസ്കാരം");
    const b = tokenize("네 맞아요 캔버스 Café നമസ്കാരം");
    const r = alignWords(a, b);
    expect(r.exactMatches).toBe(5);
  });

  it("does not fuzzy-match a punctuation-only ASR word to a one-letter word", () => {
    const r = alignWords(tokenize("I agree"), [{ norm: "" }, ...tokenize("agree")]);
    expect(r.fuzzyMatches).toBe(0);
  });
});

describe("alignSegments", () => {
  const seg = (
    start: number,
    end: number,
    text: string,
    speaker = "A",
  ): ParsedLlmSegment => ({
    speaker,
    startSec: start,
    endSec: end,
    text,
    tone: [],
    rawStart: "00:00",
    rawEnd: "00:00",
  });
  const word = (text: string, start: number, end: number): TimestampedWord => ({
    text,
    start,
    end,
  });

  it("transfers ASR word times onto LLM segments", () => {
    const llm = [seg(0, 2, "hello world", "A"), seg(2, 4, "goodbye now", "B")];
    const asr = [
      word("hello", 0.1, 0.5),
      word("world", 0.6, 1.0),
      word("goodbye", 2.1, 2.6),
      word("now", 2.7, 3.0),
    ];
    const out = alignSegments(llm, asr);
    expect(out).toHaveLength(2);
    expect(out[0]!.start).toBeCloseTo(0.1, 2);
    expect(out[0]!.end).toBeCloseTo(1.0, 2);
    expect(out[0]!.confidence).toBe(1);
    expect(out[1]!.start).toBeCloseTo(2.1, 2);
    expect(out[1]!.end).toBeCloseTo(3.0, 2);
  });

  it("interpolates timing for LLM words missing from ASR", () => {
    const llm = [seg(0, 3, "hello missing world", "A")];
    const asr = [word("hello", 0.1, 0.5), word("world", 2.0, 2.5)];
    const out = alignSegments(llm, asr);
    expect(out[0]!.start).toBeCloseTo(0.1, 2);
    expect(out[0]!.end).toBeCloseTo(2.5, 2);
    // "missing" interpolated between 0.5 and 2.0
    const missing = out[0]!.words[1]!;
    expect(missing.start).toBeGreaterThan(0.5);
    expect(missing.start).toBeLessThan(2.0);
  });

  it("preserves speaker labels from the LLM", () => {
    const llm = [seg(0, 1, "hi", "Alice"), seg(1, 2, "hello", "Bob")];
    const asr = [word("hi", 0, 0.5), word("hello", 1, 1.5)];
    const out = alignSegments(llm, asr);
    expect(out[0]!.speaker).toBe("Alice");
    expect(out[1]!.speaker).toBe("Bob");
  });

  it("handles empty LLM segments gracefully", () => {
    const out = alignSegments([], [word("hi", 0, 1)]);
    expect(out).toHaveLength(0);
  });

  it("keeps a segment's words inside its chunk's audio (no stretching over a hole)", () => {
    // Field report 1: with the following chunk's text missing, a chunk's last segments
    // matched scattered common words minutes later and stretched over the hole — hiding
    // it from gap-fill. Words heard in a chunk spanning 0–10s cannot be at 150s.
    const llm = [
      { ...seg(1, 4, "we are focusing on one thing"), chunkStart: 0, chunkEnd: 10 },
    ];
    const asr = [
      word("we", 1, 1.3),
      word("are", 1.3, 1.6),
      word("focusing", 1.6, 2.2),
      word("the", 150, 150.2),
      word("one", 150.2, 150.5),
      word("thing", 150.5, 151),
    ];
    const [out] = alignSegments(llm, asr);
    expect(out!.end).toBeLessThanOrEqual(12);
  });

  it("times a Korean segment from the Korean ASR words", () => {
    const llm = [seg(0, 3, "네, 맞아요. 그래서 시작했어요", "A")];
    const asr = [
      word("네", 0.2, 0.4),
      word("맞아요", 0.5, 1.0),
      word("그래서", 1.4, 1.9),
      word("시작했어요", 2.0, 2.8),
    ];
    const [out] = alignSegments(llm, asr);
    expect(out!.timingSource).toBe("aligned");
    expect(out!.start).toBeCloseTo(0.2, 2);
    expect(out!.end).toBeCloseTo(2.8, 2);
  });

  it("uses the LLM's own times when none of a segment's words was heard nearby", () => {
    // A Korean meeting the ASR heard as a handful of English words: the only anchors are
    // far away, so an interpolated time for this segment would be meaningless.
    const llm = [
      seg(0, 2, "intro words here", "A"),
      seg(100, 104, "네, 네, 맞아요", "B"),
      seg(300, 302, "closing words there", "A"),
    ];
    const asr = [
      word("intro", 0.1, 0.4),
      word("words", 0.5, 0.8),
      word("here", 0.9, 1.2),
      word("closing", 300.1, 300.4),
      word("words", 300.5, 300.8),
      word("there", 300.9, 301.2),
    ];
    const out = alignSegments(llm, asr);
    const korean = out.find((s) => s.speaker === "B")!;
    expect(korean.timingSource).toBe("coarse");
    expect(korean.start).toBe(100);
    expect(korean.end).toBe(104);
    // its words are spread over its own span, not stacked at one instant
    expect(korean.words[0]!.start).toBe(100);
    expect(korean.words.at(-1)!.end).toBeCloseTo(104, 5);
  });

  it("keeps an unheard backchannel at its interpolated position between neighbours", () => {
    const llm = [
      seg(10, 12, "we ship on friday", "A"),
      seg(12, 12, "Mm-hmm.", "B"),
      seg(12, 14, "and then we watch", "A"),
    ];
    const asr = [
      word("we", 10.1, 10.3),
      word("ship", 10.4, 10.7),
      word("on", 10.8, 10.9),
      word("friday", 11.0, 11.6),
      word("and", 12.4, 12.6),
      word("then", 12.7, 12.9),
      word("we", 13.0, 13.1),
      word("watch", 13.2, 13.6),
    ];
    const out = alignSegments(llm, asr);
    const mm = out.find((s) => s.speaker === "B")!;
    expect(mm.timingSource).not.toBe("coarse");
    expect(mm.start).toBeGreaterThan(11.6);
    expect(mm.start).toBeLessThan(12.4);
  });

  it("doesn't stretch a short line over a minute because one filler word matched early", () => {
    // Real case: "Um, and then I, I just draw..." spanned 18:14–19:20 because its "um"
    // matched an "um" a minute before the rest, hiding that minute from gap-fill.
    const llm = [
      {
        ...seg(1158, 1161, "Um, and then I just draw"),
        chunkStart: 1080,
        chunkEnd: 1680,
      },
    ];
    const asr = [
      word("um", 1094.6, 1094.9),
      word("and", 1157.5, 1157.7),
      word("then", 1157.8, 1158.0),
      word("i", 1158.1, 1158.2),
      word("just", 1158.3, 1158.6),
      word("draw", 1158.7, 1159.2),
    ];
    const [out] = alignSegments(llm, asr);
    expect(out!.start).toBeCloseTo(1157.5, 1);
    expect(out!.end).toBeCloseTo(1159.2, 1);
    // every word stays inside the segment it belongs to
    expect(Math.min(...out!.words.map((w) => w.start))).toBeGreaterThanOrEqual(
      out!.start,
    );
  });

  it("gives a line the ASR didn't confirm a speaking-length span, not the whole gap", () => {
    // Real case: a 3-word goodbye with no confirmed word was spread over the 22 s between
    // its confirmed neighbours and hid that stretch from gap-fill.
    const llm = [
      seg(0, 2, "we should wrap up now"),
      seg(2, 3, "good catching up"),
      seg(30, 31, "see you"),
    ];
    const asr = [
      word("we", 0, 0.3),
      word("should", 0.4, 0.7),
      word("wrap", 0.8, 1.1),
      word("up", 1.2, 1.5),
      word("now", 1.6, 2),
      word("see", 30, 30.4),
      word("you", 30.5, 31),
    ];
    const bye = alignSegments(llm, asr).find((s) => s.text === "good catching up")!;
    expect(bye.timingSource).toBe("interpolated");
    expect(bye.end - bye.start).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(bye.start).toBeGreaterThan(2);
  });
});

describe("partitionByOwnership", () => {
  const s = (start: number, end: number, trustedStart?: number): ParsedLlmSegment => ({
    speaker: "A",
    startSec: start,
    endSec: end,
    text: "x",
    tone: [],
    rawStart: "00:00",
    rawEnd: "00:00",
    trustedStart,
  });

  it("drops overlap-region segments whose center is before trustedStart", () => {
    // Chunk 1 owns [600, ...]; a segment at 570 (center) is in the overlap owned by chunk 0.
    const out = partitionByOwnership([s(560, 580, 600), s(610, 630, 600), s(0, 10, 0)]);
    // 560-580 center=570 < 600 -> dropped. 610-630 center=620 >= 600 -> kept. 0-10 -> kept.
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.startSec === 560)).toBeUndefined();
  });

  it("keeps segments with no trustedStart (e.g. gap-fill)", () => {
    const out = partitionByOwnership([s(5, 8)]);
    expect(out).toHaveLength(1);
  });
});

describe("toAsrClock before ownership", () => {
  // Chunk 0 is [0, 100] s; chunk 1 is [40, 160] s and owns everything from 100 s.
  const line = (chunk: 0 | 1, start: number, text: string): ParsedLlmSegment => ({
    speaker: "A",
    startSec: start,
    endSec: start + 2,
    text,
    tone: [],
    rawStart: "00:00",
    rawEnd: "00:00",
    chunkIndex: chunk,
    trustedStart: chunk === 0 ? 0 : 100,
    chunkStart: chunk === 0 ? 0 : 40,
    chunkEnd: chunk === 0 ? 100 : 160,
  });
  const said = (text: string, start: number) =>
    text
      .split(" ")
      .map((w, k) => ({ text: w, start: start + k * 0.3, end: start + k * 0.3 + 0.25 }));
  const asr = [
    ...said("alpha beta gamma delta epsilon", 80),
    ...said("small fun feature that I use all the time", 100.5),
    ...said("you can readjust the zoom of the window", 104),
  ];

  it("keeps a chunk's opening lines when its clock ran a minute early", () => {
    // The real case: chunk 1 skipped the overlap and stamped its first line at its own
    // 0:00 (40 s) although it was spoken at 100.5 s; chunk 0 stopped at the hand-over.
    const llm = [
      line(0, 80, "alpha beta gamma delta epsilon"),
      line(1, 41, "small fun feature that I use all the time"),
      line(1, 44, "you can readjust the zoom of the window"),
    ];
    expect(partitionByOwnership(llm).map((s) => s.text)).toHaveLength(1); // the loss
    const kept = partitionByOwnership(toAsrClock(llm, asr));
    expect(kept.map((s) => s.text)).toEqual([
      "alpha beta gamma delta epsilon",
      "small fun feature that I use all the time",
      "you can readjust the zoom of the window",
    ]);
    expect(kept[1]!.startSec).toBeCloseTo(100.5, 1);
  });

  it("still drops the next chunk's copy of the overlap", () => {
    const llm = [
      line(0, 80, "alpha beta gamma delta epsilon"),
      line(1, 80, "alpha beta gamma delta epsilon"),
      line(1, 100.5, "small fun feature that I use all the time"),
    ];
    const kept = partitionByOwnership(toAsrClock(llm, asr));
    expect(kept.filter((s) => s.text.startsWith("alpha"))).toHaveLength(1);
    expect(kept.find((s) => s.text.startsWith("alpha"))!.chunkIndex).toBe(0);
  });
});
