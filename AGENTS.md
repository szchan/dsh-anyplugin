# AGENTS.md

Operating manual for anyone (human or agent) changing this repository.
**Read this file before touching code, and read `docs/ARCHITECTURE.md` before
touching the design.**

## 1. What this project is

`dsh-anyplugin` makes DeepSeek Harness (DSH) able to install and run plugins
written for other agent harnesses — Claude Code first, Codex second — at
**100 % behavioral fidelity against a declared observable surface**.

It is a **layer**, not a runtime: foreign plugin sources are compiled into an
intermediate representation, then emitted as *data* into DSH's own plugin
loader. Two subsystems share one spine:

- **compile path** — dialects → IR → plan → emit → DSH seams (v0.1+);
- **kernel path** — Claude mod API → DSH mod ABI → mod host (v0.5+).

## 2. Read first

| File | Why |
| --- | --- |
| `docs/ARCHITECTURE.md` | The design. §0 (the fidelity contract) and §7 (mods) are load-bearing. |
| `docs/DECISIONS.md` | Ratified decisions D1–D41. **Do not relitigate these in code review or in a PR without a new decision entry.** |
| `docs/WORKFLOW.md` | How agents take tickets, where they work, and what a PR must prove. |
| `docs/TODO.md` | The burn-down list: what is next, what each item must prove, and which upstream proposal it waits on. |
| `docs/ARCHITECTURE.md` §10 | Verification plan (S1–S14) and what a spike must prove. |
| `docs/ARCHITECTURE.md` §13 | Open questions. If your work answers one, move it to a decision. |

## 3. Non-negotiables

These are contracts, not preferences. A change that violates one is rejected
even if it makes the feature work.

1. **Fidelity is annotated at the source, never computed afterwards.** Every IR
   node carries a class (`exact` / `equivalent` / `derived` / `unsupported` /
   `planned`) and a human-readable `reason`. An empty reason is a bug. A
   degradation without a reason cannot ship.
2. **Seams are extended by union only (T2).** Additive intercept points, new
   optional fields, new packages. **Never** change the meaning of an existing
   DSH behavior (T3). If a foreign semantic conflicts, split it: e.g. keep the
   command-name grammar as is and dispatch through an alias table.
3. **Emission is pure data.** The compiler produces an `EntryTree` patch. No
   code generation, no `eval`, no `new Function`, no writing JS files that get
   loaded. If it cannot be expressed as data, it is not expressible yet.
4. **No runtime writes to profile config.** Persistence is
   `installs.yml` + scope replay, materialized through the loader. Reconcile
   compares *desired* (lock) with *actual* (inventory) and is idempotent.
5. **Trust is pinned to the artifact hash.** A grant is
   `{capability, target, artifactHash, grantedAt, scope}`. Any change to the
   artifact invalidates the grant and re-prompts. Content-class work may be
   automatic; `exec`-class (`hook`, `monitor`, `bin`, `mod`) is default-off and
   must show the exact command line.
6. **One interception kernel.** Classic hooks and mods share the same event
   points, matcher grammar, decision protocol and tier ordering
   (`dsh-anyplugin-intercept`). Do not add a second, parallel event path —
   that is how mods get architected out.
7. **Mods are loaded as authored.** Claude's static scanner and its
   "capability list before install" behaviour depend on literal
   `on('event')` / `$.ns.method` call sites. Never transpile, bundle, minify or
   rewrite a mod. `.ts` may be loaded via type stripping. `.tsx` is the single
   declared exception: one classic-pragma JSX transform plus an in-memory type
   strip (D34), never a bundler, preset or second transform. Babel reprints a
   `.tsx` module, so byte and source-position preservation are not claimed for
   it; the scanner always reads the authored file, which is the trust surface.
8. **Version pins are part of the claim.** "100 %" means 100 % against a pinned
   upstream version. Any fidelity number in a report or commit must name the
   pin. Upstream drifts without notice — CI re-runs the diff against the pin.
9. **Spec beats prose.** For mods, the generated `claude-code.d.ts` (and the
   per-install `.claude-plugin/types/`) is the specification; docs pages are
   commentary.

## 4. Layout

```
AGENTS.md              this file
docs/                  design and decisions (all prose docs live here)
  ARCHITECTURE.md      the design
  DECISIONS.md         ratified decision log
  TODO.md              ordered burn-down list (outcomes, not intentions)
  CONFORMANCE.md       the differential rig
packages/              publishable packages (see ARCHITECTURE §2 for the map)
  dsh-anyplugin-conformance/  the rig: inventory, upstream oracle, diff
spikes/                throwaway experiments; each answers one question (S1–S14)
fixtures/              foreign-plugin fixtures used by the conformance rig
scripts/               repo tooling that is not a package
```

A spike is finished when its question is answered and the answer is written
into `docs/ARCHITECTURE.md` or `docs/DECISIONS.md`. Spikes are not shipped;
anything that survives moves into `packages/`.

## 5. Commands

```bash
npm install                       # workspace deps (uses the repo-local .npmrc cache)
node spikes/s1-loader/run.mjs     # run a spike
npm run rig -- verify --plugin <dir> --golden <file>   # conformance rig
npm run capture:fixtures          # re-capture goldens after a pin bump; review the diff
npm test                          # node --test over packages/ and spikes' assertions
```

The global npm cache on this machine is root-owned and unusable; `.npmrc`
points npm at `./.npm-cache` on purpose. Do not "fix" it by running `sudo chown`.

A change that closes a line in `docs/TODO.md` deletes the line in the same
commit that moves the coverage row. A list that only grows is a diary.

## 6. Probing the harness under test

The reference installation lives at `$DSH_INSTALL_DIR`. On this machine the
Desktop bundle is **extracted**, not archived, so ordinary `node` can import the
sibling `@deepseek-ai/*` packages directly (D9). On a truly archived (asar)
install, read it with DSH's own Node instead:

```bash
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e \
  'const fs=require("node:fs");console.log(fs.readFileSync(process.argv[1]+"/README.md","utf8"))' \
  "$DSH_INSTALL_DIR"
```

That is only one source. The oracle resolves a pinned harness tree in this order,
first match wins (D22):

1. `DSH_HARNESS_DIR` — an install root made by `scripts/fetch-harness.mjs`;
2. `DSH_INSTALL_DIR` — the Desktop installation's `@deepseek-ai/dsh` package
   directory;
3. `.harness/<DSH_HARNESS_VERSION>` — a fetched pin inside this checkout.

Fetching is explicit and idempotent; the tests themselves never touch the
network:

```bash
node scripts/fetch-harness.mjs 0.2.2-rc.5    # prints the install root
DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
  DSH_HARNESS_VERSION=0.2.2-rc.5 npm run verify
```

One fetch is the whole tree: the script installs the **union** the conformance
suite and every spike `verify.yml` runs boot, at that pin, in one `npm install`.
There is no second install step, locally or in CI. A test or CI spike that
starts loading a new `@deepseek-ai/dsh-*` package must add it to
`HARNESS_PACKAGES` in `scripts/fetch-harness.mjs`; until it does,
`packages/dsh-anyplugin-conformance/test/harness-union.test.mjs` fails the
suite instead of letting the package be hand-installed.

The upstream oracle resolves its `claude` the same way (D24), and CI fetches it
instead of borrowing a laptop install:

1. `CLAUDE_BIN` — an explicit executable; CI sets it to the fetched pin. Empty
   or whitespace-only counts as unset; any other unusable value is an error,
   never a fall-through;
2. `claude` on `PATH`;
3. neither — a local run skips with a reason that names
   `scripts/fetch-claude.mjs`; in CI that is a failed job.

`node scripts/fetch-claude.mjs` installs the pinned
`@anthropic-ai/claude-code@2.1.329` into `.claude-code/2.1.329/` with
`--ignore-scripts` and prints the native binary. The version is
`CLAUDE_CODE_PIN` in the conformance package; it is asserted before the suite.

**Never install `latest`.** The `@deepseek-ai` scope's `latest` dist-tag points
at `0.0.1-rc.1`, which is not a harness. Pin every version explicitly.

Three traps that have already cost us time:

- **A stale `latest` tag is not the package list.** `0.0.1-rc.1` hid the fact
  that rc.1 … rc.5 were published, and led D9 to claim npm was a different
  product. Check the published versions before concluding anything.
- **`require.resolve` failing does not mean the package does not exist
  upstream.** The Desktop bundle ships a pruned subset (338 `@deepseek-ai`
  packages). Confirm against the published package list.
- **Do not infer seam availability from a single README.** Probe the actual
  export shape (S1–S4 exist for this reason). Materializers must *detect* a
  seam at runtime and degrade with a recorded reason, never assume it.

## 7. Definition of done

A change is done when all of these hold:

- the behavior is covered by an assertion (unit test, or a spike assertion that
  later becomes a fixture);
- the fidelity report for the affected fixture changes **only** by an explicit
  annotation, with reasons;
- `docs/ARCHITECTURE.md` still describes the code (if the contract moved, the
  doc moves in the same commit);
- if a decision was made, `docs/DECISIONS.md` has a new entry;
- no non-negotiable above was bent, or the bend is written down as a decision.

## 8. Conventions

- ESM only (`"type": "module"`); no CommonJS in new code.
- TypeScript for `packages/`; spikes may be plain `.mjs` when they only probe.
- Commits: `area: imperative summary` (e.g. `loader: verify group-entry
  atomicity`). Body explains *why*, and names the pinned versions the result is
  claimed against.
- Never commit `node_modules/`, `.npm-cache/`, spike output, or captured traces
  containing credentials. Traces belong in `fixtures/` only after scrubbing.
- Prefer a new file over a long edit when the old shape is load-bearing
  documentation; this repository's docs are contracts.
