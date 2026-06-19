/**
 * Prompt construction for the diarization (content) pass. Browser-safe.
 *
 * We ask for a plain-text diarized transcript in the format
 *   [mm:ss] Speaker: (tone) text
 * rather than JSON: long transcripts can exceed output limits, and text degrades
 * gracefully under truncation (you lose the tail, not the whole parse), whereas a
 * truncated JSON array is unrecoverable. The lenient parser (parse-diarized.ts)
 * tolerates the variations. (Hard-won lesson from ipgu's parser pain.)
 */
import type { AsrResult } from "../types.js";
import { secondsToCompact } from "./time.js";

export interface DiarizationPromptInput {
  /** user instructions (speaker hints, focus, grouping rules) */
  instructions?: string;
  /** compact ASR diarized transcript used as a HINT (not authority) */
  asrHint?: string;
  /** for chunked processing: which chunk and how many */
  chunk?: { index: number; total: number; startSeconds: number };
  /** tail of the previous chunk's transcript for continuity */
  previousTail?: string;
}

export const DIARIZATION_SYSTEM = `You are an expert meeting transcriptionist and diarizer. You transcribe verbatim (including filler words and false starts), attribute every utterance to the correct speaker, and you are careful and literal. You never invent content you cannot hear.`;

export function buildDiarizationPrompt(input: DiarizationPromptInput): string {
  const { instructions, asrHint, chunk, previousTail } = input;
  const parts: string[] = [];

  if (chunk && chunk.total > 1) {
    parts.push(
      `This is part ${chunk.index + 1} of ${chunk.total} of a longer recording. ` +
        `This part starts at ${secondsToCompact(chunk.startSeconds)} in the full recording. ` +
        `Use timestamps RELATIVE to the start of THIS clip ([mm:ss] from 0:00).`
    );
  } else {
    parts.push(`This is a recorded talk/meeting. Produce a complete diarized transcript.`);
  }

  if (instructions) {
    parts.push(`\nIMPORTANT USER INSTRUCTIONS (follow these for speaker labeling and focus):\n${instructions}`);
  }

  if (asrHint) {
    parts.push(
      `\nA baseline speech-to-text system produced the rough diarization below. Its TIMING is reliable but its SPEAKER LABELS are often wrong (it splits one person into several, merges different people, and misses short interjections). Use it only as a hint — trust what you HEAR for who is speaking:\n\n${asrHint}`
    );
  }

  if (previousTail) {
    parts.push(
      `\nFor speaker continuity only, the previous part ended with the lines below. The start of THIS clip overlaps the previous part — transcribe EVERYTHING you hear in THIS clip in full (from 0:00), including any overlap; do not skip the beginning:\n...${previousTail}`
    );
  }

  parts.push(`
Instructions:
- Diarize: identify each distinct speaker. Infer real names from context (introductions, people addressing each other) when possible; otherwise label "Speaker 1", "Speaker 2", etc. Keep each speaker's label consistent throughout.
- Give the start timestamp of every speaker turn in [mm:ss].
- Add a brief tone/emotion note in parentheses when notable: (laughing), (hesitant), (emphatic), (audience member), etc. Omit when neutral.
- Transcribe verbatim. Start a new line whenever the speaker changes.

Output ONLY the transcript, one line per speaker turn, exactly:
[mm:ss] Speaker: (tone) text

Begin.`);

  return parts.join("\n");
}

/** Build a compact ASR hint string from utterances, trimming long ones. */
export function buildAsrHint(asr: AsrResult, maxUtterances = 200, maxCharsPerUtterance = 160): string {
  const lines: string[] = [];
  const utts = asr.utterances.slice(0, maxUtterances);
  for (const u of utts) {
    const text = u.text.length > maxCharsPerUtterance ? u.text.slice(0, maxCharsPerUtterance) + "…" : u.text;
    lines.push(`[${secondsToCompact(u.start)}] ${u.speaker}: ${text}`);
  }
  if (asr.utterances.length > maxUtterances) lines.push(`… (${asr.utterances.length - maxUtterances} more)`);
  return lines.join("\n");
}
