#!/usr/bin/env node
/**
 * perf — measure our own hot paths, as ratios against a base revision.
 *
 * `npm run verify` answers "is the behavior right". This script answers a
 * different question: "did the hot path get slower than the base commit". It
 * never prints a standalone millisecond count as a claim — a number on one
 * machine at one moment is not comparable to anything. Every probe prints a
 * base/head pair and the ratio between them, and a regression is a ratio, not
 * a millisecond count. P5 (bytes and RSS) is informational by construction.
 *
 * The four ratio probes, cheapest-first:
 *
 *   P1  cold mod load      loadMod + evaluate of the pinned upstream `diff`
 *                          mod, the kernel's slowest single unit.
 *   P2  boot + reconcile   the host's own profile loader boots a profile with
 *                          one installed plugin and the controller reconciles
 *                          it, once per declared DSH pin.
 *   P3  interception       runChain over three handlers with one matcher hit;
 *                          microseconds per dispatch.
 *   P4  compile            readClaudePlugin + gate + emit over the seven
 *                          pinned upstream mods and every fixture plugin.
 *
 * P5 reports the tarball's bytes, its unpacked bytes, the mods kernel's bytes
 * and the boot's peak RSS. It is stamped `informational` in both output modes
 * and `--check` never looks at it.
 *
 * How the base is measured: a detached worktree at the base commit, built
 * there, probed in its own child processes with `--root <worktree>`. The base
 * and the head therefore never share a module graph or a V8 heap. Third-party
 * dependencies are shared only when `package-lock.json` is byte-identical;
 * otherwise the base gets its own offline `npm install`. Everything the runner
 * does for itself (worktree, build, pack) happens outside every stopwatch.
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
export const DEFAULT_THRESHOLD = 1.5
export const REPORT_SCHEMA = 'dsh-anyplugin/perf@1'

/** One warmup, then this many timed samples per probe, per side. */
const MAX_REPEAT = 100
/** P3's batch: enough dispatches that a sample is milliseconds, not timer noise. */
const DISPATCH_BATCH = 2000
/** The diff mod's registration count, from fixtures/mods/upstream.json. */
const DIFF_MOD = 'diff'

export const USAGE = `perf — measure dsh-anyplugin's own hot paths, as ratios against a base ref.

Usage:
  npm run perf [-- --base <git-ref>] [--repeat <n>] [--json | --quiet]
               [--check [--threshold <x>]]

Probes (each prints base, head and ratio; a regression is a ratio):
  P1  cold mod load      loadMod + evaluate of the pinned upstream diff mod
  P2  boot + reconcile   the host's profile loader boots one installed plugin,
                         once per DSH pin declared in engines.dsh
  P3  interception       runChain over three handlers, one matcher hit (us)
  P4  compile            readClaudePlugin + gate + emit over the seven upstream
                         mods and every fixture that carries a plugin manifest
  P5  informational      tarball bytes, unpacked bytes, mods kernel bytes and
                         the boot's peak RSS; never gated

Options:
  --base <ref>       base revision measured in a separate worktree
                     (default: ${DEFAULT_BASE}; the ref must exist locally)
  --repeat <n>       timed samples per side after one warmup, 1..${MAX_REPEAT}
                     (default: ${DEFAULT_REPEAT})
  --json             print the JSON report instead of the table
  --quiet            print only the JSON report; suppress notes (failures print)
  --check            exit 1 when any ratio exceeds --threshold; never applied
                     to P5, and not wired into verify
  --threshold <x>    ratio ceiling for --check (default: ${DEFAULT_THRESHOLD});
                     requires --check
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
 * Strictly greater: a ratio exactly at the threshold is inside it. The
 * threshold is a ceiling for a *regression*, and equality is not a regression.
 */
export function exceedsThreshold(ratio, threshold) {
  return ratio > threshold
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

/** Ratio failures for `--check`. P5 is never in this list; neither is a note. */
export function checkFailures(report, threshold) {
  const failures = []
  for (const id of ['P1', 'P3', 'P4']) {
    const probe = report.probes?.[id]
    if (probe === undefined) continue
    if (id === 'P4' && probe.comparable === false) {
      failures.push('P4 not comparable (base and head compiled different plugin sets)')
      continue
    }
    if (probe.ratio === null || !Number.isFinite(probe.ratio)) {
      failures.push(`${id} not measured`)
      continue
    }
    if (exceedsThreshold(probe.ratio, threshold)) failures.push(`${id} ${probe.ratio.toFixed(2)}x`)
  }
  for (const row of report.probes?.P2 ?? []) {
    if (row.ratio === null || !Number.isFinite(row.ratio)) {
      failures.push(`P2 @ ${row.pin} not measured`)
      continue
    }
    if (exceedsThreshold(row.ratio, threshold)) failures.push(`P2 @ ${row.pin} ${row.ratio.toFixed(2)}x`)
  }
  return failures
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
    help: false,
    base: DEFAULT_BASE,
    repeat: DEFAULT_REPEAT,
    threshold: DEFAULT_THRESHOLD,
    thresholdSet: false,
    probe: null,
    root: CHECKOUT,
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
  if (options.quiet) options.json = true
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
    `node ${report.node} · ${report.repeat} samples after 1 warmup · ratio = head/base (<1.00 is faster)`,
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
    if (row.base === null || row.head === null) {
      rows.push(['P2', `boot + reconcile @ dsh ${row.pin}`, '-', '-', '-'])
      continue
    }
    const comparable = {
      unit: 'ms',
      base: { median: row.base.median },
      head: { median: row.head.median },
      ratio: row.ratio,
    }
    pair('P2', `boot + reconcile @ dsh ${row.pin}`, { ...comparable, unit: 'ms' })
  }
  pair('P3', `interception: runChain, 3 handlers, 1 match`, report.probes.P3)
  const p4 = report.probes.P4
  pair('P4', `compile: ${p4.plugins.head} plugins (read+gate+emit)`, p4)
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

  lines.push('')
  lines.push('P5  informational — never gated, head only')
  const p5 = report.p5
  const byte = (value) => (typeof value === 'number' ? `${groupDigits(value)} bytes` : '-')
  lines.push(`    tarball        ${byte(p5.tarballBytes)}`)
  lines.push(`    unpacked       ${byte(p5.unpackedBytes)}`)
  lines.push(`    mods kernel    ${byte(p5.kernelBytes)}`)
  lines.push(
    `    boot peak RSS  ${typeof p5.bootPeakRssKiB === 'number' ? `${groupDigits(p5.bootPeakRssKiB)} KiB` : '-'}`,
  )
  if (report.check !== null) {
    lines.push('')
    lines.push(
      report.check.failures.length === 0
        ? `--check: all ratios within ${report.check.threshold}x`
        : `--check: ${report.check.failures.length} above ${report.check.threshold}x — ${report.check.failures.join(', ')}`,
    )
  }
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
    '--root',
    root,
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

    const headCore = runProbe('core', CHECKOUT, options)
    const baseCore = runProbe('core', baseRoot, options)
    const bootPins = pins.filter((pin) => pin.available).map(({ version, installRoot }) => ({ version, installRoot }))
    const headBoot = runProbe('boot', CHECKOUT, options, ['--pins', JSON.stringify(bootPins)])
    const baseBoot = runProbe('boot', baseRoot, options, ['--pins', JSON.stringify(bootPins)])

    const coreRow = (id, unit) => {
      const base = summarize(baseCore[id].samples, unit)
      const head = summarize(headCore[id].samples, unit)
      return { unit, base, head, ratio: headOverBase(base.median, head.median) }
    }

    const headPluginNames = [...headCore.p4.upstream, ...headCore.p4.fixtures].sort()
    const basePluginNames = [...baseCore.p4.upstream, ...baseCore.p4.fixtures].sort()
    const comparable = JSON.stringify(headPluginNames) === JSON.stringify(basePluginNames)
    if (!comparable) {
      notes.push('P4: base and head compiled different plugin sets; the ratio would mix sets and is reported as n/c')
    }

    const p2 = pins.map((pin) => {
      const base = baseBoot.pins.find((entry) => entry.version === pin.version)
      const head = headBoot.pins.find((entry) => entry.version === pin.version)
      if (!pin.available) {
        return { pin: pin.version, unit: 'ms', base: null, head: null, ratio: null, reason: 'pin not fetched' }
      }
      assert(base !== undefined && head !== undefined, `P2 measured no boot for dsh ${pin.version}`)
      const baseSummary = summarize(base.samples, 'ms')
      const headSummary = summarize(head.samples, 'ms')
      return {
        pin: pin.version,
        unit: 'ms',
        base: baseSummary,
        head: headSummary,
        ratio: headOverBase(baseSummary.median, headSummary.median),
        hostPath: { base: base.hostPath, head: head.hostPath },
        pinnedFiles: {
          base: base.moduleUrl,
          head: head.moduleUrl,
        },
      }
    })

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
        bootPeakRssKiB: Math.max(...headBoot.pins.map((entry) => entry.maxRssKiB ?? 0)),
      },
      check: null,
      notes,
    }
    if (options.check) {
      report.check = { threshold: options.threshold, failures: checkFailures(report, options.threshold) }
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
// Probes (children). Each imports from `--root`, so the head script can measure
// the base worktree without a second copy of itself.
// ---------------------------------------------------------------------------

export async function probeCore(options) {
  const env = requirePerfEnv()
  const root = options.root
  const repeat = options.repeat
  const at = (relativePath) => moduleUrlFor(root, relativePath)

  const { loadMod } = await import(at('packages/dsh-anyplugin-mod-host/src/index.ts'))
  const { CONTINUE, runChain } = await import(at('packages/dsh-anyplugin-intercept/src/index.ts'))
  const { readClaudePlugin } = await import(at('packages/dsh-anyplugin-dialect-claude-code/src/index.ts'))
  const { defaultMaterializers, emitPlugin } = await import(at('packages/dsh-anyplugin-emit/src/index.ts'))
  const { GRANTS_SCHEMA, classify, gate, pluginIdentity } = await import(at('packages/dsh-anyplugin-trust/src/index.ts'))

  const modsTree = env.modsTree
  const pinFile = JSON.parse(readFileSync(join(root, 'fixtures', 'mods', 'upstream.json'), 'utf8'))
  const diffPin = pinFile.mods.find((mod) => mod.name === DIFF_MOD)
  assert(diffPin !== undefined, `fixtures/mods/upstream.json has no ${DIFF_MOD} mod`)

  // P1: cold mod load. `loadMod` links and evaluates; `evaluate()` here is the
  // already-started evaluation, so the timed region is the whole cold load.
  const modRoot = join(modsTree, 'mods', DIFF_MOD, 'hooks')
  const pluginRoot = join(modsTree, 'mods', DIFF_MOD)
  const host = {
    dollar() {
      throw new PerfError(`perf: the pinned ${DIFF_MOD} mod dereferenced $ while registering`)
    },
  }
  const loadDiff = async () => {
    const started = performance.now()
    const mod = await loadMod({
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
  await loadDiff() // warmup, also the assertion that the mod still registers
  const p1 = []
  for (let sample = 0; sample < repeat; sample += 1) p1.push(await loadDiff())

  // P3: interception. Three handlers, one matcher hit, so every dispatch walks
  // the skipped-matcher path twice and the run path once.
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
  const dispatch = () => runChain({ name: 'PreToolUse', data: { tool_name: 'Bash' } }, chain)
  const assertChain = async () => {
    const result = await dispatch()
    const statuses = result.trace.map((step) => step.status).join(',')
    assert(statuses === 'skipped-matcher,ran,skipped-matcher', `runChain traced ${statuses}, not the expected 3-step chain`)
    assert(result.decision === CONTINUE, 'runChain did not continue after the matching handler')
  }
  await assertChain() // warmup
  const p3 = []
  for (let sample = 0; sample < repeat; sample += 1) {
    const started = performance.now()
    for (let dispatchIndex = 0; dispatchIndex < DISPATCH_BATCH; dispatchIndex += 1) await dispatch()
    const elapsed = performance.now() - started
    p3.push((elapsed * 1000) / DISPATCH_BATCH) // microseconds per dispatch
  }
  await assertChain()

  // P4: compile. The seven upstream mods come from the pin file, so a tree that
  // drifts is a named failure rather than a smaller compile. Every fixture with
  // a plugin manifest joins them; both sets are compiled by the same code.
  const upstreamRoot = join(modsTree, 'mods')
  const upstream = pinFile.mods.map((mod) => {
    const pluginRoot = join(upstreamRoot, mod.name)
    assert(
      existsSync(join(pluginRoot, '.claude-plugin', 'plugin.json')),
      `the pinned upstream mod ${mod.name} has no .claude-plugin/plugin.json at ${pluginRoot}`,
    )
    return { name: mod.name, root: pluginRoot }
  })
  const fixturesRoot = join(root, 'fixtures')
  const fixtures = readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => existsSync(join(fixturesRoot, name, '.claude-plugin', 'plugin.json')))
    .map((name) => ({ name, root: join(fixturesRoot, name) }))
  assert(upstream.length === 7, `the pin file lists ${upstream.length} upstream mods, expected 7`)
  assert(fixtures.length > 0, 'no fixture carries .claude-plugin/plugin.json')

  const materializers = defaultMaterializers()
  const prepare = (plugin) => {
    const ir = readClaudePlugin(plugin.root)
    const rows = classify(ir)
    const grants = {
      schema: GRANTS_SCHEMA,
      revokes: [],
      grants: rows.map((row) => ({
        plugin: pluginIdentity(ir),
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
    const ir = readClaudePlugin(plugin.root)
    const gated = gate(ir, plugin.grants)
    return emitPlugin(gated.ir, { materializers, trusted: gated.decision.allowed })
  }
  const signature = (result) =>
    `${result.emitted.join(',')}|${result.considered.length}|${result.skipped.length}|${result.refused.length}`

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
  // refuses; the compile probe still measures them. The load-bearing assertion
  // is that the timed loop reaches both exec surfaces, hook and mod.
  assert(surfaces.has('hooks'), 'P4: no hook surface was emitted; the probe measures nothing to place')
  assert(surfaces.has('mods'), 'P4: no mod surface was emitted; the kernel path is not in the timed region')

  const compileSample = () => {
    const started = performance.now()
    let sampleEmitted = 0
    for (const plugin of plugins) {
      const result = compile(plugin)
      const actual = signature(result)
      assert(
        actual === baseline.get(plugin.name),
        `P4: ${plugin.name} compiled to ${actual} inside the sample, baseline was ${baseline.get(plugin.name)}`,
      )
      sampleEmitted += result.emitted.length
    }
    return { ms: performance.now() - started, emitted: sampleEmitted }
  }
  const p4 = []
  const warm = compileSample()
  assert(warm.emitted === emitted, `P4: warmup emitted ${warm.emitted} surfaces, baseline ${emitted}`)
  for (let sample = 0; sample < repeat; sample += 1) {
    const result = compileSample()
    assert(result.emitted === emitted, `P4: sample emitted ${result.emitted} surfaces, baseline ${emitted}`)
    p4.push(result.ms)
  }

  return {
    p1: { unit: 'ms', samples: p1 },
    p3: { unit: 'us', samples: p3 },
    p4: {
      unit: 'ms',
      samples: p4,
      upstream: upstream.map((plugin) => plugin.name),
      fixtures: fixtures.map((plugin) => plugin.name),
      emitted,
    },
  }
}

export async function probeBoot(options) {
  requirePerfEnv()
  const root = options.root
  const repeat = options.repeat
  const pins = options.pins
  assert(Array.isArray(pins) && pins.length > 0, 'the boot probe needs at least one --pins entry')

  const at = (relativePath) => moduleUrlFor(root, relativePath)
  const { resolveHarness } = await import(at('packages/dsh-anyplugin-conformance/src/harness.ts'))
  const { installPlugin } = await import(at('packages/dsh-anyplugin-conformance/src/install-cli.ts'))
  const { mountProfile } = await import(at('scripts/profile-boot.mjs'))
  const { registerHooks } = await import('node:module')

  const fixture = join(root, 'fixtures', 'claude-skills-only')
  const scratch = mkdtempSync(join(tmpdir(), 'anyplugin-perf-boot-'))
  const previousHome = process.env.DSH_HOME
  const measured = []

  const assertBoot = async (mounted, installsFile) => {
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
    assert(groups.length === 1, `exactly one plugin group must be mounted, found ${groups.length}`)
    assert(groups[0].fiber?.state === 2, 'the reconciled plugin group is not active')
    const expectedModule = pathToFileURL(join(root, 'lib', 'index.js')).href
    assert(
      mounted.moduleUrls.includes(expectedModule),
      `the boot loaded ${mounted.moduleUrls.join(', ')}, not this side's ${expectedModule}`,
    )
    const reconciled = mounted.logs.some(
      (record) =>
        record.name === 'dsh-anyplugin' &&
        record.args.join(' ').includes('reconciled') &&
        record.args.join(' ').includes(`from ${installsFile}`),
    )
    assert(reconciled, `the controller never reconciled from ${installsFile}`)
    const names = (await mounted.ctx.skills.list()).map((skill) => skill.name).sort()
    assert(names.join(',') === 'greet,hello', `the reconciled skills are ${names.join(',')}, expected greet,hello`)
    return { hostPath: mounted.hostPath, moduleUrl: mounted.moduleUrls.find((url) => url === expectedModule) }
  }

  try {
    for (const pin of pins) {
      const located = resolveHarness({
        env: { ...process.env, DSH_HARNESS_DIR: pin.installRoot, DSH_HARNESS_VERSION: pin.version },
        repoRoot: root,
      })
      assert(located !== undefined, `P2: DSH ${pin.version} did not resolve from ${pin.installRoot}`)
      const appBoot = await import(pathToFileURL(join(located.harnessDir, 'dsh-app-boot', 'lib', 'index.js')).href)
      const { default: SkillRegistry } = await import(
        pathToFileURL(join(located.harnessDir, 'dsh-skill', 'lib', 'index.js')).href
      )
      const installAnchor = join(located.installRoot, 'package.json')
      const home = join(scratch, pin.version)
      mkdirSync(home, { recursive: true })
      process.env.DSH_HOME = home
      installPlugin({ pluginDir: fixture, home, projectDir: root })
      const installsFile = join(home, 'anyplugin', 'installs.yml')

      const bootOnce = async (profileName) => {
        const profileDir = join(home, 'profiles', profileName)
        appBoot.initProfile(profileDir, ['dsh-anyplugin'])
        mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
        symlinkSync(root, join(profileDir, 'node_modules', 'dsh-anyplugin'), 'dir')
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
          cwd: root,
        })
        const elapsed = performance.now() - started
        try {
          const observed = await assertBoot(mounted, installsFile)
          return { elapsed, ...observed }
        } finally {
          await mounted.ctx.fiber.dispose()
        }
      }

      await bootOnce('perf-warmup') // warmup: module compilation and JIT
      const samples = []
      let observed = null
      for (let sample = 0; sample < repeat; sample += 1) {
        const run = await bootOnce(`perf-sample-${sample}`)
        samples.push(run.elapsed)
        observed = run
      }
      measured.push({
        version: pin.version,
        hostPath: observed.hostPath,
        moduleUrl: observed.moduleUrl,
        samples,
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
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${formatTable(report)}\n`)

  if (!options.quiet) {
    for (const note of report.notes) process.stderr.write(`perf: note: ${note}\n`)
  }
  if (report.check !== null) {
    if (report.check.failures.length === 0) {
      if (!options.quiet) process.stderr.write(`perf --check: all ratios within ${report.check.threshold}x\n`)
    } else {
      for (const failure of report.check.failures) {
        process.stderr.write(`perf --check: ${failure} (threshold ${report.check.threshold}x)\n`)
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
