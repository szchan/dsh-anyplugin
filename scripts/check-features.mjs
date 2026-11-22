#!/usr/bin/env node
// Feature-map check (docs/FEATURES.md).
//
// The map is prose a human maintains, but it has to stay true. This script fails
// when a referenced path is gone, when a table with a "class" column contains a
// row whose class is not one of the declared five, or when a table has no
// evidence column. Those are the three ways a capability map becomes fiction.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCountClaims } from './count-owners.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const file = join(root, 'docs', 'FEATURES.md')
const text = readFileSync(file, 'utf8')

const CLASSES = new Set(['exact', 'equivalent', 'derived', 'planned', 'unsupported'])
const problems = []
const lines = text.split('\n')

// 1. Every inline-code repo path must resolve.
const PATH = /`((?:packages|docs|spikes|fixtures|scripts|\.github)\/[^`\s]+)`/gu
const paths = new Set()
for (const match of text.matchAll(PATH)) {
  const value = match[1].replace(/[.,;:]$/u, '')
  if (value.includes('*')) continue
  paths.add(value)
}
for (const value of paths) {
  if (!existsSync(join(root, value))) problems.push(`missing path: ${value}`)
}

// 2. Tables: parse runs of `|` lines. A header that names a "class" column makes
//    the class cell mandatory for every data row; every table needs an evidence
//    column ("artifact" or "evidence").
const cells = (line) => line.split('|').map((cell) => cell.trim()).slice(1, -1)
let tables = 0
for (let index = 0; index < lines.length; index += 1) {
  if (!lines[index].startsWith('|')) continue
  const header = cells(lines[index])
  if (/^-+:?$|^-+$/u.test(header[0] ?? '')) continue
  const block = []
  let cursor = index + 1
  while (cursor < lines.length && lines[cursor].startsWith('|')) {
    block.push(lines[cursor])
    cursor += 1
  }
  tables += 1
  const classAt = header.findIndex((cell) => /^class$/iu.test(cell))
  const evidence = header.some((cell) => /^(artifact|evidence)$/iu.test(cell))
  if (!evidence && header.length >= 3) problems.push(`table "${header.join(' | ')}" has no artifact/evidence column`)
  if (classAt !== -1) {
    for (const row of block) {
      const value = cells(row)
      if (/^-+:?$|^-+$/u.test(value[0] ?? '')) continue
      const cell = value[classAt] ?? ''
      const word = cell.match(/^`([a-z-]+)`/u)?.[1]
      if (word === undefined) problems.push(`row has no class word: ${row.slice(0, 70)}`)
      else if (!CLASSES.has(word)) problems.push(`class word outside the contract: ${word}`)
    }
  }
  index = cursor - 1
}
if (tables === 0) problems.push('no tables found; the map has no rows')

// 3. The snapshot must name the ratchet that owns the number.
if (!/coverage\.test\.mjs/u.test(text)) problems.push('the snapshot must name the coverage ratchet')

// 4. R15. A doc that states a count must agree with the number its owner
//    states. The owner is a `.test.mjs` that exports the expected number as
//    `EXPECTED_COUNTS`, or a JSON ledger cited with its object section
//    (`fixtures/mods/coverage.json` `totals.methods`). Checking the owner is
//    the point: a citation that is never compared lets the doc and the owner
//    drift while the gate stays green. DECISIONS.md is exempt: it is the
//    append-only historical record, hashed by check:decisions, and its counts
//    are what was true when the entry was ratified — editing them to follow
//    the suite would falsify the record.
let owned = 0
const ownerExists = (relativePath) => existsSync(join(root, relativePath))
const readOwner = (relativePath) => readFileSync(join(root, relativePath), 'utf8')
const docs = readdirSync(join(root, 'docs'))
  .filter((name) => name.endsWith('.md') && name !== 'DECISIONS.md')
  .sort()
for (const name of docs) {
  const document = readFileSync(join(root, 'docs', name), 'utf8')
  const { violations, verified } = checkCountClaims(document, { ownerExists, readOwner })
  owned += verified
  for (const violation of violations) {
    problems.push(`${name}:${violation.line}: ${violation.message}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`features: ${problem}`)
  console.error(`features: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`features: ${tables} tables, ${paths.size} referenced paths, ${owned} count claims verified, classes within contract`)
