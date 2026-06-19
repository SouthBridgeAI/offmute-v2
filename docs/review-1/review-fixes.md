# Review 1 — diagnosis & fixes

This walks through every problem from `human-review.md` (the four tagged errors + the
issues buried in the voice notes). For each: **your note** (cleaned up), **the error**,
**dy/dx** (how it actually happened and why it got introduced), and **the fix**.

All fixes are committed and the build (`dist/`) was regenerated — important, because you
ran `node dist/cli.js`, and one fix below had already been written in source but never
rebuilt, so you kept hitting it.

| # | Problem | Severity | Status |
|---|---------|----------|--------|
| 1 | Crashes on audio-only files (keyframe extraction) | **blocker** | fixed + rebuilt |
| 2 | `-m gemini-2.5-pro` → "Thinking level is not supported" | **blocker** | fixed |
| 3 | `-m gemini-3.1-pro-preview` → "Thinking level MINIMAL is not supported" | **blocker** | fixed |
| 4 | Intermediate `.offmute_*` folder lands next to the input, not the output | bug | fixed |
| 5 | Output dir isn't created → would crash at the very end | bug | fixed |
| 6 | Progress timer doesn't live-count (long stages look frozen) | nit | fixed |
| 7 | `align.ts` comment over-claims a "banded Needleman–Wunsch" | doc bug | fixed |
| 8 | "text is not wired up" | code-read note | investigated, no bug |
| 9 | No streaming / stop path / batch | feature gaps | acknowledged below |

---

## 1. Crashes on audio-only files (keyframe extraction)

**Your note:** "We couldn't actually work with anything other than video… we will fail if
you give it [a file] because it looks for a keyframe, which in some ways is an automatic
fail because you can't run it." You hit it on `Packaging 3.m4a` (an audio recording).

**The error:**
```
[0.1s] preprocess: Extracting 16k mono audio · Extracting 8 keyframes
✗ ffmpeg keyframe @191.9s failed: … Output file does not contain any stream
Error opening output files: Invalid argument
```

**dy/dx — how & why.** Two compounding causes:

1. The pipeline auto-detects video with `isVideo = info.hasVideo && VIDEO_EXT.has(ext)`,
   but then computed `useVideo = options.useVideo ?? isVideo`. The CLI passes
   `useVideo: opts.video`, and **commander's `--no-video` flag makes `opts.video` default
   to `true`**. So `options.useVideo` was `true` for every CLI run, `true ?? isVideo`
   short-circuits to `true`, and the careful `isVideo` auto-detection was **never
   consulted**. The pipeline then tried to pull keyframes from a file with no video
   stream, ffmpeg wrote zero streams, and the thrown error killed the whole run.
2. Even setting that aside, keyframe extraction had **no resilience** — any ffmpeg
   failure (a cover-art-only stream, a corrupt frame) aborted the transcription instead
   of degrading to "no keyframes".

Why it was introduced: I built and tested the pipeline as a **library** (passing
`useVideo` explicitly) and via the CLI on `.mov`/`.mp4`. I never ran an **audio file
through the CLI**, so the commander-default interaction with `?? isVideo` was invisible.
And the keyframe step was written assuming video, with no failure path. (The earlier
`p.m4a` test in the prior session surfaced this and I patched the source — but I **didn't
rebuild `dist/`**, so your `node dist/cli.js` run kept hitting the old code. That's the
real reason it persisted.)

**The fix** (`src/pipeline.ts`, `src/cli.ts`, rebuilt `dist/`):
- `useVideo = (options.useVideo ?? isVideo) && info.hasVideo` — never attempt video work
  without an actual video stream, even if the caller/CLI says `useVideo: true`.
- Keyframe extraction is wrapped in `try/catch`; on any failure it logs "Skipping
  keyframes (…)" and continues with audio only.
- Regenerated `dist/` and verified the built `cli.js` no longer attempts keyframes on
  `p.m4a` (now prints just "Extracting 16k mono audio" and completes).

---

## 2 & 3. Model selection 400s on the thinking config

**Your note:** Tried `-m gemini-2.5-pro` ("thinking level is not supported for this
model"), then `-m gemini-3.1-pro-preview` ("thinking level MINIMAL is not supported").
"In terms of pure functional level it does kind of work, but…" — i.e. only the default
flash model worked; choosing another model broke it.

**The errors:**
```
-m gemini-2.5-pro        → 400 "Thinking level is not supported for this model."
-m gemini-3.1-pro-preview → 400 "Thinking level MINIMAL is not supported for this model."
```

**dy/dx — how & why.** The thinking control is **not uniform across the Gemini family**,
and I hard-coded one option for all of them:

- During the build I discovered (the hard way — empty transcripts) that **Gemini 3.x
  flash ignores `thinkingBudget` and over-thinks long audio**, and that
  `thinkingLevel: "MINIMAL"` is what tames it. I then made `MINIMAL` the global default
  and the provider **always** sent `thinkingConfig: { thinkingLevel }`.
- But that generalized a result I'd only validated on **one model family**
  (`gemini-flash-latest`, a 3.x flash). The reality:
  - **Gemini 2.5** uses `thinkingBudget` (an integer). `thinkingLevel` → 400. → **error 2**.
  - **Gemini 3.x *pro*** accepts `thinkingLevel` but **not `MINIMAL`** (needs LOW+). → **error 3**.
  - **Gemini 2.0** has no thinking control at all.

So the default broke every model except the one I tested. Classic over-generalization
from a single data point, made worse by the option being named `thinkingLevel` (which
*looks* universal).

**The fix** (`src/providers/thinking.ts`, used by both the SDK and fetch providers):
- A `resolveThinkingConfig(model, level)` that takes one **semantic** intensity
  (`MINIMAL…HIGH`) and translates it to whatever the target model accepts:
  - `gemini-2.5-*` → `{ thinkingBudget }` (MINIMAL → 0 for flash, 128 for pro since pro
    can't fully disable thinking; LOW/MED/HIGH → 2048/8192/24576).
  - `gemini-2.0-*` → no thinking config.
  - `gemini-3.x` *pro* (incl. `pro-latest`/`pro-preview`) → `{ thinkingLevel }` with
    `MINIMAL` floored to `LOW`.
  - `gemini-3.x` flash / `flash-latest` → `{ thinkingLevel }` as requested.
- A safety net: if a call still 400s with a thinking-config message
  (`isThinkingConfigError`), the provider retries **once with the thinking config
  removed**, so an unanticipated model degrades instead of failing.
- **Verified live**: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3.1-pro-preview`, and
  `gemini-flash-latest` all now succeed (no 400). Unit tests lock the mapping.

> Note: 3.x **pro** models reason harder, so for *long single-pass* audio they can still
> spend a lot on thinking. Chunking (automatic > 35 min) keeps each call small; for short
> clips with pro, that's fine. `gemini-flash-latest` remains the recommended default.

---

## 4. Intermediate folder lands next to the input, not the output

**Your note:** "It creates a `.offmute` folder in the folder outside the main thing…
if I ask it to put all outputs inside `desktop/a folder`, it puts the intermediate folder
on desktop… we create these intermediate folders where the video is, regardless of where
you say the output should be. **That is a clear and present bug.**"

**dy/dx — how & why.** The pipeline default was
`intermediatesDir = options.intermediatesDir ?? join(dirname(input), '.offmute_<base>')`
— i.e. **next to the input file** — and the CLI never set `intermediatesDir`, so it always
defaulted there, ignoring `-o`. I modeled this on the original offmute, which drops
`.offmute_<file>` beside the input. But offmute doesn't have v2's separate `-o` output
directory, so the two conventions collided and I never reconciled them — and I always
tested with `-o .` (output == input dir), where the discrepancy is invisible.

**The fix** (`src/cli.ts`): the CLI now defaults intermediates to **inside the output
dir**: `join(outDir, '.offmute_<base>')`. Outputs and their working files stay together;
nothing is written next to the input. Verified: with `-o /tmp/out`, intermediates land in
`/tmp/out/.offmute_p` and nothing appears next to the input.

---

## 5. Output directory isn't created (would crash at the end)

**Your note:** "If I give it a folder that doesn't exist for the output folder, it doesn't
make it… Is it just going to crash when we get to the end of it? … This is all part of the
instructions — to have graceful failures."

**dy/dx — how & why.** The CLI wrote results with `writeFileSync(join(outDir, …))` but
never `mkdir`'d `outDir`. If the directory didn't exist, every expensive stage would run
(ffmpeg, ASR, the LLM — minutes and real API spend) and only **then** would the final
write throw `ENOENT`. I tested exclusively with existing output dirs, so the missing
fail-fast never showed.

**The fix** (`src/cli.ts`): `mkdirSync(outDir, { recursive: true })` **up front**, with a
clear error and `exit(1)` if it can't be created — so you fail in the first 10ms, not
after the work.

---

## 6. Progress timer doesn't live-count

**Your note:** "It's got this timer counter but it doesn't live count up or anything."
(During the ~84s diarize stage the line just sits there.)

**dy/dx — how & why.** The progress callback printed `[Xs] stage: message` only **at stage
transitions**. Cached stages all fire at ~0s and then the long diarize stage prints once
and goes silent until it finishes — so it reads as frozen. It was a one-line logger; I
never added a live ticker.

**The fix** (`src/cli.ts`): a `setInterval` redraws the current stage line every second
with the live elapsed time (`\r[Xs] stage: msg` + ANSI erase-to-EOL), and starts a fresh
line on each new stage. Long stages now visibly count up.

---

## 7. `align.ts` over-claims a banded Needleman–Wunsch

**Your note (reading the code):** "We're saying it's Needleman one but it's not
necessarily Needleman one."

**dy/dx — how & why.** The algorithm **is** textbook Needleman–Wunsch (global DP: gap-init
row/column, `max(diag±match, up−gap, left−gap)` fill, traceback from (n,m)). But the
docstring claimed *"To bound cost on large inputs we use a Hirschberg-free banded
variant…"* — that banding was considered and **never implemented**; it's always full
O(n·m). An aspirational comment that drifted from the code and was never corrected. So the
*code* is honest NW; the *comment* wasn't.

**The fix** (`src/core/align.ts`): rewrote the comment to describe exactly what's there —
full O(n·m) DP with flat typed-array matrices, **no** banding/Hirschberg, and that
whole-file alignment is kept tractable by running it **per chunk** (not by banding).

---

## 8. "text is not wired up here"

**Your note (reading the code):** "text is not wired up here."

**dy/dx — investigated, no bug found.** Walking the data path: `tokenize()` keeps the
**surface** token, `alignLlmToAsr` carries it on `AlignedToken.surface`, and
`buildSegmentsFromTokens` joins those surfaces into `segment.text` → the output. The
*alignment* deliberately runs on **normalized** tokens (lowercased, punctuation-stripped)
and re-associates the surface text by index — that's by design (you match on normalized
forms, then recover the real text). I couldn't find a place where text is dropped. The
most likely trigger for the note is the inaccurate NW comment in #7 (same function), which
is now fixed. If you were pointing at something specific, point me at the line and I'll
chase it.

---

## 9. Streaming / stop path / batch (feature gaps, not bugs)

**Your notes:** "There's no stop path… the folder is empty until the very, very end…
I don't think it does batch; offmute does batch."

These are honest gaps, called out so they're tracked:

- **Live partial output.** Intermediates *are* written incrementally (you saw the ASR
  JSON, keyframes, media-info appear mid-run), and the hash-keyed cache lets a re-run
  **resume** from completed stages. But the final SRT/MD/JSON are written only at the end,
  and a single-pass diarize produces nothing until its one LLM call returns (~80s). The
  original offmute streams the transcript per chunk; v2 could write a partial transcript
  as chunks/segments complete. → planned enhancement, not yet done.
- **Stop path.** You can Ctrl-C and re-run (cache resumes), but there's no graceful
  "stop now and emit what we have". → planned.
- **Batch.** v2 processes one input per invocation; no glob/folder batch. → planned.

None of these block usage today, but they're the right next round of work.

---

## What I'd watch next

The three blockers (1–3) all share one root cause worth calling out: **I validated each
mechanism on a single configuration and generalized.** Audio-through-CLI, non-flash
models, and a non-existent output dir were all "untested second paths." The fixes above
close them; the durable lesson is to exercise the **matrix** (audio/video × model family ×
new/existing output dir × library/CLI), which the test suite now partially encodes
(thinking-config mapping, chunk ownership, SRT/keyframe edge cases) — 34 tests, all green.
