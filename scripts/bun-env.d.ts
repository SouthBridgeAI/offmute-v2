// Bun augments import.meta with `dir` and `path`. Declared here so the dev
// scripts (run via `bun run`) typecheck cleanly without pulling bun-types into
// the library build.
interface ImportMeta {
  readonly dir: string;
  readonly path: string;
}
