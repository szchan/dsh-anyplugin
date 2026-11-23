// The decision gate is a rule agents rely on to catch an in-place edit or a
// duplicate id. A gate with no test can be defanged by a refactor and still
// print "append-only" on a clean tree, so each failure mode is exercised here
// against a throwaway root (`--root`). Audit finding F3/F4.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-decisions.mjs', import.meta.url))
const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function makeRoot(text) {
  const root = mkdtempSync(join(tmpdir(), 'audit-decisions-'))
  roots.push(root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'DECISIONS.md'), text)
  return root
}

function run(root, ...args) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' })
}

const two = '## D1 — First\nbody one\n\n## D2 — Second\nbody two\n'

test('locks new entries and then verifies them', () => {
  const root = makeRoot(two)
  const lock = run(root, '--update')
  assert.equal(lock.status, 0, lock.stderr)
  assert.match(lock.stdout, /locked 2 entries/)
  const verify = run(root)
  assert.equal(verify.status, 0, verify.stderr)
  assert.match(verify.stdout, /2 entries append-only/)
})

test('a duplicate id fails even when the lock would accept it', () => {
  const root = makeRoot(two)
  assert.equal(run(root, '--update').status, 0)
  writeFileSync(join(root, 'docs', 'DECISIONS.md'), `${two}\n## D2 — Second again\nbody two\n`)
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /duplicate ids: D2/)
  assert.match(result.stderr, /renumber before running --update/)
})

test('editing a ratified entry in place fails', () => {
  const root = makeRoot(two)
  assert.equal(run(root, '--update').status, 0)
  writeFileSync(join(root, 'docs', 'DECISIONS.md'), two.replace('body one', 'body one, edited'))
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /D1 was edited in place/)
})

test('a new entry needs --update before it verifies', () => {
  const root = makeRoot(two)
  assert.equal(run(root, '--update').status, 0)
  writeFileSync(join(root, 'docs', 'DECISIONS.md'), `${two}\n## D3 — Third\nbody three\n`)
  const before = run(root)
  assert.equal(before.status, 1)
  assert.match(before.stderr, /D3 is new/)
  assert.equal(run(root, '--update').status, 0)
  assert.equal(run(root).status, 0)
  const lock = JSON.parse(readFileSync(join(root, 'docs', 'decisions.lock.json'), 'utf8'))
  assert.equal(Object.keys(lock.entries).length, 3)
})

test('--root needs a directory', () => {
  const result = spawnSync(process.execPath, [script, '--root'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--root needs a directory/)
})

// The sanctioned writer exists because the installed guard refuses every hand
// write to docs/DECISIONS.md. It must be able to add an entry, reword one that
// origin/main does not carry yet, and refuse to touch a ratified one.
function makeRepo(text) {
  const root = makeRoot(text)
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  return { root, git }
}

const one = '## D1 — First\nbody one\n'
const payloadFor = (root, text) => {
  const payload = join(root, 'payload.md')
  writeFileSync(payload, text)
  return payload
}

test('--append-file adds one entry and the lock accepts it', () => {
  const { root } = makeRepo(one)
  assert.equal(run(root, '--update').status, 0)
  const payload = payloadFor(root, '## D2 — Second\nbody two\n')
  const result = run(root, '--append-file', payload)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /appended D2; locked 2 entries/)
  const verify = run(root)
  assert.equal(verify.status, 0, verify.stderr)
})

test('--append-file accepts a log whose entries end in a --- separator', () => {
  // The real log separates entries with ---. Without trimming that separator on
  // re-parse, every entry followed by another one looks changed and the writer
  // refuses a legitimate append (the D78 append hit exactly this).
  const separated = '## D1 — First\nbody one\n\n---\n\n## D2 — Second\nbody two\n\n---\n'
  const { root } = makeRepo(separated)
  assert.equal(run(root, '--update').status, 0)
  const payload = payloadFor(root, '## D3 — Third\nbody three\n')
  const result = run(root, '--append-file', payload)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /appended D3; locked 3 entries/)
})

test('--reword rewrites an entry origin/main does not carry', () => {
  const { root, git } = makeRepo(one)
  assert.equal(run(root, '--update').status, 0)
  const payload = payloadFor(root, '## D2 — Second\nbody two\n')
  assert.equal(run(root, '--append-file', payload).status, 0)
  git('add', '-A')
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'branch-local')
  const reworded = payloadFor(root, '## D2 — Second\nbody two, reworded\n')
  const result = run(root, '--reword', 'D2', '--file', reworded)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /reworded D2; locked 2 entries/)
  assert.equal(run(root).status, 0)
})

test('--reword refuses an entry origin/main already carries', () => {
  const { root } = makeRepo(one)
  assert.equal(run(root, '--update').status, 0)
  const payload = payloadFor(root, '## D1 — First\nbody one, rewritten\n')
  const result = run(root, '--reword', 'D1', '--file', payload)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /D1 is already on origin\/main; it is ratified/)
})
