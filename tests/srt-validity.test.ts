import { describe, it, expect } from "vitest";
import { formatSrt } from "../src/finalize/format.js";
import { finalizeSegments } from "../src/finalize/finalize.js";
import { parseSrt } from "../src/utils/srt.js";
import type { Segment, TranscriptResult } from "../src/core/types.js";
import type { AlignedSegment } from "../src/align/aligner.js";

const result = (segments: Segment[]): TranscriptResult => ({
  segments,
  speakers: [],
  metadata: { sourceFile: "x", duration: 100, processedAt: "", models: {}, passes: [] },
});

const a = (start: number, end: number, text: string, speaker = "A"): AlignedSegment => ({
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

describe("SRT validity (property)", () => {
  it("produces parseable SRT with no blank lines inside a cue, even with newlines in text", () => {
    // LLM text with embedded newlines/blank lines that would otherwise split a cue.
    const segs = finalizeSegments([
      a(0, 2, "hello\n\nworld\nthis is a test"),
      a(2, 4, "second segment with\rmixed\r\nline endings"),
      a(4, 6, "third"),
    ]);
    const srt = formatSrt(result(segs));

    // Every cue is exactly: index / timing / text / blank. No blank line inside a cue.
    const blocks = srt.split(/\n\n+/).filter((b) => b.trim().length > 0);
    for (const b of blocks) {
      const lines = b.trimEnd().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3); // index, timing, text (+ maybe more text lines)
      expect(/^\d+$/.test(lines[0]!.trim())).toBe(true); // numeric index
      expect(lines[1]!.includes("-->")).toBe(true); // timing line
      // No blank lines within the cue.
      expect(lines.some((l) => l.trim() === "")).toBe(false);
    }

    // And the round-trip parse recovers the same number of cues.
    const parsed = parseSrt(srt);
    expect(parsed.length).toBe(segs.length);
  });

  it("each cue's text contains no newlines after formatting", () => {
    const segs = finalizeSegments([a(0, 1, "line one\nline two")]);
    const srt = formatSrt(result(segs));
    const blocks = srt.split(/\n\n+/).filter((b) => b.trim().length > 0);
    const cueText = blocks[0]!.split("\n").slice(2).join(" ");
    expect(cueText.includes("\n")).toBe(false);
  });
});
