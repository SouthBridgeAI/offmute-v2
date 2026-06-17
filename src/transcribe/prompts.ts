/**
 * LLM transcription prompt + response schema. Asks Gemini for diarized segments with
 * relative `mm:ss` timestamps (ipgu-style — coarse but good enough to validate span
 * and gate alignment), speaker labels, verbatim text, and tone tags.
 */

export interface LlmSegmentRaw {
  speaker: string;
  start: string; // mm:ss, relative to chunk start
  end: string; // mm:ss, relative to chunk start
  text: string;
  tone?: string[];
}

export interface LlmTranscriptJson {
  segments: LlmSegmentRaw[];
}

/** JSON schema for Gemini structured output. String-typed enum values match `Type`. */
export const TRANSCRIPT_SCHEMA = {
  type: "OBJECT",
  properties: {
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          speaker: { type: "STRING", description: "Speaker label. Use an identified name from the roster if confident, else 'Speaker A', 'Speaker B', etc." },
          start: { type: "STRING", description: "Relative start time as mm:ss (00:00 = start of this audio chunk)" },
          end: { type: "STRING", description: "Relative end time as mm:ss" },
          text: { type: "STRING", description: "Verbatim transcribed words, including fillers and false starts" },
          tone: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Tone/behavior tags e.g. hesitant, laughing, contemplating, urgent, sarcastic. Empty array if neutral.",
          },
        },
        required: ["speaker", "start", "end", "text"],
      },
    },
  },
  required: ["segments"],
} as const;

export interface ChunkContext {
  /** Meeting description (from describe pass). */
  description?: string;
  /** Speaker roster / hints. */
  roster?: string;
  /** Tail of the previous chunk's transcript for continuity (last few segments). */
  previousTail?: string;
  /** Chunk index (1-based) and total. */
  index: number;
  total: number;
  /** Free-form user instructions. */
  instructions?: string;
}

export function transcriptionPrompt(ctx: ChunkContext): string {
  const parts: string[] = [];
  parts.push(
    `You are an expert speech transcription engine. Below is audio chunk ${ctx.index} of ${ctx.total} from a recording. Transcribe ALL speech verbatim and diarize it.`,
  );
  parts.push("");
  parts.push("Output one segment per speaker turn (a new segment whenever the speaker changes, or after a long pause, or at an interruption).");
  parts.push("");
  parts.push("For each segment provide:");
  parts.push("- speaker: a label. Use an identified name/role from the roster if you are confident who is speaking; otherwise use 'Speaker A', 'Speaker B', etc. Keep labels CONSISTENT across the chunk.");
  parts.push("- start, end: relative timestamps as mm:ss, where 00:00 is the START of this audio chunk. They must be monotonic and span the full chunk.");
  parts.push("- text: the verbatim words, including fillers (um, uh), false starts, and corrections. Do not paraphrase.");
  parts.push("- tone: array of behavior/emotion tags. Tag most segments — e.g. confident, hesitant, laughing, sarcastic, urgent, contemplative, whispering, emphatic, questioning, joking, frustrated. Use an empty array ONLY when nothing stands out.");
  parts.push("");
  parts.push("Rules:");
  parts.push("- Cover the ENTIRE audio with no gaps. Timestamps must be monotonic non-decreasing.");
  parts.push("- Capture interruptions and overlapping talk as separate, adjacent segments even if times overlap.");
  parts.push("- Do not invent content not present in the audio. If inaudible, write [inaudible].");
  parts.push("- Keep speaker labels consistent within this chunk; the same voice = same label.");
  if (ctx.description) {
    parts.push("");
    parts.push("MEETING CONTEXT:");
    parts.push(ctx.description);
  }
  if (ctx.roster) {
    parts.push("");
    parts.push("SPEAKER ROSTER (prefer these labels/names when you can identify the voice):");
    parts.push(ctx.roster);
  }
  if (ctx.previousTail) {
    parts.push("");
    parts.push("TRANSCRIPT OF THE END OF THE PREVIOUS CHUNK (for continuity — do NOT repeat this content, continue from where it leaves off):");
    parts.push(ctx.previousTail);
  }
  if (ctx.instructions) {
    parts.push("");
    parts.push("ADDITIONAL INSTRUCTIONS:");
    parts.push(ctx.instructions);
  }
  parts.push("");
  parts.push("Return JSON matching the schema: { segments: [ {speaker, start, end, text, tone} ] }");
  return parts.join("\n");
}
