/**
 * Node-only media utilities (ffmpeg / ffprobe via spawn — no fluent-ffmpeg dep).
 * The browser build uses ffmpeg.wasm with a parallel implementation.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MediaInfo } from "../types.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, resolving with code/stdout/stderr (never rejects on non-zero). */
function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/** Probe a media file with ffprobe into a normalized MediaInfo. */
export async function probeMedia(input: string): Promise<MediaInfo> {
  const { code, stdout, stderr } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    input,
  ]);
  if (code !== 0) {
    throw new Error(`ffprobe failed (${code}): ${stderr}`);
  }
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s["codec_type"] === "video");
  const audio = streams.find((s) => s["codec_type"] === "audio");
  const info: MediaInfo = {
    durationSeconds: parseFloat(data.format?.duration ?? "0") || 0,
    hasVideo: !!video,
    hasAudio: !!audio,
    sizeBytes: data.format?.size ? parseInt(data.format.size, 10) : undefined,
  };
  if (video) {
    info.width = Number(video["width"]) || undefined;
    info.height = Number(video["height"]) || undefined;
    info.videoCodec = (video["codec_name"] as string) || undefined;
  }
  if (audio) {
    info.audioCodec = (audio["codec_name"] as string) || undefined;
    info.sampleRate = Number(audio["sample_rate"]) || undefined;
    info.channels = Number(audio["channels"]) || undefined;
  }
  return info;
}

export interface ExtractAudioOptions {
  /** target sample rate (Hz). Default 16000 (speech-model standard). */
  sampleRate?: number;
  /** channels: 1 (mono) default, 2 (stereo, e.g. for L/R diarization hint). */
  channels?: number;
  /** output container/codec inferred from extension; default mp3. */
  /** start offset seconds (optional clip). */
  startSeconds?: number;
  /** duration seconds (optional clip). */
  durationSeconds?: number;
  /** mp3 bitrate (e.g. "64k"). Default 64k. */
  bitrate?: string;
  overwrite?: boolean;
}

/**
 * Extract (and optionally clip) audio to a compact speech-ready file.
 * Output format determined by `output` extension (.mp3/.opus/.wav/.flac/.m4a).
 */
export async function extractAudio(
  input: string,
  output: string,
  options: ExtractAudioOptions = {}
): Promise<string> {
  const {
    sampleRate = 16000,
    channels = 1,
    startSeconds,
    durationSeconds,
    bitrate = "64k",
    overwrite = true,
  } = options;
  await ensureDir(output);

  const args: string[] = [];
  if (overwrite) args.push("-y");
  // Put -ss before -i for fast seek when clipping (accurate enough for audio).
  if (startSeconds !== undefined) args.push("-ss", String(startSeconds));
  args.push("-i", input);
  if (durationSeconds !== undefined) args.push("-t", String(durationSeconds));
  args.push("-vn", "-ac", String(channels), "-ar", String(sampleRate));

  const ext = output.slice(output.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "mp3") {
    args.push("-c:a", "libmp3lame", "-b:a", bitrate);
  } else if (ext === "opus") {
    args.push("-c:a", "libopus", "-b:a", bitrate);
  } else if (ext === "wav") {
    args.push("-c:a", "pcm_s16le");
  } else if (ext === "flac") {
    args.push("-c:a", "flac");
  } else if (ext === "m4a" || ext === "aac") {
    args.push("-c:a", "aac", "-b:a", bitrate);
  }
  args.push(output);

  const { code, stderr } = await run("ffmpeg", args);
  if (code !== 0) throw new Error(`ffmpeg extractAudio failed (${code}): ${stderr}`);
  return output;
}

export interface KeyframeOptions {
  /** explicit timestamps (seconds) to grab frames at. */
  atSeconds?: number[];
  /** OR evenly spaced count across the whole media. */
  count?: number;
  /** scale longest side to this many px (keep aspect). Default 768. */
  maxSize?: number;
  overwrite?: boolean;
}

/**
 * Extract still keyframes from a video. Returns the list of written file paths.
 * Either pass explicit `atSeconds`, or a `count` (needs total duration).
 */
export async function extractKeyframes(
  input: string,
  outputDir: string,
  options: KeyframeOptions & { durationSeconds?: number } = {}
): Promise<string[]> {
  const { atSeconds, count, maxSize = 768, durationSeconds, overwrite = true } = options;
  await mkdir(outputDir, { recursive: true });

  let times: number[];
  if (atSeconds && atSeconds.length > 0) {
    times = atSeconds;
  } else if (count && durationSeconds) {
    // evenly spaced, avoiding the very start/end
    times = Array.from({ length: count }, (_, i) =>
      Math.max(0.5, ((i + 0.5) / count) * durationSeconds)
    );
  } else {
    throw new Error("extractKeyframes: provide atSeconds, or count + durationSeconds");
  }

  const paths: string[] = [];
  await Promise.all(
    times.map(async (t, i) => {
      const out = join(outputDir, `frame_${String(i).padStart(3, "0")}_${Math.round(t)}s.jpg`);
      const args: string[] = [];
      if (overwrite) args.push("-y");
      args.push(
        "-ss",
        String(t),
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${maxSize},iw)':-2`,
        "-q:v",
        "3",
        out
      );
      const { code, stderr } = await run("ffmpeg", args);
      if (code !== 0) throw new Error(`ffmpeg keyframe @${t}s failed: ${stderr}`);
      paths[i] = out;
    })
  );
  return paths;
}
