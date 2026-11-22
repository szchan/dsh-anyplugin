// F16: the guard's denials must be visible to the audit as data, not as prose
// in a tool result. These tests drive the real `apply` mount, so the fields the
// audit reads are the fields the guard writes; a stub recorder would not catch
// a payload drift between `index.ts` and `denials.ts`.
//
// The matrix is deliberately hermetic: every test that denies installs its own
// scratch `DSH_ANYPLUGIN_AUDIT_DIR`, so a test run leaves an external audit
// directory untouched (0 lines). A real denial under the override writes 1 —
// `brief-live.test.mjs` and `scripts/audit-evidence.test.mjs` exercise that.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { mainCheckout as auditMainCheckout } from '../../../scripts/audit-checkout.mjs'
import { apply } from '../src/index.ts'
import { denialFile, denialSubject, recordDenial, redactSubject } from '../src/denials.ts'

const repo = '/work/repo'
const worktree = '/work/wt/ticket-164'
const config = { worktrees: [worktree], protectedRoots: [repo] }

const worker = {
  session: { header: { id: 'worker-164', cwd: repo, origin: 'subagent', parentSession: 'root-1' } },
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

/** A fresh directory per test; the env is read at write time, not import time. */
function auditDirectory(name) {
  const dir = mkdtempSync(join(tmpdir(), `guard-denials-${name}-`))
  process.env.DSH_ANYPLUGIN_AUDIT_DIR = dir
  return dir
}

function lines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
}

const accept = async () => ({ kind: 'accept' })

test('a denied call appends exactly one JSONL record with the fields the audit reads', async () => {
  const dir = auditDirectory('deny')
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const exec = { callId: 701, name: 'bash', arguments: { command: 'git push origin main' }, agent: worker }
  const denied = await listeners.get('tools/pre-execute')[0](exec, accept)
  assert.equal(denied.kind, 'deny')

  const file = join(dir, 'guard-denials.jsonl')
  const rows = lines(file)
  assert.equal(rows.length, 1, 'one denial is one line')
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'), 'the record is newline-terminated')
  const record = JSON.parse(rows[0])
  assert.deepEqual(Object.keys(record), ['ts', 'role', 'rule', 'tool', 'cwd', 'worktree', 'session', 'subject'])
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  assert.equal(record.role, 'worker')
  assert.equal(record.rule, 'git-push-main')
  assert.equal(record.tool, 'bash')
  assert.equal(record.cwd, repo)
  assert.equal(record.worktree, null, 'no brief has recorded a worktree yet')
  assert.equal(record.session, 'worker-164')
  assert.equal(record.subject, 'git push origin main')
  assert.equal(record.arguments, undefined, 'the arguments blob is never serialized')
})

test('an allowed call writes nothing', async () => {
  const dir = auditDirectory('allow')
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const result = await listeners.get('tools/pre-execute')[0](
    { callId: 702, name: 'bash', arguments: { command: 'npm run verify' }, agent: worker },
    accept,
  )
  assert.equal(result.kind, 'accept')
  assert.equal(existsSync(join(dir, 'guard-denials.jsonl')), false)
})

test('the same callId seen by two app-level plugin loads produces one record', async () => {
  const dir = auditDirectory('mount')
  const first = harness()
  const second = harness()
  await apply(first.ctx, config)
  await apply(second.ctx, config)
  const exec = { callId: 703, name: 'bash', arguments: { command: 'git push origin main' }, agent: worker }
  const left = await first.listeners.get('tools/pre-execute')[0](exec, accept)
  const right = await second.listeners.get('tools/pre-execute')[0](exec, accept)
  assert.equal(left.kind, 'deny')
  assert.equal(right.kind, 'deny')
  assert.equal(lines(join(dir, 'guard-denials.jsonl')).length, 1, 'two app-level plugin loads share the dedupe')
})

test('two sessions that share a callId remain two refusals', async () => {
  const dir = auditDirectory('sessions')
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const other = {
    session: { header: { id: 'worker-other', cwd: repo, origin: 'subagent', parentSession: 'root-1' } },
  }
  const call = (agent) => ({ callId: 708, name: 'bash', arguments: { command: 'git push origin main' }, agent })
  await listeners.get('tools/pre-execute')[0](call(worker), accept)
  await listeners.get('tools/pre-execute')[0](call(other), accept)
  const records = lines(join(dir, 'guard-denials.jsonl')).map((line) => JSON.parse(line))
  assert.equal(records.length, 2, 'dedupe is per session, not per callId alone')
  assert.deepEqual(
    records.map((record) => record.session),
    ['worker-164', 'worker-other'],
  )
})

test('a write denial records the judged path, not the patch body', async () => {
  const dir = auditDirectory('write')
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const patch = `*** Begin Patch\n*** Update File: ${join(repo, 'src/x.ts')}\n*** End Patch\n${'payload '.repeat(400)}`
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 704, name: 'apply_patch', arguments: { input: patch }, agent: worker },
    accept,
  )
  assert.equal(denied.kind, 'deny')
  const [record] = lines(join(dir, 'guard-denials.jsonl')).map((line) => JSON.parse(line))
  assert.equal(record.rule, 'write-outside-worktree')
  assert.equal(record.subject, join(repo, 'src/x.ts'))
  assert.ok(!record.subject.includes('payload'))
})

test('an unwritable audit directory leaves the verdict intact and reports once', async () => {
  const blocked = mkdtempSync(join(tmpdir(), 'guard-denials-blocked-'))
  writeFileSync(join(blocked, 'not-a-directory'), 'x')
  process.env.DSH_ANYPLUGIN_AUDIT_DIR = join(blocked, 'not-a-directory')
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const first = await listeners.get('tools/pre-execute')[0](
      { callId: 705, name: 'bash', arguments: { command: 'git push origin main' }, agent: worker },
      accept,
    )
    const second = await listeners.get('tools/pre-execute')[0](
      { callId: 706, name: 'bash', arguments: { command: 'gh pr merge 82 --squash' }, agent: worker },
      accept,
    )
    assert.equal(first.kind, 'deny', 'the write failure never changes the verdict')
    assert.equal(second.kind, 'deny')
    assert.equal(first.reason, 'anyplugin-guard: refusing "git push origin main": it writes main; agents never push to main, they open a PR (rule git-push-main)')
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1, 'one warning per process, not one per denial')
  assert.match(errors[0], /denial log write failed/u)
  assert.match(errors[0], /verdict is unchanged/u)
})

test('a FIFO at the log path is refused without blocking the guard', { timeout: 5_000 }, () => {
  const dir = auditDirectory('fifo')
  const fifo = join(dir, 'guard-denials.jsonl')
  execFileSync('mkfifo', [fifo])
  const record = recordDenial({ callId: 'fifo-1', role: 'root', rule: 'sudo-refused', tool: 'bash', subject: 'sudo rm -rf /' })
  assert.equal(record, undefined)
  assert.equal(statSync(fifo).size, 0, 'nothing was written through the FIFO')
})

test('a symlinked log is refused and the target is not written through', () => {
  const dir = auditDirectory('symlink')
  const target = mkdtempSync(join(tmpdir(), 'guard-denials-target-'))
  const real = join(target, 'guard-denials.jsonl')
  writeFileSync(real, 'sentinel\n')
  symlinkSync(real, join(dir, 'guard-denials.jsonl'))
  const record = recordDenial({ callId: 'symlink-1', role: 'root', rule: 'sudo-refused', tool: 'bash', subject: 'sudo true' })
  assert.equal(record, undefined)
  assert.equal(readFileSync(real, 'utf8'), 'sentinel\n', 'the write did not follow the link')
})

test('the written line is redacted even when it is also capped (mutation C)', () => {
  const dir = auditDirectory('written-redaction')
  const token = `ghp_${'Z'.repeat(36)}`
  const record = recordDenial({
    callId: 'written-1',
    role: 'root',
    rule: 'shell-unmodelled',
    tool: 'bash',
    subject: `curl -H "Authorization: Bearer ${'q'.repeat(20)}" --token=${token} ${'w'.repeat(400)}`,
  })
  assert.ok(record !== undefined)
  const [line] = readFileSync(join(dir, 'guard-denials.jsonl'), 'utf8').split('\n')
  assert.ok(!line.includes('ghp_'), 'no token prefix reaches the file')
  assert.ok(!line.includes('Z'.repeat(36)), 'no token body reaches the file')
  assert.ok(!line.includes('q'.repeat(20)), 'no bearer body reaches the file')
  assert.match(line, /\[redacted\]/u)
})

test('the recorded subject is capped at ~300 characters', () => {
  const dir = auditDirectory('cap')
  const long = `git push origin ${'plain '.repeat(100)}`
  const record = recordDenial({ callId: 707, role: 'root', rule: 'git-push-shape', tool: 'bash', subject: long })
  assert.ok(record !== undefined)
  assert.equal(record.subject.length, 300)
  assert.match(record.subject, /…$/u)
  assert.equal(lines(join(dir, 'guard-denials.jsonl')).length, 1)
})

test('a base64url blob straddling the cap cannot leak its tail', () => {
  const dir = auditDirectory('base64url')
  // 290 filler chars, then a 41-char run that only the full class matches: the
  // 10 `A`s and the 30 `B`s are each below the 32-char threshold, so dropping
  // `-_` from the class leaves the blob untouched and this test goes red.
  const secret = `${'w '.repeat(145)}${'A'.repeat(10)}-${'B'.repeat(30)}`
  const record = recordDenial({
    callId: 'b64url-1',
    role: 'root',
    rule: 'shell-unmodelled',
    tool: 'bash',
    subject: secret,
  })
  assert.ok(record !== undefined)
  assert.equal(record.subject.length, 300)
  assert.ok(record.subject.endsWith('[redacted]'), 'the whole run is replaced, not clipped mid-token')
  assert.doesNotMatch(record.subject, /[AB]/u, 'neither segment of the blob reaches the record')
  const [line] = readFileSync(join(dir, 'guard-denials.jsonl'), 'utf8').split('\n')
  assert.ok(!line.includes('B'), 'nothing of the tail reaches the file')
})

test('redaction removes every token shape and keeps ordinary commands', () => {
  const shapes = [
    [`ghp_${'A'.repeat(36)}`, /ghp_[A]/u],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', /github_pat_/u],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz', /sk-/u],
    ['xsk-proj-abcdefghijklmnopqrstuvwxyz', /xsk-/u],
    ['Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature', /Bearer\s+eyJ/u],
    ['Authorization: Basic dXNlcjpwYXNz', /Basic\s+dXNl/u],
    ['--token=shhh-this-is-a-secret', /shhh-this-is-a-secret/u],
    ['--token shhh-this-is-a-secret', /shhh-this-is-a-secret/u],
    ['--token="unterminated-secret', /unterminated-secret/u],
    ['f'.repeat(64), /f{32,}/u],
    ['QUJD'.repeat(12), /QUJD/u],
    [`${'g'.repeat(280)}-${'B'.repeat(30)}`, /g{30}/u],
  ]
  for (const [raw, leaked] of shapes) {
    const clean = redactSubject(`export VALUE=${raw}`)
    assert.doesNotMatch(clean, leaked, raw)
    assert.match(clean, /\[redacted\]/u, raw)
  }
  assert.equal(redactSubject('git push origin main'), 'git push origin main')
  assert.equal(redactSubject(`${worktree}/src/a.ts`), `${worktree}/src/a.ts`)
  assert.equal(redactSubject('risk-averse'), 'risk-averse', 'a word that merely contains sk- is not a token')
  assert.match(redactSubject(`checkout ${'c'.repeat(40)}`), /\[redacted\]/u, 'a 40-hex sha is redacted too')
})

test('the default log follows the checkout in every layout, and the override still wins', () => {
  const main = mkdtempSync(join(tmpdir(), 'guard-denials-main-'))
  execFileSync('git', ['init', '-q', '-b', 'main', main])
  writeFileSync(join(main, 'a.txt'), 'a\n')
  execFileSync('git', ['-C', main, 'add', 'a.txt'])
  execFileSync('git', ['-C', main, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'init'])
  const linked = join(mkdtempSync(join(tmpdir(), 'guard-denials-wt-')), 'wt')
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'ticket/164-test', linked])

  const separatedBase = mkdtempSync(join(tmpdir(), 'guard-denials-separated-'))
  const separated = join(separatedBase, 'checkout')
  execFileSync('git', [
    'init',
    '-q',
    '-b',
    'main',
    `--separate-git-dir=${join(separatedBase, 'gitdir')}`,
    separated,
  ])

  const child = mkdtempSync(join(tmpdir(), 'guard-denials-child-'))
  execFileSync('git', ['init', '-q', '-b', 'main', child])
  writeFileSync(join(child, 'c.txt'), 'c\n')
  execFileSync('git', ['-C', child, 'add', 'c.txt'])
  execFileSync('git', ['-C', child, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'child'])
  const superproject = mkdtempSync(join(tmpdir(), 'guard-denials-super-'))
  execFileSync('git', ['init', '-q', '-b', 'main', superproject])
  writeFileSync(join(superproject, 'p.txt'), 'p\n')
  execFileSync('git', ['-C', superproject, 'add', 'p.txt'])
  execFileSync('git', [
    '-C',
    superproject,
    '-c',
    'user.email=a@b.c',
    '-c',
    'user.name=a',
    'commit',
    '-qm',
    'super',
  ])
  execFileSync('git', [
    '-C',
    superproject,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    child,
    'sub',
  ])
  const submodule = join(superproject, 'sub')

  for (const [label, path, expected] of [
    ['main checkout', main, main],
    ['linked worktree', linked, main],
    ['separate git dir', separated, separated],
    ['submodule', submodule, submodule],
  ]) {
    assert.equal(auditMainCheckout(path), expected, `${label}: the audit reader names the checkout that owns .git`)
    assert.equal(dirname(denialFile({}, path)), join(expected, '.audit'), `${label}: the guard writer names its .audit`)
    assert.equal(
      dirname(denialFile({}, path)),
      join(auditMainCheckout(path), '.audit'),
      `${label}: the reader and the writer agree`,
    )
  }

  assert.equal(
    denialFile({ DSH_ANYPLUGIN_AUDIT_DIR: join(main, 'scratch') }, linked),
    join(main, 'scratch', 'guard-denials.jsonl'),
    'the override wins over the repository derivation',
  )
})

test('denialSubject extracts the command or write target and ignores everything else', () => {
  assert.equal(denialSubject('bash', { command: 'git push origin main', workdir: repo }), 'git push origin main')
  assert.equal(denialSubject('bash', { cmd: 'git status' }), 'git status')
  assert.equal(denialSubject('write', { file_path: `${worktree}/a.ts`, content: 'x' }), `${worktree}/a.ts`)
  assert.equal(denialSubject('apply_patch', { input: `*** Add File: ${worktree}/b.ts\n+hello` }), `${worktree}/b.ts`)
  assert.equal(denialSubject('bash', undefined), '')
})
