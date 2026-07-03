import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: "node20",
    platform: "node",
    shims: true,
  },
  {
    // The CLI is ESM-only: it (alone) imports chalk 5, which cannot be require()d.
    // `bin` points at dist/cli.js, so no CJS variant is needed.
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    target: "node20",
    platform: "node",
    shims: true,
  },
  {
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    // Browser build: no node polyfills; fetch/btoa are native.
    env: { NODE_ENV: "production" },
    outExtension: () => ({ js: ".browser.js" }),
    // ffmpeg.wasm peer deps are dynamically imported in-browser; keep them external.
    external: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
]);
