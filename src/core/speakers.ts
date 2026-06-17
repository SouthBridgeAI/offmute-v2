/** Speaker canonicalization. Browser-safe (deterministic base; LLM pass lives in pipeline). */
import type { Speaker } from "../types.js";

const PROVISIONAL_RE = /^(speaker|spkr|unknown|unidentified)\b/i;

export function slugLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "speaker"
  );
}

export function isProvisional(label: string): boolean {
  return PROVISIONAL_RE.test(label.trim());
}

export interface BuildSpeakersOptions {
  /** explicit canonical name per raw label (overrides) */
  knownSpeakers?: Record<string, string>;
  /** alias map: raw label -> canonical label (e.g. {"Speaker 1": "Rishi"}) from identify pass */
  aliases?: Record<string, string>;
  /** descriptions per canonical label */
  descriptions?: Record<string, string>;
}

export interface BuiltSpeakers {
  speakers: Speaker[];
  /** raw turn label -> speaker id */
  labelToId: Map<string, string>;
}

/**
 * Build canonical speakers from the raw turn labels (in order of first appearance).
 * Applies aliases (merge provisional labels into a name) and known-speaker overrides.
 */
export function buildSpeakers(rawLabels: string[], options: BuildSpeakersOptions = {}): BuiltSpeakers {
  const { knownSpeakers = {}, aliases = {}, descriptions = {} } = options;

  const labelToId = new Map<string, string>();
  const byId = new Map<string, Speaker>();

  const resolveCanonical = (raw: string): string => {
    // 1. explicit known-speaker name
    if (knownSpeakers[raw]) return knownSpeakers[raw]!;
    // 2. alias (merge) — may chain once
    if (aliases[raw]) {
      const aliased = aliases[raw]!;
      return knownSpeakers[aliased] ?? aliased;
    }
    return raw;
  };

  for (const raw of rawLabels) {
    if (labelToId.has(raw)) continue;
    const canonical = resolveCanonical(raw);
    const id = slugLabel(canonical);
    labelToId.set(raw, id);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: canonical,
        named: !isProvisional(canonical),
        description: descriptions[canonical],
      });
    } else if (descriptions[canonical] && !byId.get(id)!.description) {
      byId.get(id)!.description = descriptions[canonical];
    }
  }

  return { speakers: [...byId.values()], labelToId };
}
