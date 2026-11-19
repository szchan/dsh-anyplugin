// The lock format is documented in two places (ARCHITECTURE §5 and D23). Those
// snippets are contracts, so parse them with the shipped reader: a format change
// that forgets the docs — or a doc edit the reader would reject — fails here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parseInstalls } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const read = (file) => readFileSync(join(repoRoot, 'docs', file), 'utf8')

function installsSnippets(text) {
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes('"dsh-anyplugin/installs@1"'))
}

test('the ARCHITECTURE §5 and D23 examples parse with the shipped reader', () => {
  const arch = read('ARCHITECTURE.md')
  const decisions = read('DECISIONS.md')
  assert.match(decisions, /^## D23 — /m, 'the decision is numbered D23')

  const fromArch = installsSnippets(arch)
  const fromDecision = installsSnippets(decisions)
  assert.equal(fromArch.length, 1, 'ARCHITECTURE has exactly one installs.yml snippet')
  assert.equal(fromDecision.length, 1, 'DECISIONS has exactly one installs.yml snippet')

  const archLock = parseInstalls(fromArch[0], 'ARCHITECTURE.md')
  const decisionLock = parseInstalls(fromDecision[0], 'DECISIONS.md')
  assert.deepEqual(decisionLock, archLock, 'both snippets describe the same lock')
  assert.equal(archLock.schema, 'dsh-anyplugin/installs@1')
  assert.deepEqual(
    archLock.plugins.map((record) => [record.dialect, record.name, record.pin]),
    [['claude-code', 'skills-only', 'claude-code@2.1.322']],
  )
})
