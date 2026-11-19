/**
 * `grants.yml` — the hash-pinned grant store for exec-class artifacts
 * (AGENTS.md §3.5, DECISIONS D25).
 *
 * The file lives next to `installs.yml` and uses the same deliberately small,
 * canonical YAML subset as D23: a `schema` tag, then two records lists, one
 * field per line, every value a double-quoted JSON string. The reader accepts
 * only the canonical form and rejects everything else with a `file:line`
 * reason; it never repairs a malformed store. A missing file is an empty
 * store — which is also the safe default, because exec is default-off.
 *
 * Scope is a property of the record, not of the file location: `grants.yml`
 * is one profile file, and each grant/revoke names the scope at which it was
 * issued. Resolution prefers `local` over `project` over `user`; within one
 * scope a revoke beats a grant.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const GRANTS_SCHEMA = 'dsh-anyplugin/grants@1'

export type Scope = 'local' | 'project' | 'user'

/** Narrowest first. Index in this list is the precedence rank. */
export const SCOPES: readonly Scope[] = ['local', 'project', 'user']

/** The only capability this package can classify today. */
export const EXEC_CAPABILITY = 'exec'

export interface GrantRecord {
  /** Install identity, `<dialect>:<plugin>` (D23). */
  plugin: string
  capability: string
  /** Artifact identity within the plugin, e.g. `hook:PostToolUse#0`. */
  target: string
  /** `sha256:<hex>` over the bytes that will run. */
  artifactHash: string
  /** ISO-8601 UTC instant the grant was issued. */
  grantedAt: string
  scope: Scope
}

export interface RevokeRecord {
  plugin: string
  capability: string
  target: string
  scope: Scope
}

export interface Grants {
  schema: typeof GRANTS_SCHEMA
  grants: GrantRecord[]
  revokes: RevokeRecord[]
}

/** A rejected file or object. `reason` never includes the file/line prefix. */
export class GrantsFileError extends Error {
  readonly reason: string
  readonly file?: string
  readonly line?: number

  constructor(reason: string, details: { file?: string; line?: number } = {}) {
    const where =
      details.file === undefined ? '' : `${details.file}${details.line === undefined ? '' : `:${details.line}`}: `
    super(`${where}${reason}`)
    this.name = 'GrantsFileError'
    this.reason = reason
    this.file = details.file
    this.line = details.line
  }
}

const PLUGIN = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._@-]*$/
const CAPABILITY = /^[a-z][a-z0-9-]*$/
const TARGET = /^[a-z][a-z0-9-]*:\S+$/
const HASH = /^sha256:[0-9a-f]{64}$/
const GRANTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const SCOPE = /^(?:local|project|user)$/
const FIELD = /^([a-z][A-Za-z0-9]*):\s+("(?:[^"\\]|\\.)*")\s*$/
const SCHEMA_LINE = /^schema:\s+("(?:[^"\\]|\\.)*")\s*$/
const GRANTS_LINE = /^grants:(?:\s*\[\s*\])?\s*$/
const REVOKES_LINE = /^revokes:(?:\s*\[\s*\])?\s*$/

const GRANT_FIELDS = ['plugin', 'capability', 'target', 'artifactHash', 'grantedAt', 'scope'] as const
const REVOKE_FIELDS = ['plugin', 'capability', 'target', 'scope'] as const

interface Significant {
  text: string
  line: number
}

function significantLines(text: string): Significant[] {
  const out: Significant[] = []
  const lines = text.replace(/^\uFEFF/, '').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].replace(/\r$/, '')
    if (/^\s*(?:#.*)?$/.test(raw)) continue
    out.push({ text: raw, line: index + 1 })
  }
  return out
}

function unquote(file: string, line: number, token: string): string {
  try {
    return JSON.parse(token) as string
  } catch {
    throw new GrantsFileError('invalid double-quoted string', { file, line })
  }
}

function scopeOf(value: string, file: string, line: number): Scope {
  if (!SCOPE.test(value)) throw new GrantsFileError(`"scope" must be one of ${SCOPES.join(', ')}`, { file, line })
  return value as Scope
}

function checkShared(field: string, value: string, file: string, line: number): void {
  if (field === 'plugin' && !PLUGIN.test(value)) {
    throw new GrantsFileError('"plugin" must be a "<dialect>:<plugin>" identity', { file, line })
  }
  if (field === 'capability' && !CAPABILITY.test(value)) {
    throw new GrantsFileError(`"capability" must match ${CAPABILITY}`, { file, line })
  }
  if (field === 'target' && !TARGET.test(value)) {
    throw new GrantsFileError('"target" must look like "<kind>:<name>" and contain no whitespace', { file, line })
  }
}

function validateGrantRecord(
  raw: Record<string, string>,
  file: string,
  line: number,
  fieldLines: Record<string, number> = {},
): GrantRecord {
  const at = (field: string): number => fieldLines[field] ?? line
  for (const field of GRANT_FIELDS) {
    if (!(field in raw)) throw new GrantsFileError(`missing required field "${field}"`, { file, line })
  }
  for (const field of Object.keys(raw)) {
    if (!(GRANT_FIELDS as readonly string[]).includes(field)) {
      throw new GrantsFileError(`unknown field "${field}"`, { file, line: at(field) })
    }
  }
  for (const field of GRANT_FIELDS) checkShared(field, raw[field], file, at(field))
  if (!HASH.test(raw.artifactHash)) {
    throw new GrantsFileError('"artifactHash" must look like "sha256:<64 lowercase hex>"', { file, line: at('artifactHash') })
  }
  if (!GRANTED_AT.test(raw.grantedAt) || Number.isNaN(Date.parse(raw.grantedAt))) {
    throw new GrantsFileError('"grantedAt" must be an ISO-8601 UTC instant (…Z)', { file, line: at('grantedAt') })
  }
  return {
    plugin: raw.plugin,
    capability: raw.capability,
    target: raw.target,
    artifactHash: raw.artifactHash,
    grantedAt: raw.grantedAt,
    scope: scopeOf(raw.scope, file, at('scope')),
  }
}

function validateRevokeRecord(
  raw: Record<string, string>,
  file: string,
  line: number,
  fieldLines: Record<string, number> = {},
): RevokeRecord {
  const at = (field: string): number => fieldLines[field] ?? line
  for (const field of REVOKE_FIELDS) {
    if (!(field in raw)) throw new GrantsFileError(`missing required field "${field}"`, { file, line })
  }
  for (const field of Object.keys(raw)) {
    if (!(REVOKE_FIELDS as readonly string[]).includes(field)) {
      throw new GrantsFileError(`unknown field "${field}"`, { file, line: at(field) })
    }
  }
  for (const field of REVOKE_FIELDS) checkShared(field, raw[field], file, at(field))
  return {
    plugin: raw.plugin,
    capability: raw.capability,
    target: raw.target,
    scope: scopeOf(raw.scope, file, at('scope')),
  }
}

/** One grant per `plugin + capability + target + scope`. */
function grantKey(record: { plugin: string; capability: string; target: string; scope: Scope }): string {
  return `${record.plugin}\u0000${record.capability}\u0000${record.target}\u0000${record.scope}`
}

/** Validate a hand-built `Grants` value with the same rules as the reader. */
export function validateGrants(grants: Grants): void {
  if (grants === null || typeof grants !== 'object') throw new GrantsFileError('grants must be an object')
  if (grants.schema !== GRANTS_SCHEMA) {
    throw new GrantsFileError(`unsupported schema ${JSON.stringify(grants.schema)}; expected "${GRANTS_SCHEMA}"`)
  }
  if (!Array.isArray(grants.grants)) throw new GrantsFileError('"grants" must be an array')
  if (!Array.isArray(grants.revokes)) throw new GrantsFileError('"revokes" must be an array')

  const seenGrants = new Set<string>()
  grants.grants.forEach((record, index) => {
    const line = index + 1
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new GrantsFileError('each grant must be an object', { line })
    }
    const checked = validateGrantRecord(record as unknown as Record<string, string>, '<grants>', line)
    const key = grantKey(checked)
    if (seenGrants.has(key)) throw new GrantsFileError(`duplicate grant for "${checked.target}" (${key.split('\u0000')[3]} scope)`, { line })
    seenGrants.add(key)
  })

  const seenRevokes = new Set<string>()
  grants.revokes.forEach((record, index) => {
    const line = index + 1
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new GrantsFileError('each revoke must be an object', { line })
    }
    const checked = validateRevokeRecord(record as unknown as Record<string, string>, '<grants>', line)
    const key = grantKey(checked)
    if (seenRevokes.has(key)) throw new GrantsFileError(`duplicate revoke for "${checked.target}"`, { line })
    seenRevokes.add(key)
  })
}

/** An empty store — also what a profile that never granted anything has. */
export function emptyGrants(): Grants {
  return { schema: GRANTS_SCHEMA, grants: [], revokes: [] }
}

/** `grants.yml` sits next to `installs.yml`; the caller keeps only one path. */
export function grantsPath(installsFile: string): string {
  return join(dirname(installsFile), 'grants.yml')
}

/**
 * Read and validate `grants.yml`.
 *
 * A missing file is an empty store (exec is default-off). A file that exists
 * but does not parse is an error: treating it as empty would silently revoke
 * every exec grant, which is safe, but it would also hide a corrupt store from
 * the user — and guessing is how a grant gets re-issued without intent.
 */
export function readGrants(file: string): Grants {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyGrants()
    throw error
  }
  return parseGrants(text, file)
}

/** Pure parser, exported for tests and for callers that already hold the text. */
export function parseGrants(text: string, file = '<grants>'): Grants {
  const lines = significantLines(text)
  if (lines.length === 0) throw new GrantsFileError('empty file; expected a schema line', { file, line: 1 })

  const schemaMatch = SCHEMA_LINE.exec(lines[0].text)
  if (!schemaMatch) {
    throw new GrantsFileError(`expected \`schema: "${GRANTS_SCHEMA}"\` on the first line`, { file, line: lines[0].line })
  }
  const schema = unquote(file, lines[0].line, schemaMatch[1])
  if (schema !== GRANTS_SCHEMA) {
    throw new GrantsFileError(`unsupported schema "${schema}"; expected "${GRANTS_SCHEMA}"`, { file, line: lines[0].line })
  }

  let section: 'grants' | 'revokes' | undefined
  let inlineEmpty = false
  let grantsSeen = false
  let revokesSeen = false
  let current:
    | { section: 'grants' | 'revokes'; values: Record<string, string>; lines: Record<string, number>; line: number }
    | undefined
  const grants: GrantRecord[] = []
  const revokes: RevokeRecord[] = []
  const seenGrants = new Map<string, number>()
  const seenRevokes = new Map<string, number>()

  const finish = (): void => {
    if (!current) return
    const values = current.values
    if (current.section === 'grants') {
      const checked = validateGrantRecord(values, file, current.line, current.lines)
      const key = grantKey(checked)
      const previous = seenGrants.get(key)
      if (previous !== undefined) {
        throw new GrantsFileError(`duplicate grant for "${checked.target}" (first at line ${previous})`, {
          file,
          line: current.line,
        })
      }
      seenGrants.set(key, current.line)
      grants.push(checked)
    } else {
      const checked = validateRevokeRecord(values, file, current.line, current.lines)
      const key = grantKey(checked)
      const previous = seenRevokes.get(key)
      if (previous !== undefined) {
        throw new GrantsFileError(`duplicate revoke for "${checked.target}" (first at line ${previous})`, {
          file,
          line: current.line,
        })
      }
      seenRevokes.set(key, current.line)
      revokes.push(checked)
    }
    current = undefined
  }

  for (let index = 1; index < lines.length; index++) {
    const { text: raw, line } = lines[index]
    if (raw.startsWith('grants:') && GRANTS_LINE.test(raw)) {
      if (grantsSeen) throw new GrantsFileError('duplicate `grants` section', { file, line })
      finish()
      grantsSeen = true
      section = 'grants'
      inlineEmpty = /\[\s*\]$/.test(raw)
      continue
    }
    if (raw.startsWith('revokes:') && REVOKES_LINE.test(raw)) {
      if (!grantsSeen) throw new GrantsFileError('expected a `grants` section before `revokes`', { file, line })
      if (revokesSeen) throw new GrantsFileError('duplicate `revokes` section', { file, line })
      finish()
      revokesSeen = true
      section = 'revokes'
      inlineEmpty = /\[\s*\]$/.test(raw)
      continue
    }

    let body: string
    if (raw.startsWith('  - ')) {
      if (section === undefined) throw new GrantsFileError('record before a `grants:` section', { file, line })
      finish()
      current = { section, values: {}, lines: {}, line }
      body = raw.slice(4)
    } else if (raw.startsWith('    ') && !raw.startsWith('     ')) {
      if (!current) throw new GrantsFileError('field outside a record', { file, line })
      body = raw.slice(4)
    } else {
      throw new GrantsFileError('expected `  - ` to start a record, four spaces to continue one, or a section header', {
        file,
        line,
      })
    }

    if (inlineEmpty) {
      throw new GrantsFileError('`[]` cannot be followed by records in the same section', { file, line })
    }
    const field = FIELD.exec(body)
    if (!field) throw new GrantsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
    const [, key, token] = field
    const allowed = current?.section === 'grants' ? GRANT_FIELDS : REVOKE_FIELDS
    if (current && !(allowed as readonly string[]).includes(key)) {
      throw new GrantsFileError(`unknown field "${key}"`, { file, line })
    }
    if (current && key in current.values) throw new GrantsFileError(`duplicate field "${key}"`, { file, line })
    if (current) {
      current.values[key] = unquote(file, line, token)
      current.lines[key] = line
    }
  }
  finish()

  if (!grantsSeen) {
    throw new GrantsFileError('expected `grants:` (or `grants: []`) after the schema', {
      file,
      line: lines[1]?.line ?? lines[0].line + 1,
    })
  }
  if (!revokesSeen) {
    throw new GrantsFileError('expected a `revokes:` section (use `revokes: []` when empty)', {
      file,
      line: lines.length > 0 ? lines[lines.length - 1].line : lines[0].line,
    })
  }
  return { schema: GRANTS_SCHEMA, grants, revokes }
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function scopeRank(scope: Scope): number {
  return SCOPES.indexOf(scope)
}

export function sortGrants(records: readonly GrantRecord[]): GrantRecord[] {
  return [...records].sort((a, b) => {
    const left = `${a.plugin}\u0000${a.capability}\u0000${a.target}\u0000${String(scopeRank(a.scope)).padStart(1, '0')}`
    const right = `${b.plugin}\u0000${b.capability}\u0000${b.target}\u0000${String(scopeRank(b.scope)).padStart(1, '0')}`
    return left < right ? -1 : left > right ? 1 : 0
  })
}

export function sortRevokes(records: readonly RevokeRecord[]): RevokeRecord[] {
  return [...records].sort((a, b) => {
    const left = `${a.plugin}\u0000${a.capability}\u0000${a.target}\u0000${String(scopeRank(a.scope)).padStart(1, '0')}`
    const right = `${b.plugin}\u0000${b.capability}\u0000${b.target}\u0000${String(scopeRank(b.scope)).padStart(1, '0')}`
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** Serialize to the canonical form; validates first, so it cannot write junk. */
export function serializeGrants(grants: Grants): string {
  validateGrants(grants)
  const lines = [
    '# dsh-anyplugin grants — generated; edit through the installer.',
    `schema: ${quote(GRANTS_SCHEMA)}`,
  ]
  const grantsSorted = sortGrants(grants.grants)
  if (grantsSorted.length === 0) {
    lines.push('grants: []')
  } else {
    lines.push('grants:')
    for (const record of grantsSorted) {
      lines.push(`  - plugin: ${quote(record.plugin)}`)
      lines.push(`    capability: ${quote(record.capability)}`)
      lines.push(`    target: ${quote(record.target)}`)
      lines.push(`    artifactHash: ${quote(record.artifactHash)}`)
      lines.push(`    grantedAt: ${quote(record.grantedAt)}`)
      lines.push(`    scope: ${quote(record.scope)}`)
    }
  }
  const revokesSorted = sortRevokes(grants.revokes)
  if (revokesSorted.length === 0) {
    lines.push('revokes: []')
  } else {
    lines.push('revokes:')
    for (const record of revokesSorted) {
      lines.push(`  - plugin: ${quote(record.plugin)}`)
      lines.push(`    capability: ${quote(record.capability)}`)
      lines.push(`    target: ${quote(record.target)}`)
      lines.push(`    scope: ${quote(record.scope)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write the store atomically: a temp file in the same directory, then rename.
 * A crash mid-write must never leave a half-valid grants.yml.
 */
export function writeGrants(file: string, grants: Grants): void {
  const text = serializeGrants(grants)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export interface GrantSpec {
  plugin: string
  capability: string
  target: string
  artifactHash: string
  grantedAt?: string
}

/**
 * Add or replace one grant. Replacement is keyed by
 * `plugin + capability + target + scope`; the artifact hash is *not* part of
 * the key, so granting changed bytes at the same scope updates the pin instead
 * of leaving a stale grant behind.
 */
export function grant(store: Grants, entry: GrantSpec, options: { scope: Scope; grantedAt?: string }): Grants {
  const grantedAt = entry.grantedAt ?? options.grantedAt ?? new Date().toISOString()
  const record: GrantRecord = {
    plugin: entry.plugin,
    capability: entry.capability,
    target: entry.target,
    artifactHash: entry.artifactHash,
    grantedAt,
    scope: options.scope,
  }
  const kept = store.grants.filter((item) => grantKey(item) !== grantKey(record))
  const next: Grants = { schema: GRANTS_SCHEMA, grants: sortGrants([...kept, record]), revokes: sortRevokes(store.revokes) }
  validateGrants(next)
  return next
}

export interface RevokeSpec {
  plugin: string
  capability: string
  target: string
}

/** Add or replace one revoke at a scope. A revoke needs no artifact hash. */
export function revoke(store: Grants, entry: RevokeSpec, options: { scope: Scope }): Grants {
  const record: RevokeRecord = {
    plugin: entry.plugin,
    capability: entry.capability,
    target: entry.target,
    scope: options.scope,
  }
  const kept = store.revokes.filter((item) => grantKey(item) !== grantKey(record))
  const next: Grants = { schema: GRANTS_SCHEMA, grants: sortGrants(store.grants), revokes: sortRevokes([...kept, record]) }
  validateGrants(next)
  return next
}
