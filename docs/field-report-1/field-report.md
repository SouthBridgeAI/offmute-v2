# Field Report 1: 11 real recordings, 13.1 hours

A user's batch run of `offmute-v2@0.1.1` on defaults (`gemini-3.1-pro-preview` + AssemblyAI universal; naming fell back to `gemini-flash-latest` + `gpt-4o-mini` with no DeepSeek key). The recordings were real meetings: cafés, an office, 1:1 working sessions, 16 min to 2h15m each. They're referred to here as **R1–R11**; no participant's speech is quoted. The only quotes are text the model _invented_.

|     | setting             | length  |     |     | setting             | length  |
| --- | ------------------- | ------- | --- | --- | ------------------- | ------- |
| R1  | café meeting        | 2:15:34 |     | R7  | 1:1 working session | 1:05:14 |
| R2  | office meeting      | 46:45   |     | R8  | 1:1 working session | 1:29:20 |
| R3  | café meeting        | 1:31:55 |     | R9  | 1:1 working session | 16:31   |
| R4  | 1:1 working session | 47:44   |     | R10 | 1:1 working session | 32:57   |
| R5  | 1:1 working session | 1:09:36 |     | R11 | café meeting        | 2:06:24 |
| R6  | 1:1 working session | 1:03:55 |     |     |                     |         |

Every run reported success. Two were silently wrong:

- **R1:** a fabricated conversation (**§1**)
- **R2:** the final 9 minutes lost (**§2**)

Each root cause below was confirmed in code and **reproduced offline from the runs' own intermediates**. `llm-calls.jsonl` keeps every raw Gemini response, so each chunk can be replayed exactly through the pipeline stages. Every fix was then replayed against all **103 real 10-minute chunks** from the batch, and the network paths were tested live.

| #   | Issue                                                                                  | Status     |
| --- | -------------------------------------------------------------------------------------- | ---------- |
| 1   | Fabricated transcript over faint background speech passes validation                   | **FIXED**  |
| 2   | Speech after the last segment is never gap-filled (truncated final chunk → 9 min lost) | **FIXED**  |
| 3   | Alignment stretches segments over holes, hiding them from gap-fill                     | **FIXED**  |
| 4   | Non-streaming Gemini calls die at Node's 300s fetch limit                              | **FIXED**  |
| 5   | A naming-only option change (`--reasoner`) re-transcribes everything                   | **FIXED**  |
| 6   | Receipt (and lifetime stats) bill ASR on cache hits                                    | **FIXED**  |
| 7   | Validation false alarms on quiet chunks                                                | suggestion |
| 8   | Fallback judge pair swaps names                                                        | suggestion |
| —   | Observations                                                                           | §9         |

---

## 1. Fabricated transcript over faint background speech → FIXED

### What happened

In R1 (café, 2h15m), for the first ~35 minutes the user sits alone waiting, while strangers at the next table hold a meeting. AssemblyAI heard them faintly: ~30 words/min at confidence 0.75–0.86, against ~95 words/min at 0.94 in normal chunks. Gemini returned a conversation that never happened, credited to the user and the person they were meeting:

> _"We need to stand out in the market. So, what do you think the key message should be?"_ · _"we can use some customer testimonials to back it up"_ · _"Let's touch base on this again next week."_ · _"Alright, let's wrap it up then. Thanks, everyone."_
> _"Bye. See ya. Take care. You too. Bye. Bye. See ya. Take care. You too. Bye…"_

Per-chunk **grounding** (share of the LLM's content words that ASR heard in the same time range): **0.22, 0.26, 0.05** for chunks 1–3, against **0.80–0.95** for typical legitimate chunks. Chunk 1 also hit `fetch failed` three times in a row (§4).

### Root cause

- `validate()` (`src/transcribe/llm-transcribe.ts`) checks only structure: ≥3 segments, spanning ≥60% of the chunk. Fabricated text passes both.
- Nothing downstream compares the LLM's text with what ASR heard.
- It wasn't a cascade through `previousTail`: the three chunks ran in the same `mapPool` wave with no previous-chunk context.

### Fix

- **`src/transcribe/degeneration.ts`:** repetition-loop detection. Same idea as Whisper's compression-ratio check (text that compresses too well is a loop, not speech), computed over sliding 400-character windows.
  - It's a **pure-JS LZ77 ratio**, not zlib, because `llm-transcribe.ts` is reachable from the browser bundle, which must not gain a `zlib` import.
  - The browser bundle's Node imports are unchanged (`fs`, `path`).
- **`validate()`:** a loop is invalid however much of the chunk it spans.
- **Streaming guard:** `transcribeChunk` passes `shouldAbort` to the (now streaming) Gemini call and aborts once the spoken text has looped for two consecutive windows. That avoids paying for a 65k-token runaway. The guard reads the transcript JSON's `"text"` values, **including the final one that hasn't closed yet**; see Verification for why.
- **Temperature fallback** (as Whisper does): a retry after a loop samples hotter, 0.2 → 0.5 → 0.8.
- **`src/transcribe/grounding.ts`:** a chunk whose content words are mostly unheard by ASR (precision < 0.3) is _ungrounded_. No verdict is given with <30 content tokens on either side, or when the two sides are in different scripts (see §9 for why).
- **Pipeline step 4.5:** loop and ungrounded chunks are **dropped before alignment**, and gap-fill refills their range with what ASR actually heard.
  - The check is recomputed from segment text, so caches written by 0.1.1 are covered on re-run.
  - It only applies when ASR words exist to fall back on.

### Verification

- **Calibration, 103 real chunks** (LZ ratio, max over windows): legitimate **≤ 1.73**; the three fabrications **2.72 / 6.45 / 8.16**; threshold **2.2**.
- **Replay:** exactly R1 chunks 1–3 are dropped, and **0 of the other 100**. R1's 9:00–37:00 range then holds 1,462 words of ASR text instead of the fabrication (§3 was needed for this).
- **Live**, the same R1 chunk audio through the fixed `transcribeChunk`:
  - **Run 1:** the model ran away for **12 minutes inside a single segment's `"text"` string** (145,232 characters; the JSON broke at character 154,138). The first version of the guard only read _completed_ string values and never saw it. It now reads the unterminated value too, and a test reproduces that exact shape (it fails on the old reader).
  - Same run, attempt 2: at the fallback temperature (0.5) the output came back clean in **64s** (LZ 1.32, grounding 0.37).
  - **Run 2:** clean on the first attempt (56s, LZ 1.38, grounding 0.33).
- **Tests:** `tests/degeneration.test.ts`, `tests/grounding.test.ts`, `tests/transcribe-chunk.test.ts` (retry keeps the clean attempt; an all-loop chunk is flagged `degenerate`).

**Note on margins.** Repetition is the primary defense: it alone catches all three fabrications, with ~25% headroom each side of the threshold. Grounding is a deliberately conservative backstop. Faint _real_ speech scored 0.33 in live run 2, against 0.26 for the worst fabrication, so its margin is thin.

---

## 2. Speech after the last segment is never gap-filled → FIXED

### What happened

In R2 (office meeting, 46:45) the transcript ended at 37:24. The final chunk (36:00–46:45) came back covering 72 seconds and closed with a goodbye the model invented (_"Yeah, see you."_). The audio stays at conversation level (−27 to −30 dB) to the end, and ASR heard **1,443 words** there. None reached the output.

### Root cause

`fillAsrGaps` (`src/align/fill-gaps.ts`) builds uncovered ranges _before the first_ and _between_ segments, but deliberately **not after the last**: _"trailing silence isn't dropped content."_ The fill only fires where ASR found words, though, and silence has none. So a truncated **final** chunk loses everything after its last line.

### Fix

- A **trailing range** after the last segment.
- Coverage measured against the **running max end**, so a short segment nested inside a long one can't open a phantom gap. (Replay on R6: the old code re-inserted 22 words that the covering segment's text already contained.)
- Recovered speech is emitted **one segment per ASR utterance**, so a long recovered range keeps its speaker turns instead of becoming one monologue.

### Verification

Replaying R2's exact original Gemini output: ASR words after the last segment, **1,377 → 0**, recovered as 60 turn-by-turn segments. Tests in `tests/fill-gaps.test.ts` cover the trailing range, turn splitting, and no phantom gap.

---

## 3. Alignment stretches segments over holes → FIXED

### What happened

Found while verifying §1. With R1's fabricated chunks dropped, the last lines of chunk 0 (heard at ~8:42–9:10) were stretched to span **9:52–15:51** and **17:51–23:01**. The stretched segments covered the hole, so gap-fill couldn't reach it: only 253 of ~1,500 ASR words came back. The same mechanism produced small **chunk-seam drops** elsewhere (e.g. R5 at ~10:00).

### Root cause

One global edit-distance pass aligns the whole recording (`src/align/aligner.ts`, `src/align/edit-distance.ts`). A substitution costs the same as one indel, and nothing bounds _how far in time_ a token may match. So a token can latch onto a common word minutes away at no extra cost, and a segment's span (first-to-last matched token) stretches.

### Fix

**A token may only match ASR words from the chunk of audio it was transcribed from.** That's a hard fact (the model only heard that audio), so the rule has no false positives.

- `tagWith` puts `chunkStart`/`chunkEnd` on each segment.
- The aligner gives each token that window (±2s slack).
- `matchCost` makes out-of-window pairs cost more than insert + delete, so the edit-distance pass never picks them.
- Segments without chunk info (e.g. the browser path) are unconstrained, exactly as before.

### Verification

- **R1 after the drop:** recovered words **253 → 1,462**.
- **R5:** a 42-word seam drop is recovered.
- **Side effects across the 12 replayed runs:** 0–12 segments per file move by more than 5s, out of 164–1,418.
- **One disclosed regression:** R2 recovers 46 fewer words net at 37:01–37:21, where the _invented_ goodbye (_"Yeah, see you."_) now aligns to an earlier "yeah" in the same chunk. It's tie-breaking over fabricated text, and a chunk-level window can't prevent it.
- **Test:** `tests/align.test.ts` "no stretching over a hole" fails without the constraint and passes with it.

---

## 4. Non-streaming Gemini calls die at 300s → FIXED

### What happened

Five calls failed with `fetch failed` at ~300s (one R1 chunk three times in a row, 5m03s apart), and each was retried from scratch. Every successful call finished in ≤134s.

### Root cause

`generateContent` (`src/providers/gemini.ts`) sends no response headers until generation finishes. Node's fetch (undici) fails any request whose headers take longer than 300s. Combined with `maxOutputTokens: 65536`, a slow or runaway generation can't finish in time.

### Fix

- `generateContentStream`, so the connection never sits silent.
- An optional `shouldAbort(textSoFar)` hook (used by §1). An abort returns immediately with `aborted: <reason>` and is **not** retried inside `generate()`, because an identical request would likely loop again; the caller retries hotter.
- Usage is logged for aborted calls too, since those streamed tokens were paid for.

### Verification

Live run of the fixed CLI on a 16-minute recording: every Gemini call streamed, with real token counts captured from the stream (38.1k in / 13.4k out, matching the original run).

**Caveat:** streaming alone would make runaways _more_ expensive, since they'd run to 65k tokens instead of dying at 300s. The §1 guard is what bounds them.

---

## 5. `--reasoner` alone re-transcribes everything → FIXED

### What happened

To fix names on three 1–1.5h recordings, the user re-ran with only `--reasoner claude-sonnet-4-5`. The tool logged _"options changed since last run — discarding cached intermediates"_ and started full re-transcriptions. They were stopped after ~2 minutes, with **$1.51** of Gemini calls already completed.

### Root cause

`configSignature` (`src/core/config.ts`) includes `reasoner` and `knownSpeakers`. That contradicts the pipeline's own stated intent (_"switching --identify mode or the reasoners invalidates just this stage, not the (expensive) transcription cache"_). The identify stage's own cache key (`idConfig`) lacked `knownSpeakers`.

### Fix

`reasoner` and `knownSpeakers` come out of `configSignature`, and `knownSpeakers` goes into `idConfig`. `--speakers` still re-runs naming, and only naming. Test in `tests/fixes-master.test.ts`.

**Upgrade note:** the signature's contents changed, so each existing cache is invalidated once, on its first run after upgrading.

---

## 6. Receipt bills ASR on cache hits → FIXED

### What happened

A re-run's receipt said `assemblyai: 47min · $0.12`; the log said `[assemblyai] cache hit`.

### Root cause

`computeReceipt` (`src/core/pricing.ts`) charges ASR from duration alone. The same phantom charge goes into `~/.offmute` lifetime stats.

### Fix

- `AssemblyAIProvider.lastFromCache`.
- The pipeline tracks `asrBilled` (a fresh Groq, ElevenLabs, or AssemblyAI call).
- `computeReceipt(…, asrBilled)` bills only then.

### Verification

Live: `assemblyai: 17min · cached · $0.00`, where 0.1.1 charged $0.04 for the same cache hit. Test in `tests/pricing.test.ts`.

---

## 7. Validation false alarms on quiet chunks → suggestion

Four of the six chunks that "failed validation" were fine: walking before or after a meeting (two), a 5-minute break in a call (−42 dB), and a near miss (352s against 360s). Each costs a retry and prints an `ERROR`. The span rule can't tell _truncated_ from _nobody spoke_: R2 (a real truncation) and R7 (music) looked identical to it.

**Suggestion:** run ASR **concurrently** with the LLM chunks (they only need the same audio), then judge span against where ASR heard speech. That also hides ASR latency.

## 8. Fallback judges swap names → suggestion

Three of 11 runs came back as `Speaker A/B` because the two judges returned **exact swaps**. Offmute's rule (keep generic labels on disagreement) worked as designed. In all three the first judge (`gemini-flash-latest`) was right; that was checked against self-descriptions and languages mentioned in the transcripts. The swaps came from the fallback second judge, `gpt-4o-mini`, which `resolveSecondReasoner` picks when no DeepSeek key is set. It may be worth ordering fallback judges by strength, or warning when the pair is weak.

## 9. Observations (unchanged)

- **Trailing fill vs. music.** §2's trailing range also recovers what ASR transcribed after a meeting ended. For R7 that's 213 words of **song lyrics**, which were previously skipped.
  - ASR confidence doesn't separate lyrics from speech (0.93 vs 0.96), and ASR credited most lyrics to the conversation's own voice clusters.
  - Only density does (0.39 vs 2.5 words/sec), and that's one example per side, so it isn't encoded.
  - Visible, removable noise beats silently losing 9 minutes. A speech/music check is a good follow-up.
- **ASR script mismatch.** AssemblyAI transcribed a personal phone call in Malayalam as Chinese characters; Gemini's romanized Malayalam was correct. No output impact, but it's why `chunkGrounding` gives no verdict when the two sides' scripts differ.
- **Talk times are computed pre-finalize** (`consistency.ts`), so text that finalize trims still counts. A speaker can also be listed with **zero lines**, because speakers are filtered by consistency-stage talk time, not final segments.
- **Aligner memory** is O(N×M) Int32: roughly 0.9 GB estimated for a 2h15m file. With §3's windows, a banded DP would cut it by about the number of chunks.
- `src/index.ts` exports the legacy `identifySpeakers`; the pipeline uses `identifySpeakersV2`.

## Corrections made during the investigation

- R2's loss was first attributed to alignment stretching. The replay showed it was §2's trailing gap; stretching (§3) is real but separate.
- The first streaming guard only read completed JSON strings, and a live run looped inside one unterminated string (§1). Fixed, with a regression test.

## Verification summary

- `npm test`: 103 passed, 15 files (up from 82 in 12 on `master`: 21 new tests, 3 new files).
- `npm run typecheck`, `npm run lint`, `prettier --check`: clean.
- `npm run build`: all targets. The browser bundle's Node imports are unchanged (`fs`, `path`).
- **Offline replays** of all 103 real chunks through the fixed stages: §1–§3 numbers above.
- **Live runs:** CLI smoke test on a 16-minute recording (streaming, cached-ASR receipt); two re-transcriptions of the fabricated R1 chunk (guard bug found and fixed; temperature fallback clean).

## Calibration data (103 real chunks)

| signal                                    | 3 fabricated       | 100 legitimate                        | used                                                   |
| ----------------------------------------- | ------------------ | ------------------------------------- | ------------------------------------------------------ |
| LZ77 ratio (max over 400-char windows)    | 2.72 · 6.45 · 8.16 | ≤ 1.73                                | threshold 2.2                                          |
| zlib ratio (Whisper's measure)            | 3.13 · 3.39 · 5.80 | ≤ 2.20                                | not used (would add `node:zlib` to the browser bundle) |
| distinct word trigrams per 60-word window | 0.19 · 0.22 · 0.62 | ≥ 0.69                                | rejected: margin too thin                              |
| grounding precision vs ASR                | 0.05 · 0.22 · 0.26 | ≥ 0.37 (live faint real speech: 0.33) | backstop, threshold 0.3                                |
