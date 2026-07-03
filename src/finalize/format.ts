/**
 * Output formatting: diarized SRT (with tone), Markdown transcript, plain text, and JSON.
 *
 * Markdown ships in two styles:
 *  - "merged" (default): consecutive same-speaker segments join into one paragraph —
 *    the formatting that reads best over long transcripts. Merging happens HERE, in the
 *    formatter only; the underlying segments are never merged (measured WER regression
 *    when segments were merged upstream — boundary words duplicate).
 *  - "turns": one block per segment (the previous default), useful when you want the
 *    fine-grained turn structure visible.
 *
 * SRT breaking (spec §5): each finalized segment is one speaker turn. Long turns are
 * split into readable blocks (≤ MAX_CHARS / ≤ MAX_BLOCK_SEC) using per-word timing when
 * available, or proportional timing otherwise — so no cue is ever "too thick to read".
 */
import type { Segment, TranscriptResult } from "../core/types.js";
import { formatSrtTiming, formatDuration } from "../utils/time.js";

const MAX_CHARS = 84; // ~2 lines of subtitles
const MAX_BLOCK_SEC = 7.0;

export interface FormatOptions {
  /** Prefix each SRT block with "Speaker: ". Default true. */
  labelSpeakers?: boolean;
  /** Show "(tone)" annotations. Default true. */
  showTone?: boolean;
  /** Title for the markdown transcript. */
  title?: string;
  /** Markdown layout: merged same-speaker paragraphs (default) or one block per turn. */
  mdStyle?: "merged" | "turns";
  /** Include [mm:ss] timestamps in markdown/text. Default true. */
  timestamps?: boolean;
}

/** Seconds → compact clock time: `03:24` or `1:02:45` (hours only when needed). */
export function compactTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = m.toString().padStart(2, "0");
  const rr = r.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

/** Split one segment's words into readable SRT blocks (word-timed path). */
function splitByWords(seg: Segment): { start: number; end: number; text: string }[] {
  const words = seg.words!;
  const blocks: { start: number; end: number; text: string }[] = [];
  let curWords: typeof words = [];
  let curLen = 0;
  const flush = () => {
    if (curWords.length === 0) return;
    const first = curWords[0]!;
    const last = curWords[curWords.length - 1]!;
    blocks.push({
      start: first.start,
      end: last.end,
      text: curWords.map((w) => w.text).join(" "),
    });
    curWords = [];
    curLen = 0;
  };
  for (const w of words) {
    const addLen = w.text.length + 1;
    const blockStart = curWords.length === 0 ? w.start : curWords[0]!.start;
    const wouldSec = w.end - blockStart;
    if (curLen + addLen > MAX_CHARS || wouldSec > MAX_BLOCK_SEC) {
      flush();
    }
    curWords.push(w);
    curLen += addLen;
  }
  flush();
  return blocks;
}

/** Split a segment WITHOUT word timings: break text on the char budget, spread the
 * segment's time proportionally by character count. Guarantees the cue-width cap holds
 * on the fallback path too (previously long no-words segments shipped as one fat cue). */
function splitByChars(seg: Segment): { start: number; end: number; text: string }[] {
  const text = seg.text.trim();
  if (text.length <= MAX_CHARS) return [{ start: seg.start, end: seg.end, text }];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > MAX_CHARS) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  const total = lines.reduce((n, l) => n + l.length, 0) || 1;
  const dur = Math.max(0, seg.end - seg.start);
  const blocks: { start: number; end: number; text: string }[] = [];
  let t = seg.start;
  for (const line of lines) {
    const span = (line.length / total) * dur;
    blocks.push({ start: t, end: Math.min(seg.end, t + span), text: line });
    t += span;
  }
  return blocks;
}

/** Split one segment into readable SRT blocks. */
function splitIntoBlocks(seg: Segment): { start: number; end: number; text: string }[] {
  const blocks =
    seg.words && seg.words.length > 0 ? splitByWords(seg) : splitByChars(seg);
  return blocks.length ? blocks : [{ start: seg.start, end: seg.end, text: seg.text }];
}

/** Format the transcript as a diarized SRT. */
export function formatSrt(result: TranscriptResult, opts: FormatOptions = {}): string {
  const labelSpeakers = opts.labelSpeakers ?? true;
  const showTone = opts.showTone ?? true;
  let idx = 1;
  const blocks: string[] = [];
  for (const seg of result.segments) {
    const tone =
      showTone && seg.tone && seg.tone.length ? ` (${seg.tone.join(", ")})` : "";
    const speaker = labelSpeakers ? `${seg.speakerName || seg.speaker}: ` : "";
    const segBlocks = splitIntoBlocks(seg);
    for (let i = 0; i < segBlocks.length; i++) {
      const b = segBlocks[i]!;
      // Tone belongs to the turn, not every cue — annotate only the first block.
      const t = i === 0 ? tone : "";
      blocks.push(
        `${idx}\n${formatSrtTiming(b.start, b.end)}\n${speaker}${b.text}${t}\n`,
      );
      idx++;
    }
  }
  return blocks.join("\n");
}

/** Group consecutive same-speaker segments (display-only merge). */
function groupBySpeaker(segments: Segment[]): Segment[][] {
  const groups: Segment[][] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    const key = (s: Segment) => s.speakerName || s.speaker;
    if (last && key(last[0]!) === key(seg)) last.push(seg);
    else groups.push([seg]);
  }
  return groups;
}

/** Render one group's text with tone markers, suppressing consecutive duplicates. */
function groupText(group: Segment[], showTone: boolean): string {
  const parts: string[] = [];
  let lastTone = "";
  for (const s of group) {
    const toneStr = s.tone && s.tone.length ? s.tone.join(", ") : "";
    if (showTone && toneStr && toneStr !== lastTone) {
      parts.push(`*(${toneStr})* ${s.text}`);
    } else {
      parts.push(s.text);
    }
    lastTone = toneStr;
  }
  return parts.join(" ");
}

function mdHeader(result: TranscriptResult, opts: FormatOptions): string[] {
  const parts: string[] = [];
  parts.push(`# ${opts.title || "Transcript"}\n`);
  parts.push(
    `*Duration: ${formatDuration(result.metadata.duration)} · ${result.speakers.length} speakers · ${result.segments.length} turns*\n`,
  );
  parts.push("\n## Speakers\n");
  for (const s of result.speakers) {
    const talk = s.talkTime ? ` — ${formatDuration(Math.round(s.talkTime))}` : "";
    const desc = s.description ? ` · ${s.description}` : "";
    parts.push(`- **${s.name || s.id}**${talk}${desc}`);
  }
  parts.push("\n## Transcript\n");
  return parts;
}

/** Format as a readable markdown transcript (merged paragraphs by default). */
export function formatMarkdown(
  result: TranscriptResult,
  opts: FormatOptions = {},
): string {
  const showTone = opts.showTone ?? true;
  const timestamps = opts.timestamps ?? true;
  const style = opts.mdStyle ?? "merged";
  const parts = mdHeader(result, opts);

  const groups =
    style === "merged"
      ? groupBySpeaker(result.segments)
      : result.segments.map((s) => [s]);
  for (const group of groups) {
    const first = group[0]!;
    const ts = timestamps ? `\`[${compactTime(first.start)}]\` ` : "";
    const name = first.speakerName || first.speaker;
    parts.push(`${ts}**${name}:** ${groupText(group, showTone)}\n`);
  }
  return parts.join("\n");
}

/** Format as compact plain text (no markdown syntax). */
export function formatText(result: TranscriptResult, opts: FormatOptions = {}): string {
  const timestamps = opts.timestamps ?? true;
  const showTone = opts.showTone ?? false; // plain text defaults to no tone noise
  const lines: string[] = [];
  for (const group of groupBySpeaker(result.segments)) {
    const first = group[0]!;
    const ts = timestamps ? `[${compactTime(first.start)}] ` : "";
    const name = first.speakerName || first.speaker;
    const text = group
      .map((s) =>
        showTone && s.tone?.length ? `(${s.tone.join(", ")}) ${s.text}` : s.text,
      )
      .join(" ");
    lines.push(`${ts}${name}: ${text}`);
  }
  return lines.join("\n\n") + "\n";
}

/** Format as JSON (full structured result). */
export function formatJson(result: TranscriptResult): string {
  return JSON.stringify(result, null, 2);
}
