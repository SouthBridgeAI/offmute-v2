import { describe, it, expect } from "vitest";
import {
  formatMarkdown,
  formatText,
  formatSrt,
  compactTime,
} from "../src/finalize/format.js";
import type { TranscriptResult, Segment } from "../src/core/types.js";

function seg(partial: Partial<Segment> & { id: number }): Segment {
  return {
    start: 0,
    end: 1,
    speaker: "Speaker A",
    speakerName: "Speaker A",
    text: "hello",
    ...partial,
  };
}

function result(segments: Segment[]): TranscriptResult {
  return {
    segments,
    speakers: [{ id: "Speaker A", name: "Alice", talkTime: 10 }],
    metadata: {
      sourceFile: "x.mp4",
      duration: 60,
      processedAt: "",
      models: {},
      passes: [],
    },
  };
}

describe("formatMarkdown", () => {
  const segs = [
    seg({ id: 1, start: 0, end: 2, speakerName: "Alice", text: "First." }),
    seg({ id: 2, start: 2, end: 4, speakerName: "Alice", text: "Second." }),
    seg({
      id: 3,
      start: 4,
      end: 6,
      speakerName: "Bob",
      speaker: "Speaker B",
      text: "Reply.",
    }),
    seg({ id: 4, start: 6, end: 8, speakerName: "Alice", text: "Back again." }),
  ];

  it("merges consecutive same-speaker segments by default", () => {
    const md = formatMarkdown(result(segs));
    // Alice's first two segments join into one paragraph.
    expect(md).toContain("**Alice:** First. Second.");
    // Speaker change breaks the group; Alice reappears separately.
    expect(md).toContain("**Bob:** Reply.");
    expect(md).toContain("**Alice:** Back again.");
    // Exactly 3 transcript paragraphs (not 4).
    expect(md.match(/\*\*(Alice|Bob):\*\*/g)).toHaveLength(3);
  });

  it("keeps one block per turn with mdStyle=turns", () => {
    const md = formatMarkdown(result(segs), { mdStyle: "turns" });
    expect(md.match(/\*\*(Alice|Bob):\*\*/g)).toHaveLength(4);
  });

  it("suppresses consecutive duplicate tone tags within a merged group", () => {
    const toned = [
      seg({
        id: 1,
        start: 0,
        end: 2,
        speakerName: "Alice",
        text: "Ha!",
        tone: ["laughing"],
      }),
      seg({
        id: 2,
        start: 2,
        end: 4,
        speakerName: "Alice",
        text: "So funny.",
        tone: ["laughing"],
      }),
      seg({ id: 3, start: 4, end: 6, speakerName: "Alice", text: "Anyway.", tone: [] }),
    ];
    const md = formatMarkdown(result(toned));
    expect(md.match(/\(laughing\)/g)).toHaveLength(1);
  });

  it("never merges the underlying segment data (display-only)", () => {
    const before = JSON.stringify(segs);
    formatMarkdown(result(segs));
    expect(JSON.stringify(segs)).toBe(before);
  });
});

describe("formatText", () => {
  it("produces plain grouped lines with timestamps", () => {
    const txt = formatText(
      result([
        seg({ id: 1, start: 65, end: 67, speakerName: "Alice", text: "One." }),
        seg({ id: 2, start: 67, end: 69, speakerName: "Alice", text: "Two." }),
      ]),
    );
    expect(txt).toContain("[01:05] Alice: One. Two.");
    expect(txt).not.toContain("**");
  });
});

describe("formatSrt cue caps", () => {
  it("splits a long segment without word timings into capped cues", () => {
    const longText = Array(40).fill("supercalifragilistic").join(" "); // ~840 chars
    const srt = formatSrt(result([seg({ id: 1, start: 0, end: 30, text: longText })]));
    const cues = srt.split("\n\n").filter((c) => c.trim());
    expect(cues.length).toBeGreaterThan(5);
    for (const cue of cues) {
      const body = cue.split("\n").slice(2).join(" ");
      // speaker prefix + text stays readable
      expect(body.length).toBeLessThan(120);
    }
  });

  it("annotates tone only on the first cue of a turn", () => {
    const longText = Array(40).fill("word").join(" ");
    const srt = formatSrt(
      result([seg({ id: 1, start: 0, end: 30, text: longText, tone: ["sarcastic"] })]),
    );
    expect(srt.match(/\(sarcastic\)/g)).toHaveLength(1);
  });

  it("keeps cue timings monotonic on the proportional-split path", () => {
    const longText = Array(60).fill("abcdef").join(" ");
    const srt = formatSrt(result([seg({ id: 1, start: 10, end: 40, text: longText })]));
    const times = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map(
      (m) => +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 1000,
    );
    for (let i = 1; i < times.length; i++)
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
  });
});

describe("compactTime", () => {
  it("formats minutes and hours", () => {
    expect(compactTime(65)).toBe("01:05");
    expect(compactTime(3725)).toBe("1:02:05");
  });
});
