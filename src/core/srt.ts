/** SRT parsing and formatting. Browser-safe. */
import { formatSrtTiming, srtTimeToSeconds } from "./time.js";

export interface SrtCue {
  id: number;
  start: number; // seconds
  end: number; // seconds
  /** full text (may contain a leading "Speaker: " prefix) */
  text: string;
  /** speaker parsed from a leading "Name: " prefix, if present */
  speaker?: string;
  /** text with the speaker prefix stripped */
  body: string;
}

const TIMING_RE =
  /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/;

/** Split a "Speaker: text" line into {speaker, body}. Heuristic, conservative. */
export function splitSpeakerPrefix(text: string): {
  speaker?: string;
  body: string;
} {
  // Only treat as a speaker prefix if the part before the first colon is short,
  // has no sentence punctuation, and looks like a name/label.
  const idx = text.indexOf(":");
  if (idx <= 0 || idx > 40) return { body: text };
  const prefix = text.slice(0, idx).trim();
  const rest = text.slice(idx + 1).trim();
  if (!rest) return { body: text };
  // reject if prefix contains sentence-ending punctuation or is too "wordy"
  if (/[.!?]/.test(prefix)) return { body: text };
  const wordCount = prefix.split(/\s+/).length;
  if (wordCount > 5) return { body: text };
  return { speaker: prefix, body: rest };
}

/** Parse an SRT string into cues. Lenient about blank lines / numbering. */
export function parseSrt(content: string): SrtCue[] {
  const cues: SrtCue[] = [];
  // normalize line endings; split into blocks on blank lines
  const blocks = content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\s*\n/);

  let autoId = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // find the timing line (may be line 0 if no numeric id)
    let timingLineIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 2); i++) {
      if (TIMING_RE.test(lines[i]!)) {
        timingLineIdx = i;
        break;
      }
    }
    if (timingLineIdx === -1) continue;

    const m = lines[timingLineIdx]!.match(TIMING_RE);
    if (!m) continue;
    const start = srtTimeToSeconds(m[1]!);
    const end = srtTimeToSeconds(m[2]!);

    // id: the line before timing if numeric, else auto
    let id = ++autoId;
    if (timingLineIdx > 0) {
      const maybeId = parseInt(lines[0]!.trim(), 10);
      if (!Number.isNaN(maybeId)) id = maybeId;
    }

    const text = lines
      .slice(timingLineIdx + 1)
      .join(" ")
      .trim();
    const { speaker, body } = splitSpeakerPrefix(text);
    cues.push({ id, start, end, text, speaker, body });
  }
  return cues;
}

export interface SrtFormatOptions {
  /** include "Speaker: " prefix in each cue body */
  includeSpeaker?: boolean;
}

/** Format cues (with explicit speaker) into an SRT string. */
export function formatSrt(
  cues: Array<{ start: number; end: number; speaker?: string; text: string }>,
  options: SrtFormatOptions = {}
): string {
  const { includeSpeaker = true } = options;
  return (
    cues
      .map((cue, i) => {
        const speakerPrefix =
          includeSpeaker && cue.speaker ? `${cue.speaker}: ` : "";
        return `${i + 1}\n${formatSrtTiming(cue.start, cue.end)}\n${speakerPrefix}${cue.text}`;
      })
      .join("\n\n") + "\n"
  );
}
