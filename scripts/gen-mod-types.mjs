// gen:types — render the mod-author declaration from the coverage ledger (D95).
//
// The ledger (`fixtures/mods/coverage.json`, D55) is the only input. It
// partitions the pinned surface into served / refused / absent; this script
// selects from that partition, and the shapes below are authored from what
// this host's bridge actually serves. The pinned Anthropic declaration is never
// read, copied, imported or shipped (D14, D57, D60), and the generated file
// needs no Claude Code installation on the author's machine (D96).
//
//   npm run gen:types       rewrite `types/mod.d.ts`
//   npm run check:types     fail when the committed file drifts from the ledger,
//                           or when the rendered file outgrows RAW_BYTE_CAP
//
// A generated file that CI re-renders cannot be hand-edited out of date: the
// drift check is the gate that makes the declaration a claim about this layer
// instead of a copy of the pin.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The ledger is the only input. */
export const ledgerPath = resolve(repoRoot, 'fixtures', 'mods', 'coverage.json')
/** The single committed author-facing declaration. */
export const typesPath = resolve(repoRoot, 'types', 'mod.d.ts')
/** Raw-size guard: a wider surface needs a decision entry, not a quiet tarball (D95). */
export const RAW_BYTE_CAP = 16 * 1024

const LEDGER_RELATIVE = 'fixtures/mods/coverage.json'
const TYPES_RELATIVE = 'types/mod.d.ts'
/** Decision ids named in the generated header; re-rendered after the decision log moves. */
const DECISION_TYPES = 'D95'
const DECISION_NO_CLAUDE_CODE = 'D96'
const ABSENT_REASON = 'this layer does not serve it: see the fidelity report'
const refusedReason = (member) => `this layer does not serve it: ${member.name} is refused with ${member.code} (see the fidelity report)`

/**
 * The shape each served `$` member has at this host's bridge. This table is
 * authored, not generated: it is the host's own contract, checked against the
 * ledger's served set (a served member with no shape fails generation, and a
 * shape for a member the ledger does not serve fails too). Optional fields are
 * the fields this layer does not model further; see the note on each.
 */
export const SERVED_MEMBERS = {
  'clock.after': 'after(ms: number, callback: () => void): { cancel(): void }',
  'clock.every': 'every(ms: number, callback: () => void): { cancel(): void }',
  'clock.now': 'now(): Promise<number>',
  'command.register':
    'register(command: { name: string; description: string }): Promise<{ command: string }>',
  'env.get': 'get(name: string): Promise<string | undefined>',
  'fs.list': 'list(path?: string): Promise<FsEntry[]>',
  'fs.read':
    'read(path: string, options?: { as?: "text" | "bytes" }): Promise<string | { base64: string }>',
  'fs.stat': 'stat(path: string, options?: { resolve?: boolean }): Promise<FsStat>',
  'session.cwd': 'cwd(): Promise<string>',
  'session.id': 'id(): Promise<string>',
  'session.messages': 'messages(): Promise<Record<string, unknown>[]>',
  'session.usage': 'usage(): Promise<Readonly<Record<string, unknown>>>',
  'store.delete': 'delete(key: string): Promise<boolean>',
  'store.get': 'get(key: string): Promise<unknown>',
  'store.keys': 'keys(): Promise<string[]>',
  'store.set': 'set(key: string, value: unknown): Promise<void>',
  'telemetry.log': 'log(entry: unknown): void',
  'telemetry.mark': 'mark(entry: unknown): void',
  'ui.close': 'close(pane: { id: string }): Promise<void>',
  'ui.invalidate': 'invalidate(event: InvalidatableEvent): void',
  'ui.log': 'log(text: string, options?: { to?: "transcript" | "debug" }): void',
  'ui.open': 'open(pane: Pane): Promise<PaneResult>',
  'ui.resolve': 'resolve(input: { surface: Surface; component: Component }): ElementTable',
  'ui.status': 'status(text: string | undefined): void',
  'vcs.detect': 'detect(input: { path: string }): Promise<VcsInfo | null>',
  'vcs.diff': 'diff(input: VcsDiffInput): Promise<VcsDiff>',
}

/**
 * The payload each served event carries. Every route defaults to `Payload`
 * (a classic event's data is passed through unmodelled); the entries here are
 * the three routes whose payload this layer reshapes or carries as an envelope.
 */
export const SERVED_EVENT_PAYLOADS = {
  'classic.PreToolUse': 'ToolEnvelope',
  'prompt.context': 'PromptContext',
  'session.start': 'Payload',
  'tool.call': 'ToolEnvelope',
}

/** Payload labels the rendered `Hook` conditional knows, in branch order. */
const PAYLOAD_LABELS = ['ToolEnvelope', 'PromptContext']
const DEFAULT_PAYLOAD = 'Payload'

/**
 * The pin's invalidatable-event names (the `ui.invalidate` argument). They are
 * a runtime allow-list, not a ledger partition; every one is a declared event
 * and generation fails if the ledger stops declaring one.
 */
const INVALIDATABLE_EVENTS = [
  'command.describe',
  'config.describe',
  'prompt.attachment',
  'prompt.context',
  'prompt.section',
  'tool.describe',
  'tool.list',
  'ui.render',
]

function fail(message) {
  throw new Error(`gen-mod-types: ${message}`)
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Resolve a dotted path inside the ledger, refusing anything that is not an object. */
function at(root, path) {
  let value = root
  for (const key of path.split('.')) {
    if (!isObject(value)) return undefined
    value = value[key]
  }
  return value
}

function need(root, path) {
  const value = at(root, path)
  if (value === undefined || value === null) fail(`${path} is missing from ${LEDGER_RELATIVE}`)
  return value
}

function arrayOf(root, path) {
  const value = need(root, path)
  if (!Array.isArray(value)) fail(`${path} must be an array in ${LEDGER_RELATIVE}`)
  return value
}

function stringArray(root, path) {
  const value = arrayOf(root, path)
  for (const entry of value) if (typeof entry !== 'string' || entry === '') fail(`${path} must hold non-empty strings`)
  return value
}

function noDuplicates(entries, what) {
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry)) fail(`${what} lists ${entry} more than once`)
    seen.add(entry)
  }
}

function expectTotal(ledger, section, key, actual) {
  const value = at(ledger, `totals.${section}.${key}`)
  if (value !== actual) {
    fail(`totals.${section}.${key} is ${JSON.stringify(value)}, but the ledger arrays give ${actual}; the ledger is inconsistent`)
  }
}

/**
 * Read + verify the ledger, then derive the model the renderer needs. Every
 * check here is a refusal to guess: an inconsistent ledger is an error, never
 * a partially rendered file.
 */
export function buildModel(ledger, { members = SERVED_MEMBERS, payloads = SERVED_EVENT_PAYLOADS } = {}) {
  if (!isObject(ledger)) fail(`${LEDGER_RELATIVE} is not a JSON object`)
  const pin = need(ledger, 'pin')
  for (const key of ['version', 'commit', 'file', 'sha256']) {
    if (typeof need(pin, key) !== 'string' || pin[key] === '') fail(`pin.${key} must be a non-empty string`)
  }
  if (!Number.isInteger(pin.bytes) || pin.bytes <= 0) fail('pin.bytes must be a positive integer')

  const declaredNs = stringArray(ledger, 'declared.namespaces')
  const declaredMethods = stringArray(ledger, 'declared.methods')
  const declaredProps = stringArray(ledger, 'declared.properties')
  need(ledger, 'declared.events')
  const events = [...stringArray(ledger, 'declared.events.engine'), ...stringArray(ledger, 'declared.events.op')]
  const classicSpellings = stringArray(ledger, 'declared.events.classicSpellings')
  const declaredEventNames = new Set([...events, ...classicSpellings])
  const surfaces = need(ledger, 'declared.elements.surfaces')
  if (!isObject(surfaces) || Object.keys(surfaces).length === 0) fail('declared.elements.surfaces must be a non-empty object')
  const surfaceNames = Object.keys(surfaces)
  const components = stringArray(ledger, 'declared.renderSites')

  const servedNs = stringArray(ledger, 'served.namespaces')
  const servedMethods = stringArray(ledger, 'served.methods')
  const servedProps = stringArray(ledger, 'served.properties')
  const servedEvents = stringArray(ledger, 'served.events')
  const servedElements = stringArray(ledger, 'served.elements')
  const servedRenderSites = stringArray(ledger, 'served.renderSites')
  const absentNs = stringArray(ledger, 'absent.namespaces')
  const absentMethods = stringArray(ledger, 'absent.methods')
  const absentProps = stringArray(ledger, 'absent.properties')
  const absentEvents = stringArray(ledger, 'absent.events')
  const absentRenderSites = stringArray(ledger, 'absent.renderSites')
  const refusedNs = stringArray(ledger, 'refused.namespaces')
  const refusedProps = arrayOf(ledger, 'refused.properties')
  const refusedMethods = arrayOf(ledger, 'refused.methods')

  for (const [name, entries] of [
    ['declared.namespaces', declaredNs],
    ['declared.methods', declaredMethods],
    ['declared.properties', declaredProps],
    ['served.namespaces', servedNs],
    ['served.methods', servedMethods],
    ['absent.namespaces', absentNs],
    ['absent.methods', absentMethods],
    ['absent.properties', absentProps],
    ['served.events', servedEvents],
    ['refused.namespaces', refusedNs],
  ]) {
    noDuplicates(entries, name)
  }

  // The ledger's partitions must be complete and disjoint, with the totals the
  // ledger prints about itself. This is what makes the file a claim about the
  // whole pinned surface rather than a sample of it.
  const declaredNsSet = new Set(declaredNs)
  const servedNsSet = new Set(servedNs)
  const refusedNsSet = new Set(refusedNs)
  const absentNsSet = new Set(absentNs)
  for (const namespace of servedNs) if (!declaredNsSet.has(namespace)) fail(`ledger serves namespace ${namespace}, which it does not declare`)
  for (const namespace of [...servedNs, ...refusedNs, ...absentNs]) if (!declaredNsSet.has(namespace)) fail(`namespace ${namespace} is classified but not declared`)
  for (const namespace of [...refusedNs, ...absentNs]) if (servedNsSet.has(namespace)) fail(`namespace ${namespace} is both served and refused or absent`)
  for (const namespace of absentNs) if (refusedNsSet.has(namespace)) fail(`namespace ${namespace} is both refused and absent`)
  if (servedNs.length + refusedNs.length + absentNs.length !== declaredNs.length) {
    fail('served + refused + absent namespaces do not cover the declared namespaces')
  }
  expectTotal(ledger, 'namespaces', 'declared', declaredNs.length)
  expectTotal(ledger, 'namespaces', 'served', servedNs.length)
  expectTotal(ledger, 'namespaces', 'refusedOnly', refusedNs.length)
  expectTotal(ledger, 'namespaces', 'absent', absentNs.length)

  const declaredMethodSet = new Set(declaredMethods)
  for (const member of servedMethods) if (!declaredMethodSet.has(member)) fail(`ledger serves method ${member}, which it does not declare`)
  for (const member of [...servedMethods, ...absentMethods, ...refusedMethods.map((entry) => entry.name)]) {
    if (!declaredMethodSet.has(member)) fail(`method ${member} is classified but not declared`)
  }
  expectTotal(ledger, 'methods', 'declared', declaredMethods.length)
  expectTotal(ledger, 'methods', 'served', servedMethods.length)
  expectTotal(ledger, 'methods', 'refused', refusedMethods.length)
  expectTotal(ledger, 'methods', 'absent', absentMethods.length)
  expectTotal(ledger, 'methods', 'wrongShape', 0)

  for (const member of refusedMethods) {
    if (!isObject(member) || typeof member.name !== 'string') fail('refused.methods entries must be {name, code} objects')
    if (typeof member.code !== 'string' || !/^ERR_MOD_HOST_[A-Z0-9_]+$/.test(member.code)) {
      fail(`refused method ${member.name} has no ERR_MOD_HOST_* code`)
    }
  }

  const declaredPropSet = new Set(declaredProps)
  for (const member of servedProps) fail(`ledger serves property ${member}; the authored shapes do not model served properties`)
  for (const member of absentProps) {
    if (!declaredPropSet.has(member)) fail(`property ${member} is classified but not declared`)
    const namespace = member.slice(0, member.indexOf('.'))
    if (!new Set(absentNs).has(namespace)) fail(`absent property ${member} lives in ${namespace}, which the ledger does not mark absent`)
  }
  for (const member of refusedProps) fail(`ledger refuses property ${member}; the authored shapes do not model refused properties`)
  expectTotal(ledger, 'properties', 'declared', declaredProps.length)
  expectTotal(ledger, 'properties', 'served', servedProps.length)
  expectTotal(ledger, 'properties', 'refused', refusedProps.length)
  expectTotal(ledger, 'properties', 'absent', absentProps.length)

  const servedEventSet = new Set(servedEvents)
  for (const event of servedEvents) if (!declaredEventNames.has(event)) fail(`ledger serves event ${event}, which it does not declare`)
  for (const event of absentEvents) if (!declaredEventNames.has(event) || servedEventSet.has(event)) fail(`absent event ${event} is not a declared, unserved event`)
  if (servedEvents.length + absentEvents.length !== declaredEventNames.size) {
    fail('served + absent events do not cover the declared event names')
  }
  expectTotal(ledger, 'events', 'declared', declaredEventNames.size)
  expectTotal(ledger, 'events', 'served', servedEvents.length)
  expectTotal(ledger, 'events', 'absent', absentEvents.length)

  expectTotal(ledger, 'elements', 'declared', servedElements.length + stringArray(ledger, 'absent.elements').length)
  expectTotal(ledger, 'elements', 'served', servedElements.length)
  expectTotal(ledger, 'elements', 'absent', stringArray(ledger, 'absent.elements').length)
  expectTotal(ledger, 'renderSites', 'declared', servedRenderSites.length + absentRenderSites.length)
  expectTotal(ledger, 'renderSites', 'served', servedRenderSites.length)
  expectTotal(ledger, 'renderSites', 'absent', absentRenderSites.length)

  for (const event of INVALIDATABLE_EVENTS) if (!declaredEventNames.has(event)) fail(`invalidatable event ${event} is not declared`)
  for (const event of Object.keys(payloads)) if (!servedEventSet.has(event)) fail(`payload table names ${event}, which the ledger does not serve`)
  for (const [event, label] of Object.entries(payloads)) {
    if (label !== DEFAULT_PAYLOAD && !PAYLOAD_LABELS.includes(label)) fail(`payload table gives ${event} unknown payload type ${label}`)
  }

  // The served set must equal the authored shape table: neither side may grow
  // without the other. This is the rule that catches a ledger that starts
  // serving a member before this host is known to serve it.
  const servedMethodSet = new Set(servedMethods)
  const shapeNames = Object.keys(members)
  noDuplicates(shapeNames, 'the authored member shapes')
  for (const member of servedMethods) if (!Object.hasOwn(members, member)) fail(`served member ${member} has no authored shape`)
  for (const member of shapeNames) if (!servedMethodSet.has(member)) fail(`authored shape ${member} is not a served member in the ledger`)
  for (const member of shapeNames) {
    const namespace = member.slice(0, member.indexOf('.'))
    if (!servedNsSet.has(namespace)) fail(`authored shape ${member} lives in unserved namespace ${namespace}`)
  }

  const namespaceOf = (member) => member.slice(0, member.indexOf('.'))
  const memberOf = (member) => member.slice(member.indexOf('.') + 1)
  const group = (names) => {
    const grouped = new Map()
    for (const name of names) {
      const namespace = namespaceOf(name)
      if (!grouped.has(namespace)) grouped.set(namespace, [])
      grouped.get(namespace).push(name)
    }
    return grouped
  }

  const absentByNamespace = group(absentMethods)
  const refusedByNamespace = group(refusedMethods.map((entry) => entry.name))
  for (const namespace of [...absentByNamespace.keys(), ...refusedByNamespace.keys()]) {
    if (servedNsSet.has(namespace)) continue
    if (absentNsSet.has(namespace) || refusedNsSet.has(namespace)) continue
    fail(`method of ${namespace} is classified, but ${namespace} is not a classified namespace`)
  }
  for (const namespace of absentNs) if (refusedByNamespace.has(namespace)) fail(`namespace ${namespace} is absent but has refused methods`)
  for (const namespace of refusedNs) {
    // A refused namespace may also hold absent methods: `process` and
    // `settings` have one refused member each and other members the pin
    // declares that this layer does not serve at all. The namespace-level
    // `never` covers both, and the reason names the refused member and code.
    if (!refusedByNamespace.has(namespace)) fail(`refused namespace ${namespace} has no refused member to name in its reason`)
  }

  const payloadBranches = []
  for (const label of PAYLOAD_LABELS) {
    const names = servedEvents.filter((event) => payloads[event] === label)
    payloadBranches.push({ label, names })
  }

  return {
    pin,
    surfaces: surfaceNames,
    components,
    invalidatableEvents: INVALIDATABLE_EVENTS,
    servedNamespaces: servedNs,
    absentNamespaces: absentNs,
    absentNamespaceEntries: absentNs.map((namespace) => ({ namespace, reason: ABSENT_REASON })),
    refusedNamespaceEntries: refusedNs.map((namespace) => {
      const refused = refusedMethods.filter((entry) => namespaceOf(entry.name) === namespace)
      return { namespace, reason: refused.map((entry) => refusedReason(entry)).join('; ') }
    }),
    servedMembers: new Map(servedNs.map((namespace) => [namespace, servedMethods.filter((member) => namespaceOf(member) === namespace).map(memberOf)])),
    absentMembers: new Map([...absentByNamespace].filter(([namespace]) => servedNsSet.has(namespace)).map(([namespace, names]) => [namespace, names.map(memberOf)])),
    refusedMembers: new Map(
      [...refusedByNamespace]
        .filter(([namespace]) => servedNsSet.has(namespace))
        .map(([namespace, names]) => [namespace, names.map((name) => ({ name: memberOf(name), code: refusedMethods.find((entry) => entry.name === name).code }))]),
    ),
    servedEvents,
    payloadBranches,
    defaultPayload: DEFAULT_PAYLOAD,
    members,
  }
}

/** Render the declaration. Pure: same ledger in, same bytes out. */
export function renderModTypes(ledger) {
  const model = buildModel(ledger)
  const lines = []
  const push = (...entries) => lines.push(...entries)

  push(
    `// Generated by scripts/gen-mod-types.mjs from ${LEDGER_RELATIVE} (${DECISION_TYPES}); never edit.`,
    `// Served members are typed; absent/refused members are \`never\`. No Claude Code installation is`,
    `// needed (${DECISION_NO_CLAUDE_CODE}): map the \`claude-code\` specifier to this file in tsconfig.`,
    '',
  )

  push(
    'export type PluginOptions = Readonly<Record<string, string | number | boolean | string[]>>',
    '',
    '/** Classic hook payload fields are passed through unmodelled (planned). */',
    'export type Payload = Readonly<Record<string, unknown>>',
    '/** The matcher grammar is not modelled yet (planned). */',
    'export type Matcher = Readonly<Record<string, unknown>>',
    '',
    'export interface PromptBlock {',
    '  name: string',
    '  text: string',
    '}',
    'export interface PromptContext {',
    '  blocks: PromptBlock[]',
    '  instructionFiles?: string[]',
    '}',
    'export interface ToolEnvelope {',
    '  tool: string',
    '  tool_use_id: string',
    '  [argument: string]: unknown',
    '}',
    '',
    "export type FsKind = 'file' | 'dir' | 'other'",
    'export interface FsEntry {',
    '  name: string',
    '  kind: FsKind',
    '  size: number',
    '  isLink: boolean',
    '}',
    'export interface FsStat {',
    '  kind: FsKind',
    '  size: number',
    '  mtimeMs: number',
    '  isLink: boolean',
    '  realPath?: string',
    '}',
    '',
    'export interface Pane {',
    '  id: string',
    '  title?: string',
    '  rows?: number',
    '  columns?: number',
    "  placement?: 'widget'",
    '  focus?: boolean',
    '}',
    'export interface PaneResult {',
    '  isPlaced: boolean',
    '  reason?: string',
    '}',
    '',
    `export type Surface = ${model.surfaces.map((name) => `'${name}'`).join(' | ')}`,
    `export type Component = ${model.components.map((name) => `'${name}'`).join(' | ')}`,
    `export type InvalidatableEvent = ${model.invalidatableEvents.map((name) => `'${name}'`).join(' | ')}`,
    '/** Element availability per surface is not modelled yet (planned). */',
    'export type ElementTable = Readonly<Record<string, (props?: unknown, ...children: unknown[]) => unknown>>',
    '',
    'export interface VcsInfo {',
    "  vcs: 'git'",
    '  root: string',
    '  mainRoot: string | null',
    '  revision: string | null',
    '  branch: string | null',
    '  defaultBranch: string | null',
    '  remote: string | null',
    '}',
    'export interface VcsDiffInput {',
    '  path: string',
    "  vcs: 'git'",
    "  base: 'head' | 'default'",
    '  paths?: string[]',
    '  isStatOnly?: boolean',
    '}',
    'export interface VcsDiffEntry {',
    '  path: string',
    '  renamedFrom: string | null',
    '  added: number',
    '  removed: number',
    '  isBinary: boolean',
    '  isUntracked: boolean',
    '  patch?: string',
    '}',
    'export type VcsDiff =',
    '  | { base: string; files: VcsDiffEntry[] }',
    '  | { unknown: string }',
    '',
    'export interface Next {',
    '  (event?: unknown): Promise<unknown>',
    "  to: (event: unknown, tier: 'user' | 'append' | 'builtin') => Promise<unknown>",
    '  is: (pattern: string, event?: unknown) => boolean',
    '  signal: AbortSignal',
    '  event: string',
    '  /** Runtime reports trace, origin and budget rows; their fields are not modelled yet (planned). */',
    '  trace?: unknown[]',
    '}',
    'export interface Registration {',
    '  catch(handler: (dollar: Dollar, event: unknown, next: Next) => unknown): void',
    '}',
    '',
    `export type ServedEvent = ${model.servedEvents.map((event) => `'${event}'`).join(' | ')}`,
  )

  const branchLines = model.payloadBranches
    .filter((branch) => branch.names.length > 0)
    .map((branch, index) => {
      const condition = branch.names.map((name) => `'${name}'`).join(' | ')
      return `${index === 0 ? '' : '  : '}E extends ${condition} ? ${branch.label}`
    })
  push(
    `export type Hook<E extends ServedEvent = ServedEvent> = ${branchLines.join('\n')}`,
    `  : ${model.defaultPayload}`,
    'export type Handler<P extends ServedEvent> = (dollar: Dollar, event: Hook<P>, next: Next) => unknown',
    'export interface On {',
    '  <P extends ServedEvent>(pattern: P, hook: Handler<P>): Registration',
    '  <P extends ServedEvent>(pattern: P, matcher: Matcher, hook: Handler<P>): Registration',
    '}',
    '',
    'export interface Dollar {',
  )

  for (const namespace of model.servedNamespaces) {
    push(`  ${namespace}: {`)
    for (const member of model.servedMembers.get(namespace) ?? []) {
      push(`    ${model.members[`${namespace}.${member}`]};`)
    }
    for (const member of model.absentMembers.get(namespace) ?? []) {
      push(`    /** @deprecated ${ABSENT_REASON} */ ${member}: never;`)
    }
    for (const member of model.refusedMembers.get(namespace) ?? []) {
      push(`    /** @deprecated ${refusedReason({ name: `${namespace}.${member.name}`, code: member.code })} */ ${member.name}: never;`)
    }
    push('  };')
  }
  for (const entry of [...model.absentNamespaceEntries, ...model.refusedNamespaceEntries]) {
    push(`  /** @deprecated ${entry.reason} */ ${entry.namespace}: never;`)
  }
  push('}', '')

  return lines.join('\n')
}

/**
 * `--check`: compare the committed file with a fresh render and enforce the raw
 * cap. Returns a result object so the CLI and the tests share one decision.
 */
export function checkTypes({ ledgerFile = ledgerPath, typesFile = typesPath, read = readFileSync, cap = RAW_BYTE_CAP } = {}) {
  let ledger
  try {
    ledger = JSON.parse(read(ledgerFile, 'utf8'))
  } catch (error) {
    fail(`cannot read ${LEDGER_RELATIVE}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = renderModTypes(ledger)
  const bytes = Buffer.byteLength(text)
  const gzip = gzipSync(Buffer.from(text), { level: 9 }).length
  if (bytes > cap) {
    return { ok: false, reason: 'cap', bytes, gzip, cap }
  }
  let committed
  try {
    committed = read(typesFile, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'missing', bytes, gzip, error: error instanceof Error ? error.message : String(error) }
  }
  if (committed !== text) {
    const committedLines = committed.split('\n')
    const renderedLines = text.split('\n')
    const index = renderedLines.findIndex((line, lineIndex) => line !== committedLines[lineIndex])
    return {
      ok: false,
      reason: 'drift',
      bytes,
      gzip,
      committedBytes: Buffer.byteLength(committed),
      line: index === -1 ? Math.min(committedLines.length, renderedLines.length) + 1 : index + 1,
    }
  }
  return { ok: true, bytes, gzip }
}

function main(argv) {
  let out = typesPath
  let ledgerFile = ledgerPath
  let check = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--check') check = true
    else if (argument === '--out' || argument === '--ledger') {
      const value = argv[++index]
      if (value === undefined || value === '') fail(`${argument} needs a path`)
      if (argument === '--out') out = resolve(value)
      else ledgerFile = resolve(value)
    } else {
      fail(`unknown argument ${JSON.stringify(argument)}`)
    }
  }

  if (check) {
    const result = checkTypes({ ledgerFile, typesFile: out })
    const size = `${result.bytes} bytes raw, ${result.gzip} bytes gzip -9`
    if (result.ok) {
      process.stdout.write(`gen-mod-types: ${TYPES_RELATIVE} matches ${LEDGER_RELATIVE} (${size}, cap ${RAW_BYTE_CAP} bytes)\n`)
    } else if (result.reason === 'cap') {
      process.stderr.write(
        `gen-mod-types: ${TYPES_RELATIVE} renders to ${size}, over the ${RAW_BYTE_CAP}-byte cap (D95); ` +
          'a wider surface needs a decision entry, not a bigger file\n',
      )
      process.exitCode = 1
    } else if (result.reason === 'missing') {
      process.stderr.write(`gen-mod-types: cannot read ${TYPES_RELATIVE}: ${result.error}\n`)
      process.exitCode = 1
    } else {
      process.stderr.write(
        `gen-mod-types: ${TYPES_RELATIVE} is stale (${result.committedBytes} committed vs ${result.bytes} rendered bytes, ` +
          `first difference at line ${result.line}); run npm run gen:types and commit the result\n`,
      )
      process.exitCode = 1
    }
    return
  }

  let ledger
  try {
    ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  } catch (error) {
    fail(`cannot read ${LEDGER_RELATIVE}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = renderModTypes(ledger)
  const bytes = Buffer.byteLength(text)
  if (bytes > RAW_BYTE_CAP) {
    fail(`rendered ${TYPES_RELATIVE} is ${bytes} bytes, over the ${RAW_BYTE_CAP}-byte cap (D95); a wider surface needs a decision entry`)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  process.stdout.write(`gen-mod-types: wrote ${TYPES_RELATIVE} (${bytes} bytes raw, ${gzipSync(Buffer.from(text), { level: 9 }).length} bytes gzip -9)\n`)
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
