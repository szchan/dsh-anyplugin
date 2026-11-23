#!/usr/bin/env node
/**
 * perf — measure our own hot paths, as ratios against a base revision.
 *
 * `npm run verify` answers "is the behavior right". This script answers a
 * different question: "did the hot path get slower than the base commit". It
 * never prints a standalone millisecond count as a claim — a number on one
 * machine at one moment is not comparable to anything. Every probe prints a
 * base/head pair and the ratio between them, and a regression is a ratio, not
 * a millisecond count. Three probes also have absolute caps, because their
 * cross-run ratio is the noisy quantity (D76): P2's empty-profile boot and its
 * one-plugin multiplier, and P3's per-dispatch time. P5 (bytes and RSS) is
 * recorded in the artifact and never gates.
 *
 * The four probes, cheapest-first:
 *
 *   P1  cold mod load      loadMod + evaluate of the pinned upstream `diff`
 *                          mod, the kernel's slowest single unit.
 *   P2  boot + reconcile   the host's own profile loader boots an empty profile
 *                          and a profile with one installed plugin, once per
 *                          declared DSH pin; the controller reconciles the
 *                          second and the multiplier is gated.
 *   P3  interception       runChain over three handlers with one matcher hit;
 *                          microseconds per dispatch.
 *   P4  compile            readClaudePlugin + gate + emit over the seven
 *                          pinned upstream mods and every fixture plugin.
 *
 * P5 reports the tarball's bytes, its unpacked bytes, the mods kernel's bytes
 * and share, and the boot's peak RSS. It is stamped `informational` in both
 * output modes and neither `--check` nor `--ci` looks at it.
 *
 * How the base is measured: a detached worktree at the base commit, built
 * there. P1/P3/P4 import the base and the head in one child and measure them
 * sample by sample in alternating order, so neither side shares a module graph
 * with the other and a load drift cancels inside a pair. P2 boots the two
 * sides in separate children, because two hosts in one process would fight
 * over the DSH globals; its passes run in opposite order. Third-party
 * dependencies are shared only when `package-lock.json` is byte-identical;
 * otherwise the base gets its own offline `npm install`. Everything the runner
 * does for itself (worktree, build, pack) happens outside every stopwatch.
 *
 * `--ci` is the workflow's mode (`.github/workflows/perf.yml`): it runs the
 * ratified D76 gate set, writes `perf.json`, and exits 1 on a failed gate.
 * `--check` runs the same verdicts on a workstation. Plain `npm run perf`
 * stays a local debugging aid and is never a merge gate.
 *
 * The five environment variables are the suite's (`DSH_HARNESS_DIR`,
 * `DSH_HARNESS_VERSION`, `CLAUDE_BIN`, `ANYPLUGIN_MODS_TREE`,
 * `ANYPLUGIN_MOD_TREE`): a perf run must measure the environment the gate
 * measures. A missing one is a named failure, never a skip — P2 is the only
 * probe that spends them, but a run in a different environment would not be
 * comparable. The harness makes no network call and fetches no ref.
 *
 * docs/PROFILING.md is the contract; this file is the measurement.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const CHECKOUT = fileURLToPath(new URL('..', import.meta.url))

/** The environment the suite requires; the perf run uses the same five. */
export const ENV_VARS = Object.freeze([
  'DSH_HARNESS_DIR',
  'DSH_HARNESS_VERSION',
  'CLAUDE_BIN',
  'ANYPLUGIN_MODS_TREE',
  'ANYPLUGIN_MOD_TREE',
])

export const DEFAULT_BASE = 'origin/main'
export const DEFAULT_REPEAT = 5

/** The pair count the gate's claim is defined on (D76). */
const GATE_REPEAT = 5
export const DEFAULT_THRESHOLD = 1.5
export const REPORT_SCHEMA = 'dsh-anyplugin/perf@1'

/**
 * The ratified D76 gate set. Ratios are ceilings: a value at the limit is
 * inside it, matching `exceedsThreshold`. P2's empty cap is absolute
 * milliseconds; its one-plugin cap is a multiplier over the *head's* empty
 * median, so a slow runner that moves both boots together does not trip it.
 */
export const GATE_LIMITS = Object.freeze({
  ratio: 1.5,
  p2EmptyMs: 3000,
  p2PluginOverEmpty: 2,
  p3Micros: 50,
  p4Ratio: 1.5,
})

/** The artifact name the workflow uploads, and how long it keeps it. */
export const CI_ARTIFACT = 'perf.json'
export const ARTIFACT_RETENTION_DAYS = 30

/** One warmup, then this many timed samples per probe, per side. */
const MAX_REPEAT = 100
/** P3's batch: enough dispatches that a sample is milliseconds, not timer noise. */
const DISPATCH_BATCH = 2000
/** The diff mod's registration count, from fixtures/mods/upstream.json. */
const DIFF_MOD = 'diff'

export const USAGE = `perf — measure dsh-anyplugin's own hot paths against a base ref.

Usage:
  npm run perf [-- --base <git-ref>] [--repeat <n>] [--json | --quiet]
               [--check | --ci] [--json-out <path>] [--threshold <x>]

Probes (base, head, ratio; P2/P3 also have absolute caps, P5 never gates):
  P1  cold mod load      loadMod + evaluate of the pinned upstream diff mod;
                         head/base ratio <= ${GATE_LIMITS.ratio}x
  P2  boot + reconcile   an empty profile and a one-installed-plugin profile,
                         once per DSH pin declared in engines.dsh; head empty
                         boot <= ${GATE_LIMITS.p2EmptyMs} ms absolute and head
                         one-plugin <= ${GATE_LIMITS.p2PluginOverEmpty}x head empty
  P3  interception       runChain over three handlers, one matcher hit;
                         <= ${GATE_LIMITS.p3Micros} us per dispatch absolute
  P4  compile            readClaudePlugin + gate + emit over the seven upstream
                         mods and every fixture that carries a plugin manifest;
                         head/base ratio <= ${GATE_LIMITS.p4Ratio}x
  P5  recorded           tarball bytes, unpacked bytes, mods kernel bytes and
                         share, and the boot's peak RSS; never gated

Options:
  --base <ref>       base revision measured in a separate worktree
                     (default: ${DEFAULT_BASE}; the ref must exist locally)
  --repeat <n>       samples per side, 1..${MAX_REPEAT} (default: ${DEFAULT_REPEAT});
                     P1/P3/P4 take 2n interleaved samples per side, P2 takes n
                     paired boots per profile and side plus one discarded
                     warm-up pair
  --json             print the JSON report instead of the table
  --quiet            print only the JSON report; suppress notes (failures print)
  --check            run the D76 gates and exit 1 when one trips; --threshold
                     may relax the P1/P4 ratio ceiling for local experiments
  --ci               the workflow mode: the fixed D76 limits, writes
                     ${CI_ARTIFACT} (or --json-out), and exits 1 on a failed
                     gate; --threshold is rejected so a run cannot change the
                     ratified ceilings
  --json-out <path>  write the JSON report to <path> as well as printing
  --threshold <x>    P1/P4 ratio ceiling for --check (default:
                     ${DEFAULT_THRESHOLD}); requires --check, rejected by --ci
  -h, --help         this text

Environment (the suite's five; a missing one is a named failure, not a skip):
  DSH_HARNESS_DIR  DSH_HARNESS_VERSION  CLAUDE_BIN
  ANYPLUGIN_MODS_TREE  ANYPLUGIN_MOD_TREE

The harness makes no network call and fetches no ref. See docs/PROFILING.md for
what each probe measures and what it deliberately does not.
`

export class PerfError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PerfError'
  }
}

// ---------------------------------------------------------------------------
// Pure helpers. Everything below `runSuite` is measured; these are the parts a
// unit test can pin, and the parts a mutation can redden.
// ---------------------------------------------------------------------------

/**
 * Strictly greater: a ratio exactly at the threshold is inside it. A ratio
 * threshold is a ceiling for a *regression*, and measuring exactly the
 * pre-registered value is not a regression.
 */
export function exceedsThreshold(ratio, threshold) {
  return ratio > threshold
}

/**
 * At or above: an absolute budget is a wall, not a ratio. The ratified caps
 * read "< 3 s", "< 2x empty", "< 50 us", so the boundary value itself fails —
 * otherwise the gate is wider than the number the maintainer approved
 * (reviewer finding on #231).
 */
export function exceedsCap(value, cap) {
  return value >= cap
}

/** Median of the timed samples. Empty input is a harness bug, not a zero. */
export function median(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new PerfError('perf: median() needs at least one sample')
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * Ratio direction is the one claim every row makes: head over base, so a value
 * below 1 is faster and a value above 1 is the regression `--check` names.
 */
export function headOverBase(baseValue, headValue) {
  if (!Number.isFinite(baseValue) || baseValue <= 0) {
    throw new PerfError(`perf: the base measurement is ${baseValue}; a ratio needs a positive base`)
  }
  if (!Number.isFinite(headValue) || headValue < 0) {
    throw new PerfError(`perf: the head measurement is ${headValue}; a ratio needs a non-negative head`)
  }
  return headValue / baseValue
}

/**
 * Ratios for paired samples: sample i on the head over sample i on the base.
 * The pair, not the side's median, is the unit — a burst that slows one side
 * also slows the adjacent sample, so it mostly cancels inside the pair.
 */
export function pairRatios(baseSamples, headSamples) {
  if (!Array.isArray(baseSamples) || !Array.isArray(headSamples)) {
    throw new PerfError('perf: pairRatios() needs two sample arrays')
  }
  if (baseSamples.length === 0 || baseSamples.length !== headSamples.length) {
    throw new PerfError(
      `perf: pairRatios() needs the same non-zero sample count on both sides (${baseSamples.length} vs ${headSamples.length})`,
    )
  }
  return baseSamples.map((value, index) => headOverBase(value, headSamples[index]))
}

function measuredMedian(row) {
  const value = row?.head?.median
  return Number.isFinite(value) ? value : null
}

function measuredBase(row) {
  const value = row?.base?.median
  return Number.isFinite(value) ? value : null
}

function finiteRatio(value) {
  return Number.isFinite(value) ? value : null
}

function gateRow(probe, metric, unit, base, head, ratio, limit, limitKind, limitText, ok, detail) {
  return {
    probe,
    metric,
    unit,
    base,
    head,
    ratio,
    limit,
    limitKind,
    limitText,
    verdict: ok ? 'pass' : 'FAIL',
    detail: ok ? null : detail,
  }
}

/**
 * The D76 verdict table: one row per gated measurement, plus P5 as `record`
 * rows so the artifact's table shows what was recorded and what was gated.
 * Pure: it reads a finished report and never measures. A missing measurement
 * is a failure, never a skipped row — a gate that vanishes is a green light
 * nobody earned.
 */
export function gateRows(report, limits = GATE_LIMITS) {
  const rows = []

  const p1 = report.probes?.P1
  const p1Base = measuredBase(p1)
  const p1Head = measuredMedian(p1)
  const p1Ratio = finiteRatio(p1?.ratio)
  const p1Ok = p1Ratio !== null && !exceedsThreshold(p1Ratio, limits.ratio)
  rows.push(
    gateRow(
      'P1',
      'P1 cold mod load',
      'ms',
      p1Base,
      p1Head,
      p1Ratio,
      limits.ratio,
      'ratio',
      `${limits.ratio.toFixed(2)}x`,
      p1Ok,
      p1Ratio === null ? 'not measured' : null,
    ),
  )

  const p2 = report.probes?.P2
  if (!Array.isArray(p2) || p2.length === 0) {
    rows.push(
      gateRow(
        'P2',
        'P2 boot + reconcile',
        'ms',
        null,
        null,
        null,
        limits.p2EmptyMs,
        'ms',
        `${limits.p2EmptyMs} ms`,
        false,
        'not measured',
      ),
    )
  } else {
    for (const pin of p2) {
      const version = typeof pin?.version === 'string' ? pin.version : '?'
      const empty = pin?.empty
      const emptyBase = measuredBase(empty)
      const emptyHead = measuredMedian(empty)
      const emptyRatio = finiteRatio(empty?.ratio)
      const emptyOk = emptyHead !== null && !exceedsCap(emptyHead, limits.p2EmptyMs)
      rows.push(
        gateRow(
          'P2',
          `P2 empty boot @ dsh ${version}`,
          'ms',
          emptyBase,
          emptyHead,
          emptyRatio,
          limits.p2EmptyMs,
          'ms',
          `${limits.p2EmptyMs} ms`,
          emptyOk,
          emptyHead === null ? 'not measured' : null,
        ),
      )

      const oneBase = measuredBase(pin)
      const oneHead = measuredMedian(pin)
      const oneRatio = finiteRatio(pin?.ratio)
      const multiplier = limits.p2PluginOverEmpty
      let oneOk = false
      let oneDetail = null
      if (emptyHead === null) oneDetail = 'empty boot not measured'
      else if (oneHead === null) oneDetail = 'not measured'
      else oneOk = !exceedsCap(oneHead, multiplier * emptyHead)
      const oneLimit = emptyHead === null ? null : multiplier * emptyHead
      const oneLimitText =
        emptyHead === null
          ? `${multiplier.toFixed(2)}x empty (empty not measured)`
          : `${multiplier.toFixed(2)}x empty (${emptyHead.toFixed(1)} ms)`
      rows.push(
        gateRow(
          'P2',
          `P2 one-plugin boot @ dsh ${version}`,
          'ms',
          oneBase,
          oneHead,
          oneRatio,
          oneLimit,
          'multiplier',
          oneLimitText,
          oneOk,
          oneDetail,
        ),
      )
    }
  }

  const p3 = report.probes?.P3
  const p3Base = measuredBase(p3)
  const p3Head = measuredMedian(p3)
  const p3Ratio = finiteRatio(p3?.ratio)
  const p3Ok = p3Head !== null && !exceedsCap(p3Head, limits.p3Micros)
  rows.push(
    gateRow(
      'P3',
      'P3 pre-execute fan-out',
      'us',
      p3Base,
      p3Head,
      p3Ratio,
      limits.p3Micros,
      'absolute',
      `${limits.p3Micros.toFixed(1)} us`,
      p3Ok,
      p3Head === null ? 'not measured' : null,
    ),
  )

  const p4 = report.probes?.P4
  const p4Base = measuredBase(p4)
  const p4Head = measuredMedian(p4)
  const p4Ratio = finiteRatio(p4?.ratio)
  const p4Ok = p4?.comparable !== false && p4Ratio !== null && !exceedsThreshold(p4Ratio, limits.p4Ratio)
  let p4Detail = null
  if (p4?.comparable === false) p4Detail = 'not comparable (base and head compiled different plugin sets)'
  else if (p4Ratio === null) p4Detail = 'not measured'
  rows.push(
    gateRow(
      'P4',
      'P4 compile (7 upstream + fixtures)',
      'ms',
      p4Base,
      p4Head,
      p4Ratio,
      limits.p4Ratio,
      'ratio',
      `${limits.p4Ratio.toFixed(2)}x`,
      p4Ok,
      p4Detail,
    ),
  )

  const p5 = report.p5 ?? {}
  for (const [metric, unit, value] of [
    ['P5 tarball bytes', 'B', p5.tarballBytes],
    ['P5 unpacked bytes', 'B', p5.unpackedBytes],
    ['P5 mods kernel bytes', 'B', p5.kernelBytes],
    ['P5 boot peak RSS', 'KiB', p5.bootPeakRssKiB],
  ]) {
    rows.push({
      probe: 'P5',
      metric,
      unit,
      base: null,
      head: Number.isFinite(value) ? value : null,
      ratio: null,
      limit: null,
      limitKind: 'record',
      limitText: 'record only',
      verdict: 'record',
      detail: null,
    })
  }

  return rows
}

/**
 * A red gate is a regression claim, so its line names the probe, the observed
 * value, the limit and the repeat count (D69 rule 6 / D76).
 */
export function gateFailures(report, limits = GATE_LIMITS) {
  const repeat = Number.isInteger(report?.repeat) ? report.repeat : '?'
  return gateRows(report, limits)
    .filter((row) => row.verdict === 'FAIL')
    .map((row) => {
      if (row.detail !== null) return `${row.metric}: ${row.detail} (repeat ${repeat})`
      if (row.head === null) return `${row.metric}: not measured (repeat ${repeat})`
      if (row.limitKind === 'absolute' || row.limitKind === 'ms') {
        return `${row.metric}: ${row.head.toFixed(1)} ${row.unit} > ${row.limitText} (repeat ${repeat})`
      }
      if (row.limitKind === 'multiplier') {
        return `${row.metric}: ${row.head.toFixed(1)} ms > ${row.limitText} (repeat ${repeat})`
      }
      const ratio = row.ratio === null ? 'not measured' : `${row.ratio.toFixed(2)}x`
      return `${row.metric}: ${ratio} > ${row.limitText} (repeat ${repeat})`
    })
}

/**
 * Parse the CLI. `--threshold` without `--check` is an error rather than a
 * silently ignored flag: a threshold that gates nothing is worse than no
 * threshold. `--quiet` implies `--json` because its whole contract is "JSON on
 * stdout, nothing else".
 */
export function parseArgs(argv) {
  const options = {
    json: false,
    quiet: false,
    check: false,
    ci: false,
    help: false,
    base: DEFAULT_BASE,
    repeat: DEFAULT_REPEAT,
    threshold: DEFAULT_THRESHOLD,
    thresholdSet: false,
    jsonOut: null,
    probe: null,
    root: CHECKOUT,
    roots: null,
    pins: null,
  }

  const inlineValue = (flag, inline) => {
    if (inline === undefined) return undefined
    if (inline === '') throw new PerfError(`perf: ${flag} needs a value`)
    return inline
  }
  const takeValue = (flag, inline, index) => {
    const value = inlineValue(flag, inline)
    if (value !== undefined) return value
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new PerfError(`perf: ${flag} needs a value`)
    return next
  }
  const noValue = (flag, inline) => {
    if (inline !== undefined) throw new PerfError(`perf: ${flag} does not take a value`)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h') {
      options.help = true
      continue
    }
    if (!arg.startsWith('--')) throw new PerfError(`perf: unexpected argument ${JSON.stringify(arg)}`)
    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const inline = equals === -1 ? undefined : arg.slice(equals + 1)

    switch (flag) {
      case '--json':
        noValue(flag, inline)
        options.json = true
        break
      case '--quiet':
        noValue(flag, inline)
        options.quiet = true
        options.json = true
        break
      case '--check':
        noValue(flag, inline)
        options.check = true
        break
      // The workflow mode: same verdicts, fixed limits, an artifact on disk.
      // It does not imply --json; the table is what the CI log should show.
      case '--ci':
        noValue(flag, inline)
        options.ci = true
        options.check = true
        break
      case '--json-out': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        if (value.trim() === '') throw new PerfError('perf: --json-out needs a non-empty path')
        options.jsonOut = value
        break
      }
      case '--help':
      case '-h':
        noValue(flag, inline)
        options.help = true
        break
      case '--base': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        if (value.trim() === '') throw new PerfError('perf: --base needs a non-empty git ref')
        options.base = value
        break
      }
      case '--repeat': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        const repeat = Number(value)
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
          throw new PerfError(`perf: --repeat must be an integer from 1 to ${MAX_REPEAT}, got ${JSON.stringify(value)}`)
        }
        if (options.ci && repeat < GATE_REPEAT) {
          // --ci is the workflow mode; its claim is the median of five pairs.
          // A one-line workflow edit must not turn the gate into one sample.
          throw new PerfError(`perf: --ci needs --repeat >= ${GATE_REPEAT} (the median of ${GATE_REPEAT} pairs is the claim), got ${repeat}`)
        }
        options.repeat = repeat
        break
      }
      case '--threshold': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        const threshold = Number(value)
        if (!Number.isFinite(threshold) || threshold <= 0) {
          throw new PerfError(`perf: --threshold must be a positive number, got ${JSON.stringify(value)}`)
        }
        options.threshold = threshold
        options.thresholdSet = true
        break
      }
      // Internal: the runner re-executes this script once per side so the base
      // and the head never share a module graph. Not documented in USAGE.
      case '--probe': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        if (value !== 'core' && value !== 'boot') throw new PerfError('perf: --probe must be core or boot')
        options.probe = value
        break
      }
      case '--root': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        options.root = resolve(value)
        break
      }
      // Internal: the core probe measures both checkouts in one child, sample
      // by sample, so a load drift over the run cannot become a ratio.
      case '--roots': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        options.roots = value.split('\n').map((entry) => resolve(entry))
        if (options.roots.length !== 2) throw new PerfError('perf: --roots needs the base and the head checkout')
        break
      }
      case '--pins': {
        const value = takeValue(flag, inline, index)
        if (inline === undefined) index += 1
        try {
          options.pins = JSON.parse(value)
        } catch {
          throw new PerfError('perf: --pins must be a JSON array')
        }
        if (!Array.isArray(options.pins)) throw new PerfError('perf: --pins must be a JSON array')
        break
      }
      default:
        throw new PerfError(`perf: unknown option ${flag}\n\n${USAGE}`)
    }
  }

  if (options.thresholdSet && !options.check) {
    throw new PerfError('perf: --threshold only means something with --check')
  }
  if (options.ci && options.thresholdSet) {
    throw new PerfError('perf: --ci uses the ratified D76 limits; --threshold is a local --check experiment')
  }
  if (options.ci && options.jsonOut === null) options.jsonOut = CI_ARTIFACT
  if (options.quiet) options.json = true
  // Flag order must not matter: `--repeat 1 --ci` is the same request as
  // `--ci --repeat 1`.
  if (options.ci && options.repeat < GATE_REPEAT) {
    throw new PerfError(`perf: --ci needs --repeat >= ${GATE_REPEAT} (the median of ${GATE_REPEAT} pairs is the claim), got ${options.repeat}`)
  }
  return options
}

/**
 * Environment problems as a list, so one failure names every missing variable
 * instead of making the operator discover them one run at a time. Structural
 * checks only: P1/P3/P4 do not need the harness, but a perf run must describe
 * the suite's environment, so all five are required for every probe.
 */
export function perfEnvProblems(env = process.env) {
  const problems = []
  const present = (name) => typeof env[name] === 'string' && env[name].trim() !== ''

  for (const name of ENV_VARS) {
    if (!present(name)) problems.push(`${name} is not set`)
  }
  if (!present('DSH_HARNESS_DIR')) return problems

  const harnessDir = env.DSH_HARNESS_DIR
  const harnessProblems = []
  if (!existsSync(harnessDir) || !statSync(harnessDir).isDirectory()) {
    harnessProblems.push('is not a directory')
  } else if (!existsSync(join(harnessDir, 'node_modules', '@deepseek-ai'))) {
    harnessProblems.push('does not contain node_modules/@deepseek-ai; point it at a fetched install root')
  }
  if (harnessProblems.length > 0) problems.push(`DSH_HARNESS_DIR: ${harnessDir} ${harnessProblems.join('; ')}`)

  if (present('CLAUDE_BIN')) {
    const claudeBin = env.CLAUDE_BIN
    let problem = null
    try {
      if (!statSync(claudeBin).isFile()) problem = 'is not a file'
      else accessSync(claudeBin, fsConstants.X_OK)
    } catch (error) {
      problem = error?.code === 'EACCES' ? 'is not executable' : 'does not exist'
    }
    if (problem !== null) problems.push(`CLAUDE_BIN: ${claudeBin} ${problem}`)
  }

  if (present('ANYPLUGIN_MODS_TREE')) {
    const modsTree = env.ANYPLUGIN_MODS_TREE
    if (!existsSync(modsTree) || !statSync(modsTree).isDirectory()) {
      problems.push(`ANYPLUGIN_MODS_TREE: ${modsTree} is not a directory`)
    } else if (!existsSync(join(modsTree, 'mods'))) {
      problems.push(`ANYPLUGIN_MODS_TREE: ${modsTree} has no mods/ directory`)
    }
  }

  if (present('ANYPLUGIN_MOD_TREE')) {
    const modTree = env.ANYPLUGIN_MOD_TREE
    if (!existsSync(modTree) || !statSync(modTree).isDirectory()) {
      problems.push(`ANYPLUGIN_MOD_TREE: ${modTree} is not a directory`)
    } else if (!existsSync(join(modTree, 'register.ts'))) {
      problems.push(`ANYPLUGIN_MOD_TREE: ${modTree} has no register.ts`)
    }
  }

  return problems
}

export function requirePerfEnv(env = process.env) {
  const problems = perfEnvProblems(env)
  if (problems.length > 0) {
    throw new PerfError(
      `perf: the environment does not match the one the suite measures (a skip would hide it):\n` +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\nSee the environment block in docs/PROFILING.md.',
    )
  }
  return {
    harnessDir: env.DSH_HARNESS_DIR,
    harnessVersion: env.DSH_HARNESS_VERSION,
    claudeBin: env.CLAUDE_BIN,
    modsTree: env.ANYPLUGIN_MODS_TREE,
    modTree: env.ANYPLUGIN_MOD_TREE,
  }
}

function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

function formatMeasurement(value, unit) {
  if (!Number.isFinite(value)) return '-'
  return unit === 'us' ? value.toFixed(2) : value.toFixed(1)
}

/** The human table. P5 says "informational" in the text, not only in JSON. */
export function formatTable(report) {
  const lines = []
  lines.push(
    `dsh-anyplugin perf — base ${report.base.commit.slice(0, 8)} (${report.base.ref}) -> head ${report.head.commit.slice(0, 8)}`,
  )
  lines.push(
    `node ${report.node} · ratio = median of per-pair head/base · P1/P3/P4 ${report.repeat * 2} interleaved samples/side · P2 ${report.repeat} paired boots per profile/side`,
  )
  lines.push('')

  const rows = []
  const ratioText = (ratio) => (ratio === null || !Number.isFinite(ratio) ? '-' : `${ratio.toFixed(2)}x`)
  const pair = (id, label, row) => {
    rows.push([
      id,
      label,
      `${formatMeasurement(row.base.median, row.unit)} ${row.unit}`,
      `${formatMeasurement(row.head.median, row.unit)} ${row.unit}`,
      ratioText(row.ratio),
    ])
  }

  pair('P1', 'cold mod load: diff (loadMod + evaluate)', report.probes.P1)
  for (const row of report.probes.P2) {
    const pin = row.version ?? row.pin
    if (row.empty === undefined || row.empty.base === null || row.empty.head === null) {
      rows.push(['P2', `empty boot (no lock) @ dsh ${pin}`, '-', '-', '-'])
    } else {
      pair('P2', `empty boot (no lock) @ dsh ${pin}`, row.empty)
    }
    if (row.base === null || row.head === null) {
      rows.push(['P2', `one-plugin boot + reconcile @ dsh ${pin}`, '-', '-', '-'])
      continue
    }
    const comparable = {
      unit: 'ms',
      base: { median: row.base.median },
      head: { median: row.head.median },
      ratio: row.ratio,
    }
    pair('P2', `one-plugin boot + reconcile @ dsh ${pin}`, comparable)
  }
  pair('P3', `interception: runChain, 3 handlers, 1 match`, report.probes.P3)
  const p4 = report.probes.P4
  pair('P4', `compile: ${p4.plugins?.head ?? '?'} plugins (read+gate+emit)`, p4)
  if (p4.comparable === false) {
    rows[rows.length - 1][4] = 'n/c'
  }

  const headers = ['probe', 'measure', 'base', 'head', 'ratio']
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  )
  const formatRow = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()
  lines.push(formatRow(headers))
  for (const row of rows) lines.push(formatRow(row))

  const limits = report.gateLimits ?? GATE_LIMITS
  lines.push('')
  lines.push(
    `gated (D76): P1 ratio <= ${limits.ratio}x · P2 empty <= ${limits.p2EmptyMs} ms and one-plugin <= ${limits.p2PluginOverEmpty}x empty · P3 <= ${limits.p3Micros} us/dispatch · P4 ratio <= ${limits.p4Ratio}x`,
  )
  lines.push('recorded, never gated: P5')
  lines.push('P5  head only')
  const p5 = report.p5
  const byte = (value) => (typeof value === 'number' ? `${groupDigits(value)} bytes` : '-')
  lines.push(`    tarball        ${byte(p5.tarballBytes)}`)
  lines.push(`    unpacked       ${byte(p5.unpackedBytes)}`)
  lines.push(`    mods kernel    ${byte(p5.kernelBytes)}`)
  lines.push(
    `    boot peak RSS  ${typeof p5.bootPeakRssKiB === 'number' ? `${groupDigits(p5.bootPeakRssKiB)} KiB` : '-'}`,
  )
  if (report.check !== null) {
    const checkRows = report.check.rows ?? gateRows(report, report.check.limits ?? GATE_LIMITS)
    const gated = checkRows.filter((row) => row.verdict !== 'record').length
    lines.push('')
    lines.push(
      report.check.failures.length === 0
        ? `gates: ${gated} measurements, all pass (repeat ${report.repeat})`
        : `gates: ${report.check.failures.length} failed (repeat ${report.repeat}) — ${report.check.failures.join('; ')}`,
    )
  }
  return lines.join('\n')
}

/**
 * The CI gate table: metric, base, head, ratio, limit, verdict. `--ci` prints
 * this to the workflow log, so a red job names the row without opening the
 * artifact. It reads the rows the report already carries, so the table and
 * the exit code cannot disagree.
 */
export function formatGateTable(report) {
  const rows = report.check?.rows ?? gateRows(report, report.check?.limits ?? GATE_LIMITS)
  const lines = []
  const baseRef = report.base?.ref ?? '?'
  const baseSha = report.base?.commit?.slice(0, 8) ?? '?'
  const headSha = report.head?.commit?.slice(0, 8) ?? '?'
  lines.push(
    `dsh-anyplugin perf gates — base ${baseSha} (${baseRef}) -> head ${headSha} · repeat ${report.repeat}`,
  )
  const formatValue = (value, unit) => {
    if (!Number.isFinite(value)) return '-'
    if (unit === 'B' || unit === 'KiB') return `${groupDigits(Math.round(value))} ${unit}`
    return `${formatMeasurement(value, unit)} ${unit}`
  }
  const cells = rows.map((row) => [
    row.metric,
    formatValue(row.base, row.unit),
    formatValue(row.head, row.unit),
    row.ratio === null || !Number.isFinite(row.ratio) ? '-' : `${row.ratio.toFixed(2)}x`,
    row.limitText,
    row.verdict,
  ])
  const headers = ['metric', 'base', 'head', 'ratio', 'limit', 'verdict']
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => row[column].length)),
  )
  const formatRow = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()
  lines.push(formatRow(headers))
  for (const row of cells) lines.push(formatRow(row))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Shared plumbing: git, child probes, the scratch home.
// ---------------------------------------------------------------------------

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    throw new PerfError(
      `perf: git ${args.join(' ')} failed in ${root}: ${String(error.stderr ?? error.message ?? error).trim()}`,
    )
  }
}

function buildSide(root) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new PerfError(
      `perf: building ${root} failed; P2 boots the artifact the tarball ships:\n${String(result.stderr).trim()}`,
    )
  }
}

function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * The base worktree gets the head's node_modules only when the lockfile is
 * byte-identical. Product packages import each other relatively (checked in
 * review), so a shared dependency tree cannot mix base and head package code;
 * a different lockfile means a different dependency set, so the base installs
 * its own copy offline.
 */
function shareDependencies(headRoot, baseRoot, notes) {
  const headLock = join(headRoot, 'package-lock.json')
  const baseLock = join(baseRoot, 'package-lock.json')
  if (existsSync(headLock) && existsSync(baseLock) && fileHash(headLock) === fileHash(baseLock)) {
    symlinkSync(join(headRoot, 'node_modules'), join(baseRoot, 'node_modules'), 'dir')
    notes.push('base worktree shares the head node_modules (package-lock.json matches)')
    return
  }
  notes.push('base worktree has a different lockfile; installing its dependencies offline')
  const result = spawnSync(
    'npm',
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'],
    {
      cwd: baseRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(headRoot, '.npm-cache') },
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if (result.status !== 0) {
    throw new PerfError(
      `perf: the base worktree's package-lock.json differs from the head's and the offline install failed:\n${String(
        result.stderr,
      ).trim()}`,
    )
  }
}

function runProbe(kind, root, options, extraArgs = []) {
  const args = [
    '--experimental-vm-modules',
    SCRIPT_PATH,
    '--probe',
    kind,
    ...(root === null ? [] : ['--root', root]),
    '--repeat',
    String(options.repeat),
    ...extraArgs,
  ]
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  })
  if (result.error !== undefined) {
    throw new PerfError(`perf: the ${kind} probe for ${root} did not run: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new PerfError(
      `perf: the ${kind} probe for ${root} failed (exit ${result.status}):\n${String(result.stderr).trim().split('\n').slice(-12).join('\n')}`,
    )
  }
  const lines = String(result.stdout).trim().split('\n')
  try {
    return JSON.parse(lines[lines.length - 1])
  } catch {
    throw new PerfError(`perf: the ${kind} probe for ${root} did not print a JSON report:\n${lines.slice(-5).join('\n')}`)
  }
}

const pluginRootFrom = (root, relativePath) => join(root, relativePath)
const moduleUrlFor = (root, relativePath) => pathToFileURL(pluginRootFrom(root, relativePath)).href

function assert(condition, message) {
  if (!condition) throw new PerfError(`perf: ${message}`)
}

async function discoverPins(env, notes) {
  const { resolveHarness } = await import(
    moduleUrlFor(CHECKOUT, 'packages/dsh-anyplugin-conformance/src/harness.ts')
  )
  let located
  try {
    located = resolveHarness({ env, repoRoot: CHECKOUT })
  } catch (error) {
    throw new PerfError(`perf: DSH_HARNESS_DIR/DSH_HARNESS_VERSION did not resolve: ${error.message}`)
  }
  if (located === undefined) {
    throw new PerfError(
      `perf: DSH_HARNESS_DIR=${env.DSH_HARNESS_DIR} is not a harness install root; fetch the pin first`,
    )
  }
  const rootPackage = JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8'))
  const declared = String(rootPackage.engines?.dsh ?? '')
    .split('||')
    .map((version) => version.trim())
    .filter(Boolean)
  const versions = declared.includes(located.version) ? declared : [...declared, located.version]
  const siblingRoot = dirname(located.installRoot)
  return versions.map((version) => {
    if (version === located.version) return { version, installRoot: located.installRoot, available: true }
    const installRoot = join(siblingRoot, version)
    // The fetched tree is a union of dsh-* packages, not a single `dsh`
    // package, so availability is decided by the oracle itself, not by a path
    // guess. A throw means the sibling is not a harness either.
    let available = false
    try {
      available =
        resolveHarness({
          env: { ...process.env, DSH_HARNESS_DIR: installRoot, DSH_HARNESS_VERSION: version },
          repoRoot: CHECKOUT,
        }) !== undefined
    } catch {
      available = false
    }
    if (!available) {
      notes.push(
        `P2: DSH ${version} is declared in engines.dsh but ${installRoot} is not a fetched harness; run node scripts/fetch-harness.mjs ${version}`,
      )
    }
    return { version, installRoot, available }
  })
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function summarize(samples, unit) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new PerfError(`perf: no ${unit} samples were measured`)
  }
  return { median: median(samples), samples: samples.map((sample) => Number(sample.toFixed(4))) }
}

/**
 * One core-probe row. The ratio is the median of the per-pair head/base
 * values: base and head were measured next to each other, so the pair is the
 * comparison. headOverBase(base.median, head.median) would turn drift between
 * the two halves into a ratio, which is the bug the pairing exists to avoid.
 */
export function coreReportRow({ unit, baseSamples, headSamples }) {
  return {
    unit,
    base: summarize(baseSamples, unit),
    head: summarize(headSamples, unit),
    ratio: median(pairRatios(baseSamples, headSamples)),
  }
}

/** The P2 row: the same pair-median contract, for one pin's paired boots. */
export function pinReportRow({ pin, samples, emptySamples, hostPath, moduleUrl }) {
  const ratios = pairRatios(samples.base, samples.head)
  const row = {
    pin,
    unit: 'ms',
    base: summarize(samples.base, 'ms'),
    head: summarize(samples.head, 'ms'),
    ratio: median(ratios),
    pairs: ratios.map((ratio) => Number(ratio.toFixed(4))),
    hostPath,
    pinnedFiles: moduleUrl,
  }
  if (emptySamples !== undefined) {
    const emptyRatios = pairRatios(emptySamples.base, emptySamples.head)
    row.empty = {
      unit: 'ms',
      base: summarize(emptySamples.base, 'ms'),
      head: summarize(emptySamples.head, 'ms'),
      ratio: median(emptyRatios),
      pairs: emptyRatios.map((ratio) => Number(ratio.toFixed(4))),
    }
  }
  return row
}

async function runSuite(options) {
  const env = requirePerfEnv()
  const notes = []
  const pins = await discoverPins(process.env, notes)

  const headCommit = git(CHECKOUT, ['rev-parse', 'HEAD'])
  // A ref is a git argument, not shell text, but an argument starting with a
  // dash is still an option to rev-parse; refuse it instead of hoping.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]*$/.test(options.base)) {
    throw new PerfError(`perf: --base ${JSON.stringify(options.base)} does not look like a git ref`)
  }
  let baseCommit
  try {
    baseCommit = git(CHECKOUT, ['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`])
  } catch {
    throw new PerfError(
      `perf: --base ${options.base} is not a local commit (the harness never fetches). ` +
        `Fetch it, or pass a local ref such as --base HEAD~1.`,
    )
  }
  if (baseCommit === headCommit) {
    notes.push('base and head are the same commit; the ratios are a noise control, not a regression')
  }

  const scratchRoot = mkdtempSync(join(tmpdir(), 'anyplugin-perf-'))
  const baseRoot = join(scratchRoot, 'base')
  let added = false
  try {
    git(CHECKOUT, ['worktree', 'add', '--detach', '--quiet', baseRoot, baseCommit])
    added = true
    shareDependencies(CHECKOUT, baseRoot, notes)

    // The build and the pack are the harness's own cost: every stopwatch below
    // starts after them. P2 boots `lib/`, the same artifact the tarball ships.
    buildSide(CHECKOUT)
    buildSide(baseRoot)

    const bootPins = pins.filter((pin) => pin.available).map(({ version, installRoot }) => ({ version, installRoot }))

    // P1, P3 and P4 measure both checkouts in ONE child, alternating
    // [base, head] and [head, base] sample by sample: a ratio taken from two
    // separate blocks reports the host's load trajectory as if it were a code
    // change, while a pair measured next to each other does not.
    const core = runProbe('core', null, options, ['--roots', [baseRoot, CHECKOUT].join('\n')])
    const headCore = core.head
    const baseCore = core.base

    // P2 also measures both checkouts in ONE child per pin, and alternates
    // its boots pair by pair: base then head, then head then base, after one
    // discarded warm-up pair on each side. Four unpaired children let the
    // cold first child and the host's drift become the ratio, and a median of
    // merged blocks cannot cancel that.
    const boot = runProbe('boot', null, options, [
      '--roots',
      [baseRoot, CHECKOUT].join('\n'),
      '--pins',
      JSON.stringify(bootPins),
    ])

    const coreRow = (id, unit) =>
      coreReportRow({ unit, baseSamples: baseCore[id].samples, headSamples: headCore[id].samples })

    const headPluginNames = [...headCore.p4.upstream, ...headCore.p4.fixtures].sort()
    const basePluginNames = [...baseCore.p4.upstream, ...baseCore.p4.fixtures].sort()
    const comparable = JSON.stringify(headPluginNames) === JSON.stringify(basePluginNames)
    if (!comparable) {
      notes.push('P4: base and head compiled different plugin sets; the ratio would mix sets and is reported as n/c')
    }

    const p2 = pins.map((pin) => {
      const measured = boot.pins.find((entry) => entry.version === pin.version)
      if (!pin.available) {
        return {
          version: pin.version,
          pin: pin.version,
          unit: 'ms',
          base: null,
          head: null,
          ratio: null,
          empty: null,
          reason: 'pin not fetched',
        }
      }
      assert(measured !== undefined, `P2 measured no boot for dsh ${pin.version}`)
      assert(measured.empty !== undefined, `P2 measured no empty boot for dsh ${pin.version}`)
      return {
        ...pinReportRow({
          pin: pin.version,
          samples: measured.samples,
          emptySamples: measured.empty.samples,
          hostPath: measured.hostPath,
          moduleUrl: measured.moduleUrl,
        }),
        version: pin.version,
      }
    })

    // `--threshold` stays a local `--check` experiment: it moves the two ratio
    // ceilings only. The absolute caps are the ratified D76 numbers, and `--ci`
    // rejects the flag outright.
    const limits = { ...GATE_LIMITS, ratio: options.threshold, p4Ratio: options.threshold }

    const pack = packTarball(CHECKOUT)
    const kernel = JSON.parse(readFileSync(join(CHECKOUT, 'lib', 'kernel-size.json'), 'utf8'))
    assert(typeof kernel.bytes === 'number', 'lib/kernel-size.json carries no kernel byte count')

    const report = {
      schema: REPORT_SCHEMA,
      generatedAt: new Date().toISOString(),
      node: process.version,
      head: { commit: headCommit },
      base: { ref: options.base, commit: baseCommit, sameAsHead: baseCommit === headCommit },
      repeat: options.repeat,
      coreSamplesPerSide: options.repeat * 2,
      bootPairs: options.repeat,
      bootProfilesPerPair: 2,
      gateLimits: limits,
      probes: {
        P1: coreRow('p1', 'ms'),
        P2: p2,
        P3: coreRow('p3', 'us'),
        P4: {
          ...coreRow('p4', 'ms'),
          comparable,
          plugins: { base: basePluginNames.length, head: headPluginNames.length },
          upstream: { base: baseCore.p4.upstream, head: headCore.p4.upstream },
          fixtures: { base: baseCore.p4.fixtures.length, head: headCore.p4.fixtures.length },
          emitted: { base: baseCore.p4.emitted, head: headCore.p4.emitted },
        },
      },
      p5: {
        informational: true,
        tarballBytes: pack.tarballBytes,
        unpackedBytes: pack.unpackedBytes,
        kernelBytes: kernel.bytes,
        bootPeakRssKiB: Math.max(...boot.pins.map((entry) => entry.maxRssKiB ?? 0)),
      },
      check: null,
      notes,
    }
    if (options.check) {
      report.check = {
        threshold: options.threshold,
        limits,
        rows: gateRows(report, limits),
        failures: gateFailures(report, limits),
      }
    }
    return report
  } finally {
    if (added) {
      try {
        git(CHECKOUT, ['worktree', 'remove', '--force', baseRoot])
      } catch {
        rmSync(baseRoot, { recursive: true, force: true })
      }
    }
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}

function packTarball(root) {
  const destination = mkdtempSync(join(tmpdir(), 'anyplugin-perf-pack-'))
  try {
    const npm = process.env.npm_execpath
    const command = npm === undefined ? 'npm' : process.execPath
    const prefix = npm === undefined ? [] : [npm]
    const result = spawnSync(
      command,
      [...prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: join(root, '.npm-cache') },
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    if (result.status !== 0) {
      throw new PerfError(`perf: npm pack failed:\n${String(result.stderr).trim()}`)
    }
    let parsed
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new PerfError('perf: npm pack did not print JSON')
    }
    const entry = Array.isArray(parsed) ? parsed[0] : parsed
    if (entry === undefined || typeof entry.size !== 'number' || typeof entry.unpackedSize !== 'number') {
      throw new PerfError('perf: npm pack printed no size/unpackedSize')
    }
    return { tarballBytes: entry.size, unpackedBytes: entry.unpackedSize }
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Probes (children). Both import the base and the head checkout (`--roots`):
// P1/P3/P4 alternate their samples in one child, P2 alternates its boots.
// ---------------------------------------------------------------------------

// The two roots are measured in the same child, sample by sample, and the
// order alternates: [base, head] then [head, base]. A ratio taken from two
// separate blocks reports the host's load trajectory as if it were a code
// change; a pair measured next to each other does not.
const sideOrder = (sample) => (sample % 2 === 0 ? ['base', 'head'] : ['head', 'base'])

async function importProduct(root) {
  const at = (relativePath) => moduleUrlFor(root, relativePath)
  const [modHost, intercept, dialect, emit, trust] = await Promise.all([
    import(at('packages/dsh-anyplugin-mod-host/src/index.ts')),
    import(at('packages/dsh-anyplugin-intercept/src/index.ts')),
    import(at('packages/dsh-anyplugin-dialect-claude-code/src/index.ts')),
    import(at('packages/dsh-anyplugin-emit/src/index.ts')),
    import(at('packages/dsh-anyplugin-trust/src/index.ts')),
  ])
  return {
    CONTINUE: intercept.CONTINUE,
    GRANTS_SCHEMA: trust.GRANTS_SCHEMA,
    classify: trust.classify,
    defaultMaterializers: emit.defaultMaterializers,
    emitPlugin: emit.emitPlugin,
    gate: trust.gate,
    loadMod: modHost.loadMod,
    pluginIdentity: trust.pluginIdentity,
    readClaudePlugin: dialect.readClaudePlugin,
    runChain: intercept.runChain,
  }
}

export async function probeCore(options) {
  const env = requirePerfEnv()
  const repeat = options.repeat
  assert(
    Array.isArray(options.roots) && options.roots.length === 2,
    'the core probe needs --roots with the base and head checkouts',
  )
  const roots = { base: options.roots[0], head: options.roots[1] }
  const api = {}
  for (const side of ['base', 'head']) api[side] = await importProduct(roots[side])

  const modsTree = env.modsTree
  const pinFile = JSON.parse(readFileSync(join(roots.head, 'fixtures', 'mods', 'upstream.json'), 'utf8'))
  const diffPin = pinFile.mods.find((mod) => mod.name === DIFF_MOD)
  assert(diffPin !== undefined, `fixtures/mods/upstream.json has no ${DIFF_MOD} mod`)
  const basePinFile = JSON.parse(readFileSync(join(roots.base, 'fixtures', 'mods', 'upstream.json'), 'utf8'))
  const baseDiffPin = basePinFile.mods.find((mod) => mod.name === DIFF_MOD)
  assert(
    baseDiffPin?.registrations?.length === diffPin.registrations.length,
    'base and head pin different upstream diff mods; the ratio would mix pins',
  )

  // P1: cold mod load. `loadMod` links and evaluates; `evaluate()` here is the
  // already-started evaluation, so the timed region is the whole cold load.
  const modRoot = join(modsTree, 'mods', DIFF_MOD, 'hooks')
  const pluginRoot = join(modsTree, 'mods', DIFF_MOD)
  const host = {
    dollar() {
      throw new PerfError(`perf: the pinned ${DIFF_MOD} mod dereferenced $ while registering`)
    },
  }
  const loadDiff = async (side) => {
    const started = performance.now()
    const mod = await api[side].loadMod({
      root: modRoot,
      entry: 'register.ts',
      pluginRoot,
      host,
    })
    await mod.evaluate()
    const elapsed = performance.now() - started
    const registrations = mod.registrations.length
    assert(
      registrations === diffPin.registrations.length,
      `the pinned ${DIFF_MOD} mod registered ${registrations} handlers, the pin records ${diffPin.registrations.length}`,
    )
    await mod.dispose?.()
    return elapsed
  }
  for (const side of ['base', 'head']) await loadDiff(side) // warmup, and the pin assertion
  const p1 = { base: [], head: [] }
  for (let sample = 0; sample < repeat * 2; sample += 1) {
    for (const side of sideOrder(sample)) p1[side].push(await loadDiff(side))
  }

  // P3: interception. Three handlers, one matcher hit, so every dispatch walks
  // the skipped-matcher path twice and the run path once. The chain is plain
  // data, so both sides dispatch the same registrations through their own code.
  const chain = [
    {
      event: 'PreToolUse',
      tier: 'prepend',
      matcher: 'Write|Edit',
      source: 'perf/first',
      run: () => {},
    },
    {
      event: 'PreToolUse',
      tier: 'user',
      matcher: 'Read|Bash',
      source: 'perf/matched',
      run: () => {},
    },
    {
      event: 'PreToolUse',
      tier: 'append',
      matcher: 'Write|Edit',
      source: 'perf/third',
      run: () => {},
    },
  ]
  const dispatch = (side) => api[side].runChain({ name: 'PreToolUse', data: { tool_name: 'Bash' } }, chain)
  const assertChain = async (side) => {
    const result = await dispatch(side)
    const statuses = result.trace.map((step) => step.status).join(',')
    assert(statuses === 'skipped-matcher,ran,skipped-matcher', `runChain traced ${statuses}, not the expected 3-step chain`)
    assert(result.decision === api[side].CONTINUE, 'runChain did not continue after the matching handler')
  }
  for (const side of ['base', 'head']) await assertChain(side) // warmup
  const p3 = { base: [], head: [] }
  for (let sample = 0; sample < repeat * 2; sample += 1) {
    for (const side of sideOrder(sample)) {
      const started = performance.now()
      for (let dispatchIndex = 0; dispatchIndex < DISPATCH_BATCH; dispatchIndex += 1) await dispatch(side)
      p3[side].push(((performance.now() - started) * 1000) / DISPATCH_BATCH) // microseconds per dispatch
    }
  }
  for (const side of ['base', 'head']) await assertChain(side)

  // P4: compile. The seven upstream mods come from the pin file, so a tree that
  // drifts is a named failure rather than a smaller compile. Every fixture with
  // a plugin manifest joins them; each side compiles its own tree with its own
  // code, and the two sets are asserted to be the same set.
  const upstreamRoot = join(modsTree, 'mods')
  const signature = (result) =>
    `${result.emitted.join(',')}|${result.considered.length}|${result.skipped.length}|${result.refused.length}`
  const prepareSide = (side) => {
    const upstream = pinFile.mods.map((mod) => {
      const root = join(upstreamRoot, mod.name)
      assert(
        existsSync(join(root, '.claude-plugin', 'plugin.json')),
        `the pinned upstream mod ${mod.name} has no .claude-plugin/plugin.json at ${root}`,
      )
      return { name: mod.name, root }
    })
    const fixturesRoot = join(roots[side], 'fixtures')
    const fixtures = readdirSync(fixturesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .filter((name) => existsSync(join(fixturesRoot, name, '.claude-plugin', 'plugin.json')))
      .map((name) => ({ name, root: join(fixturesRoot, name) }))
    assert(upstream.length === 7, `the pin file lists ${upstream.length} upstream mods, expected 7`)
    assert(fixtures.length > 0, 'no fixture carries .claude-plugin/plugin.json')

    const materializers = api[side].defaultMaterializers()
    const prepare = (plugin) => {
      const ir = api[side].readClaudePlugin(plugin.root)
      const rows = api[side].classify(ir)
      const grants = {
        schema: api[side].GRANTS_SCHEMA,
        revokes: [],
        grants: rows.map((row) => ({
          plugin: api[side].pluginIdentity(ir),
          capability: row.capability,
          target: row.target,
          artifactHash: row.artifactHash,
          grantedAt: '2026-01-01T00:00:00.000Z',
          scope: 'user',
        })),
      }
      return { ...plugin, grants, rows: rows.length }
    }
    const compile = (plugin) => {
      const ir = api[side].readClaudePlugin(plugin.root)
      const gated = api[side].gate(ir, plugin.grants)
      return api[side].emitPlugin(gated.ir, { materializers, trusted: gated.decision.allowed })
    }
    const plugins = [...upstream, ...fixtures].map(prepare)
    const baseline = new Map()
    const surfaces = new Set()
    let emitted = 0
    for (const plugin of plugins) {
      const result = compile(plugin)
      baseline.set(plugin.name, signature(result))
      emitted += result.emitted.length
      for (const surface of result.emitted) surfaces.add(surface)
    }
    // The fixtures include deliberately broken plugins whose artifacts the gate
    // refuses; the compile probe still measures them. The load-bearing
    // assertion is that the timed loop reaches both exec surfaces, hook and mod.
    assert(surfaces.has('hooks'), 'P4: no hook surface was emitted; the probe measures nothing to place')
    assert(surfaces.has('mods'), 'P4: no mod surface was emitted; the kernel path is not in the timed region')
    return {
      plugins,
      compile,
      baseline,
      emitted,
      upstream: upstream.map((plugin) => plugin.name),
      fixtures: fixtures.map((plugin) => plugin.name),
    }
  }
  const prepared = { base: prepareSide('base'), head: prepareSide('head') }
  const compileSample = (side) => {
    const preparedSide = prepared[side]
    const started = performance.now()
    let sampleEmitted = 0
    for (const plugin of preparedSide.plugins) {
      const result = preparedSide.compile(plugin)
      const actual = signature(result)
      assert(
        actual === preparedSide.baseline.get(plugin.name),
        `P4: ${plugin.name} compiled to ${actual} inside the sample, baseline was ${preparedSide.baseline.get(plugin.name)}`,
      )
      sampleEmitted += result.emitted.length
    }
    return { ms: performance.now() - started, emitted: sampleEmitted }
  }
  for (const side of ['base', 'head']) {
    const warm = compileSample(side)
    assert(
      warm.emitted === prepared[side].emitted,
      `P4: warmup on ${side} emitted ${warm.emitted} surfaces, baseline ${prepared[side].emitted}`,
    )
  }
  const p4 = { base: [], head: [] }
  for (let sample = 0; sample < repeat * 2; sample += 1) {
    for (const side of sideOrder(sample)) {
      const result = compileSample(side)
      assert(
        result.emitted === prepared[side].emitted,
        `P4: sample emitted ${result.emitted} surfaces, baseline ${prepared[side].emitted}`,
      )
      p4[side].push(result.ms)
    }
  }

  const sideResult = (side) => ({
    p1: { unit: 'ms', samples: p1[side] },
    p3: { unit: 'us', samples: p3[side] },
    p4: {
      unit: 'ms',
      samples: p4[side],
      upstream: prepared[side].upstream,
      fixtures: prepared[side].fixtures,
      emitted: prepared[side].emitted,
    },
  })
  return { base: sideResult('base'), head: sideResult('head') }
}

/**
 * Boot sampling is paired in time: one base boot and one head boot per pair,
 * adjacent and in alternating order, after one discarded warm-up pair. Two
 * separated blocks would report the host's load trajectory as a code change,
 * and a merged median cannot cancel that (the first block also pays the cold
 * first-load penalty). `run` returns the pair's elapsed time; `pairBootLog`
 * refuses a log that is not pairwise.
 */
export async function sampleBootPairs({ repeat, run }) {
  await run({ side: 'base', pair: -1, warmup: true })
  await run({ side: 'head', pair: -1, warmup: true })
  const log = []
  for (let pair = 0; pair < repeat; pair += 1) {
    const order = sideOrder(pair)
    for (const side of order) {
      const elapsed = await run({ side, pair, warmup: false })
      log.push({ pair, side, elapsed })
    }
  }
  return log
}

/**
 * The two-profile schedule: each pair measures an empty boot and a one-plugin
 * boot, base and head adjacent for each profile. Every profile is first on
 * alternating pairs, and the two profiles are ordered by the same alternation,
 * so the empty/one-plugin medians are not two blocks measured at different
 * points in the run. Returns one pairwise log per profile; `pairBootLog`
 * validates each independently.
 */
export async function sampleBootProfiles({ repeat, profiles, run }) {
  for (const profile of profiles) {
    await run({ profile, side: 'base', pair: -1, warmup: true })
    await run({ profile, side: 'head', pair: -1, warmup: true })
  }
  const logs = Object.fromEntries(profiles.map((profile) => [profile, []]))
  for (let pair = 0; pair < repeat; pair += 1) {
    const sides = sideOrder(pair)
    const order = pair % 2 === 0 ? profiles : [...profiles].reverse()
    for (const profile of order) {
      for (const side of sides) {
        const elapsed = await run({ profile, side, pair, warmup: false })
        logs[profile].push({ profile, pair, side, elapsed })
      }
    }
  }
  return logs
}

/** Validate a paired boot log and return per-side samples and per-pair ratios. */
export function pairBootLog(log) {
  if (!Array.isArray(log) || log.length === 0 || log.length % 2 !== 0) {
    throw new PerfError('perf: a paired boot log needs an even, non-zero number of samples')
  }
  const base = []
  const head = []
  const ratios = []
  for (let index = 0; index < log.length; index += 2) {
    const first = log[index]
    const second = log[index + 1]
    if (first.pair !== second.pair) {
      throw new PerfError('perf: a boot pair was split across repeats; the two sides are not adjacent')
    }
    const sides = new Set([first.side, second.side])
    if (sides.size !== 2 || !sides.has('base') || !sides.has('head')) {
      throw new PerfError(`perf: boot pair ${first.pair} is not one base and one head sample`)
    }
    const baseSide = first.side === 'base' ? first : second
    const headSide = first.side === 'head' ? first : second
    base.push(baseSide.elapsed)
    head.push(headSide.elapsed)
    ratios.push(headOverBase(baseSide.elapsed, headSide.elapsed))
  }
  return { base, head, ratios }
}

export async function probeBoot(options) {
  requirePerfEnv()
  assert(
    Array.isArray(options.roots) && options.roots.length === 2,
    'the boot probe needs --roots with the base and head checkouts',
  )
  const roots = { base: options.roots[0], head: options.roots[1] }
  const repeat = options.repeat
  const pins = options.pins
  assert(Array.isArray(pins) && pins.length > 0, 'the boot probe needs at least one --pins entry')

  // The host and the profile loader are scaffolding, not the measured artifact:
  // each side's package is selected by the profile symlink below and asserted
  // by `assertBoot`, while `installPlugin` writes the same lock for both sides.
  const at = (relativePath) => moduleUrlFor(roots.head, relativePath)
  const { resolveHarness } = await import(at('packages/dsh-anyplugin-conformance/src/harness.ts'))
  const { installPlugin } = await import(at('packages/dsh-anyplugin-conformance/src/install-cli.ts'))
  const { mountProfile } = await import(at('scripts/profile-boot.mjs'))
  const { registerHooks } = await import('node:module')

  const fixture = join(roots.head, 'fixtures', 'claude-skills-only')
  const scratch = mkdtempSync(join(tmpdir(), 'anyplugin-perf-boot-'))
  const previousHome = process.env.DSH_HOME
  const measured = []

  const bootShape = (mounted, side) => {
    assert(mounted.ctx.fiber.state === 2, 'the booted harness settled in a non-active state')
    const entries = [...mounted.ctx.loader.entries()]
    const controller = entries.find((entry) => entry.options?.id === 'dsh-anyplugin')
    assert(controller !== undefined, 'the controller entry is not in the loader tree')
    assert(controller.fiber?.state === 2, 'the controller entry is not active')
    const groups = entries.filter(
      (entry) =>
        entry.parent === mounted.ctx.loader.root &&
        typeof entry.options?.id === 'string' &&
        entry.options.id.startsWith('anyplugin.'),
    )
    const expectedModule = pathToFileURL(join(roots[side], 'lib', 'index.js')).href
    assert(
      mounted.moduleUrls.includes(expectedModule),
      `the boot loaded ${mounted.moduleUrls.join(', ')}, not the ${side} checkout's ${expectedModule}`,
    )
    return {
      entries,
      groups,
      hostPath: mounted.hostPath,
      moduleUrl: mounted.moduleUrls.find((url) => url === expectedModule),
    }
  }

  const assertEmptyBoot = async (mounted, installsFile, side) => {
    const { groups, ...shape } = bootShape(mounted, side)
    assert(groups.length === 0, `an empty profile must mount no plugin group, found ${groups.length}`)
    const noLock = mounted.logs.some(
      (record) =>
        record.name === 'dsh-anyplugin' &&
        record.args.join(' ').includes('nothing to reconcile') &&
        record.args.join(' ').includes(`no lock at ${installsFile}`),
    )
    assert(noLock, `the controller never took the empty-lock path for ${installsFile}`)
    const names = (await mounted.ctx.skills.list()).map((skill) => skill.name).sort()
    assert(names.length === 0, `an empty profile loaded skills ${names.join(',')}`)
    return shape
  }

  const assertOnePluginBoot = async (mounted, installsFile, side) => {
    const { groups, ...shape } = bootShape(mounted, side)
    assert(groups.length === 1, `exactly one plugin group must be mounted, found ${groups.length}`)
    assert(groups[0].fiber?.state === 2, 'the reconciled plugin group is not active')
    const reconciled = mounted.logs.some(
      (record) =>
        record.name === 'dsh-anyplugin' &&
        record.args.join(' ').includes('reconciled') &&
        record.args.join(' ').includes(`from ${installsFile}`),
    )
    assert(reconciled, `the controller never reconciled from ${installsFile}`)
    const names = (await mounted.ctx.skills.list()).map((skill) => skill.name).sort()
    assert(names.join(',') === 'greet,hello', `the reconciled skills are ${names.join(',')}, expected greet,hello`)
    return shape
  }

  try {
    for (const pin of pins) {
      const located = resolveHarness({
        env: { ...process.env, DSH_HARNESS_DIR: pin.installRoot, DSH_HARNESS_VERSION: pin.version },
        repoRoot: roots.head,
      })
      assert(located !== undefined, `P2: DSH ${pin.version} did not resolve from ${pin.installRoot}`)
      const appBoot = await import(pathToFileURL(join(located.harnessDir, 'dsh-app-boot', 'lib', 'index.js')).href)
      const { default: SkillRegistry } = await import(
        pathToFileURL(join(located.harnessDir, 'dsh-skill', 'lib', 'index.js')).href
      )
      const installAnchor = join(located.installRoot, 'package.json')
      const homeOne = join(scratch, pin.version, 'one')
      const homeEmpty = join(scratch, pin.version, 'empty')
      mkdirSync(homeOne, { recursive: true })
      mkdirSync(homeEmpty, { recursive: true })
      process.env.DSH_HOME = homeOne
      installPlugin({ pluginDir: fixture, home: homeOne, projectDir: roots.head })
      const installsFile = join(homeOne, 'anyplugin', 'installs.yml')
      const emptyInstallsFile = join(homeEmpty, 'anyplugin', 'installs.yml')

      const bootOnce = async (kind, side, profileName) => {
        const home = kind === 'empty' ? homeEmpty : homeOne
        // The controller resolves a relative default from DSH_HOME dynamically;
        // the explicit home below is what `mountProfile` hands the loader.
        process.env.DSH_HOME = home
        const profileDir = join(home, 'profiles', profileName)
        appBoot.initProfile(profileDir, ['dsh-anyplugin'])
        mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
        symlinkSync(roots[side], join(profileDir, 'node_modules', 'dsh-anyplugin'), 'dir')
        // Profile assembly is not the measurement: boot is. The profile is
        // prepared and loaded before the clock starts.
        const profile = appBoot.loadProfile('dsh', profileName, installAnchor, home)
        const started = performance.now()
        const mounted = await mountProfile({
          appBoot,
          registerHooks,
          SkillRegistry,
          harnessDir: located.harnessDir,
          installAnchor,
          profile,
          home,
          cwd: roots[side],
        })
        const elapsed = performance.now() - started
        try {
          const observed =
            kind === 'empty'
              ? await assertEmptyBoot(mounted, emptyInstallsFile, side)
              : await assertOnePluginBoot(mounted, installsFile, side)
          return { elapsed, ...observed }
        } finally {
          await mounted.ctx.fiber.dispose()
        }
      }

      const observed = { empty: { base: null, head: null }, one: { base: null, head: null } }
      const logs = await sampleBootProfiles({
        repeat,
        profiles: ['empty', 'one'],
        run: async ({ profile, side, pair, warmup }) => {
          const profileName = `perf-${profile}-${side}-${warmup ? 'warmup' : pair}`
          const run = await bootOnce(profile, side, profileName)
          observed[profile][side] = run
          return run.elapsed
        },
      })
      const emptyPaired = pairBootLog(logs.empty)
      const onePaired = pairBootLog(logs.one)
      measured.push({
        version: pin.version,
        hostPath: { base: observed.one.base.hostPath, head: observed.one.head.hostPath },
        moduleUrl: { base: observed.one.base.moduleUrl, head: observed.one.head.moduleUrl },
        samples: { base: onePaired.base, head: onePaired.head },
        ratios: onePaired.ratios,
        empty: {
          hostPath: { base: observed.empty.base.hostPath, head: observed.empty.head.hostPath },
          moduleUrl: { base: observed.empty.base.moduleUrl, head: observed.empty.head.moduleUrl },
          samples: { base: emptyPaired.base, head: emptyPaired.head },
          ratios: emptyPaired.ratios,
        },
        maxRssKiB: process.resourceUsage().maxRSS,
      })
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(scratch, { recursive: true, force: true })
  }

  return {
    pins: measured,
    maxRssKiB: Math.max(...measured.map((pin) => pin.maxRssKiB)),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)
  } catch {
    return false
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  if (options.probe === 'core') {
    const payload = await probeCore(options)
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }
  if (options.probe === 'boot') {
    const payload = await probeBoot(options)
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }

  const report = await runSuite(options)

  // The artifact is written before the verdict is delivered: a red workflow
  // still uploads the same perf.json a green one does. `--ci` defaults the
  // path to CI_ARTIFACT; `--json-out` works with or without a gate mode.
  if (options.jsonOut !== null) {
    const artifact = resolve(options.jsonOut)
    writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`)
    if (!options.quiet) process.stderr.write(`perf: wrote ${artifact}\n`)
  }

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(`${formatTable(report)}\n`)
    if (report.check !== null) process.stdout.write(`\n${formatGateTable(report)}\n`)
  }

  if (!options.quiet) {
    for (const note of report.notes) process.stderr.write(`perf: note: ${note}\n`)
  }
  if (report.check !== null) {
    if (report.check.failures.length === 0) {
      if (!options.quiet) {
        process.stderr.write(`perf: all gates pass (repeat ${report.repeat})\n`)
      }
    } else {
      // A red perf is a regression claim: probe, observed value, limit and
      // repeat count, one line each so a CI failure names what regressed.
      for (const failure of report.check.failures) {
        process.stderr.write(`perf: gate failed: ${failure}\n`)
      }
      process.exitCode = 1
    }
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof PerfError ? error.message : String(error.stack ?? error)}\n`)
    process.exitCode = error?.exitCode ?? 1
  })
}
