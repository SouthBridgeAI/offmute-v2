/** Output formatters: Transcript -> SRT / Markdown / JSON. Browser-safe. */
import type { Transcript, TranscriptSegment } from "../types.js";
import { formatSrtTiming, secondsToCompact } from "./time.js";

function speakerLabelMap(transcript: Transcript): Map<string, string> {
  const m = new Map<string, string>();
  for (const sp of transcript.speakers) m.set(sp.id, sp.label);
  return m;
}

export interface SrtOptions {
  /** include "Speaker: " prefix (default true) */
  includeSpeaker?: boolean;
  /** include tone annotations inline (default false for SRT) */
  includeTone?: boolean;
}

/** Make text safe for one SRT cue: collapse blank lines (they separate cues) + trim. */
export function srtCueText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/\n[ \t]*\n+/g, "\n").trim() || " ";
}

export function toSRT(transcript: Transcript, options: SrtOptions = {}): string {
  const { includeSpeaker = true, includeTone = false } = options;
  const labels = speakerLabelMap(transcript);
  const blocks = transcript.segments.map((seg, i) => {
    const label = labels.get(seg.speakerId) ?? seg.speakerId;
    const prefix = includeSpeaker ? `${label}: ` : "";
    const tone = includeTone && seg.tone ? `(${seg.tone}) ` : "";
    const body = srtCueText(`${prefix}${tone}${seg.text}`);
    // clamp so the end is never before the start (defensive — keeps the cue valid)
    return `${i + 1}\n${formatSrtTiming(seg.start, Math.max(seg.start, seg.end))}\n${body}`;
  });
  return blocks.join("\n\n") + "\n";
}

export interface MarkdownOptions {
  includeTimestamps?: boolean;
  includeTone?: boolean;
  title?: string;
  /** merge consecutive segments by the same speaker into one paragraph */
  mergeBySpeaker?: boolean;
}

export function toMarkdown(transcript: Transcript, options: MarkdownOptions = {}): string {
  const { includeTimestamps = true, includeTone = true, title = "Transcript", mergeBySpeaker = true } = options;
  const labels = speakerLabelMap(transcript);
  const out: string[] = [];

  out.push(`# ${title}\n`);
  const m = transcript.metadata;
  out.push(`*Duration: ${secondsToCompact(m.durationSeconds)} · ${transcript.segments.length} segments · ` +
    `${transcript.speakers.length} speakers*`);
  if (m.asrProvider || m.llmModel) {
    out.push(`*ASR: ${m.asrProvider ?? "—"} · LLM: ${m.llmModel ?? "—"}*`);
  }
  out.push("");

  // Speakers
  out.push(`## Speakers\n`);
  for (const sp of transcript.speakers) {
    const named = sp.named ? "" : " *(unidentified)*";
    const desc = sp.description ? ` — ${sp.description}` : "";
    out.push(`- **${sp.label}**${named}${desc}`);
  }
  out.push(`\n## Transcript\n`);

  const groups = mergeBySpeaker ? groupBySpeaker(transcript.segments) : transcript.segments.map((s) => [s]);
  for (const group of groups) {
    const first = group[0]!;
    const label = labels.get(first.speakerId) ?? first.speakerId;
    const ts = includeTimestamps ? `\`[${secondsToCompact(first.start)}]\` ` : "";
    const text = group
      .map((s) => (includeTone && s.tone ? `*(${s.tone})* ${s.text}` : s.text))
      .join(" ");
    out.push(`${ts}**${label}:** ${text}\n`);
  }
  return out.join("\n");
}

function groupBySpeaker(segments: TranscriptSegment[]): TranscriptSegment[][] {
  const groups: TranscriptSegment[][] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.speakerId === seg.speakerId) last.push(seg);
    else groups.push([seg]);
  }
  return groups;
}

export function toJSON(transcript: Transcript): string {
  return JSON.stringify(transcript, null, 2);
}

/** A compact plain-text transcript (no markdown). */
export function toText(transcript: Transcript, options: { includeTimestamps?: boolean } = {}): string {
  const { includeTimestamps = true } = options;
  const labels = speakerLabelMap(transcript);
  return (
    groupBySpeaker(transcript.segments)
      .map((group) => {
        const first = group[0]!;
        const label = labels.get(first.speakerId) ?? first.speakerId;
        const ts = includeTimestamps ? `[${secondsToCompact(first.start)}] ` : "";
        return `${ts}${label}: ${group.map((s) => s.text).join(" ")}`;
      })
      .join("\n\n") + "\n"
  );
}
