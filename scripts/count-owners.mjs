// R15 support: a number in a doc names the test that owns it.
//
// Counts drift. "25 declared / 24 matched" is only true while the coverage
// test asserts it; a doc that states the number but not the owner lets one
// move while the other stays green — exactly the failure the ratchet exists to
// prevent. The rule is deliberately narrow: only `N declared`, `N test(s)` and
// `N fixture(s)` are claims, and the owner is a `.test.mjs` path in the same
// paragraph or the same table (tables are one paragraph: no blank lines
// between rows).
//
// `docs/DECISIONS.md` is exempt at the call site: it is the append-only
// historical record, hashed by `check:decisions`, and its counts are what was
// true when the entry was ratified — rewriting them would falsify the record.

const CLAIM = /\b\d+\s+(?:total\s+)?(?:declared|tests?|fixtures?)\b/giu
const OWNER = /[\w./-]+\.test\.mjs\b/gu

/** Split on blank lines, keeping the line each paragraph starts on. */
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
    if (lines[index].trim() === '') {
      flush()
      start = index + 1
    } else {
      buffer.push(lines[index])
    }
  }
  flush()
  return result
}

/**
 * Paragraphs that state a count without naming a test.
 * `line` is 1-based and points at the paragraph, not the number, so the
 * caller can report a file location a human can open.
 */
export function countOwnerViolations(text, { ownerExists = () => true } = {}) {
  const violations = []
  for (const paragraph of paragraphs(text)) {
    const claims = [...paragraph.text.matchAll(CLAIM)].map((match) => match[0].replace(/\s+/gu, ' '))
    if (claims.length === 0) continue
    const owners = [...paragraph.text.matchAll(OWNER)].map((match) => match[0])
    if (owners.length === 0) {
      violations.push({
        line: paragraph.line,
        claim: claims[0],
        message: `"${claims[0]}" states a count but the paragraph names no owning .test.mjs file; add the test path next to the number`,
      })
      continue
    }
    const missing = owners.filter((owner) => !ownerExists(owner))
    if (missing.length === owners.length) {
      violations.push({
        line: paragraph.line,
        claim: claims[0],
        message: `"${claims[0]}" names ${missing.join(', ')}, which does not exist; point at the test that owns the number`,
      })
    }
  }
  return violations
}

/** Claims the docs actually own, for the check's summary line. */
export function ownedCounts(text, { ownerExists = () => true } = {}) {
  return paragraphs(text).filter((paragraph) => {
    if ([...paragraph.text.matchAll(CLAIM)].length === 0) return false
    const owners = [...paragraph.text.matchAll(OWNER)].map((match) => match[0])
    return owners.some((owner) => ownerExists(owner))
  }).length
}
