import { test, expect, describe } from "bun:test";
import { toSRT, toMarkdown, toText } from "../core/format.js";
import { buildTranscript, alignTurnsToSegments } from "../core/assemble.js";
import { parseSrt } from "../core/srt.js";
import { srtTimeToSeconds } from "../core/time.js";
import type { Transcript, TranscriptMetadata, TranscriptSegment } from "../types.js";

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

// --- behavioral / property tests: formatters must ALWAYS produce valid output ---
const TIMING_LINE = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;

function mkTranscript(segs: Array<Partial<TranscriptSegment> & { text: string; start: number; end: number }>): Transcript {
  return {
    speakers: [{ id: "s", label: "Spk", named: false }],
    segments: segs.map((s, i) => ({ id: i + 1, speakerId: "s", timingSource: "asr", ...s })),
    metadata: META,
  };
}

// adversarial cases: empty text, blank lines, unicode, colon, end<start, zero-dur, huge
const NASTY = mkTranscript([
  { start: 0, end: 1, text: "normal line" },
  { start: 1, end: 2, text: "" }, // empty
  { start: 2, end: 3, text: "line one\n\nline three with a blank line between" }, // blank line would break SRT
  { start: 3, end: 4, text: "emoji 😀 and únïcode and a : colon" },
  { start: 5, end: 4.5, text: "end before start (should clamp)" }, // end < start
  { start: 6, end: 6, text: "zero duration" },
  { start: 7, end: 8, text: "  surrounded by whitespace  \n" },
]);

describe("toSRT is always valid", () => {
  test("every cue has a valid timing line and parses back to the same count", () => {
    const srt = toSRT(NASTY);
    const cues = parseSrt(srt);
    expect(cues.length).toBe(NASTY.segments.length); // no cue lost to a stray blank line
    // each block's timing line matches the strict SRT format
    const blocks = srt.trim().split(/\n\s*\n/);
    for (const b of blocks) {
      const lines = b.split("\n");
      expect(Number.isInteger(Number(lines[0]))).toBe(true); // sequential index
      expect(TIMING_LINE.test(lines[1]!)).toBe(true);
      expect(lines.slice(2).join("").length).toBeGreaterThan(0); // non-empty body
    }
  });
  test("timings are finite, non-negative, and end >= start (clamped)", () => {
    for (const c of parseSrt(toSRT(NASTY))) {
      expect(Number.isFinite(c.start)).toBe(true);
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeGreaterThanOrEqual(c.start);
    }
  });
  test("indices are sequential 1..N", () => {
    const idx = toSRT(NASTY).trim().split(/\n\s*\n/).map((b) => Number(b.split("\n")[0]));
    expect(idx).toEqual(NASTY.segments.map((_, i) => i + 1));
  });
  test("empty transcript yields parseable (empty) output", () => {
    expect(parseSrt(toSRT(mkTranscript([]))).length).toBe(0);
  });
});

describe("toMarkdown is always structured", () => {
  test("has speakers + transcript sections and renders all cues", () => {
    const md = toMarkdown(NASTY);
    expect(md).toContain("## Speakers");
    expect(md).toContain("## Transcript");
    expect(md).toContain("normal line");
    expect(md.length).toBeGreaterThan(0);
  });
  test("empty transcript still produces valid markdown", () => {
    const md = toMarkdown(mkTranscript([]));
    expect(md).toContain("## Transcript");
  });
});

void srtTimeToSeconds;

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
