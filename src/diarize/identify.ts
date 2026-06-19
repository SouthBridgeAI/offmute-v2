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

function buildTranscriptExcerpt(segments: IdentifySegment[], speakers: SpeakerInfo[]): string {
  // Give the reasoner a representative sample per speaker: their longest segments
  // (most likely to contain identification cues), plus overall flow.
  const bySpeaker: Record<string, IdentifySegment[]> = {};
  for (const s of segments) (bySpeaker[s.speaker] ??= []).push(s);
  const parts: string[] = [];
  for (const sp of speakers) {
    const segs = (bySpeaker[sp.id] || [])
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, 6);
    const voices = sp.asrVoices && sp.asrVoices.length ? `, voices=${sp.asrVoices.join("/")}` : "";
    parts.push(
      `### ${sp.id} (${sp.name || "unknown"}, ${sp.segmentCount || 0} turns, ~${Math.round(sp.talkTime || 0)}s${voices})`,
    );
    for (const s of segs) parts.push(`  ${s.text}`);
  }
  return parts.join("\n");
}

export function identifyPrompt(transcriptExcerpt: string, roster: string, knownSpeakers?: string[]): string {
  return `You are identifying speakers in a transcribed recording. Below are the most substantial quotes from each speaker (labeled exactly as shown in the headers, e.g. "Speaker A"), plus a roster description.

Identify each speaker by name and/or role using content cues: self-introductions ("my name is X"), references to themselves, their role, or context. If you cannot confidently identify a speaker, leave the name empty ("").

${knownSpeakers && knownSpeakers.length ? `Known possible speakers: ${knownSpeakers.join(", ")}\n` : ""}ROSTER:
${roster}

TRANSCRIPT EXCERPTS BY SPEAKER:
${transcriptExcerpt}

Respond as JSON: { "speakers": [ { "id": "<exact speaker id from the headers>", "name": "Full Name or Role", "confidence": "high|medium|low", "evidence": "short quote/reason" } ], "reasoning": "one-paragraph summary" }
Use the EXACT speaker id strings from the headers above (e.g. "Speaker A").`;
}

/** Identify speakers via a text reasoner. Returns a name map (speaker id → name). */
export async function identifySpeakers(
  client: OpenAICompatClient,
  model: string,
  segments: IdentifySegment[],
  speakers: SpeakerInfo[],
  roster: string,
  knownSpeakers?: string[],
): Promise<IdentifyResult> {
  const excerpt = buildTranscriptExcerpt(segments, speakers);
  const { data, error } = await client.chatJson<{ speakers: IdentifiedSpeaker[]; reasoning: string }>(
    model,
    [{ role: "user", content: identifyPrompt(excerpt, roster, knownSpeakers) }],
    { temperature: 0.1, maxTokens: 2000, logKind: "identify" },
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
