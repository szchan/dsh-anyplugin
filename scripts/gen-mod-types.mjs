#!/usr/bin/env node
// Generate the internal mod type surface (#144) from the pinned declaration.
//
// `fixtures/mods/coverage.json` (D55) is the authority for what `$` serves; the
// pin's `mods/types/claude-code.d.ts` is the authority for each signature. This
// script joins the two and writes
// `packages/dsh-anyplugin-mod-host/types/mod.d.ts`: the served subset, with the
// pin's own signature text, plus the refused members as a closed error-code
// union. A served member whose signature it cannot copy fails generation naming
// the member — it is never guessed, because a made-up type is a lie the
// compiler would repeat.
//
// The file is repository-side only: it is not shipped in the package and is not
// author-facing. Shipping it would require either redistributing Anthropic's
// pinned declaration (D14 forbids vendoring the artifact, and the licence does
// not grant redistribution) or a derived inline subset whose shapes are no
// longer copied verbatim (a different claim under D57). Until that choice is
// ratified, author-facing types are `planned`; this file exists to stop shape
// drift in the repository.
//
// The file imports the named helper types from the pinned `claude-code` module.
// It does not vendor the pin's type library: that library's `OpValueOf` and
// `EventCalls` carry the names of absent and refused members, so copying it
// would make the generated file claim members this host does not serve.
//
// Run: node scripts/gen-mod-types.mjs [--out <path>]

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPSTREAM_MODS_PIN } from '../packages/dsh-anyplugin-mod-host/src/pin.ts'
import { ledgerPath, matchingIndex, parseDeclaration, parseMembers, readDeclaration } from './mod-coverage.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const typesPath = join(repoRoot, 'packages', 'dsh-anyplugin-mod-host', 'types', 'mod.d.ts')
const ledgerRelativePath = 'fixtures/mods/coverage.json'
const declarationRelativePath = 'mods/types/claude-code.d.ts'

// TypeScript's own globals. A signature that references one of these needs no
// import; anything else must be declared in the pin or generation fails.
const BUILTIN_TYPES = new Set([
  'Array',
  'ArrayBuffer',
  'AsyncGenerator',
  'AsyncIterable',
  'AsyncIterator',
  'Awaited',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'Capitalize',
  'DataView',
  'Date',
  'Error',
  'Exclude',
  'Extract',
  'Float32Array',
  'Float64Array',
  'Function',
  'Generator',
  'InstanceType',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Intl',
  'Iterable',
  'IterableIterator',
  'Iterator',
  'JSON',
  'Lowercase',
  'Map',
  'Math',
  'NoInfer',
  'NonNullable',
  'Number',
  'Object',
  'Omit',
  'Parameters',
  'Partial',
  'Pick',
  'Promise',
  'PromiseLike',
  'PropertyKey',
  'Readonly',
  'ReadonlyArray',
  'ReadonlyMap',
  'ReadonlySet',
  'Record',
  'RegExp',
  'Required',
  'ReturnType',
  'Set',
  'SharedArrayBuffer',
  'String',
  'Symbol',
  'ThisType',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'Uncapitalize',
  'Uppercase',
  'WeakMap',
  'WeakSet',
])

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (values) => [...values].sort(compareStrings)

const fail = (message) => {
  throw new Error(`gen-mod-types: ${message}`)
}

const readLedger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'))

const splitMember = (entry) => {
  const dot = entry.indexOf('.')
  if (dot <= 0 || dot === entry.length - 1) fail(`ledger member ${JSON.stringify(entry)} is not a dotted \`namespace.member\` name`)
  return [entry.slice(0, dot), entry.slice(dot + 1)]
}

/** `{ namespaces, members }` — the served set, as the ledger states it. */
function servedSet(ledger) {
  const namespaces = new Map()
  for (const namespace of ledger.served.namespaces) {
    if (namespaces.has(namespace)) fail(`ledger lists served namespace ${namespace} twice`)
    namespaces.set(namespace, new Set())
  }
  for (const entry of [...ledger.served.methods, ...ledger.served.properties]) {
    const [namespace, member] = splitMember(entry)
    if (!namespaces.has(namespace)) fail(`ledger serves ${entry} but does not list ${namespace} as a served namespace`)
    const members = namespaces.get(namespace)
    if (members.has(member)) fail(`ledger lists served member ${entry} twice`)
    members.add(member)
  }
  return namespaces
}

/** Refused members and their measured runtime codes, sorted by dotted name. */
function refusedSet(ledger) {
  const entries = [...ledger.refused.methods, ...ledger.refused.properties].map((entry) => {
    const name = typeof entry === 'string' ? entry : entry?.name
    const code = typeof entry === 'string' ? undefined : entry?.code
    if (typeof name !== 'string') fail(`ledger has a refused entry with no name: ${JSON.stringify(entry)}`)
    if (typeof code !== 'string' || !/^ERR_MOD_HOST_[A-Z0-9_]+$/.test(code)) {
      fail(`refused member ${name} has no typed ERR_MOD_HOST_* code in the ledger; refusing to document a guessed error`)
    }
    return { name, code }
  })
  entries.sort((a, b) => compareStrings(a.name, b.name))
  const seen = new Set()
  for (const { name } of entries) {
    if (seen.has(name)) fail(`ledger lists refused member ${name} twice`)
    seen.add(name)
  }
  return entries
}

/** Keywords and built-in primitives that are never imported or declared. */
const TYPE_KEYWORDS = new Set([
  'any',
  'asserts',
  'bigint',
  'boolean',
  'extends',
  'false',
  'infer',
  'is',
  'keyof',
  'never',
  'new',
  'null',
  'number',
  'object',
  'readonly',
  'satisfies',
  'string',
  'symbol',
  'this',
  'true',
  'typeof',
  'undefined',
  'unknown',
  'void',
])

/** The index of the first colon outside strings, brackets, braces and parens. */
function topLevelColon(text) {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"') {
      i++
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '`') {
      i++
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--
    else if (c === ':' && depth === 0) return i
  }
  return -1
}

/**
 * The type parameters a signature declares: `<E extends X>` either after the
 * member's colon (property form) or directly after its name (method form).
 */
export function localTypeParameters(source) {
  let rest = source.trimStart()
  const name = /^[A-Za-z_$][\w$]*/.exec(rest)
  const afterName = name === null ? '' : rest.slice(name[0].length).trimStart()
  if (afterName.startsWith('<')) rest = afterName
  else {
    const colon = topLevelColon(rest)
    if (colon !== -1) rest = rest.slice(colon + 1).trimStart()
  }
  if (!rest.startsWith('<')) return new Set()
  let depth = 0
  let current = ''
  const chunks = []
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === '<') {
      depth++
      if (depth === 1) continue
    } else if (c === '>') {
      depth--
      if (depth === 0) {
        chunks.push(current)
        break
      }
    } else if (c === ',' && depth === 1) {
      chunks.push(current)
      current = ''
      continue
    }
    if (depth >= 1) current += c
  }
  const names = new Set()
  for (const chunk of chunks) {
    const match = /^\s*([A-Za-z_$][\w$]*)/.exec(chunk)
    if (match) names.add(match[1])
  }
  return names
}

const identifierStart = (c) => /[A-Za-z_$]/.test(c)
const identifierPart = (c) => /[\w$]/.test(c)

/** The next non-space character at or after `from`, or '' at end of text. */
function nextSignificant(text, from) {
  for (let i = from; i < text.length; i++) if (!/\s/.test(text[i])) return text[i]
  return ''
}

/**
 * Identifiers used in type position, e.g. `TimerCall` in `after: TimerCall;` or
 * `mysteryCall` in a doctored `after: mysteryCall;`. It deliberately does not
 * rely on an uppercase convention: an unresolved lowercase type is the same lie
 * as an unresolved uppercase one. Names followed by `:` or `?` are parameters
 * or property keys, not type references, so they are skipped.
 */
export function typeReferences(source) {
  const references = new Set()
  // A member source starts with its name and then either `:` (property form)
  // or a type-parameter list / parameter list (method form). For method form
  // the first top-level colon is the *return type*, so scanning only after it
  // would miss every parameter and constraint; start at the type-parameter or
  // parameter list instead. A bare type expression (no member name) starts at 0.
  let from = 0
  const member = /^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\??/.exec(source)
  if (member !== null) {
    const after = source.slice(member[0].length)
    if (after.startsWith(':')) from = member[0].length + 1
    else if (after.startsWith('<') || after.startsWith('(')) from = member[0].length
  }
  let previous = ''
  for (let i = from; i < source.length; i++) {
    const c = source[i]
    if (c === "'" || c === '"') {
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i++
        i++
      }
      previous = 'literal'
      continue
    }
    if (c === '`') {
      i++
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') i++
        i++
      }
      previous = 'literal'
      continue
    }
    if (/\s/.test(c)) continue
    if (c === '=' && source[i + 1] === '>') {
      previous = '=>'
      i++
      continue
    }
    if (identifierStart(c)) {
      let end = i + 1
      while (end < source.length && identifierPart(source[end])) end++
      const word = source.slice(i, end)
      const next = nextSignificant(source, end)
      const inTypePosition =
        previous === '' ||
        previous === ':' ||
        previous === '|' ||
        previous === '&' ||
        previous === '<' ||
        previous === ',' ||
        previous === '=>' ||
        previous === 'extends' ||
        previous === 'keyof' ||
        previous === 'typeof' ||
        previous === 'readonly' ||
        previous === '?' ||
        previous === 'as' ||
        previous === 'satisfies' ||
        previous === 'is'
      if (inTypePosition && next !== ':' && next !== '?') references.add(word)
      previous = word
      i = end - 1
      continue
    }
    previous = c
  }
  return references
}

/** The type text of a signature, or a failure when it has none. */
function signatureTypeText(source, label) {
  const text = source.replace(/;\s*$/, '').trim()
  const colon = topLevelColon(text)
  const type = colon === -1 ? '' : text.slice(colon + 1).trim()
  if (type === '') {
    fail(`served member ${label} was extracted as ${JSON.stringify(source)} with no type text; refusing to emit an untyped member`)
  }
  return type
}

/**
 * Check the ledger's pin against the declaration it names and the checked-out
 * pin module. A mismatch means the ledger and the d.ts are not the same claim,
 * so the generated file would cite a hash it was not built from.
 */
function verifyPin(ledger, declaration, pin) {
  const claimed = ledger.pin
  if (claimed === undefined) fail('the ledger has no `pin` block')
  const checks = [
    ['version', claimed.version, pin.version],
    ['commit', claimed.commit, pin.commit],
    ['file', claimed.file, declarationRelativePath],
    ['bytes', claimed.bytes, declaration.bytes],
    ['sha256', claimed.sha256, declaration.sha256],
  ]
  for (const [field, fromLedger, fromSource] of checks) {
    if (fromLedger !== fromSource) {
      fail(
        `ledger pin ${field} is ${JSON.stringify(fromLedger)} but the declaration/pin module says ` +
          `${JSON.stringify(fromSource)}; refusing to generate from two different claims`,
      )
    }
  }
}

/** The namespace's members as the pin declares them, or a named failure. */
function namespaceMembers(parsed, text, coreMembers, namespace) {
  const named = parsed.declaration(namespace)
  const typeText =
    named?.kind === 'interface' ? `{${text.slice(named.bodyStart, named.bodyEnd)}}` : coreMembers.get(namespace)?.type
  if (typeof typeText !== 'string' || typeText.trim() === '') {
    fail(`served namespace ${namespace} has no declaration in ${declarationRelativePath}; refusing to guess`)
  }
  return new Map(parsed.parseMembers(typeText).filter((member) => member.name !== undefined).map((member) => [member.name, member]))
}

/**
 * Render the file. Pure except for reading the ledger and the d.ts (both
 * overridable); `verify: false` exists only so tests can feed a doctored
 * declaration and watch a later check fire.
 */
export function renderModTypes(options = {}) {
  const ledger = options.ledger ?? readLedger()
  const declaration = options.declaration ?? readDeclaration()
  const pin = options.pin ?? UPSTREAM_MODS_PIN
  if (options.verify !== false) {
    const measured = {
      ...declaration,
      bytes: Buffer.byteLength(declaration.text),
      sha256: createHash('sha256').update(declaration.text).digest('hex'),
    }
    verifyPin(ledger, measured, pin)
  }

  const served = servedSet(ledger)
  const refused = refusedSet(ledger)

  // Served and refused must partition the pin. If the ledger lists a member in
  // both, the file would declare it and refuse it at once — a lie in both
  // directions — so fail before rendering anything.
  const servedNames = new Set()
  for (const [namespace, members] of served) {
    for (const member of members) servedNames.add(`${namespace}.${member}`)
  }
  for (const { name } of refused) {
    if (servedNames.has(name)) {
      fail(`member ${name} is listed as both served and refused in the ledger; the two sets must not overlap`)
    }
  }
  for (const namespace of ledger.refused.namespaces) {
    if (served.has(namespace)) {
      fail(`namespace ${namespace} is listed as both served and refused in the ledger; the two sets must not overlap`)
    }
  }

  const parsed = parseDeclaration(declaration.text)

  const core = parsed.declaration('CoreEngineInterface')
  if (core?.kind !== 'interface') fail(`the declaration has no \`CoreEngineInterface\` interface`)
  const coreMembers = new Map(
    parsed.parseMembers(`{${declaration.text.slice(core.bodyStart, core.bodyEnd)}}`).filter((member) => member.name !== undefined).map((member) => [member.name, member]),
  )

  const references = new Map()
  const namespaceBlocks = []
  for (const namespace of sorted(served.keys())) {
    const members = namespaceMembers(parsed, declaration.text, coreMembers, namespace)
    const lines = []
    for (const member of sorted(served.get(namespace))) {
      const qualified = `${namespace}.${member}`
      const found = members.get(member)
      if (found === undefined) {
        fail(`served member ${qualified} has no declaration in ${declarationRelativePath}; refusing to guess a signature`)
      }
      let source = found.source
      if (typeof source !== 'string' || source.trim() === '') {
        fail(`served member ${qualified} has no extractable signature text in ${declarationRelativePath}; refusing to guess`)
      }
      if (!source.startsWith(member) && !source.startsWith(`readonly ${member}`)) {
        fail(`served member ${qualified} was extracted as ${JSON.stringify(source)}; refusing to emit text that does not start with the member`)
      }
      if (!source.endsWith(';')) source += ';'
      signatureTypeText(source, qualified)
      lines.push(`    ${source}`)

      const locals = localTypeParameters(source)
      for (const reference of typeReferences(source)) {
        if (locals.has(reference) || BUILTIN_TYPES.has(reference) || TYPE_KEYWORDS.has(reference)) continue
        const users = references.get(reference) ?? new Set()
        users.add(qualified)
        references.set(reference, users)
      }
    }
    namespaceBlocks.push([namespace, lines])
  }

  // Every reference must be a type the pin declares (a helper) or a builtin. A
  // reference to nothing is a signature we cannot honestly copy: fail, naming
  // the member that needs it.
  for (const [reference, users] of references) {
    if (parsed.declaration(reference) === undefined) {
      fail(
        `served member ${sorted(users).join(', ') || '(unknown)'} references ${reference}, which is not declared in ` +
          `${declarationRelativePath}; refusing to guess the type`,
      )
    }
  }
  const imports = sorted(references.keys())

  const servedMembers = [...served.values()].reduce((sum, members) => sum + members.size, 0)
  const header = [
    '// Generated by `npm run gen:types` (`node scripts/gen-mod-types.mjs`) from the',
    '// pinned mod declaration. Do not edit: the generator owns this file.',
    '//',
    `// Pin: claude-code ${ledger.pin.version}, mods tree commit ${ledger.pin.commit}.`,
    `// Declaration: ${declarationRelativePath} (${ledger.pin.bytes} bytes,`,
    `// sha256 ${ledger.pin.sha256}).`,
    `// Ledger: ${ledgerRelativePath} (D55) — ${served.size} served namespaces,`,
    `// ${servedMembers} served members, ${refused.length} refused members.`,
    '//',
    '// This file is the repository-side guard against shape drift: `ModDollar`',
    "// declares exactly the members the ledger says the host serves, with the pin's",
    '// own signature text, so a served member without a shape fails generation',
    '// instead of merging silently. It is not shipped and not author-facing:',
    "// shipping it would require either redistributing Anthropic's pinned",
    '// declaration (D14 forbids vendoring the artifact, and the licence does not',
    '// grant redistribution) or a derived inline subset whose shapes are no longer',
    '// copied verbatim (a different claim under D57). Author-facing types are',
    '// planned. It is not a promise about the pin\'s whole surface either: absent',
    '// members are named nowhere here, and events, elements, render sites and',
    '// matchers are counted separately by the ledger, not declared in this file.',
    '//',
    '// The named types in the signatures are imported from `claude-code` (the pin is',
    '// their specification); their bodies are not reproduced here.',
    '',
    'import type {',
    ...imports.map((name) => `  ${name},`),
    "} from 'claude-code'",
    '',
    '/** The `$` a mod sees: only the members this host serves, as the pin declares them. */',
    'export interface ModDollar {',
  ]

  for (const [namespace, lines] of namespaceBlocks) {
    header.push(`  ${namespace}: {`, ...lines, '  };')
  }
  header.push('}')

  const refusedUnion = [
    '',
    '/**',
    ' * Members the pin declares and this host refuses: calling one always throws a',
    " * typed error before any work happens. The value is the error's `code`, so a mod",
    ' * branches on `ModRefusedErrorCode` instead of matching a message.',
    ' *',
    ' * This is the only place a refused member is named. `ModDollar` and this',
    ' * interface partition what this file can know — served, or refused; a member',
    ' * in neither is absent at the pin and is named nowhere here.',
    ' */',
    'export interface ModRefusedMemberCodes {',
    ...refused.map(({ name, code }) => `  '${name}': '${code}';`),
    '}',
    '',
    '/** A member the host refuses, by dotted name. */',
    'export type ModRefusedMember = keyof ModRefusedMemberCodes',
    '',
    '/** The typed error code a refused member throws. */',
    'export type ModRefusedErrorCode = ModRefusedMemberCodes[ModRefusedMember]',
    '',
  ]

  const rendered = [...header, ...refusedUnion].join('\n')
  assertImportsCoverTypeReferences(rendered, declaration.text)
  assertRendered(rendered, ledger)
  return rendered
}

/**
 * The reverse closure check: every type a `ModDollar` signature references must
 * be imported. The forward check (every imported name is declared by the pin)
 * cannot see a name that was dropped from the block, so both are needed.
 */
export function assertImportsCoverTypeReferences(text, declarationText) {
  const parsed = parseDeclaration(declarationText)
  const block = /^import type \{\n([\s\S]*?)\n\} from 'claude-code'$/m.exec(text)
  if (block === null) fail('generated file has no `claude-code` import block')
  const imported = new Set(
    block[1]
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => line !== ''),
  )

  const marker = 'export interface ModDollar {'
  const start = text.indexOf(marker)
  if (start === -1) fail('generated file has no ModDollar interface')
  const open = start + marker.length - 1
  const close = matchingIndex(text, open)
  if (close === -1) fail('generated file has an unterminated ModDollar interface')

  for (const namespaceMember of parseMembers(`{${text.slice(open + 1, close)}}`)) {
    if (namespaceMember.name === undefined || typeof namespaceMember.type !== 'string') continue
    for (const entry of parseMembers(namespaceMember.type)) {
      if (entry.name === undefined) continue
      // Method-form members have an empty `type` (their signature is only in
      // `source`); rebuilding `name: ;` here would hide every parameter.
      const source =
        typeof entry.source === 'string' && entry.source.trim() !== ''
          ? entry.source
          : `${entry.name}: ${entry.type};`
      const locals = localTypeParameters(source)
      for (const reference of typeReferences(source)) {
        if (locals.has(reference) || BUILTIN_TYPES.has(reference) || TYPE_KEYWORDS.has(reference)) continue
        if (parsed.declaration(reference) === undefined) {
          fail(`${namespaceMember.name}.${entry.name} references ${reference}, which the pin does not declare`)
        }
        if (!imported.has(reference)) {
          fail(`${namespaceMember.name}.${entry.name} references ${reference}, which the import block does not import`)
        }
      }
    }
  }
}

/**
 * The generator's own guard, so a bug here cannot ship a file the acceptance
 * rules forbid. The test checks the same properties against the committed file,
 * independently of this function.
 */
function assertRendered(rendered, ledger) {
  for (const name of [...ledger.absent.methods, ...ledger.absent.properties]) {
    if (rendered.includes(name)) fail(`rendered output names absent member ${name}; refusing to write`)
  }
  for (const namespace of ledger.absent.namespaces) {
    if (new RegExp(`\\b${namespace}\\b`).test(rendered)) fail(`rendered output names absent namespace ${namespace}; refusing to write`)
  }

  // A bare member name inside its namespace block never appears as a dotted
  // string, so compare the rendered `ModDollar` namespace-by-namespace.
  const dollarMarker = 'export interface ModDollar {'
  const dollarStart = rendered.indexOf(dollarMarker)
  if (dollarStart === -1) fail('rendered output has no ModDollar interface')
  const dollarOpen = dollarStart + dollarMarker.length - 1
  const dollarClose = matchingIndex(rendered, dollarOpen)
  if (dollarClose === -1) fail('rendered output has an unterminated ModDollar interface')
  const declaredNamespaces = new Map()
  for (const member of parseMembers(`{${rendered.slice(dollarOpen + 1, dollarClose)}}`)) {
    if (member.name === undefined) continue
    declaredNamespaces.set(
      member.name,
      new Set(parseMembers(member.type).filter((entry) => entry.name !== undefined).map((entry) => entry.name)),
    )
  }
  for (const name of [...ledger.absent.methods, ...ledger.absent.properties]) {
    const dot = name.indexOf('.')
    if (dot === -1) continue
    const namespace = name.slice(0, dot)
    if (declaredNamespaces.get(namespace)?.has(name.slice(dot + 1))) {
      fail(`rendered output declares absent member ${name}; refusing to write`)
    }
  }

  const refusedNames = [...ledger.refused.methods, ...ledger.refused.properties].map((entry) =>
    typeof entry === 'string' ? entry : entry?.name,
  )
  for (const name of refusedNames) {
    const dot = name.indexOf('.')
    if (dot === -1) continue
    const namespace = name.slice(0, dot)
    if (declaredNamespaces.get(namespace)?.has(name.slice(dot + 1))) {
      fail(`rendered output declares refused member ${name} in ModDollar; the served and refused sets must not overlap`)
    }
  }

  const marker = 'export interface ModRefusedMemberCodes {'
  const start = rendered.indexOf(marker)
  if (start === -1) fail('rendered output has no ModRefusedMemberCodes union')
  const open = start + marker.length - 1
  const close = matchingIndex(rendered, open)
  if (close === -1) fail('rendered output has an unterminated ModRefusedMemberCodes union')

  for (const name of refusedNames) {
    let index = rendered.indexOf(name)
    let count = 0
    while (index !== -1) {
      if (index < open || index >= close) fail(`refused member ${name} appears outside the error union`)
      count++
      index = rendered.indexOf(name, index + 1)
    }
    if (count !== 1) fail(`refused member ${name} appears ${count} times; the union must name it exactly once`)
  }
  for (const namespace of ledger.refused.namespaces) {
    let index = rendered.indexOf(namespace)
    while (index !== -1) {
      if (index < open || index >= close) fail(`refused namespace ${namespace} appears outside the error union`)
      index = rendered.indexOf(namespace, index + 1)
    }
  }
  return rendered
}

function main(argv) {
  let out = typesPath
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const value = argv[++i]
      if (value === undefined || value === '') fail('--out needs a path')
      out = resolve(value)
    } else {
      fail(`unknown argument ${JSON.stringify(argv[i])}`)
    }
  }
  const text = renderModTypes()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  process.stdout.write(`gen-mod-types: wrote ${relative(repoRoot, out)} (${Buffer.byteLength(text)} bytes)\n`)
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
