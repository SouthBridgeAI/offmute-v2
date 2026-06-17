/** Timestamp helpers. Browser-safe (no node deps). */

/** seconds -> "HH:MM:SS,mmm" (SRT style, comma decimal). */
export function secondsToSrtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  // rounding can push ms to 1000
  let carrySecs = secs;
  let carryMin = minutes;
  let carryHrs = hours;
  let outMs = ms;
  if (outMs === 1000) {
    outMs = 0;
    carrySecs += 1;
  }
  if (carrySecs === 60) {
    carrySecs = 0;
    carryMin += 1;
  }
  if (carryMin === 60) {
    carryMin = 0;
    carryHrs += 1;
  }
  return (
    `${String(carryHrs).padStart(2, "0")}:` +
    `${String(carryMin).padStart(2, "0")}:` +
    `${String(carrySecs).padStart(2, "0")},` +
    `${String(outMs).padStart(3, "0")}`
  );
}

/** "HH:MM:SS,mmm" or "HH:MM:SS.mmm" or "MM:SS" -> seconds. */
export function srtTimeToSeconds(timestamp: string): number {
  const t = timestamp.trim().replace(",", ".");
  const [hms = "", frac] = t.split(".");
  const parts = hms.split(":").map((p) => parseInt(p, 10));
  let hours = 0;
  let minutes = 0;
  let secs = 0;
  if (parts.length === 3) {
    [hours, minutes, secs] = parts as [number, number, number];
  } else if (parts.length === 2) {
    [minutes, secs] = parts as [number, number];
  } else if (parts.length === 1) {
    [secs] = parts as [number];
  }
  const fracSecs = frac ? parseFloat(`0.${frac}`) : 0;
  return hours * 3600 + minutes * 60 + secs + fracSecs;
}

/** "mm:ss" relative timestamp -> seconds, or null. Tolerates "h:mm:ss" too. */
export function relTimeToSeconds(timeStr: string): number | null {
  const parts = timeStr.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n))) return null;
  if (nums.length === 2) {
    const [m, s] = nums as [number, number];
    return m * 60 + s;
  }
  const [h, m, s] = nums as [number, number, number];
  return h * 3600 + m * 60 + s;
}

/** seconds -> "M:SS" compact (for markdown headers). */
export function secondsToCompact(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Format "start --> end" SRT timing line. */
export function formatSrtTiming(start: number, end: number): string {
  return `${secondsToSrtTime(start)} --> ${secondsToSrtTime(end)}`;
}
