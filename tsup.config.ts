import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Node library + CLI
    entry: { index: "src/index.ts", cli: "src/cli.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node18",
    platform: "node",
    splitting: false,
    banner: { js: "" },
  },
  {
    // Pure browser core (no node deps, no provider SDKs)
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    splitting: false,
  },
]);
