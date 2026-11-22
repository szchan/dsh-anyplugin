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
  exceedsThreshold,
  formatTable,
  headOverBase,
  median,
  parseArgs,
  perfEnvProblems,
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

test('checkFailures gates P1, P3 and P4 plus every P2 pin, and never P5', () => {
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
  assert.deepEqual(checkFailures(report, 1.5), ['P3 1.51x', 'P2 @ 0.2.2-rc.5 1.60x'])
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
    'P2 @ 0.2.2-rc.2 not measured',
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
  assert.match(table, /ratio = head\/base/)
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
