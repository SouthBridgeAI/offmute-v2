/**
 * offmute-v2 browser entry — the pure, dependency-free core that runs anywhere.
 *
 * The browser host is responsible for the two "impure" steps:
 *   1. preprocessing media (ffmpeg.wasm) → 16k mono audio,
 *   2. calling the ASR + LLM providers (fetch),
 * then feeds the results here to fuse them into a timestamp-correct transcript.
 *
 * Typical browser flow:
 *   const asr = await myAsrFetch(audioBlob);            // -> AsrResult
 *   const text = await myGeminiFetch(audioBlob, prompt);// -> diarized text
 *   const turns = parseDiarizedText(text);
 *   const { transcript } = assembleTranscript({ turns, asr });
 *   const srt = toSRT(transcript);
 */
export * from "./types.js";
export * from "./core/time.js";
export * from "./core/srt.js";
export * from "./core/align.js";
export * from "./core/format.js";
export * from "./core/speakers.js";
export * from "./core/parse-diarized.js";
export * from "./core/prompts.js";
export * from "./core/chunk.js";
export * from "./core/eval.js";
export {
  identifySpeakersLLM,
  parseIdentifyJson,
  type TextGenerator,
  type IdentifyResult,
} from "./core/identify.js";
export { assembleTranscript, type AssembleOptions } from "./core/assemble.js";
