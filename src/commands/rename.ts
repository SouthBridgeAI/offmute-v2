/**
 * `offmute-v2 rename <result.json> "Old=New" [...]` — retcon speaker names without
 * reprocessing. Applies the mapping to the saved JSON result and regenerates the
 * text formats from it (meeting-diary heritage: fixing one name shouldn't cost a rerun).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TranscriptResult } from "../core/types.js";
import { formatSrt, formatMarkdown, formatText } from "../finalize/format.js";

export interface RenameOptions {
  formats: string; // comma list: md,srt,txt (json always rewritten)
  mdStyle?: "merged" | "turns";
}

export function runRename(jsonPath: string, mappings: string[], opts: RenameOptions): void {
  const result = JSON.parse(readFileSync(jsonPath, "utf-8")) as TranscriptResult;

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
  const renameOf = (s: { speaker?: string; speakerName?: string; id?: string | number; name?: string }) => {
    for (const key of [s.speakerName, s.name, s.speaker, typeof s.id === "string" ? s.id : undefined]) {
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
    console.error(`✗ no speaker matched: ${missed.join(", ")}\n  known speakers: ${known}`);
    process.exit(1);
  }

  const dir = dirname(jsonPath);
  const base = basename(jsonPath, ".json");
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  const formats = opts.formats.split(",").map((f) => f.trim());
  if (formats.includes("md"))
    writeFileSync(join(dir, `${base}.md`), formatMarkdown(result, { title: base, mdStyle: opts.mdStyle }));
  if (formats.includes("srt"))
    writeFileSync(join(dir, `${base}.srt`), formatSrt(result, { title: base }));
  if (formats.includes("txt"))
    writeFileSync(join(dir, `${base}.txt`), formatText(result, { title: base }));

  console.log(
    `Renamed ${applied.size} speaker(s); rewrote ${base}.json${formats.length ? " + " + formats.join("/") : ""}.`,
  );
}
