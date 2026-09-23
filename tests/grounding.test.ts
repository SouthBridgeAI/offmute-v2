import { describe, it, expect } from "vitest";
import { chunkGrounding } from "../src/transcribe/grounding.js";
import type { ParsedLlmSegment } from "../src/transcribe/llm-transcribe.js";
import type { TimestampedWord } from "../src/core/types.js";

const seg = (text: string, startSec = 0, endSec = 60): ParsedLlmSegment => ({
  speaker: "Speaker A",
  startSec,
  endSec,
  text,
  tone: [],
  rawStart: "",
  rawEnd: "",
});
/** One ASR word per whitespace token, 0.5s apart from `t0`. */
const asrWords = (text: string, t0 = 0): TimestampedWord[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => ({ text: w, start: t0 + i * 0.5, end: t0 + i * 0.5 + 0.4 }));

// What was actually said (as ASR heard it)…
const HEARD =
  "honestly I have been in limbo trying to figure out my future since the startup folded " +
  "my main goal right now is finding a role where I learn quickly maybe healthcare maybe " +
  "education the thing I keep coming back to is how much personality a child develops " +
  "early and whether products could support parents better during those first years";
// …and a fluent conversation the LLM invented over the same audio (field report 1).
const INVENTED =
  "good point we need to stand out in the market so what do you think the key message " +
  "should be I think something about how our product saves time great idea we can use " +
  "customer testimonials to back it up awesome let's touch base on this again next week " +
  "sounds like a plan anything else we need to cover alright let's wrap it up thanks everyone";

describe("chunkGrounding", () => {
  it("flags text the ASR never heard as ungrounded", () => {
    const g = chunkGrounding([seg(INVENTED)], asrWords(HEARD), 0, 600);
    expect(g.judged).toBe(true);
    expect(g.grounded).toBe(false);
  });

  it("accepts text the ASR corroborates", () => {
    const g = chunkGrounding([seg(HEARD)], asrWords(HEARD), 0, 600);
    expect(g.grounded).toBe(true);
  });

  it("only counts ASR words inside the chunk's time range", () => {
    // Matching speech exists later in the file, outside this chunk; what the ASR heard
    // *inside* the chunk is something else entirely → the chunk is still ungrounded.
    const asr = [...asrWords(INVENTED, 0), ...asrWords(HEARD, 700)];
    const g = chunkGrounding([seg(HEARD)], asr, 0, 600);
    expect(g.grounded).toBe(false);
  });

  it("makes no judgment when ASR emits a different script than the LLM", () => {
    // Field report 1: ASR wrote Chinese characters over a (correct) romanized Malayalam
    // phone call — the ASR is the unreliable side there.
    const romanized =
      "thaan enthelum undo aayirunnu njan ezhunnettu vachaal poyitti innu engane swasam " +
      "edukkan cheriya budhimuttu undavum athe njan chodikunnathu ariyan vendiyanu inhaler " +
      "edutho eduthu athu maattiyittilla njanum thuni virichu aakki kondirikkukayanu joli " +
      "cheyyunnund aayirunnu idayil ithu oru nalla exercise aayi bhakshanam enthenkilum kazhicho";
    const han =
      "盘 子 里 面 的 温 度 已经 很 高 了 我 们 先 看 看 这个 问题 然后 再 说 吧 好 的 没 问题 谢谢 你 今天 天气 不错 我们 走 吧";
    const g = chunkGrounding([seg(romanized)], asrWords(han), 0, 600);
    expect(g.judged).toBe(false);
    expect(g.grounded).toBe(true);
  });

  it("ignores the LLM's bracketed annotations", () => {
    const g = chunkGrounding(
      [seg(`${"[inaudible] ".repeat(40)}${HEARD}`)],
      asrWords(HEARD),
      0,
      600,
    );
    expect(g.precision).toBeGreaterThan(0.9);
  });
});
