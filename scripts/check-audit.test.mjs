// The audit gate is what keeps the ledger from becoming a diary: a deleted
// artifact, an unprovable `enforced`, or an unreadable report must fail. Each
// case below is a way the first version passed something it should have refused.
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const hashEntry = (entry) =>
  createHash('sha256').update(JSON.stringify([entry.id, entry.title, entry.mechanism, entry.artifact])).digest('hex')

function makeRoot(entries, { updated = '2026-11-22', reports = { '2026-11-22.md': report }, lockEntries = entries } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'audit-gate-'))
  roots.push(root)
  mkdirSync(join(root, 'docs', 'audits'), { recursive: true })
  writeFileSync(join(root, 'gate.mjs'), '// gate\n')
  writeFileSync(join(root, 'gate.test.mjs'), '// test\n')
  writeFileSync(join(root, 'other.mjs'), '// other\n')
  const ledger = { version: 1, updated, entries }
  const lock = Object.fromEntries(lockEntries.map((entry) => [entry.id, hashEntry(entry)]))
  writeFileSync(join(root, 'docs', 'audit.lock.json'), `${JSON.stringify({ version: 1, entries: lock }, null, 2)}\n`)
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

test('## Open may not list a reviewed finding', () => {
  const text = report.replace('nothing open', 'F1 is still here')
  const result = run(makeRoot([baseEntry({ status: 'reviewed' })], { reports: { '2026-11-22.md': text } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /F1 is in ## Open but its ledger status is reviewed/u)
})

test('## Open must list every open finding', () => {
  const result = run(makeRoot([baseEntry({ status: 'open', proof: undefined, tracking: '#1' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /F1 is open but missing from ## Open/u)
})

// `documented` was removed from the vocabulary by docs/AUDIT.md §11 (D88). The
// refusal has to name that, because "unknown status" would not tell a pass that
// the fix is an owner and a review date rather than a typo.
test('documented is refused with the §11 reason', () => {
  const result = run(makeRoot([baseEntry({ status: 'documented' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /documented is retired by docs\/AUDIT\.md §11/u)
})

test('an accepted risk needs an owner', () => {
  const entry = baseEntry({ status: 'accepted', proof: undefined, reviewBy: '2026-11-30' })
  const text = report.replace('nothing open', 'F1 is accepted.')
  const result = run(makeRoot([entry], { reports: { '2026-11-22.md': text } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /status accepted needs an owner/u)
})

test('an accepted risk needs a review date', () => {
  const entry = baseEntry({ status: 'accepted', proof: undefined, owner: 'the master' })
  const text = report.replace('nothing open', 'F1 is accepted.')
  const result = run(makeRoot([entry], { reports: { '2026-11-22.md': text } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /status accepted needs a reviewBy date/u)
})

test('a reviewBy phrase is not a date', () => {
  const entry = baseEntry({ status: 'accepted', proof: undefined, owner: 'the master', reviewBy: 'soon' })
  const text = report.replace('nothing open', 'F1 is accepted.')
  const result = run(makeRoot([entry], { reports: { '2026-11-22.md': text } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /reviewBy as a YYYY-MM-DD date/u)
})

test('a reviewBy cannot be a rolled-over calendar day', () => {
  const entry = baseEntry({ status: 'accepted', proof: undefined, owner: 'the master', reviewBy: '2026-02-31' })
  const text = report.replace('nothing open', 'F1 is accepted.')
  const result = run(makeRoot([entry], { reports: { '2026-11-22.md': text } }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /reviewBy as a YYYY-MM-DD date/u)
})

test('## Open may list an accepted finding', () => {
  const entry = baseEntry({ status: 'accepted', proof: undefined, owner: 'the master', reviewBy: '2026-11-30' })
  const text = report.replace('nothing open', 'F1 is accepted with a review date.')
  const result = run(makeRoot([entry], { reports: { '2026-11-22.md': text } }))
  assert.equal(result.status, 0, result.stderr)
})

test('## Open must list every accepted finding', () => {
  const entry = baseEntry({ status: 'accepted', proof: undefined, owner: 'the master', reviewBy: '2026-11-30' })
  const result = run(makeRoot([entry]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /F1 is accepted but missing from ## Open/u)
})

test('a dormant mechanism still has to be a machine mechanism', () => {
  const result = run(makeRoot([baseEntry({ status: 'dormant', mechanism: 'docs' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /dormant needs a machine mechanism/u)
})

test('a proof must be a test file, not any file', () => {
  const result = run(makeRoot([baseEntry({ proof: 'other.mjs' })]))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /proof must be a \.test\.mjs file/u)
})

test('a deleted finding is refused', () => {
  const first = baseEntry()
  const gone = baseEntry({ id: 'F2', title: 'a second finding' })
  const result = run(makeRoot([first], { lockEntries: [first, gone] }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /F2 is locked but missing/u)
})

test('a new finding needs --update', () => {
  const first = baseEntry()
  const second = baseEntry({ id: 'F2', title: 'a second finding' })
  const result = run(makeRoot([first, second], { lockEntries: [first] }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /F2 is new; run check-audit --update/u)
})

test('--update adds a new finding', () => {
  const first = baseEntry()
  const second = baseEntry({ id: 'F2', title: 'a second finding' })
  const root = makeRoot([first, second], { lockEntries: [first] })
  const updated = run(root, '--update')
  assert.equal(updated.status, 0, updated.stderr)
  const result = run(root)
  assert.equal(result.status, 0, result.stderr)
})

test('a finding cannot be renamed in place', () => {
  const first = baseEntry()
  const result = run(makeRoot([{ ...first, title: 'a different finding' }], { lockEntries: [first] }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /F1 changed its title\/mechanism\/artifact/u)
})

test('verify runs check:audit before the test suite', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const verify = pkg.scripts.verify
  assert.match(verify, /check:audit/u)
  assert.ok(verify.indexOf('check:audit') < verify.indexOf('npm test'), 'check:audit must run before npm test')
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
