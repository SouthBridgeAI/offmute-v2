/**
 * HTML output: one self-contained file (no JS frameworks, no network) — the
 * shareable "here's the meeting" artifact. Speaker-colored merged paragraphs,
 * sticky legend, tone as subtle badges, click a timestamp to copy it.
 */
import type { Segment, TranscriptResult } from "../core/types.js";
import { formatDuration } from "../utils/time.js";
import { compactTime } from "./format.js";

const PALETTE = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#be185d",
  "#4d7c0f",
  "#b45309",
  "#6d28d9",
];

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function groupBySpeaker(segments: Segment[]): Segment[][] {
  const groups: Segment[][] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    const key = (s: Segment) => s.speakerName || s.speaker;
    if (last && key(last[0]!) === key(seg)) last.push(seg);
    else groups.push([seg]);
  }
  return groups;
}

export function formatHtml(
  result: TranscriptResult,
  opts: { title?: string } = {},
): string {
  const title = opts.title || "Transcript";
  const colorOf = new Map<string, string>();
  result.speakers.forEach((sp, i) => {
    colorOf.set(sp.name || sp.id, PALETTE[i % PALETTE.length]!);
  });
  const color = (name: string) => colorOf.get(name) ?? "#64748b";

  const legend = result.speakers
    .map((sp) => {
      const name = sp.name || sp.id;
      const talk = sp.talkTime ? ` · ${formatDuration(Math.round(sp.talkTime))}` : "";
      return `<span class="who"><i style="background:${color(name)}"></i>${esc(name)}<small>${talk}</small></span>`;
    })
    .join("");

  const paragraphs = groupBySpeaker(result.segments)
    .map((group) => {
      const first = group[0]!;
      const name = first.speakerName || first.speaker;
      let lastTone = "";
      const body = group
        .map((s) => {
          const toneStr = s.tone?.length ? s.tone.join(", ") : "";
          const badge =
            toneStr && toneStr !== lastTone
              ? `<em class="tone">${esc(toneStr)}</em> `
              : "";
          lastTone = toneStr;
          return `${badge}${esc(s.text)}`;
        })
        .join(" ");
      return `<div class="turn" style="border-color:${color(name)}">
  <div class="meta"><b style="color:${color(name)}">${esc(name)}</b><time data-t="${compactTime(first.start)}" title="click to copy">${compactTime(first.start)}</time></div>
  <p>${body}</p>
</div>`;
    })
    .join("\n");

  const m = result.metadata;
  const cost = m.cost ? ` · ~$${m.cost.actualUsd.toFixed(2)}` : "";
  const footer = `${esc(m.models.transcribe ?? "")} + ${esc(m.models.timestamped ?? "")}${cost} · ${new Date(m.processedAt).toLocaleDateString()}`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#ffffff;--fg:#1e293b;--muted:#64748b;--line:#e2e8f0;--chip:#f1f5f9}
@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--chip:#1e293b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.5rem;margin:0 0 .25rem}
.sub{color:var(--muted);font-size:.9rem;margin-bottom:1rem}
header.legend{position:sticky;top:0;background:var(--bg);padding:.6rem 0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.4rem .9rem;z-index:1}
.who{display:inline-flex;align-items:center;gap:.4rem;font-size:.85rem}
.who i{width:.65rem;height:.65rem;border-radius:50%;display:inline-block}
.who small{color:var(--muted)}
.turn{border-left:3px solid;padding:.15rem 0 .15rem 1rem;margin:1.1rem 0}
.turn .meta{display:flex;align-items:baseline;gap:.6rem;font-size:.85rem}
.turn time{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:.78rem;cursor:pointer}
.turn time:hover{text-decoration:underline}
.turn p{margin:.25rem 0 0}
.tone{background:var(--chip);color:var(--muted);border-radius:.5rem;padding:0 .45rem;font-size:.75rem;font-style:italic;white-space:nowrap}
footer{margin-top:3rem;color:var(--muted);font-size:.8rem;border-top:1px solid var(--line);padding-top:1rem}
</style>
<main>
<h1>${esc(title)}</h1>
<div class="sub">${formatDuration(m.duration)} · ${result.speakers.length} speakers · ${result.segments.length} turns</div>
<header class="legend">${legend}</header>
${paragraphs}
<footer>${footer}</footer>
</main>
<script>
document.querySelectorAll("time").forEach(t=>t.addEventListener("click",()=>{
  navigator.clipboard&&navigator.clipboard.writeText(t.dataset.t);
  const o=t.textContent;t.textContent="copied";setTimeout(()=>t.textContent=o,700);
}));
</script>
</html>
`;
}
