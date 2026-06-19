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

## How publishing works (npm Trusted Publishing / OIDC)

Releases are published by `.github/workflows/publish.yml` using **npm Trusted Publishing**
(OpenID Connect) — no `NPM_TOKEN` stored anywhere. The workflow detects the build from the
package.json version at the released commit:

- version `X.Y.Z`        → `npm publish` (→ `@latest`) + `npm dist-tag add … glm`
- version `X.Y.Z-opus.N`  → `npm publish --tag opus`

It runs with `id-token: write`, Node 24 + npm ≥ 11.5.1, `--provenance` (the repo is public),
and no `NODE_AUTH_TOKEN`.

### One-time bootstrap (required — OIDC cannot create a brand-new package)

The package must exist on npm before a trusted publisher can be attached. Do this **once**,
locally, signed in to the npm account that owns `offmute-v2` (with 2FA):

```bash
# 1) GLM build → claims the name, sets @latest and @glm
git checkout glm && npm ci && npm run build
npm publish --access public                                   # → @latest  (NO --provenance locally)
npm dist-tag add "offmute-v2@$(node -p "require('./package.json').version")" glm

# 2) Opus build → @opus
git checkout opus && bun install && bun run build
npm publish --access public --tag opus
```

### Configure the trusted publisher (once, on npmjs.com)

Packages → **offmute-v2** → Settings → **Trusted publishing** → GitHub Actions:

| Field | Value |
|-------|-------|
| Organization or user | `SouthBridgeAI` |
| Repository | `offmute-v2` |
| Workflow filename | `publish.yml` |
| Environment | *(leave blank)* |

Then set **Publishing access → "Require two-factor authentication and disallow tokens"** so the
trusted workflow is the only automated path.

### Every release after that

1. Bump the version on the branch (`glm`: `1.0.1`; `opus`: `1.0.0-opus.1`), commit, push.
2. Create a **GitHub Release** whose tag points at that commit.
3. `publish.yml` runs and publishes with the right dist-tag + provenance.

## Verify

```bash
npm dist-tag ls offmute-v2
# expect e.g.: latest -> 1.0.0   glm -> 1.0.0   opus -> 1.0.0-opus.0
npx offmute-v2@glm --help
npx offmute-v2@opus --help
```
