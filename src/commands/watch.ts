/**
 * `offmute-v2 watch <dir>` — daemon mode: drop media in a folder, get transcripts.
 *
 * Design notes:
 *  - Poll + fs.watch hybrid: fs.watch triggers an early scan, but polling is the source
 *    of truth (fs.watch is unreliable on network mounts / Dropbox).
 *  - A file is enqueued only when its size+mtime are stable across two consecutive
 *    checks — recorders write media slowly, and half-written files must not start jobs.
 *  - Idempotence: `<dir>/.offmute/state.json` records finished inputs by signature
 *    (path+size+mtime). Restarting never reprocesses finished files; a killed job
 *    resumes from the intermediates cache for free.
 *  - Graceful stop: first Ctrl-C aborts the running job at a stage boundary (partials
 *    and cache stay on disk), second Ctrl-C force-exits.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  watch as fsWatch,
  statSync,
  readdirSync,
} from "node:fs";
import { join, extname, basename } from "node:path";
import { transcribe } from "../core/pipeline.js";
import { inputSignature, type PipelineOptions } from "../core/config.js";
import { notify } from "../utils/notify.js";

const MEDIA_EXTS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4a",
  ".mp3",
  ".wav",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".wma",
]);
const POLL_MS = 5000;

interface WatchState {
  /** inputSignature → record */
  done: Record<
    string,
    { file: string; finishedAt: string; segments?: number; error?: string }
  >;
}

export interface WatchCliOptions {
  match?: string;
  jobs: string;
  backlog: boolean;
  output?: string;
  /** Remaining transcribe options forwarded to the pipeline. */
  pipeline: Partial<PipelineOptions>;
}

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export async function runWatch(dir: string, opts: WatchCliOptions): Promise<void> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`✗ not a directory: ${dir}`);
    process.exit(1);
  }
  const stateDir = join(dir, ".offmute");
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "state.json");
  const logPath = join(stateDir, "daemon.log");
  let state: WatchState = { done: {} };
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<WatchState>;
      state = { done: parsed.done ?? {} };
    } catch {
      /* corrupt state file — start fresh (worst case: reprocess) */
    }
  }
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

  const log = (line: string) => {
    console.log(`[${ts()}] ${line}`);
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* log file is best-effort */
    }
  };

  const matchExts = opts.match
    ? new Set(
        opts.match.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()),
      )
    : MEDIA_EXTS;

  // --- discovery ---------------------------------------------------------
  const seenSizes = new Map<string, { size: number; mtimeMs: number }>(); // readiness tracking
  const queued = new Set<string>();
  const queue: string[] = [];
  let processed = 0;

  const listCandidates = (): string[] => {
    try {
      return readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .filter((f) => matchExts.has(extname(f).toLowerCase()))
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  };

  const scan = (isFirst = false) => {
    for (const file of listCandidates()) {
      if (queued.has(file)) continue;
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (st.size === 0) continue;
      const sig = inputSignature(file);
      if (state.done[sig]) continue; // already processed this exact file
      if (isFirst && !opts.backlog) {
        // --no-backlog: pre-existing files are recorded as skipped, not processed.
        state.done[sig] = {
          file: basename(file),
          finishedAt: new Date().toISOString(),
          error: "skipped (pre-existing, --no-backlog)",
        };
        continue;
      }
      const prev = seenSizes.get(file);
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        queued.add(file);
        queue.push(file);
        log(
          `queued   ${basename(file)}  (${(st.size / 1e6).toFixed(0)}MB, queue: ${queue.length})`,
        );
      } else {
        seenSizes.set(file, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    if (isFirst && !opts.backlog) saveState();
  };

  // --- worker -------------------------------------------------------------
  let stopping = false;
  const controller = { current: null as AbortController | null };
  const jobs = Math.max(1, parseInt(opts.jobs, 10) || 1);
  let active = 0;

  const pump = async (): Promise<void> => {
    while (!stopping && active < jobs && queue.length > 0) {
      const file = queue.shift()!;
      active++;
      void runJob(file).finally(() => {
        active--;
        void pump();
      });
    }
  };

  const runJob = async (file: string): Promise<void> => {
    const name = basename(file);
    const abort = new AbortController();
    controller.current = abort;
    log(`start    ${name}`);
    const t0 = Date.now();
    try {
      const result = await transcribe({
        ...opts.pipeline,
        input: file,
        outputDir: opts.output,
        signal: abort.signal,
        showProgress: false,
      });
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      const cost = result.metadata.cost
        ? ` · ~$${result.metadata.cost.actualUsd.toFixed(2)}`
        : "";
      state.done[inputSignature(file)] = {
        file: name,
        finishedAt: new Date().toISOString(),
        segments: result.segments.length,
      };
      saveState();
      processed++;
      log(
        `done     ${name} · ${result.segments.length} segments · ${result.speakers.length} speakers${cost} · ${mins}m`,
      );
      notify(
        "offmute-v2 watch",
        `${name} transcribed — ${result.segments.length} segments${cost}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (abort.signal.aborted) {
        // Aborted jobs stay unrecorded: the next daemon start re-queues and the
        // intermediates cache resumes the work already paid for.
        log(`stopped  ${name} (will resume on next start)`);
        return;
      }
      state.done[inputSignature(file)] = {
        file: name,
        finishedAt: new Date().toISOString(),
        error: msg,
      };
      saveState();
      log(`FAILED   ${name} — ${msg}`);
      notify("offmute-v2 watch", `${name} FAILED — ${msg.slice(0, 80)}`);
    } finally {
      queued.delete(file);
      controller.current = null;
    }
  };

  // --- lifecycle ----------------------------------------------------------
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\nforce exit.");
      process.exit(1);
    }
    stopping = true;
    log(
      `stopping — ${controller.current ? "finishing current stage, " : ""}state saved. (Ctrl-C again to force)`,
    );
    controller.current?.abort();
    // Exit once the active job unwinds.
    const wait = setInterval(() => {
      if (active === 0) {
        clearInterval(wait);
        log(`daemon stopped · ${processed} file(s) processed this session`);
        process.exit(0);
      }
    }, 200);
  });

  log(
    `watching ${dir}  (exts: ${[...matchExts].join(" ")}, jobs: ${jobs}${opts.backlog ? "" : ", backlog skipped"})`,
  );
  scan(true);
  void pump();

  // fs.watch nudges an early scan; polling remains the source of truth.
  try {
    fsWatch(dir, () => {
      if (!stopping) {
        scan();
        void pump();
      }
    });
  } catch {
    /* fs.watch unsupported — polling covers it */
  }
  setInterval(() => {
    if (!stopping) {
      scan();
      void pump();
    }
  }, POLL_MS);

  // Keep the process alive forever (intervals do that already; this is explicit).
  await new Promise(() => {});
}
