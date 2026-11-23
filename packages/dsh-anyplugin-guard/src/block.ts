import { PLUGIN_ID } from './composition.ts'

/**
 * The managed block read back as YAML values.
 *
 * `renderBlock` writes a deterministic YAML document, and the first version of
 * `guard:status` compared that document line by line. The profile writer is not
 * us, though: DSH rewrites `cordis.patch.yml` through a comment-preserving YAML
 * document API, which may fold a long double-quoted scalar across two lines and
 * reseat a trailing comment behind a blank line without changing one value. The
 * loader applies the parsed document, so the guarantee `guard:status` gives is
 * "the installed block holds the values this tree would write" — and that has
 * to be decided on values too, or a harmless rewrite reads as a stale install
 * (F20).
 *
 * The reader is deliberately strict: it accepts the shapes a YAML writer
 * produces for this block — block mappings and sequences, JSON-quoted and
 * plain scalars, a double-quoted scalar folded with a backslash continuation or
 * a bare line break, comments and blank lines — and nothing else. Callers must
 * treat `{ ok: false }` as "not provably equal": a side that does not parse is
 * stale, never current, and anchors, aliases, tags, duplicate keys and flow
 * collections are refused rather than guessed at.
 */

export type BlockParse = { ok: true; value: unknown } | { ok: false; reason: string }

const ESCAPED: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: '\u2028',
  P: '\u2029',
}

class BlockSyntaxError extends Error {
  line: number

  constructor(line: number, message: string) {
    super(message)
    this.name = 'BlockSyntaxError'
    this.line = line
  }
}

function fail(line: number, message: string): never {
  throw new BlockSyntaxError(line, message)
}

interface Document {
  lines: string[]
  /** The next physical line, 0-based; parse helpers keep it past what they read. */
  index: number
}

interface Peak {
  index: number
  line: number
  indent: number
  content: string
}

function indentOf(line: string): number {
  let index = 0
  while (line[index] === ' ') index += 1
  return index
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isComment(line: string): boolean {
  return line.slice(indentOf(line)).startsWith('#')
}

function peek(document: Document): Peak | undefined {
  while (document.index < document.lines.length) {
    const raw = document.lines[document.index]
    if (isBlank(raw) || isComment(raw)) {
      document.index += 1
      continue
    }
    const indent = indentOf(raw)
    return { index: document.index, line: document.index + 1, indent, content: raw.slice(indent) }
  }
  return undefined
}

/**
 * The parsed value of a managed block, or a reason the block cannot be read.
 *
 * The argument is the block `readBlock` returned: the two marker comments are
 * trivia to the reader, and the optional state comment is trivia too — it
 * records what the file looked like before install, not part of the policy.
 */
export function parseBlock(text: string): BlockParse {
  const document: Document = {
    lines: text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)),
    index: 0,
  }
  try {
    const first = peek(document)
    if (first === undefined) return { ok: true, value: null }
    const value = parseNode(document, first)
    const trailing = peek(document)
    if (trailing !== undefined) fail(trailing.line, 'unexpected content after the document')
    return { ok: true, value }
  } catch (error) {
    if (error instanceof BlockSyntaxError) return { ok: false, reason: `line ${error.line}: ${error.message}` }
    throw error
  }
}

/** Deep equality of parsed YAML values: arrays in order, objects by own keys. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index])) return false
    }
    return true
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)) return false
    if (!sameValue(leftRecord[key], rightRecord[key])) return false
  }
  return true
}

/**
 * The `worktrees` entries a parsed block lists, or undefined when the value is
 * not the entry this guard installs. Reporting reads them from values so a
 * block the writer refolded still answers with its own policy.
 */
export function guardWorktrees(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  for (const row of value) {
    if (row === null || typeof row !== 'object') continue
    const insert = (row as Record<string, unknown>).insert
    if (!Array.isArray(insert)) continue
    for (const entry of insert) {
      if (entry === null || typeof entry !== 'object') continue
      const plugin = entry as Record<string, unknown>
      if (plugin.id !== PLUGIN_ID) continue
      const config = plugin.config
      if (config === null || typeof config !== 'object') return undefined
      const worktrees = (config as Record<string, unknown>).worktrees
      if (!Array.isArray(worktrees)) return undefined
      const paths: string[] = []
      for (const path of worktrees) {
        if (typeof path !== 'string') return undefined
        paths.push(path)
      }
      return paths
    }
  }
  return undefined
}

function parseNode(document: Document, peak: Peak): unknown {
  document.index = peak.index + 1
  if (peak.content === '-' || peak.content.startsWith('- ')) return parseSequence(document, peak.line, peak.indent)
  if (/^[A-Za-z_][A-Za-z0-9_.-]*[ ]*:/u.test(peak.content)) {
    return parseMapping(document, peak.indent, { line: peak.line, content: peak.content })
  }
  return fail(peak.line, `expected a block mapping or sequence, found ${JSON.stringify(peak.content)}`)
}

function parseSequence(document: Document, firstLine: number, indent: number): unknown[] {
  const items: unknown[] = []
  let pending: { line: number; content: string } | undefined = {
    line: firstLine,
    content: document.lines[firstLine - 1].slice(indent),
  }
  for (;;) {
    let line: number
    let content: string
    if (pending !== undefined) {
      line = pending.line
      content = pending.content
      pending = undefined
    } else {
      const next = peek(document)
      if (next === undefined || next.indent < indent) return items
      if (next.indent > indent) fail(next.line, `unexpected indentation (expected a sibling item at column ${indent})`)
      document.index = next.index + 1
      line = next.line
      content = next.content
    }
    const after = content.slice(1)
    if (after !== '' && !after.startsWith(' ')) fail(line, 'expected "- " before a sequence item')
    let restStart = 1
    while (content[restStart] === ' ') restStart += 1
    const rest = content.slice(restStart)
    if (rest === '') {
      const next = peek(document)
      if (next === undefined || next.indent <= indent) fail(line, 'a sequence item has no value')
      items.push(parseNode(document, next))
      continue
    }
    if (rest === '-' || rest.startsWith('- ')) fail(line, 'a nested sequence on the dash line is not read')
    if (/^[A-Za-z_][A-Za-z0-9_.-]*[ ]*:/u.test(rest)) {
      items.push(parseMapping(document, indent + restStart, { line, content: rest }))
      continue
    }
    items.push(parseValue(document, line, indent + restStart))
  }
}

function parseMapping(
  document: Document,
  indent: number,
  first?: { line: number; content: string },
): Record<string, unknown> {
  const mapping: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let pending = first
  for (;;) {
    let line: number
    let content: string
    if (pending !== undefined) {
      line = pending.line
      content = pending.content
      pending = undefined
    } else {
      const next = peek(document)
      if (next === undefined || next.indent < indent) return mapping
      if (next.indent > indent) fail(next.line, `unexpected indentation (expected a sibling key at column ${indent})`)
      document.index = next.index + 1
      line = next.line
      content = next.content
    }
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)[ ]*:/u.exec(content)
    if (match === null) fail(line, `expected "key: value", found ${JSON.stringify(content)}`)
    const key = match[1]
    if (Object.hasOwn(mapping, key)) fail(line, `duplicate mapping key ${JSON.stringify(key)}`)
    let restStart = match[0].length
    while (content[restStart] === ' ') restStart += 1
    if (restStart >= content.length || content[restStart] === '#') {
      const next = peek(document)
      if (next === undefined || next.indent <= indent) fail(line, `key ${JSON.stringify(key)} has no value`)
      mapping[key] = parseNode(document, next)
      continue
    }
    mapping[key] = parseValue(document, line, indent + restStart)
  }
}

function parseValue(document: Document, line: number, column: number): unknown {
  const text = document.lines[line - 1].slice(column)
  if (text.startsWith('[]')) return finishFlow(document, line, column + 2, [])
  if (text.startsWith('{}')) return finishFlow(document, line, column + 2, Object.create(null) as Record<string, unknown>)
  if (text.startsWith('"') || text.startsWith("'")) return parseQuoted(document, line, column, text[0])
  if (text[0] === '[') fail(line, 'flow sequences are not read; write one entry per line')
  if (text[0] === '{') fail(line, 'flow mappings are not read; write one key per line')
  if (text[0] === '&' || text[0] === '*' || text[0] === '!') fail(line, 'anchors, aliases and tags are not read')
  if (text[0] === '|' || text[0] === '>') fail(line, 'block scalars are not read')
  const plain = stripComment(text).trim()
  if (plain === '') fail(line, 'a key needs a value (an empty value is refused)')
  return resolvePlain(plain, line)
}

function finishFlow(document: Document, line: number, column: number, value: unknown): unknown {
  const rest = document.lines[line - 1].slice(column)
  if (!/^[ ]*(?:#.*)?$/u.test(rest)) fail(line, `unexpected text after a value: ${JSON.stringify(rest.trim())}`)
  document.index = Math.max(document.index, line)
  return value
}

function stripComment(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '#' && (index === 0 || text[index - 1] === ' ' || text[index - 1] === '\t')) {
      return text.slice(0, index)
    }
  }
  return text
}

// js-yaml's number resolvers keep a scalar as a string when `parseInt`/`parseFloat`
// is not finite (`1e999`, a hex literal too long for a double), so the reader
// must not type it as a number: `Infinity` also serialises as `null` in a JSON
// report, the same reason `.inf` is refused below.
function numberOrRefuse(value: number, text: string, line: number): number {
  if (!Number.isFinite(value)) fail(line, `plain value ${JSON.stringify(text)} is not a finite number; quote it`)
  return value
}

function resolvePlain(text: string, line: number): unknown {
  // The loader resolves plain scalars with a YAML schema, so a plain scalar is
  // only "the same value" as another when both sides type it the same way. The
  // tag set below is YAML 1.2 core/JSON: `true` in any case, `null`/`~`, decimal
  // integers (leading zeros included), `0x`/`0o`/`0b` integers and floats with a
  // digit on at least one side of the dot. Anything else stays a string.
  if (/^(?:true|True|TRUE)$/u.test(text)) return true
  if (/^(?:false|False|FALSE)$/u.test(text)) return false
  if (/^(?:null|Null|NULL|~)$/u.test(text)) return null
  if (/^[-+]?0x[0-9a-fA-F]+$/u.test(text)) return numberOrRefuse(Number.parseInt(text, 16), text, line)
  if (/^[-+]?0o[0-7]+$/u.test(text)) return numberOrRefuse(Number.parseInt(text.replace(/^[-+]?0o/u, ''), 8) * (text.startsWith('-') ? -1 : 1), text, line)
  if (/^[-+]?0b[01]+$/u.test(text)) return numberOrRefuse(Number.parseInt(text.replace(/^[-+]?0b/u, ''), 2) * (text.startsWith('-') ? -1 : 1), text, line)
  if (/^[-+]?[0-9]+$/u.test(text)) return numberOrRefuse(Number(text), text, line)
  if (/^(?:[-+]?[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/u.test(text)) return numberOrRefuse(Number(text), text, line)
  // A plain scalar the reader cannot type confidently is refused: the loader
  // may throw on it (`foo: bar`, `- b`) or type it as something we do not model
  // (`.inf`, `.NaN` — the loader's schema reads them as non-finite numbers,
  // which the block cannot have meant and which do not survive a JSON report).
  // A refusal makes the comparison stale, never current, which is the direction
  // F20 needs.
  if (/^[-+]?(?:\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)$/u.test(text)) {
    fail(line, `plain value ${JSON.stringify(text)} is not a finite number; quote it`)
  }
  if (text.includes(': ') || text.startsWith('- ') || text.startsWith('? ') || /^[&*!|>{[\]}]/u.test(text)) {
    fail(line, `plain value ${JSON.stringify(text)} is not read; quote it`)
  }
  return text
}

/**
 * A double- or single-quoted scalar, which may be folded across physical lines.
 *
 * A YAML writer folds a long quoted scalar in two ways this block can contain: a
 * bare line break folds to one space, and a backslash at the end of the line
 * removes the break entirely (`name: ".../ind\` then `ex.ts"`). The reader
 * accepts both; a blank line inside the scalar is refused, because the values
 * this block holds never carry a newline and a blank line would change one.
 */
function parseQuoted(document: Document, line: number, column: number, quote: string): string {
  let current = line
  let position = column + 1
  let value = ''
  document.index = Math.max(document.index, line)
  for (;;) {
    const text = document.lines[current - 1]
    let closed = false
    let escapedBreak = false
    // Raw spaces and tabs are trimmable at a fold; whitespace that came from an
    // escape is content and is flushed immediately. Keeping the two apart is
    // what makes `".../ind   \` + `ex.ts"` a different value from `".../ind\`
    // + `ex.ts"` — the loader sees `ind   ex.ts` in the first and `index.ts` in
    // the second (F20 follow-up: a lenient reader called them equal).
    let pending = ''
    while (position < text.length) {
      const character = text[position]
      if (character === ' ' || character === '\t') {
        pending += character
        position += 1
        continue
      }
      if (character === quote) {
        if (quote === "'" && text[position + 1] === "'") {
          value += pending + "'"
          pending = ''
          position += 2
          continue
        }
        value += pending
        pending = ''
        closed = true
        position += 1
        break
      }
      if (character !== '\\' || quote === "'") {
        value += pending + character
        pending = ''
        position += 1
        continue
      }
      if (position + 1 >= text.length) {
        escapedBreak = true
        position = text.length
        break
      }
      const escape = text[position + 1]
      const simple = ESCAPED[escape]
      if (simple !== undefined) {
        value += pending + simple
        pending = ''
        position += 2
        continue
      }
      const width = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : 0
      if (width === 0) fail(current, `unknown escape ${JSON.stringify(`\\${escape}`)} in a quoted scalar`)
      const digits = text.slice(position + 2, position + 2 + width)
      if (digits.length !== width || !/^[0-9a-fA-F]+$/u.test(digits)) {
        fail(current, `incomplete escape ${JSON.stringify(`\\${escape}${digits}`)} in a quoted scalar`)
      }
      const codepoint = Number.parseInt(digits, 16)
      if (codepoint > 0x10ffff) fail(current, `escape ${JSON.stringify(`\\${escape}${digits}`)} is not a Unicode scalar value`)
      value += pending + String.fromCodePoint(codepoint)
      pending = ''
      position += 2 + width
    }
    if (closed) {
      const rest = document.lines[current - 1].slice(position)
      if (!/^[ ]*(?:#.*)?$/u.test(rest)) {
        fail(current, `unexpected text after a quoted scalar: ${JSON.stringify(rest.trim())}`)
      }
      document.index = Math.max(document.index, current)
      return value
    }
    const next = current + 1
    if (next > document.lines.length) fail(current, 'unterminated quoted scalar')
    const continuation = document.lines[next - 1]
    if (isBlank(continuation)) fail(next, 'a blank line inside a quoted scalar is not read')
    // An escaped line break removes the break and the next line's indentation;
    // spaces before the backslash are content, because the line's last
    // character is the backslash and not the space. A bare line break folds to
    // one space and raw trailing whitespace is dropped.
    value += escapedBreak ? pending : ' '
    pending = ''
    current = next
    // A fold discards the continuation's leading whitespace, whichever way it
    // is written: js-yaml's `skipSeparationSpace` skips the whole run of spaces
    // and tabs after a break (`"x\` + LF + TAB + spaces + `y"` is `xy`), so no
    // leading whitespace can be content at the start of a folded line. Skipping
    // only the space indent and then a tab run would keep spaces that follow the
    // tab (F20 round-2 re-check).
    position = 0
    while (continuation[position] === ' ' || continuation[position] === '\t') position += 1
    document.index = Math.max(document.index, current)
  }
}
