// R15 support: a count in a doc is checked against the number its owner states.
//
// Counts drift. "26 served / 7 refused / 67 absent" is only true while the
// ledger says so; a doc that repeats the number but names no owner lets one
// move while the other stays green — exactly the failure the ledger exists to
// prevent. Naming the owner is not enough either: the old rule accepted any
// `.test.mjs` path, so `24 served` could sit next to a test that said 26 and
// the gate stayed green. This module therefore reads the owner.
//
// The grammar is deliberately narrow — the ledger's own vocabulary plus the
// gate's test/fixture counts: `N declared`, `N served`, `N refused`,
// `N refusals`, `N refused-only`, `N absent`, `N matched`, `N missing`,
// `N test(s)`, `N fixture(s)`. `typed` and `total` are accepted between the
// number and the noun, so `7 typed refusals` is the same claim as `7 refused`.
//
// The owner is named in the same paragraph (tables are one paragraph: no blank
// lines between rows) in one of two forms:
//
//   packages/dsh-anyplugin-conformance/test/coverage.test.mjs
//     the file must export `EXPECTED_COUNTS = { key: number, ... }`; the test
//     itself asserts those fields, so the constant cannot drift from it.
//
//   `fixtures/mods/coverage.json` `totals.methods`
//     the JSON path must be followed by a code span naming the object to read;
//     the number is `totals.methods[<noun key>]`. A bare JSON path that merely
//     mentions the file is not an owner citation.
//
// The nearest owner citation in the paragraph wins, so several sections can be
// cited in one paragraph as long as each claim sits next to its own section.
//
// `docs/DECISIONS.md` is exempt at the call site: it is the append-only
// historical record, hashed by `check:decisions`, and its counts are what was
// true when the entry was ratified — rewriting them would falsify the record.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const CLAIM =
  /\b(\d+)\s+(?:(?:typed|total)\s+)?(declared|served|refused-only|refusals?|refused|absent|matched|missing|tests?|fixtures?)\b/giu
const OWNER_REF = /`((?:packages|docs|spikes|fixtures|scripts|\.github)\/[^`\s]+?\.(?:json|test\.mjs))`/gu
const SECTION_AFTER = /^[\s,;:()]*`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/u
const SECTION_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u
const EXPECTED_OBJECT = /export\s+const\s+EXPECTED_COUNTS\s*=\s*\{([^}]*)\}/u

const KEY = {
  declared: 'declared',
  served: 'served',
  refused: 'refused',
  refusal: 'refused',
  refusals: 'refused',
  'refused-only': 'refusedOnly',
  absent: 'absent',
  matched: 'matched',
  missing: 'missing',
  test: 'tests',
  tests: 'tests',
  fixture: 'fixtures',
  fixtures: 'fixtures',
}

/**
 * Split on blank lines, list-item boundaries and headings, keeping the line
 * each block starts on. Consecutive bullets are separate claims even without a
 * blank line between them, so a citation in the next bullet is not treated as
 * this bullet's owner.
 */
function paragraphs(text) {
  const lines = text.split('\n')
  const result = []
  let start = 0
  let buffer = []
  const flush = () => {
    if (buffer.length > 0) result.push({ line: start + 1, text: buffer.join('\n') })
    buffer = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      flush()
      start = index + 1
      continue
    }
    if (/^(?:[-*+]\s|#{1,6}\s)/u.test(line) && buffer.length > 0) {
      flush()
      start = index
    }
    buffer.push(line)
  }
  flush()
  return result
}

/**
 * Owner citations in a paragraph, in source order. A JSON path carries the
 * section code span that follows it; a test path carries none.
 */
function ownerRefs(text) {
  const refs = []
  for (const match of text.matchAll(OWNER_REF)) {
    const path = match[1].replace(/[.,;:]$/u, '')
    const after = text.slice(match.index + match[0].length)
    const section = after.match(SECTION_AFTER)?.[1]
    refs.push({
      path,
      section: section !== undefined && SECTION_NAME.test(section) ? section : null,
      isTest: path.endsWith('.test.mjs'),
      start: match.index,
    })
  }
  return refs
}

const nearest = (refs, offset) =>
  refs.reduce((best, ref) => (best === null || Math.abs(ref.start - offset) < Math.abs(best.start - offset) ? ref : best), null)

const claimText = (match) => match[0].replace(/\s+/gu, ' ')

/**
 * Resolve one claim against one owner. Returns `{ expected, where }` or a
 * human-readable `{ problem }`.
 */
function resolve(claim, ref, { ownerExists, readOwner }) {
  const label = `"${claim.text}"`
  if (!ownerExists(ref.path)) {
    return { problem: `${label} names ${ref.path}, which does not exist; point at the file that owns the number` }
  }
  let source
  try {
    source = readOwner(ref.path)
  } catch (error) {
    return { problem: `${label} names ${ref.path}, which could not be read: ${error.message}` }
  }
  const key = KEY[claim.noun]
  if (ref.isTest) {
    const object = source.match(EXPECTED_OBJECT)?.[1]
    if (object === undefined) {
      return { problem: `${label} names ${ref.path}, which declares no \`EXPECTED_COUNTS\` object; export the numbers the test asserts` }
    }
    const counts = {}
    for (const pair of object.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(\d+)/gu)) counts[pair[1]] = Number(pair[2])
    if (!(key in counts)) {
      return { problem: `${label} names ${ref.path} but its \`EXPECTED_COUNTS\` has no \`${key}\`` }
    }
    return { expected: counts[key], where: `${ref.path} EXPECTED_COUNTS.${key}` }
  }
  if (ref.section === null) {
    return { problem: `${label} names ${ref.path} without an object section; write the section (e.g. totals.methods) after the path` }
  }
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    return { problem: `${label} names ${ref.path}, which is not valid JSON: ${error.message}` }
  }
  for (const part of ref.section.split('.')) {
    if (value === null || typeof value !== 'object' || !(part in value)) {
      return { problem: `${label} names ${ref.path} ${ref.section}, which does not exist` }
    }
    value = value[part]
  }
  if (value === null || typeof value !== 'object' || !(key in value) || typeof value[key] !== 'number') {
    return { problem: `${label} names ${ref.path} ${ref.section}, which has no \`${key}\` number` }
  }
  return { expected: value[key], where: `${ref.path} ${ref.section}.${key}` }
}

function checkCounts(text, { ownerExists, readOwner } = {}) {
  const violations = []
  let verified = 0
  const options = {
    ownerExists: ownerExists ?? ((relativePath) => existsSync(join(root, relativePath))),
    readOwner: readOwner ?? ((relativePath) => readFileSync(join(root, relativePath), 'utf8')),
  }
  for (const paragraph of paragraphs(text)) {
    const claims = [...paragraph.text.matchAll(CLAIM)].map((match) => ({
      text: claimText(match),
      value: Number(match[1]),
      noun: match[2].toLowerCase(),
      offset: match.index,
    }))
    if (claims.length === 0) continue
    const refs = ownerRefs(paragraph.text)
    // A JSON path without a section, or a `.test.mjs`, only becomes the owner
    // when no sectioned citation exists in the paragraph; the bare path then
    // produces the "add a section" message instead of "names no owner".
    const citations = refs.filter((ref) => ref.isTest || ref.section !== null)
    for (const claim of claims) {
      const ref = nearest(citations.length > 0 ? citations : refs, claim.offset)
      if (ref === null) {
        violations.push({
          line: paragraph.line,
          claim: claim.text,
          message: `"${claim.text}" states a count but the paragraph names no owner file; add the .test.mjs path or a .json path and its object section next to the number`,
        })
        continue
      }
      const result = resolve(claim, ref, options)
      if (result.problem !== undefined) {
        violations.push({ line: paragraph.line, claim: claim.text, message: result.problem })
      } else if (result.expected !== claim.value) {
        violations.push({
          line: paragraph.line,
          claim: claim.text,
          message: `"${claim.text}" disagrees with its owner: the doc says ${claim.value}, ${result.where} says ${result.expected}`,
        })
      } else {
        verified += 1
      }
    }
  }
  return { violations, verified }
}

/**
 * Count claims and the number the owner confirmed, in one pass. The gate calls
 * this so each document's owner files are read once, not once per export.
 */
export function checkCountClaims(text, options) {
  return checkCounts(text, options)
}

/**
 * Count claims that a paragraph states but its owner does not confirm.
 * `line` is 1-based and points at the paragraph, not the number, so the
 * caller can report a file location a human can open.
 */
export function countOwnerViolations(text, options) {
  return checkCounts(text, options).violations
}

/** Claims the docs actually verified, for the check's summary line. */
export function ownedCounts(text, options) {
  return checkCounts(text, options).verified
}
