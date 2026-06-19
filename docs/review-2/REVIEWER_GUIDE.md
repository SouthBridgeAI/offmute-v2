# offmute-v2 — Human Reviewer Guide

A suggested ~60–90 minute path through the whole project, ordered so each step builds context
for the next. Pair this with `docs/REVIEW.md` (the findings) — this doc is _how to look_.

## Step 0 — Orient (10 min, read-only)

1. Read `../0-starting-instructions.md` — the brief.
2. Read `docs/spec.md` — the plan, hypotheses (H1–H6), and the **failure-handling table**
   (§4). This is the contract to grade against.
3. Skim `intermediates/process_log_thoughts_ideas_hypotheses_and_scratch_space.md` — the
   chronological "why". Note the H1–H6 "VERIFIED" entries and the **"Finalize merge — tried &
   reverted"** entry (the author measured a WER regression and backed it out instead of
   shipping it).
4. `git log --oneline` — confirm the commit story matches the log (scaffold → providers →
   aligner → pipeline → packaging → finishing).

## Step 1 — Verify the checks (5 min)

```bash
npm install        # if needed
npm run typecheck  # expect 0 errors
npm run lint       # expect 0 errors, 16 any-warnings
npm test           # expect 27 passing
```

The tests are the fast way to trust the core:

- `tests/align.test.ts` — alignment correctness incl. the no-scatter property
- `tests/consistency.test.ts` — talk-time ordering, ASR-merge, nearest-fallback
- `tests/finalize.test.ts` — overlap/clamp/dedup
- `tests/fill-gaps.test.ts` — gap recovery
- `tests/config.test.ts` — level-3 → identify insertion

## Step 2 — Read the core in dependency order (25 min)

Each file is small and self-documented:

1. `src/core/types.ts` — the `Segment` is the currency; understand
   `timingSource`/`textSource`/`confidence`.
2. `src/core/config.ts` — `resolveKeys` (security model), `resolveOptions` (note the
   level-3→identify splice, ~lines 149–161), `planChunks` (overlap + `trustedStart` +
   short-last-chunk merge).
3. `src/align/normalize.ts` → `edit-distance.ts` → `aligner.ts` — **the heart.** Check:
   - `edit-distance.ts` cost model and consistent tie resolution in the backtrace.
   - `aligner.ts:131` aligns the _flat_ stream (not per-segment) — understand why
     (process log "H3 VERIFIED").
   - `transferTiming` interpolation is **bounded to the same `segIdx`** (~lines 99–106) so
     inserts don't bleed across segment boundaries.
4. `src/align/fill-gaps.ts` — the 0.6 "already-covered" guard (~lines 46–52) preventing
   duplication of words that are merely late, not dropped.
5. `src/diarize/consistency.ts` — `isGenericLabel`, merge-by-specific-label, talk-_duration_
   ordering, and the nearest-utterance fallback (~lines 58–72).
6. `src/finalize/finalize.ts` — `fixOverlaps` (note the shift-next guard against unsorting,
   ~lines 76–82) and `clampAndFix`'s **final re-check** (the ipgu bug fix).
7. `src/finalize/format.ts` — `splitIntoBlocks` for readable SRT.

## Step 3 — Orchestration & providers (15 min)

1. `src/core/pipeline.ts` — trace the 8 stages; confirm each has read-cache / compute /
   write-cache and the `has(passes, …)` gating. **Spot the issues**: hardcoded `timestamped:`
   metadata (line 345); `previousTail` under concurrency (lines 182–191); identify
   double-gate (line 303).
2. `src/providers/gemini.ts` — upload→poll→generate→**cleanup in `finally`** (offmute pattern),
   retry loop, JSON fence stripping.
3. `src/providers/assemblyai.ts` — content-hash caching; note **no retry** (a gap vs spec).
4. `src/providers/openai-compat.ts` + `whisper-groq.ts` — the fetch clients.
5. `src/browser.ts` — confirm it imports only fetch providers + pure core; note the simplified
   single-call flow (no describe/chunk/gap-fill).

## Step 4 — Judge output quality with your own eyes (15 min)

The instructions stressed _actually reading transcripts_. Do it:

1. Open `output/run-p/p.md` (51-min, 2-speaker interview). Check: coherent speaker turns?
   plausible tone tags? monotonic timestamps?
2. Compare a slice of `intermediates/run1/final.json` against
   `../test-files/1/talk-with-questions.srt` (hand-checked ground truth). Look at:
   - The **opening** ("GPU…") — see the gap-fill speaker-attribution issue (REVIEW §5.4).
   - **Interruption boundaries** (audience cutting in ~0:05–0:14) — does diarization switch
     correctly?
3. Reproduce the headline number:

   ```bash
   # scorer expects a TranscriptResult; intermediates/<run>/final.json is a bare Segment[].
   npx tsx scripts/eval.ts output/run-p/p.json     # or any *.json output you have
   ```

   For a bare `final.json` array, the quick independent check is a few lines of plain-JS WER
   (tokenize → word edit-distance) against the reference; this confirmed **86.0%** on `run1`.
   Note: `run2` and `run-p` are _different source files_, so scoring them against
   test-files/1's reference is meaningless (WER >1.0 is expected, not a bug).

## Step 5 — Probe the claims you care about

- **Resumability:** delete one `intermediates/<run>/aligned.json`, rerun with
  `--passes align,consistency,finalize`, confirm it recomputes only that + downstream.
- **Stoppability:** Ctrl-C mid-run; confirm completed stages' JSON is on disk and a resume
  picks up.
- **Key injection:** call `transcribe({..., apiKeys:{gemini,assemblyai}})` with env vars unset
  (instr. #11).
- **Failure detection:** check `transcribe/llm-transcribe.ts` `validate()` (span ≥60%,
  ≥3 segments, monotonic) and the retry — the spec's "how would we know if it failed."

## What to grade hardest

1. **The aligner** (`align/aligner.ts` + `edit-distance.ts`) — the entire value proposition.
   The tests + the process-log drift post-mortem are the evidence it's right.
2. **The eval** (`eval/scorer.ts`) — confirm the _metric design_ is fair (it deliberately
   rejected per-segment Jaccard for full-transcript WER + time-overlap; reasoning in the
   process log).
3. **The intermediates contract** — every stage round-trips through JSON, which is what makes
   "stoppable/resumable/debuggable" true rather than marketing.
