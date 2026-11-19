/**
 * Static scanner for Claude mods.
 *
 * A mod is an ES module whose capabilities are visible as literal call sites:
 * `on('event', ...)` and `$.namespace.method(...)`. That is what makes an
 * unsandboxed mod reviewable *before* install (ARCHITECTURE §7.5), so the scan
 * is deliberately lexical: it reads source text, never imports, executes or
 * rewrites the module.
 *
 * The scanner is not a JavaScript parser. It skips comments, strings, regular
 * expression literals and template-literal bodies; it records a literal event
 * only when the first argument is one literal, and records a call only when the
 * namespace and method are direct identifiers. Every capability-shaped site it
 * can see but cannot prove is reported under `dynamic` with a reason instead of
 * being dropped. Some capabilities leave no literal site at all (aliases,
 * imported helpers, `eval`/`new Function`, unrecognized syntax); those are
 * outside a lexical scan and are named in `SCAN_CAVEAT`. The limits are part of
 * D21.
 */

/**
 * The limits of every scan, as one stable sentence. `capabilityList` is a
 * literal list, not a completeness claim: a trust prompt must display this
 * caveat and `scan.dynamic`, or a caller could read the list as exhaustive.
 */
export const SCAN_CAVEAT =
  'The scan proves only literal on() and $.namespace.method() sites. Calls through aliases or imported helpers, eval/new Function, and syntax the scanner does not recognize are invisible.'

export interface ModEvent {
  /** The literal event name, e.g. `tool.call`. */
  name: string
  /**
   * The matcher argument exactly as authored, with runs of whitespace collapsed
   * to one space. Present only for three-argument calls; the scanner does not
   * evaluate the expression.
   */
  matcher?: string
  /** 1-based line of the `on` token. */
  line: number
}

export interface ModCall {
  /** The namespace in `$.namespace.method`, e.g. `fs`. */
  namespace: string
  /** The method in `$.namespace.method`, e.g. `read`. */
  method: string
  /** 1-based line of the `$` token. */
  line: number
}

export interface DynamicSite {
  /** 1-based line of the construct the scanner could not prove. */
  line: number
  /** Why this site is not in `events` / `calls`. Never empty. */
  reason: string
}

export interface ModScan {
  /** The file path or URL the caller asked to scan. */
  file: string
  /** Every proven `on('event', ...)` site, in source order. Duplicates are kept. */
  events: ModEvent[]
  /** Every proven `$.namespace.method(...)` site, in source order. Duplicates are kept. */
  calls: ModCall[]
  /**
   * Every capability-shaped site the scan can see but could not prove, with a
   * reason. A capability that leaves no literal site is outside the scan; see
   * `SCAN_CAVEAT`.
   */
  dynamic: DynamicSite[]
}

export interface ScanOptions {
  /** File path or URL, for the caller's diagnostics. Required so a scan cannot be anonymous. */
  file: string
}

type TokenKind = 'ident' | 'string' | 'template' | 'punct'

interface Token {
  kind: TokenKind
  value: string
  /** 1-based line where the token starts. */
  line: number
  /** Offset of the first character in the source. */
  start: number
  /** Offset one past the last character in the source. */
  end: number
  /**
   * Set on a template token when an interpolation contains capability-shaped
   * code. The tokenizer does not descend into template expressions, so the
   * scan reports the token instead of pretending the interpolation is empty.
   */
  embedded?: boolean
}

interface ArgumentRange {
  /** Index of the first token of the argument. */
  start: number
  /** Index one past the last token of the argument. */
  end: number
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
])

/**
 * Scan one mod's source.
 *
 * @param source the module text, read by the caller; it is never evaluated
 * @param options `file` is required and only used by the caller for diagnostics
 */
export function scanModSource(source: string, options: ScanOptions): ModScan {
  if (typeof source !== 'string') {
    throw new TypeError('scanModSource: source must be a string')
  }
  const file = (options as ScanOptions | undefined)?.file
  if (typeof file !== 'string' || file.trim() === '') {
    throw new TypeError('scanModSource: options.file must be a non-empty string')
  }

  const tokens = tokenize(source)
  const events: ModEvent[] = []
  const calls: ModCall[] = []
  const dynamic: DynamicSite[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (token.kind === 'template' && token.embedded === true) {
      addDynamic(dynamic, token.line, 'template interpolation contains capability-shaped code the lexical scan does not descend into')
      continue
    }
    if (token.kind !== 'ident') continue

    if (token.value === 'on') {
      const open = onCallOpen(tokens, index)
      if (open !== -1) scanOn(tokens, index, open, source, events, dynamic)
    } else if (token.value === '$' && !isMemberName(tokens, index)) {
      scanDollar(tokens, index, calls, dynamic)
    }
  }

  return { file, events, calls, dynamic }
}

/**
 * The capability list in the shape Claude prints before install: one sorted,
 * deduplicated `hooks:` line and one `calls:` line. `dynamic` is not folded in
 * here; a trust prompt must show `scan.dynamic` and `SCAN_CAVEAT` as well, or it
 * would present a literal list as a complete one.
 */
export function capabilityList(scan: ModScan): string[] {
  const hooks = [...new Set(scan.events.map((event) => event.name))].sort()
  const calls = [...new Set(scan.calls.map((call) => `${call.namespace}.${call.method}`))].sort()
  const line = (label: string, values: string[]): string => (values.length === 0 ? `${label}:` : `${label}: ${values.join(', ')}`)
  return [line('hooks', hooks), line('calls', calls)]
}

function isMemberName(tokens: Token[], index: number): boolean {
  return tokens[index - 1]?.value === '.'
}

/**
 * Index of the `(` that opens an `on` call, or -1 when this `on` is not a call.
 * Accepts the authored call syntax a mod may use without a transform:
 * `on(...)`, `on?.(...)`, `on<T>(...)` and `on?.<T>(...)`. The scanner reads
 * text, so a generic argument list is skipped lexically, never typechecked.
 */
function onCallOpen(tokens: Token[], index: number): number {
  const previous = tokens[index - 1]
  if (previous?.value === '.') return -1
  if (previous?.kind === 'ident' && previous.value === 'function') return -1

  let at = index + 1
  if (tokens[at]?.value === '?') {
    if (tokens[at + 1]?.value !== '.') return -1
    at += 2
  }
  if (tokens[at]?.value === '<') {
    const close = typeArgumentEnd(tokens, at)
    if (close === -1) return -1
    at = close + 1
  }
  if (tokens[at]?.value === '?') {
    if (tokens[at + 1]?.value !== '.') return -1
    at += 2
  }
  return tokens[at]?.value === '(' ? at : -1
}

/**
 * Index of the `>` that closes a simple type-argument list, or -1. Only tokens
 * that can appear in a type are accepted, so a comparison such as
 * `on < x > (y)` is not mistaken for a generic call unless its tokens also look
 * like a type. Nested generics (`on<Map<string, T>>`) are handled by depth.
 */
function typeArgumentEnd(tokens: Token[], open: number): number {
  let depth = 0
  for (let at = open; at < tokens.length; at += 1) {
    const token = tokens[at]
    if (token.value === '<') {
      depth += 1
      continue
    }
    if (token.value === '>') {
      depth -= 1
      if (depth === 0) return at
      continue
    }
    if (token.kind === 'ident') continue
    if (token.kind === 'punct' && ['[', ']', ',', '.', '|', '&', '?', ':'].includes(token.value)) continue
    return -1
  }
  return -1
}

function scanOn(tokens: Token[], index: number, open: number, source: string, events: ModEvent[], dynamic: DynamicSite[]): void {
  const line = tokens[index].line
  const { args } = readArguments(tokens, open)
  if (args.length === 0) {
    addDynamic(dynamic, line, 'on(...) has no event argument, so the scanner cannot prove what is hooked')
    return
  }

  const first = args[0]
  const firstTokens = tokens.slice(first.start, first.end)
  if (firstTokens.length !== 1 || firstTokens[0].kind !== 'string') {
    let reason = 'event name is not a single string literal, so the scanner cannot prove the event'
    if (firstTokens.length === 1 && firstTokens[0].kind === 'template') {
      reason = 'event name is a template literal with an interpolation, so the scanner cannot prove the event'
    } else if (firstTokens.length === 1 && firstTokens[0].kind === 'ident') {
      reason = 'event name is an identifier, not a string literal, so the scanner cannot prove the event'
    } else if (firstTokens.length > 1) {
      reason = 'event name is an expression, so the scanner cannot prove the event'
    }
    addDynamic(dynamic, line, reason)
    return
  }

  const event: ModEvent = { name: firstTokens[0].value, line }
  if (args.length >= 3) {
    const matcher = args[1]
    const start = tokens[matcher.start].start
    const end = tokens[matcher.end - 1].end
    event.matcher = source.slice(start, end).replace(/\s+/g, ' ').trim()
  }
  events.push(event)
}

function scanDollar(tokens: Token[], index: number, calls: ModCall[], dynamic: DynamicSite[]): void {
  const line = tokens[index].line
  let at = index + 1

  // `$.ns`, `$?.ns`, or the computed forms `$[ns]` / `$?.[ns]` / `$(ns)`.
  if (tokens[at]?.value === '?') {
    if (tokens[at + 1]?.value === '.' && tokens[at + 2]?.value === '[') {
      addDynamic(dynamic, line, 'computed namespace access $?.[...] cannot be proven by the lexical scan')
      return
    }
    if (tokens[at + 1]?.value !== '.') return
    at += 2
  } else if (tokens[at]?.value === '.') {
    at += 1
  } else if (tokens[at]?.value === '[') {
    addDynamic(dynamic, line, 'computed namespace access $[...] cannot be proven by the lexical scan')
    return
  } else if (tokens[at]?.value === '(') {
    addDynamic(dynamic, line, 'a call of $ itself cannot be proven by the lexical scan')
    return
  } else {
    return
  }

  const namespace = tokens[at]
  if (namespace?.kind !== 'ident') return
  at += 1

  // `$.ns.method`, `$.ns?.method`, or the computed form `$.ns[method]`.
  // `$.ns?.[method]` lexes as `?` `.` `[`, so the bracket is one token later.
  if (tokens[at]?.value === '?') {
    if (tokens[at + 1]?.value === '.' && tokens[at + 2]?.value === '[') {
      addDynamic(dynamic, line, `computed method name on $.${namespace.value} cannot be proven by the lexical scan`)
      return
    }
    if (tokens[at + 1]?.value !== '.') return
    at += 2
  } else if (tokens[at]?.value === '[') {
    addDynamic(dynamic, line, `computed method name on $.${namespace.value} cannot be proven by the lexical scan`)
    return
  } else if (tokens[at]?.value === '.') {
    at += 1
  } else {
    return
  }

  const method = tokens[at]
  if (method?.kind !== 'ident') return
  at += 1

  // A direct call, optionally with the optional-call operator: `m(...)` or
  // `m?.(...)`.
  if (tokens[at]?.value === '?') {
    if (tokens[at + 1]?.value !== '.') return
    at += 2
  }
  if (tokens[at]?.value !== '(') return

  calls.push({ namespace: namespace.value, method: method.value, line })
}

/** Split a call's argument list into token ranges. Brackets of any kind nest. */
function readArguments(tokens: Token[], open: number): { args: ArgumentRange[] } {
  const args: ArgumentRange[] = []
  let depth = 0
  let start = open + 1

  for (let index = open; index < tokens.length; index += 1) {
    const value = tokens[index].value
    if (value === '(' || value === '[' || value === '{') {
      depth += 1
      continue
    }
    if (value === ')' || value === ']' || value === '}') {
      depth -= 1
      if (depth === 0) {
        if (index > start) args.push({ start, end: index })
        return { args }
      }
      continue
    }
    if (value === ',' && depth === 1) {
      if (index > start) args.push({ start, end: index })
      start = index + 1
    }
  }

  return { args }
}

function addDynamic(dynamic: DynamicSite[], line: number, reason: string): void {
  if (!dynamic.some((site) => site.line === line && site.reason === reason)) {
    dynamic.push({ line, reason })
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let line = 1

  while (index < source.length) {
    const ch = source[index]

    if (ch === '\n') {
      line += 1
      index += 1
      continue
    }
    if (/\s/.test(ch)) {
      index += 1
      continue
    }

    if (ch === '/' && source[index + 1] === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1
        index += 1
      }
      index = Math.min(index + 2, source.length)
      continue
    }

    if (ch === "'" || ch === '"') {
      const string = readString(source, index, ch, line)
      tokens.push(string.token)
      index = string.index
      line = string.line
      continue
    }

    if (ch === '`') {
      const template = readTemplate(source, index, line)
      tokens.push(template.token)
      index = template.index
      line = template.line
      continue
    }

    if (ch === '/' && regexAllowed(tokens[tokens.length - 1])) {
      const regex = readRegex(source, index, line)
      tokens.push({ kind: 'punct', value: 'regex', line, start: index, end: regex.index })
      index = regex.index
      line = regex.line
      continue
    }

    if (isIdentifierStart(ch)) {
      const start = index
      index += 1
      while (index < source.length && isIdentifierPart(source[index])) index += 1
      tokens.push({ kind: 'ident', value: source.slice(start, index), line, start, end: index })
      continue
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[index + 1]))) {
      const start = index
      index += 1
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index])) index += 1
      tokens.push({ kind: 'punct', value: 'number', line, start, end: index })
      continue
    }

    tokens.push({ kind: 'punct', value: ch, line, start: index, end: index + 1 })
    index += 1
  }

  return tokens
}

function readString(source: string, start: number, quote: string, line: number): { token: Token; index: number; line: number } {
  const startLine = line
  let index = start + 1
  let value = ''

  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      if (source[index + 1] === '\n') {
        line += 1
        index += 2
        continue
      }
      const escape = readEscape(source, index)
      value += escape.value
      index = escape.index
      continue
    }
    if (ch === quote) {
      index += 1
      break
    }
    if (ch === '\n') line += 1
    value += ch
    index += 1
  }

  return { token: { kind: 'string', value, line: startLine, start, end: index }, index, line }
}

function readTemplate(source: string, start: number, line: number): { token: Token; index: number; line: number } {
  const startLine = line
  let index = start + 1
  let value = ''
  let interpolated = false
  let embedded = false

  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      if (source[index + 1] === '\n') {
        line += 1
        index += 2
        continue
      }
      const escape = readEscape(source, index)
      value += escape.value
      index = escape.index
      continue
    }
    if (ch === '`') {
      index += 1
      break
    }
    if (ch === '$' && source[index + 1] === '{') {
      interpolated = true
      const skipped = skipInterpolation(source, index + 2, line)
      const raw = source.slice(index + 2, skipped.index - 1)
      if (/\bon\s*\(|\$\s*(?:\.|\[|\()/.test(raw)) embedded = true
      index = skipped.index
      line = skipped.line
      continue
    }
    if (ch === '\n') line += 1
    value += ch
    index += 1
  }

  return {
    token: {
      kind: interpolated ? 'template' : 'string',
      value,
      line: startLine,
      start,
      end: index,
      ...(embedded ? { embedded: true } : {}),
    },
    index,
    line,
  }
}

function skipInterpolation(source: string, start: number, line: number): { index: number; line: number } {
  let index = start
  let depth = 1

  while (index < source.length) {
    const ch = source[index]
    if (ch === '\n') {
      line += 1
      index += 1
      continue
    }
    if (ch === '\\') {
      index += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const skipped = skipQuoted(source, index, ch, line)
      index = skipped.index
      line = skipped.line
      continue
    }
    if (ch === '`') {
      const skipped = skipTemplate(source, index, line)
      index = skipped.index
      line = skipped.line
      continue
    }
    if (ch === '/' && source[index + 1] === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1
        index += 1
      }
      index = Math.min(index + 2, source.length)
      continue
    }
    if (ch === '{') {
      depth += 1
      index += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      index += 1
      if (depth === 0) return { index, line }
      continue
    }
    index += 1
  }

  return { index, line }
}

function skipQuoted(source: string, start: number, quote: string, line: number): { index: number; line: number } {
  let index = start + 1
  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      if (source[index + 1] === '\n') line += 1
      index += 2
      continue
    }
    if (ch === quote) {
      index += 1
      break
    }
    if (ch === '\n') line += 1
    index += 1
  }
  return { index, line }
}

function skipTemplate(source: string, start: number, line: number): { index: number; line: number } {
  let index = start + 1
  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      if (source[index + 1] === '\n') line += 1
      index += 2
      continue
    }
    if (ch === '`') {
      index += 1
      break
    }
    if (ch === '$' && source[index + 1] === '{') {
      const skipped = skipInterpolation(source, index + 2, line)
      index = skipped.index
      line = skipped.line
      continue
    }
    if (ch === '\n') line += 1
    index += 1
  }
  return { index, line }
}

function readRegex(source: string, start: number, line: number): { index: number; line: number } {
  let index = start + 1
  let inClass = false

  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      index += 2
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      index += 1
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1
      return { index, line }
    } else if (ch === '\n') {
      line += 1
    }
    index += 1
  }

  return { index, line }
}

function readEscape(source: string, index: number): { value: string; index: number } {
  const ch = source[index + 1]
  switch (ch) {
    case 'n':
      return { value: '\n', index: index + 2 }
    case 'r':
      return { value: '\r', index: index + 2 }
    case 't':
      return { value: '\t', index: index + 2 }
    case 'b':
      return { value: '\b', index: index + 2 }
    case 'f':
      return { value: '\f', index: index + 2 }
    case 'v':
      return { value: '\v', index: index + 2 }
    case '0':
      return { value: '\0', index: index + 2 }
    case 'x': {
      const hex = source.slice(index + 2, index + 4)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) return { value: String.fromCharCode(Number.parseInt(hex, 16)), index: index + 4 }
      break
    }
    case 'u': {
      if (source[index + 2] === '{') {
        const close = source.indexOf('}', index + 3)
        if (close !== -1) {
          const hex = source.slice(index + 3, close)
          if (/^[0-9A-Fa-f]+$/.test(hex)) {
            const code = Number.parseInt(hex, 16)
            if (code <= 0x10ffff) return { value: String.fromCodePoint(code), index: close + 1 }
          }
        }
      } else {
        const hex = source.slice(index + 2, index + 6)
        if (/^[0-9A-Fa-f]{4}$/.test(hex)) return { value: String.fromCharCode(Number.parseInt(hex, 16)), index: index + 6 }
      }
      break
    }
    default:
      break
  }
  return { value: ch ?? '', index: Math.min(index + 2, source.length) }
}

function regexAllowed(previous: Token | undefined): boolean {
  if (previous === undefined) return true
  if (previous.kind === 'ident') return REGEX_PRECEDING_KEYWORDS.has(previous.value)
  if (previous.kind === 'string' || previous.kind === 'template') return false
  return previous.value !== ')' && previous.value !== ']' && previous.value !== '}'
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$'
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch)
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}
