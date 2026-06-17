/**
 * offmute-v2 — browser entry.
 *
 * The core logic (alignment, consistency, identification, finalize, formatting) is
 * pure TypeScript with no node deps, so it runs unchanged in the browser. This entry
 * re-exports it alongside fetch-based providers (no SDK, no node), plus a
 * `transcribeBrowser` orchestrator.
 *
 * Browser constraints:
 *  - No ffmpeg: the caller provides an already-extracted mono audio Blob (use
 *    ffmpeg.wasm to extract/chunk from a video file). `transcribeBrowser` sends the
 *    whole Blob to AssemblyAI (whole-file) and to Gemini inline (base64), which suits
 *    files ≤ ~20MB. For longer files, chunk with ffmpeg.wasm and call the stages
 *    directly (alignSegments etc.) per chunk.
 *  - API keys are supplied by the caller (e.g. from user input / your backend).
 */
import { GeminiFetchClient } from "./providers/gemini-fetch.js";
import { AssemblyAIFetchClient } from "./providers/assemblyai-fetch.js";
import { OpenAICompatClient } from "./providers/openai-compat.js";
import { transcriptionPrompt, TRANSCRIPT_SCHEMA, type LlmTranscriptJson } from "./transcribe/prompts.js";
import { parseLlmSegments } from "./transcribe/llm-transcribe.js";
import { alignSegments } from "./align/aligner.js";
import { assignGlobalSpeakers } from "./diarize/consistency.js";
import { identifySpeakers } from "./diarize/identify.js";
import { finalizeSegments } from "./finalize/finalize.js";
import { formatSrt, formatMarkdown, formatJson } from "./finalize/format.js";
import type { Segment, TranscriptResult, SpeakerInfo } from "./core/types.js";

// Re-export the pure-logic surface for custom browser orchestration.
export {
  alignSegments,
  assignGlobalSpeakers,
  identifySpeakers,
  finalizeSegments,
  formatSrt,
  formatMarkdown,
  formatJson,
  parseLlmSegments,
  transcriptionPrompt,
  TRANSCRIPT_SCHEMA,
  GeminiFetchClient,
  AssemblyAIFetchClient,
  OpenAICompatClient,
};
export type { Segment, TranscriptResult, SpeakerInfo };

export interface TranscribeBrowserOptions {
  /** Mono audio Blob (caller extracts via ffmpeg.wasm). ≤ ~20MB for inline Gemini. */
  audio: Blob;
  geminiApiKey: string;
  assemblyaiApiKey: string;
  /** Audio file extension for MIME detection (default "flac"). */
  audioExt?: string;
  model?: string;
  instructions?: string;
  level?: 1 | 2 | 3;
  deepseekApiKey?: string;
  knownSpeakers?: string[];
}

/**
 * Run the full pipeline in the browser from a mono audio Blob. Uses one Gemini call
 * (whole audio inline) + one AssemblyAI transcript (whole file) + alignment. Best for
 * files whose audio fits the inline limit (~20MB); for longer, chunk and call the
 * stages directly.
 */
export async function transcribeBrowser(opts: TranscribeBrowserOptions): Promise<TranscriptResult> {
  const model = opts.model ?? "gemini-2.5-flash";
  const level = opts.level ?? 2;

  // 1. ASR (whole file).
  const asr = await new AssemblyAIFetchClient(opts.assemblyaiApiKey).transcribe(opts.audio);

  // 2. LLM transcription (whole audio inline, single call).
  const audioBuf = await opts.audio.arrayBuffer();
  const gemini = new GeminiFetchClient({ apiKey: opts.geminiApiKey });
  const gen = await gemini.generateJson<LlmTranscriptJson>(
    model,
    transcriptionPrompt({ index: 1, total: 1, instructions: opts.instructions }),
    [{ data: audioBuf, ext: opts.audioExt ?? "flac" }],
    TRANSCRIPT_SCHEMA as Record<string, unknown>,
    { temperature: 0.2, maxRetries: 3 },
  );
  if (!gen.data) throw new Error(`LLM transcription failed: ${gen.error ?? "no data"}`);
  const llmSegments = parseLlmSegments(gen.data, 0).segments;

  // 3. Align LLM text → ASR timestamps.
  const aligned = alignSegments(llmSegments, asr.words, { timeMarginSec: 30 });

  // 4. Consistency (merge ASR speakers by LLM label).
  const cons = assignGlobalSpeakers(aligned, asr.utterances);
  let segments: typeof cons.segments = cons.segments;
  let speakers: SpeakerInfo[] = cons.speakers;

  // 5. Identify (level 3).
  if (level >= 3 && opts.deepseekApiKey) {
    const ds = OpenAICompatClient.fromProvider("deepseek", opts.deepseekApiKey, "deepseek-chat");
    const id = await identifySpeakers(
      ds,
      "deepseek-chat",
      segments.map((s) => ({ speaker: s.speaker, text: s.text })),
      speakers,
      "(browser: no roster available — infer from transcript content)",
      opts.knownSpeakers,
    );
    segments = segments.map((s) =>
      id.nameMap[s.speaker] ? { ...s, speakerName: id.nameMap[s.speaker] } : s,
    );
    speakers = speakers.map((sp) => (id.nameMap[sp.id] ? { ...sp, name: id.nameMap[sp.id] } : sp));
  }

  // 6. Finalize.
  const finalSegments: Segment[] = finalizeSegments(segments);
  return {
    segments: finalSegments,
    speakers,
    metadata: {
      sourceFile: "browser",
      duration: asr.durationSec,
      processedAt: new Date().toISOString(),
      models: { transcribe: model, timestamped: "assemblyai-universal-2" },
      passes: ["timestamped", "llm-transcribe", "align", "consistency", level >= 3 ? "identify" : "", "finalize"].filter(
        Boolean,
      ) as string[],
    },
  };
}
