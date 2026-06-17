/** Node-only: hash-keyed intermediates for resume + debugging. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fast media identity key: path + size + mtime (not full-content hash — a 9.6GB
 * file would be slow to read). Good enough to invalidate a per-input cache.
 */
export function mediaKey(filePath: string): string {
  const st = statSync(filePath);
  return createHash("sha256").update(`${filePath}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16);
}

export class Intermediates {
  constructor(public readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  has(name: string): boolean {
    return existsSync(this.path(name));
  }

  readJSON<T>(name: string): T | null {
    const p = this.path(name);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return null;
    }
  }

  writeJSON(name: string, data: unknown): void {
    writeFileSync(this.path(name), JSON.stringify(data, null, 2));
  }

  readText(name: string): string | null {
    const p = this.path(name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  writeText(name: string, data: string): void {
    writeFileSync(this.path(name), data);
  }

  /** Run `producer` unless a cached JSON exists (and cache is enabled). */
  async cachedJSON<T>(name: string, enabled: boolean, producer: () => Promise<T>): Promise<T> {
    if (enabled) {
      const hit = this.readJSON<T>(name);
      if (hit !== null) return hit;
    }
    const result = await producer();
    this.writeJSON(name, result);
    return result;
  }

  async cachedText(name: string, enabled: boolean, producer: () => Promise<string>): Promise<string> {
    if (enabled) {
      const hit = this.readText(name);
      if (hit !== null) return hit;
    }
    const result = await producer();
    this.writeText(name, result);
    return result;
  }
}
