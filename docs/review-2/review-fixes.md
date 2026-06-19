# Review-2 Fixes & Responses

Working through `docs/review-2/human-review.md` (a senior-dev code read of the GLM build).
For each point: your note (cleaned up), then my response — a **fix** (why it happened + what I
did) where it was a defect, or an **explanation** where it was a question/observation.

All fixes are committed; verification is at the bottom.

---

## 1. Lint issues "sitting around" → FIXED (0 warnings)

### Note
> "We do have some lint issues that are just sitting around, which is not nice. They're not
> super bad, but we did build in the lint thing, so that's a big point."

### Response (fix)
The leftover warnings were all `@typescript-eslint/no-explicit-any` in the provider layer,
where I'd parsed SDK/HTTP JSON responses as `any` for speed. They were "not super bad"
(0 errors, just warnings) but they were sitting around. **Tightened to 0 warnings** by typing
the response shapes properly:
- `assemblyai.ts`: `params as any` → typed `TranscribeParams`; `speechModel: string` → `SpeechModel`; `mapTranscript(t: any)` → a structural type with `AaiWord`.
- `gemini.ts`: `(file as any).state` → `file.state` (SDK `FileState` is typed); `parts: any[]` → `Part[]` (SDK type).
- `gemini-fetch.ts` / `whisper-groq.ts` / `openai-compat.ts`: `as any` JSON → inline response interfaces.
- `ffmpeg.ts`: `streams: any[]` → typed ffprobe stream shape; `list-models.ts`: `m as any` → typed cast.

Why they happened: I reached for `any` while wiring untyped third-party JSON quickly and never
went back to tighten it. ESLint was configured (the "big point" you noted) but I'd left the
warnings as to-do. Now `npm run lint` is clean (0 problems), `tsc` clean, 27 tests pass.

---

## 2. Intermediates default is cwd-relative `./intermediates` → FIXED (anchored to input)

### Note
> "Instead of `./` relative, address the intermediate folder to what? … This might be where
> our bugs are coming from — when you run it wherever, you're doing `./intermediates` instead
> of anchoring to either where the file is from, where the program is, or some temp dir or
> `/var/lib`. That's a bit of a boo-boo."

### Response (fix)
You're right, and this is the same root as the review-1 cache bug — my review-1 fix made the
dir **per-input** but still **cwd-relative** (`./intermediates/<base>-<hash>`), so running the
tool from a different working directory scattered intermediates elsewhere. 

**Fixed:** `deriveIntermediatesDir` now anchors to the **input file's directory**:
`<inputDir>/.offmute-v2-<basename>-<hash>` (e.g. `/Users/x/movies/.offmute-v2-vmeeting-a1b2c3d4`).
That's your "where the file is from" option — stable regardless of cwd, per-input (no
collision), and findable right next to the source. `-i` still overrides for a custom location.

Why it happened: I defaulted to `./intermediates` for dev convenience and only fixed the
*collision* in review-1, not the *cwd-relativity*. Anchoring to the input dir closes it.

---

## 3. "Log every LLM call and response so I can validate it" → FIXED (added)

### Note
> "Since we have that map, we want to add an option to log every single LLM call and response
> so I can go in and validate it."

### Response (fix — feature)
Added an LLM call logger. Every Gemini and DeepSeek call now appends one JSON line to
`<intermediates>/llm-calls.jsonl`:
```json
{"ts":"…","provider":"gemini","model":"gemini-2.5-flash","kind":"transcribe","chunk":0,
 "prompt":"<full prompt>","response":"<full response>","usage":{"inputTokens":1339,"outputTokens":407},
 "durationMs":8290,"attempt":1}
```
Fields: provider, model, **kind** (`describe` | `transcribe` | `identify`), chunk index, the
**full prompt and response** (so you can validate), token usage, timing, attempt, and error.
Wired into `GeminiClient.generate` and `OpenAICompatClient.chat` (covers describe, per-chunk
transcription, and identify). `--no-llm-log` disables it; default is on. Verified: a 25s run
produced 3 log lines (describe / transcribe chunk 0 / identify) with full prompts+responses.

Why it wasn't there before: I saved per-chunk raw responses (`chunk_NN_raw.json`) and the
description output, but not a unified, structured log of *every* call with prompts — so
validating the LLM's actual behavior meant grepping scattered files. The JSONL log gives one
append-only file to inspect.

---

## 4. Hardcoded `gemini-2.5-flash` base model → FIXED (constants)

### Note
> "We've hard-coded Gemini 2.5 Flash as our base model. These things would have been better as
> constants."

### Response (fix)
The defaults `gemini-2.5-flash` (transcribe) and `deepseek-chat` (reasoner) were string
literals inline in `pipeline.ts`. Extracted to named constants in `config.ts`:
`DEFAULT_TRANSCRIBE_MODEL` (= `MODELS.gemini25Flash`) and `DEFAULT_REASONER_MODEL`
(= `MODELS.deepseek`), sitting next to the existing `MODELS` preset map. The pipeline now
references the constants, so there's one place to change the default.

---

## 5. Tokenization regex — performance? → EXPLAINED (not a concern)

### Note
> "Tokenization looks clean… we do use regexes, easy to read. I'm not sure about performance,
> so it's something to compare."

### Response (explanation)
The tokenizer (`src/align/normalize.ts`) is one `split(/\s+/)` plus a per-token
`replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi,"")` — both O(n) in the text length, and they run once
per segment. For a 32-min file that's ~3,000 tokens; the regex cost is microseconds. The
expensive part is the alignment DP (`O(tokens × asrWords)`), which is ~1.6s for the whole file
— orders of magnitude above tokenization. So regex perf here is negligible; no change needed.
(I measured this during the aligner work — the DP dominates by far.)

---

## 6. Edit-distance / Needleman-Wunsch, no banding → EXPLAINED

### Note
> "We have an edit-distance algorithm we wrote ourselves. We also use Needleman-Wunsch, but in
> Needleman-Wunsch we're using edit distance here. We don't mention banding."

### Response (explanation)
It **is** Needleman-Wunsch (global pairwise alignment via a DP table) with edit-distance costs
(exact=0, fuzzy=1, substitute=2, indel=2) — same algorithm, just cost-flavored as edit
distance. The doc/comments could say "Needleman–Wunsch" more explicitly; I'll align the wording.

On **banding** (restricting the DP to a diagonal band, the standard speedup for near-aligned
sequences): I deliberately didn't band, and noted why in the process log. Our two sequences
are *the same content* transcribed twice (LLM vs ASR) — highly aligned but with
insertions/deletions/substitutions throughout, including whole dropped/added utterances at
chunk boundaries. A fixed band would clip those long indels and misalign. The full DP is cheap
enough here (per-chunk or per-file, ~1.6s for 32 min, ~70MB for a full-file pass) that banding
isn't worth the correctness risk. **If** a 2-hour file made the full-file DP slow, the right
move is per-chunk alignment (already supported) rather than banding. So: intentional, with a
documented escape hatch for scale.

---

## 7. Prompt construction (`parts.push`, multi-line strings) "all over the place" → EXPLAINED (+ minor)

### Note
> "We have these `parts.push`. The way we create prompts, which is multi-line strings, is a bit
> all over the place."

### Response (explanation)
The `parts.push(...)` + `join("\n")` pattern in `transcriptionPrompt` is intentional: the
prompt conditionally assembles context (description, roster, previous-chunk tail, user
instructions) that may or may not be present, and pushing lines into an array is the cleanest
way to build that conditionally without messy template-indentation. It reads as a sequence of
lines, which is what a prompt is. `descriptionPrompt` / `identifyPrompt` use template literals
because they're static. So there are two styles, but each matches its use. I agree it could be
more uniform; I left it because the conditional-assembly case genuinely reads better as
`parts.push`. Not a defect — a stylistic note I've acknowledged.

---

## 8. Browser constraint: no native ffmpeg → EXPLAINED (documented extension)

### Note
> "The browser constraint here is that we just don't have ffmpeg straight up. That's a pretty
> big issue. We don't need to add it right now, but it's something to mark down. Skipping
> ffmpeg kind of means we've skipped the complexity."

### Response (explanation)
Correct, and intentional for now. The browser build (`offmute-v2/browser`, ~35KB, zero
node-only imports) ships the **pure logic** (align / consistency / identify / finalize /
format) plus **fetch-based providers** (Gemini inline, AssemblyAI REST) — none of which need
ffmpeg. What it can't do in-browser is **preprocess** (extract/downsample audio, slice
keyframes) because that needs ffmpeg, which is native. The documented extension point is
`ffmpeg.wasm`: the caller extracts/chunks audio in-browser with ffmpeg.wasm, then hands the
Blob to `transcribeBrowser` (which handles inline-Gemini + AssemblyAI + the pure-logic
pipeline). So we "skipped the complexity" of bundling ffmpeg.wasm by default, but the seam is
clean — drop in ffmpeg.wasm for preprocessing and the rest already runs in the browser. Marked
in the README's browser section.

---

## 9. Praise items (acknowledged, no action)

### Notes
> "Very different way of typing things, and it is structured, honestly pretty well… a thing for
> resolving the security model, resolving the keys. We do have model presets, which we didn't
> in the other version — wonderful to have learned from offmute. size+mtime is a better way to
> build a content hash, something we do in one of the dependencies too. This code is
> significantly more readable. I like that the files are grouped into folders — otherwise you
> get 50 files."

### Response
Acknowledged, and thanks — these were deliberate:
- **Typed, modular structure** (`core/ align/ diarize/ finalize/ providers/ …`) so each stage
  is a small, readable module rather than a 50-file flat dump.
- **Security model / key resolution** (`resolveKeys`: injected > env) and **model presets**
  (`MODELS` map + role constants) — both lifted from offmute v1's lessons.
- **size+mtime signature** for cache invalidation (in `inputSignature`) — chosen over a content
  hash precisely to avoid hashing multi-GB files, matching the convention you recognized from a
  dependency.

---

## Verification

| Check | Result |
|---|---|
| `npm run lint` | **0 problems** (was 16 `any` warnings) |
| `npm run typecheck` | clean |
| `npm test` | 27 passed |
| `npm run build` | succeeds (node + browser) |
| Intermediates default | anchored to input dir, e.g. `/tmp/.offmute-v2-clip25-cc613666` (not cwd-relative) |
| LLM call log | `llm-calls.jsonl` written with 3 entries (describe/transcribe/identify), full prompt+response+usage+timing |
| `--no-llm-log` | disables logging |
| Full pipeline smoke (20s clip) | real SRT; typed `TranscribeParams`/`Part`/ffprobe all work |

## Files changed
- `src/core/config.ts` — `deriveIntermediatesDir` anchors to input dir; `DEFAULT_TRANSCRIBE_MODEL`/`DEFAULT_REASONER_MODEL` constants; `llmLog` option.
- `src/core/pipeline.ts` — `setLlmLogPath` at start; model constants.
- `src/cli.ts` — `--no-llm-log` flag.
- `src/providers/llm-log.ts` — **new**: append-only JSONL call logger.
- `src/providers/{gemini,openai-compat,assemblyai,assemblyai-fetch,whisper-groq,gemini-fetch}.ts` — LLM logging wired in; `any` → typed response shapes.
- `src/audio/ffmpeg.ts` — typed ffprobe stream shape.
- `src/transcribe/{describe,llm-transcribe}.ts`, `src/diarize/identify.ts` — pass `logKind`/`logChunk`.
- `scripts/list-models.ts` — typed cast.

## Not changed (intentional, explained above)
- No banding in the alignment DP (correctness > micro-optimization; per-chunk is the scale lever).
- Prompt `parts.push` style (intentional for conditional assembly).
- No ffmpeg.wasm bundled by default (documented browser extension point).
