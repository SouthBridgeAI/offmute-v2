import { describe, it, expect } from "vitest";
import { transcribeChunk } from "../src/transcribe/llm-transcribe.js";
import type { GeminiClient, GeminiUsage } from "../src/providers/gemini.js";
import type { LlmTranscriptJson } from "../src/transcribe/prompts.js";

const usage: GeminiUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
/** A 60s chunk transcript: `n` segments spread evenly, each saying `text(i)`. */
const transcript = (n: number, text: (i: number) => string): LlmTranscriptJson => ({
  segments: Array.from({ length: n }, (_, i) => ({
    speaker: i % 2 ? "Speaker B" : "Speaker A",
    start: mmss(i * 3),
    end: mmss(i * 3 + 2),
    text: text(i),
  })),
});
const LOOPING = transcript(20, () => "Bye. See ya. Take care. You too.");
const SENTENCES = [
  "Let's start with pricing, because the pilot ends in March.",
  "Right, and the customer asked for monthly billing.",
  "I think annual works if we give them an exit clause.",
  "Hiring is the other thing, we still need a designer.",
  "Can we ask the agency for two candidates this week?",
  "Sure, I'll email them after lunch.",
  "The roadmap slipped because the importer broke twice.",
  "Was that the CSV parser or the auth flow?",
  "Both, honestly, but the parser was worse.",
  "Okay, so demo day moves to the fourteenth.",
  "That gives us time to fix onboarding too.",
  "Do we have numbers from the last cohort?",
  "Retention was sixty percent after four weeks.",
  "Better than I expected, given the bugs.",
  "Let's write that up for the investor update.",
  "I can draft it tonight and send it round.",
  "Perfect, then we're done for today.",
  "Thanks, talk tomorrow.",
];
const CLEAN = transcript(SENTENCES.length, (i) => SENTENCES[i]!);
/** Test double: transcribeChunk only calls generateJson; responses are served in order. */
function fakeClient(responses: LlmTranscriptJson[]): GeminiClient {
  const queue = [...responses];
  const fake = {
    async generateJson() {
      const data = queue.shift()!;
      return { data, raw: JSON.stringify(data), usage };
    },
  };
  return fake as unknown as GeminiClient;
}
const ctx = { index: 1, total: 1 };

describe("transcribeChunk repetition handling", () => {
  it("retries a repetition loop and keeps the clean retry", async () => {
    const r = await transcribeChunk(fakeClient([LOOPING, CLEAN]), "m", "c.mp3", 0, ctx, {
      chunkDurationSec: 60,
      validationRetries: 1,
    });
    expect(r.validation.isValid).toBe(true);
    expect(r.segments[0]!.text).toContain("pricing");
  });

  it("flags the chunk as degenerate when every attempt loops", async () => {
    const r = await transcribeChunk(
      fakeClient([LOOPING, LOOPING]),
      "m",
      "c.mp3",
      0,
      ctx,
      {
        chunkDurationSec: 60,
        validationRetries: 1,
      },
    );
    expect(r.validation.isValid).toBe(false);
    expect(r.validation.degenerate).toBe(true);
  });
});
