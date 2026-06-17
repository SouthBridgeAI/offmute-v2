// Regression tests for review findings.
import { test, expect, describe } from "bun:test";
import { secondsToSrtTime } from "../core/time.js";
import { splitSpeakerPrefix, parseSrt } from "../core/srt.js";
import { calculateChunks, mergeChunkSegments, type MergeableSegment } from "../core/chunk.js";

describe("secondsToSrtTime hardening (#8)", () => {
  test("non-finite input yields zero time, not NaN", () => {
    expect(secondsToSrtTime(NaN)).toBe("00:00:00,000");
    expect(secondsToSrtTime(Infinity)).toBe("00:00:00,000");
    expect(secondsToSrtTime(-5)).toBe("00:00:00,000");
  });
});

describe("splitSpeakerPrefix timecode (#7)", () => {
  test("leading timecode is not a speaker", () => {
    expect(splitSpeakerPrefix("12:34 and then he left").speaker).toBeUndefined();
    expect(splitSpeakerPrefix("5 things happened").speaker).toBeUndefined();
    expect(splitSpeakerPrefix("Hrishi: hello").speaker).toBe("Hrishi");
  });
});

describe("parseSrt noise tolerance (#9)", () => {
  test("finds timing line even with noise before it", () => {
    const srt = "garbage\nanother\n00:00:01,000 --> 00:00:02,000\nText here";
    const cues = parseSrt(srt);
    expect(cues.length).toBe(1);
    expect(cues[0]!.body).toBe("Text here");
  });
});

describe("calculateChunks config clamp (#3)", () => {
  test("overlap >= chunk does not explode chunk count", () => {
    const chunks = calculateChunks(3600, 900, 900); // overlap == chunk
    expect(chunks.length).toBeLessThan(20); // not thousands
  });
  test("negative overlap leaves no gaps (contiguous coverage)", () => {
    const chunks = calculateChunks(3600, 900, -300);
    for (let i = 1; i < chunks.length; i++) {
      // each chunk starts at or before the previous chunk's end (no gap)
      expect(chunks[i]!.startSeconds).toBeLessThanOrEqual(chunks[i - 1]!.endSeconds);
    }
    expect(chunks[chunks.length - 1]!.endSeconds).toBe(3600);
  });
});

describe("mergeChunkSegments (#1/#2)", () => {
  const mk = (start: number, end: number, speaker: string, text: string, mr: number, chunk: number): MergeableSegment => ({
    start, end, speakerLabel: speaker, text, matchRatio: mr, chunkIndex: chunk,
  });
  const bounds = [
    { index: 0, startSeconds: 0, endSeconds: 110 },
    { index: 1, startSeconds: 100, endSeconds: 200 },
  ];

  test("same-chunk similar cues are NOT merged (distinct pieces of a turn)", () => {
    const segs = [mk(0, 5, "A", "hello world how are you", 0.9, 0), mk(5, 10, "A", "hello world how are you", 0.9, 0)];
    expect(mergeChunkSegments(segs, bounds).length).toBe(2);
  });

  test("cross-chunk overlap duplicate IS merged, keeps higher matchRatio", () => {
    const segs = [mk(100, 109, "Rishi", "yeah I think so too", 0.5, 0), mk(101, 110, "Speaker 1", "yeah I think so too", 0.9, 1)];
    const merged = mergeChunkSegments(segs, bounds);
    expect(merged.length).toBe(1);
    expect(merged[0]!.matchRatio).toBe(0.9); // kept the better one despite different label
  });
});
