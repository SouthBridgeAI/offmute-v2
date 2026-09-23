import { describe, it, expect } from "vitest";
import { fillAsrGaps } from "../src/align/fill-gaps.js";
import type { AlignedSegment } from "../src/align/aligner.js";
import type { TimestampedWord, TimestampedUtterance } from "../src/core/types.js";

const seg = (
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
const word = (text: string, start: number, end: number): TimestampedWord => ({
  text,
  start,
  end,
});
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
    const asr = [
      word("GPU", 0.16, 0.7),
      word("And", 1.2, 1.5),
      word("I'm", 1.5, 1.8),
      word("inspired", 1.8, 3.0),
    ];
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

  it("recovers speech after the last segment (a truncated final chunk)", () => {
    // Field report 1: Gemini stopped transcribing the final chunk ~9 min early; with no
    // trailing range, everything ASR heard after the last LLM segment was dropped.
    const segs = [seg(0, 2, "hello there")];
    const asr = [
      word("hello", 0, 1),
      word("there", 1, 2),
      word("we", 60, 61),
      word("kept", 61, 62),
      word("talking", 62, 63),
    ];
    const out = fillAsrGaps(segs, asr, [
      utt(0, 2, "speaker_A"),
      utt(60, 63, "speaker_B"),
    ]);
    expect(out.length).toBe(2);
    expect(out[1]!.text).toBe("we kept talking");
    expect(out[1]!.speaker).toBe("speaker_B");
    expect(out[1]!.timingSource).toBe("timestamped");
  });

  it("splits a long recovered range at ASR speaker turns", () => {
    const segs = [seg(0, 2, "hi")];
    const asr = [
      word("hi", 0, 2),
      word("so", 10, 11),
      word("right", 13, 14),
      word("exactly", 15, 16),
    ];
    const utts = [
      utt(0, 2, "speaker_A"),
      utt(10, 12, "speaker_A"),
      utt(13, 14, "speaker_B"),
      utt(15, 16, "speaker_A"),
    ];
    const recovered = fillAsrGaps(segs, asr, utts).filter(
      (s) => s.timingSource === "timestamped",
    );
    expect(recovered.map((s) => [s.speaker, s.text])).toEqual([
      ["speaker_A", "so"],
      ["speaker_B", "right"],
      ["speaker_A", "exactly"],
    ]);
  });

  it("does not open a phantom gap inside a long segment that covers it", () => {
    // A long segment (0–100) with shorter ones nested inside: time 20–30 is covered.
    const segs = [seg(0, 100, "long turn"), seg(10, 20, "nested"), seg(30, 40, "later")];
    const asr = [word("inside", 25, 26)];
    const out = fillAsrGaps(segs, asr, [utt(0, 100, "speaker_A")]);
    expect(out.length).toBe(3);
  });
});
