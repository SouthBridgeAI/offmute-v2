/**
 * AssemblyAI provider — accurate word-level timestamps + speaker diarization over a
 * whole file (no chunking). Universal-2 speech model. Content-hash caching so dev
 * iteration doesn't re-pay upload/transcribe.
 */
import { AssemblyAI, type TranscribeParams, type SpeechModel } from "assemblyai";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TimestampedUtterance, TimestampedWord } from "../core/types.js";
import { logger } from "../utils/logger.js";

/** A word/utterance token from the AssemblyAI transcript response. */
interface AaiWord {
  text: string;
  start?: number | null;
  end?: number | null;
  confidence?: number | null;
}

export interface AssemblyAIOptions {
  apiKey: string;
  /** Directory for hash-keyed cache. If omitted, no caching. */
  cacheDir?: string;
  /** Expected speaker count hint. */
  speakersExpected?: number;
  /** Speech model (default "universal" = Universal-2). */
  speechModel?: string;
}

export interface AssemblyAIResult {
  utterances: TimestampedUtterance[];
  /** Flat word list (all speakers), for alignment. */
  words: TimestampedWord[];
  durationSec: number;
  audioDurationSec?: number;
  speakers: string[];
  transcriptId: string;
  speechModelUsed?: string;
  /** AssemblyAI does its own speaker diarization. */
  hasDiarization: true;
}

async function fileHash(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex").slice(0, 24);
}

export class AssemblyAIProvider {
  private client: AssemblyAI;
  private cacheDir?: string;

  constructor(opts: AssemblyAIOptions) {
    this.client = new AssemblyAI({ apiKey: opts.apiKey });
    this.cacheDir = opts.cacheDir;
    this.speechModel = (opts.speechModel as SpeechModel) ?? "universal";
    this.speakersExpected = opts.speakersExpected;
  }

  private speechModel: SpeechModel;
  private speakersExpected?: number;

  /** Transcribe a local audio file. Returns cached result if available. */
  async transcribe(filePath: string): Promise<AssemblyAIResult> {
    const hash = await fileHash(filePath);
    const cachePath = this.cacheDir ? `${this.cacheDir}/${hash}.json` : undefined;

    if (cachePath && existsSync(cachePath)) {
      logger.info(`[assemblyai] cache hit ${hash}`);
      return JSON.parse(await readFile(cachePath, "utf-8")) as AssemblyAIResult;
    }

    logger.info(`[assemblyai] uploading ${filePath}...`);
    const uploadUrl = await this.client.files.upload(filePath);
    logger.info(`[assemblyai] transcribing (speech_model=${this.speechModel})...`);
    const params: TranscribeParams = {
      audio: uploadUrl,
      speaker_labels: true,
      speech_model: this.speechModel,
    };
    if (this.speakersExpected) params.speakers_expected = this.speakersExpected;

    const transcript = await this.client.transcripts.transcribe(params);
    if (transcript.status === "error") {
      throw new Error(`AssemblyAI error: ${transcript.error}`);
    }

    const result = this.mapTranscript(transcript, hash);
    if (cachePath) {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(result, null, 2));
    }
    logger.info(
      `[assemblyai] done: ${result.utterances.length} utterances, ${result.words.length} words, ${result.speakers.length} speakers`,
    );
    return result;
  }

  private mapTranscript(
    t: {
      id?: string | null;
      audio_duration?: number | null;
      speech_model_used?: string | null;
      utterances?: { speaker: string; text: string; start?: number | null; end?: number | null; confidence?: number | null; words?: AaiWord[] | null }[] | null;
      words?: AaiWord[] | null;
    },
    id: string,
  ): AssemblyAIResult {
    const toWord = (w: AaiWord): TimestampedWord => ({
      text: w.text,
      start: (w.start || 0) / 1000,
      end: (w.end || 0) / 1000,
      confidence: w.confidence ?? undefined,
    });

    const utterances: TimestampedUtterance[] = [];
    const speakers = new Set<string>();
    for (const u of t.utterances || []) {
      const speaker = `speaker_${u.speaker}`;
      speakers.add(speaker);
      utterances.push({
        speaker,
        text: u.text,
        start: (u.start || 0) / 1000,
        end: (u.end || 0) / 1000,
        confidence: u.confidence ?? undefined,
        words: (u.words || []).map(toWord),
      });
    }
    const words: TimestampedWord[] = (t.words || []).map(toWord);
    const durationSec = words.length
      ? (words[words.length - 1]!.end || 0)
      : utterances.length
        ? utterances[utterances.length - 1]!.end
        : 0;

    return {
      utterances,
      words,
      durationSec,
      audioDurationSec: t.audio_duration ?? undefined, // AssemblyAI returns seconds (not ms)
      speakers: [...speakers].sort(),
      transcriptId: t.id ?? id,
      speechModelUsed: t.speech_model_used ?? undefined,
      hasDiarization: true,
    };
  }
}
