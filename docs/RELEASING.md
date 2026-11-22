# Releasing

A release is a tag on `main`, cut by the maintainer, published by GitHub
Actions over OIDC. Nothing is published from a laptop: `.github/workflows/release.yml`
is the only thing that can push to the registry, and it proves it has no token
that could.

## The train

| version | what it ships |
| --- | --- |
| `0.1.x` | the Claude Code compile path (skills, commands as model-face skills, MCP, hooks, agents, output styles) |
| `0.2.x` | adds the mods kernel to the bundle and serves the `$` surface the upstream mods call |
| `0.3.x` | the Codex portable dialect |
| `1.0.x` | the full declared surface (§0 A–F) with every `planned` row either closed or explicitly refused |

Each release is a branch `release/<minor>` plus a tag; the branch exists so a
patch release can be cut without dragging in `main`'s unfinished work.

## Before you tag

1. `main` is green: the `verify` job passed on the commit you are about to tag.
   The release workflow re-runs it, but a tag on a red commit wastes a tag.
2. Every `planned` row you now claim is backed by a ratified decision, and
   `docs/DECISIONS.md` matches the code (D-entries land before the tag, not
   after).
3. `check:pack` prints the numbers you are willing to defend: tarball size,
   kernel size, and the `dsh` pins in `engines.dsh`.
4. The version in `package.json`, the tag, and any README claim agree. The
   workflow asserts tag == version and refuses otherwise.
5. `CHANGELOG`-style prose lives in the GitHub release, not in this file.

## Tagging

```bash
git checkout main && git pull --ff-only
git tag -a v0.2.0 -m "dsh-anyplugin 0.2.0"
git push origin v0.2.0
```

The tag **must be an ancestor of `origin/main`**. Tagging a merge commit that
only exists on a release branch fails with
`<sha> is not an ancestor of origin/main`; delete the tag, check out `main`
after the merge, and tag again:

```bash
git push --delete origin v0.2.0 && git tag -d v0.2.0
```

## After the workflow

The job publishes with `npm publish --provenance --access public` using
`id-token: write`; there is no `NODE_AUTH_TOKEN` in the environment and the
workflow asserts that before publishing.

Verify from the registry, not from the log:

```bash
curl -s https://registry.npmjs.org/dsh-anyplugin | node -e "…"  # dist-tags.latest, dist.attestations
npx dsh-anyplugin@<version> --help                              # the bin is real
```

`npm view` may serve a cached manifest; `curl` against the registry does not.
A published version carries `dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`.

Then open the GitHub release for the tag and write what changed, in the same
five-class vocabulary the docs use (what is now `exact` / `equivalent` / still
`planned`).

## First publish of a new package name (one time only)

Trusted publishing cannot be configured for a package that does not exist yet,
so the very first version needs a token:

1. publish once with a granular `NPM_TOKEN` that allows publishing;
2. immediately configure the trusted publisher at
   `https://www.npmjs.com/package/<name>/access` (GitHub Actions, owner, repo,
   workflow `release.yml`), then set the package to "Require 2FA and disallow
   tokens";
3. delete the `NPM_TOKEN` secret;
4. `npm run gh-bot -- workflow run npm-trust.yml` asserts the binding and prints
   `npm trust list`.

From then on every release is tag → workflow → provenance, with no secret in
the repository.

## Failure modes we have actually hit

- **Tag on a branch commit.** The workflow refuses; retag on `main`.
- **A staged publish.** If the account still restricts direct publishing, npm
  accepts the upload as a staged version and the package does not appear. The
  escalation is a `[HUMAN]` issue asking for the one 2FA approval; after that,
  configuring trusted publishing makes it permanent.
- **A `latest` dist-tag that points at a placeholder.** Never conclude from
  `latest` alone; check the full version list (D9's lesson).
