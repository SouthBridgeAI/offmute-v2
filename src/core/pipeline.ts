/**
 * Pipeline orchestrator. Stub for the scaffolding phase — real stages are
 * implemented in the build phase per the spec (see docs/spec.md).
 */
import { resolveKeys, resolveOptions } from "./config.js";
import { logger } from "../utils/logger.js";
import type { PipelineOptions, TranscriptResult } from "./config.js";
import type { Segment, TranscriptMetadata } from "./types.js";

/**
 * Run the full transcription pipeline.
 *
 * TODO(build phase): wire up preprocess → describe → llm-transcribe → timestamped
 * → align → consistency → identify → finalize. Each stage reads/writes intermediates
 * for resumability. For now returns an empty result so the CLI/lib compiles.
 */
export async function transcribe(opts: PipelineOptions): Promise<TranscriptResult> {
  const options = resolveOptions(opts);
  const keys = resolveKeys(options.apiKeys);
  logger.setLevel(options.logLevel);
  logger.info(`offmute-v2 pipeline — input: ${options.input}`);
  logger.debug(`passes: ${options.passes.join(", ")}`);
  logger.debug(
    `keys present: ${Object.entries(keys)
      .filter(([, v]) => !!v)
      .map(([k]) => k)
      .join(", ")}`,
  );

  // TODO: implement stages. See docs/spec.md.
  const segments: Segment[] = [];
  const metadata: TranscriptMetadata = {
    sourceFile: options.input,
    duration: 0,
    processedAt: new Date().toISOString(),
    models: {},
    passes: options.passes,
  };

  return { segments, speakers: [], metadata };
}
