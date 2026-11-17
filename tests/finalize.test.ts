import { describe, it, expect } from "vitest";
import {
  fixOverlaps,
  clampAndFix,
  dedupSegments,
  finalizeSegments,
} from "../src/finalize/finalize.js";
import type { Segment } from "../src/core/types.js";
import type { AlignedSegment } from "../src/align/aligner.js";

const seg = (start: number, end: number, text = "x", speaker = "A"): Segment => ({
  id: 0,
  start,
  end,
  speaker,
  text,
});

describe("fixOverlaps", () => {
  it("shortens the earlier block to remove overlap", () => {
    const out = fixOverlaps([seg(0, 2), seg(1.5, 3)]);
    expect(out[0]!.end).toBeLessThanOrEqual(out[1]!.start);
    expect(out[0]!.end).toBeCloseTo(1.5 - 0.05, 2);
  });

  it("leaves non-overlapping blocks untouched", () => {
    const out = fixOverlaps([seg(0, 1), seg(2, 3)]);
    expect(out[0]!.end).toBe(1);
    expect(out[1]!.start).toBe(2);
  });
});

describe("clampAndFix", () => {
  it("extends too-short blocks to MIN_DUR", () => {
    const out = clampAndFix([seg(0, 0.1)]);
    expect(out[0]!.end - out[0]!.start).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps a long block's real end (cue length is the SRT formatter's job)", () => {
    const out = clampAndFix([seg(0, 20)]);
    expect(out[0]!.end).toBe(20);
  });
});

describe("dedupSegments", () => {
  const a = (start: number, text: string, conf = 0.9): AlignedSegment => ({
    speaker: "speaker_A",
    start,
    end: start + 2,
    text,
    tone: [],
    confidence: conf,
    timingSource: "aligned",
    words: [],
    sourceIndex: 0,
  });

  it("drops near-duplicate overlap-region segments", () => {
    const dup = dedupSegments([
      a(0, "hello world this is a test"),
      a(1.5, "hello world this is a test"), // same text, overlapping time
    ]);
    expect(dup.length).toBe(1);
  });

  it("keeps distinct segments", () => {
    const kept = dedupSegments([
      a(0, "hello world"),
      a(5, "completely different content here"),
    ]);
    expect(kept.length).toBe(2);
  });
});

describe("finalizeSegments", () => {
  const a = (
    start: number,
    end: number,
    text: string,
    speaker = "A",
  ): AlignedSegment => ({
    speaker,
    start,
    end,
    text,
    tone: [],
    confidence: 0.9,
    timingSource: "aligned",
    words: [],
    sourceIndex: 0,
  });

  it("produces renumbered, non-overlapping segments", () => {
    const out = finalizeSegments([
      a(0, 2, "first segment"),
      a(1.8, 3, "second segment"), // overlap
    ]);
    expect(out.length).toBe(2);
    expect(out[0]!.id).toBe(1);
    expect(out[1]!.id).toBe(2);
    expect(out[0]!.end).toBeLessThanOrEqual(out[1]!.start);
  });

  it("keeps an interjection the aligner could only place at a point in time", () => {
    const out = finalizeSegments([
      a(10, 14, "so the plan is to ship on friday"),
      a(14, 14, "Yeah.", "B"), // zero width: none of its words was found in the ASR
      a(14.2, 18, "and then we watch the numbers"),
    ]);
    expect(out.map((s) => s.text)).toEqual([
      "so the plan is to ship on friday",
      "Yeah.",
      "and then we watch the numbers",
    ]);
    expect(out[1]!.speaker).toBe("B");
  });

  it("drops segments with no text", () => {
    const out = finalizeSegments([a(0, 2, "hello there"), a(2, 3, "   ")]);
    expect(out.map((s) => s.text)).toEqual(["hello there"]);
  });
});
