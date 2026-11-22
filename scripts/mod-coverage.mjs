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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
        'The bare ClassicHookEvent names are the source of those 33 spellings and are not counted a second time. ' +
        'served events are the live MOD_EVENT_ROUTES host routes; the sink-owned synthetic ui.render/ui.resolve ' +
        'dispatches are not host routes and are not counted as served here.',
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

// The codes the bridge uses for a member it deliberately does not serve. A
// refusal is not "absent": the member exists and is callable, but under this
// configuration it always throws one of these typed errors. `served` means
// callable here and not a refusal; the two sets are disjoint.
const REFUSAL_CODES = new Set([
  'ERR_MOD_HOST_EXEC_UNSUPPORTED',
  'ERR_MOD_HOST_SETTINGS_UNAVAILABLE',
  'ERR_MOD_HOST_UI_UNSUPPORTED',
  'ERR_MOD_HOST_VCS_UNSUPPORTED',
])
const PROBE_TIMEOUT_MS = 1000
const PROBE_TIMED_OUT = Symbol('mod-coverage probe timed out')

const isThenable = (value) =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'

const refusalCodeOf = (error) => {
  if (error === null || typeof error !== 'object') return undefined
  const code = error.code
  return typeof code === 'string' && REFUSAL_CODES.has(code) ? code : undefined
}

/** Await a probe result only long enough to see a typed refusal, never to hang. */
const settleProbe = async (value) => {
  if (!isThenable(value)) return { kind: 'value' }
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(PROBE_TIMED_OUT), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
  const settled = Promise.resolve(value).then(
    () => ({ kind: 'value' }),
    (error) => ({ kind: 'error', error }),
  )
  try {
    const outcome = await Promise.race([settled, timeout])
    return outcome === PROBE_TIMED_OUT ? { kind: 'timeout' } : outcome
  } finally {
    clearTimeout(timer)
  }
}

const probeRefusal = async (fn) => {
  let value
  try {
    value = fn()
  } catch (error) {
    return refusalCodeOf(error)
  }
  const outcome = await settleProbe(value)
  return outcome.kind === 'error' ? refusalCodeOf(outcome.error) : undefined
}

/**
 * Call the runtime `$` factory and classify every member it returns. Each
 * function is called once with no arguments: a typed refusal is observable
 * without a valid call, and a member whose probe rejects for any other reason
 * is still callable (the probe is a classification aid, not a conformance
 * test). The scratch directory and the attached session model the host at
 * handler time; `settings` is deliberately absent because the materializer
 * passes no settings source (packages/dsh-anyplugin-materialize-hook/src/index.ts:1536).
 */
export async function inspectRuntime() {
  const scratch = mkdtempSync(join(tmpdir(), 'mod-coverage-'))
  const bridge = createModBridge({
    plugin: 'mod-coverage',
    dataDir: scratch,
    cwd: scratch,
    session: () => ({ id: 'mod-coverage', cwd: scratch, messages: [], usage: {} }),
    commands: { register: () => () => {} },
    env: {},
    warn: () => {},
  })
  try {
    const table = bridge.dollar()
    const namespaces = []
    const entries = []
    for (const [namespace, members] of Object.entries(table)) {
      if (members === null || typeof members !== 'object') continue
      namespaces.push(namespace)
      for (const [name, value] of Object.entries(members)) {
        if (typeof value === 'function') {
          entries.push({
            namespace,
            name,
            kind: 'method',
            valueType: 'function',
            code: await probeRefusal(value),
          })
        } else {
          entries.push({ namespace, name, kind: 'property', valueType: typeof value })
        }
      }
    }
    const elements = {}
    for (const surface of UI_SURFACES) {
      elements[surface] = sorted(Object.keys(elementsForSurface(surface, 'mod-coverage')))
    }
    return { namespaces: sorted(namespaces), entries, elements }
  } finally {
    bridge.dispose()
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---- the ledger -----------------------------------------------------------

const setDifference = (left, right) => {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function partitionElements(declaredSurfaces, servedSurfaces) {
  const served = []
  const absent = []
  const perSurface = {}
  for (const [surface, declaredNames] of Object.entries(declaredSurfaces)) {
    const runtimeNames = servedSurfaces[surface]
    if (runtimeNames === undefined) throw new Error(`mod-coverage: no runtime element table for surface ${surface}`)
    const declaredSet = new Set(declaredNames)
    const extras = runtimeNames.filter((name) => !declaredSet.has(name))
    if (extras.length > 0) {
      throw new Error(`mod-coverage: ${surface} serves elements the pin does not declare: ${extras.join(', ')}`)
    }
    const runtimeSet = new Set(runtimeNames)
    const missing = declaredNames.filter((name) => !runtimeSet.has(name))
    perSurface[surface] = { declared: declaredNames.length, served: runtimeNames.length, absent: missing.length }
    for (const name of runtimeNames) served.push(`${surface}:${name}`)
    for (const name of missing) absent.push(`${surface}:${name}`)
  }
  for (const surface of Object.keys(servedSurfaces)) {
    if (!(surface in declaredSurfaces)) throw new Error(`mod-coverage: runtime serves unknown surface ${surface}`)
  }
  return { served: sorted(served), absent: sorted(absent), perSurface }
}

function assertPartition(label, declaredCount, parts) {
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  if (total !== declaredCount) {
    throw new Error(
      `mod-coverage: ${label} partition is not exhaustive: ${parts.map((part) => `${part.label} ${part.count}`).join(' + ')} = ${total}, declared ${declaredCount}`,
    )
  }
}

export function buildLedger(declaration, runtime) {
  const declared = extractDeclared()
  const declaredMethods = new Set(declared.methods)
  const declaredProperties = new Set(declared.properties)
  const declaredEvents = [...declared.events.engine, ...declared.events.op, ...declared.events.classicSpellings]
  const declaredEventSet = new Set(declaredEvents)

  const servedMethods = []
  const servedProperties = []
  const refused = []
  const wrongShape = []
  const extras = []
  const present = new Set()
  const seen = new Set()

  for (const entry of runtime.entries) {
    const qualified = `${entry.namespace}.${entry.name}`
    if (seen.has(qualified)) throw new Error(`mod-coverage: duplicate runtime member ${qualified}`)
    seen.add(qualified)
    present.add(qualified)
    if (declaredMethods.has(qualified)) {
      if (entry.kind === 'method' && entry.code === undefined) servedMethods.push(qualified)
      else if (entry.kind === 'method') refused.push({ name: qualified, code: entry.code })
      else {
        wrongShape.push({
          name: qualified,
          declared: 'method',
          runtime: entry.kind,
          valueType: entry.valueType,
        })
      }
    } else if (declaredProperties.has(qualified)) {
      if (entry.kind === 'property') servedProperties.push(qualified)
      else {
        wrongShape.push({
          name: qualified,
          declared: 'property',
          runtime: entry.kind,
          valueType: entry.valueType,
        })
      }
    } else {
      extras.push(qualified)
    }
  }

  if (extras.length > 0) {
    throw new Error(
      `mod-coverage: the runtime $ table serves members the pinned declaration does not declare: ${sorted(extras).join(', ')}`,
    )
  }

  const servedEvents = sorted(
    MOD_EVENT_ROUTES.filter((route) => route.status === 'live')
      .map((route) => route.modEvent)
      .filter(Boolean),
  )
  const extraEvents = servedEvents.filter((name) => !declaredEventSet.has(name))
  if (extraEvents.length > 0) {
    throw new Error(`mod-coverage: the host routes events the pin does not declare: ${extraEvents.join(', ')}`)
  }

  const elementPartition = partitionElements(declared.elements.surfaces, runtime.elements)
  for (const [surface, counts] of Object.entries(elementPartition.perSurface)) {
    assertPartition(`elements ${surface}`, counts.declared, [
      { label: 'served', count: counts.served },
      { label: 'absent', count: counts.absent },
    ])
  }
  assertPartition('elements', declared.elements.surfaceQualified, [
    { label: 'served', count: elementPartition.served.length },
    { label: 'absent', count: elementPartition.absent.length },
  ])

  // The host owns one render site: it synthesizes `ui.render` for
  // `component: 'Pane'` on `surface: 'terminal'` only (ui.ts:26-29,
  // :1093-1097). The other components are declared and planned, not served.
  const runtimeComponents = sorted(UI_COMPONENTS)
  if (JSON.stringify(runtimeComponents) !== JSON.stringify(declared.renderSites)) {
    throw new Error('mod-coverage: UI_COMPONENTS and the pin RenderComponent disagree')
  }
  const servedRenderSites = ['Pane']
  const absentRenderSites = declared.renderSites.filter((name) => !servedRenderSites.includes(name))
  assertPartition('render sites', declared.renderSites.length, [
    { label: 'served', count: servedRenderSites.length },
    { label: 'absent', count: absentRenderSites.length },
  ])

  const wrongMethodNames = new Set(wrongShape.filter((entry) => entry.declared === 'method').map((entry) => entry.name))
  const wrongPropertyNames = new Set(
    wrongShape.filter((entry) => entry.declared === 'property').map((entry) => entry.name),
  )
  // A namespace is served only when at least one of its members is served.
  // Presence alone is not service: `process` and `settings` are present and
  // expose every member as a typed refusal, so they are refused-only.
  const namespaceOf = (name) => name.slice(0, name.indexOf('.'))
  const presentNamespaces = new Set(runtime.namespaces)
  const servedNamespaceSet = new Set([...servedMethods, ...servedProperties].map(namespaceOf))
  const refusedNamespaceSet = new Set(refused.map((entry) => namespaceOf(entry.name)))
  const servedNamespaces = declared.namespaces.filter((name) => servedNamespaceSet.has(name))
  const refusedOnlyNamespaces = declared.namespaces.filter(
    (name) => presentNamespaces.has(name) && !servedNamespaceSet.has(name) && refusedNamespaceSet.has(name),
  )
  const unclassifiedNamespaces = declared.namespaces.filter(
    (name) => presentNamespaces.has(name) && !servedNamespaceSet.has(name) && !refusedNamespaceSet.has(name),
  )
  if (unclassifiedNamespaces.length > 0) {
    throw new Error(
      `mod-coverage: namespace${unclassifiedNamespaces.length === 1 ? '' : 's'} present with no served or refused member: ${unclassifiedNamespaces.join(', ')}`,
    )
  }
  const absentNamespaces = declared.namespaces.filter((name) => !presentNamespaces.has(name))
  const absent = {
    namespaces: absentNamespaces,
    methods: declared.methods.filter((name) => !present.has(name)),
    properties: declared.properties.filter((name) => !present.has(name)),
    events: sorted(setDifference(declaredEvents, servedEvents)),
    elements: elementPartition.absent,
    renderSites: absentRenderSites,
  }

  const served = {
    namespaces: servedNamespaces,
    methods: sorted(servedMethods),
    properties: sorted(servedProperties),
    events: servedEvents,
    elements: elementPartition.served,
    renderSites: servedRenderSites,
  }

  assertPartition('methods', declared.methods.length, [
    { label: 'served', count: served.methods.length },
    { label: 'refused', count: refused.length },
    { label: 'absent', count: absent.methods.length },
    { label: 'wrong shape', count: wrongMethodNames.size },
  ])
  assertPartition('properties', declared.properties.length, [
    { label: 'served', count: served.properties.length },
    { label: 'refused', count: 0 },
    { label: 'absent', count: absent.properties.length },
    { label: 'wrong shape', count: wrongPropertyNames.size },
  ])
  assertPartition('events', declared.events.declaredTotal, [
    { label: 'served', count: served.events.length },
    { label: 'absent', count: absent.events.length },
  ])
  assertPartition('namespaces', declared.namespaces.length, [
    { label: 'served', count: served.namespaces.length },
    { label: 'refused-only', count: refusedOnlyNamespaces.length },
    { label: 'absent', count: absent.namespaces.length },
  ])

  return {
    pin: {
      version: UPSTREAM_MODS_PIN.version,
      commit: UPSTREAM_MODS_PIN.commit,
      file: declarationRelative.split('\\').join('/'),
      bytes: declaration.bytes,
      sha256: declaration.sha256,
    },
    configuration: {
      bridge: 'createModBridge (the runtime $ factory)',
      options: {
        plugin: 'mod-coverage',
        dataDir: 'a fresh temporary directory',
        cwd: 'the same temporary directory',
        session: 'an attached view: id "mod-coverage", that cwd, messages [], usage {}',
        commands: 'a stub registry whose register returns a no-op disposer',
        env: {},
        warn: 'a no-op',
        settings: 'absent (undefined): the materializer passes no settings source, so $.settings.read refuses',
      },
      refusalProbe:
        'each function key is called with no arguments; a returned promise is awaited; a typed ERR_MOD_HOST_* unsupported/unavailable code marks the member refused',
      renderSites:
        'served: the host synthesizes ui.render for component "Pane" on surface "terminal" only (ui.ts:1093-1097; D44); the other 19 declared components are planned, not drawn by the host',
      elements:
        'from elementsForSurface / ELEMENT_TAGS (ui.ts:701-719, 935-953), not from the $ factory: the surface element row is table coverage (what each surface declares it can draw), not drawing coverage',
      shapeCheck:
        'classifies callable vs non-callable only; it does not compare arguments, return types, sync vs Promise, or behaviour',
      note: 'The refused set is configuration-dependent. served means callable under this configuration and not a typed refusal.',
    },
    declared,
    served,
    refused: { namespaces: refusedOnlyNamespaces, methods: sortedByName(refused), properties: [] },
    shapeMismatches: sortedByName(
      wrongShape.map((entry) => ({ name: entry.name, declared: entry.declared, served: entry.runtime })),
    ),
    wrongShape: sortedByName(wrongShape),
    absent,
    totals: {
      namespaces: {
        declared: declared.namespaces.length,
        served: served.namespaces.length,
        refusedOnly: refusedOnlyNamespaces.length,
        absent: absent.namespaces.length,
      },
      methods: {
        declared: declared.methods.length,
        served: served.methods.length,
        refused: refused.length,
        absent: absent.methods.length,
        wrongShape: wrongMethodNames.size,
      },
      properties: {
        declared: declared.properties.length,
        served: served.properties.length,
        refused: 0,
        absent: absent.properties.length,
        wrongShape: wrongPropertyNames.size,
      },
      events: {
        declared: declared.events.declaredTotal,
        served: served.events.length,
        absent: absent.events.length,
      },
      elements: {
        declared: declared.elements.surfaceQualified,
        served: served.elements.length,
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
        note: 'Counts the type aliases named Matcher* / OpenMatcher in the declaration (internal helper shapes), not user-facing matcher forms; there is no runtime type surface to compare.',
      },
      partition: {
        namespaces: 'served + refusedOnly + absent = declared',
        methods: 'served + refused + absent + wrongShape = declared',
        properties: 'served + refused + absent + wrongShape = declared',
        events: 'served + absent = declared',
        elements: 'served + absent = declared',
        renderSites: 'served + absent = declared',
        matchers: 'not partitioned: counted by name only; no runtime type surface',
      },
    },
  }
}

const sortedByName = (values) => [...values].sort((a, b) => compareStrings(a.name, b.name))

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
  compareList('absent.namespaces', committed.absent?.namespaces ?? [], live.absent.namespaces)
  compareList('declared.methods', committed.declared?.methods ?? [], live.declared.methods)
  compareList('declared.properties', committed.declared?.properties ?? [], live.declared.properties)
  compareList('served.methods', committed.served?.methods ?? [], live.served.methods)
  compareList('served.properties', committed.served?.properties ?? [], live.served.properties)
  compareList('refused.namespaces', committed.refused?.namespaces ?? [], live.refused.namespaces)
  compareList('refused.methods', (committed.refused?.methods ?? []).map((entry) => entry.name), live.refused.methods.map((entry) => entry.name))
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
  compareList('served.elements', committed.served?.elements ?? [], live.served.elements)
  compareList('absent.elements', committed.absent?.elements ?? [], live.absent.elements)
  compareList('renderSites', committed.declared?.renderSites ?? [], live.declared.renderSites)
  compareList('served.renderSites', committed.served?.renderSites ?? [], live.served.renderSites)
  compareList('absent.renderSites', committed.absent?.renderSites ?? [], live.absent.renderSites)
  compareList('matchers', committed.declared?.matchers ?? [], live.declared.matchers)
  if (JSON.stringify(committed.refused ?? null) !== JSON.stringify(live.refused)) {
    changes.push(`refused.methods status: ${JSON.stringify(committed.refused ?? null)} -> ${JSON.stringify(live.refused)}`)
  }
  if (JSON.stringify(committed.wrongShape ?? []) !== JSON.stringify(live.wrongShape)) {
    changes.push(`wrongShape: ${JSON.stringify(committed.wrongShape ?? [])} -> ${JSON.stringify(live.wrongShape)}`)
  }
  if (JSON.stringify(committed.shapeMismatches ?? []) !== JSON.stringify(live.shapeMismatches)) {
    changes.push(
      `shapeMismatches: ${JSON.stringify(committed.shapeMismatches ?? [])} -> ${JSON.stringify(live.shapeMismatches)}`,
    )
  }
  if (JSON.stringify(committed.configuration ?? null) !== JSON.stringify(live.configuration)) {
    changes.push('configuration changed')
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
export async function computeCoverage() {
  const declaration = readDeclaration()
  declarationText = declaration.text
  declarations = indexDeclarations(declaration.text)
  return buildLedger(declaration, await inspectRuntime())
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

function groupByPrefix(values, separator) {
  const groups = new Map()
  for (const value of values) {
    const cut = value.indexOf(separator)
    const prefix = cut === -1 ? '(root)' : value.slice(0, cut)
    if (!groups.has(prefix)) groups.set(prefix, [])
    groups.get(prefix).push(value)
  }
  return [...groups.entries()].sort(([a], [b]) => compareStrings(a, b))
}

export function report(ledger) {
  const { totals, absent, refused, wrongShape } = ledger
  const lines = [
    `mod-coverage: claude-code ${ledger.pin.version} (${ledger.pin.commit.slice(0, 10)})`,
    `declaration: ${ledger.pin.file} (${ledger.pin.bytes} bytes, sha256 ${ledger.pin.sha256})`,
    '',
    `declared: ${totals.namespaces.declared} namespaces, ${totals.methods.declared} methods, ${totals.properties.declared} ${totals.properties.declared === 1 ? 'property' : 'properties'}, ${totals.events.declared} events, ${totals.elements.declared} surface elements (${totals.elements.unique} unique), ${totals.renderSites.declared} render sites, ${totals.matchers.declared} matcher type aliases`,
    `served:   ${totals.namespaces.served} namespaces, ${totals.methods.served} methods, ${totals.properties.served} ${totals.properties.served === 1 ? 'property' : 'properties'}, ${totals.events.served} events, ${totals.elements.served} surface elements, ${totals.renderSites.served} render site${totals.renderSites.served === 1 ? '' : 's'}`,
    `refused:  ${totals.methods.refused} methods in ${totals.namespaces.refusedOnly} refused-only namespace${totals.namespaces.refusedOnly === 1 ? '' : 's'} (${refused.namespaces.join(', ')}), callable but a typed refusal under the recorded configuration`,
    `absent:   ${totals.namespaces.absent} namespaces, ${totals.methods.absent} methods, ${totals.properties.absent} ${totals.properties.absent === 1 ? 'property' : 'properties'}, ${totals.events.absent} events, ${totals.elements.absent} surface elements, ${totals.renderSites.absent} render sites`,
    `wrong shape: ${totals.methods.wrongShape} method${totals.methods.wrongShape === 1 ? '' : 's'} present but excluded from served and absent`,
    '',
    `configuration: ${ledger.configuration.bridge}; ${ledger.configuration.options.session}; ${ledger.configuration.options.settings}`,
    `render sites: ${ledger.configuration.renderSites}`,
    `shape check: ${ledger.configuration.shapeCheck}`,
    '',
    'not served methods, by namespace:',
  ]
  for (const [namespace, names] of groupAbsent(absent.methods)) {
    lines.push(`  ${namespace}: ${names.length}`)
    for (const name of names) lines.push(`    ${name}`)
  }
  if (refused.methods.length > 0) {
    lines.push('', 'refused methods, by namespace (callable; typed refusal under this configuration):')
    for (const [namespace, entries] of groupByPrefix(refused.methods.map((entry) => `${entry.name}=${entry.code}`), '.')) {
      lines.push(`  ${namespace}: ${entries.length}`)
      for (const entry of entries) lines.push(`    ${entry}`)
    }
  }
  if (absent.properties.length > 0) {
    lines.push('', 'not served properties:')
    for (const name of absent.properties) lines.push(`  ${name}`)
  }
  if (wrongShape.length > 0) {
    lines.push('', 'wrong shape (present, but neither served nor absent):')
    for (const entry of wrongShape) {
      lines.push(`  ${entry.name}: declared ${entry.declared}, runtime ${entry.runtime} (${entry.valueType})`)
    }
  }
  if (absent.events.length > 0) {
    lines.push('', 'not served events, by namespace:')
    for (const [namespace, names] of groupAbsent(absent.events)) {
      lines.push(`  ${namespace}: ${names.length}`)
      for (const name of names) lines.push(`    ${name}`)
    }
  }
  if (absent.elements.length > 0) {
    lines.push('', 'not served surface elements:')
    for (const [surface, names] of groupByPrefix(absent.elements, ':')) {
      lines.push(`  ${surface}: ${names.length}`)
      for (const name of names) lines.push(`    ${name}`)
    }
  }
  if (absent.renderSites.length > 0) {
    lines.push('', 'not served render sites:')
    for (const name of absent.renderSites) lines.push(`  ${name}`)
  }
  lines.push('', `matcher type aliases: ${totals.matchers.declared} counted by name only; ${totals.matchers.note}`)
  for (const [category, rule] of Object.entries(totals.partition)) {
    lines.push(`partition ${category}: ${rule}`)
  }
  return `${lines.join('\n')}\n`
}

async function main(argv) {
  const update = argv.includes('--update')
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'usage: node scripts/mod-coverage.mjs [--update]\n\n' +
        'Reads the pinned claude-code.d.ts and the runtime $ table, prints the\n' +
        'declared/served/refused/absent totals, and fails on drift unless --update is given.\n',
    )
    return 0
  }
  let live
  try {
    live = await computeCoverage()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
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
  process.exitCode = await main(process.argv.slice(2))
}
