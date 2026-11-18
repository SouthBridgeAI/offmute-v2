/**
 * The models offmute uses when none is named. Plain constants, no Node imports: the
 * browser build reads them too.
 */

/** Transcription default. Gemini 4 Hydrogen: on nine hard chunks of real meetings it kept
 * 96.6% of the speech where Gemini 3.1 Pro (the 0.1.x default) kept 72.9%, at the same
 * $0.74 per audio hour (docs/field-report-2, §8). Its thinking runs at LOW
 * (providers/gemini-models.ts). */
export const DEFAULT_TRANSCRIBE_MODEL = "gemini-4-hydrogen";

/** `--pro`: Gemini 4 Argon kept the most speech in the same bake-off (97.3%), at about
 * 1.7× Hydrogen's time per chunk and, from 1 Dec 2026, about twice its price. */
export const PRO_TRANSCRIBE_MODEL = "gemini-4-argon";

/** Speaker naming and summaries. */
export const DEFAULT_REASONER_MODEL = "deepseek-chat";
