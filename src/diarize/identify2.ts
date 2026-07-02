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
    | "elimination"
    | "conflict-fallback"
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

/** Char edit distance ≤ 1 (one substitution/insertion/deletion). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (s.length === l.length) i++; // substitution
    j++; // insertion in the longer
  }
  return edits + (l.length - j) <= 1;
}

/** Two name tokens are the same if equal, or one edit apart for longer tokens —
 * transcription renders the same spoken name differently across models/passes
 * ("Rishi"/"Hrishi", "Hanjun"/"Hanjin"). Short tokens must match exactly (Jay≠Ray). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && withinOneEdit(a, b);
}

/** Do two name strings plausibly refer to the same person? */
export function namesMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Every token of the shorter name matches some token of the longer one
  // ("Rishi" ⊂ "Hrishi Olickel", fuzzy at the token level).
  const ta = na.split(" ");
  const tb = nb.split(" ");
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((t) => big.some((u) => tokensMatch(t, u)));
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

// First-person introductions only. "[Tt]his is X" is deliberately NOT matched — people
// say "this is Reddit, man" about their screen constantly (live failure: a speaker got
// named "Reddit"), and the phone-intro sense is rare in recorded meetings.
const INTRO_RE =
  /\b(?:[Mm]y name is|I am|I'm)[,\s]+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)/gu;
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
  /** The intro name also appears in the roster / known speakers (safe to adopt alone). */
  introCorroborated = false,
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

  // The tripwire outranks the models WHEN it corroborates one of them: a
  // self-introduction matching a model's answer is the strongest evidence.
  if (intro) {
    if (aName && namesMatch(aName, intro))
      return { ...base, outcome: "tripwire", finalName: aName, note: `intro "${intro}"` };
    if (bName && namesMatch(bName, intro))
      return { ...base, outcome: "tripwire", finalName: bName, note: `intro "${intro}"` };
    // A regex-extracted name that NO model backs is more likely a false positive
    // ("This is Reddit, man" named a speaker "Reddit" live) — only adopt it alone
    // when the roster/known speakers corroborate it.
    if (introCorroborated) {
      return {
        ...base,
        outcome: "tripwire",
        finalName: intro,
        note: `intro "${intro}" corroborated by roster/known speakers`,
      };
    }
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
  /** The recording's filename — meeting recorders often name participants in it. */
  sourceFileName?: string;
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
      opts.sourceFileName,
    );

  const wantB = mode === "dual" && reasonerB !== null;
  const [resA, resB] = await Promise.all([
    runPass(reasonerA),
    wantB ? runPass(reasonerB!) : Promise.resolve(undefined),
  ]);

  // Distinguish "verified: no names in evidence" from "the passes never ran".
  // A transient outage must not masquerade as a considered decision.
  const passFailed = (r: IdentifyResult | undefined) =>
    !!r && r.speakers.length === 0 && /fetch failed|HTTP \d|network|ENOTFOUND|JSON parse|no response/i.test(r.reasoning);
  if (passFailed(resA) && (!wantB || passFailed(resB))) {
    logger.warn(
      `identify: ALL passes failed (${resA.reasoning.slice(0, 80)}) — speakers left as generic labels. ` +
        `Re-run to retry naming cheaply (everything else is cached).`,
    );
  }

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
  // An intro name is "corroborated" when the roster or known speakers mention it —
  // that makes it safe to adopt even when both model passes missed it.
  const corroborationText = norm(`${opts.roster ?? ""} ${(opts.knownSpeakers ?? []).join(" ")}`);
  const isCorroborated = (name: string | undefined): boolean => {
    if (!name) return false;
    const n = norm(name);
    return n.length >= 3 && corroborationText.includes(n);
  };

  const nameMap: Record<string, string> = {};
  for (const sp of speakers) {
    const a = byIdA.get(sp.id) ?? { name: resA.nameMap[sp.id] };
    const b = byIdB ? (byIdB.get(sp.id) ?? { name: resB!.nameMap[sp.id] }) : undefined;
    const intro = introBySpeaker.get(sp.id);
    const d = adjudicate(
      sp.id,
      a ?? {},
      wantB ? (b ?? {}) : undefined,
      transcriptNorm,
      intro,
      isCorroborated(intro),
    );
    decisions.push(d);
    if (d.finalName) nameMap[sp.id] = d.finalName;
  }

  // Coherence: one person cannot be two voices. If two speakers ended up with matching
  // names (e.g. pass A and pass B swapped a name pair and per-speaker evidence breaks
  // resolved BOTH to the same person — observed live: two "Hrishi"s), keep only the
  // strongest claim and demote the rest to generic labels.
  const STRENGTH: Record<IdentifyV2Decision["outcome"], number> = {
    agreed: 4,
    tripwire: 3,
    "evidence-break": 2,
    "a-only": 1,
    "b-only": 1,
    elimination: 1,
    "conflict-fallback": 0,
    "kept-generic": 0,
  };
  const named = decisions.filter((d) => d.finalName);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const di = named[i]!;
      const dj = named[j]!;
      if (!di.finalName || !dj.finalName) continue;
      if (!namesMatch(di.finalName, dj.finalName)) continue;
      const si = STRENGTH[di.outcome];
      const sj = STRENGTH[dj.outcome];
      const losers = si === sj ? [di, dj] : si < sj ? [di] : [dj];
      for (const loser of losers) {
        loser.note = `demoted: "${loser.finalName}" also claimed by another speaker with ${si === sj ? "equal" : "stronger"} evidence`;
        loser.finalName = undefined;
        loser.outcome = "conflict-fallback";
        delete nameMap[loser.speakerId];
      }
    }
  }

  // Elimination: when the user supplied the speaker list and exactly one known name
  // and one unnamed voice remain, the leftover name belongs to the leftover voice.
  if (opts.knownSpeakers?.length) {
    const unusedNames = opts.knownSpeakers.filter(
      (n) => !decisions.some((d) => d.finalName && namesMatch(d.finalName, n)),
    );
    const unnamed = decisions.filter((d) => !d.finalName);
    if (unusedNames.length === 1 && unnamed.length === 1) {
      const d = unnamed[0]!;
      d.finalName = unusedNames[0]!;
      d.outcome = "elimination";
      d.note = `only remaining known speaker`;
      nameMap[d.speakerId] = d.finalName;
      logger.info(`identify: "${d.speakerId}" → ${d.finalName} (by elimination from --speakers)`);
    }
  }

  for (const d of decisions) {
    if (d.outcome === "conflict-fallback") {
      logger.info(`identify: "${d.speakerId}" kept generic — ${d.note}`);
    }
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
