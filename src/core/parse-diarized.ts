/**
 * Lenient parser for the LLM's diarized text format:
 *   [mm:ss] Speaker: (tone) text
 * Tolerates missing timestamps, missing tone, and continuation lines.
 * Browser-safe.
 */
import type { LlmLine } from "../types.js";
import { relTimeToSeconds } from "./time.js";

const LINE_RE =
  /^\s*(?:\[(?<ts>\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(?<speaker>[^:\[\]]{1,40}?):\s*(?:\((?<tone>[^)]{1,60})\)\s*)?(?<text>.*)$/;

export function parseDiarizedText(raw: string): LlmLine[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: LlmLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // skip code fences / markdown noise
    if (/^```/.test(trimmed)) continue;

    const m = trimmed.match(LINE_RE);
    if (m && m.groups && m.groups["text"] !== undefined) {
      const speaker = m.groups["speaker"]!.trim();
      const tsStr = m.groups["ts"];
      const tone = m.groups["tone"]?.trim();
      const text = m.groups["text"]!.trim();
      // Heuristic: reject "speakers" that are obviously not labels (too long / sentence-y)
      if (speaker.split(/\s+/).length > 6) {
        appendContinuation(out, trimmed);
        continue;
      }
      const approxStart = tsStr ? relTimeToSeconds(tsStr) ?? undefined : undefined;
      out.push({
        speaker,
        text,
        tone: tone || undefined,
        approxStart,
      });
    } else {
      // continuation of previous line (wrapped text)
      appendContinuation(out, trimmed);
    }
  }
  return out;
}

function appendContinuation(out: LlmLine[], text: string): void {
  const last = out[out.length - 1];
  if (last) last.text = `${last.text} ${text}`.trim();
}
