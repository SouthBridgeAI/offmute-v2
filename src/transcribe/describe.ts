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

export function descriptionPrompt(
  fileName: string,
  instructions?: string,
  sampleCount = 1,
): string {
  const sampleNote =
    sampleCount > 1
      ? `You are given ${sampleCount} audio samples from a longer recording — taken from the beginning, middle, and end — plus any keyframes. Speakers may appear in only one sample.`
      : `You are listening to a recording.`;
  return `${sampleNote} Your job is to prepare context for a transcription engine. Describe what you hear${
    instructions ? ` (note: ${instructions})` : ""
  }.

Respond in TWO sections, clearly separated by a line containing only "---":

DESCRIPTION
A short paragraph: what kind of recording this is, the setting, the main topics, and the overall flow.

ROSTER
A bulleted speaker roster. For each distinct speaker you can identify, give:
- A short label to use consistently (a name/role if you can infer it, e.g. "Presenter (Hrishi)", else "Speaker A").
- A one-line description anchored to the VOICE itself (pitch, pace, accent, audio quality/mic distance) plus role if evident.
List the people you can distinguish. Do not invent names you didn't hear. If only one person speaks, say so.

IMPORTANT — name-to-voice binding: knowing WHO is present is not the same as knowing WHICH voice is whose. If the voices are similar (same accent, same register) or you are not certain which voice a name belongs to, say so explicitly in the roster (e.g. "one of the two voices — binding uncertain") instead of asserting it. Never describe a speaker by conversational role alone (e.g. "the primary speaker who drives the conversation") — that changes call to call and misleads downstream labeling; anchor to the voice.

File: ${fileName}`;
}

/** Describe the meeting from an audio sample (+ optional keyframes). */
export async function describeMeeting(
  client: GeminiClient,
  model: string,
  files: GeminiFileInput[],
  fileName: string,
  instructions?: string,
  audioSampleCount = 1,
): Promise<MeetingDescription> {
  const res = await client.generate(
    model,
    descriptionPrompt(fileName, instructions, audioSampleCount),
    files,
    {
      temperature: 0.2,
      maxRetries: 3,
      logKind: "describe",
    },
  );
  return { ...parseDescription(res.text || ""), raw: res.text || "" };
}

/** Split a description reply into its two sections, without their headings: the prompt
 * shows "DESCRIPTION" and "ROSTER", and models repeat them. */
export function parseDescription(text: string): { description: string; roster: string } {
  const parts = text.split(/\n---\n|\n\s*---\s*\n/);
  return {
    description: dropHeading(parts[0] ?? "", "DESCRIPTION") || text.trim(),
    roster:
      dropHeading(parts.slice(1).join("\n---\n"), "ROSTER") || "(no explicit roster)",
  };
}

/** `section` without a leading `word` heading: a line of its own ("## ROSTER") or a label
 * before a colon ("**DESCRIPTION:** …"). Prose that merely starts with the word stays. */
function dropHeading(section: string, word: string): string {
  const s = section.trim();
  const firstLine = s.split("\n", 1)[0] ?? "";
  if (new RegExp(`^[#*_\\s]*${word}[#*_:\\s]*$`, "i").test(firstLine)) {
    return s.slice(firstLine.length).trim();
  }
  return s.replace(new RegExp(`^[#*_\\s]*${word}[*_]*\\s*:[*_]*\\s*`, "i"), "");
}
