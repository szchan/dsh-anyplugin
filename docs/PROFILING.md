# PROFILING — our own hot paths, gated in CI

`npm run perf` measures the four hot paths that a plugin install and a plugin
load go through. It exists because `npm run verify` answers a different
question: *is the behavior right?* This one answers *did the tree get slower,
and did a boot or a dispatch cross its budget?*

P1 (cold mod load) and P4 (compile) report **head over base** and are gated as
ratios: the number a reviewer reads is the median of the per-pair `head/base`
ratios, where `< 1.00` is faster (D69). P2 (boot + reconcile) and P3
(`pre-execute` dispatch) are gated as **absolute budgets** on the head, because
those numbers are short enough that a base/head ratio is mostly host noise
(D76). P5 (size/RSS) is recorded and never gated. The full decision is D76 in
`docs/DECISIONS.md`; D69's pairing rules still govern the ratios, and D69's
"not in CI" clause is superseded.

## The CI gate

`.github/workflows/perf.yml` runs one job named **`perf`** on every branch push
(push only: one run per push event, so a same-repo PR shows one `perf` for its
head — a `pull_request` run would execute the workflow file from the PR's merge
commit, which a fork controls). The job measures the head and `origin/main` on
the **same runner**:

1. it checks out the pushed commit with full history and fetches `origin/main`
   explicitly, so the comparison ref is the base repo's current `main`; the same
   `--base` machinery then creates the detached base worktree;
2. it fetches the pinned mod tree, the pinned Claude Code CLI and both DSH pins
   declared by `engines.dsh`, and refuses to measure with any of them missing;
3. `node scripts/perf.mjs --base origin/main --repeat 5 --ci --json-out
   perf.json` creates a detached worktree at `origin/main`, builds both trees,
   runs the interleaved probes, prints the gate table and writes the artifact;
4. the job uploads the artifact named **`perf.json`**, retained for **30
   days**, with `if: always()` so a red run still carries its report.

The fixed limits are:

| probe | measurement | limit |
| --- | --- | --- |
| P1 cold mod load | median of the paired head/base ratios | `<= 1.50x` |
| P2 empty-profile boot (per declared pin) | head median | `< 3000 ms` |
| P2 one-plugin boot (per declared pin) | head median / head empty median | `< 2.00x` |
| P3 pre-execute fan-out | head median, microseconds per dispatch | `< 50.0 us` |
| P4 compile | median of the paired head/base ratios | `<= 1.50x` |
| P5 tarball/unpacked/kernel/RSS | recorded only | never gates |

A ratio exactly at its limit passes: 1.5× is a ceiling, as `exceedsThreshold`
has always meant. An absolute budget fails at its boundary — the ratified
numbers read "< 3 s", "< 2× empty" and "< 50 µs" — so 3000 ms, exactly 2× and
50 µs are red (`exceedsCap`). A pin declared in `engines.dsh` but not fetched is a **failed** row from
`discoverPins`, and an unmeasured probe is a failed row; the workflow guard
fails the job before measurement when one of the two hardcoded pins cannot be
fetched. Neither layer drops the gate silently. The P2 base/head ratio is still printed,
but it is description: its noise is why D69 did not gate it, and D76 keeps that
objection while gating the head's absolute boot instead. The absolute caps are
hard walls, not a noise band: a single sample at the boundary is red, and the
verdict line reads `gates: all N gated measurements pass`, and the separate
`gated (D76)` line lists the seven gates, so the recorded P2 boot ratio is never
implied to have been checked.

`npm run perf` on a workstation is **local-only for debugging and never a
merge gate**. `npm run verify` does not read perf; the `perf` workflow is its
own check. It is push only, one run per push event, the same rule as `verify`
(D83): a `pull_request` run executes the workflow file from the PR's merge
commit — for a fork the contributor's own file, with a job name the contributor
chooses — so a check it produced would not be evidence this repository measured
anything, and a same-repo PR would show two `perf` runs for one commit. Branch
protection cannot tell which workflow file produced a context, so if `perf`
becomes a required check the reviewer counts only the push run produced by this
repository's `perf.yml`; for a fork PR that is the run from a maintainer pushing
the head onto a branch here. Whether a red `perf` blocks a merge is branch
protection's decision, and the merge command stays human.

## Reading the artifact

Download `perf.json` from the run's **Artifacts** section, or read the same
gate table in the job log. The report is:

```json
{
  "schema": "dsh-anyplugin/perf@1",
  "base": { "ref": "origin/main", "commit": "...", "sameAsHead": false },
  "head": { "commit": "..." },
  "repeat": 5,
  "gateLimits": { "ratio": 1.5, "p2EmptyMs": 3000, "p2PluginOverEmpty": 2,
                  "p3Micros": 50, "p4Ratio": 1.5 },
  "probes": { "P1": {}, "P2": [], "P3": {}, "P4": {} },
  "p5": { "informational": true, "tarballBytes": 0, "unpackedBytes": 0,
          "kernelBytes": 0, "bootPeakRssKiB": 0 },
  "check": { "limits": {}, "rows": [], "failures": [] },
  "notes": []
}
```

- `probes.P1/P3/P4` hold `base`, `head`, the paired `ratio` and the samples.
  P4 also says whether the two sides compiled the same plugin set.
- `probes.P2` has one row per declared pin. Each row has the one-plugin
  `base/head/ratio/pairs` and an `empty` object with the same shape. A row
  whose pin was not fetched has `reason: "pin not fetched"` instead of numbers.
- `check.rows` is the gate table: `metric`, `base`, `head`, `ratio`, `limit`,
  `verdict` (`pass`, `FAIL` or `record`) and `detail`. The four P5 rows are
  `record`; they never appear in `check.failures`.
- `check.failures` is what turned the job red, one line per failed row, naming
  the probe, the value, the threshold and the repeat count.
- `p5` is the recorded size/RSS block. It has no base/head pair.

`perf.json` is written before the process exits, so a gate failure still
produces the evidence. A run with no `perf.json` is itself a failed job: the
upload step errors rather than letting a report-less run look green.

## What a red gate means

A red `perf` is a **regression claim**, and the claim names three things: the
probe, the threshold and the repeat count. The workflow runs `--repeat 5`; the
gate table and the log line say so.

1. Read the failed row. P1/P4 failures are a paired ratio above 1.5x; P2
   failures are a head boot above 3000 ms or above 2x the empty boot; P3 is a
   head dispatch above 50 us.
2. Check P4's `comparable` flag. If it is false, the base and head compiled
   different plugin sets and the failure is a set mismatch, not a slower
   compile; fix the fixture/pin difference first.
3. Re-run the job before writing a regression report. One sample outside the
   observed band is a reason to re-measure (D69 rule 4), not a conclusion.
   A second red run at the same repeat count is the regression claim.
4. Do not widen `--threshold` to make CI pass. `--ci` rejects `--threshold`
   outright; the ratified limits are fixed in `scripts/perf.mjs`.

Do not read a standalone millisecond figure as a cross-machine claim. P2's
3000 ms and P3's 50 us are budgets for this job on this runner, not numbers
comparable to a laptop. P1/P4 are meaningful only as the paired ratio from the
same run.

## Commands

```bash
npm run perf                                   # base origin/main, 5 samples, table
npm run perf -- --base HEAD~1 --repeat 7       # a different base, more samples
npm run perf -- --json                         # the same report as JSON
npm run perf -- --quiet                        # JSON on stdout, nothing else
npm run perf -- --check                        # the D76 gates, exit 1 on a failure
npm run perf -- --check --threshold 2          # local experiment: move P1/P4 only
node scripts/perf.mjs --ci --json-out perf.json  # what CI runs; fixed limits
```

`--check` applies all D76 gates on the workstation: P1/P4 ratios, P2's absolute
caps, P3's absolute cap. `--threshold` moves only the P1/P4 ratio ceilings and
is a local experiment. `--ci` selects the fixed D76 limits, rejects
`--threshold`, writes `perf.json` (default name; `--json-out` overrides it),
prints the gate table and exits 1 on a red gate. A plain `npm run perf` is a
table, not a verdict, and exits 0.

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
   the build is the harness's own cost (P2 boots `lib/`);
4. `node_modules` is shared only when `package-lock.json` is byte-identical.
   Otherwise the base gets its own `npm install --offline` (still no network);
   product packages import each other relatively, so a shared dependency tree
   cannot substitute head package code for base package code;
5. P1, P3 and P4 import **both** trees into one child (`--probe core
   --roots <base>\n<head>`) and measure them sample by sample, alternating
   `[base, head]` and `[head, base]`. Each side keeps its own module graph and
   its own `vm` contexts; because the two halves of a pair are adjacent in
   time, a drift in the host's load cancels inside the pair instead of being
   reported as a ratio. P2 boots the base side and the head side as a pair, alternating which side
   goes first, and reports the median of the per-pair ratios; one probe child
   serves every declared pin in turn, so a failure on the first pin stops the
   rest, and the peak RSS is the maximum across pins rather than a per-pin
   number;
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
discarded; the report's ratio is the median of `2 × --repeat` per-pair ratios
(two samples per side per pair). The gate is that median at or below 1.5x.
After the stopwatch closes, the probe asserts the pinned registration count
from `fixtures/mods/upstream.json` (11 for `diff`) and disposes the mod.

P1 does not depend on the DSH pin: it measures our mod host against the pinned
Claude Code mod tree (2.1.329, commit `f9e4d1e…`), not against a DSH release.

### P2 — boot + reconcile

For each DSH pin declared in `engines.dsh`, the host's own profile loader boots
two scratch profiles:

- **empty** — a home with no `anyplugin/installs.yml`. The controller starts,
  logs that it has no lock and nothing to reconcile, and mounts **no**
  `anyplugin.*` group and no fixture skill. This is the base cost of the
  harness plus our controller.
- **one plugin** — a home where `installPlugin()` installed
  `fixtures/claude-skills-only`; the controller reconciles it from
  `installs.yml`, mounts one active group and exposes `greet,hello`.

Outside every timed region: the two scratch homes, `installPlugin()` (writes
`installs.yml` + enabled state), `appBoot.initProfile()`, the
`<profile>/node_modules/dsh-anyplugin → <side root>` symlink, and
`appBoot.loadProfile()`. The timed region is `mountProfile()`: the harness
boot, the profile's plugin activation, module loading from the side's `lib/`,
and the controller's reconcile pass (or its early return for the empty home).

Each profile gets one discarded warm-up pair (base and head), then each repeat
boots the base side and the head side **as a pair**, adjacent in time and with
the order alternating. The two profiles alternate their order inside a repeat,
so four boots happen per repeat: empty base/head and one-plugin base/head.
`pairBootLog` validates that each profile's log is still adjacent and
alternating. The reported base/head ratio for each profile is the median of its
per-pair ratios; the per-side medians are descriptive.

The D76 gates are on the **head** side of those medians: the empty boot must be
strictly below 3000 ms, and the one-plugin boot strictly below 2x the empty
boot; the boundary value fails.
The base/head P2 ratio stays in the table but does not gate.

After the stopwatch closes, P2 asserts the profile shape:

- the harness and the controller entry are active (state `2`);
- the empty boot has zero `anyplugin.*` groups and an empty skill list, and the
  controller logged `no lock … nothing to reconcile`;
- the one-plugin boot has exactly one active `anyplugin.*` group, the
  controller logged `reconciled … from <installs.yml>`, and the skills are
  `greet,hello`;
- in both, the module URL is **this side's** `<root>/lib/index.js` (so the base
  worktree is not booting the head's artifact).

P2 deliberately does **not** assert the one-plugin reconcile log's summary
columns. `controller.ts` calls `reconcile(..., { settle: false })`, and the
summary checks the group's fiber immediately after `loader.create`, while the
group is still loading: the line therefore reads `created 0, …, kept 0,
failed 1` even though the group becomes active during boot. That is a known
wart of the existing controller, not something to bend a perf probe around; the
assertion that the reconcile ran, and the group is active, is the honest one.

The probe records which host path each boot took (`PluginPackages` or the
scope-link fallback) so the JSON report says how the plugin was found.

The P2 **base/head ratio** is informational, not gated. The bar a ratio-gated
probe must hold is every ratio inside 0.85–1.18 over five consecutive `--base
HEAD --repeat 5` runs on identical code. Five such runs produced:

| pin | ratios from the five runs |
| --- | --- |
| rc.2 | 0.906, 0.928, 0.933, 0.966, 1.021 |
| rc.5 | 0.958, 1.011, 1.021, 1.073, 1.193 |

rc.2 holds. rc.5 misses the bar once (1.193). Individual paired boots still
swing when a GC or another agent's build lands inside one, and a pair cannot
cancel a pause that hits only one side. Gating the base/head ratio at 1.5 would
therefore let a real 1.5x boot regression pass whenever that noise lands on the
head side — which is exactly what the merged-block design did before pairing:
reviewer-perf measured 0.59x and 1.02x back to back on identical code. D76
keeps that ratio descriptive and gates the head's absolute boot instead.

### P3 — interception

`runChain()` over three handlers on `PreToolUse`, one matcher hit:

| tier | matcher | result on `tool_name: "Bash"` |
| --- | --- | --- |
| `prepend` | `Write\|Edit` | `skipped-matcher` |
| `user` | `Read\|Bash` | `ran` |
| `append` | `Write\|Edit` | `skipped-matcher` |

Every sample is 2,000 dispatches; the reported number is **microseconds per
dispatch**, and the probe asserts the exact trace and a `continue` decision
after each sample. The gate is the head median strictly below **50 us per
dispatch** (the observed value is roughly 8–10 us). The base/head ratio is
printed as description; the absolute cap is the gate. The dispatch is
in-process: no host, no CLI, no IPC.

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

The gate is the median of the paired ratios at or below 1.5x. If base and head
compiled a different plugin set, P4 is reported not comparable and the gate
fails; the ratio would mix sets. P4 does not depend on the DSH pin.

### P5 — recorded, never gated

| number | source |
| --- | --- |
| tarball bytes | `npm pack --ignore-scripts --json` on the head |
| unpacked bytes | the same JSON's `unpackedSize` |
| mods kernel bytes | `lib/kernel-size.json` (D46's 128 KiB ceiling) |
| boot peak RSS | the P2 child's `process.resourceUsage().maxRSS` |

P5 has no base/head pair. It changes for many reasons (a dependency bump, a
platform's allocator, test fixtures) and none of them is "the hot path got
slower", so it is stamped `informational` in the table and the JSON, its gate
rows say `record`, and no verdict reads it.

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
- **No cross-machine ratio.** A paired ratio is meaningful only inside the run
  that produced it. P2's 3000 ms and P3's 50 us are budgets on the CI runner,
  not numbers comparable to a laptop.
- **No release gate hidden in `verify`.** `verify` stays perf-free; the
  separate `perf` workflow is where the D76 limits run.

## Variance: what to expect, and what a ratio means

A ratio is the median of per-pair `head/base` values, and the two halves of a
pair run back to back. On identical code — every ratio a noise control — that
is the number to expect around 1.00.

Before pairing, the harness measured the base in one block and the head in the
next. On identical code that produced 1.20x/1.51x and then 1.74x/1.73x on
P1/P3 while the host was busy; even alternating whole-side blocks still
produced 1.89x on P3. The machine's load trajectory had become the regression.

Five consecutive `--base HEAD --repeat 5` runs after pairing, on the same busy
host and the same commit:

| probe | the five ratios | ratio-gated by D76? |
| --- | --- | --- |
| P1 | 1.077, 1.011, 1.033, 1.014, 1.025 | yes |
| P3 | 0.924, 0.967, 0.944, 0.965, 0.987 | no — 50 us head cap |
| P4 | 1.025, 0.990, 0.994, 1.005, 0.990 | yes |
| P2 rc.2 | 1.021, 0.966, 0.928, 0.933, 0.906 | no — head boot caps |
| P2 rc.5 | 1.073, 0.958, 1.021, 1.193, 1.011 | no — head boot caps |

The ratio bar is every ratio inside 0.85–1.18 over five consecutive runs on
identical code. P1 and P4 hold. P3's five-run ratio also sits inside the band,
but its gate is the 50 us cap; P2's rc.5 ratio misses once, which is why D76
does not gate that ratio. Do not widen a cap to turn a miss into a pass; make
the probe honest or take the claim out of the gate.

So:

- on the ratio-gated probes the five-run spread was 0.990–1.077. A ratio inside
  that band is the probe's own noise, not a regression; a ratio outside it is
  worth a second run before reading anything into it;
- P1/P4 fail at a paired ratio above 1.5x. P2 fails at a head empty boot above
  3000 ms or a one-plugin boot above 2x the empty boot. P3 fails at a head
  median above 50 us per dispatch. Those are the only automatic verdicts;
- P2's base/head ratio and P5 are printed, never gated. Read the P2 ratio as a
  direction (about ±20–30 %), not as a pass/fail; P5 says `informational` in
  both output modes;
- absolute medians in two different runs are not a comparison. A ratio is
  meaningful only from the same run, and the D76 absolute caps are budgets,
  not cross-run comparisons.

Raising `--repeat` tightens every median; it cannot remove the drift between
separate runs.
