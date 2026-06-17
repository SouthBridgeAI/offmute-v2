/**
 * Time + timestamp utilities. Ported & cleaned from ipgu (proven, robust).
 * Handles SRT `HH:MM:SS,mmm` and relative `mm:ss` formats.
 */

/** Seconds → `HH:MM:SS,mmm` (SRT timestamp). */
export function secondsToTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const ms = Math.floor((clamped % 1) * 1000);
  return (
    `${hours.toString().padStart(2, "0")}:` +
    `${minutes.toString().padStart(2, "0")}:` +
    `${secs.toString().padStart(2, "0")},` +
    `${ms.toString().padStart(3, "0")}`
  );
}

/** `HH:MM:SS,mmm` or `HH:MM:SS.mmm` → seconds. */
export function timestampToSeconds(timestamp: string): number {
  const timeStr = timestamp.replace(",", ".");
  const [timeWithoutMs, ms] = timeStr.split(".");
  if (!timeWithoutMs) return 0;
  const [hours, minutes, seconds] = timeWithoutMs.split(":").map(Number);
  const h = hours || 0;
  const m = minutes || 0;
  const s = seconds || 0;
  return h * 3600 + m * 60 + s + (ms ? Number(`0.${ms}`) : 0);
}

/** Parse an SRT timing line `00:01:23,456 --> 00:01:45,678`. */
export function parseSrtTiming(
  timingString: string,
): { start: number; end: number } | null {
  const parts = timingString.split("-->");
  if (parts.length !== 2) return null;
  return { start: timestampToSeconds(parts[0]!.trim()), end: timestampToSeconds(parts[1]!.trim()) };
}

/** Format start/end seconds as an SRT timing line. */
export function formatSrtTiming(startSeconds: number, endSeconds: number): string {
  return `${secondsToTimestamp(startSeconds)} --> ${secondsToTimestamp(endSeconds)}`;
}

/** Parse a relative `mm:ss` timestamp → seconds, or null if invalid. */
export function parseMmSs(timeStr: string): number | null {
  const parts = timeStr.split(":");
  if (parts.length !== 2) return null;
  const minutes = parseInt(parts[0]!, 10);
  const seconds = parseInt(parts[1]!, 10);
  if (isNaN(minutes) || isNaN(seconds)) return null;
  if (seconds < 0 || seconds >= 60) return null;
  return minutes * 60 + seconds;
}

/** Human-readable `1h 2m 3s` for durations. */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${remaining}s`);
  return parts.join(" ");
}
