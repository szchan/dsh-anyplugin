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

For a pipe, ask npm to stay quiet: `npm` prints its own `> dsh-anyplugin@…
perf` banner on stdout before the script starts, so `npm run perf -- --json`
is valid JSON only after that line. Use `npm run --silent perf -- --json`, or
call `node scripts/perf.mjs --json` directly; the program's own stdout is a
single JSON document and `--quiet` writes nothing else.

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
5. P1, P3 and P4 import **both** trees into one child (`--probe core
   --roots <base>\n<head>`) and measure them sample by sample, alternating
   `[base, head]` and `[head, base]`. Each side keeps its own module graph and
   its own `vm` contexts; because the two halves of a pair are adjacent in
   time, a drift in the host's load cancels inside the pair instead of being
   reported as a ratio. P2 boots the two sides in separate children (two
   hosts in one process would fight over the DSH globals) and runs two passes
   in opposite order, merging their samples for the same reason;
6. the worktree and the scratch home are removed in a `finally`.

Everything the runner needs for itself — worktree creation, dependency sharing,
build, profile assembly, `npm pack` — happens outside every timed region. The
only timed regions are the four numbered `performance.now()` spans below.

## The probes

### P1 — cold mod load

`loadMod()` plus `await mod.evaluate()` of the pinned upstream `diff` mod
(`$ANYPLUGIN_MODS_TREE/mods/diff/hooks/register.ts`). This is the kernel's
slowest single unit: link, type-strip and evaluate a foreign module in a fresh
`vm` context. Every sample creates a fresh context. One warmup per side is
discarded; the report's median is over `2 × --repeat` samples per side (the
paired halves of the run). After the stopwatch closes, the probe asserts the pinned
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
uses a fresh profile directory and disposes the context afterwards. Two passes
run in opposite order and their boots are merged, so the median is over
`2 × --repeat` boots per pin.

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

The report's median is over `2 × --repeat` samples per side, and the base and
head halves of a pair are measured back to back. That pairing is not cosmetic.
Before it, the harness measured the base in one block and the head in the next.
On identical code (that is, with every ratio a noise control) that produced
0.93x–1.01x on P1 and 1.01x–1.08x on P3 at a quiet moment, but 1.20x/1.51x and
then 1.74x/1.73x when the host was busy; merely alternating whole-side blocks
still produced 1.89x on P3. The machine's load trajectory had become the
regression.

With the paired measurement, on the same busy host and the same commit:

| probe | run 1 ratio | run 2 ratio | base median, run 1 → run 2 |
| --- | --- | --- | --- |
| P1 | 1.02x | 1.08x | 416.1 → 247.9 ms |
| P2 rc.2 | 1.06x | 1.05x | 50.0 → 27.0 ms |
| P2 rc.5 | 1.01x | 1.03x | 49.6 → 25.1 ms |
| P3 | 0.98x | 0.98x | 9.90 → 5.90 µs |
| P4 | 1.01x | 1.01x | 186.3 → 115.8 ms |

The ratio agreed within ~6 % on P1 and exactly on P3, while the absolute
medians still moved by ~40 % because the two runs happened at different
moments. A third run under heavier load (P1 base median 675.9 ms, three times
the second run) gave 1.05x and 1.12x: pairing removes the drift between the two
halves, not every burst. That is the point: a base/head ratio survives a busy machine; a
millisecond count does not. So:

- a ratio of 0.9–1.1 is noise; do not open a ticket for it;
- a ratio above the `--check` default of 1.5 is worth a look at the probe that
  moved, after a second run;
- absolute medians in two different runs are not a comparison. Only the ratio
  of a base and a head measured by the same run is.

P2 is the least stable probe: each sample boots a host and loads a profile, so
a pair costs about a second and a load burst can still move its ratio by
20–30 %. It is gated by `--check` because a real boot regression is large, but
read a 1.1x P2 as noise. Raising `--repeat` tightens every median; it cannot
remove the drift between separate runs.
