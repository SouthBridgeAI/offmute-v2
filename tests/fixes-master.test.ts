import { describe, it, expect } from "vitest";
import { configSignature } from "../src/core/config.js";
import { resolveThinking, isThinkingConfigError } from "../src/providers/gemini.js";
import { transcribe } from "../src/core/pipeline.js";

describe("configSignature (cache invalidation on option change)", () => {
  const base = { input: "a.mp4", outputDir: "out" } as const;

  it("changes when the model changes (the stale-cache bug)", () => {
    const a = configSignature({ ...base, model: "gemini-2.5-flash" });
    const b = configSignature({ ...base, model: "gemini-3.1-pro-preview" });
    expect(a).not.toBe(b);
  });

  it("changes for instructions / chunking / provider / level", () => {
    const ref = configSignature(base);
    expect(configSignature({ ...base, instructions: "label the host" })).not.toBe(ref);
    expect(configSignature({ ...base, chunkDurationSec: 300 })).not.toBe(ref);
    expect(configSignature({ ...base, chunkOverlapSec: 30 })).not.toBe(ref);
    expect(configSignature({ ...base, timestampedProvider: "whisper-groq" })).not.toBe(ref);
    expect(configSignature({ ...base, diarizationLevel: 3 })).not.toBe(ref);
  });

  it("is stable for options that don't affect intermediates", () => {
    const ref = configSignature(base);
    expect(configSignature({ ...base, outputDir: "other", formats: ["srt"], concurrency: 1, logLevel: "debug" })).toBe(ref);
  });
});

describe("resolveThinking (per-model thinking config)", () => {
  it("disables/limits thinking for 2.5 via thinkingBudget", () => {
    expect(resolveThinking("gemini-2.5-flash")).toEqual({ thinkingBudget: 0 });
    expect(resolveThinking("gemini-2.5-pro")).toEqual({ thinkingBudget: 128 });
  });
  it("floors 3.x pro to LOW (MINIMAL unsupported), flash to MINIMAL", () => {
    expect(resolveThinking("gemini-3.1-pro-preview")).toEqual({ thinkingLevel: "LOW" });
    expect(resolveThinking("gemini-flash-latest")).toEqual({ thinkingLevel: "MINIMAL" });
  });
  it("returns nothing for 2.0 (no thinking control)", () => {
    expect(resolveThinking("gemini-2.0-flash")).toBeUndefined();
  });
  it("recognizes thinking-config rejection messages", () => {
    expect(isThinkingConfigError("Thinking level MINIMAL is not supported for this model.")).toBe(true);
    expect(isThinkingConfigError("Unknown name \"thinkingConfig\"")).toBe(true);
    expect(isThinkingConfigError("rate limit exceeded")).toBe(false);
  });
});

describe("transcribe() option validation (clear errors, not cryptic crashes)", () => {
  it("rejects a missing input", async () => {
    // @ts-expect-error intentionally bad
    await expect(transcribe({ outputDir: "out" })).rejects.toThrow(/'input'.*required/);
  });
  it("rejects a missing outputDir", async () => {
    // @ts-expect-error intentionally bad
    await expect(transcribe({ input: "a.mp4" })).rejects.toThrow(/'outputDir'.*required/);
  });
});
