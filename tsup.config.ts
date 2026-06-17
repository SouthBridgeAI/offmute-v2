import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", cli: "src/cli.ts" },
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
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    // Browser build: no node polyfills; fetch/btoa are native.
    env: { NODE_ENV: "production" },
    outExtension: () => ({ js: ".browser.js" }),
  },
]);
