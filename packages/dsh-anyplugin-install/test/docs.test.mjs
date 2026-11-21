// The lock format is documented in two places (ARCHITECTURE §5 and D23). Those
// snippets are contracts, so parse them with the shipped reader: a format change
// that forgets the docs — or a doc edit the reader would reject — fails here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { INSTALLS_SCHEMA, parseInstalls } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const read = (file) => readFileSync(join(repoRoot, 'docs', file), 'utf8')

function installsSnippets(text) {
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes('"dsh-anyplugin/installs@'))
}

test('the ARCHITECTURE §5 and D23 examples parse with the shipped reader', () => {
  const arch = read('ARCHITECTURE.md')
  const decisions = read('DECISIONS.md')
  assert.match(decisions, /^## D23 — /m, 'the decision is numbered D23')

  const fromArch = installsSnippets(arch)
  const fromDecision = installsSnippets(decisions)
  assert.ok(fromArch.length >= 1, 'ARCHITECTURE documents installs.yml')
  assert.equal(fromDecision.length, 1, 'DECISIONS has exactly one installs.yml snippet')
  for (const [index, snippet] of fromArch.entries()) {
    // Every architecture snippet must be readable; the mods example is a second
    // record shape on purpose, not a stray block.
    parseInstalls(snippet, `ARCHITECTURE.md snippet ${index + 1}`)
  }
  const fromArchMods = fromArch.find((snippet) => snippet.includes('mods:'))
  assert.ok(fromArchMods === undefined || parseInstalls(fromArchMods, 'ARCHITECTURE.md mods').plugins[0].mods?.length === 1)

  const archLock = parseInstalls(fromArch[0], 'ARCHITECTURE.md')
  const decisionLock = parseInstalls(fromDecision[0], 'DECISIONS.md')
  assert.equal(archLock.schema, INSTALLS_SCHEMA, 'ARCHITECTURE shows the current schema')
  // D23 is append-only and still quotes the 0.1.0 schema; the reader accepts it
  // and normalizes to the current schema, so the two snippets compare equal
  // after parsing. ARCHITECTURE also demonstrates the optional marketplace
  // `source` line, which D23's ratified snippet does not carry.
  const required = archLock.plugins.map((record) => {
    const rest = { ...record }
    delete rest.source
    return rest
  })
  assert.deepEqual(decisionLock, { ...archLock, plugins: required }, 'both snippets describe the same required fields')
  assert.deepEqual(
    archLock.plugins.map((record) => record.source),
    [{ marketplace: 'my-marketplace', entry: 'skills-only' }],
    'ARCHITECTURE shows the optional source provenance line',
  )
  assert.match(fromArch[0], /"dsh-anyplugin\/installs@2"/, 'the architecture example is current')
  assert.match(fromDecision[0], /"dsh-anyplugin\/installs@1"/, 'D23 keeps the version it ratified')
  assert.deepEqual(
    archLock.plugins.map((record) => [record.dialect, record.name, record.pin]),
    [['claude-code', 'skills-only', 'claude-code@2.1.322']],
  )
})

test('the INSTALL.md lock example parses with the shipped reader', () => {
  const install = readFileSync(join(repoRoot, 'INSTALL.md'), 'utf8')
  const snippets = [...install.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes('"dsh-anyplugin/installs@'))
  assert.equal(snippets.length, 1, 'INSTALL documents exactly one lock example')
  const lock = parseInstalls(snippets[0], 'INSTALL.md')
  assert.equal(lock.schema, INSTALLS_SCHEMA)
  assert.equal(lock.plugins.length, 1)
  const mods = lock.plugins[0].mods ?? []
  assert.equal(mods.length, 1)
  assert.equal(mods[0].entry, 'hooks/register.ts')
  assert.equal(mods[0].files[0].path, 'hooks/register.ts')
  for (const file of mods[0].files) {
    assert.doesNotMatch(file.path, /^\//, 'tree paths are plugin-relative')
  }
})
