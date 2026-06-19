/**
 * LLM speaker-identification pass: merges provisional labels (e.g. "Speaker 1"
 * used before a name was known) into canonical identities, infers names/roles,
 * and applies instruction-driven grouping. Text-only (cheap, browser-capable).
 */
import type { LlmLine } from "../types.js";

/** Minimal generator interface so this stays decoupled from the Node Gemini client. */
export interface TextGenerator {
  generate(
    parts: Array<{ text?: string; filePath?: string }>,
    options: {
      model?: string;
      temperature?: number;
      maxOutputTokens?: number;
      systemInstruction?: string;
      thinkingBudget?: number;
      thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
      /** JSON schema → structured-output (JSON) mode */
      schema?: unknown;
      /** label for call logging */
      label?: string;
    }
  ): Promise<{ text: string }>;
}

/**
 * Response schema for the identify pass. With JSON mode the model is constrained to
 * this shape, so the output is valid JSON (no code fences / prose to strip). We still
 * keep the lenient parser as a fallback in case a model ignores the schema.
 * (Gemini's responseSchema uses uppercase OpenAPI types.)
 */
export const IDENTIFY_SCHEMA = {
  type: "OBJECT",
  properties: {
    speakers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          rawLabels: { type: "ARRAY", items: { type: "STRING" } },
          name: { type: "STRING" },
          description: { type: "STRING" },
        },
        required: ["rawLabels", "name"],
      },
    },
  },
  required: ["speakers"],
} as const;

export interface IdentifyResult {
  /** raw turn label -> canonical name */
  resolvedNames: Record<string, string>;
  /** canonical name -> description/role */
  descriptions: Record<string, string>;
}

export interface IdentifyOptions {
  instructions?: string;
  llmModel?: string;
  /** per raw-label distribution of ASR speaker labels (voice anchor) */
  asrSpeakerByLabel?: Record<string, Record<string, number>>;
}

/** Format voice-anchor hint: each label's dominant ASR voice cluster. */
function buildVoiceHint(dist: Record<string, Record<string, number>>): string {
  const lines: string[] = [];
  for (const [label, counts] of Object.entries(dist)) {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, n]) => s + n, 0);
    if (total === 0) continue;
    const top = sorted
      .slice(0, 2)
      .map(([sp, n]) => `${sp}=${Math.round((100 * n) / total)}%`)
      .join(", ");
    lines.push(`  "${label}" → voice ${top}`);
  }
  return lines.join("\n");
}

/** Pick representative example turns (longest) per raw label, for grounding. */
function exampleTurns(turns: LlmLine[], perLabel = 2, maxChars = 200): string {
  const byLabel = new Map<string, LlmLine[]>();
  for (const t of turns) {
    const arr = byLabel.get(t.speaker);
    if (arr) arr.push(t);
    else byLabel.set(t.speaker, [t]);
  }
  const lines: string[] = [];
  for (const [label, ts] of byLabel) {
    const top = [...ts].sort((a, b) => b.text.length - a.text.length).slice(0, perLabel);
    lines.push(`Label "${label}" (${ts.length} turns). Examples:`);
    for (const t of top) {
      const text = t.text.length > maxChars ? t.text.slice(0, maxChars) + "…" : t.text;
      lines.push(`  - ${text}`);
    }
  }
  return lines.join("\n");
}

function buildIdentifyPrompt(turns: LlmLine[], options: IdentifyOptions): string {
  const labels = [...new Set(turns.map((t) => t.speaker))];
  const examples = exampleTurns(turns);
  return `Below is a diarized transcript's speaker labels with example utterances. The labels may be inconsistent: the same person can appear under a provisional label (like "Speaker 1") early on and under their real name later, once it became known. Different people may share a generic label.

Your job: produce the canonical set of speakers.
- Merge labels that refer to the SAME person.
- Give each canonical speaker a name if it can be inferred from the transcript (someone introduces themselves, or is addressed by name); otherwise keep a clean generic label like "Speaker 1".
- Add a short role/description if evident (e.g. "main presenter", "audience member").
- Each canonical speaker must be exactly ONE person. NEVER create a catch-all like "Panel", "Multiple", "Various", or "Mixed". If a raw label seems to cover overlapping/multiple voices, assign it to the single most likely dominant speaker (use the voice analysis below).
${options.instructions ? `- Follow these user instructions for naming/grouping: ${options.instructions}\n` : ""}
Distinct raw labels: ${labels.map((l) => `"${l}"`).join(", ")}

${examples}
${
  options.asrSpeakerByLabel
    ? `\nVoice analysis (a separate diarizer clustered the audio into voices A/B/C…; this is a STRONG signal for merging — labels sharing the same dominant voice are usually the same person, regardless of what they say):\n${buildVoiceHint(options.asrSpeakerByLabel)}\n`
    : ""
}
Respond with ONLY a JSON object (no prose, no code fence) of this shape:
{"speakers":[{"rawLabels":["Speaker 1","Rishi"],"name":"Rishi","description":"main presenter"}, ...]}
Every raw label above must appear in exactly one speaker's rawLabels.`;
}

/** Strip code fences and parse the first JSON object found. */
export function parseIdentifyJson(text: string): {
  speakers: Array<{ rawLabels: string[]; name: string; description?: string }>;
} | null {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    if (obj && Array.isArray(obj.speakers)) return obj;
    return null;
  } catch {
    return null;
  }
}

export async function identifySpeakersLLM(
  gen: TextGenerator,
  turns: LlmLine[],
  options: IdentifyOptions = {}
): Promise<IdentifyResult> {
  const prompt = buildIdentifyPrompt(turns, options);
  const res = await gen.generate([{ text: prompt }], {
    model: options.llmModel ?? "gemini-flash-latest",
    temperature: 0,
    maxOutputTokens: 16384,
    thinkingLevel: "MINIMAL",
    schema: IDENTIFY_SCHEMA,
    label: "identify",
  });
  const parsed = parseIdentifyJson(res.text);
  const resolvedNames: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  if (parsed) {
    for (const sp of parsed.speakers) {
      if (!sp.name) continue;
      for (const raw of sp.rawLabels ?? []) resolvedNames[raw] = sp.name;
      if (sp.description) descriptions[sp.name] = sp.description;
    }
  }
  return { resolvedNames, descriptions };
}
