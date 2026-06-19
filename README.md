# offmute-v2

**Timestamp-correct, diarized meeting transcription** — a video/audio file goes in; a
speaker-labelled, tone-annotated transcript with accurate timestamps comes out (SRT / Markdown /
JSON). It fuses a multimodal LLM (content, diarization, tone, speaker identity) with an ASR model
(word-level timing), aligned together. Runs as an npx CLI, a Node library, and in the browser.

> 📝 **Full write-up:** _"offmute-v2: GLM vs Opus"_ — **coming soon** at
> http://southbridge.ai/blog/offmute-v2-glm-vs-opus

---

## This repo is an agent-vs-agent experiment

offmute-v2 was built **twice, from a single identical prompt**, by two different models running in
**Claude Code** — as a head-to-head of how each does on a hard, AI-resistant build (combining the
ideas from [offmute], [meeting-diary], and [ipgu] into one timestamp-accurate diarizer):

| Branch | Built by | npm | What it is |
|--------|----------|-----|------------|
| [`glm`](../../tree/glm)  | **GLM-5.2** | `offmute-v2@latest` / `@glm` | the **primary**, daily-driven build |
| [`opus`](../../tree/opus) | **Claude Opus 4.8** | `offmute-v2@opus` | the comparison build, preserved with full history |
| `master` | — | — | this overview + the current primary (tracks `glm` for now; may diverge) |

The two branches have **independent histories** — each is the full, unedited commit trail of that
model's build, including every review round and fix (so you can read exactly what happened).

## The receipts (per branch, in `docs/`)

Each build branch carries its own review trail:

- `docs/spec.md` — the plan & hypotheses
- `docs/review-1/` — first run-through review + the model's diagnosed fixes
- `docs/review-2/` — code-read + independent review + fixes
- `docs/comparison-response.md` (glm) / `docs/review-comparison-fixes.md` (opus) — each model's
  response to the cross-model comparison
- `intermediates/process_log_*.md` — the model's append-only dev journal

Browse them on [`glm`](../../tree/glm/docs) and [`opus`](../../tree/opus/docs).

## Quick start

```bash
export GEMINI_API_KEY=...         # multimodal transcription (or GOOGLE_API_KEY)
export ASSEMBLYAI_API_KEY=...     # word-level timing

# primary (GLM) build:
npx offmute-v2@latest meeting.mp4
# explicitly pin a build:
npx offmute-v2@glm  meeting.mp4
npx offmute-v2@opus meeting.mp4
```

Both publish the same `offmute-v2` CLI and library; they differ in pipeline internals (e.g. GLM's
ASR-backbone consistency + gap-fill, Opus's ownership-partition merge + voice-anchored identify).
See each branch's README for its full CLI/library/browser docs, and [`RELEASING.md`](RELEASING.md)
for how the `latest` / `glm` / `opus` npm tags are published.

## Build from source

```bash
git clone https://github.com/SouthBridgeAI/offmute-v2.git
cd offmute-v2 && git checkout glm   # or: opus

# glm build (npm):           npm ci && npm run build && npm test
# opus build (bun):          bun install && bun run build && bun test
node dist/cli.js --help      # (glm CLI entry is dist/cli.cjs)
```

## Requirements
- Node ≥ 20 and `ffmpeg`/`ffprobe` on PATH (CLI / library). Browser builds use ffmpeg.wasm.
- API keys from env or injected: `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `ASSEMBLYAI_API_KEY`;
  optional `DEEPSEEK_API_KEY` / `GROQ_API_KEY` depending on the build/options.

## License
Apache-2.0. Built on [offmute], [meeting-diary], and [ipgu]. Credit to the model teams — including
[z.ai](https://z.ai) for GLM-5.2.

[offmute]: https://github.com/southbridgeai/offmute
[meeting-diary]: https://github.com/southbridgeai/meeting-diary
[ipgu]: https://github.com/hrishioa/ipgu
