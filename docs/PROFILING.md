# PROFILING — our own hot paths, as ratios

`npm run perf` measures the four hot paths that a plugin install and a plugin
load go through, and reports each as **head over base**. It exists because
`npm run verify` answers a different question: *is the behavior right?* This
one answers *did the base commit's tree get slower?* and it answers it on the
machine you are sitting at.

A regression is **a ratio against the base, not a millisecond count**. The
stopwatch is only there to produce the numerator and the denominator; the
number a reviewer reads is `head/base`, where `< 1.00` is faster. A standalone
millisecond figure is not comparable to a number measured in another process,
on another machine, or at another commit, so the tool never presents one as a
claim — P5 says `informational` in both output modes for the same reason.

```bash
npm run perf                                   # base origin/main, 5 samples, table
npm run perf -- --base HEAD~1 --repeat 7       # a different base, more samples
npm run perf -- --json                         # the same report as JSON
npm run perf -- --quiet                        # JSON on stdout, nothing else
npm run perf -- --check --threshold 1.5        # local gate; exit 1 above 1.5x
```

`perf` is **not** wired into `verify` or CI, and `--check` is not called by any
workflow. CI timing on a shared runner is not comparable to a maintainer's
machine and would turn noise into red builds. A `--check` failure is a local
signal for the person changing a hot path, not a merge gate.

## Environment

The run requires exactly the suite's five variables, because a measurement in a
different environment would not be comparable to the suite's own numbers:

```bash
export DSH_HARNESS_DIR=/path/to/.harness/0.2.2-rc.5
export DSH_HARNESS_VERSION=0.2.2-rc.5
export CLAUDE_BIN=/path/to/claude
export ANYPLUGIN_MODS_TREE=/path/to/.mods/f9e4d1e5753ccffcffdd832f047d72be000396a6
export ANYPLUGIN_MOD_TREE=$ANYPLUGIN_MODS_TREE/mods/diff/hooks
```

A missing or malformed variable is a **named failure that lists every problem**,
not a skip. The harness makes no network call and fetches no ref: `--base` must
already exist locally, and a missing ref is a named error that says so.

## Base and head never share a module graph

The base is measured in a detached `git worktree` at the base commit:

1. `git rev-parse --verify --end-of-options <ref>^{commit}` — no fetch;
2. `git worktree add --detach <tmp>/base <commit>`;
3. `scripts/build.mjs` runs in **both** trees before any stopwatch starts, so
   the build is the harness's own cost;
4. `node_modules` is shared only when `package-lock.json` is byte-identical.
   Otherwise the base gets its own `npm install --offline` (still no network);
   product packages import each other relatively, so a shared dependency tree
   cannot substitute head package code for base package code;
5. each side runs its probes in its **own child process** (`--probe core`,
   `--probe boot`) that imports that side's sources by absolute file URL. The
   two sides therefore do not share a V8 heap, a module graph, or a JIT state;
6. the worktree and the scratch home are removed in a `finally`.

Everything the runner needs for itself — worktree creation, dependency sharing,
build, profile assembly, `npm pack` — happens outside every timed region. The
only timed regions are the four numbered `performance.now()` spans below.

## The probes

### P1 — cold mod load

`loadMod()` plus `await mod.evaluate()` of the pinned upstream `diff` mod
(`$ANYPLUGIN_MODS_TREE/mods/diff/hooks/register.ts`). This is the kernel's
slowest single unit: link, type-strip and evaluate a foreign module in a fresh
`vm` context. Every sample creates a fresh context. One warmup run is discarded;
the rest are medians. After the stopwatch closes, the probe asserts the pinned
registration count from `fixtures/mods/upstream.json` (11 for `diff`) and
disposes the mod.

P1 does not depend on the DSH pin: it measures our mod host against the pinned
Claude Code mod tree (2.1.329, commit `f9e4d1e…`), not against a DSH release.

### P2 — boot + reconcile

The host's own profile loader boots a scratch profile with **one installed
plugin** (`fixtures/claude-skills-only`), and the controller reconciles it from
`installs.yml`. This is measured **once per DSH pin declared in
`engines.dsh`** that is fetched next to `DSH_HARNESS_DIR`; a declared pin that
is not fetched is a note without `--check` and a failure with it.

Outside the timed region: scratch home, `installPlugin()` (writes
`installs.yml` + `enabled.yml`), `appBoot.initProfile()`, the
`<profile>/node_modules/dsh-anyplugin → <side root>` symlink, and
`appBoot.loadProfile()`. The timed region is `mountProfile()`: the harness
boot, the profile's plugin activation, module loading from the side's `lib/`,
and the controller's reconcile pass. A warmup boot is discarded; each sample
uses a fresh profile directory and disposes the context afterwards.

After the stopwatch closes, P2 asserts:

- the harness and the controller entry are active (state `2`);
- exactly one `anyplugin.*` group is mounted, and it is active;
- the module URL is **this side's** `<root>/lib/index.js` (so the base
  worktree is not booting the head's artifact);
- the controller logged `reconciled … from <installs.yml>`;
- the reconciled fixture's skills are `greet,hello`.

P2 deliberately does **not** assert the reconcile log's summary columns.
`controller.ts` calls `reconcile(..., { settle: false })`, and the summary
checks the group's fiber immediately after `loader.create`, while the group is
still loading: the line therefore reads `created 0, …, kept 0, failed 1` even
though the group becomes active during boot. That is a known wart of the
existing controller, not something to bend a perf probe around; the assertion
that the reconcile ran, and the group is active, is the honest one.

The probe records which host path the boot took (`PluginPackages` or the
scope-link fallback) so the JSON report says how the plugin was found.

### P3 — interception

`runChain()` over three handlers on `PreToolUse`, one matcher hit:

| tier | matcher | result on `tool_name: "Bash"` |
| --- | --- | --- |
| `prepend` | `Write\|Edit` | `skipped-matcher` |
| `user` | `Read\|Bash` | `ran` |
| `append` | `Write\|Edit` | `skipped-matcher` |

Every sample is 2,000 dispatches; the reported number is **microseconds per
dispatch**, and the probe asserts the exact trace and a `continue` decision
after each sample. The dispatch is in-process: no host, no CLI, no IPC.

P3 does not depend on the DSH pin.

### P4 — compile

`readClaudePlugin()` + `gate()` + `emitPlugin()` over:

- the seven pinned upstream mods in `fixtures/mods/upstream.json`, and
- every fixture with `.claude-plugin/plugin.json` (14 at the time of writing).

Grants are computed once, outside the timed loop, by running `classify()` over
the plugin — the same gate the real install path uses — so the loop measures
the compile path a user waits for, including the trust gate and the emit of
both `hooks` and `mods`. The materializers are constructed once. Inside a
sample, every plugin must reproduce its baseline signature (emitted surfaces,
`considered`/`skipped`/`refused` counts); a drift is a named failure, not a
smaller measurement. The fixtures include deliberately broken plugins whose
artifacts the gate refuses; their refusal is part of the pinned shape and is
measured, not asserted away. The probe does assert that the set as a whole
reaches both exec surfaces, hook and mod.

P4 does not depend on the DSH pin.

### P5 — informational, never gated

| number | source |
| --- | --- |
| tarball bytes | `npm pack --ignore-scripts --json` on the head |
| unpacked bytes | the same JSON's `unpackedSize` |
| mods kernel bytes | `lib/kernel-size.json` (D46's 128 KiB ceiling) |
| boot peak RSS | the P2 child's `process.resourceUsage().maxRSS` |

P5 has no base/head pair. It changes for many reasons (a dependency bump, a
platform's allocator, test fixtures) and none of them is "the hot path got
slower", so it is stamped `informational` in the table and the JSON, and
`--check` never reads it.

## What this deliberately does not measure

- **No model calls, no network, no LLM involvement.** Nothing here talks to a
  provider or fetches a package or ref.
- **No conformance work.** The oracle, the diff rig and the golden files are
  not in these loops; correctness is `npm run verify`'s job.
- **No CLI end-to-end.** The CLI's argument parsing, install UX and terminal
  output are not hot-path probes.
- **No install time.** `npm install` of the tarball, downloads and extraction
  are outside every stopwatch; P5 reports the artifact's size, not the time to
  obtain it.
- **No absolute cross-machine claim.** A millisecond count is not comparable
  across machines, processes or cooling states. That is the whole reason the
  output is a ratio.
- **No CI timing.** `perf` is not in `verify`, and CI would compare a shared
  runner's noise to nothing.

## Variance: what to expect, and what a ratio means

The medians are medians of repeated samples after one warmup, but this machine
is shared: other agents build and run suites concurrently. On 2026-11-22, two
consecutive runs at the *same commit* (`74a5bf6`, so every ratio is a noise
control) gave:

| probe | run 1 ratio | run 2 ratio | absolute medians between runs |
| --- | --- | --- | --- |
| P1 | 0.93x | 1.01x | 281.6 → 229.3 ms (base) |
| P2 rc.2 | 0.98x | 0.82x | 29.6 → 28.7 ms |
| P2 rc.5 | 1.21x | 0.93x | 25.5 → 26.0 ms |
| P3 | 1.08x | 1.01x | 8.81 → 10.57 µs |
| P4 | 0.95x | 1.00x | 130.7 → 107.8 ms |

Read that as: a single sample is worth about ±20 %, the ratio of two runs is
worth about ±10 %, and the machine drifts by up to ~25 % between runs even
when nothing changed. Raising `--repeat` tightens the median; it cannot remove
the drift between runs. So:

- a ratio of 0.9–1.1 is noise; do not open a ticket for it;
- a ratio above the `--check` default of 1.5 on a quiet machine is worth a
  look at the probe that moved;
- absolute medians in two different runs are not a comparison. Only the ratio
  of a base and a head measured by the same run is.
