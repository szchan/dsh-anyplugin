/**
 * Unit tests for the parts of `perf.mjs` that own a contract rather than a
 * timing: the median, the ratio direction, the CLI, the environment check and
 * the table's honesty about a pin it could not measure. The probes themselves
 * are integration work and are exercised by `npm run perf`, not here.
 *
 * These tests are deliberately env-free: every helper takes its input, so a
 * missing DSH_HARNESS_DIR cannot make the suite skip a real assertion.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_BASE,
  DEFAULT_REPEAT,
  DEFAULT_THRESHOLD,
  ENV_VARS,
  PerfError,
  REPORT_SCHEMA,
  checkFailures,
  coreReportRow,
  exceedsThreshold,
  formatTable,
  headOverBase,
  median,
  pairBootLog,
  pairRatios,
  parseArgs,
  perfEnvProblems,
  pinReportRow,
  sampleBootPairs,
  requirePerfEnv,
} from './perf.mjs'

test('ENV_VARS is the suite’s five, and only those', () => {
  assert.deepEqual([...ENV_VARS], [
    'DSH_HARNESS_DIR',
    'DSH_HARNESS_VERSION',
    'CLAUDE_BIN',
    'ANYPLUGIN_MODS_TREE',
    'ANYPLUGIN_MOD_TREE',
  ])
})

test('the report schema names itself', () => {
  assert.equal(REPORT_SCHEMA, 'dsh-anyplugin/perf@1')
})

test('median is order-independent and averages the middle pair', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([7]), 7)
  const input = [5, 1, 9]
  median(input)
  assert.deepEqual(input, [5, 1, 9], 'median must not sort its caller’s array')
})

test('median refuses an empty sample set instead of reporting zero', () => {
  assert.throws(() => median([]), PerfError)
  assert.throws(() => median(undefined), PerfError)
})

test('a ratio is head over base, so below one is faster', () => {
  assert.equal(headOverBase(200, 100), 0.5)
  assert.equal(headOverBase(100, 150), 1.5)
  assert.equal(headOverBase(100, 0), 0)
})

test('a ratio needs a positive base and a finite head', () => {
  assert.throws(() => headOverBase(0, 10), PerfError)
  assert.throws(() => headOverBase(-1, 10), PerfError)
  assert.throws(() => headOverBase(Number.NaN, 10), PerfError)
  assert.throws(() => headOverBase(10, Number.POSITIVE_INFINITY), PerfError)
})

test('the threshold is a ceiling: equality is inside it', () => {
  assert.equal(exceedsThreshold(1.5, 1.5), false)
  assert.equal(exceedsThreshold(1.5001, 1.5), true)
  assert.equal(exceedsThreshold(0.99, 1.5), false)
})

test('parseArgs defaults match the documented contract', () => {
  const options = parseArgs([])
  assert.equal(options.base, DEFAULT_BASE)
  assert.equal(options.repeat, DEFAULT_REPEAT)
  assert.equal(options.threshold, DEFAULT_THRESHOLD)
  assert.equal(options.json, false)
  assert.equal(options.quiet, false)
  assert.equal(options.check, false)
  assert.equal(options.help, false)
  assert.equal(options.probe, null)
})

test('parseArgs reads values, --flag=value, and makes --quiet imply JSON', () => {
  const options = parseArgs([
    '--base',
    'HEAD~1',
    '--repeat=3',
    '--threshold',
    '2',
    '--check',
    '--quiet',
  ])
  assert.equal(options.base, 'HEAD~1')
  assert.equal(options.repeat, 3)
  assert.equal(options.threshold, 2)
  assert.equal(options.thresholdSet, true)
  assert.equal(options.check, true)
  assert.equal(options.json, true)
})

test('parseArgs supports -h and --help without a value', () => {
  assert.equal(parseArgs(['-h']).help, true)
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs(['--json=1']), PerfError)
})

test('--threshold without --check is an error, not an ignored flag', () => {
  assert.throws(() => parseArgs(['--threshold', '2']), PerfError)
})

test('parseArgs rejects out-of-range and malformed values', () => {
  assert.throws(() => parseArgs(['--repeat', '0']), PerfError)
  assert.throws(() => parseArgs(['--repeat', '101']), PerfError)
  assert.throws(() => parseArgs(['--repeat', '2.5']), PerfError)
  assert.throws(() => parseArgs(['--threshold', '0']), PerfError)
  assert.throws(() => parseArgs(['--threshold', 'NaN']), PerfError)
  assert.throws(() => parseArgs(['--base', '']), PerfError)
  assert.throws(() => parseArgs(['stray']), PerfError)
  assert.throws(() => parseArgs(['--nope']), PerfError)
})

test('parseArgs accepts the internal probe flags, and only their values', () => {
  const options = parseArgs(['--probe', 'boot', '--root', '.', '--pins', '[{"version":"1"}]'])
  assert.equal(options.probe, 'boot')
  assert.equal(options.pins.length, 1)
  const paired = parseArgs(['--probe', 'core', '--roots', '/tmp/base\n/tmp/head'])
  assert.deepEqual(paired.roots, ['/tmp/base', '/tmp/head'])
  assert.throws(() => parseArgs(['--roots', 'only-one']), PerfError)
  assert.throws(() => parseArgs(['--probe', 'other']), PerfError)
  assert.throws(() => parseArgs(['--pins', '{}']), PerfError)
  assert.throws(() => parseArgs(['--pins', 'not json']), PerfError)
})

test('checkFailures gates P1, P3 and P4, and never P2 or P5', () => {
  const report = {
    probes: {
      P1: { ratio: 1.2 },
      P3: { ratio: 1.51 },
      P4: { ratio: 1.0, comparable: true },
      P2: [
        { pin: '0.2.2-rc.2', ratio: 1.02 },
        { pin: '0.2.2-rc.5', ratio: 1.6 },
      ],
    },
    p5: { tarballBytes: 1 },
  }
  assert.deepEqual(checkFailures(report, 1.5), ['P3 1.51x'])
  assert.deepEqual(checkFailures(report, 2), [])
})

test('checkFailures names an unmeasured probe and a P4 that mixed plugin sets', () => {
  const report = {
    probes: {
      P1: { ratio: null },
      P3: { ratio: 1 },
      P4: { ratio: 1.1, comparable: false },
      P2: [{ pin: '0.2.2-rc.2', ratio: null }],
    },
  }
  assert.deepEqual(checkFailures(report, 1.5), [
    'P1 not measured',
    'P4 not comparable (base and head compiled different plugin sets)',
  ])
})

test('perfEnvProblems names every missing variable at once', () => {
  const problems = perfEnvProblems({})
  for (const name of ENV_VARS) {
    assert.ok(problems.includes(`${name} is not set`), `the report must name ${name}`)
  }
  assert.equal(problems.length, ENV_VARS.length)
})

test('perfEnvProblems rejects a harness dir that is not a fetched install root', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'anyplugin-perf-test-'))
  try {
    const problems = perfEnvProblems({ DSH_HARNESS_DIR: join(scratch, 'not-a-harness') })
    assert.ok(problems.some((problem) => problem.includes('DSH_HARNESS_DIR')))
    assert.ok(problems.some((problem) => problem.includes('not a directory')))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('perfEnvProblems accepts a complete environment and requirePerfEnv returns it', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'anyplugin-perf-test-'))
  try {
    const harnessDir = join(scratch, 'harness')
    mkdirSync(join(harnessDir, 'node_modules', '@deepseek-ai'), { recursive: true })
    const claudeBin = join(scratch, 'claude')
    writeFileSync(claudeBin, '#!/bin/sh\n')
    chmodSync(claudeBin, 0o755)
    const modsTree = join(scratch, 'mods')
    mkdirSync(join(modsTree, 'mods'), { recursive: true })
    const modTree = join(modsTree, 'mods', 'diff', 'hooks')
    mkdirSync(modTree, { recursive: true })
    writeFileSync(join(modTree, 'register.ts'), '')

    const env = {
      DSH_HARNESS_DIR: harnessDir,
      DSH_HARNESS_VERSION: '0.2.2-rc.5',
      CLAUDE_BIN: claudeBin,
      ANYPLUGIN_MODS_TREE: modsTree,
      ANYPLUGIN_MOD_TREE: modTree,
    }
    assert.deepEqual(perfEnvProblems(env), [])
    assert.deepEqual(requirePerfEnv(env), {
      harnessDir,
      harnessVersion: '0.2.2-rc.5',
      claudeBin,
      modsTree,
      modTree,
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('requirePerfEnv throws one PerfError that lists every problem', () => {
  assert.throws(
    () => requirePerfEnv({}),
    (error) => error instanceof PerfError && ENV_VARS.every((name) => error.message.includes(name)),
  )
})

test('formatTable shows base, head and ratio, and marks P5 informational', () => {
  const report = {
    base: { commit: 'a'.repeat(40), ref: 'origin/main' },
    head: { commit: 'b'.repeat(40) },
    node: 'v24.22.2',
    repeat: 5,
    probes: {
      P1: { unit: 'ms', base: { median: 200 }, head: { median: 220 }, ratio: 1.1 },
      P2: [
        { pin: '0.2.2-rc.2', unit: 'ms', base: { median: 30 }, head: { median: 33 }, ratio: 1.1 },
        { pin: '0.2.2-rc.5', unit: 'ms', base: null, head: null, ratio: null },
      ],
      P3: { unit: 'us', base: { median: 8 }, head: { median: 8.8 }, ratio: 1.1 },
      P4: {
        unit: 'ms',
        base: { median: 100 },
        head: { median: 101 },
        ratio: 1.01,
        comparable: true,
        plugins: { base: 21, head: 21 },
      },
    },
    p5: { tarballBytes: 186325, unpackedBytes: 749068, kernelBytes: 115532, bootPeakRssKiB: 131000 },
    check: null,
    notes: [],
  }
  const table = formatTable(report)
  assert.match(table, /ratio = median of per-pair head\/base/)
  assert.match(table, /gated by --check: P1, P3, P4 · informational: P2 \(boot timing\), P5/u)
  assert.match(table, /P1\s+cold mod load: diff \(loadMod \+ evaluate\)\s+200\.0 ms\s+220\.0 ms\s+1\.10x/u)
  assert.match(table, /P4\s+compile: 21 plugins \(read\+gate\+emit\)\s+100\.0 ms\s+101\.0 ms\s+1\.01x/u)
  assert.match(table, /P5  informational — never gated, head only/u)
  assert.match(table, /tarball\s+186,325 bytes/u)
  assert.match(table, /boot peak RSS\s+131,000 KiB/u)
  assert.match(table, /P2\s+boot \+ reconcile @ dsh 0\.2\.2-rc\.5\s+-\s+-\s+-/u)
  assert.doesNotMatch(table, /NaN|undefined/u)
})

test('formatTable prints a check verdict, including the failure list', () => {
  const report = {
    base: { commit: 'a'.repeat(40), ref: 'HEAD~1' },
    head: { commit: 'b'.repeat(40) },
    node: 'v24.22.2',
    repeat: 3,
    probes: {
      P1: { unit: 'ms', base: { median: 1 }, head: { median: 2 }, ratio: 2 },
      P2: [],
      P3: { unit: 'us', base: { median: 1 }, head: { median: 1 }, ratio: 1 },
      P4: {
        unit: 'ms',
        base: { median: 1 },
        head: { median: 1 },
        ratio: 1,
        comparable: true,
        plugins: { base: 21, head: 21 },
      },
    },
    p5: {},
    check: { threshold: 1.5, failures: ['P1 2.00x'] },
    notes: [],
  }
  assert.match(formatTable(report), /--check: 1 above 1\.5x — P1 2\.00x/u)
})


test('boot samples are paired in time: one base and one head per repeat, adjacent', async () => {
  const calls = []
  await sampleBootPairs({
    repeat: 3,
    run: async ({ side, pair, warmup }) => {
      calls.push(warmup ? `${side}:warmup` : `${side}:${pair}`)
      return 10
    },
  })
  assert.deepEqual(calls, [
    'base:warmup',
    'head:warmup',
    'base:0',
    'head:0',
    'head:1',
    'base:1',
    'base:2',
    'head:2',
  ])
  for (let index = 2; index < calls.length; index += 2) {
    const [, firstPair] = calls[index].split(':')
    const [, secondPair] = calls[index + 1].split(':')
    assert.equal(firstPair, secondPair)
    assert.deepEqual(new Set([calls[index].split(':')[0], calls[index + 1].split(':')[0]]), new Set(['base', 'head']))
  }
})

test('pairBootLog refuses block-merged samples and takes the median of per-pair ratios', () => {
  const alternating = [
    { pair: 0, side: 'base', elapsed: 100 },
    { pair: 0, side: 'head', elapsed: 150 },
    { pair: 1, side: 'head', elapsed: 120 },
    { pair: 1, side: 'base', elapsed: 100 },
  ]
  const paired = pairBootLog(alternating)
  assert.deepEqual(paired.base, [100, 100])
  assert.deepEqual(paired.head, [150, 120])
  assert.deepEqual(paired.ratios, [1.5, 1.2])
  assert.equal(median(paired.ratios), 1.35)

  // The shape the reviewer caught: every base sample first, then every head.
  const blockMerged = [
    { pair: 0, side: 'base', elapsed: 100 },
    { pair: 1, side: 'base', elapsed: 100 },
    { pair: 0, side: 'head', elapsed: 150 },
    { pair: 1, side: 'head', elapsed: 120 },
  ]
  assert.throws(() => pairBootLog(blockMerged), PerfError)
  assert.throws(() => pairBootLog([{ pair: 0, side: 'base', elapsed: 100 }]), PerfError)
})


test('the reported ratio is the pair median, not the ratio of the two side medians', () => {
  // Pairs are (100, 250) and (300, 150): ratios [2.5, 0.5] -> median 1.5.
  // The side medians are both 200, so a row that regressed to
  // headOverBase(base.median, head.median) would print 1.0 instead.
  const baseSamples = [100, 300]
  const headSamples = [250, 150]
  assert.equal(median(pairRatios(baseSamples, headSamples)), 1.5)
  assert.equal(headOverBase(median(baseSamples), median(headSamples)), 1)

  const core = coreReportRow({ unit: 'ms', baseSamples, headSamples })
  assert.equal(core.ratio, 1.5)
  assert.equal(core.base.median, 200)
  assert.equal(core.head.median, 200)

  const pin = pinReportRow({
    pin: '0.2.2-rc.5',
    samples: { base: baseSamples, head: headSamples },
    hostPath: 'scope-link',
    moduleUrl: 'file:///tmp/base/lib/index.js',
  })
  assert.equal(pin.ratio, 1.5)
  assert.deepEqual(pin.pairs, [2.5, 0.5])
  assert.equal(pin.base.median, 200)
  assert.equal(pin.head.median, 200)
})

test('a P2 far outside the threshold stays outside --check, and the verdict says so', () => {
  const report = {
    base: { commit: 'a'.repeat(40), ref: 'HEAD~1' },
    head: { commit: 'b'.repeat(40) },
    node: 'v24.22.2',
    repeat: 5,
    probes: {
      P1: { unit: 'ms', base: { median: 100 }, head: { median: 101 }, ratio: 1.01 },
      P2: [{ pin: '0.2.2-rc.5', unit: 'ms', base: { median: 10 }, head: { median: 189 }, ratio: 18.9 }],
      P3: { unit: 'us', base: { median: 10 }, head: { median: 10 }, ratio: 1 },
      P4: { unit: 'ms', base: { median: 100 }, head: { median: 100 }, ratio: 1, comparable: true, plugins: { base: 21, head: 21 } },
    },
    p5: {},
    check: { threshold: 1.2, failures: [] },
    notes: [],
  }
  // No failure means the CLI exits 0; P2's 18.9x is printed but never read.
  assert.deepEqual(checkFailures(report, 1.2), [])
  const table = formatTable(report)
  assert.match(table, /18\.90x/u)
  assert.match(table, /--check: all gated ratios within 1\.2x — P2 is informational and was not checked/u)
})

test('pairRatios pairs sample i with sample i and refuses different counts', () => {
  assert.deepEqual(pairRatios([100, 50], [120, 40]), [1.2, 0.8])
  assert.throws(() => pairRatios([], []), PerfError)
  assert.throws(() => pairRatios([100], [120, 40]), PerfError)
  assert.throws(() => pairRatios([0], [120]), PerfError)
})
