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

## The optional panel

`dsh-anyplugin-ui` is a second artifact (D61), not part of the root tarball.
It has its own budget: `npm run check:ui` refuses a panel tarball above
64 KiB, and `npm run pack:ui` produces the publishable tarball (the staging
step rewrites `exports["."]` to the built `lib/index.js`). The release
workflow publishes only the root package today; the first panel publish needs
a maintainer's one-time 2FA approval (tracked in `docs/TODO.md`), and wiring a
second OIDC publish is a release-workflow change, not a laptop publish.

## After the workflow

The job publishes with `npm publish --provenance --access public` using
`id-token: write`; there is no `NODE_AUTH_TOKEN` in the environment and the
workflow asserts that before publishing.

Verify from the registry, not from the log, and **run what the registry
serves**:

```bash
node scripts/verify-release.mjs --version <version>
```

It reads the registry document (the version exists, and
`dist.attestations.provenance.predicateType` is `https://slsa.dev/provenance/v1`),
packs the published tarball with `npm pack`, unpacks it, and runs *its*
`lib/cli.js report` on `fixtures/claude-skills-only`. The report's own facts
are the claim: `ok`, the fixture's plugin name, the `claude-code` pin, at
least one component, and a surface and class on every component. Exit 1 lists
each claim that did not hold. The script is not part of `verify` — it reaches
the network; it is the post-publish step.

Run it from outside the checkout. Inside one, `npx dsh-anyplugin@<version>`
resolves the workspace bin, whose `lib/cli.js` only exists after a build, and
the same command fails with `dsh-anyplugin: command not found`.

`npm view` may serve a cached manifest; the script reads the registry over
`fetch`, which does not.

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
