// F16 end to end: a denial the guard actually produced must be countable by the
// audit without reading tool output. This spawns the real CLI rather than
// importing it, because the audit's contract is its digest and its evidence
// JSON — the two things an auditor sees.
//
// F2 is the other half of the same surface: the digest must name the guard's
// install state, and CI has no Desktop profile to ask. The probe's seam is
// DSH_ANYPLUGIN_GUARD_STATUS_RUNNER, so the guard cases below run a fixture
// that takes `--json` and prints a report — never this machine's profile.
//
// The log fixture is asserted to be a regular file immediately before each
// spawn, and a child that reports it absent while the fixture still exists
// fails with the child's environment and the file's stat. Those diagnostics are
// for a full-suite-only flake seen once in review; it never reproduced in
// isolation or in three full-suite-shape runs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import zlib from 'node:zlib'

import { apply } from '../packages/dsh-anyplugin-guard/src/index.ts'
import { mainCheckout } from './audit-checkout.mjs'
import { GUARD_PROBE_TIMEOUT_MS, parseProbeTimeout } from './guard-probe-timeout.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts', 'audit-evidence.mjs')
const repo = '/work/repo'
const worktree = '/work/wt/ticket-164'
const config = { worktrees: [worktree], protectedRoots: [repo] }
const worker = {
  session: { header: { id: 'worker-164', cwd: repo, origin: 'subagent', parentSession: 'root-1' } },
}

function audit(name) {
  const dir = mkdtempSync(join(tmpdir(), `audit-evidence-${name}-`))
  process.env.DSH_ANYPLUGIN_AUDIT_DIR = dir
  return dir
}

function harness() {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(listener), 1)
    },
    effect(register) {
      disposers.push(register())
    },
  }
  return { ctx, listeners, disposers }
}

function runAudit(dir, args = [], env = {}) {
  return spawnSync(process.execPath, [script, '--no-sessions', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSH_ANYPLUGIN_AUDIT_DIR: dir, ...env },
  })
}

// A stand-in for scripts/guard-status.mjs: executable, takes `--json`, prints a
// report. `raw` bypasses JSON encoding so a malformed line can be proven
// unparsable, and a nonzero exitCode proves the reader's "not current" signal is
// data rather than a probe failure.
function guardRunner(name, { report, raw, exitCode = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), `guard-status-${name}-`))
  const file = join(dir, 'guard-status.mjs')
  const body = raw ?? JSON.stringify(report)
  writeFileSync(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(body)})\nprocess.exitCode = ${exitCode}\n`)
  chmodSync(file, 0o755)
  return file
}

// The shape scripts/guard-status.mjs prints; the digest line is built from it.
function guardReport(overrides = {}) {
  return {
    profileDir: '/home/auditor/.dsh/profiles/desktop',
    patchFile: '/home/auditor/.dsh/profiles/desktop/installs.yml',
    status: 'current',
    source: '/work/repo/packages/dsh-anyplugin-guard/src/index.ts',
    sourceExists: true,
    worktrees: ['/tmp/anyplugin-wt/ticket-*'],
    installedWorktrees: ['/tmp/anyplugin-wt/ticket-*'],
    stalePaths: [],
    protectedRoots: ['/work/repo'],
    duplicateId: false,
    hooks: [{ file: '/work/repo/.git/hooks/pre-push', status: 'current' }],
    ...overrides,
  }
}

function evidenceFile(dir) {
  return join(dir, `evidence-${new Date().toISOString().slice(0, 10)}.json`)
}

// The fixture is asserted immediately before the child is spawned: an edit that
// stops writing the log then fails here, naming the missing file, instead of
// surfacing as a mysterious "no structured log" from inside the child.
function assertLogShape(dir, { size } = {}) {
  const file = join(dir, 'guard-denials.jsonl')
  const stat = statSync(file)
  assert.ok(stat.isFile(), `${file} must be a regular file, not mode ${stat.mode.toString(8)}`)
  if (size !== undefined) assert.equal(stat.size, size, `${file} must be ${size} bytes`)
  return file
}

// One full-suite run reported this child as "no structured log" for a file that
// existed. It never reproduced in isolation or in three full-suite-shape runs;
// if it happens again, fail with the child's environment and the file's stat so
// the mechanism is visible instead of being a regex mismatch. Do not turn this
// into a silent retry: a flake that passes on the second attempt is a flake.
function explainAbsentLog(dir, result) {
  const file = join(dir, 'guard-denials.jsonl')
  const lines = [`the audit child reported the structured log absent or unreadable, but the fixture is still there: ${file}`]
  lines.push(`parent DSH_ANYPLUGIN_AUDIT_DIR: ${process.env.DSH_ANYPLUGIN_AUDIT_DIR ?? '(unset)'}`)
  lines.push(`child status ${result.status}, signal ${result.signal ?? '(none)'}, error ${result.error ? String(result.error) : '(none)'}`)
  try {
    const stat = statSync(file)
    lines.push(`fixture stat: regular=${stat.isFile()} size=${stat.size} mode=${stat.mode.toString(8)} ino=${stat.ino} mtimeMs=${stat.mtimeMs}`)
  } catch (error) {
    lines.push(`fixture stat now fails: ${error.code ?? String(error)}`)
  }
  try {
    lines.push(`dir entries: ${readdirSync(dir).join(', ') || '(none)'}`)
  } catch (error) {
    lines.push(`dir entries unreadable: ${error.code ?? String(error)}`)
  }
  const printed = /at (\/[^\n]+)$/mu.exec(result.stdout)?.[1]
  if (printed !== undefined) lines.push(`path in child output: ${printed}`)
  lines.push(`child stdout:\n${result.stdout.slice(0, 2000)}`)
  if (result.stderr) lines.push(`child stderr:\n${result.stderr}`)
  return lines.join('\n')
}

function assertChildReadLog(dir, result) {
  if (/no structured log|log unreadable/u.test(result.stdout)) assert.fail(explainAbsentLog(dir, result))
}

async function deny() {
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 801, name: 'bash', arguments: { command: 'git push origin main' }, agent: worker },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(denied.kind, 'deny')
}

test('a real guard denial is counted by the digest and the evidence JSON', async () => {
  const dir = audit('real')
  await deny()
  assertLogShape(dir)
  const result = runAudit(dir, ['--days', '1'])
  assert.equal(result.status, 0, result.stderr)
  assertChildReadLog(dir, result)
  assert.match(result.stdout, /guard denials \(structured, last 1 days\): 1 \(worker 1\)/u)
  assert.match(result.stdout, /by rule: git-push-main 1/u)
  assert.match(result.stdout, /last: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} git-push-main worker/u)

  const evidence = JSON.parse(readFileSync(evidenceFile(dir), 'utf8'))
  assert.equal(evidence.guardDenials.available, true)
  assert.equal(evidence.guardDenials.total, 1)
  assert.deepEqual(evidence.guardDenials.byRule, [{ rule: 'git-push-main', count: 1 }])
  assert.deepEqual(evidence.guardDenials.byRole, [{ role: 'worker', count: 1 }])
  assert.equal(evidence.guardDenials.recent.at(-1).rule, 'git-push-main')
  assert.equal(evidence.guardDenials.unreadable, 0)
})

test('an unwritable evidence directory fails before the digest, not after it', (t) => {
  // Root ignores the mode bits, so the check only means something for a normal user.
  if (process.getuid?.() === 0) {
    t.skip('runs as root: directory modes are not enforced')
    return
  }
  const base = mkdtempSync(join(tmpdir(), 'audit-unwritable-'))
  const auditDir = join(base, 'audit')
  mkdirSync(auditDir)
  chmodSync(auditDir, 0o500)
  try {
    const result = runAudit(auditDir, ['--days', '1'])
    assert.notEqual(result.status, 0, 'an audit that cannot write its evidence must fail')
    assert.match(result.stderr, /audit-evidence: cannot write/u)
    assert.ok(result.stderr.includes(auditDir), `stderr must name ${auditDir}`)
    assert.equal(readdirSync(auditDir).length, 0, 'no partial evidence file')
    assert.doesNotMatch(result.stdout, /audit digest/u, 'the digest must not be printed')
  } finally {
    chmodSync(auditDir, 0o700)
    rmSync(base, { recursive: true, force: true })
  }
})

test('a missing log is reported as absent, not as zero denials', () => {
  const dir = audit('missing')
  const result = runAudit(dir, ['--days', '1', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.guardDenials.available, false)
  assert.equal(evidence.guardDenials.total, 0)
  assert.ok(!existsSync(join(dir, 'guard-denials.jsonl')))
})

test('an empty log is present with zero denials, not absent', () => {
  const dir = audit('empty')
  writeFileSync(join(dir, 'guard-denials.jsonl'), '')
  assertLogShape(dir, { size: 0 })
  const result = runAudit(dir, ['--days', '1'])
  assert.equal(result.status, 0, result.stderr)
  assertChildReadLog(dir, result)
  assert.match(result.stdout, /guard denials \(structured, last 1 days\): 0 \(none\); by rule: none; last: none/u)
  const json = runAudit(dir, ['--days', '1', '--json'])
  const evidence = JSON.parse(json.stdout)
  assert.equal(
    evidence.guardDenials.available,
    true,
    evidence.guardDenials.available === false ? explainAbsentLog(dir, json) : undefined,
  )
  assert.equal(evidence.guardDenials.total, 0)
  assert.deepEqual(evidence.guardDenials.byRule, [])
  assert.deepEqual(evidence.guardDenials.byRole, [])
  assert.deepEqual(evidence.guardDenials.recent, [])
})

test('malformed lines and records outside the window are counted without crashing', () => {
  const dir = audit('mixed')
  const now = new Date()
  const recent = { ts: now.toISOString(), role: 'root', rule: 'git-push-main', tool: 'bash', subject: 'git push origin main' }
  const old = { ...recent, ts: new Date(now.getTime() - 10 * 86_400_000).toISOString(), rule: 'shell-unmodelled' }
  const future = { ...recent, ts: new Date(now.getTime() + 10 * 86_400_000).toISOString(), rule: 'sudo-refused' }
  writeFileSync(
    join(dir, 'guard-denials.jsonl'),
    ['{not json', JSON.stringify({ ...recent, role: 'someone-else' }), JSON.stringify(old), JSON.stringify(future), JSON.stringify(recent), ''].join('\n'),
  )
  assertLogShape(dir)
  const result = runAudit(dir, ['--days', '1', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(
    evidence.guardDenials.available,
    true,
    evidence.guardDenials.available === false ? explainAbsentLog(dir, result) : undefined,
  )
  assert.equal(evidence.guardDenials.total, 1)
  assert.equal(evidence.guardDenials.unreadable, 2)
  assert.equal(evidence.guardDenials.outsideWindow, 2)
  assert.deepEqual(evidence.guardDenials.byRule, [{ rule: 'git-push-main', count: 1 }])
})

test('an unreadable log is reported as unreadable, not as absent', () => {
  const dir = audit('unreadable')
  mkdirSync(join(dir, 'guard-denials.jsonl'))
  const result = runAudit(dir, ['--days', '1'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /guard denials \(structured, last 1 days\): log unreadable/u)
  const evidence = JSON.parse(runAudit(dir, ['--days', '1', '--json']).stdout)
  assert.equal(evidence.guardDenials.available, false)
  assert.ok(evidence.guardDenials.error, 'the read error is kept for the digest')
})

test('the digest reports a current guard from the parsed report', () => {
  const dir = audit('guard-current')
  const runner = guardRunner('current', { report: guardReport() })
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^- guard: \*\*current\*\*; source present; worktree entries 1 desired \/ 1 installed; hooks pre-push current$/mu)

  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.equal(evidence.guard.status, 'current')
  assert.equal(evidence.guard.sourceExists, true)
  assert.deepEqual(evidence.guard.stalePaths, [])
  assert.equal(evidence.guard.duplicateId, false)
})

test('a nonzero guard-status exit with a valid report is not-installed, not unavailable', () => {
  const dir = audit('guard-not-installed')
  const runner = guardRunner('not-installed', {
    exitCode: 1,
    report: guardReport({
      status: 'not-installed',
      installedWorktrees: [],
      hooks: [{ file: '/work/repo/.git/hooks/pre-push', status: 'missing' }],
    }),
  })
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, 'a not-current guard must not fail the digest')
  assert.match(result.stdout, /^- guard: \*\*not-installed\*\*; source present; worktree entries 1 desired \/ 0 installed; hooks pre-push missing$/mu)

  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.equal(evidence.guard.status, 'not-installed')
  assert.ok(!('error' in evidence.guard), 'a parsed report is not an unavailable probe')
})

test('installed-with-stale-paths names the stale path in the digest', () => {
  const dir = audit('guard-stale')
  const runner = guardRunner('stale', {
    report: guardReport({
      status: 'installed-with-stale-paths',
      stalePaths: ['/tmp/anyplugin-wt/ticket-142'],
      installedWorktrees: [],
    }),
  })
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /^- guard: \*\*installed-with-stale-paths\*\*; source present; worktree entries 1 desired \/ 0 installed; stale paths: \/tmp\/anyplugin-wt\/ticket-142; hooks pre-push current$/mu,
  )
  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.deepEqual(evidence.guard.stalePaths, ['/tmp/anyplugin-wt/ticket-142'])
})

test('a duplicate guard id is reported as duplicate in the digest', () => {
  const dir = audit('guard-duplicate')
  const runner = guardRunner('duplicate', { report: guardReport({ status: 'stale', duplicateId: true }) })
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /^- guard: \*\*duplicate\*\*; source present; worktree entries 1 desired \/ 1 installed; a second anyplugin-guard id sits outside the managed block; hooks pre-push current$/mu,
  )
  // The derived word is for the digest; the reader's own status stays in the JSON.
  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.equal(evidence.guard.duplicateId, true)
  assert.equal(evidence.guard.status, 'stale')
})

test('a guard probe that cannot be spawned is unavailable, and the digest still exits 0', () => {
  const dir = audit('guard-spawn')
  const base = mkdtempSync(join(tmpdir(), 'guard-missing-'))
  const runner = join(base, 'missing', 'guard-status.mjs')
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, 'an unavailable probe must not fail the digest')
  assert.match(
    result.stdout,
    /^- guard: \*\*unavailable\*\*: the probe could not be spawned \(ENOENT\); install state unknown — treat as not current until the probe reports$/mu,
  )
  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.equal(evidence.guard.status, 'unavailable')
  assert.match(evidence.guard.error, /ENOENT/u)
})

test('unparsable guard-status output is unavailable with the reason, not a crash', () => {
  const dir = audit('guard-unparsable')
  const runner = guardRunner('unparsable', { raw: 'guard-status: not json', exitCode: 1 })
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, 'an unparsable report must not fail the digest')
  assert.match(
    result.stdout,
    /^- guard: \*\*unavailable\*\*: unparsable guard-status output \(exit 1\); install state unknown — treat as not current until the probe reports$/mu,
  )
  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.equal(evidence.guard.status, 'unavailable')
  assert.match(evidence.guard.error, /unparsable guard-status output/u)
})

test('a stale block names the difference line the F2 evidence quotes', () => {
  const dir = audit('guard-stale-difference')
  const runner = guardRunner('stale-difference', {
    report: guardReport({
      status: 'stale',
      difference: { line: 4, installed: 'id: anyplugin-guard', current: 'id: anyplugin-guard' },
    }),
  })
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /^- guard: \*\*stale\*\*; source present; worktree entries 1 desired \/ 1 installed; the installed block differs from the tree at line 4; hooks pre-push current$/mu,
  )
  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.equal(evidence.guard.status, 'stale')
  assert.equal(evidence.guard.difference.line, 4)
})

test('a refused report is cannot-tell with its reason, not invented negative facts', () => {
  const dir = audit('guard-refused')
  const runner = guardRunner('refused', {
    exitCode: 1,
    report: { status: 'refused', reason: 'a second anyplugin-guard id sits outside the managed block' },
  })
  const result = runAudit(dir, ['--days', '1'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner })
  assert.equal(result.status, 0, 'a refused guard report must not fail the digest')
  assert.match(
    result.stdout,
    /^- guard: \*\*refused\*\*: a second anyplugin-guard id sits outside the managed block; install state unknown — treat as not current until the probe reports$/mu,
  )
  assert.doesNotMatch(result.stdout, /source (?:present|missing); worktree entries/u, 'no negative facts are invented')
  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: runner }).stdout,
  )
  assert.equal(evidence.guard.status, 'refused')
  assert.equal(evidence.guard.reason, 'a second anyplugin-guard id sits outside the managed block')
})

// The timeout rule is imported directly: the audit script runs its main body on
// import, so the parse lives in a module a test can load without spawning it.
// `0x10` is the regression: `Number()` read it as 16 ms and silently shortened
// the probe, while the end-to-end case below proves the accepted override path.
test('the probe timeout accepts only positive integer digits and falls back to 25 s', () => {
  assert.equal(GUARD_PROBE_TIMEOUT_MS, 25_000)
  assert.equal(parseProbeTimeout('100'), 100)
  for (const value of ['', '0', '-1', '1.5', '0x10', 'garbage']) {
    assert.equal(parseProbeTimeout(value), 25_000, `${JSON.stringify(value)} must fall back to 25 000 ms`)
  }
  assert.equal(parseProbeTimeout(undefined), 25_000, 'an unset variable uses the 25 s default')
})

test('a probe that times out is unavailable, and the digest still exits 0', () => {
  const dir = audit('guard-timeout')
  const slowDir = mkdtempSync(join(tmpdir(), 'guard-status-slow-'))
  const slow = join(slowDir, 'guard-status.mjs')
  writeFileSync(slow, `#!${process.execPath}\nsetTimeout(() => {}, 60_000)\n`)
  chmodSync(slow, 0o755)
  const result = runAudit(dir, ['--days', '1'], {
    DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: slow,
    DSH_ANYPLUGIN_GUARD_PROBE_TIMEOUT_MS: '100',
  })
  assert.equal(result.status, 0, 'a timed-out probe must not fail the digest')
  assert.match(
    result.stdout,
    /^- guard: \*\*unavailable\*\*: the probe timed out after 100 ms; install state unknown — treat as not current until the probe reports$/mu,
  )
  const evidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], {
      DSH_ANYPLUGIN_GUARD_STATUS_RUNNER: slow,
      DSH_ANYPLUGIN_GUARD_PROBE_TIMEOUT_MS: '100',
    }).stdout,
  )
  assert.equal(evidence.guard.status, 'unavailable')
  assert.match(evidence.guard.error, /timed out after 100 ms/u)
})

// F21: a seeded fork's transcript opens with a byte copy of its ancestor's
// events, so counting the whole file lists inherited work as the child's own.
// The digest must count the independent tail after the tagged cut, sort the
// eight largest by that independent window work (the role-cap unit, D73), name
// a seeded session whose cut cannot be read, and print the greatest decision
// number rather than the last line. These fixtures build a DSH home and spawn
// the CLI without `--no-sessions`, because the digest text and the evidence
// JSON are the contract an auditor reads.
const projectRoot = mainCheckout(root)
const sessionBucketName = `--${projectRoot.replaceAll(sep, '-').replace(/^-+/u, '')}--`

// zstd is only needed to build transcript fixtures. Native support landed in
// Node 22.15; older Node falls back to the CLI so this file still loads there.
function compress(bytes) {
  if (typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(Buffer.from(bytes))
  const result = spawnSync('zstd', ['-q', '-c'], { input: Buffer.from(bytes), maxBuffer: 64 * 1024 * 1024 })
  assert.equal(result.status, 0, `no native zstd and \`zstd -q -c\` failed: ${String(result.stderr ?? result.error)}`)
  return result.stdout
}

function sessionAuditFixtures() {
  const home = mkdtempSync(join(tmpdir(), 'audit-sessions-'))
  const bucket = join(home, 'sessions', sessionBucketName)
  mkdirSync(bucket, { recursive: true })
  return { home, bucket }
}

function writeSessionFixture(bucket, id, events) {
  const dir = join(bucket, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), compress(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`))
}

// The projection cache is the digest's second source for a seed's cut; it may
// only sharpen the "cannot tell" note, never replace the transcript.
function writeProjectionFixture(home, id, identity) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 7, record: { identity } }))
}

function runAuditSessions(home, dir, args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSH_ANYPLUGIN_AUDIT_DIR: dir, DSH_HOME: home, ...env },
  })
}

// A frozen clock for the window-boundary case: the child computes `since` from
// its own `Date.now()`, so a fixture written against the parent's clock can never
// put a call exactly on `sinceMs`. `--import` runs before the script's main body
// and only this spawn sees it, so the audit script itself needs no clock seam.
// The override is test-only, like DSH_ANYPLUGIN_AUDIT_DIR.
function frozenClockPreload(dir) {
  const file = join(dir, 'frozen-clock.mjs')
  writeFileSync(
    file,
    [
      'const fixed = Number(process.env.DSH_AUDIT_TEST_NOW_MS)',
      'const RealDate = Date',
      'class FrozenDate extends RealDate {',
      '  constructor(...args) {',
      '    if (args.length === 0) super(fixed)',
      '    else super(...args)',
      '  }',
      '  static now() {',
      '    return fixed',
      '  }',
      '}',
      'globalThis.Date = FrozenDate',
      '',
    ].join('\n'),
  )
  return pathToFileURL(file).href
}

function headerLine(id, { seeded = false, depth = 0 } = {}) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: new Date().toISOString(),
    cwd: root,
    isSeeded: seeded,
    delegationDepth: depth,
    agentPreset: 'standard',
  }
}

function call(seq, name, time) {
  const args = name === 'bash' ? { command: 'npm run check:features' } : { file_path: '/work/repo/x.md' }
  return { seq, time, type: 'tool/call', data: { callId: `call-${seq}`, name, arguments: JSON.stringify(args) } }
}

function inheritedMarker(seq, time) {
  return { seq, time, type: 'session/end-seed', data: { inherited: true } }
}

test('a seeded fork counts only events after its tagged cut, and the eight largest are ordered by independent window work', () => {
  const dir = audit('seeded-fork')
  const { home, bucket } = sessionAuditFixtures()
  const now = Date.now()
  const old = now - 10 * 86_400_000
  writeSessionFixture(bucket, 'root-session-01', [
    headerLine('root-session-01', { depth: 0 }),
    call(0, 'bash', now),
    call(1, 'bash', now),
    call(2, 'bash', now),
  ])
  // Four inherited calls, a tagged cut, then independent work: two bash calls in
  // the window and three reads older than it. The reads count in `lifetime` but
  // not `window`, so this child has the largest lifetime (5) while its window
  // work (2) is below the root's (3). A lifetime-only sort therefore produces a
  // different order than the window sort, which is what proves the key below.
  writeSessionFixture(bucket, 'seeded-child-01', [
    headerLine('seeded-child-01', { seeded: true, depth: 1 }),
    call(0, 'bash', old),
    call(1, 'bash', old),
    call(2, 'bash', old),
    call(3, 'bash', old),
    inheritedMarker(4, old),
    call(5, 'bash', now),
    call(6, 'read', old),
    call(7, 'bash', now),
    call(8, 'read', old),
    call(9, 'read', old),
  ])
  writeProjectionFixture(home, 'seeded-child-01', {
    formatVersion: 4,
    cwd: root,
    isSeeded: true,
    inheritedEventCount: 4,
  })
  writeSessionFixture(bucket, 'plain-child-01', [
    headerLine('plain-child-01', { depth: 1 }),
    call(0, 'bash', now),
  ])
  writeProjectionFixture(home, 'plain-child-01', {
    formatVersion: 4,
    cwd: root,
    isSeeded: false,
    inheritedEventCount: 0,
  })

  const result = runAuditSessions(home, dir, ['--days', '1'])
  assert.equal(result.status, 0, result.stderr)
  // Selection of a session is by transcript mtime; the per-row `window` value is
  // a per-call filter. The digest must say both, or a 1-day window reads as a
  // lifetime count for every included session.
  assert.match(
    result.stdout,
    /sessions are selected by transcript mtime, and a row's `window` counts only that session's independent calls whose event time is at or after the window start/u,
  )
  // The copied prefix is reported as excluded, never silently dropped.
  assert.match(
    result.stdout,
    /^- inherited prefixes excluded: 1 seeded session\(s\), 4 copied tool calls \(not independent work\)$/mu,
  )
  // Aggregates count independent calls only: 3 root + 2 seeded + 1 plain bash calls.
  assert.match(result.stdout, /^- bash 6 calls;/mu)
  assert.match(result.stdout, /^- tools: bash 6, read 3$/mu)
  // The eight largest show independent window work, with lifetime as context.
  assert.match(result.stdout, /seeded-child-01 d1 window 2 lifetime 5 inherited 4/u)

  const evidence = JSON.parse(runAuditSessions(home, dir, ['--days', '1', '--json']).stdout)
  const rows = evidence.sessions.largest
  const windowOrder = [...rows]
    .sort((a, b) => b.window - a.window || b.lifetime - a.lifetime || a.id.localeCompare(b.id))
    .map((row) => row.id)
  const lifetimeOrder = [...rows].sort((a, b) => b.lifetime - a.lifetime || a.id.localeCompare(b.id)).map((row) => row.id)
  // The fixture makes the two keys disagree (window 3 > 2 > 1; lifetime 5 > 3 > 1).
  // A sort that drops the window key yields the second list, so pinning the first
  // list is a proof that window work orders the table.
  assert.deepEqual(windowOrder, ['root-session-01', 'seeded-child-01', 'plain-child-01'], 'window order')
  assert.deepEqual(
    lifetimeOrder,
    ['seeded-child-01', 'root-session-01', 'plain-child-01'],
    'a lifetime-only sort must order this fixture differently, or the fixture does not prove the window key',
  )
  assert.deepEqual(
    rows.map((row) => row.id),
    windowOrder,
    'the table is ordered by independent window work (3 > 2 > 1), not lifetime (5 > 3 > 1)',
  )
  const seeded = rows.find((row) => row.id === 'seeded-child-01')
  assert.deepEqual(
    { window: seeded.window, lifetime: seeded.lifetime, inherited: seeded.inherited, seed: seeded.seed },
    { window: 2, lifetime: 5, inherited: 4, seed: 'seeded' },
  )
  // `tools` is the pre-F21 name for the independent total; the evidence JSON is
  // an artifact other tools read, so the old key stays as an alias.
  for (const row of rows) assert.equal(row.tools, row.lifetime, `${row.id}: tools must alias lifetime`)
  assert.equal(seeded.tools, 5)
  assert.deepEqual(evidence.sessions.inherited, { sessions: 1, tools: 4 })
  assert.deepEqual(evidence.sessions.unknownSeed, [])
  assert.equal(evidence.sessions.toolCalls.find((row) => row.name === 'bash')?.count, 6)
})

test('a call exactly at the window start counts in window, one millisecond earlier does not', () => {
  const dir = audit('window-boundary')
  const { home, bucket } = sessionAuditFixtures()
  // Freeze the child's clock to one known millisecond so `sinceMs = now - 1 day`
  // is exact; `generatedAt` below proves the child ran on that clock.
  const now = Date.now()
  const sinceMs = now - 86_400_000
  writeSessionFixture(bucket, 'boundary-session-01', [
    headerLine('boundary-session-01', { depth: 0 }),
    call(0, 'bash', sinceMs),
    call(1, 'read', sinceMs - 1),
  ])
  const result = runAuditSessions(home, dir, ['--days', '1', '--json'], {
    DSH_AUDIT_TEST_NOW_MS: String(now),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${frozenClockPreload(dir)}`.trim(),
  })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.generatedAt, new Date(now).toISOString(), 'the frozen clock must reach the child')
  const row = evidence.sessions.largest.find((candidate) => candidate.id === 'boundary-session-01')
  assert.ok(row, 'the fixture session must be included')
  // `>= sinceMs` includes the call exactly at the boundary; one millisecond
  // earlier is independent lifetime work but outside the window.
  assert.equal(row.window, 1, 'a call exactly at the window start is inside it (event.time >= sinceMs)')
  assert.equal(row.lifetime, 2, 'the call one millisecond before the window is lifetime work only')
  assert.equal(row.tools, 2, 'tools aliases the independent lifetime total')
})

test('decisions.last is the greatest decision number, not the last line in the file', () => {
  const dir = audit('decisions-order')
  const home = mkdtempSync(join(tmpdir(), 'audit-empty-home-'))
  const file = join(mkdtempSync(join(tmpdir(), 'decisions-order-')), 'DECISIONS.md')
  writeFileSync(file, ['## D85 — five', '', '## D88 — eight', '', '## D84 — four', '', '## D86 — six', ''].join('\n'))
  const env = { DSH_ANYPLUGIN_AUDIT_DECISIONS: file, DSH_HOME: home }
  const result = runAudit(dir, ['--days', '1'], env)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^- decisions: 4 \(last D88; duplicates: none\)$/mu)
  const evidence = JSON.parse(runAudit(dir, ['--days', '1', '--json'], env).stdout)
  assert.deepEqual(evidence.decisions, { entries: 4, last: 'D88', duplicates: [] })
})

test('duplicate, reworded and prose-embedded decision ids follow the heading grammar', () => {
  const dir = audit('decisions-grammar')
  const home = mkdtempSync(join(tmpdir(), 'audit-empty-home-'))
  const file = join(mkdtempSync(join(tmpdir(), 'decisions-grammar-')), 'DECISIONS.md')
  writeFileSync(
    file,
    [
      '## D1 — one',
      '',
      '## D2 — two',
      '',
      '## D1 — one, repeated heading', // duplicate: counted, named once
      '',
      'Prose mentions D99 and a lookalike `## D98 — not a heading`.', // prose-embedded: not a heading
      '',
      '### D3 — three', // reworded: h3, not the h2 the log uses
      '',
      '## D 4 — four', // reworded: a space after D
      '',
      '## D5: five', // reworded: colon instead of the em dash
      '',
      '## D2 — two, repeated heading', // duplicate of an earlier id
      '',
      '## D6 — six',
      '',
    ].join('\n'),
  )
  const env = { DSH_ANYPLUGIN_AUDIT_DECISIONS: file, DSH_HOME: home }
  const result = runAudit(dir, ['--days', '1'], env)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^- decisions: 5 \(last D6; duplicates: D1, D2\)$/mu)
  assert.deepEqual(
    JSON.parse(runAudit(dir, ['--days', '1', '--json'], env).stdout).decisions,
    { entries: 5, last: 'D6', duplicates: ['D1', 'D2'] },
  )

  // A doubled log is the reviewer's hand exercise: every heading counts and each
  // id is named once as a duplicate. The expectation is derived from the real log
  // so appending a decision does not make this fixture stale.
  const real = readFileSync(join(root, 'docs', 'DECISIONS.md'), 'utf8')
  const realIds = [...real.matchAll(/^## (D\d+) — /gmu)].map((match) => match[1])
  const doubled = join(mkdtempSync(join(tmpdir(), 'decisions-doubled-')), 'DECISIONS.md')
  writeFileSync(doubled, real + real)
  const doubledEvidence = JSON.parse(
    runAudit(dir, ['--days', '1', '--json'], { ...env, DSH_ANYPLUGIN_AUDIT_DECISIONS: doubled }).stdout,
  )
  const greatest = [...realIds].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0]
  assert.deepEqual(doubledEvidence.decisions, {
    entries: realIds.length * 2,
    last: greatest,
    duplicates: [...new Set(realIds)],
  })
})

test('a seeded header whose cut cannot be read is excluded and named, not counted as independent work', () => {
  const dir = audit('unknown-seed')
  const { home, bucket } = sessionAuditFixtures()
  const now = Date.now()
  // Seeded header, no tagged cut: the projection cache knows how much is
  // inherited, but the digest must say it cannot tell, not guess.
  writeSessionFixture(bucket, 'broken-seed-01', [
    headerLine('broken-seed-01', { seeded: true, depth: 1 }),
    call(0, 'bash', now),
    call(1, 'bash', now),
    call(2, 'bash', now),
  ])
  writeProjectionFixture(home, 'broken-seed-01', {
    formatVersion: 4,
    cwd: root,
    isSeeded: true,
    inheritedEventCount: 7,
  })
  writeSessionFixture(bucket, 'plain-child-01', [
    headerLine('plain-child-01', { depth: 1 }),
    call(0, 'bash', now),
    call(1, 'bash', now),
  ])

  const result = runAuditSessions(home, dir, ['--days', '1'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /^- seeded prefixes unreadable, excluded from the counts \(the digest cannot tell inherited history from independent work\): broken-seed-01 \(seeded header without a tagged end-of-seed marker; the projection cache says 7 inherited events\)$/mu,
  )
  // Only the readable session's calls are counted.
  assert.match(result.stdout, /^- bash 2 calls;/mu)
  assert.match(result.stdout, /plain-child-01 d1 window 2 lifetime 2 inherited 0/u)
  assert.doesNotMatch(result.stdout, /broken-seed-01 d1/u, 'an unreadable seed prefix must not be listed as independent work')

  const evidence = JSON.parse(runAuditSessions(home, dir, ['--days', '1', '--json']).stdout)
  assert.deepEqual(evidence.sessions.unknownSeed, [
    { id: 'broken-seed-01', reason: 'seeded header without a tagged end-of-seed marker', projection: 7 },
  ])
  assert.deepEqual(evidence.sessions.largest.map((row) => row.id), ['plain-child-01'])
  assert.equal(evidence.sessions.toolCalls.find((row) => row.name === 'bash')?.count, 2)
})

test('the last tagged cut wins, so a fork of a fork does not count its inner interval as work', () => {
  const dir = audit('nested-seed')
  const { home, bucket } = sessionAuditFixtures()
  const now = Date.now()
  // Two tagged cuts (a fork of a fork) and one untagged restore boundary: only
  // the last tagged cut is the session's seed boundary, and the interval between
  // the tagged cuts is still inherited history.
  writeSessionFixture(bucket, 'nested-seed-01', [
    headerLine('nested-seed-01', { seeded: true, depth: 2 }),
    call(0, 'bash', now),
    { seq: 1, time: now, type: 'session/end-seed', data: { inherited: false } },
    call(2, 'bash', now),
    inheritedMarker(3, now),
    call(4, 'bash', now),
    inheritedMarker(5, now),
    call(6, 'bash', now),
    call(7, 'read', now),
  ])
  writeProjectionFixture(home, 'nested-seed-01', {
    formatVersion: 4,
    cwd: root,
    isSeeded: true,
    inheritedEventCount: 5,
  })

  const evidence = JSON.parse(runAuditSessions(home, dir, ['--days', '1', '--json']).stdout)
  const row = evidence.sessions.largest.find((candidate) => candidate.id === 'nested-seed-01')
  assert.ok(row, 'the seeded session must still appear in the eight largest')
  assert.deepEqual(
    { window: row.window, lifetime: row.lifetime, inherited: row.inherited, seed: row.seed },
    { window: 2, lifetime: 2, inherited: 3, seed: 'seeded' },
  )
  assert.deepEqual(evidence.sessions.inherited, { sessions: 1, tools: 3 })
})
