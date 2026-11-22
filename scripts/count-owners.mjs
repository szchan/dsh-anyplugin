// R15 support: a count in a doc is checked against the number its owner states.
//
// Counts drift. "26 served / 7 refused / 67 absent" is only true while the
// ledger says so; a doc that repeats the number but names no owner lets one
// move while the other stays green — exactly the failure the ledger exists to
// prevent. Naming the owner is not enough either: the old rule accepted any
// `.test.mjs` path, so `24 served` could sit next to a test that said 26 and
// the gate stayed green. And proximity is not enough: the ledger has several
// `served` numbers, so a claim must be bound to the owner family its own noun
// names, never to whichever citation happens to be closest.
//
// The grammar is deliberately narrow — the ledger's own vocabulary plus the
// gate's row count: `N declared`, `N served`, `N refused`, `N refusals`,
// `N refused-only`, `N absent`, `N matched`, `N missing`, `N row(s)`. `typed`,
// `total` and `coverage` are accepted between the number and the noun. Numbers
// outside that vocabulary (`N handler invocations`, `N sites`, `122/122`) are
// not claims this gate compares; docs must not say otherwise.
//
// The owner is named in the same paragraph or table row in one of two forms:
//
//   packages/dsh-anyplugin-conformance/test/coverage.test.mjs
//     the file must export `EXPECTED_COUNTS = { key: number, ... }`; the test
//     itself asserts those fields, so the constant cannot drift from it.
//
//   `fixtures/mods/coverage.json` `totals.methods`
//     the JSON path must be followed by a code span naming the object to read;
//     the number is `totals.methods[<noun key>]`. A bare JSON path that merely
//     mentions the file is not an owner citation, and a claim next to one fails
//     rather than borrowing a sectioned citation from further along.
//
// The category noun immediately after the claim binds the owner family:
// namespace(s) read `totals.namespaces`, member(s)/method(s) `totals.methods`,
// event(s) `totals.events`, element(s) `totals.elements`, render site(s)
// `totals.renderSites`, a bridge `site` reads `mods.test.mjs` and a coverage
// `row` reads `coverage.test.mjs`. An earlier category word — a table's
// first-cell label, a sentence topic — never competes. If the word after the
// claim is a noun the map does not know (`9 served pairs`), that is a failure,
// not a fallback; only when no noun follows does the nearest citation decide.
// A citation from another family is a failure, not a pass. Tables are split
// row by row, so one row's citation cannot certify the next row's claim.
//
// `docs/DECISIONS.md` is exempt at the call site: it is the append-only
// historical record, hashed by `check:decisions`, and its counts are what was
// true when the entry was ratified — rewriting them would falsify the record.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const LEDGER = 'fixtures/mods/coverage.json'
const COVERAGE_TEST = 'packages/dsh-anyplugin-conformance/test/coverage.test.mjs'
const MODS_TEST = 'packages/dsh-anyplugin-conformance/test/mods.test.mjs'

const CLAIM =
  /(?<![\d./])\b(\d+)\s+(?:(?:typed|total|coverage)\s+)?(declared|served|refused-only|refusals?|refused|absent|matched|missing|rows?)\b/giu
const OWNER_REF = /`((?:packages|docs|spikes|fixtures|scripts|\.github)\/[^`\s]+?\.(?:json|test\.mjs))`/gu
const SECTION_AFTER = /^[\s,;:()]*`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/u
const SECTION_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u
const EXPECTED_OBJECT = /export\s+const\s+EXPECTED_COUNTS\s*=\s*\{([^}]*)\}/u
const CODE_SPAN = /`[^`\n]*`/gu

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
  row: 'rows',
  rows: 'rows',
}

// Words that may follow a claim without naming a count category: articles,
// prepositions, conjunctions, auxiliaries and the vocabulary's own adjectives.
// Any other word right after the claim is an unknown category, not a licence
// to fall back to whichever citation is closest.
const NON_NOUN = new Set([
  'a',
  'about',
  'across',
  'after',
  'again',
  'all',
  'also',
  'an',
  'and',
  'are',
  'around',
  'as',
  'at',
  'available',
  'be',
  'been',
  'being',
  'before',
  'between',
  'both',
  'but',
  'by',
  'can',
  'complete',
  'could',
  'coverage',
  'did',
  'do',
  'does',
  'during',
  'each',
  'even',
  'every',
  'expected',
  'fewer',
  'for',
  'from',
  'had',
  'has',
  'have',
  'if',
  'in',
  'into',
  'is',
  'its',
  'just',
  'less',
  'listed',
  'may',
  'might',
  'more',
  'must',
  'no',
  'not',
  'of',
  'on',
  'only',
  'or',
  'our',
  'over',
  'per',
  'plus',
  'recorded',
  'reported',
  'see',
  'should',
  'since',
  'so',
  'still',
  'than',
  'that',
  'the',
  'then',
  'their',
  'these',
  'this',
  'those',
  'through',
  'to',
  'total',
  'typed',
  'under',
  'until',
  'via',
  'was',
  'were',
  'when',
  'where',
  'while',
  'will',
  'with',
  'within',
  'without',
  'would',
  'your',
])

/** The owner family a category noun selects. */
function categoryOf(word) {
  const value = word.toLowerCase()
  if (value.startsWith('render')) {
    return { label: 'render site', path: LEDGER, section: 'totals.renderSites' }
  }
  if (value.startsWith('namespace')) {
    return { label: 'namespace', path: LEDGER, section: 'totals.namespaces' }
  }
  if (value.startsWith('member') || value.startsWith('method')) {
    return { label: 'member', path: LEDGER, section: 'totals.methods' }
  }
  if (value.startsWith('event')) {
    return { label: 'event', path: LEDGER, section: 'totals.events' }
  }
  if (value.startsWith('element')) {
    return { label: 'element', path: LEDGER, section: 'totals.elements' }
  }
  if (value.startsWith('site')) {
    return { label: 'bridge site', path: MODS_TEST, section: 'EXPECTED_COUNTS' }
  }
  if (value.startsWith('row')) {
    return { label: 'coverage row', path: COVERAGE_TEST, section: 'EXPECTED_COUNTS' }
  }
  return null
}

/**
 * Split on blank lines, list-item boundaries, headings and table rows, keeping
 * the line each block starts on. A bullet or a row is its own claim context, so
 * a citation in the next one is never treated as this one's owner.
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
    const startsBlock = /^(?:[-*+]\s|#{1,6}\s)/u.test(line) || /^\s*\|/u.test(line)
    if (startsBlock && buffer.length > 0) {
      flush()
      start = index
    }
    buffer.push(line)
  }
  flush()
  return result
}

/** Character ranges occupied by inline code, so their words are not prose. */
function codeRanges(text) {
  return [...text.matchAll(CODE_SPAN)].map((match) => [match.index, match.index + match[0].length])
}

const inside = (offset, ranges) => ranges.some(([start, end]) => offset >= start && offset < end)

/**
 * Owner citations in a block, in source order. A JSON path carries the section
 * code span that follows it; a test path carries none.
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

/**
 * The first prose word after a claim. Markdown decoration is skipped, but a
 * citation code span, a table-cell boundary or another number ends the search:
 * the noun that binds the owner is the one immediately after the number.
 */
function nextWord(text, offset) {
  let index = offset
  while (index < text.length) {
    const character = text[index]
    if (/\s/u.test(character)) {
      index += 1
      continue
    }
    if (character === '`' || character === '|') return null
    if (/[A-Za-z]/u.test(character)) {
      const word = text.slice(index).match(/^[A-Za-z][A-Za-z-]*/u)[0]
      return { word, start: index, end: index + word.length }
    }
    if (/\d/u.test(character)) return null
    index += 1
  }
  return null
}

const nearest = (items, offset) =>
  items.reduce(
    (best, item) => (best === null || Math.abs(item.start - offset) < Math.abs(best.start - offset) ? item : best),
    null,
  )

const claimText = (match) => match[0].replace(/\s+/gu, ' ')

const describeRef = (ref) => (ref.isTest ? `${ref.path} EXPECTED_COUNTS` : `${ref.path} ${ref.section ?? '(no section)'}`)

const matchesCategory = (ref, category) => {
  if (category.path.endsWith('.test.mjs')) return ref.isTest && ref.path === category.path
  return !ref.isTest && ref.section === category.section
}

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

/**
 * Pick the citation that may certify a claim. Only the noun right after the
 * number binds the family; an unknown noun is an error, and an earlier table
 * label or topic never competes. Distance decides only when no noun follows.
 */
function chooseRef(claim, refs, text) {
  const label = `"${claim.text}"`
  const next = nextWord(text, claim.end)
  let category = null
  if (next !== null) {
    category = categoryOf(next.word)
    if (category === null && !NON_NOUN.has(next.word.toLowerCase())) {
      return {
        problem: `"${claim.text} ${next.word}" uses a count category R15 does not know; add it to the map or reword`,
      }
    }
  }
  const closest = nearest(refs, claim.offset)
  if (closest !== null && !closest.isTest && closest.section === null) {
    return {
      problem: `${label} names ${closest.path} without an object section; write the section (e.g. totals.methods) after the path`,
    }
  }
  if (category !== null) {
    const matching = refs.filter((ref) => matchesCategory(ref, category))
    if (matching.length === 0) {
      if (refs.length === 0) {
        return {
          problem: `${label} states a count but the paragraph or table row names no owner file; add the .test.mjs path or a .json path and its object section next to the number`,
        }
      }
      const cited = refs.map(describeRef).join(', ')
      return {
        problem: `${label} is a ${category.label} count but is certified by an owner of a different count: ${cited}; cite ${category.path} ${category.section}`,
      }
    }
    return { ref: nearest(matching, claim.offset) }
  }
  const citations = refs.filter((ref) => ref.isTest || ref.section !== null)
  if (citations.length === 0) {
    if (refs.length > 0) {
      return {
        problem: `${label} names ${refs[0].path} without an object section; write the section (e.g. totals.methods) after the path`,
      }
    }
    return {
      problem: `${label} states a count but the paragraph or table row names no owner file; add the .test.mjs path or a .json path and its object section next to the number`,
    }
  }
  return { ref: nearest(citations, claim.offset) }
}

function checkCounts(text, { ownerExists, readOwner } = {}) {
  const violations = []
  let verified = 0
  const options = {
    ownerExists: ownerExists ?? ((relativePath) => existsSync(join(root, relativePath))),
    readOwner: readOwner ?? ((relativePath) => readFileSync(join(root, relativePath), 'utf8')),
  }
  for (const paragraph of paragraphs(text)) {
    const ranges = codeRanges(paragraph.text)
    const claims = [...paragraph.text.matchAll(CLAIM)]
      .filter((match) => !inside(match.index, ranges))
      .map((match) => ({
        text: claimText(match),
        value: Number(match[1]),
        noun: match[2].toLowerCase(),
        offset: match.index,
        end: match.index + match[0].length,
      }))
    if (claims.length === 0) continue
    const refs = ownerRefs(paragraph.text)
    for (const claim of claims) {
      const line = paragraph.line + (paragraph.text.slice(0, claim.offset).match(/\n/gu)?.length ?? 0)
      const choice = chooseRef(claim, refs, paragraph.text)
      if (choice.problem !== undefined) {
        violations.push({ line, claim: claim.text, message: choice.problem })
        continue
      }
      const result = resolve(claim, choice.ref, options)
      if (result.problem !== undefined) {
        violations.push({ line, claim: claim.text, message: result.problem })
      } else if (result.expected !== claim.value) {
        violations.push({
          line,
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
 * Count claims that a paragraph or table row states but its owner does not
 * confirm. `line` is 1-based and points at the claim, so the caller can report
 * a file location a human can open.
 */
export function countOwnerViolations(text, options) {
  return checkCounts(text, options).violations
}

/** Claims the docs actually verified, for the check's summary line. */
export function ownedCounts(text, options) {
  return checkCounts(text, options).verified
}
