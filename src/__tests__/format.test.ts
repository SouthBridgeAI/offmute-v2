import { test, expect, describe } from "bun:test";
import { toSRT, toMarkdown, toText } from "../core/format.js";
import { buildTranscript, alignTurnsToSegments } from "../core/assemble.js";
import type { Transcript, TranscriptMetadata } from "../types.js";

const META: TranscriptMetadata = {
  source: "x",
  durationSeconds: 10,
  processedAt: "2026-01-01",
  asrProvider: "assemblyai",
  llmModel: "gemini",
};

const transcript: Transcript = {
  speakers: [
    { id: "hrishi", label: "Hrishi", named: true, description: "presenter" },
    { id: "audience", label: "Audience", named: false },
  ],
  segments: [
    { id: 1, start: 0, end: 2, speakerId: "hrishi", text: "Hello there.", tone: "warm", timingSource: "asr" },
    { id: 2, start: 2, end: 3, speakerId: "hrishi", text: "How are you?", timingSource: "asr" },
    { id: 3, start: 4, end: 6, speakerId: "audience", text: "Good.", timingSource: "asr" },
  ],
  metadata: META,
};

describe("toSRT", () => {
  test("numbers cues sequentially, includes speaker, formats time", () => {
    const srt = toSRT(transcript);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:02,000\nHrishi: Hello there.");
    expect(srt).toContain("3\n00:00:04,000 --> 00:00:06,000\nAudience: Good.");
  });
  test("tone excluded by default, included when asked", () => {
    expect(toSRT(transcript)).not.toContain("(warm)");
    expect(toSRT(transcript, { includeTone: true })).toContain("(warm) Hello there.");
  });
});

describe("toMarkdown", () => {
  test("merges consecutive same-speaker segments and lists speakers", () => {
    const md = toMarkdown(transcript);
    expect(md).toContain("- **Hrishi**");
    expect(md).toContain("- **Audience** *(unidentified)*");
    // the two Hrishi segments merge into one paragraph
    expect(md).toContain("Hello there. How are you?");
  });
});

describe("toText", () => {
  test("groups by speaker with timestamps", () => {
    const txt = toText(transcript);
    expect(txt).toContain("[0:00] Hrishi: Hello there. How are you?");
    expect(txt).toContain("[0:04] Audience: Good.");
  });
});

describe("assemble round-trip", () => {
  test("alignTurnsToSegments + buildTranscript with no ASR uses approx times", () => {
    const turns = [
      { speaker: "A", text: "one two three", approxStart: 0 },
      { speaker: "B", text: "four five", approxStart: 5 },
    ];
    const { segments } = alignTurnsToSegments(turns, undefined, 10, true);
    expect(segments.length).toBe(2);
    expect(segments[0]!.start).toBe(0);
    expect(segments[1]!.start).toBe(5);
    const t = buildTranscript(segments, META);
    expect(t.speakers.length).toBe(2);
    expect(t.segments[0]!.timingSource).toBe("llm"); // matchRatio 0 → llm timing
  });
});
