# offmute-v2 — Code & System Review

> Independent review of the `offmute-v2-glm` build against `0-starting-instructions.md`
> and `docs/spec.md`. Covers conventions, readability, instruction adherence, and whether
> it is a working, extensible, maintainable system. Verified by running the project's own
> checks plus an independent accuracy computation.

## 1. Verdict

A **strong, genuinely working build** that meets the brief unusually well. It is not a demo
that merely looks like it works: the core hypothesis (multimodal LLM for _content_ + ASR for
_timing_, fused by edit-distance alignment) is implemented cleanly, tested, and
independently verifiable.

Re-ran the project's own checks plus a from-scratch WER computation:

| Check                                                            | Result                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit`                                                   | clean, 0 errors                                                                                                                 |
| `eslint .`                                                       | 0 errors, 16 warnings (all `any` in provider interop, intentional)                                                              |
| `vitest run`                                                     | **27/27 pass** (the only error seen was a sandbox blocking vitest's results-cache write to `node_modules` — not a test failure) |
| Independent WER vs hand-checked reference (`intermediates/run1`) | **WER 0.140 / 86.0% word accuracy, coverage 38/38** — matches the documented 0.135–0.146                                        |

The engineering process in `intermediates/process_log_*.md` and the git history (hypothesis
H1–H6, each verified by a script before being wired in) is exactly what the instructions
asked for. The headline strength: **the author followed the recommended scientific process
and left an auditable trail.**

## 2. Instruction adherence

The brief had 13 guidelines + a 10-step process. Coverage is near-complete:

| Instruction                                 | Status    | Evidence                                                                                                                                                                            |
| ------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Study the 3 inspirations, learn their bugs  | Excellent | Process log documents offmute's no-dedup overlap, ipgu's clamp-reintroduces-overlap gap (and _fixes_ it in `clampAndFix`), meeting-diary's hash caching (reused in `assemblyai.ts`) |
| Web research / SOTA                         | Done      | Adapted the ts-aligner edit-distance approach; evaluated WhisperX/pyannote; chose AssemblyAI Universal-2                                                                            |
| Test each part with scripts first           | Done      | `scripts/` has per-stage harnesses (preprocess, llm-transcribe, timestamped, align, eval)                                                                                           |
| Spec with hypotheses + failure handling     | Done      | `docs/spec.md` §4 is an explicit failure/detection/recovery table                                                                                                                   |
| 3 diarization levels, selectable            | Done      | `--level 1\|2\|3`; level 3 auto-adds the identify pass (`config.ts` `resolveOptions`)                                                                                               |
| Preprocess (downsample, keyframes)          | Done      | 9.6GB PCM `.mov` → 76MB mono-16kHz FLAC; scene-aware keyframes                                                                                                                      |
| Save intermediates, resumable/stoppable     | Done      | Every stage reads/writes JSON and skips on cache hit unless `--force`                                                                                                               |
| Keys from env _and_ injectable              | Done      | `resolveKeys`: injected > env, per-key                                                                                                                                              |
| npx + browser packaging                     | Done      | `tsup` dual build; `browser.ts` uses fetch-only providers, no node deps                                                                                                             |
| SRT breaking (readable blocks)              | Done      | `format.ts` `splitIntoBlocks`: per-word splitting at ≤84 chars / ≤7s                                                                                                                |
| Timestamp alignment "coarse → close"        | Done      | LLM gives coarse `mm:ss`; whole-chunk DP transfers ASR word times                                                                                                                   |
| Prefer not to use subagents (except review) | Done      | Used once, for a fresh-eyes code review (documented; bugs fixed)                                                                                                                    |
| Eval against the reference                  | Done      | `eval/scorer.ts` (WER + coverage + boundary + speaker), reproduced above                                                                                                            |

**Gaps vs the spec (minor):**

- Spec §4 promised a DeepSeek _alignment-repair_ pass for low-confidence segments — not built.
  ASR gap-fill (`align/fill-gaps.ts`) was built instead, which is arguably better.
- WhisperX-in-container was scoped but not implemented; Groq Whisper covers the "free
  fallback" need.

Neither is a real miss.

## 3. Architecture & design

The pipeline is a **linear sequence of pure-ish stages connected by serializable JSON**,
giving resumability, debuggability, and browser-portability for free.

```
preprocess → describe → llm-transcribe(per-chunk) → timestamped(whole-file)
   → align(single-DP) → gap-fill → consistency → [identify] → finalize → format
```

Decisions worth calling out as good:

- **The alignment insight is correct and the code matches it.** `align/aligner.ts` aligns the
  _entire_ chunk's flat LLM token stream against the ASR word stream in one DP
  (`align/edit-distance.ts`), then slices back to segments. The process log explains _why_
  per-segment windowed alignment drifted (ties let common words like "it" match a later
  occurrence → 41s median error) and why the flat approach fixes it. The cost model
  (exact=0, fuzzy=1, sub=2, indel=2, ×2 to stay integer in `Int32Array`) makes exact strictly
  beat fuzzy — pinned by a unit test ("prefers the earliest exact match over a later fuzzy one").
- **Consistency uses the ASR diarization as a global backbone** (`diarize/consistency.ts`)
  rather than stitching per-chunk LLM labels — sidesteps offmute's cross-chunk drift. The
  clever bit: _merging_ ASR speakers that share a specific LLM label (fixes AssemblyAI
  over-splitting one presenter into two voices) while keeping generic "Speaker A" labels
  separate. Both behaviors are unit-tested.
- **Clean core/provider split.** Node-specific code is confined to `audio/ffmpeg.ts` and the
  SDK providers; align/diarize/finalize/format core is pure TS — what makes the ~35KB browser
  bundle real rather than aspirational.
- **Pragmatic provider abstraction**: one OpenAI-compatible fetch client serves
  DeepSeek/Groq/OpenAI; AssemblyAI and Gemini each have an SDK (node) and a fetch (browser)
  variant with matched result shapes.

## 4. Code quality, conventions, readability

Consistently high:

- **Every file has an accurate top-of-file doc comment explaining _why_ it exists and what
  trick it uses** (rare and valuable). Comments explain intent/trade-offs, not mechanics.
- TypeScript is strict (`noUncheckedIndexedAccess`, `strict`, `verbatimModuleSyntax`) and the
  code respects it; `!` assertions are used where invariants hold.
- Naming is clear and domain-aligned (`trustedStart`, `timingSource`, `dominantLabel`,
  `groupTalk`).
- Functions are small and single-purpose; the only large file is `core/pipeline.ts`
  (366 lines), appropriate for an orchestrator.
- Constants are named and centralized per-module (`MIN_DUR`, `MAX_DUR`, `OVERLAP_GAP`,
  `MIN_SPAN_RATIO`) — directly addressing offmute's "magic numbers" complaint.

## 5. Issues & risks (ranked)

None are blockers. Roughly in priority order:

1. **`metadata.models.timestamped` is hardcoded** to `"assemblyai-universal-2"`
   (`core/pipeline.ts:345`) even when `--timestamped whisper-groq` is used → output JSON
   misreports provenance. Easy fix.
2. **Dead/duplicated formatters.** `utils/srt.ts` exports its own `formatSrt`/`formatMarkdown`,
   but the live ones are in `finalize/format.ts`. Only `parseSrt` from `utils/srt.ts` is used.
   Delete or re-export the duplicates to avoid future confusion.
3. **Cross-chunk `previousTail` continuity is mostly inert under the default `concurrency: 4`.**
   Chunks run in parallel, so a chunk's predecessor cache usually doesn't exist yet when it's
   read (`core/pipeline.ts:182-191`). Documented as acceptable (ASR backbone handles
   consistency) and the eval bears it out, but a prompt feature is silently a no-op in the
   common path. Add a call-site comment or sequence the tail dependency.
4. **Gap-fill speaker attribution can be wrong at the very start.** In `run1` the recovered
   opener "GPU" is attributed to "Speaker D" (audience) because the leading-gap speaker vote
   picked the wrong dominant ASR utterance; the reference attributes it to the presenter.
   Cosmetic, low-frequency, but visible.
5. **`--passes` + identify interaction is a subtle footgun.** Identify is gated on
   `diarizationLevel >= 3` _in addition to_ being in the passes list
   (`core/pipeline.ts:303`), so `--passes ...,identify` without `--level 3` silently does
   nothing. Reasonable, but undocumented.
6. **Browser path skips describe + chunking + gap-fill** (`browser.ts` `transcribeBrowser`):
   one whole-file inline Gemini call. Fine for ≤~20MB as documented, but the quality ceiling
   is lower than the node path and the asymmetry isn't loudly flagged in the function contract.
7. **`any` in providers (16 lint warnings).** Intentional for SDK/REST interop; the
   AssemblyAI/Gemini response shapes could get minimal typed interfaces to catch upstream
   changes.
8. **No retry/backoff on AssemblyAI**, unlike Gemini (`generate`) and the OpenAI-compat client
   which both retry. AssemblyAI failures throw immediately — a gap vs the spec's failure table.

## 6. Bottom line

For an autonomous build against an open-ended brief, this lands in the top tier: the hard
problem (timestamp-accurate diarized transcription) is actually solved and measured, the code
is clean and extensible, packaging (npx + library + browser) is real, and the process
discipline (intermediates, resumability, hypothesis logging, eval-driven iteration) is
exemplary. The open issues are polish-level, not architectural.
