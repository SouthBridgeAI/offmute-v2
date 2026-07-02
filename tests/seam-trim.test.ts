import { describe, it, expect } from "vitest";
import { trimSeamOverlaps } from "../src/finalize/finalize.js";
import type { AlignedSegment, AlignedWord } from "../src/align/aligner.js";

function mkWords(text: string, from: number, dur = 0.4): AlignedWord[] {
  return text.split(" ").map((w, i) => ({
    text: w,
    start: from + i * dur,
    end: from + (i + 1) * dur,
    matched: true,
  }));
}

function mkSeg(text: string, from: number, speaker = "Speaker A"): AlignedSegment {
  const words = mkWords(text, from);
  return {
    speaker,
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text,
    tone: [],
    confidence: 1,
    timingSource: "aligned",
    words,
    sourceIndex: 0,
  };
}

describe("trimSeamOverlaps", () => {
  const shared = "so I think there is an opportunity for everyone to make that transition";

  it("trims the earlier copy's tail when the later segment re-covers it", () => {
    // Chunk N's copy ends with the shared span (truncated); chunk N+1 re-covers it in full.
    const a = mkSeg(`before the seam some early content and then ${shared}`, 0);
    const b = mkSeg(`${shared} and then genuinely new content follows after the seam`, 30);
    const out = trimSeamOverlaps([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe("before the seam some early content and then");
    expect(out[1]!.text).toBe(b.text); // later, fuller copy kept whole
  });

  it("drops the earlier segment when it is entirely re-covered", () => {
    const a = mkSeg(shared, 0);
    const b = mkSeg(`${shared} plus a continuation with fresh words`, 30);
    const out = trimSeamOverlaps([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(b.text);
  });

  it("tolerates small transcription differences inside the duplicate", () => {
    const a = mkSeg(`lead-in words here ${shared}`, 0);
    const nearDup = shared.replace("everyone", "everybody").replace("transition", "transitions");
    const b = mkSeg(`${nearDup} continuing with brand new material now`, 30);
    const out = trimSeamOverlaps([a, b]);
    expect(out[0]!.text).toBe("lead-in words here");
  });

  it("leaves different speakers alone", () => {
    const a = mkSeg(`something ending with ${shared}`, 0, "Speaker A");
    const b = mkSeg(`${shared} echoed by another person`, 30, "Speaker B");
    const out = trimSeamOverlaps([a, b]);
    expect(out[0]!.text).toBe(a.text);
    expect(out[1]!.text).toBe(b.text);
  });

  it("leaves non-duplicating adjacent segments alone", () => {
    const a = mkSeg("the first turn talks about apples and oranges at length", 0);
    const b = mkSeg("the second turn is entirely about something else completely", 30);
    const out = trimSeamOverlaps([a, b]);
    expect(out[0]!.text).toBe(a.text);
    expect(out[1]!.text).toBe(b.text);
  });
});
