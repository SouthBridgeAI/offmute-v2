/**
 * OS "done" notification — macOS (osascript) and Linux (notify-send), best-effort
 * silent no-op elsewhere or on failure. Used by the CLI for long runs and by the
 * daemon for every finished job.
 */
import { execFile } from "node:child_process";

export function notify(title: string, message: string): void {
  try {
    const esc = (s: string) => s.replace(/["\\]/g, "");
    if (process.platform === "darwin") {
      execFile(
        "osascript",
        ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`],
        () => {},
      );
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, message], () => {});
    }
  } catch {
    /* notifications are decoration */
  }
}
