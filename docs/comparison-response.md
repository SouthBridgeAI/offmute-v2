# Comparison Response — what I ported/fixed from the GLM-vs-Opus review

Response to `review-comparison.md`. The comparison was candid that both builds work and the
core thesis is shared; the actionable items for the GLM line were in the "what to port from
Opus" list plus a few cons. Here's what I did with each, with verification.

## Acted on

### 1. Ownership-partition chunk merge — FIXED (the big one)
**The finding (Part 4):** GLM's 60s chunk overlap caused double-printed sentences at the seam
(24 near-duplicate segments on the talk), inflating WER from a true ~8.3% to a reported ~15%
(724 insertions, mostly duplicates). The fuzzy dedup in finalize missed them — overlap
duplicates can map to *different* global speakers, so the `speaker ===` guard skipped them.

**The fix (ported from Opus's ownership partitioning):** each LLM segment is now tagged with
its source chunk's `trustedStart`; before alignment, `partitionByOwnership` drops any segment
whose center time falls in the overlap region owned by the *previous* chunk. This structurally
guarantees every word is emitted by exactly one chunk — no reliance on fuzzy matching. Also
fixed `trustedStart` going stale after silence-snapping. Fuzzy dedup kept as a safety net.

**Verified:** near-duplicate pairs **12 → 0**; **WER 0.136 → 0.072 (92.8% accuracy)** — now
level with the comparison's deduped 7.5%. +2 unit tests for `partitionByOwnership`.

### 2. Always-valid SRT — FIXED (property tests)
**The finding:** a blank line inside a segment's text could split one SRT cue into several (a
real validity bug, found by asking "do we test that the SRT is always valid?").

**The fix:** `finalizeSegments` now collapses all internal whitespace (incl. newlines) in
segment text to single spaces, so no stray blank line can end a cue early. Added property
tests asserting every generated cue is well-formed (numeric index, timing line, no intra-cue
blank lines) and round-trips through `parseSrt`. (31 tests.)

### 3. Voice-anchored identify hint — PORTED (adapted to this architecture)
**The finding:** Opus feeds identify a `label → dominant ASR voice %` hint to strengthen
level-3 naming.

**The fix:** `SpeakerInfo` gains `asrVoices` (the ASR voice clusters each global speaker maps
to), populated by the consistency pass; the identify prompt header now shows
`voices=speaker_B` so the reasoner has voice-anchored evidence. Note: in this
consistency-first architecture, label→voice *merging* is already done by consistency (so the
hint's merge value is narrower than in Opus), but the voice evidence still helps the reasoner
name speakers. Verified: `asrVoices` populated and reaching the identify prompt on a real run.

### 4. ffmpeg.wasm browser pipeline — SCAFFOLDED (the piece I'd punted on)
**The finding:** "Runs in the browser" was real for Opus (ffmpeg.wasm + demo) and aspirational
for GLM (pure core only, ffmpeg left as an extension point).

**The fix:** added `src/browser-ffmpeg.ts` — `preprocessInBrowser()` extracts mono 16k audio +
per-chunk slices + keyframes from a raw Blob via `@ffmpeg/ffmpeg` 0.12 (dynamically imported,
browser-only). `@ffmpeg/ffmpeg`/`@ffmpeg/util` are optional peer deps, marked external in the
browser build; a type shim keeps `tsc` green without them installed. Exported from the browser
entry, with `examples/browser/index.html` (drop a file → extract via ffmpeg.wasm →
`transcribeBrowser`). Bundle **40KB, 0 node-only imports**.

**Honest caveat:** the pure core + bundle compile and run (verified in a module context); the
ffmpeg.wasm *execution* follows the 0.12 API but could only be confirmed in a real browser
(none in this dev env). The demo + adapter are the seam; verify wasm in your browser.

### 5. JSON-mode identify — already in place
The comparison listed "JSON-mode identify robustness" as a port item; my identify pass already
uses `chatJson` (JSON mode). No change needed.

## Already closed before this comparison (review-1 / review-2)
The comparison's GLM "cons" — silent cache collision, `--force` not forcing, cwd-relative
intermediates, no early input validation, lint warnings, no LLM-call log — were all fixed in
the two earlier review rounds (see `docs/review-fixes.md` and `docs/review-fixes-2.md`):
per-input intermediates anchored to the input file + a source-signature manifest, one
`forceAll` applied uniformly, early `existsSync(input)` check, lint to **0 warnings**, and an
append-only `llm-calls.jsonl`. Those are not re-addressed here.

## Deferred (with reasons)
- **Stage-tagged errors (`[asr] …`):** not added; errors are thrown with clear messages and
  each stage logs `=== stage ===` on entry, which gives the same locality. Low value; skipped.
- **Full DRY of Node vs browser orchestration:** the comparison flagged Opus's ~80% duplicated
  orchestration as future debt. I did **not** introduce a second orchestrator — the browser
  path reuses the pure-logic stages (`alignSegments`/`assignGlobalSpeakers`/…); only the I/O
  (ffmpeg.wasm + fetch providers) differs. A shared I/O-abstracted orchestrator would be the
  larger refactor; deferred to avoid shipping unverified duplication.
- **Branches for risky ideas:** the comparison noted neither build used branches. I also kept
  everything on the working branch for these iterations (each change is a commit, easily
  reverted — the ownership-partition and merge-revert history is intact).

## Verification summary
| Check | Result |
|---|---|
| Ownership-partition dedup | near-dup pairs 12 → 0; WER **0.072** (was 0.136) |
| SRT validity | property tests pass; intra-cue blank lines impossible |
| Voice-anchored identify | `asrVoices` populated + in identify prompt |
| Browser bundle | 40KB, 0 node-only imports; `preprocessInBrowser` exported; core runs in module context |
| `tsc` / lint / tests | clean / 0 problems / 31 pass |

## Bottom line
The comparison's one concrete accuracy gap (overlap dedup) is closed and measured — GLM's
WER is now ~level with Opus's on the controlled comparison, matching the article's "very good
vs very good" framing. The SRT-validity bug is fixed with property tests, the voice-anchored
identify hint is ported, and the browser story has a real (if browser-verify-pending)
ffmpeg.wasm seam + demo instead of a punt. The earlier-round cons were already closed. The
remaining items (stage-tagged errors, a fully DRY'd shared orchestrator) are deferred as low
value / larger refactor.
