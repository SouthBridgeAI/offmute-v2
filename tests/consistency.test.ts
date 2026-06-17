import { describe, it, expect } from "vitest";
import { assignGlobalSpeakers } from "../src/diarize/consistency.js";
import type { AlignedSegment } from "../src/align/aligner.js";
import type { TimestampedUtterance } from "../src/core/types.js";

const a = (start: number, end: number, speaker: string, text = "x"): AlignedSegment => ({
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
const utt = (start: number, end: number, speaker: string): TimestampedUtterance => ({
  start,
  end,
  speaker,
  text: "",
});

describe("assignGlobalSpeakers", () => {
  it("orders global ids by talk DURATION, not segment count", () => {
    // Presenter: 1 long segment (100s). Audience: 5 short segments (10s each = 50s total).
    // By count audience would win; by duration presenter must be Speaker A.
    const segs = [
      a(0, 100, "Presenter", "long monologue"),
      a(100, 110, "Aud1", "q"),
      a(120, 130, "Aud1", "q"),
      a(140, 150, "Aud1", "q"),
      a(160, 170, "Aud1", "q"),
      a(180, 190, "Aud1", "q"),
    ];
    const utts = [utt(0, 100, "speaker_A"), utt(100, 190, "speaker_B")];
    const r = assignGlobalSpeakers(segs, utts);
    const presenter = r.segments.find((s) => s.speakerName === "Presenter");
    expect(presenter?.speaker).toBe("Speaker A");
  });

  it("merges ASR speakers that share a specific LLM label", () => {
    // Presenter split across speaker_A + speaker_B by ASR; LLM labels both "Presenter".
    const segs = [
      a(0, 50, "Presenter", "hello"),
      a(50, 100, "Presenter", "world"),
      a(100, 110, "Audience", "q"),
    ];
    const utts = [utt(0, 50, "speaker_A"), utt(50, 100, "speaker_B"), utt(100, 110, "speaker_C")];
    const r = assignGlobalSpeakers(segs, utts);
    // Both presenter segments should share ONE global id.
    const ids = new Set(r.segments.slice(0, 2).map((s) => s.speaker));
    expect(ids.size).toBe(1);
    expect(r.speakers.length).toBe(2); // presenter (merged) + audience
  });

  it("keeps generic-label ASR speakers separate", () => {
    const segs = [a(0, 10, "Speaker A", "x"), a(10, 20, "Speaker A", "y")];
    const utts = [utt(0, 10, "speaker_A"), utt(10, 20, "speaker_B")];
    const r = assignGlobalSpeakers(segs, utts);
    expect(r.speakers.length).toBe(2);
  });

  it("falls back to the NEAREST utterance (not the first) for zero-overlap segments", () => {
    // seg1 overlaps utt1 (speaker_A); seg2 lands in a gap, nearest utt2 (speaker_B).
    // With the nearest-fallback, seg2 → speaker_B → two distinct speakers. The old
    // behavior (utterances[0]) would put both on speaker_A → one speaker.
    const segs = [a(0, 10, "Speaker A", "x"), a(45, 46, "Speaker A", "y")];
    const utts = [utt(0, 10, "speaker_A"), utt(50, 60, "speaker_B")];
    const r = assignGlobalSpeakers(segs, utts);
    expect(r.speakers.length).toBe(2);
    // The two segments should map to DIFFERENT global speakers.
    const ids = new Set(r.segments.map((s) => s.speaker));
    expect(ids.size).toBe(2);
  });
});
