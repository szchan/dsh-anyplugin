#!/usr/bin/env node
// Measure the mod API: what the pinned declaration declares, what this host
// actually serves, and what is absent between the two (#130).
//
// The denominator is the generated `claude-code.d.ts` at the fetched pin
// (AGENTS §3.9: that file is the specification; docs are commentary). We read
// it as text with a small scanner. It is 895,875 bytes at 2.1.329 and importing
// it would only prove that TypeScript can parse it, not that the symbols we
// count are the symbols a mod author can call.
//
// `served` is derived by calling the host's `$` factory and inspecting the
// table it returns. Nothing here executes a mod, and no symbol is counted
// because a string appears somewhere in our source: a bridge method that is
// removed changes the runtime table, and the ledger test fails.
//
// This is a denominator, not a fidelity claim. A name in `served` says the
// method is reachable; it does not say the method behaves like the pin's. The
// fidelity classes live in the IR annotations (AGENTS §3.1), and this script
// never assigns one.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createModBridge } from '../packages/dsh-anyplugin-mod-host/src/bridge.ts'
import { UI_COMPONENTS, UI_SURFACES, elementsForSurface } from '../packages/dsh-anyplugin-mod-host/src/ui.ts'
import { MOD_EVENT_ROUTES } from '../packages/dsh-anyplugin-intercept/src/mod-events.ts'
import { UPSTREAM_MODS_PIN } from '../packages/dsh-anyplugin-mod-host/src/pin.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ledgerPath = join(repoRoot, 'fixtures', 'mods', 'coverage.json')
const declarationRelative = join('mods', 'types', 'claude-code.d.ts')

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (values) => [...values].sort(compareStrings)

// ---- a scanner for declaration text ---------------------------------------

class Scanner {
  constructor(text, pos = 0) {
    this.text = text
    this.pos = pos
    this.len = text.length
  }

  eof() {
    return this.pos >= this.len
  }

  peek(n = 0) {
    return this.text[this.pos + n]
  }

  startsWith(value) {
    return this.text.startsWith(value, this.pos)
  }

  advance(n = 1) {
    this.pos += n
  }

  skipTrivia() {
    for (;;) {
      const c = this.text[this.pos]
      if (c === undefined) return
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++
        continue
      }
      if (c === '/' && this.text[this.pos + 1] === '/') {
        this.pos += 2
        while (this.pos < this.len && this.text[this.pos] !== '\n') this.pos++
        continue
      }
      if (c === '/' && this.text[this.pos + 1] === '*') {
        const end = this.text.indexOf('*/', this.pos + 2)
        this.pos = end === -1 ? this.len : end + 2
        continue
      }
      return
    }
  }

  readIdentifier() {
    const start = this.pos
    if (!/[A-Za-z_$]/.test(this.text[this.pos] ?? '')) return undefined
    this.pos++
    while (this.pos < this.len && /[A-Za-z0-9_$]/.test(this.text[this.pos])) this.pos++
    return this.text.slice(start, this.pos)
  }

  readString() {
    const quote = this.text[this.pos]
    if (quote !== "'" && quote !== '"') return undefined
    const start = this.pos
    this.pos++
    let value = ''
    while (this.pos < this.len) {
      const c = this.text[this.pos]
      if (c === '\\') {
        value += this.text[this.pos + 1] ?? ''
        this.pos += 2
        continue
      }
      if (c === quote) {
        this.pos++
        return { value, raw: this.text.slice(start, this.pos) }
      }
      value += c
      this.pos++
    }
    return undefined
  }

  // A template literal, including `${...}` nests. Type-level templates keep
  // their `${}` text as it is; only the extent matters to the caller.
  skipTemplate() {
    this.pos++ // opening backtick
    while (this.pos < this.len) {
      const c = this.text[this.pos]
      if (c === '\\') {
        this.pos += 2
        continue
      }
      if (c === '`') {
        this.pos++
        return
      }
      if (c === '$' && this.text[this.pos + 1] === '{') {
        this.pos += 2
        let depth = 1
        while (this.pos < this.len && depth > 0) {
          const d = this.text[this.pos]
          if (d === '\\') {
            this.pos += 2
            continue
          }
          if (d === '{') depth++
          else if (d === '}') depth--
          else if (d === '`') this.skipTemplate()
          else if (d === "'" || d === '"') this.readString()
          else this.pos++
        }
        continue
      }
      this.pos++
    }
  }

  // Read a type expression up to the member/declaration boundary: `;` or `}`
  // at depth zero. Braces, parens and brackets are tracked; quotes, templates
  // and comments are skipped so prose in a JSDoc cannot end a type.
  readTypeText() {
    const start = this.pos
    let brace = 0
    let paren = 0
    let bracket = 0
    while (this.pos < this.len) {
      const c = this.text[this.pos]
      if (c === "'" || c === '"') {
        this.readString()
        continue
      }
      if (c === '`') {
        this.skipTemplate()
        continue
      }
      if (c === '/' && this.text[this.pos + 1] === '/') {
        this.skipTrivia()
        continue
      }
      if (c === '/' && this.text[this.pos + 1] === '*') {
        this.skipTrivia()
        continue
      }
      if (c === '{') brace++
      else if (c === '}') {
        if (brace === 0 && paren === 0 && bracket === 0) break
        brace--
      } else if (c === '(') paren++
      else if (c === ')') paren--
      else if (c === '[') bracket++
      else if (c === ']') bracket--
      else if (c === ';' && brace === 0 && paren === 0 && bracket === 0) break
      this.pos++
    }
    return this.text.slice(start, this.pos).trim()
  }
}

const closerOf = (open) => (open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : undefined)

/** The index of the bracket that closes `start`, or -1. Comments/strings skipped. */
function matchingIndex(text, start) {
  const open = text[start]
  const close = closerOf(open)
  if (close === undefined) return -1
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === "'" || c === '"') {
      const scanner = new Scanner(text, i)
      scanner.readString()
      i = scanner.pos - 1
      continue
    }
    if (c === '`') {
      const scanner = new Scanner(text, i)
      scanner.skipTemplate()
      i = scanner.pos - 1
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** The index of the `>` that closes a generic parameter list, or -1. */
function matchingAngle(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"') {
      const scanner = new Scanner(text, i)
      scanner.readString()
      i = scanner.pos - 1
      continue
    }
    if (c === '<' && text[i - 1] !== '=') depth++
    else if (c === '>' && text[i - 1] !== '=') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split on a top-level separator, ignoring nested brackets, comments and strings. */
function splitTopLevel(text, separator) {
  const parts = []
  let start = 0
  let angle = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === "'" || c === '"') {
      const scanner = new Scanner(text, i)
      scanner.readString()
      i = scanner.pos - 1
      continue
    }
    if (c === '`') {
      const scanner = new Scanner(text, i)
      scanner.skipTemplate()
      i = scanner.pos - 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      const close = matchingIndex(text, i)
      if (close === -1) return [text]
      i = close
      continue
    }
    if (c === '<') {
      const previous = text.slice(0, i).trimEnd().slice(-1)
      if (/[A-Za-z0-9_$>)]/.test(previous) && text[i + 1] !== '=') angle++
      continue
    }
    if (c === '>' && angle > 0 && text[i - 1] !== '=') {
      angle--
      continue
    }
    if (angle === 0 && c === separator) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

const unquote = (value) => {
  const t = value.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1)
  }
  return t
}

// ---- the declaration index ------------------------------------------------

const MODULE_MARKER = /^declare module 'claude-code' \{/m

function indexDeclarations(text) {
  const match = MODULE_MARKER.exec(text)
  if (match === null) throw new Error('mod-coverage: the declaration has no `declare module \'claude-code\'` block')
  const scanner = new Scanner(text, match.index + match[0].length)
  const declarations = new Map()

  const skipUnknown = () => {
    let depth = 0
    while (!scanner.eof()) {
      const c = scanner.peek()
      if (c === '/' && scanner.peek(1) === '/') {
        scanner.advance(2)
        while (!scanner.eof() && scanner.peek() !== '\n') scanner.advance()
        continue
      }
      if (c === '/' && scanner.peek(1) === '*') {
        const end = text.indexOf('*/', scanner.pos + 2)
        scanner.pos = end === -1 ? text.length : end + 2
        continue
      }
      if (c === "'" || c === '"') {
        scanner.readString()
        continue
      }
      if (c === '`') {
        scanner.skipTemplate()
        continue
      }
      if (c === '{') depth++
      else if (c === '}') {
        if (depth === 0) return
        depth--
      } else if (c === ';' && depth === 0) {
        scanner.advance()
        return
      }
      scanner.advance()
    }
  }

  for (;;) {
    scanner.skipTrivia()
    if (scanner.eof()) break
    if (scanner.peek() === '}') break

    if (scanner.startsWith('export')) {
      const save = scanner.pos
      scanner.advance(6)
      if (scanner.peek() === ' ' || scanner.peek() === '\n' || scanner.peek() === '\t') {
        scanner.skipTrivia()
      } else {
        scanner.pos = save
      }
    }
    if (scanner.startsWith('declare')) {
      const save = scanner.pos
      scanner.advance(7)
      if (scanner.peek() === ' ' || scanner.peek() === '\n' || scanner.peek() === '\t') {
        scanner.skipTrivia()
      } else {
        scanner.pos = save
      }
    }

    if (scanner.startsWith('interface')) {
      scanner.advance(9)
      scanner.skipTrivia()
      const name = scanner.readIdentifier()
      if (name === undefined) {
        skipUnknown()
        continue
      }
      // `extends` may carry generics; skip to the body brace.
      while (!scanner.eof() && scanner.peek() !== '{') {
        if (scanner.peek() === "'" || scanner.peek() === '"') scanner.readString()
        else if (scanner.peek() === '`') scanner.skipTemplate()
        else scanner.advance()
      }
      if (scanner.eof()) break
      const bodyStart = scanner.pos + 1
      const bodyEnd = matchingIndex(text, scanner.pos)
      if (bodyEnd === -1) throw new Error(`mod-coverage: unterminated interface ${name}`)
      declarations.set(name, { kind: 'interface', bodyStart, bodyEnd })
      scanner.pos = bodyEnd + 1
      continue
    }

    if (scanner.startsWith('type')) {
      scanner.advance(4)
      scanner.skipTrivia()
      const name = scanner.readIdentifier()
      if (name === undefined) {
        skipUnknown()
        continue
      }
      while (!scanner.eof() && scanner.peek() !== '=') {
        if (scanner.peek() === '<') {
          const close = matchingAngle(text, scanner.pos)
          if (close === -1) break
          scanner.pos = close + 1
          continue
        }
        scanner.advance()
      }
      if (scanner.eof()) break
      scanner.advance() // =
      scanner.skipTrivia()
      const type = scanner.readTypeText()
      declarations.set(name, { kind: 'type', type })
      if (scanner.peek() === ';') scanner.advance()
      continue
    }

    skipUnknown()
  }

  return declarations
}

// ---- parsing members and deciding callability ------------------------------

let declarations = new Map()
let declarationText = ''

function declaredType(name) {
  const declaration = declarations.get(name)
  if (declaration === undefined) return undefined
  if (declaration.kind === 'type') return declaration.type
  return `{${declarationText.slice(declaration.bodyStart, declaration.bodyEnd)}}`
}

function parseMembers(typeText) {
  const text = typeText.trim()
  if (!text.startsWith('{')) return []
  const scanner = new Scanner(text)
  scanner.advance() // {
  const members = []

  for (;;) {
    scanner.skipTrivia()
    if (scanner.eof() || scanner.peek() === '}') break
    if (scanner.peek() === ';' || scanner.peek() === ',') {
      scanner.advance()
      continue
    }
    // A call signature or construct signature has no member name.
    if (scanner.peek() === '(' || scanner.peek() === '<' || scanner.startsWith('new ')) {
      scanner.readTypeText()
      members.push({ name: undefined, kind: 'call', type: '', callable: true })
      if (scanner.peek() === ';') scanner.advance()
      continue
    }
    if (scanner.peek() === '[') {
      scanner.readTypeText()
      if (scanner.peek() === ';') scanner.advance()
      continue
    }

    let readonly = false
    const save = scanner.pos
    const modifier = scanner.readIdentifier()
    if (modifier === 'readonly') {
      readonly = true
      scanner.skipTrivia()
    } else {
      scanner.pos = save
    }

    let name
    if (scanner.peek() === "'" || scanner.peek() === '"') {
      const literal = scanner.readString()
      name = literal?.value
    } else if (scanner.peek() === '[') {
      scanner.readTypeText()
      if (scanner.peek() === ';') scanner.advance()
      continue
    } else {
      name = scanner.readIdentifier()
    }
    if (name === undefined) {
      // Not a member shape we can name; consume one unit so the loop advances.
      scanner.readTypeText()
      if (scanner.peek() === ';') scanner.advance()
      continue
    }
    scanner.skipTrivia()
    let optional = false
    if (scanner.peek() === '?') {
      optional = true
      scanner.advance()
      scanner.skipTrivia()
    }
    if (scanner.peek() !== ':') {
      // Method signature `name<T>(...): R` with no property colon.
      if (scanner.peek() === '(' || scanner.peek() === '<') {
        scanner.readTypeText()
        members.push({ name, kind: 'method', type: '', callable: true, readonly, optional })
        if (scanner.peek() === ';') scanner.advance()
        continue
      }
      while (!scanner.eof() && scanner.peek() !== ';' && scanner.peek() !== '}') scanner.advance()
      if (scanner.peek() === ';') scanner.advance()
      continue
    }
    scanner.advance() // :
    const type = scanner.readTypeText()
    members.push({ name, kind: 'property', type, callable: undefined, readonly, optional })
    if (scanner.peek() === ';') scanner.advance()
  }

  return members
}

function hasCallSignature(typeText) {
  const text = typeText.trim()
  if (!text.startsWith('{')) return false
  const scanner = new Scanner(text)
  scanner.advance() // {
  for (;;) {
    scanner.skipTrivia()
    if (scanner.eof() || scanner.peek() === '}') return false
    if (scanner.peek() === '(' || scanner.peek() === '<') return true
    if (scanner.startsWith('new')) {
      let cursor = scanner.pos + 3
      while (/\s/.test(text[cursor] ?? '')) cursor++
      if (text[cursor] === '(') return true
    }
    scanner.readTypeText()
    if (scanner.peek() === ';') scanner.advance()
  }
}

function parseIndexedAccess(typeText) {
  const text = typeText.trim()
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(\[[\s\S]+\])$/.exec(text)
  if (match === null) return undefined
  const keys = []
  let cursor = 0
  const brackets = match[2]
  while (cursor < brackets.length) {
    if (brackets[cursor] !== '[') return undefined
    const close = matchingIndex(brackets, cursor)
    if (close === -1) return undefined
    keys.push(unquote(brackets.slice(cursor + 1, close)))
    cursor = close + 1
    while (/\s/.test(brackets[cursor] ?? '')) cursor++
  }
  return { base: match[1], keys }
}

function memberType(typeText, key) {
  const text = typeText.trim()
  if (text.startsWith('{')) {
    const member = parseMembers(text).find((entry) => entry.name === key)
    return member?.type
  }
  for (const part of splitTopLevel(text, '|')) {
    const textPart = part.trim()
    if (textPart === '') continue
    if (textPart.startsWith('{')) {
      const member = parseMembers(textPart).find((entry) => entry.name === key)
      if (member !== undefined) return member.type
      continue
    }
    const resolved = declaredType(textPart.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0] ?? '')
    if (resolved !== undefined) {
      const member = memberType(resolved, key)
      if (member !== undefined) return member
    }
  }
  for (const part of splitTopLevel(text, '&')) {
    const textPart = part.trim()
    if (textPart === '' || textPart === text) continue
    const member = memberType(textPart, key)
    if (member !== undefined) return member
  }
  const name = text.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0]
  if (name !== undefined) {
    const resolved = declaredType(name)
    if (resolved !== undefined && resolved !== text) return memberType(resolved, key)
  }
  return undefined
}

function resolveIndexedAccess(typeText) {
  const access = parseIndexedAccess(typeText)
  if (access === undefined) return undefined
  let current = declaredType(access.base)
  if (current === undefined) return undefined
  for (const key of access.keys) {
    const next = memberType(current, key)
    if (next === undefined) return undefined
    current = next
  }
  return current
}

function isCallable(typeText, seen = new Set()) {
  const original = typeText.trim()
  if (original === '' || seen.size > 80) return false

  for (const part of splitTopLevel(original, '|')) {
    if (part.trim() !== original && isCallable(part, seen)) return true
  }
  for (const part of splitTopLevel(original, '&')) {
    if (part.trim() !== original && isCallable(part, seen)) return true
  }

  let text = original
  while (text.startsWith('(') && matchingIndex(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim()
  }
  if (text.startsWith('<')) {
    const close = matchingAngle(text, 0)
    if (close === -1) return false
    text = text.slice(close + 1).trim()
  }
  if (text.startsWith('new ') || text.startsWith('new(')) return true
  if (text.startsWith('(')) {
    const close = matchingIndex(text, 0)
    if (close === -1) return false
    return text.slice(close + 1).trimStart().startsWith('=>')
  }
  if (text.startsWith('{')) return hasCallSignature(text)

  if (parseIndexedAccess(text) !== undefined) {
    if (seen.has(text)) return false
    seen.add(text)
    const resolved = resolveIndexedAccess(text)
    return resolved !== undefined && resolved !== text ? isCallable(resolved, seen) : false
  }

  const name = text.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0]
  if (name === undefined || seen.has(name)) return false
  const declaration = declarations.get(name)
  if (declaration === undefined) return false
  seen.add(name)
  if (declaration.kind === 'interface') {
    return hasCallSignature(`{${declarationText.slice(declaration.bodyStart, declaration.bodyEnd)}}`)
  }
  return isCallable(declaration.type, seen)
}

// Resolve a property's callability once; `parseMembers` stores the raw type so
// a later resolution is not required to know the declaration table order.
function memberIsCallable(member) {
  if (member.kind === 'call' || member.kind === 'method') return true
  return isCallable(member.type)
}

// ---- extract the declared surface -----------------------------------------

function hookEventLiteral(typeText, seen = new Set()) {
  let text = typeText.trim()
  while (text.startsWith('(') && matchingIndex(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim()
  }
  if (seen.has(text)) return undefined
  seen.add(text)
  for (const intersection of splitTopLevel(text, '&')) {
    let part = intersection.trim()
    while (part.startsWith('(') && matchingIndex(part, 0) === part.length - 1) {
      part = part.slice(1, -1).trim()
    }
    if (part.startsWith('{')) {
      const member = parseMembers(part).find((entry) => entry.name === 'hook_event_name')
      if (member === undefined) continue
      const value = unquote(member.type)
      if (value !== member.type) return value
      continue
    }
    const nested = hookEventLiteral(part, seen)
    if (nested !== undefined) return nested
  }
  const name = text.match(/^[A-Za-z_$][A-Za-z0-9_$]*$/)?.[0]
  if (name !== undefined) {
    const declaration = declarations.get(name)
    if (declaration !== undefined && declaration.kind === 'type') return hookEventLiteral(declaration.type, seen)
  }
  return undefined
}

function extractEvents() {
  const engineDeclaration = declarations.get('EngineEventOf')
  const opDeclaration = declarations.get('OpEventOf')
  if (engineDeclaration === undefined || engineDeclaration.kind !== 'type') {
    throw new Error('mod-coverage: EngineEventOf is not a type alias')
  }
  if (opDeclaration === undefined || opDeclaration.kind !== 'type') {
    throw new Error('mod-coverage: OpEventOf is not a type alias')
  }
  const engine = parseMembers(engineDeclaration.type).map((member) => member.name).filter(Boolean)
  const op = parseMembers(opDeclaration.type).map((member) => member.name).filter(Boolean)

  const hookInput = declarations.get('HookInput')
  if (hookInput === undefined || hookInput.kind !== 'type') {
    throw new Error('mod-coverage: HookInput is not a type alias')
  }
  const classic = []
  for (const part of splitTopLevel(hookInput.type, '|')) {
    const alias = part.trim()
    if (alias === '') continue
    const declaration = declarations.get(alias)
    if (declaration === undefined || declaration.kind !== 'type') {
      throw new Error(`mod-coverage: hook union member ${alias} is not a type alias`)
    }
    const literal = hookEventLiteral(declaration.type)
    if (literal === undefined) throw new Error(`mod-coverage: ${alias} has no hook_event_name literal`)
    classic.push(literal)
  }

  return {
    engine: sorted(engine),
    op: sorted(op),
    classic: sorted(classic),
    classicSpellings: sorted(classic.map((event) => `classic.${event}`)),
  }
}

function extractEngine() {
  const core = declarations.get('CoreEngineInterface')
  if (core === undefined || core.kind !== 'interface') {
    throw new Error('mod-coverage: CoreEngineInterface is not an interface')
  }
  const namespaces = parseMembers(`{${declarationText.slice(core.bodyStart, core.bodyEnd)}}`)
    .filter((member) => member.name !== undefined)
    .map((member) => member.name)
    .filter(Boolean)

  const methods = []
  const properties = []
  for (const namespace of namespaces) {
    const declaration = declarations.get(namespace)
    if (declaration === undefined || declaration.kind !== 'interface') {
      // The namespace type is an inline object in CoreEngineInterface. Resolve
      // it from the member list rather than assuming a named interface.
      const coreMember = parseMembers(`{${declarationText.slice(core.bodyStart, core.bodyEnd)}}`).find(
        (member) => member.name === namespace,
      )
      if (coreMember === undefined) continue
      for (const member of parseMembers(coreMember.type)) {
        if (member.name === undefined) continue
        if (memberIsCallable(member)) methods.push(`${namespace}.${member.name}`)
        else properties.push(`${namespace}.${member.name}`)
      }
      continue
    }
    for (const member of parseMembers(`{${declarationText.slice(declaration.bodyStart, declaration.bodyEnd)}}`)) {
      if (member.name === undefined) continue
      if (memberIsCallable(member)) methods.push(`${namespace}.${member.name}`)
      else properties.push(`${namespace}.${member.name}`)
    }
  }

  return {
    namespaces: sorted([...new Set(namespaces)]),
    methods: sorted([...new Set(methods)]),
    properties: sorted([...new Set(properties)]),
  }
}

function extractElements() {
  const elements = declarations.get('Elements')
  if (elements === undefined || elements.kind !== 'interface') {
    throw new Error('mod-coverage: Elements is not an interface')
  }
  const surfaces = parseMembers(`{${declarationText.slice(elements.bodyStart, elements.bodyEnd)}}`)
  const tables = {}
  const unique = new Set()
  let surfaceQualified = 0
  for (const surface of surfaces) {
    if (surface.name === undefined) continue
    const names = parseMembers(surface.type)
      .map((member) => member.name)
      .filter(Boolean)
    tables[surface.name] = sorted(names)
    surfaceQualified += names.length
    for (const name of names) unique.add(name)
  }
  return { tables, surfaceQualified, unique: sorted(unique) }
}

function extractRenderSites() {
  const declaration = declarations.get('RenderComponent')
  if (declaration === undefined || declaration.kind !== 'type') {
    throw new Error('mod-coverage: RenderComponent is not a type alias')
  }
  return sorted(splitTopLevel(declaration.type, '|').map((part) => unquote(part)).filter(Boolean))
}

function extractMatchers() {
  const names = [...declarations.entries()]
    .filter(([name, declaration]) => declaration.kind === 'type' && (name.startsWith('Matcher') || name === 'OpenMatcher'))
    .map(([name]) => name)
  return sorted(names)
}

function extractDeclared() {
  const events = extractEvents()
  const engine = extractEngine()
  const elements = extractElements()
  return {
    namespaces: engine.namespaces,
    methods: engine.methods,
    properties: engine.properties,
    events: {
      engine: events.engine,
      op: events.op,
      classic: events.classic,
      classicSpellings: events.classicSpellings,
      declaredTotal: events.engine.length + events.op.length + events.classicSpellings.length,
      note:
        'declaredTotal counts EngineEventOf + OpEventOf + the `classic.<Event>` spellings of ClassicHookEvent. ' +
        'The bare ClassicHookEvent names are the source of those 33 spellings and are not counted a second time.',
    },
    elements: {
      surfaces: elements.tables,
      surfaceQualified: elements.surfaceQualified,
      unique: elements.unique,
    },
    renderSites: extractRenderSites(),
    matchers: extractMatchers(),
  }
}

// ---- the served surface, from the runtime ---------------------------------

function extractServed() {
  const bridge = createModBridge({ plugin: 'mod-coverage', dataDir: '', warn: () => {} })
  const methods = []
  const properties = []
  const namespaces = new Set()
  try {
    const table = bridge.dollar()
    for (const namespace of Object.keys(table)) {
      const value = table[namespace]
      if (value === null || typeof value !== 'object') continue
      namespaces.add(namespace)
      for (const [name, method] of Object.entries(value)) {
        if (typeof method === 'function') methods.push(`${namespace}.${name}`)
        else properties.push(`${namespace}.${name}`)
      }
    }
  } finally {
    bridge.dispose()
  }

  const elements = {}
  for (const surface of UI_SURFACES) {
    elements[surface] = sorted(Object.keys(elementsForSurface(surface, 'mod-coverage')))
  }

  const events = MOD_EVENT_ROUTES.filter((route) => route.status === 'live')
    .map((route) => route.modEvent)
    .filter(Boolean)

  return {
    namespaces: sorted(namespaces),
    methods: sorted([...new Set(methods)]),
    properties: sorted([...new Set(properties)]),
    events: sorted([...new Set(events)]),
    elements,
    renderSites: sorted(UI_COMPONENTS),
  }
}

// ---- the ledger -----------------------------------------------------------

const setDifference = (left, right) => {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function buildLedger(declaration) {
  const declared = extractDeclared()
  const served = extractServed()

  const declaredEvents = [...declared.events.engine, ...declared.events.op, ...declared.events.classicSpellings]
  const servedElementNames = Object.values(served.elements).flat()
  const declaredElementNames = Object.values(declared.elements.surfaces).flat()

  const absent = {
    methods: setDifference(declared.methods, served.methods),
    properties: setDifference(declared.properties, served.properties),
    events: sorted(setDifference(declaredEvents, served.events)),
    elements: sorted(setDifference(declaredElementNames, servedElementNames)),
    renderSites: setDifference(declared.renderSites, served.renderSites),
  }

  const shapeMismatches = []
  for (const name of declared.methods) {
    if (served.properties.includes(name)) shapeMismatches.push({ name, declared: 'method', served: 'property' })
  }
  for (const name of declared.properties) {
    if (served.methods.includes(name)) shapeMismatches.push({ name, declared: 'property', served: 'method' })
  }

  return {
    pin: {
      version: UPSTREAM_MODS_PIN.version,
      commit: UPSTREAM_MODS_PIN.commit,
      file: declarationRelative.split('\\').join('/'),
      bytes: declaration.bytes,
      sha256: declaration.sha256,
    },
    declared,
    served,
    absent,
    shapeMismatches: shapeMismatches.sort((a, b) => compareStrings(a.name, b.name)),
    totals: {
      namespaces: {
        declared: declared.namespaces.length,
        served: served.namespaces.length,
        absent: setDifference(declared.namespaces, served.namespaces).length,
      },
      methods: {
        declared: declared.methods.length,
        served: served.methods.length,
        absent: absent.methods.length,
      },
      properties: {
        declared: declared.properties.length,
        served: served.properties.length,
        absent: absent.properties.length,
      },
      events: {
        declared: declared.events.declaredTotal,
        served: served.events.length,
        absent: absent.events.length,
      },
      elements: {
        declared: declared.elements.surfaceQualified,
        served: servedElementNames.length,
        absent: absent.elements.length,
        unique: declared.elements.unique.length,
      },
      renderSites: {
        declared: declared.renderSites.length,
        served: served.renderSites.length,
        absent: absent.renderSites.length,
      },
      matchers: {
        declared: declared.matchers.length,
        served: null,
        absent: null,
        note: 'No named runtime matcher-type surface: matching is behavioural (value grammar + event patterns), so this category has no served/absent set.',
      },
    },
  }
}

/** Return human-readable drift entries between a committed ledger and a live one. */
export function diffLedger(committed, live) {
  const changes = []
  const compareList = (label, left, right) => {
    const missing = setDifference(left, right)
    const extra = setDifference(right, left)
    if (missing.length > 0) changes.push(`${label}: missing ${missing.length} (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''})`)
    if (extra.length > 0) changes.push(`${label}: extra ${extra.length} (${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ', …' : ''})`)
  }
  if (committed.pin?.sha256 !== live.pin.sha256) {
    changes.push(`pin sha256: ${committed.pin?.sha256 ?? 'absent'} -> ${live.pin.sha256}`)
  }
  if (committed.pin?.commit !== live.pin.commit) {
    changes.push(`pin commit: ${committed.pin?.commit ?? 'absent'} -> ${live.pin.commit}`)
  }
  compareList('declared.namespaces', committed.declared?.namespaces ?? [], live.declared.namespaces)
  compareList('served.namespaces', committed.served?.namespaces ?? [], live.served.namespaces)
  compareList('declared.methods', committed.declared?.methods ?? [], live.declared.methods)
  compareList('declared.properties', committed.declared?.properties ?? [], live.declared.properties)
  compareList('served.methods', committed.served?.methods ?? [], live.served.methods)
  compareList('served.properties', committed.served?.properties ?? [], live.served.properties)
  compareList('absent.methods', committed.absent?.methods ?? [], live.absent.methods)
  compareList('absent.properties', committed.absent?.properties ?? [], live.absent.properties)
  compareList('served.events', committed.served?.events ?? [], live.served.events)
  compareList('absent.events', committed.absent?.events ?? [], live.absent.events)
  const committedEvents = committed.declared?.events
  const liveEvents = live.declared.events
  compareList('events.engine', committedEvents?.engine ?? [], liveEvents.engine)
  compareList('events.op', committedEvents?.op ?? [], liveEvents.op)
  compareList('events.classic', committedEvents?.classicSpellings ?? [], liveEvents.classicSpellings)
  for (const surface of Object.keys(live.declared.elements.surfaces)) {
    compareList(
      `elements.${surface}`,
      committed.declared?.elements?.surfaces?.[surface] ?? [],
      live.declared.elements.surfaces[surface],
    )
  }
  for (const surface of Object.keys(live.served.elements)) {
    compareList(
      `served.elements.${surface}`,
      committed.served?.elements?.[surface] ?? [],
      live.served.elements[surface],
    )
  }
  compareList('renderSites', committed.declared?.renderSites ?? [], live.declared.renderSites)
  compareList('served.renderSites', committed.served?.renderSites ?? [], live.served.renderSites)
  compareList('matchers', committed.declared?.matchers ?? [], live.declared.matchers)
  if (JSON.stringify(committed.shapeMismatches ?? []) !== JSON.stringify(live.shapeMismatches)) {
    changes.push(`shapeMismatches: ${JSON.stringify(committed.shapeMismatches ?? [])} -> ${JSON.stringify(live.shapeMismatches)}`)
  }
  const committedTotals = committed.totals
  for (const category of Object.keys(live.totals)) {
    const expected = live.totals[category]
    const actual = committedTotals?.[category]
    for (const key of Object.keys(expected)) {
      if (typeof expected[key] === 'number' && actual?.[key] !== expected[key]) {
        changes.push(`totals.${category}.${key}: ${actual?.[key] ?? 'absent'} -> ${expected[key]}`)
      }
    }
  }
  return changes
}

export function readDeclaration() {
  const envTree = process.env.ANYPLUGIN_MODS_TREE
  const tree = envTree && envTree.trim() !== '' ? resolve(envTree) : join(repoRoot, '.mods', UPSTREAM_MODS_PIN.commit)
  const path = join(tree, declarationRelative)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `mod-coverage: cannot read ${path} (${error instanceof Error ? error.message : String(error)}).\n` +
        `Run \`node scripts/fetch-mod.mjs\` or set ANYPLUGIN_MODS_TREE to the fetched mods tree.`,
    )
  }
  const bytes = Buffer.byteLength(text)
  const sha256 = createHash('sha256').update(text).digest('hex')
  return { tree, path, text, bytes, sha256 }
}

/** Compute the live ledger without reading or writing the committed one. */
export function computeCoverage() {
  const declaration = readDeclaration()
  declarationText = declaration.text
  declarations = indexDeclarations(declaration.text)
  return buildLedger(declaration)
}

export const ledgerText = (ledger) => `${JSON.stringify(ledger, null, 2)}\n`

function groupAbsent(methods) {
  const groups = new Map()
  for (const name of methods) {
    const dot = name.indexOf('.')
    const namespace = dot === -1 ? '(root)' : name.slice(0, dot)
    if (!groups.has(namespace)) groups.set(namespace, [])
    groups.get(namespace).push(name)
  }
  return [...groups.entries()].sort(([a], [b]) => compareStrings(a, b))
}

export function report(ledger) {
  const { totals, absent } = ledger
  const lines = [
    `mod-coverage: claude-code ${ledger.pin.version} (${ledger.pin.commit.slice(0, 10)})`,
    `declaration: ${ledger.pin.file} (${ledger.pin.bytes} bytes, sha256 ${ledger.pin.sha256})`,
    '',
    `declared: ${totals.namespaces.declared} namespaces, ${totals.methods.declared} methods, ${totals.properties.declared} ${totals.properties.declared === 1 ? 'property' : 'properties'}, ${totals.events.declared} events, ${totals.elements.declared} surface elements (${totals.elements.unique} unique), ${totals.renderSites.declared} render sites, ${totals.matchers.declared} matcher types`,
    `served:   ${totals.namespaces.served} namespaces, ${totals.methods.served} methods, ${totals.properties.served} ${totals.properties.served === 1 ? 'property' : 'properties'}, ${totals.events.served} events, ${totals.elements.served} surface elements, ${totals.renderSites.served} render sites`,
    `absent:   ${totals.namespaces.absent} namespaces, ${totals.methods.absent} methods, ${totals.properties.absent} ${totals.properties.absent === 1 ? 'property' : 'properties'}, ${totals.events.absent} events, ${totals.elements.absent} surface elements, ${totals.renderSites.absent} render sites`,
    '',
    'not served, by namespace (methods; properties counted separately):',
  ]
  for (const [namespace, names] of groupAbsent(absent.methods)) {
    lines.push(`  ${namespace}: ${names.length}`)
    for (const name of names) lines.push(`    ${name}`)
  }
  if (absent.properties.length > 0) {
    lines.push('', 'not served properties:')
    for (const name of absent.properties) lines.push(`  ${name}`)
  }
  if (absent.events.length > 0) {
    lines.push('', 'not served events, by namespace:')
    for (const [namespace, names] of groupAbsent(absent.events)) {
      lines.push(`  ${namespace}: ${names.length}`)
      for (const name of names) lines.push(`    ${name}`)
    }
  }
  if (ledger.shapeMismatches.length > 0) {
    lines.push('', 'shape mismatches (present, but not in the declared shape):')
    for (const entry of ledger.shapeMismatches) {
      lines.push(`  ${entry.name}: declared ${entry.declared}, served ${entry.served}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function main(argv) {
  const update = argv.includes('--update')
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'usage: node scripts/mod-coverage.mjs [--update]\n\n' +
        'Reads the pinned claude-code.d.ts and the runtime $ table, prints the\n' +
        'declared/served/absent totals, and fails on drift unless --update is given.\n',
    )
    return 0
  }
  const live = computeCoverage()
  if (update) {
    writeFileSync(ledgerPath, ledgerText(live))
    process.stdout.write(report(live))
    process.stdout.write(`\nwrote ${relative(repoRoot, ledgerPath)}\n`)
    return 0
  }
  let committed
  try {
    committed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  } catch (error) {
    process.stderr.write(
      `mod-coverage: cannot read ${relative(repoRoot, ledgerPath)} (${error instanceof Error ? error.message : String(error)})\n` +
        'Run `node scripts/mod-coverage.mjs --update` to write it.\n',
    )
    return 1
  }
  const changes = diffLedger(committed, live)
  if (changes.length > 0) {
    process.stderr.write(`mod-coverage: ledger is out of date (${relative(repoRoot, ledgerPath)})\n`)
    for (const change of changes) process.stderr.write(`  ${change}\n`)
    process.stderr.write('\nRun `node scripts/mod-coverage.mjs --update` and review the diff.\n')
    return 1
  }
  process.stdout.write(report(live))
  return 0
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
