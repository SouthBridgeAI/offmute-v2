import { test, expect, describe } from "bun:test";
import { secondsToSrtTime, srtTimeToSeconds, relTimeToSeconds } from "../core/time.js";
import { parseSrt, formatSrt, splitSpeakerPrefix } from "../core/srt.js";
import {
  alignTokens,
  alignLlmToAsr,
  fillTokenTimes,
  buildSegmentsFromTokens,
  normalizeToken,
} from "../core/align.js";
import { parseDiarizedText } from "../core/parse-diarized.js";
import { evaluateWords, segmentsToWords } from "../core/eval.js";
import type { TimedWord } from "../types.js";

describe("time", () => {
  test("srt round-trip", () => {
    for (const s of [0, 0.16, 87.44, 781.46, 3661.999]) {
      expect(srtTimeToSeconds(secondsToSrtTime(s))).toBeCloseTo(s, 2);
    }
  });
  test("ms rounding carry", () => {
    expect(secondsToSrtTime(59.9999)).toBe("00:01:00,000");
    expect(secondsToSrtTime(3599.9999)).toBe("01:00:00,000");
  });
  test("srt parse accepts comma and dot", () => {
    expect(srtTimeToSeconds("00:01:27,440")).toBeCloseTo(87.44, 3);
    expect(srtTimeToSeconds("00:01:27.440")).toBeCloseTo(87.44, 3);
  });
  test("relative mm:ss", () => {
    expect(relTimeToSeconds("1:27")).toBe(87);
    expect(relTimeToSeconds("1:02:03")).toBe(3723);
    expect(relTimeToSeconds("bad")).toBeNull();
  });
});

describe("srt", () => {
  test("parse with speaker prefixes", () => {
    const srt = "1\n00:00:00,160 --> 00:00:05,440\nHrishi: GPU and inspired.\n\n2\n00:00:05,440 --> 00:00:07,600\nAudience: Help me.";
    const cues = parseSrt(srt);
    expect(cues.length).toBe(2);
    expect(cues[0]!.speaker).toBe("Hrishi");
    expect(cues[0]!.body).toBe("GPU and inspired.");
    expect(cues[0]!.start).toBeCloseTo(0.16, 2);
  });
  test("splitSpeakerPrefix rejects sentences", () => {
    expect(splitSpeakerPrefix("This is a long sentence: with a colon.").speaker).toBeUndefined();
    expect(splitSpeakerPrefix("Hrishi: hello").speaker).toBe("Hrishi");
  });
  test("format round-trips speaker", () => {
    const out = formatSrt([{ start: 1, end: 2, speaker: "A", text: "hi there" }]);
    expect(out).toContain("A: hi there");
    expect(out).toContain("00:00:01,000 --> 00:00:02,000");
  });
});

describe("align", () => {
  test("identical sequences fully match", () => {
    const a = ["the", "quick", "brown", "fox"];
    const pairs = alignTokens(a, a);
    expect(pairs.filter((p) => p.match).length).toBe(4);
  });
  test("handles substitution + insertion + deletion", () => {
    const ref = ["the", "quick", "brown", "fox"];
    const hyp = ["the", "slow", "brown", "red", "fox"]; // sub quick->slow, insert red
    const pairs = alignTokens(ref, hyp);
    const matches = pairs.filter((p) => p.match).length;
    expect(matches).toBe(3); // the, brown, fox
  });

  const asrWords: TimedWord[] = [
    { text: "GPU", start: 0.16, end: 0.72, speaker: "A" },
    { text: "and", start: 1.2, end: 1.6, speaker: "A" },
    { text: "inspired", start: 1.9, end: 2.4, speaker: "A" },
    { text: "help", start: 5.4, end: 5.7, speaker: "B" },
    { text: "me", start: 5.7, end: 6.0, speaker: "B" },
  ];

  test("alignLlmToAsr assigns word times and asr speaker", () => {
    const turns = [{ text: "GPU and inspired." }, { text: "Help me." }];
    const tokens = alignLlmToAsr(turns, asrWords);
    const gpu = tokens.find((t) => t.norm === "gpu")!;
    expect(gpu.matched).toBe(true);
    expect(gpu.start).toBeCloseTo(0.16, 2);
    expect(gpu.asrSpeaker).toBe("A");
    const help = tokens.find((t) => t.norm === "help")!;
    expect(help.asrSpeaker).toBe("B");
    expect(help.turnIndex).toBe(1);
  });

  test("buildSegmentsFromTokens turn-level gives correct boundaries", () => {
    const turns = [{ text: "GPU and inspired." }, { text: "Help me." }];
    const tokens = fillTokenTimes(alignLlmToAsr(turns, asrWords), 6);
    const segs = buildSegmentsFromTokens(turns, tokens, { subSegment: false });
    expect(segs.length).toBe(2);
    expect(segs[0]!.start).toBeCloseTo(0.16, 2);
    expect(segs[0]!.end).toBeCloseTo(2.4, 2);
    expect(segs[1]!.start).toBeCloseTo(5.4, 2);
  });

  test("interpolates unmatched tokens monotonically", () => {
    // LLM adds a word the ASR didn't catch
    const turns = [{ text: "GPU absolutely and inspired" }];
    const tokens = fillTokenTimes(alignLlmToAsr(turns, asrWords), 6);
    const times = tokens.map((t) => t.start!);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
  });
});

describe("parse-diarized", () => {
  test("parses [mm:ss] Speaker: (tone) text", () => {
    const raw = "[00:14] Rishi: (laughing) Actually there's more.\n[01:27] Audience: Right.";
    const lines = parseDiarizedText(raw);
    expect(lines.length).toBe(2);
    expect(lines[0]!.speaker).toBe("Rishi");
    expect(lines[0]!.tone).toBe("laughing");
    expect(lines[0]!.approxStart).toBe(14);
    expect(lines[0]!.text).toBe("Actually there's more.");
  });
  test("continuation lines append", () => {
    const raw = "[00:00] A: first part\nsecond part continues";
    const lines = parseDiarizedText(raw);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toBe("first part second part continues");
  });
});

describe("eval", () => {
  test("WER on simple case", () => {
    const ref = segmentsToWords([{ start: 0, end: 4, speaker: "A", text: "the quick brown fox" }]);
    const hyp = segmentsToWords([{ start: 0, end: 4, speaker: "X", text: "the slow brown fox" }]);
    const r = evaluateWords(ref, hyp);
    expect(r.wer).toBeCloseTo(0.25, 5); // 1 sub / 4
    expect(r.speakerAccuracy).toBe(1); // single speaker maps perfectly
  });
  test("speaker mapping picks best assignment", () => {
    const ref = segmentsToWords([
      { start: 0, end: 2, speaker: "Hrishi", text: "alpha beta gamma" },
      { start: 2, end: 4, speaker: "Audience", text: "delta epsilon zeta" },
    ]);
    const hyp = segmentsToWords([
      { start: 0, end: 2, speaker: "Speaker 1", text: "alpha beta gamma" },
      { start: 2, end: 4, speaker: "Speaker 2", text: "delta epsilon zeta" },
    ]);
    const r = evaluateWords(ref, hyp);
    expect(r.speakerMapping["Speaker 1"]).toBe("Hrishi");
    expect(r.speakerMapping["Speaker 2"]).toBe("Audience");
    expect(r.speakerAccuracy).toBe(1);
  });
});

describe("normalizeToken", () => {
  test("strips punctuation and case", () => {
    expect(normalizeToken("Hello,")).toBe("hello");
    expect(normalizeToken("WebGPU!")).toBe("webgpu");
    expect(normalizeToken("—")).toBe("");
  });
});
