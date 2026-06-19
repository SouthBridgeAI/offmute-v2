# Releasing offmute-v2

This repo ships **one npm package (`offmute-v2`)** built by two different models, kept on two
branches with **independent histories**:

| Branch | Build | npm dist-tag(s) | Installed by |
|--------|-------|-----------------|--------------|
| `glm`  | GLM build — **primary**, daily-driven | `latest` **and** `glm` | `npm i offmute-v2` / `offmute-v2@glm` |
| `opus` | Opus build — preserved for receipts/comparison | `opus` | `offmute-v2@opus` |

`glm` is the default branch. Both branches publish the same package name and the same
`offmute-v2` CLI binary; only the dist-tag and version differ, so all three of
`offmute-v2`, `offmute-v2@glm`, and `offmute-v2@opus` resolve.

## Versioning

npm versions must be unique per publish, so the two lines never collide:

- **glm** uses normal semver and owns `latest`: `1.0.0`, `1.0.1`, …
- **opus** uses an `-opus.N` prerelease so it can never accidentally become `latest`:
  `1.0.0-opus.0`, `1.0.0-opus.1`, … Bump the prerelease counter per opus publish.

## Publish the primary (GLM → `latest` + `glm`)

```bash
git checkout glm
npm ci
npm run typecheck && npm run lint && npm test
npm run build                 # tsup → dist/ (node + browser)
npm publish                   # publishes the current version as @latest
npm dist-tag add offmute-v2@$(node -p "require('./package.json').version") glm
```

(`npm publish` tags `latest` by default; the second line also points `glm` at the same
version, so `offmute-v2@glm` always tracks the primary build.)

## Publish the secondary (Opus → `opus`)

```bash
git checkout opus
# bump version to the next 1.0.0-opus.N first
npm ci && npm run build
npm publish --tag opus        # never touches @latest because it's a prerelease + explicit tag
```

## Verify

```bash
npm dist-tag ls offmute-v2
# expect: latest -> 1.0.0   glm -> 1.0.0   opus -> 1.0.0-opus.0
npx offmute-v2@glm --help
npx offmute-v2@opus --help
```

## GitHub

After pushing, set the repo's **default branch to `glm`** in Settings → Branches. Keep `opus`
as a long-lived branch (it shares no history with `glm` by design — it's a separate build, not a
feature branch).
