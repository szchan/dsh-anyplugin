// R3 (no eval), R13 (no literal skip) and R14 (every fixture has an owner) are
// the architecture rules whose failure mode is a security or honesty claim, not
// a layout preference. They had no test: deleting the loop kept check:arch green
// on a clean tree. This drives each rule against a throwaway tree, so the message
// itself is the assertion. `--sources-only` stops before the repo-wide rules;
// R14 needs the full run.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-architecture.mjs', import.meta.url))
const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function makeRoot(source) {
  const root = mkdtempSync(join(tmpdir(), 'audit-arch-'))
  roots.push(root)
  mkdirSync(join(root, 'packages', 'dsh-anyplugin-ir', 'src'), { recursive: true })
  // R12 reads docs/ before the rule report is printed; an empty directory is
  // enough for a source-only probe.
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'packages', 'dsh-anyplugin-ir', 'src', 'index.ts'), source)
  return root
}

function run(root) {
  return spawnSync(process.execPath, [script, '--root', root, '--sources-only'], { encoding: 'utf8' })
}

function runFull(root) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
}

test('eval in a package source is R3', () => {
  const result = run(makeRoot('export const bad = eval("1")\n'))
  assert.equal(result.status, 1)
  assert.match(result.stdout, /R3 no-eval/)
})

test('a literal skip is R13', () => {
  const root = makeRoot('export const ok = 1\n')
  mkdirSync(join(root, 'packages', 'dsh-anyplugin-ir', 'test'), { recursive: true })
  writeFileSync(join(root, 'packages', 'dsh-anyplugin-ir', 'test', 'probe.test.mjs'), "test('x', { skip: true }, () => {})\n")
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /R13 skip-reason/)
})

test('a fixture directory with no row and no exclusion is R14', () => {
  const root = makeRoot('export const ok = 1\n')
  mkdirSync(join(root, 'fixtures', 'orphan'), { recursive: true })
  mkdirSync(join(root, 'packages', 'dsh-anyplugin-conformance', 'test'), { recursive: true })
  writeFileSync(
    join(root, 'packages', 'dsh-anyplugin-conformance', 'test', 'coverage.test.mjs'),
    'const EXPECTED_ROWS = {\n}\n',
  )
  const result = runFull(root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /R14 fixture-ratchet/)
  assert.match(result.stdout, /fixtures\/orphan has no EXPECTED_ROWS entry/)
})

test('--root needs a directory', () => {
  const result = spawnSync(process.execPath, [script, '--root'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--root needs a directory/)
})
