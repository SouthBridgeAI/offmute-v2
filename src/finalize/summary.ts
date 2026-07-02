/**
 * Summary pass (--summary): one reasoner call over the final transcript → a meeting
 * summary markdown (TL;DR, decisions, action items, per-speaker positions, open
 * questions). offmute v1's most-loved feature, absent from v2 until now.
 */
import type { TranscriptResult } from "../core/types.js";
import type { OpenAICompatClient } from "../providers/openai-compat.js";
import { compactTime } from "./format.js";

export function summaryPrompt(result: TranscriptResult, instructions?: string): string {
  const lines = result.segments.map((s) => {
    const name = s.speakerName || s.speaker;
    return `[${compactTime(s.start)}] ${name}: ${s.text}`;
  });
  return `Below is a diarized meeting transcript. Write a summary in clean markdown with these sections (omit a section entirely if there is nothing for it):

## TL;DR
2-4 sentences. What was this, what mattered.

## Decisions
Bullet list of decisions actually made (not topics discussed). Attribute who decided when clear.

## Action items
Bullet list, "**Owner** — action" format. Only real commitments, with the timestamp in [mm:ss].

## By speaker
One short paragraph per speaker: their main points and positions.

## Open questions
Things raised but not resolved.

Be specific and quote sparingly. Do not invent content.${instructions ? `\n\nAdditional instructions: ${instructions}` : ""}

TRANSCRIPT:
${lines.join("\n")}`;
}

export async function summarizeTranscript(
  client: OpenAICompatClient,
  model: string,
  result: TranscriptResult,
  instructions?: string,
): Promise<string> {
  const res = await client.chat(
    model,
    [{ role: "user", content: summaryPrompt(result, instructions) }],
    { temperature: 0.3, maxTokens: 4000, logKind: "summary" },
  );
  if (res.error || !res.text) {
    throw new Error(`summary failed: ${res.error || "empty response"}`);
  }
  return res.text.trim() + "\n";
}
