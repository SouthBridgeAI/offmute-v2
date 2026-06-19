/**
 * Optional peer-dep type shims. @ffmpeg/ffmpeg and @ffmpeg/util are browser-only and not
 * installed in the Node dev environment (they're optional peer deps), so we declare them
 * loosely here to keep `tsc` green. The actual modules are dynamically imported at runtime
 * in the browser (see src/browser-ffmpeg.ts) and marked external in the tsup browser build.
 */
declare module "@ffmpeg/ffmpeg" {
  export class FFmpeg {
    load(opts?: Record<string, unknown>): Promise<boolean>;
    writeFile(name: string, data: Uint8Array | string): Promise<boolean>;
    readFile(name: string): Promise<Uint8Array | string>;
    deleteFile(name: string): Promise<boolean>;
    exec(args: string[]): Promise<number>;
    on(event: string, cb: (...args: unknown[]) => void): void;
  }
}
declare module "@ffmpeg/util" {
  export function fetchFile(input: Blob | string): Promise<Uint8Array>;
  export function toBlobURL(url: string, type?: string): Promise<string>;
}
