/**
 * AssemblyAI provider — accurate word-level timestamps + speaker diarization over a
 * whole file (no chunking). Universal-2 speech model. Content-hash caching so dev
 * iteration doesn't re-pay upload/transcribe.
 */
import {
  AssemblyAI,
  type SubmitParams,
  type SpeechModel,
  type Transcript,
} from "assemblyai";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TimestampedUtterance, TimestampedWord } from "../core/types.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

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
  /** Language code (e.g. "ko", "ml"). Omitted: AssemblyAI detects one language per file. */
  language?: string;
  /** Delete the transcript from AssemblyAI once offmute has its own copy (default true).
   * AssemblyAI otherwise keeps transcripts for 30 days; it deletes uploaded audio within
   * 48 hours either way. */
  zeroStorage?: boolean;
  /** API origin (tests, proxies). Default: AssemblyAI's. */
  baseUrl?: string;
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
  /** The language AssemblyAI transcribed in (detected, or the one requested). */
  languageCode?: string;
  /** AssemblyAI does its own speaker diarization. */
  hasDiarization: true;
}

async function fileHash(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex").slice(0, 24);
}

/** What AssemblyAI's text says once a transcript has been deleted. */
const DELETED_TEXT = "Deleted by user.";

/** The job id a run saved at `pendingPath`, if it saved one. */
async function readPendingId(pendingPath: string): Promise<string | undefined> {
  if (!existsSync(pendingPath)) return undefined;
  try {
    return (JSON.parse(await readFile(pendingPath, "utf-8")) as { id?: string }).id;
  } catch {
    return undefined; // a half-written file holds no job
  }
}

export class AssemblyAIProvider {
  private client: AssemblyAI;
  private cacheDir?: string;

  constructor(opts: AssemblyAIOptions) {
    this.client = new AssemblyAI({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
    this.cacheDir = opts.cacheDir;
    this.speechModel = (opts.speechModel as SpeechModel) ?? "universal";
    this.speakersExpected = opts.speakersExpected;
    this.language = opts.language;
    this.zeroStorage = opts.zeroStorage ?? true;
  }

  private speechModel: SpeechModel;
  private speakersExpected?: number;
  private language?: string;
  private zeroStorage: boolean;
  /** Whether the last transcribe() was served from the content-hash cache (no paid call). */
  lastFromCache = false;

  /** Transcribe a local audio file. Returns cached result if available. */
  async transcribe(filePath: string): Promise<AssemblyAIResult> {
    const hash = await fileHash(filePath);
    // The cache key names every request option, so a run with another language or model
    // can't be served this one's words. Before 0.2.0 an unset language meant English and the
    // key was the bare hash; those files don't match the detecting request, so they're left.
    const variant = [
      `lang-${this.language ?? "auto"}`,
      this.speakersExpected && `spk-${this.speakersExpected}`,
      this.speechModel !== "universal" && this.speechModel,
    ]
      .filter(Boolean)
      .join("_");
    const cachePath = this.cacheDir
      ? `${this.cacheDir}/${hash}_${variant}.json`
      : undefined;
    // A job's id is kept beside the cache from its submission until AssemblyAI has deleted
    // it (or, without zero storage, until offmute has its copy). A run stopped in between
    // leaves it, and the next run carries on with that job instead of paying again.
    const pendingPath = cachePath?.replace(/\.json$/, ".pending.json");

    this.lastFromCache = false;
    if (cachePath && existsSync(cachePath)) {
      logger.info(`[assemblyai] cache hit ${hash}`);
      this.lastFromCache = true;
      // Stopped after caching, before the delete went through: finish it.
      if (pendingPath) await this.finish(pendingPath, await readPendingId(pendingPath));
      return JSON.parse(await readFile(cachePath, "utf-8")) as AssemblyAIResult;
    }

    let transcript = pendingPath ? await this.resume(pendingPath) : undefined;
    if (!transcript) {
      logger.info(`[assemblyai] uploading ${filePath}...`);
      // Uploads of large files ride a single long HTTP request — the most likely place
      // for a transient network blip to land (observed live: "fetch failed" mid-upload).
      const uploadUrl = await withRetry("assemblyai upload", () =>
        this.client.files.upload(filePath),
      );
      logger.info(
        `[assemblyai] transcribing (speech_model=${this.speechModel}, language=${this.language ?? "auto-detect"})...`,
      );
      const params: SubmitParams = {
        audio: uploadUrl,
        speaker_labels: true,
        speech_model: this.speechModel,
      };
      if (this.speakersExpected) params.speakers_expected = this.speakersExpected;
      // Left unset, AssemblyAI assumes English: a Korean meeting came back as 31 English words
      // for 9 minutes of speech. So without a language, ask it to detect one per file.
      if (this.language) params.language_code = this.language;
      else params.language_detection = true;

      const job = await withRetry("assemblyai submit", () =>
        this.client.transcripts.submit(params),
      );
      if (pendingPath) {
        await mkdir(dirname(pendingPath), { recursive: true });
        await writeFile(pendingPath, JSON.stringify({ id: job.id }));
      }
      transcript = await withRetry("assemblyai transcribe", () =>
        this.client.transcripts.waitUntilReady(job.id),
      );
    }
    if (transcript.status === "error") {
      if (pendingPath) await rm(pendingPath, { force: true });
      throw new Error(`AssemblyAI error: ${transcript.error}`);
    }

    const result = this.mapTranscript(transcript, hash);
    if (cachePath) {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(result, null, 2));
    }
    logger.info(
      `[assemblyai] done: ${result.utterances.length} utterances, ${result.words.length} words, ${result.speakers.length} speakers, language ${result.languageCode ?? "?"}`,
    );
    // Only after offmute holds its own copy: a failed delete leaves AssemblyAI's 30-day
    // expiry, never a lost transcript.
    if (pendingPath) await this.finish(pendingPath, transcript.id);
    else if (this.zeroStorage && transcript.id) await this.deleteRemote(transcript.id);
    return result;
  }

  /** Delete job `id` from AssemblyAI (with zero storage), then forget it. */
  private async finish(pendingPath: string, id: string | undefined): Promise<void> {
    if (this.zeroStorage && id) await this.deleteRemote(id);
    await rm(pendingPath, { force: true });
  }

  private async deleteRemote(id: string): Promise<void> {
    await this.client.transcripts.delete(id).then(
      () => logger.debug(`[assemblyai] deleted transcript ${id} from AssemblyAI`),
      (err: unknown) =>
        logger.warn(
          `[assemblyai] couldn't delete transcript ${id} from AssemblyAI (it expires in 30 days): ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
  }

  /** The finished job a stopped run left at `pendingPath`, or undefined to send the audio
   * again: when there is none, or AssemblyAI says it's gone (not found, failed, deleted).
   * Anything less certain (offline, an outage, a refused key) is thrown with the job kept,
   * so the next run neither pays twice nor leaves the job behind undeleted. */
  private async resume(pendingPath: string): Promise<Transcript | undefined> {
    const id = await readPendingId(pendingPath);
    if (id) {
      logger.info(`[assemblyai] picking up transcript ${id}, left by a stopped run...`);
      let gone: string | undefined;
      try {
        const t = await withRetry("assemblyai transcribe", () =>
          this.client.transcripts.waitUntilReady(id),
        );
        // A deleted transcript still answers "completed", with its words gone.
        if (t.status === "completed" && t.text !== DELETED_TEXT) return t;
        gone = t.status === "error" ? `it failed: ${t.error}` : "it was deleted";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/not found/i.test(message)) throw err;
        gone = message;
      }
      logger.warn(
        `[assemblyai] transcript ${id} is gone (${gone}) — sending the audio again`,
      );
    }
    await rm(pendingPath, { force: true });
    return undefined;
  }

  private mapTranscript(
    t: {
      id?: string | null;
      audio_duration?: number | null;
      speech_model_used?: string | null;
      language_code?: string | null;
      utterances?:
        | {
            speaker: string;
            text: string;
            start?: number | null;
            end?: number | null;
            confidence?: number | null;
            words?: AaiWord[] | null;
          }[]
        | null;
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
      ? words[words.length - 1]!.end || 0
      : utterances.length
        ? utterances[utterances.length - 1]!.end
        : 0;

    return {
      utterances,
      words,
      durationSec,
      audioDurationSec: t.audio_duration ?? undefined, // AssemblyAI returns seconds (not ms)
      languageCode: t.language_code ?? undefined,
      speakers: [...speakers].sort(),
      transcriptId: t.id ?? id,
      speechModelUsed: t.speech_model_used ?? undefined,
      hasDiarization: true,
    };
  }
}
