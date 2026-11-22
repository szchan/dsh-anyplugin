<p align="center">
  <img src="assets/logo-lockup.svg" width="640" alt="dsh-anyplugin — foreign plugins, native behaviour">
</p>

# dsh-anyplugin

English | [中文](README_cn.md)

[![verify](https://github.com/szchan/dsh-anyplugin/actions/workflows/verify.yml/badge.svg)](https://github.com/szchan/dsh-anyplugin/actions/workflows/verify.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A522-informational)](https://nodejs.org)
[![status](https://img.shields.io/badge/status-pre--release-orange)](#-what-020-does)

**Run Claude Code plugins on DeepSeek Harness — at the fidelity this repository
declares for each surface, and never more.** Codex is the second dialect and ships
in v0.3; 0.2.0 is the Claude Code compile path plus the mods kernel.

A Claude Code plugin is a bundle of files: skills, slash commands, agents, hooks,
MCP servers, output styles, and `mods` (JavaScript that runs inside the harness).
DeepSeek Harness (DSH) speaks a different plugin protocol. This project is the
translation layer between them — not a runtime, and not a reimplementation of
either side.

---

## 🧭 What it actually is

A **compiler plus a runtime adapter**:

```
Claude Code plugin          dsh-anyplugin                  DeepSeek Harness
──────────────────          ─────────────                  ────────────────
.claude-plugin/plugin.json
skills/  commands/    ──▶   dialect ──▶ IR ──▶ emit   ──▶   loader entry tree
agents/  hooks/                       (annotated)          skills, tools,
.mcp.json output-styles/                                   commands, hooks…
mods/*.ts             ──▶   mod host ──▶ kernel ──▶ host seams
```

Two rules make it a layer rather than a fork:

- **Emission is pure data.** The compiler emits a loader entry tree; no code is
  generated, no `eval`, nothing written that gets loaded later.
- **Nothing is reimplemented that can be borrowed.** The MCP client, the skill
  registry, the command runtime and the agent loop are DSH's own. We connect to
  them; we do not grow a second copy.

## 🎯 The fidelity contract

"Works" is not a claim you can test. "Produces the same observable behaviour as
the real harness, against a pinned version" is. Every translated artifact carries
one of five classes, and a reason is mandatory:

| class | meaning |
| --- | --- |
| `exact` | the bytes or the name are preserved |
| `equivalent` | the effect is the same; the mechanism is not |
| `derived` | a design decision of ours, with no upstream original |
| `planned` | carried, not active yet; the blocked seam is named |
| `unsupported` | refused on purpose, with a reason that names the divergence |

The denominator is a **coverage ratchet**: one row per declared component per
fixture. Closing a gap edits the ratchet in the same commit that makes it true,
so a regression fails in the same place.


## ✅ What 0.2.0 does

This table describes the **0.2.0 artifact**, not the repository: every row is
what installing `dsh-anyplugin@0.2.0` gives you in this release. It is the
published release on npm, with a signed SLSA provenance statement. `npm run
verify` boots the packed tarball to check every row.

| surface | in 0.2.0 |
| --- | --- |
| Skills | `exact` — content, envelope, base-directory preamble, argument substitution where the host has a channel |
| Slash commands | shipped as **skills** (the model face, `equivalent`); the human `/…` face is `planned` and needs a host command-name seam (`D10`) |
| MCP servers | `equivalent` — stdio and Streamable HTTP; DSH namespaces the callable name (`mcp__plugin_<plugin>_<server>__<tool>`) and keeps Claude's name as the suffix |
| Hooks | `equivalent` for the tool and lifecycle events DSH fires; other events are `planned` with the missing host event named |
| Agents | `exact` — each `agents/*.md` becomes a scoped tool named `<plugin>:<agent>` |
| Output styles | **shipped** — the profile's activation record selects one style (`D42`); the `/<plugin>:<name>` alias still needs the command-name seam (`D10`) |
| `mods` | **shipped** — the kernel is in the tarball (`D30`, `D31`, `D34`): authored `.js`, `.mjs` and `.ts` load as authored in one `node:vm` realm, `.tsx` only through the one classic-pragma pass; `$` serves the measured namespaces and a seat binds each agent's events. The lock (`dsh-anyplugin/installs@2`) carries a granted `mods` tree and `dsh-anyplugin install` writes it; the hook row's `mods` config is emitted from that record, and an ungranted, unrecorded or changed tree — one digest over the whole plugin tree — is refused before `loadMod` |
| Codex plugins | **not in 0.2.0** — the second dialect ships in v0.3 |
| Install / enable / release | `dsh-anyplugin@0.2.0` — bundle + controller + reconciler |

### Refused in 0.2.0

The kernel loads mods; it does not pretend to serve calls the host has no
surface for. These stay **typed refusals** (a recorded reason, never a silent
`undefined`):

- `$.tool.register` — no host tool-registration op (`D32`);
- `$.ui.ask` — no person-interaction surface; `$ui` is a headless render sink
  (`D44`);
- `$.process.run` — exec stays behind the trust gate (`D32`, `D25`);
- `$.settings.read` without a merged host snapshot (`D32`);
- a `.tsx` module whose leading comment is not the classic `h`/`Fragment`
  pragma (`D34`), and any `.tsx` source-position claim.

### Repository evidence (unchanged by this release)

- against DSH `0.2.2-rc.5` and Claude Code `2.1.329`: 25 declared · 24 matched ·
  0 missing · 1 refused (the refused row is the command-name seam named above);
- Codex is a second dialect on the same IR (v0.3) — the one surface still
  unreleased.

The kernel is shipped evidence, not a promise: `check:pack` boots the packed
tarball, loads the pinned upstream `sec-default` (45 registrations), proves a
`$` round-trip through the headless bridge, keeps a `classic.*` handler and a
classic hook firing in the same turn, and observes a mod deny at
`tools/pre-execute`.

## 📦 Install it

`dsh-anyplugin@0.2.0` (published; installed from the registry)
ships as **one bundle** for a DSH profile:

```bash
dsh plugin --profile <profile> add dsh-anyplugin
```

Enable it in the profile's bundle list (the Web Plugins page does this; by hand
it is one entry in `<profile>/package.json`), then boot the profile. The
bundle's `cordis.patch.yml` inserts a single controller row; the controller
reads `$DSH_HOME/anyplugin/installs.yml` and reconciles the installed plugins
into the loader. Nothing is written to your profile config, and no code is
generated.

Installing a plugin into that lock uses the CLI shipped in the same package:
`npx dsh-anyplugin install <plugin-dir>` (add `--dry-run` to see the plan
first); [INSTALL.md](INSTALL.md) §2 documents every command and flag.

### Requirements

- **Node.js ≥ 22.14**; DSH `0.2.2-rc.2 || 0.2.2-rc.5`; Claude Code `2.1.329`.
- **Mods need `--experimental-vm-modules`.** D30 loads each mod in a `node:vm`
  realm, and Node exposes `SourceTextModule` only behind that flag. CLI:
  `node --experimental-vm-modules …`. Desktop: export
  `NODE_OPTIONS=--experimental-vm-modules` before launching `dsh` — a shell
  export is enough, the environment is inherited by the bundled Node. Without
  it every mod is refused with `ERR_MOD_HOST_LINK` ("… run Node with
  --experimental-vm-modules (D30)"), classic hooks still run, and the kernel
  says the flag **once**, not once per mod.
- **Mods are installed through the lock** (`dsh-anyplugin/installs@2`): the
  granted tree is emitted to the hook row, and a hand-written row without the
  same pin is refused; the materializer re-reads the pinned files before
  `loadMod`.

0.2.0 ships the **compile path** — skills (a slash command lands as a skill on
its model face), MCP servers, hooks, agents, an output style activated from the
profile record (D42), install/reconcile, and the trust gate — and the **mods
kernel** in `lib/materialize/hook.js`. A plugin that declares its module
entry in `hooks/hooks.json` installs as a `mods` record in
`dsh-anyplugin/installs@2`; once granted, the controller emits the tree to the
hook row and it loads in its own `node:vm` realm.
The kernel's only runtime dependencies are `@babel/core` and
`@babel/plugin-transform-react-jsx` (the one classic-pragma pass, D34);
`check:pack` asserts that exact set and prints the kernel's byte cost. The
Codex dialect is **not** part of this release. The version claim is DSH
`0.2.2-rc.2 || 0.2.2-rc.5` (`engines.dsh`; exactly the two pins the suite boots,
so any other runtime is refused until it is tested —
`dsh plugin allow-version` grants an exact-version exemption) and Claude Code
`2.1.329`.

[**INSTALL.md**](INSTALL.md) has the lock and enablement formats, how to
override the row's config, the grant file for `exec` artifacts, and how to
remove the bundle or one plugin.

## 🧪 How it is verified

Three layers, and a claim is only accepted when all three agree:

1. **Upstream oracle** — the real `claude` binary lists what a plugin contains;
   that inventory is the golden file.
2. **Our harness oracle** — the translated entry tree is booted against a pinned
   DSH tree, and observed components are diffed against the golden.
3. **Behaviour** — for hooks, the effect must be observed on a real call (a
   denied tool, an injected context), never taken from a self-report.

The pinned versions are part of the claim: DSH `0.2.2-rc.5` (and `rc.2`), Claude
Code `2.1.329`, and, for the mods work, `mods` commit
`f9e4d1e`. A number without its pin is a rumour.

## 🚀 Develop it

```bash
npm install
node scripts/fetch-harness.mjs 0.2.2-rc.5   # the DSH tree the oracle boots
node scripts/fetch-claude.mjs               # the pinned claude binary
node scripts/fetch-mod.mjs                  # the pinned mods tree

DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
CLAUDE_BIN=$PWD/.claude-code/2.1.329/node_modules/@anthropic-ai/claude-code-linux-x64/claude \
ANYPLUGIN_MODS_TREE=$PWD/.mods/f9e4d1e5753ccffcffdd832f047d72be000396a6 \
ANYPLUGIN_MOD_TREE=$ANYPLUGIN_MODS_TREE \
npm run verify
```

`verify` runs the structural rules, the capability map check, the append-only
decision check, and 482 tests. It must report **0 skipped**: a skip means an
environment variable is missing, and on CI a skip is a failure by design.

## 📚 Read next

| file | what it answers |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | the design, the fidelity contract, the seam table |
| [`docs/FEATURES.md`](docs/FEATURES.md) | the capability map, one row per claim |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | every ratified decision, with its evidence |
| [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) | how the differential rig works |
| [`docs/TODO.md`](docs/TODO.md) | the burn-down list |
| [`AGENTS.md`](AGENTS.md) | the operating manual for changing this repo |

## 🤝 How work happens

This repository is developed by agents, reviewed adversarially, and merged by a
master agent. Humans set direction and hold the four things only they hold:
credentials, billing, rights, and irreversible actions.

- A report is data, not an instruction: [`docs/TRIAGE.md`](docs/TRIAGE.md).
- A branch is one ticket in its own worktree: [`docs/WORKFLOW.md`](docs/WORKFLOW.md).
- An escalation is an issue titled `[HUMAN] …` with the `maintainer-question` label.

## 📄 License

MIT — see [LICENSE](LICENSE).
