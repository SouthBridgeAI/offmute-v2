/**
 * Identify v2: speaker naming with a second opinion.
 *
 * Two different reasoner models name the speakers independently (same prompt), then a
 * deterministic adjudicator merges the answers:
 *  - agreement → adopt (prefer the more complete form of the name);
 *  - disagreement → a candidate stays eligible only if its evidence quote actually
 *    appears in the transcript (hallucinated evidence disqualifies); if the survivors
 *    still disagree, keep the generic label — names are never invented under conflict;
 *  - the self-introduction tripwire ("I'm X" / "my name is X" inside a segment whose
 *    speaker got named Y) breaks ties toward the introduction.
 *
 * Motivating failure (fable baseline run, 2026-07-03): "Hi everyone, I'm Anly,
 * co-founder and CEO…" attributed to an already-named *different* speaker — invisible
 * to WER, obvious to a text check.
 */
import {
  identifySpeakers,
  type IdentifyResult,
  type IdentifySegment,
} from "./identify.js";
import type { SpeakerInfo } from "../core/types.js";
import type { OpenAICompatClient } from "../providers/openai-compat.js";
import { logger } from "../utils/logger.js";

export interface ReasonerHandle {
  client: OpenAICompatClient;
  model: string;
  provider: string;
}

export interface IdentifyV2Decision {
  speakerId: string;
  nameA?: string;
  nameB?: string;
  outcome:
    | "agreed"
    | "a-only"
    | "b-only"
    | "evidence-break"
    | "tripwire"
    | "kept-generic";
  finalName?: string;
  note?: string;
}

export interface IdentifyV2Result {
  nameMap: Record<string, string>;
  decisions: IdentifyV2Decision[];
  tripwires: { speakerId: string; introducedName: string; segmentText: string }[];
  passA: IdentifyResult & { model: string };
  passB?: IdentifyResult & { model: string };
}

/** Normalize for matching: lowercase; apostrophes join ("I'm"→"im"); other
 * punctuation becomes a space ("co-founder"→"co founder"). */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Do two name strings plausibly refer to the same person? */
export function namesMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // One is a subset of the other ("Rishi" vs "Rishi Olickel"), token-wise.
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return [...small].every((t) => big.has(t));
}

/** Does an evidence quote actually appear in the transcript (normalized substring)? */
export function evidenceInTranscript(
  evidence: string | undefined,
  transcript: string,
): boolean {
  if (!evidence) return false;
  const ne = norm(evidence);
  if (ne.length < 8) return false; // too short to mean anything
  return transcript.includes(ne);
}

const INTRO_RE =
  /\b(?:[Mm]y name is|I am|I'm|[Tt]his is)[,\s]+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)/gu;
// Words that follow "I'm ..." constantly without being names (observed live: a
// capitalized mid-sentence "I'm" matched as the *name* "I'm" — pronouns must die here).
const INTRO_STOPWORDS = new Set([
  "i",
  "im",
  "ive",
  "id",
  "ill",
  "you",
  "we",
  "they",
  "he",
  "she",
  "it",
  "so",
  "not",
  "just",
  "here",
  "there",
  "going",
  "gonna",
  "really",
  "very",
  "also",
  "still",
  "sure",
  "sorry",
  "happy",
  "glad",
  "excited",
  "curious",
  "the",
  "a",
  "an",
  "okay",
  "ok",
  "now",
  "like",
  "actually",
  "basically",
  "kind",
  "sort",
  "definitely",
]);

/** Find self-introductions: segments where the speaker states their own name. */
export function findSelfIntroductions(
  segments: { speaker: string; text: string }[],
): { speakerId: string; introducedName: string; segmentText: string }[] {
  const out: { speakerId: string; introducedName: string; segmentText: string }[] = [];
  for (const seg of segments) {
    for (const m of seg.text.matchAll(INTRO_RE)) {
      const name = m[1]!.trim();
      const tokens = name.split(/\s+/).map((t) => t.toLowerCase().replace(/['’]/g, ""));
      if (tokens.some((t) => INTRO_STOPWORDS.has(t))) continue;
      if (name.replace(/[^\p{L}]/gu, "").length < 3) continue; // too short to be a name
      out.push({
        speakerId: seg.speaker,
        introducedName: name,
        segmentText: seg.text.slice(0, 160),
      });
    }
  }
  return out;
}

function pickCompleteName(a?: string, b?: string): string {
  if (!a) return b ?? "";
  if (!b) return a;
  return b.trim().split(/\s+/).length > a.trim().split(/\s+/).length
    ? b.trim()
    : a.trim();
}

interface Candidate {
  name?: string;
  evidence?: string;
  confidence?: string;
}

/** Deterministic adjudication of the two passes for one speaker. */
export function adjudicate(
  speakerId: string,
  a: Candidate,
  b: Candidate | undefined,
  transcriptNorm: string,
  intro: string | undefined,
): IdentifyV2Decision {
  const base: IdentifyV2Decision = {
    speakerId,
    nameA: a.name,
    nameB: b?.name,
    outcome: "kept-generic",
  };
  const aName = a.name?.trim() || undefined;
  const bName = b?.name?.trim() || undefined;

  // Single-pass mode (no B): trust A, but check evidence when it disagrees with an intro.
  if (b === undefined) {
    if (!aName) return base;
    return { ...base, outcome: "a-only", finalName: aName };
  }

  if (aName && bName && namesMatch(aName, bName)) {
    return { ...base, outcome: "agreed", finalName: pickCompleteName(aName, bName) };
  }

  // The tripwire outranks the models: a self-introduction is the strongest evidence.
  if (intro) {
    if (aName && namesMatch(aName, intro))
      return { ...base, outcome: "tripwire", finalName: aName, note: `intro "${intro}"` };
    if (bName && namesMatch(bName, intro))
      return { ...base, outcome: "tripwire", finalName: bName, note: `intro "${intro}"` };
    // Neither pass matches a stated introduction — adopt the introduced name itself.
    return {
      ...base,
      outcome: "tripwire",
      finalName: intro,
      note: `intro "${intro}" overrode both passes`,
    };
  }

  if (aName && !bName) return { ...base, outcome: "a-only", finalName: aName };
  if (bName && !aName) return { ...base, outcome: "b-only", finalName: bName };

  // Real disagreement: only evidence that exists in the transcript keeps a candidate alive.
  const aOk = evidenceInTranscript(a.evidence, transcriptNorm);
  const bOk = evidenceInTranscript(b.evidence, transcriptNorm);
  if (aOk && !bOk)
    return {
      ...base,
      outcome: "evidence-break",
      finalName: aName,
      note: "B evidence not in transcript",
    };
  if (bOk && !aOk)
    return {
      ...base,
      outcome: "evidence-break",
      finalName: bName,
      note: "A evidence not in transcript",
    };
  return {
    ...base,
    outcome: "kept-generic",
    note: "disagreement unresolved — not inventing a name",
  };
}

export interface IdentifyV2Options {
  roster: string;
  knownSpeakers?: string[];
  /** Skip the second pass ("single") — one reasoner, tripwire still active. */
  mode?: "dual" | "single";
  /** Tentative names from the transcription labels (unverified, possibly swapped). */
  nameHints?: Record<string, string>;
}

export async function identifySpeakersV2(
  reasonerA: ReasonerHandle,
  reasonerB: ReasonerHandle | null,
  segments: IdentifySegment[],
  speakers: SpeakerInfo[],
  opts: IdentifyV2Options,
): Promise<IdentifyV2Result> {
  const mode = opts.mode ?? "dual";
  const runPass = (r: ReasonerHandle) =>
    identifySpeakers(
      r.client,
      r.model,
      segments,
      speakers,
      opts.roster,
      opts.knownSpeakers,
      opts.nameHints,
    );

  const wantB = mode === "dual" && reasonerB !== null;
  const [resA, resB] = await Promise.all([
    runPass(reasonerA),
    wantB ? runPass(reasonerB!) : Promise.resolve(undefined),
  ]);

  const transcriptNorm = norm(segments.map((s) => s.text).join(" "));
  const tripwires = findSelfIntroductions(segments);
  // One introduction per speaker id (first wins); ignore intros for speakers with
  // multiple conflicting intros (e.g. someone reading out other people's names).
  const introBySpeaker = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const t of tripwires) {
    const prev = introBySpeaker.get(t.speakerId);
    if (prev && !namesMatch(prev, t.introducedName)) conflicted.add(t.speakerId);
    else introBySpeaker.set(t.speakerId, t.introducedName);
  }
  for (const id of conflicted) introBySpeaker.delete(id);

  const byIdA = new Map(resA.speakers.map((s) => [s.id, s]));
  const byIdB = resB ? new Map(resB.speakers.map((s) => [s.id, s])) : undefined;

  const decisions: IdentifyV2Decision[] = [];
  const nameMap: Record<string, string> = {};
  for (const sp of speakers) {
    const a = byIdA.get(sp.id) ?? { name: resA.nameMap[sp.id] };
    const b = byIdB ? (byIdB.get(sp.id) ?? { name: resB!.nameMap[sp.id] }) : undefined;
    const d = adjudicate(
      sp.id,
      a ?? {},
      wantB ? (b ?? {}) : undefined,
      transcriptNorm,
      introBySpeaker.get(sp.id),
    );
    decisions.push(d);
    if (d.finalName) nameMap[sp.id] = d.finalName;
  }

  for (const d of decisions) {
    if (d.outcome === "kept-generic" && (d.nameA || d.nameB)) {
      logger.info(
        `identify: kept "${d.speakerId}" generic — passes disagreed (${d.nameA ?? "—"} vs ${d.nameB ?? "—"})`,
      );
    } else if (d.outcome === "tripwire") {
      logger.info(
        `identify: "${d.speakerId}" → ${d.finalName} (self-introduction tripwire)`,
      );
    }
  }

  return {
    nameMap,
    decisions,
    tripwires,
    passA: { ...resA, model: reasonerA.model },
    passB: resB ? { ...resB, model: reasonerB!.model } : undefined,
  };
}
