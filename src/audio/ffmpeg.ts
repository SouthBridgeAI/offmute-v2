/**
 * Thin, promise-based ffmpeg/ffprobe wrapper. Spawns the binaries directly for full
 * control (no fluent-ffmpeg dep). All encode progress/diagnostics go to stderr; we
 * capture it for parsing (silence/scene detection) and for error messages.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../utils/logger.js";

export interface ProbeResult {
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  audioCodec?: string;
  videoCodec?: string;
  sampleRate?: number;
  channels?: number;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

function run(
  cmd: string,
  args: string[],
  opts: { captureStderr?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.slice(-800);
        reject(new Error(`${cmd} exited ${code}: ${tail}`));
      }
    });
  });
}

/** Check ffmpeg + ffprobe are available. */
export async function checkFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Probe a media file's streams + duration. */
export async function probe(input: string): Promise<ProbeResult> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    input,
  ]);
  const data = JSON.parse(stdout);
  const streams: any[] = data.streams || [];
  const audio = streams.find((s) => s.codec_type === "audio");
  const video = streams.find((s) => s.codec_type === "video");
  return {
    duration: parseFloat(data.format?.duration || "0") || 0,
    hasAudio: !!audio,
    hasVideo: !!video,
    audioCodec: audio?.codec_name,
    videoCodec: video?.codec_name,
    sampleRate: audio ? parseInt(audio.sample_rate, 10) : undefined,
    channels: audio?.channels,
    width: video?.width,
    height: video?.height,
    sizeBytes: parseInt(data.format?.size || "0", 10) || undefined,
  };
}

export type AudioFormat = "flac" | "mp3" | "opus" | "wav";

export interface ExtractAudioOptions {
  sampleRate?: number; // default 16000
  channels?: number; // default 1 (mono)
  format?: AudioFormat; // default flac
  bitrate?: string; // for lossy, e.g. "64k"
}

function audioArgs(opts: ExtractAudioOptions): string[] {
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const format = opts.format ?? "flac";
  const common = ["-vn", "-ac", String(channels), "-ar", String(sampleRate)];
  switch (format) {
    case "flac":
      return [...common, "-c:a", "flac"];
    case "mp3":
      return [...common, "-c:a", "libmp3lame", "-b:a", opts.bitrate ?? "64k"];
    case "opus":
      return [...common, "-c:a", "libopus", "-b:a", opts.bitrate ?? "48k"];
    case "wav":
      return [...common, "-c:a", "pcm_s16le"];
  }
}

/** Extract/convert audio (mono 16kHz FLAC by default — speech-optimal, small, lossless). */
export async function extractAudio(
  input: string,
  output: string,
  opts: ExtractAudioOptions = {},
): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const args = ["-y", "-i", input, ...audioArgs(opts), output];
  await run("ffmpeg", args);
}

/** Extract a time-bounded chunk [startSec, endSec) from an audio/video file. */
export async function extractChunk(
  input: string,
  output: string,
  startSec: number,
  endSec: number,
  opts: ExtractAudioOptions = {},
): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const duration = Math.max(0, endSec - startSec);
  const args = [
    "-y",
    "-ss",
    startSec.toFixed(3),
    "-i",
    input,
    "-t",
    duration.toFixed(3),
    ...audioArgs(opts),
    output,
  ];
  await run("ffmpeg", args);
}

export interface KeyframeInfo {
  path: string;
  time: number;
}

/** Get scene-change timestamps via the showinfo filter. */
async function getSceneChangeTimes(input: string, threshold: number): Promise<number[]> {
  try {
    const { stderr } = await run("ffmpeg", [
      "-i",
      input,
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-vsync",
      "vfr",
      "-f",
      "null",
      "-",
    ]);
    const times: number[] = [];
    const re = /pts_time:(\d+\.?\d*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) times.push(parseFloat(m[1]!));
    return times;
  } catch (err) {
    logger.debug(`scene detection failed: ${(err as Error).message}`);
    return [];
  }
}

/** Extract N keyframes, preferring scene changes, padding with even spacing. */
export async function extractKeyframes(
  input: string,
  outputDir: string,
  count: number,
  opts: { width?: number; sceneThreshold?: number } = {},
): Promise<KeyframeInfo[]> {
  await mkdir(outputDir, { recursive: true });
  const width = opts.width ?? 1280;
  const { duration } = await probe(input);
  if (!duration) return [];

  const sceneTimes = await getSceneChangeTimes(input, opts.sceneThreshold ?? 0.3);
  const times: number[] = [];

  // Evenly sample scene changes if we have enough; otherwise pad with even spacing.
  if (sceneTimes.length >= count) {
    const step = sceneTimes.length / count;
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(i * step);
      times.push(sceneTimes[idx] ?? 0);
    }
  } else {
    // Use all scene changes, then fill remaining slots with even spacing.
    times.push(...sceneTimes);
    const need = count - times.length;
    const start = duration * 0.02;
    const end = duration * 0.98;
    for (let i = 0; i < need; i++) {
      times.push(start + ((end - start) * (i + 0.5)) / need);
    }
  }

  times.sort((a, b) => a - b);
  const out: KeyframeInfo[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const path = `${outputDir}/keyframe_${String(i).padStart(3, "0")}.jpg`;
    await run("ffmpeg", [
      "-y",
      "-ss",
      t.toFixed(3),
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-2`,
      "-q:v",
      "3",
      path,
    ]);
    out.push({ path, time: t });
  }
  return out;
}

export interface SilenceRange {
  start: number;
  end: number;
  duration: number;
}

/** Detect silent ranges via silencedetect. Returns half-open [start, end) intervals. */
export async function detectSilence(
  input: string,
  opts: { noiseDb?: number; minDuration?: number } = {},
): Promise<SilenceRange[]> {
  const noise = opts.noiseDb ?? -30;
  const minDur = opts.minDuration ?? 0.3;
  const { stderr } = await run("ffmpeg", [
    "-i",
    input,
    "-af",
    `silencedetect=noise=${noise}dB:d=${minDur}`,
    "-f",
    "null",
    "-",
  ]);
  const starts: number[] = [];
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  const startRe = /silence_start: (-?\d+\.?\d*)/g;
  while ((m = startRe.exec(stderr)) !== null) starts.push(parseFloat(m[1]!));
  const endRe = /silence_end: (-?\d+\.?\d*)/g;
  while ((m = endRe.exec(stderr)) !== null) ends.push(parseFloat(m[1]!));
  const ranges: SilenceRange[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const e = ends[i] ?? s + minDur;
    ranges.push({ start: s, end: e, duration: e - s });
  }
  return ranges;
}

/**
 * Given a desired boundary time, snap it to the nearest silence midpoint within
 * `tolerance` seconds. Used to nudge chunk boundaries onto natural pauses for
 * cleaner overlap dedup (hypothesis H6).
 */
export function snapToSilence(
  boundary: number,
  silences: SilenceRange[],
  tolerance: number,
): number {
  let best = boundary;
  let bestDist = tolerance;
  for (const s of silences) {
    const mid = (s.start + s.end) / 2;
    const dist = Math.abs(mid - boundary);
    if (dist < bestDist) {
      bestDist = dist;
      best = mid;
    }
  }
  return best;
}
