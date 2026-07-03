/**
 * `offmute-v2 rename <media-or-json> "Old=New" [...]` — retcon speaker names without
 * reprocessing (meeting-diary heritage: fixing one name shouldn't cost a rerun).
 *
 * Accepts either the transcript JSON or the ORIGINAL MEDIA FILE: every run caches its
 * full result in the per-input intermediates dir, so `offmute-v2 rename meeting.mp4
 * "Speaker B=Jay"` finds the cache, applies the mapping, and rewrites the outputs
 * next to the media — no --formats json required at transcription time.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { TranscriptResult } from "../core/types.js";
import { deriveIntermediatesDir, inputSignature } from "../core/config.js";
import { formatSrt, formatMarkdown, formatText } from "../finalize/format.js";
import { formatHtml } from "../finalize/html.js";

export interface RenameOptions {
  formats: string; // comma list: md,srt,txt,html (json rewritten when given a json)
  mdStyle?: "merged" | "turns";
  output?: string;
  /** Cache dir override — needed when the run used -i. */
  intermediates?: string;
}

interface Source {
  result: TranscriptResult;
  /** Where regenerated formats go. */
  outDir: string;
  /** Base name for output files. */
  base: string;
  /** JSON file to rewrite (the given json, or the cache's result.json). */
  jsonPath: string;
}

function loadSource(path: string, opts: RenameOptions): Source {
  if (path.endsWith(".json")) {
    return {
      result: JSON.parse(readFileSync(path, "utf-8")) as TranscriptResult,
      outDir: opts.output ?? dirname(resolve(path)),
      base: basename(path, ".json"),
      jsonPath: path,
    };
  }

  // Media file → look up the run's cache.
  const cacheDir = opts.intermediates ?? deriveIntermediatesDir(path);
  const resultPath = join(cacheDir, "result.json");
  const sourcePath = join(cacheDir, "source.json");
  if (!existsSync(resultPath)) {
    console.error(`✗ no cached transcript found for ${basename(path)}`);
    console.error(
      `  the cache lives in the OS temp dir and may have been cleaned up.\n` +
        `  re-run first:  offmute-v2 "${path}"   (then rename again — naming is cached)`,
    );
    process.exit(1);
  }
  // The cache must belong to THIS file (same path+size+mtime) — otherwise we'd
  // happily rename a previous file's transcript.
  try {
    const src = JSON.parse(readFileSync(sourcePath, "utf-8")) as { signature?: string };
    if (src.signature && src.signature !== inputSignature(path)) {
      console.error(
        `✗ the cached transcript is from an older version of ${basename(path)}`,
      );
      console.error(`  re-run first:  offmute-v2 "${path}"`);
      process.exit(1);
    }
  } catch {
    /* no source manifest — proceed on result.json alone */
  }
  const ext = path.slice(path.lastIndexOf("."));
  return {
    result: JSON.parse(readFileSync(resultPath, "utf-8")) as TranscriptResult,
    outDir: opts.output ?? dirname(resolve(path)),
    base: basename(path, ext),
    jsonPath: resultPath,
  };
}

export function runRename(path: string, mappings: string[], opts: RenameOptions): void {
  const { result, outDir, base, jsonPath } = loadSource(path, opts);

  const map = new Map<string, string>();
  for (const m of mappings) {
    const eq = m.indexOf("=");
    if (eq <= 0) {
      console.error(`✗ bad mapping "${m}" — expected "Old Name=New Name"`);
      process.exit(1);
    }
    map.set(m.slice(0, eq).trim(), m.slice(eq + 1).trim());
  }

  // Match against id, current display name, or identified name — whatever the user sees.
  const applied = new Set<string>();
  const renameOf = (s: {
    speaker?: string;
    speakerName?: string;
    id?: string | number;
    name?: string;
  }) => {
    for (const key of [
      s.speakerName,
      s.name,
      s.speaker,
      typeof s.id === "string" ? s.id : undefined,
    ]) {
      if (key && map.has(key)) {
        applied.add(key);
        return map.get(key)!;
      }
    }
    return null;
  };

  for (const seg of result.segments) {
    const to = renameOf(seg);
    if (to) seg.speakerName = to;
  }
  for (const sp of result.speakers) {
    const to = renameOf(sp);
    if (to) sp.name = to;
  }

  const missed = [...map.keys()].filter((k) => !applied.has(k));
  if (missed.length) {
    const known = [
      ...new Set(result.speakers.flatMap((s) => [s.id, s.name]).filter(Boolean)),
    ].join(", ");
    console.error(
      `✗ no speaker matched: ${missed.join(", ")}\n  known speakers: ${known}`,
    );
    process.exit(1);
  }

  writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  // Keep the identify cache in agreement, or a later re-run (e.g. for another
  // format) would resurrect the pre-rename names from it.
  const idPath = join(dirname(jsonPath), "identified.json");
  if (basename(jsonPath) === "result.json" && existsSync(idPath)) {
    try {
      const id = JSON.parse(readFileSync(idPath, "utf-8")) as {
        nameMap?: Record<string, string>;
      };
      id.nameMap ??= {};
      for (const sp of result.speakers) {
        if (sp.name && sp.name !== sp.id) id.nameMap[sp.id] = sp.name;
      }
      writeFileSync(idPath, JSON.stringify(id, null, 2));
    } catch {
      /* cache patch is best-effort */
    }
  }
  const formats = opts.formats.split(",").map((f) => f.trim());
  const written: string[] = [];
  const write = (name: string, contents: string) => {
    const p = join(outDir, name);
    writeFileSync(p, contents);
    written.push(p);
  };
  if (formats.includes("md"))
    write(`${base}.md`, formatMarkdown(result, { title: base, mdStyle: opts.mdStyle }));
  if (formats.includes("srt")) write(`${base}.srt`, formatSrt(result, { title: base }));
  if (formats.includes("txt")) write(`${base}.txt`, formatText(result, { title: base }));
  if (formats.includes("html"))
    write(`${base}.html`, formatHtml(result, { title: base }));
  if (formats.includes("json") && jsonPath !== join(outDir, `${base}.json`)) {
    write(`${base}.json`, JSON.stringify(result, null, 2));
  }

  console.log(`Renamed ${applied.size} speaker(s).`);
  for (const p of written) console.log(`  → ${p}`);
}
