# Part 1 — Code Review Report: offmute-v2 (opus variant)

## Verdict

This is a **strong, genuinely impressive build**. It does the hard thing the brief asked for — fuse a multimodal LLM (content/diarization/names/tone) with an ASR timing track via forced alignment — and it actually works, with measured numbers backed by intermediates on disk. Typecheck is clean, all 30 unit tests pass, the build produces node + CLI + a pure browser bundle, and the showcased Satya podcast output (5 speakers auto-named correctly) holds up when inspected.

The code is unusually well-reasoned for an agent-built project: the process log is excellent, the architecture is principled, and most "gotchas" are documented at the point they bite. The main weaknesses are (a) some **spec-vs-implementation drift** (a few advertised features were never built), (b) **orchestration duplication** between the Node and browser pipelines, and (c) a couple of **misleading comments** and **minor doc staleness**. None are correctness-critical.

I'd grade it roughly **A−**: production-credible v1, with a short, clear list of cleanups before it deserves a 1.0.

---

## 1. How well it followed the starting instructions

The instructions in `0-starting-instructions.md` were followed closely and, in places, to the letter.

| Instruction                                                             | Status       | Evidence                                                                                                                                |
| ----------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Scaffold in `./offmute-v2`, gitignore, TS project, typechecker + linter | ✅ Mostly    | Clean TS scaffold, strict `tsconfig`, tsup build. **No linter** (ESLint) is configured — "linter" was interpreted as `tsc --strict`.    |
| Append-only `process_log_..._scratch_space.md` in intermediates         | ✅ Exemplary | 7 detailed dated entries; honest about failures, rejected review suggestions, dead ends.                                                |
| README for self, kept updated                                           | ✅           | Both a user README and the process log.                                                                                                 |
| Study the 3 inspirations incl. commit history & bugs                    | ✅           | Entry 1 shows real study of offmute/ipgu/meeting-diary, including their parser pain and merge logic.                                    |
| Web research on SOTA models/ASR                                         | ✅           | Entry 2 documents live Gemini 3.x + AssemblyAI/Groq/OpenAI landscape.                                                                   |
| Build a spec & plan with hypotheses + failure detection                 | ✅           | `docs/SPEC.md` §8 is a proper failure-mode table.                                                                                       |
| git init + commit as you go; branches for risky ideas                   | ⚠️ Partial   | 17 well-described commits, but **everything is on `master`** — no branches were used for the "risky ideas" (ownership dedup, chunking). |
| Save intermediates, resumable                                           | ✅           | Hash-keyed `Intermediates` class; every stage caches.                                                                                   |
| Diarization level 3 (identification)                                    | ✅           | LLM diarize + voice-anchored identify pass; verified on real files.                                                                     |
| Preprocess (downsample, keyframes)                                      | ✅           | 16k mono mp3 + keyframes; 9.6GB→14.6MB in ~3s.                                                                                          |
| Security: keys from env or injected                                     | ✅           | Both paths supported everywhere.                                                                                                        |
| Timestamp alignment (coarse→close, fuzzy)                               | ✅           | Needleman–Wunsch token alignment — the centerpiece.                                                                                     |
| SRT breaking (readable, not too thick)                                  | ✅           | Sub-segmentation on sentence/gap/length caps.                                                                                           |
| Browser + npx packaging                                                 | ✅           | Both shipped; browser path verified end-to-end via a shim.                                                                              |
| Avoid subagents except for review                                       | ✅           | Used one review subagent, verified its findings, **rejected one** — exactly as instructed.                                              |
| Measure, don't vibe; read the transcripts                               | ✅           | `core/eval.ts` (WER + speaker + boundary) and documented manual reading.                                                                |

**Where it under-delivered vs its own SPEC** (the README is honest; the SPEC over-promises):

- SPEC §9 advertises `passes?: number` (refinement passes) and "Stoppable → returns best-so-far." **Neither exists** — there is no `passes` option and no `AbortSignal`/stop path. (Grep confirms no abort/passes anywhere in `src`.)
- SPEC §6 says identify uses "a pass with the _whole_ transcript + best example turns." The implementation (`core/identify.ts`) sends **only** per-label example turns + a voice hint, **not** the whole transcript. This is cheaper and works, but it means a self-identification ("my name's Rishi") that appears only in a short turn could be missed by identify (it's caught by the inline diarize naming instead).
- A "describe/context pass" (offmute-style global description) is plumbed through prompts (`description?` field) but **never produced or passed** by either pipeline.

---

## 2. Architecture

The core thesis is sound and well-separated into three "tracks that get fused":

```57:67:src/types.ts
export interface LlmLine {
  /** speaker as the LLM sees it — a name ("Hrishi") or anonymous ("Speaker 1") */
  speaker: string;
  text: string;
  /** optional tone/emotion annotation, e.g. "hesitant", "laughing" */
  tone?: string;
  /** rough start (seconds, absolute) if the LLM provided one — NOT authoritative */
  approxStart?: number;
```

The standout design decisions:

- **LLM owns content/diarization/identity/tone; ASR owns time; alignment marries them.** "Never trust LLM timestamps; never trust ASR diarization as authority" is a genuinely good principle, and the code honors it.
- **Plain-text LLM output over JSON**, with a lenient parser — chosen _because_ truncated text degrades gracefully where truncated JSON is unrecoverable. This is the ipgu lesson applied well (`core/prompts.ts` header comment).
- **Chunk overlap = ownership partitioning** (`chunkOwnership`): each segment is emitted by the chunk owning its center time, so every word appears exactly once. The fuzzy time+text dedup (`mergeChunkSegments`) is kept only as a safety net. This is the cleanest part of the design and the process log honestly documents the bug they hit (content loss) and how the prompt change fixed it.
- **Voice-anchored speaker canonicalization**: `asrSpeakerByLabel` maps each LLM label to its dominant ASR voice cluster, which becomes a strong merge hint for the identify pass and reconciles labels across chunks. Elegant.
- **Pure fusion core** (`core/assemble.ts`, `align.ts`, `chunk.ts`, etc.) shared by Node and browser. Good.

---

## 3. Code quality — conventions & readability

**Very good overall.** Consistent style, `node:` import prefixes, ESM throughout, descriptive names. Every module has a top "why" docblock, and comments are reserved for non-obvious intent (e.g. the `bothMatched` gap-split rationale in `align.ts`, the chunk-relative→absolute `approxStart` note in `pipeline.ts`). This matches the project's own "comments explain intent, not narration" preference.

Strict compiler settings are real and respected: `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. The pervasive `!`/`?? ` usage is a direct consequence of `noUncheckedIndexedAccess` and is used carefully.

Nits:

- `align.ts:34-41` claims a **"Hirschberg-free banded variant"** — there is **no banding**; it's full O(n·m) DP with flat typed arrays. The comment is misleading (see §6).
- A few very long lines in the orchestrators (e.g. the `parts` construction and progress strings) hurt scannability.
- `index.ts` uses `export *` broadly, which makes the public surface implicit and easy to balloon.

---

## 4. Correctness & testing

- **30/30 unit tests pass**; `tsc --noEmit` clean. Tests are well-chosen: SRT round-trip with ms-carry edge cases, alignment with sub/ins/del, monotonic interpolation, parse-diarized continuations, eval WER + optimal speaker mapping, and a dedicated `fixes.test.ts` capturing each review finding as a regression (chunk overlap clamp, ownership partition, cross- vs same-chunk dedup, non-finite time guard, timecode-prefix rejection).
- **Coverage gap:** the orchestrators (`pipeline.ts`, `browser-pipeline.ts`) and the providers have **no automated tests** — they're validated only by the manual `scripts/*` against live APIs. Understandable (needs keys), but the chunk-loop + ownership-filter glue (the part most likely to regress) is only indirectly covered by `chunk.ts` unit tests.
- **Empirical results are real and reproducible from intermediates.** I confirmed the showcased outputs: `satya-test/identify.json` correctly resolves Announcer/Sarah Guo/Satya Nadella/Elad Gil/swix, and the root `.md` reads cleanly with accurate `[m:ss]` anchors. The talk's first cue aligns to `00:00:00,160` exactly matching ground truth.

---

## 5. Issues found (prioritized)

**Bugs / correctness (low severity, none block the happy path):**

1. **CLI `text` format is advertised but not wired.** `cli.ts:25` help says `srt | md | json | text | all`, but the writer only handles srt/md/json. `-f text` writes nothing yet exits 0.

```54:70:src/cli.ts
      const want = (f: string) => opts.format === "all" || opts.format === f;
      const written: string[] = [];
      if (want("srt")) { ... }
      if (want("md")) { ... }
      if (want("json")) { ... }
```

There's a perfectly good `toText()` in `core/format.ts` that's never reachable from the CLI.

2. **`parse-diarized` can misread a mid-sentence colon as a speaker.** The line regex treats any `<≤40 chars, ≤6 words>:` as a new turn. A wrapped continuation like `the model: it's great` would start a spurious "the model" turn. Rare in practice, but the only guard is the 6-word check.

3. **`alignTokens` memory on long single-pass.** It's full DP: `Int32Array((n+1)*(m+1))` + `Uint8Array(...)`. For a ~35-min single-pass file (~7k LLM tokens × ~6k ASR words) that's ~245MB transient. Chunking caps it in practice (>35min is chunked), but a single-pass near the threshold is heavy, and the "banded" comment implies a bound that isn't there.

**Spec-vs-impl drift (medium — affects trust in docs):** 4. `passes` (refinement) and stoppable/best-so-far are in SPEC §9 but unimplemented. 5. The `description`/context pass is plumbed but never generated. 6. Identify uses example turns, not the whole transcript (SPEC §6 says whole).

**Doc / cleanliness (low):** 7. SPEC says the browser bundle is **32KB**; it's actually **~49KB** (README's "~50KB" is correct). The 32KB figure predates adding the fetch providers + orchestrator to `browser.ts`. 8. The three `YTDown_...Satya...` output files are **committed at the repo root**. They're excluded from the npm tarball (`files: ["dist"]`), but they clutter the repo and aren't covered by `.gitignore` (which only ignores media, not `.md/.srt/.json`). 9. `onProgress`'s `pct` field is defined but only ever set on `done` (100).

**Maintainability smell (medium):** 10. **Orchestration is duplicated** between `pipeline.ts` (Node, paths+SDK) and `browser-pipeline.ts` (bytes+fetch): the chunk loop, `sliceAsrWindow`, `mergeVoiceDist`, ownership filtering, and merge are ~80% identical copies. They DRY'd the _pure_ core but not the _orchestration_, so a future fix to the chunk/merge flow must be made in two places. This is the most likely source of future divergence/bugs.

**Security (informational):** 11. The Gemini fetch client passes the API key as a **URL query param** (`?key=...`) — that's the Google API convention, but keys can leak into request logs/proxies. AssemblyAI correctly uses an auth header. Worth a note in docs.

---

## 6. Strengths worth calling out

- **The process log is a model of how to do this.** It records hypotheses, the empirical results that confirmed/killed them, and the exact "thinking-level eats the output budget → empty response" gotcha that would otherwise cost a future maintainer hours.
- **Honest, measured engineering:** WER/speaker/boundary metrics, "our diarization sometimes beats the ground truth," and a rejected review suggestion with reasoning.
- **Graceful degradation everywhere:** keyframes fail → continue audio-only; identify fails → fall back to raw labels; ASR off → fall back to LLM `approxStart` ordering.
- **Isomorphic providers** (`*-fetch.ts`) that run in both Node 18+ and the browser, keeping the browser bundle SDK-free.

---

# Part 2 — Detailed Guide for a Human Reviewer

This is a step-by-step path to review the whole thing efficiently, in priority order, with what to look for and how to verify claims.

## A. Setup (5 min)

```bash
cd offmute-v2-opus/offmute-v2
bun install            # or npm install
bun test               # expect 30 pass
npx tsc --noEmit       # expect clean
npm run build          # tsup → dist/{index,cli,browser}.js (+ .d.ts)
node dist/cli.js --help
```

Keys for live runs: `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and `ASSEMBLYAI_API_KEY` (see `.env.example`).

A no-key, no-cost end-to-end smoke test of the _fusion core_ (the most important code) is possible because all LLM/ASR intermediates are cached on disk — see step F.

## B. Orientation (15 min) — read in this order

1. `0-starting-instructions.md` — the brief.
2. `intermediates/process_log_...md` — **read this fully.** It's the design rationale and the list of every gotcha. (It lives in the parent `intermediates/`, not in `offmute-v2/`.)
3. `docs/SPEC.md` — the plan and failure-mode table.
4. `README.md` — the user-facing contract.

While reading 3 & 4, keep a list of _claims to verify_ (numbers, bundle size, "stoppable", "passes", "5 speakers auto-identified").

## C. Core logic review (the part that matters most, ~60 min)

Read in dependency order and scrutinize the specific risks noted:

1. `src/types.ts` — the data model (two tracks → fused `Transcript`). Confirm `timingSource`/`alignmentConfidence` provenance.
2. `src/core/align.ts` — **the crux.** Verify the Needleman–Wunsch DP and traceback by hand against `core.test.ts`. _Scrutinize:_ the "banded variant" comment (there's no band — confirm and decide if you care about O(n·m) memory for long single-pass). Check `fillTokenTimes` interpolation (leading/trailing/between anchors) and the "no matches at all" branch.
3. `src/core/assemble.ts` — how aligned tokens become segments; the "drop only short word-less turns (`tokenCount<=3`)" rule and the tone-once-per-turn logic.
4. `src/core/chunk.ts` — `calculateChunks` (overlap clamp to [0,50%]), `chunkOwnership` (midpoint partition), `mergeChunkSegments` (cross-chunk only, time+Jaccard). Cross-check against `fixes.test.ts`.
5. `src/core/parse-diarized.ts` — _scrutinize_ the LINE_RE: try to break it with a wrapped line containing a colon.
6. `src/core/identify.ts` — the LLM merge prompt + lenient JSON parse. Note it does **not** send the whole transcript; decide if that matters for your inputs.
7. `src/core/speakers.ts`, `srt.ts`, `format.ts`, `time.ts`, `eval.ts` — formatters and metrics. In `eval.ts`, note the documented caveat: boundary error (real cue starts) is the trustworthy timing signal; per-word time error is inflated by interpolation inside long cues.

## D. Orchestration & providers (~40 min)

8. `src/pipeline.ts` — the Node orchestrator. Trace one chunked run mentally: probe → audio → ASR (whole-file) → per-chunk diarize → align to windowed ASR words → ownership filter → merge → identify → format. _Scrutinize:_ the window pad (`±2s`), `sliceAsrWindow` (relative offsets for the hint), and that single-pass goes through the same loop with 1 chunk.
9. `src/browser-pipeline.ts` — **diff it against `pipeline.ts`.** This is where duplication lives; confirm the two stay logically in sync (chunk loop, ownership, merge). Any future bug fix must touch both.
10. `src/providers/gemini.ts` + `gemini-fetch.ts` — confirm `thinkingLevel` (3.x) vs `thinkingBudget` (2.5) handling and `maxOutputTokens=65536`. Note key-in-URL for the fetch client. Check upload→poll→cleanup.
11. `src/providers/assemblyai.ts` + `assemblyai-fetch.ts` — ms→s conversion, `diarized` flag.
12. `src/media/ffmpeg.ts` + `ffmpeg-wasm.ts` — spawn args (`-ss` before `-i`), 16k mono, keyframe scaling.
13. `src/core/retry.ts` — transient classification + backoff; used by both SDK and fetch paths.
14. `src/cli.ts` — _confirm the `text` format gap_ (advertised, not written).

## E. Packaging (~15 min)

- `package.json` exports (`.` and `./browser`), optional `@ffmpeg/*` peer deps, `files: ["dist"]`.
- `tsup.config.ts` — two builds (node platform vs browser platform).
- `dist/browser.js` size: `wc -c dist/browser.js` → ~49KB (note SPEC says 32KB).
- `examples/browser/index.html` (CDN ffmpeg.wasm single-thread, no COOP/COEP) and `docs/BROWSER.md`.

## F. Verify the quality claims (the most important review step)

The brief stresses _reading the transcripts_. Do it:

- Open `intermediates/satya-test/identify.json` and the root `YTDown_...Satya....md`. Confirm the 5 speakers are correctly named and the text reads cleanly. This is the "generalizes to unseen input" proof.
- Open `intermediates/talk-video-test/transcript.srt` and diff against ground truth `test-files/1/talk-with-questions.srt`. Check: first cue at `00:00:00,160`; sub-segmented cues are readable; speaker attribution. Note the documented ambiguous first turn (Hrishi vs Audience).
- If you have keys, reproduce the headline number:

```bash
bun run scripts/test-pipeline-eval.ts   # WER / speaker / boundary vs ground truth
```

Re-running is cheap because intermediates are cached; delete `intermediates/*/` or pass `--no-cache` to force fresh.

- Beware one trap: `intermediates/p-test/identify.json` is a **degenerate older experiment** (2 generic speakers, garbled descriptions) — don't mistake it for the showcased result; `satya-test` is the real one.

## G. Reviewer checklist (sign-off)

- [ ] `bun test` 30/30, `tsc` clean, `tsup` builds 3 bundles.
- [ ] Alignment DP verified against tests; memory ceiling acceptable for your max single-pass length.
- [ ] Chunk ownership + merge logic understood; node vs browser pipelines agree.
- [ ] Read the Satya `.md` and the talk SRT vs ground truth — quality is real.
- [ ] Confirmed the known gaps (CLI `text` unwired; `passes`/stoppable/description unimplemented; SPEC 32KB stale; root sample outputs committed).
- [ ] Decided whether orchestration duplication needs DRYing before 1.0.

## H. Suggested small follow-ups (if you want a punch list)

1. Wire `-f text` (call `toText`) or drop it from CLI help.
2. Extract the shared chunk/diarize/align/merge loop into a provider-agnostic helper to de-duplicate the two pipelines.
3. Fix the `align.ts` "banded" comment (or actually band/Hirschberg it for long single-pass safety).
4. Reconcile SPEC with reality: remove/implement `passes` & stoppable; update bundle size; note identify uses samples not whole transcript.
5. `.gitignore` the generated `*.srt/.md/.json` sample outputs at the repo root (or move to `examples/`).
6. Document the Gemini key-in-URL caveat.

Overall: a thoughtful, well-tested, well-documented system that delivers on the brief's central bet. The cleanups above are polish, not rescue.
