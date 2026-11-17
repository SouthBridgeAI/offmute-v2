/**
 * `offmute-v2 models` — the model matrix: what each role can use, which presets the
 * current keys can actually call, and what the defaults resolve to.
 */
import {
  resolveKeys,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_REASONER_MODEL,
  type ApiKeys,
} from "../core/config.js";
import {
  REASONER_PRESETS,
  resolveReasonerInfo,
  reasonerKey,
} from "../providers/reasoner.js";

// Notes say only what was measured on the owner's meetings (lab/bakeoff, 17 Nov 2026) or
// published by Google. Removed: gemini-3-pro-preview (shut down 9 Mar 2026), gemini-3.5-flash
// (served by 3.6 Flash since 8 Oct 2026), gemini-2.5-* (served by 3.x models from 1 Dec 2026).
const TRANSCRIBE_PRESETS: { model: string; note: string }[] = [
  { model: "gemini-3.1-pro-preview", note: "default" },
  {
    model: "gemini-4-hydrogen",
    note: "same cost per hour as the default; kept the speech the default dropped on hard chunks",
  },
  { model: "gemini-3.8-flash", note: "about a third of the cost until 1 Jan 2027" },
  { model: "gemini-4-argon", note: "slower; price doubles on 1 Dec 2026" },
  { model: "gemini-flash-latest", note: "moving alias, stays current" },
];

const TIMESTAMPED_PRESETS: { id: string; keyName: keyof ApiKeys | null; note: string }[] =
  [
    {
      id: "assemblyai",
      keyName: "assemblyai",
      note: "default — word timing + diarization",
    },
    {
      id: "elevenlabs",
      keyName: "elevenlabs",
      note: "Scribe v2 — strongest diarization labels",
    },
    {
      id: "whisper-groq",
      keyName: "groq",
      note: "free/fast — word timing, NO diarization",
    },
    { id: "none", keyName: null, note: "LLM-only (coarse timestamps)" },
  ];

const ok = (b: boolean) => (b ? "✓" : "✗ (no key)");

export async function runModels(): Promise<void> {
  const keys = resolveKeys();
  const lines: string[] = [];
  lines.push("");
  lines.push("TRANSCRIBE (multimodal — hears the audio)      --model");
  for (const p of TRANSCRIBE_PRESETS) {
    const mark = ok(!!keys.gemini);
    const def = p.model === DEFAULT_TRANSCRIBE_MODEL ? "  ← default" : "";
    lines.push(`  ${mark}  ${p.model.padEnd(28)} ${p.note}${def}`);
  }
  lines.push("");
  lines.push("TIMESTAMPED (owns the clock)                   --timestamped");
  for (const p of TIMESTAMPED_PRESETS) {
    const has = p.keyName === null ? true : !!keys[p.keyName];
    const def = p.id === "assemblyai" ? "  ← default" : "";
    lines.push(`  ${ok(has)}  ${p.id.padEnd(28)} ${p.note}${def}`);
  }
  lines.push("");
  lines.push("REASONER (text passes: identify, summary)      --reasoner");
  for (const p of REASONER_PRESETS) {
    const info = resolveReasonerInfo(p.model);
    const has = !!reasonerKey(info, keys);
    const def = p.model === DEFAULT_REASONER_MODEL ? "  ← default" : "";
    lines.push(`  ${ok(has)}  ${p.model.padEnd(28)} ${p.note}${def}`);
  }
  lines.push("");
  lines.push("Any Gemini model id works for --model; any provider-prefixed model");
  lines.push('(e.g. "zai:glm-4.7") works for --reasoner. Keys come from the environment');
  lines.push("or can be injected via the library API.");
  lines.push("");
  console.log(lines.join("\n"));
}
