/**
 * Description pass: a multimodal LLM looks at an audio sample (+ keyframes for video)
 * to produce a meeting description and a speaker roster. This roster anchors
 * cross-chunk speaker consistency and gives the transcription pass context.
 */
import { GeminiClient } from "../providers/gemini.js";
import type { GeminiFileInput } from "../providers/gemini.js";

export interface MeetingDescription {
  description: string;
  roster: string;
  raw: string;
}

export function descriptionPrompt(fileName: string, instructions?: string): string {
  return `You are listening to a recording to prepare a transcription engine. Describe what you hear${
    instructions ? ` (note: ${instructions})` : ""
  }.

Respond in TWO sections, clearly separated by a line containing only "---":

DESCRIPTION
A short paragraph: what kind of recording this is, the setting, the main topics, and the overall flow.

ROSTER
A bulleted speaker roster. For each distinct speaker you can identify, give:
- A short label to use consistently (a name/role if you can infer it, e.g. "Presenter (Hrishi)", else "Speaker A").
- A one-line description (voice, role, accent if notable).
List the people you can distinguish. Do not invent names you didn't hear. If only one person speaks, say so.

File: ${fileName}`;
}

/** Describe the meeting from an audio sample (+ optional keyframes). */
export async function describeMeeting(
  client: GeminiClient,
  model: string,
  files: GeminiFileInput[],
  fileName: string,
  instructions?: string,
): Promise<MeetingDescription> {
  const res = await client.generate(model, descriptionPrompt(fileName, instructions), files, {
    temperature: 0.2,
    maxRetries: 3,
    logKind: "describe",
  });
  const text = res.text || "";
  // Split into DESCRIPTION / ROSTER by the "---" separator.
  const parts = text.split(/\n---\n|\n\s*---\s*\n/);
  const description = parts[0]?.trim() || text.trim();
  const roster = parts.slice(1).join("\n---\n").trim() || "(no explicit roster)";
  return { description, roster, raw: text };
}
