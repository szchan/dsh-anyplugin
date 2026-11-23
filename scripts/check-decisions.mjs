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
//   node scripts/check-decisions.mjs                        # verify
//   node scripts/check-decisions.mjs --update               # accept new entries only
//   node scripts/check-decisions.mjs --append-file <path>   # sanctioned writer: append one entry
//   node scripts/check-decisions.mjs --reword D83 --file <path>
//                                                           # sanctioned writer: rewrite an entry
//                                                           # that is not yet on origin/main
//
// The last two exist because the guard refuses every hand write to this file
// (`decisions-append-only`): without a writer, nothing could record a decision
// after the guard is installed. Both refuse to touch an entry that origin/main
// already carries — ratification is what makes an entry historical.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
if (rootFlag >= 0 && argv[rootFlag + 1] === undefined) {
  console.error('decisions: --root needs a directory')
  process.exit(1)
}
const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1]) : fileURLToPath(new URL('..', import.meta.url))
const decisionsPath = join(root, 'docs', 'DECISIONS.md')
const lockPath = join(root, 'docs', 'decisions.lock.json')
const update = argv.includes('--update')

const text = readFileSync(decisionsPath, 'utf8')

function parseEntries(source) {
  const parsed = []
  let current = null
  for (const line of source.split('\n')) {
    const match = line.match(/^## (D\d+) — (.+)$/u)
    if (match !== null) {
      if (current !== null) parsed.push(current)
      current = { id: match[1], title: match[2].trim(), lines: [] }
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  if (current !== null) parsed.push(current)
  return parsed
}

// An entry ends at the next heading, so its trailing separator must not be
// part of the hash: otherwise appending D<n+1> rewrites D<n>'s digest and the
// append-only rule forbids the very act it is meant to allow.
const trimTail = (entry) => {
  while (entry.lines.length > 0) {
    const last = entry.lines[entry.lines.length - 1]
    if (last.trim() === "" || last.trim() === "---") entry.lines.pop()
    else break
  }
  return entry
}

const entries = parseEntries(text).map(trimTail)

if (entries.length === 0) {
  console.error('decisions: no entries found')
  process.exit(1)
}

// The hash lock cannot see this one: two workers can pick the same next number
// and both edit in a way the lock accepts (each entry is new and well formed).
// A duplicate id makes every later citation ambiguous, so it is a hard failure
// rather than a review note. Audit finding F4.
const seen = new Set()
const duplicates = new Set()
for (const entry of entries) {
  if (seen.has(entry.id)) duplicates.add(entry.id)
  seen.add(entry.id)
}
if (duplicates.size > 0) {
  console.error(`decisions: duplicate ids: ${[...duplicates].join(', ')}`)
  console.error('decisions: give the later entry the next free number; ids are cited from code and docs. If this came from a merge, renumber before running --update: the lock has no entry for the new id')
  process.exit(1)
}

const digest = (entry) =>
  createHash('sha256')
    .update(`${entry.title}\n${entry.lines.join('\n').replace(/\s+$/u, '')}`)
    .digest('hex')

const currentHashes = Object.fromEntries(entries.map((entry) => [entry.id, digest(entry)]))
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { schema: 'dsh-anyplugin/decisions@1', entries: {} }

// The sanctioned writer. It exists because the guard (D78-adjacent rules) refuses
// every hand write to docs/DECISIONS.md: without it, no session could record a
// decision once the guard is installed. It writes through the lock, so the
// append-only verdict keeps meaning something.
const valueOf = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}
const appendFile = valueOf('--append-file')
const rewordFile = valueOf('--file')
const rewordId = valueOf('--reword')
if (appendFile !== undefined || rewordId !== undefined) {
  const payloadPath = appendFile ?? rewordFile
  if (payloadPath === undefined) {
    console.error('decisions: --reword needs --file <path>')
    process.exit(1)
  }
  if (appendFile !== undefined && rewordId !== undefined) {
    console.error('decisions: --append-file and --reword are different modes; pick one')
    process.exit(1)
  }
  const payload = readFileSync(resolve(payloadPath), 'utf8').replace(/\s+$/u, '')
  const headingMatch = payload.match(/^## (D\d+) — (.+)$/mu)
  if (headingMatch === null) {
    console.error(`decisions: the payload must start with "## D<n> — <title>"; got ${JSON.stringify(payload.slice(0, 60))}`)
    process.exit(1)
  }
  // A decision that origin/main already carries is ratified: rewriting it here
  // would be the very in-place edit the lock exists to catch.
  const onMain = () => {
    try {
      const mainText = execFileSync('git', ['-C', root, 'show', 'origin/main:docs/DECISIONS.md'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return mainText
    } catch {
      return undefined
    }
  }
  const mainText = onMain()
  if (mainText === undefined) {
    console.error('decisions: cannot read origin/main:docs/DECISIONS.md; the writer refuses to guess what is ratified')
    process.exit(1)
  }
  const mainIds = new Set([...mainText.matchAll(/^## (D\d+) — /gmu)].map((match) => match[1]))
  const ids = [...payload.matchAll(/^## (D\d+) — /gmu)].map((match) => match[1])
  if (ids.length !== 1) {
    console.error(`decisions: the payload must hold exactly one entry, found ${ids.length}`)
    process.exit(1)
  }
  const id = ids[0]
  if (mainIds.has(id)) {
    console.error(`decisions: ${id} is already on origin/main; it is ratified, supersede it with a new entry instead`)
    process.exit(1)
  }
  let nextText
  if (appendFile !== undefined) {
    if (entries.some((entry) => entry.id === id)) {
      console.error(`decisions: ${id} already exists; --append-file only adds a new id`)
      process.exit(1)
    }
    nextText = `${text.replace(/\s+$/u, '')}\n\n${payload}\n`
  } else {
    const start = text.search(new RegExp(`^## ${rewordId} — `, 'mu'))
    if (start < 0) {
      console.error(`decisions: no entry ${rewordId} to reword`)
      process.exit(1)
    }
    if (id !== rewordId) {
      console.error(`decisions: the payload's id ${id} does not match --reword ${rewordId}`)
      process.exit(1)
    }
    const after = text.slice(start + 1).search(/^## D\d+ — /mu)
    const end = after < 0 ? text.length : start + 1 + after
    const rewritten = `${payload}\n\n`
    nextText = `${text.slice(0, start)}${rewritten}${text.slice(end)}`.replace(/\n{3,}/gu, '\n\n')
  }
  // Everything outside the touched entry must still hash the same; otherwise the
  // writer would be a back door for the in-place edits the gate forbids.
  const before = new Map(entries.map((entry) => [entry.id, digest(entry)]))
  const refreshed = parseEntries(nextText)
  for (const entry of refreshed) {
    if (entry.id === id) continue
    if (before.get(entry.id) !== digest(entry)) {
      console.error(`decisions: the payload changes ${entry.id} as well; one entry at a time`)
      process.exit(1)
    }
  }
  writeFileSync(decisionsPath, nextText)
  const nextHashes = Object.fromEntries(refreshed.map((entry) => [entry.id, digest(entry)]))
  writeFileSync(lockPath, `${JSON.stringify({ ...lock, entries: nextHashes }, null, 2)}\n`)
  console.log(`decisions: ${appendFile !== undefined ? 'appended' : 'reworded'} ${id}; locked ${refreshed.length} entries`)
  process.exit(0)
}

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
