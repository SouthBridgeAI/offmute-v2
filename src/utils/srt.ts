/**
 * SRT parsing/formatting. Ported & cleaned from ipgu/meeting-diary.
 */
import { parseSrtTiming, formatSrtTiming } from "./time.js";
import type { Segment } from "../core/types.js";

export interface ParsedSrtEntry {
  id: number;
  start: number;
  end: number;
  text: string;
  /** Raw timing string as it appeared in the file. */
  timingString: string;
}

/** Parse an SRT file string into entries. Tolerant of BOM and \r\n. */
export function parseSrt(content: string): ParsedSrtEntry[] {
  const clean = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const blocks = clean.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const entries: ParsedSrtEntry[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) continue;

    // First line may be an id; if it's not a number, it's likely a timing line
    // (some SRTs omit ids). Handle both.
    let idLine = 0;
    let id = parseInt(lines[0]!.trim(), 10);
    if (isNaN(id)) {
      id = entries.length + 1;
      idLine = -1; // no id line; timing is line 0
    }
    const timingLine = lines[idLine + 1]!.trim();
    const timing = parseSrtTiming(timingLine);
    if (!timing) continue;

    const text = lines.slice(idLine + 2).join("\n").trim();
    entries.push({
      id,
      start: timing.start,
      end: timing.end,
      text,
      timingString: timingLine,
    });
  }

  entries.sort((a, b) => a.start - b.start);
  return entries;
}

/** Format an array of {@link Segment} as an SRT string. */
export function formatSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const timing = formatSrtTiming(seg.start, seg.end);
      const tone = seg.tone && seg.tone.length > 0 ? ` (${seg.tone.join(", ")})` : "";
      const text = `${seg.speakerName || seg.speaker}: ${seg.text}${tone}`;
      return `${i + 1}\n${timing}\n${text}\n`;
    })
    .join("\n");
}

/** Format segments as a readable markdown transcript. */
export function formatMarkdown(
  segments: Segment[],
  opts: { title?: string; speakers?: string[] } = {},
): string {
  const parts: string[] = [];
  if (opts.title) parts.push(`# ${opts.title}\n`);
  if (opts.speakers && opts.speakers.length > 0) {
    parts.push("## Speakers\n");
    for (const s of opts.speakers) parts.push(`- **${s}**`);
    parts.push("\n## Transcript\n");
  }
  for (const seg of segments) {
    const mm = Math.floor(seg.start / 60)
      .toString()
      .padStart(2, "0");
    const ss = Math.floor(seg.start % 60)
      .toString()
      .padStart(2, "0");
    const tone = seg.tone && seg.tone.length > 0 ? ` *(${seg.tone.join(", ")})*` : "";
    parts.push(`[${mm}:${ss}] **${seg.speakerName || seg.speaker}**${tone}: ${seg.text}\n`);
  }
  return parts.join("\n");
}
