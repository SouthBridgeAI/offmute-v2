/**
 * Speaker-identification pass (diarization level 3). A text reasoner (DeepSeek) reads
 * the consistent transcript + roster and names speakers from content cues — e.g.
 * "my name is Rishi, I run Southbridge" identifies the presenter. A speaker may
 * self-identify in only one chunk, so the reasoner must see the whole transcript.
 */
import { OpenAICompatClient } from "../providers/openai-compat.js";
import type { SpeakerInfo } from "../core/types.js";

/** Minimal segment shape needed for identification. */
export interface IdentifySegment {
  speaker: string;
  text: string;
}

export interface IdentifiedSpeaker {
  id: string;
  name: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
}

export interface IdentifyResult {
  nameMap: Record<string, string>;
  speakers: IdentifiedSpeaker[];
  reasoning: string;
}

/** Above this size, fall back to per-speaker excerpts instead of the full transcript. */
const MAX_FULL_TRANSCRIPT_CHARS = 80_000;

function buildTranscriptExcerpt(
  segments: IdentifySegment[],
  speakers: SpeakerInfo[],
): string {
  const speakerHeader = (sp: SpeakerInfo) => {
    const voices =
      sp.asrVoices && sp.asrVoices.length ? `, voices=${sp.asrVoices.join("/")}` : "";
    return `${sp.id} (${sp.segmentCount || 0} turns, ~${Math.round(sp.talkTime || 0)}s talk time${voices})`;
  };

  // The FULL transcript in order when it fits — vocatives ("thanks, Jay") and flips
  // only make sense with the conversational flow, and a meeting's worth of text is
  // cheap for a text reasoner. Excerpt mode is the fallback for very long recordings.
  const totalChars = segments.reduce((n, s) => n + s.text.length, 0);
  if (totalChars <= MAX_FULL_TRANSCRIPT_CHARS) {
    const parts = [
      "SPEAKERS:",
      ...speakers.map((sp) => `- ${speakerHeader(sp)}`),
      "",
      "FULL TRANSCRIPT (in order):",
    ];
    for (const s of segments) parts.push(`[${s.speaker}] ${s.text}`);
    return parts.join("\n");
  }

  // Fallback: a representative sample per speaker — their longest segments (most
  // likely to contain identification cues).
  const bySpeaker: Record<string, IdentifySegment[]> = {};
  for (const s of segments) (bySpeaker[s.speaker] ??= []).push(s);
  const parts: string[] = [];
  for (const sp of speakers) {
    const segs = (bySpeaker[sp.id] || [])
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, 6);
    parts.push(`### ${speakerHeader(sp)}`);
    for (const s of segs) parts.push(`  ${s.text}`);
  }
  return parts.join("\n");
}

export function identifyPrompt(
  transcriptExcerpt: string,
  roster: string,
  knownSpeakers?: string[],
  nameHints?: Record<string, string>,
  sourceFileName?: string,
): string {
  const hintBlock =
    nameHints && Object.keys(nameHints).length
      ? `\nTENTATIVE LABELS (from the transcription model — UNVERIFIED and possibly SWAPPED between speakers; treat as weak hints to confirm or refute, never as ground truth):\n${Object.entries(
          nameHints,
        )
          .map(([id, n]) => `  ${id} was tentatively called "${n}"`)
          .join("\n")}\n`
      : "";
  return `You are identifying speakers in a transcribed recording. Below is the diarized transcript (speaker ids like "Speaker A" are stable voice clusters), plus a roster description.

Identify each speaker by name and/or role using content cues: self-introductions ("my name is X"), references to themselves, their role, or context. If you cannot confidently identify a speaker, leave the name empty ("").

CRITICAL — direction of address: when a speaker says a name, work out whether they are talking ABOUT themselves or TO someone else. "Thanks, Rishi" or "I'm stealing your update, Rishi" is spoken TO Rishi — so that speaker is NOT Rishi, and Rishi is one of the OTHER speakers. Only first-person statements ("I'm Rishi", "my name is...") identify the speaker themselves. Misreading address direction is the most common error in this task.

BEWARE the roster and tentative labels: they describe who is PRESENT, but their name-to-voice binding may be wrong or swapped (this happens when speakers sound similar). Verify every name against first-person evidence in the transcript itself. If the transcript contradicts a tentative label, trust the transcript. If you cannot verify which of two speakers a name belongs to, leave both names empty rather than guess.

Prefer real human names over screen handles/usernames when both are available for the same person (e.g. a recording named after "Jay" whose call UI shows a handle — the person is Jay).

${knownSpeakers && knownSpeakers.length ? `Known possible speakers: ${knownSpeakers.join(", ")}\n` : ""}${sourceFileName ? `RECORDING FILENAME (often names participants): ${sourceFileName}\n` : ""}ROSTER:
${roster}
${hintBlock}
TRANSCRIPT:
${transcriptExcerpt}

Respond as JSON: { "speakers": [ { "id": "<exact speaker id from the headers>", "name": "Full Name or Role", "confidence": "high|medium|low", "evidence": "a short quote copied VERBATIM from the transcript above that supports the name" } ], "reasoning": "one-paragraph summary" }
Use the EXACT speaker id strings (e.g. "Speaker A"). The evidence field must be an exact quote from the TRANSCRIPT — never the filename, roster, or your own words; an unverifiable evidence quote disqualifies the name.`;
}

/** Identify speakers via a text reasoner. Returns a name map (speaker id → name). */
export async function identifySpeakers(
  client: OpenAICompatClient,
  model: string,
  segments: IdentifySegment[],
  speakers: SpeakerInfo[],
  roster: string,
  knownSpeakers?: string[],
  nameHints?: Record<string, string>,
  sourceFileName?: string,
): Promise<IdentifyResult> {
  const excerpt = buildTranscriptExcerpt(segments, speakers);
  const { data, error } = await client.chatJson<{
    speakers: IdentifiedSpeaker[];
    reasoning: string;
  }>(
    model,
    [
      {
        role: "user",
        content: identifyPrompt(
          excerpt,
          roster,
          knownSpeakers,
          nameHints,
          sourceFileName,
        ),
      },
    ],
    // 8000 tokens: verbose models quote long verbatim evidence, and Gemini's compat
    // endpoint spends part of the budget on thinking — tighter caps truncated
    // mid-JSON and silently emptied whole identify passes (observed live, twice).
    { temperature: 0.1, maxTokens: 8000, logKind: "identify" },
  );
  if (error || !data) {
    return { nameMap: {}, speakers: [], reasoning: error || "no response" };
  }
  const nameMap: Record<string, string> = {};
  for (const s of data.speakers || []) {
    if (s.name && s.name.trim()) nameMap[s.id] = s.name.trim();
  }
  return { nameMap, speakers: data.speakers || [], reasoning: data.reasoning || "" };
}
