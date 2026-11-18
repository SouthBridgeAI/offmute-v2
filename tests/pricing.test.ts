import { describe, it, expect } from "vitest";
import {
  estimateRunCost,
  computeReceipt,
  asrCost,
  priceFor,
} from "../src/core/pricing.js";
import { usageFromMetadata } from "../src/providers/gemini-usage.js";

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

describe("priceFor", () => {
  it("prices a dated variant by the longest id it starts with", () => {
    // "gemini-2.5-flash-lite-…" also starts with "gemini-2.5-flash" (3× the input price).
    const lite = priceFor("gemini-2.5-flash-lite-preview-09-2025")!;
    expect(lite).toEqual(priceFor("gemini-2.5-flash-lite"));
  });

  it("switches a model to its announced price on the announced day", () => {
    const before = priceFor("gemini-4-argon", new Date("2026-11-30T23:00:00Z"))!;
    const after = priceFor("gemini-4-argon", new Date("2026-12-01T00:00:00Z"))!;
    expect(after.out).toBe(before.out * 2);
    expect(after.textIn).toBe(before.textIn * 2);
  });
});

describe("usageFromMetadata", () => {
  it("bills thinking tokens as output", () => {
    const u = usageFromMetadata({
      promptTokenCount: 15_000,
      candidatesTokenCount: 6_000,
      thoughtsTokenCount: 4_000,
      totalTokenCount: 25_000,
    });
    expect(u.outputTokens).toBe(10_000);
    expect(u.thoughtTokens).toBe(4_000);
  });
});

describe("computeReceipt", () => {
  it("aggregates usage per model and adds ASR", () => {
    const receipt = computeReceipt(
      [
        {
          provider: "gemini",
          model: "gemini-3.1-pro-preview",
          kind: "transcribe",
          inputTokens: 600_000,
          outputTokens: 60_000,
          calls: 3,
          errors: 0,
        },
        {
          provider: "gemini",
          model: "gemini-3.1-pro-preview",
          kind: "transcribe",
          inputTokens: 400_000,
          outputTokens: 40_000,
          calls: 1,
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
    const pro = priceFor("gemini-3.1-pro-preview")!;
    const ds = priceFor("deepseek-chat")!;
    const proUsd = (1_000_000 * pro.textIn + 100_000 * pro.out) / 1e6;
    const dsUsd = (10_000 * ds.textIn + 1_000 * ds.out) / 1e6;
    expect(receipt.perModel["gemini-3.1-pro-preview"]).toBeCloseTo(proUsd, 6);
    expect(receipt.llmUsd).toBeCloseTo(proUsd + dsUsd, 6);
    expect(receipt.asrUsd).toBeCloseTo(asrCost("assemblyai", 3600)!, 6);
    expect(receipt.totals.calls).toBe(5);
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
