import { describe, it, expect } from "vitest";
import { chunkCoverage, MIN_COVERAGE_RATIO } from "../src/transcribe/coverage.js";
import type { TimestampedWord } from "../src/core/types.js";

/** `n` ASR words spread evenly over [start, end). */
const asrWords = (n: number, start: number, end: number): TimestampedWord[] =>
  Array.from({ length: n }, (_, i) => {
    const t = start + ((end - start) * i) / n;
    return { text: `word${i}`, start: t, end: t + 0.3 };
  });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("chunkCoverage", () => {
  it("flags a chunk whose transcript stopped after a minute of ten", () => {
    // A final chunk that came back covering 26 s while the ASR heard the whole conversation.
    const cov = chunkCoverage([{ text: words(60) }], asrWords(1600, 0, 600), 0, 600);
    expect(cov.judged).toBe(true);
    expect(cov.low).toBe(true);
    expect(cov.ratio).toBeLessThan(MIN_COVERAGE_RATIO);
  });

  it("doesn't count a bracketed placeholder as speech", () => {
    // One "[silence]" segment over 8.5 minutes of talk satisfied every span check.
    const segs = [{ text: words(280) }, { text: "[silence]" }];
    const cov = chunkCoverage(segs, asrWords(1600, 0, 600), 0, 600);
    expect(cov.llmWords).toBe(280);
    expect(cov.low).toBe(true);
  });

  it("passes a chunk whose transcript matches the ASR's word count", () => {
    const cov = chunkCoverage([{ text: words(1500) }], asrWords(1600, 0, 600), 0, 600);
    expect(cov.low).toBe(false);
  });

  it("doesn't judge a quiet chunk", () => {
    // A break in a call: few words on either side is not lost speech.
    const cov = chunkCoverage([{ text: words(5) }], asrWords(40, 0, 600), 0, 600);
    expect(cov.judged).toBe(false);
    expect(cov.low).toBe(false);
  });

  it("counts only ASR words inside the chunk's window", () => {
    const asr = [...asrWords(1000, 0, 600), ...asrWords(1000, 600, 1200)];
    const cov = chunkCoverage([{ text: words(950) }], asr, 600, 1200);
    expect(cov.asrWords).toBe(1000);
    expect(cov.low).toBe(false);
  });
});
