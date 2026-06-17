/**
 * Browser media preprocessing via ffmpeg.wasm. The host passes a *loaded* FFmpeg
 * instance (from `@ffmpeg/ffmpeg`); we don't import the package so it stays out of
 * the bundle. Functions operate on the instance's in-memory FS.
 *
 *   import { FFmpeg } from "@ffmpeg/ffmpeg";
 *   const ff = new FFmpeg(); await ff.load();
 *   const audio = await extractAudioWasm(ff, new Uint8Array(await file.arrayBuffer()));
 */

/** The subset of the @ffmpeg/ffmpeg API we use. */
export interface FFmpegLike {
  writeFile(path: string, data: Uint8Array | string): Promise<unknown>;
  readFile(path: string, encoding?: string): Promise<Uint8Array | string>;
  exec(args: string[]): Promise<unknown>;
  deleteFile?(path: string): Promise<unknown>;
}

let counter = 0;
const tmpName = (ext: string) => `__offmute_${counter++}.${ext}`;

async function tryDelete(ff: FFmpegLike, name: string): Promise<void> {
  try {
    await ff.deleteFile?.(name);
  } catch {
    /* ignore */
  }
}

const AUDIO_CODEC: Record<string, string[]> = {
  mp3: ["-c:a", "libmp3lame"],
  opus: ["-c:a", "libopus"],
  wav: ["-c:a", "pcm_s16le"],
  m4a: ["-c:a", "aac"],
};

export interface ExtractAudioWasmOptions {
  sampleRate?: number;
  channels?: number;
  startSeconds?: number;
  durationSeconds?: number;
  bitrate?: string;
  /** output container (mp3 default) */
  format?: "mp3" | "opus" | "wav" | "m4a";
  /** reuse a file already written to the FS instead of writing `input` */
  inputName?: string;
  /** keep the written input file (for slicing the same source repeatedly) */
  keepInput?: boolean;
}

/**
 * Extract (and optionally clip) speech-ready audio from media bytes (or a file
 * already in the FS via `inputName`). Returns the encoded audio bytes.
 */
export async function extractAudioWasm(
  ff: FFmpegLike,
  input: Uint8Array | null,
  opts: ExtractAudioWasmOptions = {}
): Promise<Uint8Array> {
  const {
    sampleRate = 16000,
    channels = 1,
    startSeconds,
    durationSeconds,
    bitrate = "64k",
    format = "mp3",
    inputName,
    keepInput = false,
  } = opts;

  let inName = inputName;
  let wrote = false;
  if (!inName) {
    if (!input) throw new Error("extractAudioWasm: provide input bytes or inputName");
    inName = tmpName("bin");
    await ff.writeFile(inName, input);
    wrote = true;
  }
  const outName = tmpName(format);

  const args: string[] = [];
  if (startSeconds !== undefined) args.push("-ss", String(startSeconds));
  args.push("-i", inName);
  if (durationSeconds !== undefined) args.push("-t", String(durationSeconds));
  args.push("-vn", "-ac", String(channels), "-ar", String(sampleRate), ...(AUDIO_CODEC[format] ?? AUDIO_CODEC["mp3"]!));
  if (format !== "wav") args.push("-b:a", bitrate);
  args.push(outName);

  try {
    await ff.exec(args);
    const out = (await ff.readFile(outName)) as Uint8Array;
    return out;
  } finally {
    await tryDelete(ff, outName);
    if (wrote && !keepInput) await tryDelete(ff, inName!);
  }
}

export interface ExtractKeyframesWasmOptions {
  atSeconds: number[];
  maxSize?: number;
  inputName?: string;
}

/** Extract still JPEG keyframes at the given timestamps. Returns one Uint8Array per frame. */
export async function extractKeyframesWasm(
  ff: FFmpegLike,
  input: Uint8Array | null,
  opts: ExtractKeyframesWasmOptions
): Promise<Uint8Array[]> {
  const { atSeconds, maxSize = 768, inputName } = opts;
  let inName = inputName;
  let wrote = false;
  if (!inName) {
    if (!input) throw new Error("extractKeyframesWasm: provide input bytes or inputName");
    inName = tmpName("bin");
    await ff.writeFile(inName, input);
    wrote = true;
  }
  const frames: Uint8Array[] = [];
  try {
    for (const t of atSeconds) {
      const out = tmpName("jpg");
      await ff.exec(["-ss", String(t), "-i", inName, "-frames:v", "1", "-vf", `scale='min(${maxSize},iw)':-2`, "-q:v", "3", out]);
      frames.push((await ff.readFile(out)) as Uint8Array);
      await tryDelete(ff, out);
    }
  } finally {
    if (wrote) await tryDelete(ff, inName!);
  }
  return frames;
}

/** Write bytes to the FS under a stable name and return it (for slicing repeatedly). */
export async function writeInput(ff: FFmpegLike, bytes: Uint8Array, name = "__offmute_source"): Promise<string> {
  await ff.writeFile(name, bytes);
  return name;
}
