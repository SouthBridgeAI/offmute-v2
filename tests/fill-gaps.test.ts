import { describe, it, expect } from "vitest";
import { fillAsrGaps } from "../src/align/fill-gaps.js";
import type { AlignedSegment } from "../src/align/aligner.js";
import type { TimestampedWord, TimestampedUtterance } from "../core/types.js";

const seg = (start: number, end: number, text: string, speaker = "A"): AlignedSegment => ({
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
const word = (text: string, start: number, end: number): TimestampedWord => ({ text, start, end });
const utt = (start: number, end: number, speaker: string): TimestampedUtterance => ({
  start,
  end,
  speaker,
  text: "",
});

describe("fillAsrGaps", () => {
  it("inserts an ASR fallback segment for a leading gap (dropped opener)", () => {
    // First LLM segment starts at 1.2; ASR has "GPU" at 0.16 (dropped by LLM).
    const segs = [seg(1.2, 3.0, "And I'm inspired")];
    const asr = [word("GPU", 0.16, 0.7), word("And", 1.2, 1.5), word("I'm", 1.5, 1.8), word("inspired", 1.8, 3.0)];
    const utts = [utt(0.16, 3.0, "speaker_A")];
    const out = fillAsrGaps(segs, asr, utts);
    expect(out.length).toBe(2);
    expect(out[0]!.start).toBeCloseTo(0.16, 2);
    expect(out[0]!.text).toBe("GPU");
    expect(out[0]!.timingSource).toBe("timestamped");
  });

  it("does NOT fill a gap whose words are already in the following segment's text", () => {
    // Gap [0,1.2] has "GPU", but the following segment's text already contains "GPU"
    // (timing imprecision, not a real drop) → no fill.
    const segs = [seg(1.2, 3.0, "GPU and I'm inspired")];
    const asr = [word("GPU", 0.16, 0.7), word("And", 1.2, 1.5)];
    const utts = [utt(0.16, 3.0, "speaker_A")];
    const out = fillAsrGaps(segs, asr, utts);
    expect(out.length).toBe(1);
  });

  it("skips narrow gaps below the threshold", () => {
    const segs = [seg(0, 1.0, "hello"), seg(1.3, 2.0, "world")]; // 0.3s gap
    const asr = [word("hello", 0, 1.0), word("world", 1.3, 2.0)];
    const out = fillAsrGaps(segs, asr, [utt(0, 2.0, "speaker_A")]);
    expect(out.length).toBe(2);
  });
});
