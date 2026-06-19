# Review 2 — responses & fixes

Review 2 was a **code read** (everything was functional by then), so it's mostly
"explain this" with a handful of "fix this." Below, each item from `human-review.md`
is cleaned up into a note, then answered: things to fix are fixed (with *why it
happened* and *what I did*); things to explain are explained.

| # | Item | Kind | Status |
|---|------|------|--------|
| 1 | Test files committed? | hygiene | verified clean |
| 2 | `aliases` is the wrong word | rename | fixed |
| 3 | Want to inspect every LLM call (prompt/response) + raw vs parsed | feature | fixed |
| 4 | Identify uses lenient JSON parsing — is there a JSON mode? | improve | fixed (JSON mode) |
| 5 | An `AbortController` would've been nice | feature | fixed |
| 6 | More try/catch so we know *what failed where* | improve | fixed (stage-tagged errors) |
| 7 | Do we test that SRT/markdown is always valid? | tests | fixed (+ found a real bug) |
| 8 | Browser demo: "Workers can't be accessed from here" | bug | fixed (blobify worker) |
| 9 | align.ts is core — wants links / more explanation | docs | fixed |
| 10 | Why both `words` and `utterances`? | explain | below |
| 11 | Why is `AsrUtterance.words` optional? optional/generics use? | explain | below |
| 12 | How is `tone` parsed? | explain | below |
| 13 | What does `buildVoiceHint` / the `Math.round(... %)` do? | explain | below |
| 14 | Pipeline uses the intermediate folder as state | explain (design) | below |
| 15 | `maxOutputTokens` — newer models have more | explain | below |

---

## Fixes

### 1. Test files committed?

> "Look at our test files — if they happen to be committed, we need to clear up."

**Verified clean.** Nothing heavy is tracked: `git ls-files` is 51 files — source, scripts,
docs, config — no `.mov/.mp4/.m4a/.mp3`, no `dist/`, no `node_modules/`. The test media
lives *outside* the repo (in the workspace `../test-files/`), and `.gitignore` covers all
media extensions, so it was never at risk. `.git` is 2 MB.

### 2. `aliases` is the wrong term

> "`aliases` isn't quite right — you're going from *unidentified* to *identified*. Aliases
> would fit if you had different spellings of the same group. Very forgivable, though."

**Why it happened:** I named the identify-pass output `aliases` thinking of it as
"label → canonical label." But it's really *resolution* (a provisional `"Speaker 1"` → the
identified `"Rishi"`), not aliasing.

**Fix:** renamed `aliases` → **`resolvedNames`** everywhere (`identify.ts`, `speakers.ts`,
`assemble.ts`, both pipelines) and reworded the comments. Tests green.

### 3. Inspect every LLM call + raw vs parsed output

> "I want to see the actual LLM calls — every single one — so I can inspect the prompts and
> what comes back. Add an option and just log them. I also want to see, in the
> intermediates, the *raw* LLM output and then the *parsed* output."

**Why it was missing:** only the diarization *response* (`diarize.txt`) was saved. The
prompt, the identify call, and the parsed form weren't — so you couldn't see what was sent
or how it was interpreted.

**Fix:** added an `onCall` hook on `GeminiClient`/`GeminiFetchClient` (the single chokepoint
every call goes through) carrying `{label, model, promptText, responseText, usage}`. The
pipeline:
- writes **every** call to `intermediates/llm/NN-<label>.{prompt,response,meta}` (e.g.
  `00-diarize.prompt.txt`, `01-identify.response.txt`) — toggle with `logLlm`,
- exposes `onLlmCall?(rec)` for programmatic inspection,
- saves the **parsed** turns as `diarize.parsed.json` next to the raw `diarize.txt`.

So raw → parsed is now visible, and you can read the exact prompt + response of each call.

### 4. Identify pass — JSON mode instead of lenient parsing?

> "We don't ask it to respond in fenced code blocks… is there not a JSON mode we can use?"

**Context / why I'd avoided it:** the *diarization* pass emits a long transcript as plain
text on purpose — long structured (JSON) output can truncate into an unparseable blob,
whereas text degrades gracefully (you lose the tail, not the whole parse). I carried that
caution to the identify pass too — but identify's output is **small and bounded** (a short
speaker list), so JSON mode is safe and strictly more robust there.

**Fix:** the identify pass now uses **structured-output (JSON) mode** via `responseSchema`
(`IDENTIFY_SCHEMA`), so the model is constrained to valid JSON — no fences/prose to strip.
The lenient parser stays as a fallback for any model that ignores the schema. (The long
diarization pass keeps text, for the truncation reason above.)

### 5. AbortController

> "An abort controller would have been nice to have."

**Fix:** `transcribe()` and `transcribeInBrowser()` now accept `signal?: AbortSignal`.
Cancellation is cooperative — checked at stage and per-chunk boundaries — so it stops
between stages/chunks rather than mid-HTTP-call. Verified: an already-aborted signal throws
`AbortError` before any work runs.

### 6. More try/catch — know *what failed where*

> "I'd have liked more try/catch and exceptions thrown back so we know what failed where."

**Directly motivated by this review:** while testing, AssemblyAI had a transient DNS
failure and the CLI printed a bare `✗ Unable to connect. Is the computer able to access the
url?` — with no hint that **ASR** was the culprit.

**Fix:** a `stage(name, fn)` wrapper tags any thrown error with its stage and preserves the
original as `cause`. That same failure now reads `✗ [asr] Unable to connect…`. ASR,
diarize (per chunk), and identify are wrapped; the CLI surfaces the tagged message.

### 7. Do we test that the output is always valid?

> "Are our tests checking that the SRT is parsable? No — they're tied to specific files.
> Behavioral tests that we *always* produce valid SRT / markdown would be useful."

**You were right, and it surfaced a real bug.** A segment whose text contained a **blank
line** would split one SRT cue into several (SRT separates cues by blank lines), silently
corrupting the file.

**Fix:** `toSRT` now sanitizes cue text (collapse internal blank lines, trim) and clamps
`end ≥ start`, so output is always valid. Added 6 **property/behavioral tests** that run an
adversarial transcript (empty text, blank lines, unicode/emoji, a colon, `end < start`,
zero-duration) through `toSRT` and assert it parses back to the same cue count with valid,
monotonic timing lines — plus markdown-structure checks. (34 → 40 tests.)

### 8. Browser demo — "Workers can't be accessed from here"

> "Examples/browser is a really nice touch… but there's a worker error. I think you need to
> blobify it."

**Why it happened:** `@ffmpeg/ffmpeg` spawns a Web Worker. Loaded from a CDN, that worker
URL is cross-origin, and browsers refuse to start a cross-origin worker.

**Fix (exactly your suggestion):** fetch the worker, core, and wasm and hand ffmpeg
**blob:** URLs via `toBlobURL` — crucially including `classWorkerURL` (the worker), which
the demo previously didn't blobify. All three are now same-origin blob URLs, so the worker
loads.

### 9. align.ts deserves more explanation

> "Needleman–Wunsch is a fine choice… but this is core, maintainable-by-anyone code — links
> and a bit more line-by-line explanation would help. (And the Opus auto-review noted you
> *could* have done banding/Hirschberg, which you didn't.)"

**Fix:** expanded the `alignTokens` docstring with a reference link and a plain-English
walkthrough of the three steps (seed row/col with gap penalties → fill each cell as the best
of diagonal/up/left → trace the backpointers), plus the meaning of each move and the
tie-break. On banding/Hirschberg: still intentionally not implemented — alignment runs
**per chunk** (a few thousand tokens ⇒ tens of MB), so full O(n·m) is fine; the docstring
now says this explicitly rather than implying an optimization that isn't there (a comment
bug already corrected in review 1).

---

## Explanations

### 10. Why both `words` and `utterances` when utterances contain words?

They serve two different consumers, and AssemblyAI returns both for free:

- **`words`** (flat, every word with `start/end/speaker`) is the **alignment substrate** —
  the LLM token stream is aligned against this ungrouped word sequence to read timings.
  Alignment wants the whole stream, not speaker-grouped chunks.
- **`utterances`** (speaker-grouped turns) is the **human-readable / prompt view** — it
  builds the compact "ASR hint" (`[mm:ss] A: …`) handed to the diarization LLM, and is what
  you'd render if you wanted AssemblyAI's own diarization.

So they're not redundant — one is for the alignment algorithm, the other for prompting and
display. I should add a one-line comment on the type saying this; good catch.

### 11. Why is `AsrUtterance.words` optional? (and: optional/generics overall)

- **`AsrUtterance.words?`** is optional because we **don't rely on it** — alignment uses the
  top-level `AsrResult.words`. Per-utterance word lists are a provider convenience that not
  every provider/config populates; marking it required would be a promise we don't keep and
  don't need. The top-level `words`/`utterances` arrays *are* required (the invariants).
- **Optionality generally** marks provider-variable data: `confidence`, `speaker`,
  `language` are optional (not every provider returns them); `text/start/end` are required.
- **Generics:** intentionally sparse. The domain is concrete (`TimedWord`, `AsrUtterance`,
  `TranscriptSegment`), so generics would add ceremony with no payoff. The one place a
  generic earns its keep is the intermediates cache (`cachedJSON<T>` / `readJSON<T>`), which
  is generic. So: generics where they pay, avoided where they don't.

### 12. How is `tone` parsed?

The LLM emits `[mm:ss] Speaker: (tone) text`. `parseDiarizedText` runs one lenient regex
per line with a named group: `\((?<tone>[^)]{1,60})\)` immediately after the speaker colon.
If present it's captured onto `LlmLine.tone`; otherwise undefined. It's a **pass-through
annotation** — we don't interpret it, the model decides what's notable (`laughing`,
`hesitant`, …). One nuance from earlier: tone is attached only to the **first sub-segment**
of a turn so it shows once, not repeated on every wrapped subtitle line.

### 13. What does `buildVoiceHint` (and `Math.round((100*n)/total)`) do?

It builds the **voice-anchoring** signal for speaker identification. After alignment we know,
for each LLM label, which ASR *voice cluster* (A/B/C…) its words landed in
(`asrSpeakerByLabel`). `buildVoiceHint` turns those counts into percentages —
`Math.round((100*n)/total)` is just count→percent — and formats one line per label, e.g.:

```
"Speaker 1" → voice A=100%
"Rishi"     → voice A=99%, C=1%
```

That line is handed to the identify LLM as a strong merge hint: labels dominated by the same
voice are usually the same person — which is how the provisional `"Speaker 1"` gets merged
into `"Rishi"` even though their *text* looks unrelated.

### 14. The pipeline uses the intermediate folder as state — wouldn't passing data around be safer?

Worth clarifying, because it's half true:

- **Within a single run, data is already passed in memory** — `asr`, `allTurns`, `segments`
  are local variables flowing stage→stage. A mid-run error doesn't lose them to "something
  happening to the folder."
- The intermediates folder is the **durable cache for resume *across* runs** plus a debug
  artifact. Each stage writes its output so a *re-run* (or a resume after Ctrl-C / a crash /
  the transient ASR outage above) skips completed stages instead of repeating minutes of
  ffmpeg + API spend. That's a deliberate trade: disk-backed resumability + inspectability
  over pure in-memory simplicity.
- So the folder isn't the in-run state; it's the persistence/resume layer. Your suggestion
  (load + pass + check at each point) is exactly what happens for the *live* path; the disk
  is the *recovery* path. (Where I agree: a couple of stages could carry richer error
  context — that's fix #6.)

### 15. `maxOutputTokens` — newer models have longer output

True, and not a problem today. `65536` is the current ceiling for the Gemini models we use,
and a full ~30-min transcript (~7k output tokens) sits far under it; longer media is
**chunked** before it could approach the limit. If/when a model exposes a larger output
window, raising this constant is a one-line change that would let single-pass handle longer
files before chunking kicks in. We already pick the max the chosen model allows.

---

## Noted, no change

- **The backpointer** in `alignTokens` — you answered your own question on the read ("oh,
  it's being explained"). It records which of diag/up/left won each cell, for the traceback.
- **README / on-progress callback / overall code quality** — appreciated; no change beyond
  the items above (and the README now also documents `onLlmCall` and `signal`).
- **Batch processing & live partial-output/streaming** (raised more in review 1) remain
  planned, not yet built.
