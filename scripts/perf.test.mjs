/**
 * Unit tests for the parts of `perf.mjs` that own a contract rather than a
 * timing: the median, the ratio direction, the CLI, the environment check, the
 * D76 gate rows and the table's honesty about a pin it could not measure. The
 * probes themselves are integration work and are exercised by `npm run perf`,
 * not here.
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
  ARTIFACT_RETENTION_DAYS,
  CI_ARTIFACT,
  DEFAULT_BASE,
  DEFAULT_REPEAT,
  DEFAULT_THRESHOLD,
  ENV_VARS,
  GATE_LIMITS,
  PerfError,
  REPORT_SCHEMA,
  coreReportRow,
  exceedsThreshold,
  formatGateTable,
  formatTable,
  gateFailures,
  gateRows,
  headOverBase,
  median,
  pairBootLog,
  pairRatios,
  parseArgs,
  perfEnvProblems,
  pinReportRow,
  requirePerfEnv,
  sampleBootPairs,
  sampleBootProfiles,
} from './perf.mjs'

/** A report row with only the fields the gate and table readers need. */
function row(base, head, extra = {}) {
  return {
    unit: 'ms',
    base: { median: base },
    head: { median: head },
    ratio: head / base,
    ...extra,
  }
}

/** A complete, all-green report. Tests mutate the probe they are about. */
function sampleReport(overrides = {}) {
  return {
    schema: REPORT_SCHEMA,
    base: { commit: 'a'.repeat(40), ref: 'origin/main' },
    head: { commit: 'b'.repeat(40) },
    node: 'v24.22.2',
    repeat: 5,
    gateLimits: GATE_LIMITS,
    probes: {
      P1: row(200, 220),
      P2: [{ version: '0.2.2-rc.5', ...row(30, 33), empty: row(20, 21) }],
      P3: row(8, 8.8, { unit: 'us' }),
      P4: row(100, 101, { comparable: true, plugins: { base: 21, head: 21 } }),
    },
    p5: {
      tarballBytes: 186325,
      unpackedBytes: 749068,
      kernelBytes: 115532,
      bootPeakRssKiB: 131000,
    },
    check: null,
    notes: [],
    ...overrides,
  }
}

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

test('the D76 limits and artifact name are pinned in one place', () => {
  assert.deepEqual(GATE_LIMITS, {
    ratio: 1.5,
    p2EmptyMs: 3000,
    p2PluginOverEmpty: 2,
    p3Micros: 50,
    p4Ratio: 1.5,
  })
  assert.equal(CI_ARTIFACT, 'perf.json')
  assert.equal(ARTIFACT_RETENTION_DAYS, 30)
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
  assert.equal(options.ci, false)
  assert.equal(options.jsonOut, null)
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

test('--ci turns on the fixed gate set and defaults the artifact to perf.json', () => {
  const ci = parseArgs(['--ci'])
  assert.equal(ci.ci, true)
  assert.equal(ci.check, true)
  assert.equal(ci.jsonOut, 'perf.json')
  assert.equal(ci.json, false, '--ci prints the table for the workflow log')
  assert.equal(parseArgs(['--ci', '--json-out', 'out.json']).jsonOut, 'out.json')
  assert.equal(parseArgs(['--check', '--json-out', 'out.json']).jsonOut, 'out.json')
})

test('--ci refuses a threshold: the CI limits are ratified, not tunable', () => {
  assert.throws(
    () => parseArgs(['--ci', '--threshold', '2']),
    (error) => error instanceof PerfError && /ratified D76/.test(error.message),
  )
})

test('parseArgs rejects out-of-range and malformed values', () => {
  assert.throws(() => parseArgs(['--repeat', '0']), PerfError)
  assert.throws(() => parseArgs(['--repeat', '101']), PerfError)
  assert.throws(() => parseArgs(['--repeat', '2.5']), PerfError)
  assert.throws(() => parseArgs(['--threshold', '0']), PerfError)
  assert.throws(() => parseArgs(['--threshold', 'NaN']), PerfError)
  assert.throws(() => parseArgs(['--base', '']), PerfError)
  assert.throws(() => parseArgs(['--json-out']), PerfError)
  assert.throws(() => parseArgs(['--json-out=']), PerfError)
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

test('gateRows builds P1, two P2 rows per pin, P3, P4, and four P5 records', () => {
  const rows = gateRows(sampleReport())
  assert.deepEqual(rows.map((entry) => entry.probe), ['P1', 'P2', 'P2', 'P3', 'P4', 'P5', 'P5', 'P5', 'P5'])
  assert.equal(rows.filter((entry) => entry.verdict === 'FAIL').length, 0)
  assert.equal(rows.filter((entry) => entry.verdict === 'record').length, 4)
  const empty = rows.find((entry) => entry.metric.startsWith('P2 empty boot'))
  assert.equal(empty.verdict, 'pass')
  assert.equal(empty.limitText, '3000 ms')
  const one = rows.find((entry) => entry.metric.startsWith('P2 one-plugin boot'))
  assert.equal(one.verdict, 'pass')
  assert.equal(one.limitKind, 'multiplier')
  assert.match(one.limitText, /^2\.00x empty \(21\.0 ms\)$/)
  const p3 = rows.find((entry) => entry.probe === 'P3')
  assert.equal(p3.limitText, '50.0 us')
  const p5 = rows.filter((entry) => entry.probe === 'P5')
  assert.ok(p5.every((entry) => entry.verdict === 'record' && entry.limitText === 'record only'))
})

test('gateRows fails a P1 or P4 ratio above the ceiling, and names the repeat', () => {
  const p1 = sampleReport()
  p1.probes.P1 = row(100, 160)
  assert.deepEqual(gateFailures(p1), ['P1 cold mod load: 1.60x > 1.50x (repeat 5)'])

  const p4 = sampleReport()
  p4.probes.P4 = row(100, 151, { comparable: true, plugins: { base: 21, head: 21 } })
  assert.deepEqual(gateFailures(p4), ['P4 compile (7 upstream + fixtures): 1.51x > 1.50x (repeat 5)'])
})

test('gateRows fails P3 on the absolute cap and P2 on either cap', () => {
  const report = sampleReport()
  report.probes.P3 = row(8, 51, { unit: 'us' })
  report.probes.P2 = [
    // 650 > 2 x 250: the one-plugin cap trips even though 650/300 is 2.17x.
    { version: '0.2.2-rc.5', ...row(300, 650), empty: row(200, 250) },
    // The empty profile's own 3 s cap trips; the one-plugin side is fine.
    { version: '0.2.2-rc.2', ...row(300, 310), empty: row(200, 3010) },
  ]
  assert.deepEqual(gateFailures(report), [
    'P2 one-plugin boot @ dsh 0.2.2-rc.5: 650.0 ms > 2.00x empty (250.0 ms) (repeat 5)',
    'P2 empty boot @ dsh 0.2.2-rc.2: 3010.0 ms > 3000 ms (repeat 5)',
    'P3 pre-execute fan-out: 51.0 us > 50.0 us (repeat 5)',
  ])
})

test('a P2 one-plugin/empty multiplier is the gate, not the base/head ratio', () => {
  const report = sampleReport()
  report.probes.P2 = [{ version: '0.2.2-rc.5', ...row(10, 189), empty: row(10, 10) }]
  // 18.9x is the descriptive base/head ratio; the gate is 189 ms against
  // 2 x 10 ms, and the failure says so rather than calling the ratio the cap.
  assert.deepEqual(gateFailures(report), [
    'P2 one-plugin boot @ dsh 0.2.2-rc.5: 189.0 ms > 2.00x empty (10.0 ms) (repeat 5)',
  ])
})

test('P4 with different plugin sets fails as not comparable', () => {
  const report = sampleReport()
  report.probes.P4 = row(100, 100, { comparable: false, plugins: { base: 20, head: 21 } })
  assert.deepEqual(gateFailures(report), [
    'P4 compile (7 upstream + fixtures): not comparable (base and head compiled different plugin sets) (repeat 5)',
  ])
})

test('a missing measurement is a failed row, never a vanished gate', () => {
  const report = sampleReport()
  report.probes.P1 = { base: null, head: null, ratio: null }
  report.probes.P2 = []
  report.probes.P3 = { unit: 'us', base: null, head: null, ratio: null }
  report.probes.P4 = { unit: 'ms', base: null, head: null, ratio: null, comparable: true }
  const failures = gateFailures(report)
  assert.equal(failures.length, 4, 'P1, P2, P3 and P4 each still produce a failure')
  assert.ok(failures.includes('P1 cold mod load: not measured (repeat 5)'))
  assert.ok(failures.includes('P2 boot + reconcile: not measured (repeat 5)'))
  assert.ok(failures.includes('P3 pre-execute fan-out: not measured (repeat 5)'))
  assert.ok(failures.includes('P4 compile (7 upstream + fixtures): not measured (repeat 5)'))
})

test('formatGateTable prints metric, base, head, ratio, limit and verdict', () => {
  const table = formatGateTable(sampleReport())
  assert.match(table, /^dsh-anyplugin perf gates — base aaaaaaaa \(origin\/main\) -> head bbbbbbbb · repeat 5$/mu)
  assert.match(table, /metric\s+base\s+head\s+ratio\s+limit\s+verdict/u)
  assert.match(table, /P1 cold mod load\s+200\.0 ms\s+220\.0 ms\s+1\.10x\s+1\.50x\s+pass/u)
  assert.match(table, /P2 empty boot @ dsh 0\.2\.2-rc\.5\s+20\.0 ms\s+21\.0 ms\s+1\.05x\s+3000 ms\s+pass/u)
  assert.match(table, /P2 one-plugin boot @ dsh 0\.2\.2-rc\.5.*2\.00x empty \(21\.0 ms\)\s+pass/u)
  assert.match(table, /P3 pre-execute fan-out\s+8\.00 us\s+8\.80 us\s+1\.10x\s+50\.0 us\s+pass/u)
  assert.match(table, /P4 compile \(7 upstream \+ fixtures\)\s+100\.0 ms\s+101\.0 ms\s+1\.01x\s+1\.50x\s+pass/u)
  assert.match(table, /P5 tarball bytes\s+-\s+186,325 B\s+-\s+record only\s+record/u)
  assert.match(table, /P5 boot peak RSS\s+-\s+131,000 KiB\s+-\s+record only\s+record/u)
  assert.doesNotMatch(table, /NaN|undefined/u)
})

test('formatGateTable shows FAIL and the measured limit for a red row', () => {
  const report = sampleReport()
  report.probes.P3 = row(8, 60, { unit: 'us' })
  const table = formatGateTable(report)
  assert.match(table, /P3 pre-execute fan-out\s+8\.00 us\s+60\.00 us\s+7\.50x\s+50\.0 us\s+FAIL/u)
})

test('formatTable shows base, head and ratio, and records P5 without gating it', () => {
  const table = formatTable(sampleReport())
  assert.match(table, /ratio = median of per-pair head\/base/)
  assert.match(table, /P2 5 paired boots per profile\/side/)
  assert.match(
    table,
    /gated \(D76\): P1 ratio <= 1\.5x · P2 empty <= 3000 ms and one-plugin <= 2x empty · P3 <= 50 us\/dispatch · P4 ratio <= 1\.5x/u,
  )
  assert.match(table, /recorded, never gated: P5/u)
  assert.match(table, /P1\s+cold mod load: diff \(loadMod \+ evaluate\)\s+200\.0 ms\s+220\.0 ms\s+1\.10x/u)
  assert.match(table, /P2\s+empty boot \(no lock\) @ dsh 0\.2\.2-rc\.5\s+20\.0 ms\s+21\.0 ms\s+1\.05x/u)
  assert.match(table, /P2\s+one-plugin boot \+ reconcile @ dsh 0\.2\.2-rc\.5\s+30\.0 ms\s+33\.0 ms\s+1\.10x/u)
  assert.match(table, /P4\s+compile: 21 plugins \(read\+gate\+emit\)\s+100\.0 ms\s+101\.0 ms\s+1\.01x/u)
  assert.match(table, /P5  head only/u)
  assert.match(table, /tarball\s+186,325 bytes/u)
  assert.match(table, /boot peak RSS\s+131,000 KiB/u)
  assert.doesNotMatch(table, /gates:/u)
  assert.doesNotMatch(table, /NaN|undefined/u)
})

test('formatTable marks a pin it could not measure instead of inventing a number', () => {
  const report = sampleReport()
  report.probes.P2.push({ version: '0.2.2-rc.2', pin: '0.2.2-rc.2', base: null, head: null, ratio: null })
  const table = formatTable(report)
  assert.match(table, /P2\s+empty boot \(no lock\) @ dsh 0\.2\.2-rc\.2\s+-\s+-\s+-/u)
  assert.match(table, /P2\s+one-plugin boot \+ reconcile @ dsh 0\.2\.2-rc\.2\s+-\s+-\s+-/u)
  assert.doesNotMatch(table, /NaN|undefined/u)
})

test('formatTable prints the D76 failure list when a gate trips', () => {
  const report = sampleReport()
  report.probes.P1 = row(100, 200)
  report.check = {
    threshold: 1.5,
    limits: GATE_LIMITS,
    rows: gateRows(report),
    failures: gateFailures(report),
  }
  const table = formatTable(report)
  assert.match(
    table,
    /gates: 1 failed \(repeat 5\) — P1 cold mod load: 2\.00x > 1\.50x \(repeat 5\)/u,
  )
})

test('formatTable derives check rows when only the failure list was stored', () => {
  const report = sampleReport()
  report.probes.P1 = row(1, 2)
  report.check = { threshold: 1.5, failures: ['P1 cold mod load: 2.00x > 1.50x (repeat 5)'] }
  assert.match(formatTable(report), /gates: 1 failed/u)
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

test('the two-profile schedule interleaves empty and one-plugin boots', async () => {
  const calls = []
  const logs = await sampleBootProfiles({
    repeat: 2,
    profiles: ['empty', 'one'],
    run: async ({ profile, side, pair, warmup }) => {
      calls.push(warmup ? `${profile}:${side}:warmup` : `${profile}:${side}:${pair}`)
      return side === 'base' ? 10 : 20
    },
  })
  assert.deepEqual(calls, [
    'empty:base:warmup',
    'empty:head:warmup',
    'one:base:warmup',
    'one:head:warmup',
    'empty:base:0',
    'empty:head:0',
    'one:base:0',
    'one:head:0',
    'one:head:1',
    'one:base:1',
    'empty:head:1',
    'empty:base:1',
  ])
  for (const profile of ['empty', 'one']) {
    const paired = pairBootLog(logs[profile])
    assert.deepEqual(paired.base, [10, 10])
    assert.deepEqual(paired.head, [20, 20])
    assert.deepEqual(paired.ratios, [2, 2])
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
    emptySamples: { base: [100, 300], head: [150, 150] },
    hostPath: 'scope-link',
    moduleUrl: 'file:///tmp/base/lib/index.js',
  })
  assert.equal(pin.ratio, 1.5)
  assert.deepEqual(pin.pairs, [2.5, 0.5])
  assert.equal(pin.base.median, 200)
  assert.equal(pin.head.median, 200)
  assert.equal(pin.empty.ratio, 1)
  assert.deepEqual(pin.empty.pairs, [1.5, 0.5])
  assert.equal(pin.empty.base.median, 200)
  assert.equal(pin.empty.head.median, 150)
})

test('pinReportRow omits the empty row when no empty samples were measured', () => {
  const pin = pinReportRow({
    pin: '0.2.2-rc.5',
    samples: { base: [100], head: [110] },
    hostPath: 'scope-link',
    moduleUrl: 'file:///tmp/base/lib/index.js',
  })
  assert.equal(pin.empty, undefined)
})

test('pairRatios pairs sample i with sample i and refuses different counts', () => {
  assert.deepEqual(pairRatios([100, 50], [120, 40]), [1.2, 0.8])
  assert.throws(() => pairRatios([], []), PerfError)
  assert.throws(() => pairRatios([100], [120, 40]), PerfError)
  assert.throws(() => pairRatios([0], [120]), PerfError)
})
