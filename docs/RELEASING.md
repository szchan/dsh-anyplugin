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
node scripts/verify-release.mjs --version <version>          # human output
node scripts/verify-release.mjs --version <version> --json   # for a release note
```

It judges three things: the registry (the version is in `versions`, and
`dist.attestations.provenance.predicateType` is `https://slsa.dev/provenance/v1`),
the packed manifest (the tarball's `version`, and the `bin` it declares), and
the packed CLI. For the last one it runs `npm pack`, unpacks the tarball, runs
*that* bin's `report` on `fixtures/claude-skills-only`, and judges the report:
`ok`, a `problems` array that is empty, the fixture's name, the pin exactly as
`CLAUDE_CODE_PIN` declares it, every row `exact` or `equivalent` and carried (a
row the report downgrades to `planned` is not proven placed), the totals that
`report.ts` derives from the rows (`declared` = rows, `emitted` = carried,
`refused` = rows with a refusal, `skipped` = rows − emitted − refused), and the
row set equal to the fixture's declared rows —
a dropped, invented, or repeated row fails. The row list is derived from the
fixture's own files: `skills/*/SKILL.md`, top-level `commands/*.md`,
`agents/*.md` and `output-styles/*.md`; nested commands, hooks and MCP rows are
not enumerated.

**The row checks only run when that list is non-empty.** A fixture made of
nested commands, hooks or MCP servers enumerates nothing, so only the shape and
totals rules apply and a dropped row is not detected; a mixed fixture's rows on
those surfaces are treated as invented. Use the default skills fixture (or
another built from the four surfaces) when the row claim matters.

The entry point exits 0 when every claim holds, 1 with each failed claim listed,
and 2 on a usage error. The 0/1 paths are tested through `run`'s return value;
the usage path is tested by spawning the entry point, so deleting the exit
assignment reddens. An unpublished
version stops after the registry judgment, because nothing after it can be true.

Scope, stated narrowly: this runs the packed CLI's `report` path. It does not
execute the packed materializers — `report.ok` is IR validation, and a tarball
whose `lib/materialize/*.js` all throw still reports `ok: true`.

The script is not part of `verify`: it reaches the network and npm, and it is
the post-publish step. Run it from the checkout root; the default fixture is
relative. `npm view` supplies the version list; the version document itself is
read over `fetch`.

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
