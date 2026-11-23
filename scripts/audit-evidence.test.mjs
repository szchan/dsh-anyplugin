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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply } from '../packages/dsh-anyplugin-guard/src/index.ts'

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
