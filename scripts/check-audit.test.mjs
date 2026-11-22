// The audit gate is what keeps the ledger from becoming a diary: a deleted
// artifact, an unprovable `enforced`, or an unreadable report must fail. Each
// case below is a way the first version passed something it should have refused.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-audit.mjs', import.meta.url))
const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const report = `# audit 2026-11-22

## Evidence

evidence body

## Findings

F1 is the only finding.

## Actions

action body

## Open

nothing open
`

const baseEntry = (overrides = {}) => ({
  id: 'F1',
  title: 'a finding',
  mechanism: 'ci',
  status: 'enforced',
  artifact: 'gate.mjs',
  proof: 'gate.test.mjs',
  rationale: 'because',
  evidence: ['evidence'],
  ...overrides,
})

function makeRoot(entries, { updated = '2026-11-22', reports = { '2026-11-22.md': report } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'audit-gate-'))
  roots.push(root)
  mkdirSync(join(root, 'docs', 'audits'), { recursive: true })
  writeFileSync(join(root, 'gate.mjs'), '// gate\n')
  writeFileSync(join(root, 'gate.test.mjs'), '// test\n')
  writeFileSync(join(root, 'other.mjs'), '// other\n')
  const ledger = { version: 1, updated, entries }
  writeFileSync(
    join(root, 'docs', 'AUDIT.md'),
    `# Audit\n\n<!-- audit-ledger:start -->\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\`\n<!-- audit-ledger:end -->\n`,
  )
  for (const [name, text] of Object.entries(reports)) writeFileSync(join(root, 'docs', 'audits', name), text)
  return root
}

function run(root, ...args) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' })
}

test('a well-formed ledger and report pass', () => {
  const result = run(makeRoot([baseEntry()]))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /1 ledger entries, 1 reports/)
})

test('an empty proof is not a path', () => {
  const result = run(makeRoot([baseEntry({ proof: '' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /proof must be a file path|missing proof/)
})

test('a directory is not a proof file', () => {
  const result = run(makeRoot([baseEntry({ proof: 'docs' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /proof is not a file: docs/)
})

test('a skill cannot be enforced', () => {
  const result = run(makeRoot([baseEntry({ mechanism: 'skill' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /enforced needs a machine mechanism/)
})

test('proof must be a second observation, not the artifact', () => {
  const result = run(makeRoot([baseEntry({ proof: 'gate.mjs' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /proof must differ from artifact/)
})

test('F01 is not F1', () => {
  const result = run(makeRoot([baseEntry({ id: 'F01' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /id must match F<number> with no leading zero/)
})

test('open needs a tracking issue', () => {
  const result = run(makeRoot([baseEntry({ status: 'open', proof: undefined })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /status open needs tracking/)
})

test('duplicate ids fail', () => {
  const result = run(makeRoot([baseEntry(), baseEntry()]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /duplicate id/)
})

test('a section inside a fence is not a section', () => {
  const text = report.replace('## Evidence\n\nevidence body', '```md\n## Evidence\n```\n\nfenced, not a section')
  const result = run(makeRoot([baseEntry()], { reports: { '2026-11-22.md': text } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing section ## Evidence/)
})

test('a report id must be in the ledger', () => {
  const result = run(makeRoot([baseEntry()], { reports: { '2026-11-22.md': report.replace('F1 is', 'F-99 is') } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /F-99 is not in the ledger/)
})

test('updated cannot lag the latest report', () => {
  const result = run(makeRoot([baseEntry()], { updated: '2026-11-21' }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ledger updated 2026-11-21 is older/)
})

test('a rig- report is accepted', () => {
  const result = run(makeRoot([baseEntry()], { reports: { 'rig-2026-11-22.md': report } }))
  assert.equal(result.status, 0, result.stderr)
})

test('--root needs a directory', () => {
  const result = spawnSync(process.execPath, [script, '--root'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--root needs a directory/)
})
