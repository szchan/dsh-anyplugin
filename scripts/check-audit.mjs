#!/usr/bin/env node
// The audit is a mechanism too, so it gets a gate (docs/AUDIT.md §9).
//
// The ledger is the part of the audit that can rot silently: a finding can name
// a file that was deleted, a status can claim `enforced` with no proof, or an
// `open` finding can lose the issue that tracks it. Those are cheap to check and
// expensive to discover a month later, so `verify` checks them.
//
// What this does NOT check: whether the mechanism actually works. That is the
// independent reviewer's job (docs/AUDIT.md §6), because a script can only see
// that a test file exists, not that the test proves the promised contract.
//
//   node scripts/check-audit.mjs
//   node scripts/check-audit.mjs --json
//   node scripts/check-audit.mjs --root <dir>   # tests use a throwaway root
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
if (rootFlag >= 0 && argv[rootFlag + 1] === undefined) {
  console.error('audit: --root needs a directory')
  process.exit(1)
}
const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1]) : resolve(fileURLToPath(new URL('..', import.meta.url)))
const auditPath = join(root, 'docs', 'AUDIT.md')
const reportsDir = join(root, 'docs', 'audits')
const asJson = argv.includes('--json')
const update = argv.includes('--update')

const MECHANISMS = new Set(['hook', 'ci', 'lint', 'skill', 'reviewer', 'docs', 'schedule'])
// The ledger vocabulary in docs/AUDIT.md §11. `documented` was retired by D88:
// prose is not an action, so a sentence is not a status.
const STATUSES = new Set(['enforced', 'reviewed', 'dormant', 'open', 'retired', 'accepted'])
// The statuses a deferred finding can hold. With `open` and `dormant`, an
// `accepted` risk is a promise to re-decide it on `reviewBy`, so every report's
// ## Open carries it and the next pass sees it without reading the ledger.
const DEFERRED = new Set(['open', 'dormant', 'accepted'])
const MACHINE = new Set(['hook', 'ci', 'lint'])
const REQUIRED = ['id', 'title', 'mechanism', 'status', 'artifact', 'rationale']
const SECTIONS = ['## Evidence', '## Findings', '## Actions', '## Open']

const problems = []
const fail = (message) => problems.push(message)
const isFile = (path) => {
  try {
    return statSync(join(root, path)).isFile()
  } catch {
    return false
  }
}
// An accepted risk is a date, not a phrase: the next pass comes back on
// `reviewBy`, so "soon" is not usable and "2026-02-31" is not a calendar day
// even though Date.parse would roll it into March.
const isIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

if (!existsSync(auditPath)) {
  console.error('audit: docs/AUDIT.md is missing')
  process.exit(1)
}
const audit = readFileSync(auditPath, 'utf8')
const block = audit.match(/<!-- audit-ledger:start -->\s*```json\n([\s\S]*?)\n```\s*<!-- audit-ledger:end -->/u)
if (block === null) {
  console.error('audit: docs/AUDIT.md has no <!-- audit-ledger:start --> JSON block')
  process.exit(1)
}
let ledger
try {
  ledger = JSON.parse(block[1])
} catch (error) {
  console.error(`audit: ledger is not JSON: ${String(error).slice(0, 300)}`)
  process.exit(1)
}
if (ledger.version !== 1) fail(`ledger version must be 1, got ${String(ledger.version)}`)
if (typeof ledger.updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(ledger.updated)) {
  fail('ledger needs updated: YYYY-MM-DD')
} else if (Number.isNaN(Date.parse(`${ledger.updated}T00:00:00Z`))) {
  fail(`ledger updated is not a date: ${ledger.updated}`)
}
if (!Array.isArray(ledger.entries) || ledger.entries.length === 0) fail('ledger has no entries')

const ids = new Set()
const known = new Set()
const statusById = new Map()
for (const entry of ledger.entries ?? []) {
  const where = `ledger ${entry.id ?? '(no id)'}`
  for (const field of REQUIRED) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') fail(`${where}: missing ${field}`)
  }
  // F1 and F01 are the same finding to a reader and different to Set, so the
  // grammar is exact: no leading zero, no separator.
  if (!/^F[1-9]\d*$/u.test(entry.id ?? '')) fail(`${where}: id must match F<number> with no leading zero`)
  if (ids.has(entry.id)) fail(`${where}: duplicate id`)
  ids.add(entry.id)
  known.add(entry.id)
  statusById.set(entry.id, entry.status)
  if (!MECHANISMS.has(entry.mechanism)) fail(`${where}: unknown mechanism ${String(entry.mechanism)}`)
  // Say why `documented` is refused instead of the generic unknown-status line:
  // it was a status once, so it is the spelling a pass is most likely to reach
  // for, and the correction is in §11 (owner + reviewBy, or open + tracking).
  if (entry.status === 'documented') {
    fail(`${where}: status documented is retired by docs/AUDIT.md §11 (D88): prose only is not an action; use accepted with owner and reviewBy, or open with a tracking issue`)
  } else if (!STATUSES.has(entry.status)) {
    fail(`${where}: unknown status ${String(entry.status)}`)
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) fail(`${where}: evidence must be a non-empty array`)
  if (entry.mechanism === 'docs' && entry.status === 'enforced') fail(`${where}: docs cannot enforce; use hook/ci/lint`)

  // A path in a ledger is a promise that the artifact still exists. Strip the
  // optional `#anchor` first: an anchor names a section, not a second file.
  const artifact = String(entry.artifact ?? '').split('#')[0]
  if (artifact !== '' && !isFile(artifact)) fail(`${where}: artifact is not a file: ${entry.artifact}`)
  if (entry.proof !== undefined) {
    if (typeof entry.proof !== 'string' || entry.proof.trim() === '') {
      fail(`${where}: proof must be a file path`)
    } else {
      const proof = entry.proof.split('#')[0]
      if (!isFile(proof)) fail(`${where}: proof is not a file: ${entry.proof}`)
      // The artifact cannot prove itself: the point of `proof` is a second
      // observation (a test, a hook, a log), not the same paragraph repeated.
      if (proof === artifact) fail(`${where}: proof must differ from artifact`)
    }
  }
  const machineProof = entry.status === 'enforced' || entry.status === 'dormant'
  if (machineProof && entry.proof === undefined) fail(`${where}: status ${entry.status} needs a proof file`)
  if (machineProof && entry.proof !== undefined && !/\.test\.mjs$/u.test(String(entry.proof).split('#')[0])) {
    fail(`${where}: proof must be a .test.mjs file, not ${entry.proof}`)
  }
  if (machineProof && !MACHINE.has(entry.mechanism)) {
    fail(`${where}: ${entry.status} needs a machine mechanism (hook/ci/lint), not ${entry.mechanism}`)
  }
  if (entry.status === 'open' && !/#\d+|https?:\/\//u.test(String(entry.tracking ?? ''))) {
    fail(`${where}: status open needs tracking (#issue or URL)`)
  }
  // `accepted` is a decision with an owner and a date, not a sentence. An entry
  // that says "known" without either is `open` with a tracking issue or nothing.
  if (entry.status === 'accepted') {
    if (typeof entry.owner !== 'string' || entry.owner.trim() === '') fail(`${where}: status accepted needs an owner`)
    if (typeof entry.reviewBy !== 'string' || entry.reviewBy.trim() === '') {
      fail(`${where}: status accepted needs a reviewBy date`)
    } else if (!isIsoDate(entry.reviewBy)) {
      fail(`${where}: status accepted needs reviewBy as a YYYY-MM-DD date, not ${String(entry.reviewBy)}`)
    }
  }
}

// The ledger is append-only. A deleted finding is how a recurring mistake
// quietly leaves the process: the report that named it still exists, but the
// next pass no longer sees it. The lock pins the identity fields of every
// finding; status and rationale may move, but a new finding needs --update and
// an existing one is retired, not renamed.
const hashEntry = (entry) =>
  createHash('sha256').update(JSON.stringify([entry.id, entry.title, entry.mechanism, entry.artifact])).digest('hex')
const lockPath = join(root, 'docs', 'audit.lock.json')
let lock = null
if (existsSync(lockPath)) {
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (error) {
    fail(`docs/audit.lock.json is not JSON: ${String(error).slice(0, 200)}`)
  }
}
if (lock !== null && lock.version !== 1) fail('docs/audit.lock.json version must be 1')
const locked = lock?.entries ?? {}
if (update) {
  if (problems.length > 0) {
    for (const problem of problems) console.error(`audit: ${problem}`)
    console.error('audit: refusing --update while the ledger has errors')
    process.exit(1)
  }
  for (const [id, hash] of Object.entries(locked)) {
    const entry = ledger.entries.find((candidate) => candidate.id === id)
    if (entry === undefined) {
      console.error(`audit: refusing --update: ${id} is locked but missing from the ledger`)
      process.exit(1)
    }
    if (hashEntry(entry) !== hash) {
      console.error(`audit: refusing --update: ${id} changed its title/mechanism/artifact; retire it and add a new finding`)
      process.exit(1)
    }
  }
  const entries = { ...locked }
  for (const entry of ledger.entries) entries[entry.id] = hashEntry(entry)
  const sorted = Object.fromEntries(Object.keys(entries).sort((a, b) => a.localeCompare(b, 'en')).map((id) => [id, entries[id]]))
  writeFileSync(lockPath, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`)
  console.log(`audit: lock updated (${Object.keys(sorted).length} findings)`)
} else if (lock === null) {
  fail('docs/audit.lock.json is missing; run check-audit --update')
} else {
  for (const [id, hash] of Object.entries(locked)) {
    const entry = ledger.entries.find((candidate) => candidate.id === id)
    if (entry === undefined) {
      fail(`${id} is locked but missing from the ledger; findings are retired, not deleted`)
    } else if (hashEntry(entry) !== hash) {
      fail(`${id} changed its title/mechanism/artifact; retire it and add a new finding, then --update`)
    }
  }
  for (const entry of ledger.entries) {
    if (locked[entry.id] === undefined) fail(`${entry.id} is new; run check-audit --update`)
  }
}

// Reports are the audit's output. Required sections keep them comparable across
// days; a report that only says "looked fine" is not an audit. The date prefix
// is `YYYY-MM-DD.md` or `rig-YYYY-MM-DD.md` (docs/AUDIT.md §8).
let reports = []
if (!existsSync(reportsDir)) {
  fail('docs/audits/ is missing')
} else {
  try {
    reports = readdirSync(reportsDir)
      .filter((name) => /^(?:rig-)?\d{4}-\d{2}-\d{2}\.md$/u.test(name))
      .sort((a, b) => a.replace(/^rig-/u, '').localeCompare(b.replace(/^rig-/u, '')))
  } catch (error) {
    fail(`docs/audits/ cannot be read: ${String(error).slice(0, 200)}`)
  }
  if (reports.length === 0) fail('docs/audits/ has no YYYY-MM-DD.md report')

  for (const report of reports) {
    const text = readFileSync(join(reportsDir, report), 'utf8')
    const lines = text.split('\n')
    // Headings inside a fenced example are not sections, and a heading with no
    // body is a promise the report did not keep.
    let fenced = false
    const sections = new Map()
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (line.startsWith('```')) fenced = !fenced
      if (!fenced && SECTIONS.includes(line)) sections.set(line, index)
    }
    for (const section of SECTIONS) {
      if (!sections.has(section)) {
        fail(`docs/audits/${report}: missing section ${section}`)
        continue
      }
      const start = sections.get(section) + 1
      let end = lines.length
      for (let index = start; index < lines.length; index += 1) {
        if (lines[index].startsWith('## ')) {
          end = index
          break
        }
      }
      if (lines.slice(start, end).every((line) => line.trim() === '')) {
        fail(`docs/audits/${report}: section ${section} has no body`)
      }
    }
    // Every finding id in a report must exist in the ledger, or it is a finding
    // that no future audit will see. `F-1` is not a synonym for `F1`.
    for (const match of text.matchAll(/\bF-?\d+\b/gu)) {
      if (!known.has(match[0])) fail(`docs/audits/${report}: ${match[0]} is not in the ledger`)
    }
    // ## Open is the next pass's checklist. A reviewed finding in that list
    // sends the next pass after work that is not deferred, and an open,
    // dormant or accepted finding missing from it is never picked up.
    const openStart = sections.get('## Open')
    if (openStart !== undefined) {
      let openEnd = lines.length
      for (let index = openStart + 1; index < lines.length; index += 1) {
        if (lines[index].startsWith('## ')) {
          openEnd = index
          break
        }
      }
      const openBody = lines.slice(openStart + 1, openEnd).join('\n')
      const inOpen = new Set([...openBody.matchAll(/\bF-?\d+\b/gu)].map((match) => match[0]))
      for (const id of inOpen) {
        const status = statusById.get(id)
        if (status !== undefined && !DEFERRED.has(status)) {
          fail(`docs/audits/${report}: ${id} is in ## Open but its ledger status is ${status}`)
        }
      }
      for (const entry of ledger.entries) {
        if (DEFERRED.has(entry.status) && !inOpen.has(entry.id)) {
          fail(`docs/audits/${report}: ${entry.id} is ${entry.status} but missing from ## Open`)
        }
      }
    }
  }
  const latest = reports.at(-1)
  if (latest !== undefined) {
    const date = latest.match(/\d{4}-\d{2}-\d{2}/u)[0]
    if (date > new Date().toISOString().slice(0, 10)) fail(`docs/audits/${latest}: report date is in the future`)
    if (typeof ledger.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(ledger.updated) && ledger.updated < date) {
      fail(`ledger updated ${ledger.updated} is older than the latest report ${date}`)
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`audit: ${problem}`)
  process.exit(1)
}
const latest = reports.at(-1) ?? null
if (asJson) console.log(JSON.stringify({ entries: ledger.entries.length, reports: reports.length, latest }))
else console.log(`audit: ${ledger.entries.length} ledger entries, ${reports.length} reports`)
