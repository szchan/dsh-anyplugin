// R15 lives in check-features: a count in the docs must agree with the test that
// owns it. The helper has counter-example tests, but deleting the call site in
// check-features left those green. This drives the gate against a throwaway
// FEATURES.md whose count has no owner, so the reported line is the assertion.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-features.mjs', import.meta.url))
const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'audit-features-'))
  roots.push(root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'packages', 'dsh-anyplugin-conformance', 'test'), { recursive: true })
  writeFileSync(
    join(root, 'packages', 'dsh-anyplugin-conformance', 'test', 'coverage.test.mjs'),
    'export const EXPECTED_COUNTS = {}\n',
  )
  writeFileSync(
    join(root, 'docs', 'FEATURES.md'),
    [
      '# Capabilities',
      '',
      '| capability | artifact |',
      '| --- | --- |',
      '| probe | probe |',
      '',
      'The ratchet is `packages/dsh-anyplugin-conformance/test/coverage.test.mjs`.',
      '',
      'Across 14 absent members.',
      '',
    ].join('\n'),
  )
  return root
}

function run(root) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
}

test('a count with no owning test is R15 at the gate call site', () => {
  const result = run(makeRoot())
  assert.equal(result.status, 1)
  assert.match(result.stderr, /features: FEATURES\.md:\d+: .*14 absent.*names no owner file/u)
})

test('--root needs a directory', () => {
  const result = spawnSync(process.execPath, [script, '--root'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /features: --root needs a directory/u)
})
