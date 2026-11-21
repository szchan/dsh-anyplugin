#!/usr/bin/env node
// Decisions are append-only (docs/DECISIONS.md, D27 and the workflow rubric).
//
// Twice now a worker edited a ratified entry in place — D9 was rewritten by the
// harness PR, and the reviewer caught it only by hashing the section by hand.
// This check makes that review step a machine rule: every entry's body is hashed
// into docs/decisions.lock.json, and a change to a ratified entry fails the gate.
// Creating a new decision (or appending "Superseded by D<n>" as a new entry) is
// the only sanctioned way to move a ratified decision.
//
//   node scripts/check-decisions.mjs            # verify
//   node scripts/check-decisions.mjs --update   # accept new entries only
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const decisionsPath = join(root, 'docs', 'DECISIONS.md')
const lockPath = join(root, 'docs', 'decisions.lock.json')
const update = process.argv.includes('--update')

const text = readFileSync(decisionsPath, 'utf8')
const heading = /^## (D\d+) — (.+)$/gmu
const entries = []
let current = null
for (const line of text.split('\n')) {
  const match = line.match(/^## (D\d+) — (.+)$/u)
  if (match !== null) {
    if (current !== null) entries.push(current)
    current = { id: match[1], title: match[2].trim(), lines: [] }
    continue
  }
  if (current !== null) current.lines.push(line)
}
if (current !== null) entries.push(current)

if (entries.length === 0) {
  console.error('decisions: no entries found')
  process.exit(1)
}

const digest = (entry) =>
  createHash('sha256')
    .update(`${entry.title}\n${entry.lines.join('\n').replace(/\s+$/u, '')}`)
    .digest('hex')

const currentHashes = Object.fromEntries(entries.map((entry) => [entry.id, digest(entry)]))
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { schema: 'dsh-anyplugin/decisions@1', entries: {} }

if (update) {
  // Only additions are accepted; a changed hash is exactly what this rule forbids.
  const changed = Object.keys(lock.entries ?? {}).filter((id) => currentHashes[id] !== lock.entries[id])
  if (changed.length > 0) {
    console.error(`decisions: refusing to rewrite ratified entries: ${changed.join(', ')}`)
    console.error('decisions: supersede with a new entry instead')
    process.exit(1)
  }
  const next = { ...lock, entries: { ...lock.entries, ...currentHashes } }
  writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`decisions: locked ${entries.length} entries`)
  process.exit(0)
}

const problems = []
for (const [id, hash] of Object.entries(lock.entries ?? {})) {
  if (currentHashes[id] === undefined) problems.push(`${id} disappeared from DECISIONS.md`)
  else if (currentHashes[id] !== hash) problems.push(`${id} was edited in place (supersede it with a new entry instead)`)
}
for (const id of Object.keys(currentHashes)) {
  if ((lock.entries ?? {})[id] === undefined) problems.push(`${id} is new; run scripts/check-decisions.mjs --update to ratify it`)
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`decisions: ${problem}`)
  process.exit(1)
}
console.log(`decisions: ${entries.length} entries append-only`)
