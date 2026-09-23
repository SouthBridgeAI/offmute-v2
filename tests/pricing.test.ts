import { describe, it, expect } from "vitest";
import { estimateRunCost, computeReceipt, asrCost } from "../src/core/pricing.js";

describe("estimateRunCost", () => {
  it("estimates a 47-minute default run in a sane range", () => {
    const est = estimateRunCost({
      durationSec: 2814,
      model: "gemini-3.1-pro-preview",
      reasoner: "deepseek-chat",
      tsProvider: "assemblyai",
      chunkSec: 600,
      overlapSec: 60,
      identify: true,
    });
    expect(est.incomplete).toBe(false);
    // Order of magnitude: dollars, not cents or hundreds.
    expect(est.totalUsd).toBeGreaterThan(0.1);
    expect(est.totalUsd).toBeLessThan(5);
    expect(est.lines.some((l) => l.includes("assemblyai"))).toBe(true);
  });

  it("marks unknown models as unpriced instead of guessing", () => {
    const est = estimateRunCost({
      durationSec: 600,
      model: "some-future-model",
      tsProvider: "none",
      chunkSec: 600,
      overlapSec: 60,
      identify: false,
    });
    expect(est.incomplete).toBe(true);
  });

  it("prices moving aliases and dated variants via prefix match", () => {
    const est = estimateRunCost({
      durationSec: 600,
      model: "gemini-2.5-flash-preview-09-2025",
      tsProvider: "none",
      chunkSec: 600,
      overlapSec: 60,
      identify: false,
    });
    expect(est.incomplete).toBe(false);
  });
});

describe("computeReceipt", () => {
  it("aggregates usage per model and adds ASR", () => {
    const receipt = computeReceipt(
      [
        {
          provider: "gemini",
          model: "gemini-3.5-flash",
          kind: "transcribe",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          calls: 4,
          errors: 0,
        },
        {
          provider: "deepseek",
          model: "deepseek-chat",
          kind: "identify",
          inputTokens: 10_000,
          outputTokens: 1_000,
          calls: 1,
          errors: 0,
        },
      ],
      "assemblyai",
      3600,
    );
    // 1M @ $1.50 + 100k @ $9 = 1.5 + 0.9 = 2.4; deepseek pennies; asr 0.15
    expect(receipt.llmUsd).toBeCloseTo(2.4 + 0.0032, 1);
    expect(receipt.asrUsd).toBeCloseTo(0.15, 5);
    expect(receipt.totals.calls).toBe(5);
    expect(receipt.perModel["gemini-3.5-flash"]).toBeGreaterThan(2);
    expect(receipt.incomplete).toBe(false);
  });

  it("does not bill ASR when the timestamped result came from cache", () => {
    // A re-run that hits the ASR cache pays nothing for ASR — the receipt (and the
    // lifetime stats fed from it) must not claim otherwise.
    const receipt = computeReceipt([], "assemblyai", 3600, false);
    expect(receipt.asrUsd).toBe(0);
    expect(receipt.totalUsd).toBe(0);
  });
});

describe("asrCost", () => {
  it("prices an hour of each provider", () => {
    expect(asrCost("assemblyai", 3600)).toBeCloseTo(0.15);
    expect(asrCost("elevenlabs", 3600)).toBeCloseTo(0.4);
    expect(asrCost("whisper-groq", 3600)).toBeCloseTo(0.04);
    expect(asrCost("unknown-provider", 3600)).toBeNull();
  });
});
