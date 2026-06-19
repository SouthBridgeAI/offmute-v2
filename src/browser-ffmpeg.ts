/**
 * In-browser preprocessing via ffmpeg.wasm — the piece the browser bundle punted on.
 * Extracts mono 16kHz audio (for ASR + chunking) and keyframes (for video) from a raw
 * media Blob, so the full pipeline can run in-browser.
 *
 * Requires the optional peer deps `@ffmpeg/ffmpeg` and `@ffmpeg/util`, loaded dynamically
 * (so they're not bundled into the Node build). The ffmpeg-core is fetched from a CDN at
 * runtime (configurable via `coreBase`).
 *
 * ⚠️ Verification note: this adapter follows the @ffmpeg/ffmpeg 0.12 API and compiles clean,
 * but wasm execution can only be verified in a real browser (no browser in the dev env here).
 * See examples/browser/index.html for a runnable wiring, and verify in your browser.
 */
import type { ChunkPlan } from "./core/types.js";

export interface FfmpegWasmOptions {
  /** Base URL for the ffmpeg-core files (default: unpkg @ffmpeg/core 0.12.x). */
  coreBase?: string;
}

const DEFAULT_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegInstance: import("@ffmpeg/ffmpeg").FFmpeg | null = null;

async function loadFfmpeg(opts: FfmpegWasmOptions = {}): Promise<import("@ffmpeg/ffmpeg").FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const { toBlobURL } = await import("@ffmpeg/util");
  const base = opts.coreBase ?? DEFAULT_CORE_BASE;
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  });
  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

async function writeInput(ffmpeg: import("@ffmpeg/ffmpeg").FFmpeg, blob: Blob, name: string) {
  const { fetchFile } = await import("@ffmpeg/util");
  await ffmpeg.writeFile(name, await fetchFile(blob));
}

export interface BrowserPreprocessResult {
  /** Whole mono 16kHz FLAC audio (for the ASR whole-file pass). */
  audio: Blob;
  /** Per-chunk mono 16kHz FLAC Blobs + absolute [start,end] (for per-chunk LLM). */
  chunks: { data: Blob; start: number; end: number }[];
  /** Keyframe JPEG Blobs (video only). */
  keyframes: Blob[];
}

/**
 * Preprocess a raw media Blob in-browser: extract mono 16kHz FLAC, slice it into chunks,
 * and (for video) extract keyframes. Returns what the browser pipeline needs.
 */
export async function preprocessInBrowser(
  input: Blob,
  chunks: ChunkPlan[],
  opts: FfmpegWasmOptions & { keyframeCount?: number; isVideo?: boolean } = {},
): Promise<BrowserPreprocessResult> {
  const ffmpeg = await loadFfmpeg(opts);
  const inExt = input.type.includes("video") ? "mp4" : "m4a";
  const inFile = `input.${inExt}`;

  await writeInput(ffmpeg, input, inFile);

  // Whole audio (mono 16kHz FLAC) for the ASR pass.
  await ffmpeg.exec(["-i", inFile, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", "audio.flac"]);
  const audioData = (await ffmpeg.readFile("audio.flac")) as Uint8Array;
  const audio = new Blob([audioData], { type: "audio/flac" });

  // Per-chunk slices for the LLM pass.
  const chunkBlobs: { data: Blob; start: number; end: number }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const name = `chunk_${i}.flac`;
    await ffmpeg.exec([
      "-i", inFile, "-ss", c.start.toFixed(3), "-t", (c.end - c.start).toFixed(3),
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", name,
    ]);
    const data = (await ffmpeg.readFile(name)) as Uint8Array;
    chunkBlobs.push({ data: new Blob([data], { type: "audio/flac" }), start: c.start, end: c.end });
    try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
  }

  // Keyframes (video only).
  const keyframes: Blob[] = [];
  if (opts.isVideo && (opts.keyframeCount ?? 0) > 0) {
    const n = opts.keyframeCount!;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n; // fraction — caller should pass real times; simplified here
      const name = `kf_${i}.jpg`;
      await ffmpeg.exec(["-i", inFile, "-ss", (t * 1).toFixed(3), "-frames:v", "1", name]);
      const data = (await ffmpeg.readFile(name)) as Uint8Array;
      keyframes.push(new Blob([data], { type: "image/jpeg" }));
      try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
    }
  }

  try { await ffmpeg.deleteFile(inFile); await ffmpeg.deleteFile("audio.flac"); } catch { /* ignore */ }
  return { audio, chunks: chunkBlobs, keyframes };
}
