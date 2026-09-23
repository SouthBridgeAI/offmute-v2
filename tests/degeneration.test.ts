import { describe, it, expect } from "vitest";
import {
  DEGENERATE_COMPRESSION_RATIO,
  maxCompressionRatio,
  tailIsDegenerate,
  transcriptTextOf,
} from "../src/transcribe/degeneration.js";

// Ordinary meeting talk: varied words, no loop.
const NATURAL =
  "So the way I think about it, the first customers came from content, not outbound. " +
  "We wrote about the alignment problem, people found the repo, and a couple of them asked " +
  "whether we could run it on their own recordings. That's when we realised the timestamps " +
  "mattered more than the summary. Honestly the hardest part was diarization during " +
  "interruptions, because every ASR system we tried merged the two voices whenever someone " +
  "said yeah or right in the middle of a sentence. We tested it on a panel from Singapore, " +
  "then on a podcast, then on a noisy cafe interview, and each one broke something new. " +
  "Next month we want to try longer recordings, maybe three hours, and see where it drifts.";
// The loop observed in field report 1.
const LOOP = "Bye. See ya. Take care. You too. ".repeat(30);

describe("maxCompressionRatio", () => {
  it("flags a repetition loop", () => {
    expect(maxCompressionRatio(LOOP)).toBeGreaterThan(DEGENERATE_COMPRESSION_RATIO);
  });

  it("passes natural conversation", () => {
    expect(maxCompressionRatio(NATURAL)).toBeLessThan(DEGENERATE_COMPRESSION_RATIO);
  });

  it("catches a loop embedded in otherwise normal text", () => {
    expect(maxCompressionRatio(NATURAL + LOOP + NATURAL)).toBeGreaterThan(
      DEGENERATE_COMPRESSION_RATIO,
    );
  });
});

describe("tailIsDegenerate (streaming abort)", () => {
  it("fires once a loop has persisted at the end of the stream", () => {
    expect(tailIsDegenerate(NATURAL + LOOP)).toBe(true);
  });

  it("does not fire on a loop that has only just started", () => {
    // One window of repetition isn't enough evidence to kill a generation.
    expect(tailIsDegenerate(NATURAL + LOOP.slice(0, 300))).toBe(false);
  });

  it("does not fire on natural conversation", () => {
    expect(tailIsDegenerate(NATURAL + NATURAL)).toBe(false);
  });
});

describe("transcriptTextOf", () => {
  const head =
    '{"segments":[{"speaker":"Speaker A","start":"00:01","end":"00:03","text":"Hello there"},';

  it("includes the still-streaming final text value", () => {
    const partial = `${head}{"speaker":"Speaker B","start":"00:03","end":"00:05","text":"Hi, how are yo`;
    expect(transcriptTextOf(partial)).toBe("Hello there Hi, how are yo");
  });

  it("lets the stream guard see a runaway inside one unterminated text value", () => {
    // Field report 1, live: the model looped inside a single segment's text for 145k
    // characters; the string never closed, so a completed-values-only reader saw nothing.
    const partial = `${head}{"speaker":"Speaker B","start":"00:03","end":"00:05","text":"${"Thank you so much. ".repeat(80)}`;
    expect(tailIsDegenerate(transcriptTextOf(partial))).toBe(true);
  });
});
