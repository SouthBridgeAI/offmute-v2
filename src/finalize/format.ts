/**
 * Output formatting: diarized SRT (with tone), Markdown transcript, and JSON.
 *
 * SRT breaking (spec §5): each finalized segment is one speaker turn. Long turns are
 * split into readable blocks (≤ maxChars / ≤ maxSec) using per-word timing so block
 * boundaries stay time-accurate. The speaker label prefixes each block.
 */
import type { Segment, TranscriptResult } from "../core/types.js";
import { formatSrtTiming } from "../utils/time.js";

const MAX_CHARS = 84; // ~2 lines of subtitles
const MAX_BLOCK_SEC = 7.0;

export interface FormatOptions {
  /** Prefix each SRT block with "Speaker: ". Default true. */
  labelSpeakers?: boolean;
  /** Append "(tone)" to blocks that have tone tags. Default true. */
  showTone?: boolean;
  /** Title for the markdown transcript. */
  title?: string;
}

/** Split one segment's words into readable SRT blocks. */
function splitIntoBlocks(seg: Segment): { start: number; end: number; text: string }[] {
  const words = seg.words && seg.words.length > 0 ? seg.words : null;
  if (!words) {
    return [{ start: seg.start, end: seg.end, text: seg.text }];
  }
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
  return blocks.length ? blocks : [{ start: seg.start, end: seg.end, text: seg.text }];
}

/** Format the transcript as a diarized SRT. */
export function formatSrt(result: TranscriptResult, opts: FormatOptions = {}): string {
  const labelSpeakers = opts.labelSpeakers ?? true;
  const showTone = opts.showTone ?? true;
  let idx = 1;
  const blocks: string[] = [];
  for (const seg of result.segments) {
    const tone = showTone && seg.tone && seg.tone.length ? ` (${seg.tone.join(", ")})` : "";
    const speaker = labelSpeakers ? `${seg.speakerName || seg.speaker}: ` : "";
    for (const b of splitIntoBlocks(seg)) {
      blocks.push(`${idx}\n${formatSrtTiming(b.start, b.end)}\n${speaker}${b.text}${tone}\n`);
      idx++;
    }
  }
  return blocks.join("\n");
}

/** Format as a readable markdown transcript. */
export function formatMarkdown(result: TranscriptResult, opts: FormatOptions = {}): string {
  const parts: string[] = [];
  parts.push(`# ${opts.title || "Transcript"}\n`);
  parts.push(`*Duration: ${Math.round(result.metadata.duration)}s · Speakers: ${result.speakers.length}*\n`);
  parts.push("\n## Speakers\n");
  for (const s of result.speakers) {
    const talk = s.talkTime ? ` (${Math.round(s.talkTime)}s)` : "";
    parts.push(`- **${s.name || s.id}**${talk}`);
  }
  parts.push("\n## Transcript\n");
  for (const seg of result.segments) {
    const mm = Math.floor(seg.start / 60).toString().padStart(2, "0");
    const ss = Math.floor(seg.start % 60).toString().padStart(2, "0");
    const tone = seg.tone && seg.tone.length ? ` *(${seg.tone.join(", ")})*` : "";
    parts.push(`[${mm}:${ss}] **${seg.speakerName || seg.speaker}**${tone}: ${seg.text}\n`);
  }
  return parts.join("\n");
}

/** Format as JSON (full structured result). */
export function formatJson(result: TranscriptResult): string {
  return JSON.stringify(result, null, 2);
}
