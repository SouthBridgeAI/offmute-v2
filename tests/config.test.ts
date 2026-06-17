import { describe, it, expect } from "vitest";
import { resolveOptions, planChunks } from "../src/core/config.js";

describe("resolveOptions", () => {
  it("flows model/reasoner/timestampedProvider through (regression: were undefined)", () => {
    const o = resolveOptions({
      input: "x",
      outputDir: "out",
      intermediatesDir: "int",
      model: "gemini-2.5-pro",
      reasoner: "deepseek-reasoner",
      timestampedProvider: "whisper-groq",
    });
    expect(o.model).toBe("gemini-2.5-pro");
    expect(o.reasoner).toBe("deepseek-reasoner");
    expect(o.timestampedProvider).toBe("whisper-groq");
  });

  it("applies sensible defaults", () => {
    const o = resolveOptions({ input: "x", outputDir: "out", intermediatesDir: "int" });
    expect(o.chunkDurationSec).toBe(600);
    expect(o.chunkOverlapSec).toBe(60);
    expect(o.concurrency).toBe(4);
    expect(o.diarizationLevel).toBe(2);
    expect(o.formats).toEqual(["srt", "md", "json"]);
  });
});

describe("planChunks", () => {
  it("plans overlapping chunks with trustedStart", () => {
    const chunks = planChunks(1500, 600, 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[0]!.trustedStart).toBe(0);
    expect(chunks[1]!.trustedStart).toBe(chunks[1]!.start + chunks[1]!.overlapWithPrevious);
    // chunks should cover the full duration
    const last = chunks[chunks.length - 1]!;
    expect(last.end).toBe(1500);
  });

  it("merges a short tail into the previous chunk", () => {
    // 630s with 600s chunks, 60s overlap → tail would be tiny → merged
    const chunks = planChunks(630, 600, 60);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.end).toBe(630);
  });
});
