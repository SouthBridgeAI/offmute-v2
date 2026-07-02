import { describe, it, expect } from "vitest";
import { splitMixedVoiceSegments } from "../src/diarize/split-mixed.js";
import { countTurnTransitions } from "../src/diarize/consistency.js";
import type { AlignedSegment, AlignedWord } from "../src/align/aligner.js";
import type { TimestampedUtterance } from "../src/core/types.js";

function words(from: number, count: number, dur = 0.4): AlignedWord[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `w${i}`,
    start: from + i * dur,
    end: from + (i + 1) * dur,
    matched: true,
  }));
}

function seg(ws: AlignedWord[], speaker = "Hrishi"): AlignedSegment {
  return {
    speaker,
    start: ws[0]!.start,
    end: ws[ws.length - 1]!.end,
    text: ws.map((w) => w.text).join(" "),
    tone: [],
    confidence: 1,
    timingSource: "aligned",
    words: ws,
    sourceIndex: 0,
  };
}

function utt(speaker: string, start: number, end: number): TimestampedUtterance {
  return { speaker, start, end, text: "x" };
}

describe("splitMixedVoiceSegments", () => {
  it("splits a segment whose words span two voice clusters", () => {
    // 20 words: first 10 in cluster A's utterance, last 10 in cluster B's.
    const ws = words(0, 20, 0.5); // 0..10s
    const utts = [utt("speaker_A", 0, 5), utt("speaker_B", 5, 10)];
    const out = splitMixedVoiceSegments([seg(ws)], utts);
    expect(out).toHaveLength(2);
    expect(out[0]!.speaker).toBe("Hrishi"); // dominant (tie → first max) keeps label
    expect(out[1]!.speaker).toBe("Voice speaker_B");
    expect(out[0]!.text.split(" ")).toHaveLength(10);
  });

  it("does not split on single-word flicker (hysteresis)", () => {
    const ws = words(0, 20, 0.5);
    // One word (2.0-2.5s) belongs to B; everything else A.
    const utts = [
      utt("speaker_A", 0, 2.0),
      utt("speaker_B", 2.0, 2.5),
      utt("speaker_A", 2.5, 10),
    ];
    const out = splitMixedVoiceSegments([seg(ws)], utts);
    expect(out).toHaveLength(1);
    expect(out[0]!.speaker).toBe("Hrishi");
  });

  it("passes short segments through untouched", () => {
    const ws = words(0, 4);
    const utts = [utt("speaker_A", 0, 1), utt("speaker_B", 1, 2)];
    const out = splitMixedVoiceSegments([seg(ws)], utts);
    expect(out).toHaveLength(1);
  });

  it("no-ops without diarization data", () => {
    const ws = words(0, 20);
    expect(splitMixedVoiceSegments([seg(ws)], [])).toHaveLength(1);
  });
});

describe("countTurnTransitions", () => {
  it("sees conversation partners alternate and over-splits not", () => {
    const conversation = [
      utt("speaker_A", 0, 5),
      utt("speaker_B", 5, 8),
      utt("speaker_A", 8, 12),
      utt("speaker_B", 12, 14),
      utt("speaker_A", 14, 20),
      utt("speaker_B", 20, 22),
    ];
    expect(countTurnTransitions(conversation, "speaker_A", "speaker_B")).toBe(5);

    // Over-split: A does the first half, B the second (diarizer re-clustered midway).
    const oversplit = [
      utt("speaker_A", 0, 5),
      utt("speaker_A", 5, 10),
      utt("speaker_A", 10, 15),
      utt("speaker_B", 15, 20),
      utt("speaker_B", 20, 25),
    ];
    expect(countTurnTransitions(oversplit, "speaker_A", "speaker_B")).toBe(1);
  });

  it("ignores third-party utterances in between", () => {
    const utts = [
      utt("speaker_A", 0, 5),
      utt("speaker_C", 5, 6),
      utt("speaker_A", 6, 10),
      utt("speaker_B", 10, 15),
    ];
    expect(countTurnTransitions(utts, "speaker_A", "speaker_B")).toBe(1);
  });
});
