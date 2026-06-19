import { describe, it, expect } from "vitest";
import { alignWords } from "../src/align/edit-distance.js";
import { tokenize } from "../src/align/normalize.js";
import { alignSegments } from "../src/align/aligner.js";
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
});

describe("alignSegments", () => {
  const seg = (start: number, end: number, text: string, speaker = "A"): ParsedLlmSegment => ({
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
    const llm = [
      seg(0, 2, "hello world", "A"),
      seg(2, 4, "goodbye now", "B"),
    ];
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
