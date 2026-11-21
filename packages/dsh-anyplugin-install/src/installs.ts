/**
 * `installs.yml` — the profile-global installation lock.
 *
 * Format decision D23. The file is machine-written and human-audited, so it is
 * a deliberately small YAML subset: a `schema` tag, then one record per
 * installed plugin, one field per line, every value a double-quoted JSON
 * string. JSON quoting keeps the reader exact (no YAML implicit types: `no`
 * is not a boolean, `1.2.3` is not a number) and keeps the writer boring.
 *
 * The reader accepts the canonical form only. Anything it does not understand
 * is rejected with a reason and a line number instead of being guessed or
 * repaired (AGENTS.md §3.4: persistence must be reproducible, not clever).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

export const INSTALLS_SCHEMA = 'dsh-anyplugin/installs@1'

/**
 * Where a record came from when it was installed through a marketplace: the
 * catalog's own `name`, the entry the user asked for, and the version the
 * entry advertised (when it declared one). A later pin bump can use this to
 * say where a record came from without remembering the checkout.
 */
export interface MarketplaceProvenance {
  marketplace: string
  entry: string
  version?: string
}

/**
 * `source` provenance: either the legacy label string
 * (`plugin-dir:fixtures/claude-skills-only`) or, for a marketplace install,
 * the structured catalog identity.
 *
 * The file format is unchanged (D23): every value is one double-quoted JSON
 * string. Structured provenance is a JSON object *inside* that string, so the
 * reader stays exact and a `@1` reader still accepts the file (it only
 * requires `source` to be a non-empty string).
 */
export type InstallSource = string | MarketplaceProvenance

/** One installed plugin. Identity is `<dialect>:<name>`; `version` is metadata. */
export interface InstallRecord {
  /** Foreign harness the plugin was written for. Only `claude-code` is known. */
  dialect: string
  /** Plugin name as the dialect reads it from the artifact. */
  name: string
  /** Plugin version as the dialect reads it from the artifact. */
  version: string
  /** Versioned artifact root (the source tree that is read on every compile). */
  root: string
  /** Stable per-plugin data directory; survives version updates (D2). */
  dataDir: string
  /** Host pin the artifact was read against, e.g. `claude-code@2.1.329`. */
  pin: string
  /**
   * Provenance, e.g. `plugin-dir:fixtures/claude-skills-only`, or the
   * marketplace catalog identity for `rig marketplace install` (optional).
   */
  source?: InstallSource
}

export interface Installs {
  schema: typeof INSTALLS_SCHEMA
  plugins: InstallRecord[]
}

/** A rejected file or object. `reason` never includes the file/line prefix. */
export class InstallsFileError extends Error {
  readonly reason: string
  readonly file?: string
  readonly line?: number

  constructor(reason: string, details: { file?: string; line?: number } = {}) {
    const where = details.file === undefined ? '' : `${details.file}${details.line === undefined ? '' : `:${details.line}`}: `
    super(`${where}${reason}`)
    this.name = 'InstallsFileError'
    this.reason = reason
    this.file = details.file
    this.line = details.line
  }
}

const REQUIRED = ['dialect', 'name', 'version', 'root', 'dataDir', 'pin'] as const
const OPTIONAL = ['source'] as const
const FIELDS = [...REQUIRED, ...OPTIONAL]
const FIELD = /^([a-z][A-Za-z0-9]*):\s+("(?:[^"\\]|\\.)*")\s*$/
const DIALECT = /^[a-z][a-z0-9-]*$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
const VERSION = /^\S+$/
const PIN = /^[a-z][a-z0-9-]*@\S+$/
const SCHEMA_LINE = /^schema:\s+("(?:[^"\\]|\\.)*")\s*$/
const PLUGINS_LINE = /^plugins:(?:\s*\[\s*\])?\s*$/
const SOURCE_FIELDS = ['marketplace', 'entry', 'version'] as const
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

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
    throw new InstallsFileError('invalid double-quoted string', { file, line })
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one `source` value, in either the string form the file holds or the
 * object form a caller builds. Returns the canonical in-memory value so a
 * writer cannot reorder or smuggle fields.
 */
function validateSource(value: unknown, file: string, line: number): InstallSource {
  const where = { file, line }
  let parsed: unknown
  if (typeof value === 'string') {
    if (value.trim() === '') throw new InstallsFileError('"source" must be a non-empty string', where)
    if (!value.startsWith('{')) return value
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new InstallsFileError('"source" opens with "{" but is not a JSON object', where)
    }
  } else {
    parsed = value
  }
  if (!isPlainObject(parsed)) {
    throw new InstallsFileError('"source" must be a label or a {marketplace, entry, version} object', where)
  }
  for (const key of Object.keys(parsed)) {
    if (!(SOURCE_FIELDS as readonly string[]).includes(key)) {
      throw new InstallsFileError(`unknown field "source.${key}"`, where)
    }
  }
  const { marketplace, entry, version } = parsed
  if (typeof marketplace !== 'string' || marketplace.trim() === '') {
    throw new InstallsFileError('"source.marketplace" must be a non-empty string', where)
  }
  if (!MARKETPLACE_NAME.test(marketplace)) {
    throw new InstallsFileError('"source.marketplace" must be the marketplace name (letters, digits, ".", "_", "-")', where)
  }
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new InstallsFileError('"source.entry" must be a non-empty string', where)
  }
  if (!NAME.test(entry)) {
    throw new InstallsFileError('"source.entry" must be a bare plugin name (no ":", "/" or spaces)', where)
  }
  if (version !== undefined && (typeof version !== 'string' || !VERSION.test(version))) {
    throw new InstallsFileError('"source.version" must be non-empty and contain no whitespace', where)
  }
  const result: MarketplaceProvenance = { marketplace, entry }
  if (version !== undefined) result.version = version
  return result
}

/** The human-readable label recorded in the IR, e.g. `marketplace:local#hello`. */
export function sourceText(source: InstallSource): string {
  if (typeof source === 'string') return source
  const version = source.version === undefined ? '' : `@${source.version}`
  return `marketplace:${source.marketplace}#${source.entry}${version}`
}

/** The canonical string a record stores in the `source` field. */
function encodeSource(source: InstallSource): string {
  if (typeof source === 'string') return source
  return JSON.stringify({
    marketplace: source.marketplace,
    entry: source.entry,
    ...(source.version === undefined ? {} : { version: source.version }),
  })
}

function validateRecord(record: Record<string, unknown>, file: string, line: number): InstallRecord {
  const where = { file, line }
  for (const field of REQUIRED) {
    if (!(field in record)) throw new InstallsFileError(`missing required field "${field}"`, where)
    if (typeof record[field] !== 'string') throw new InstallsFileError(`"${field}" must be a string`, where)
  }
  const dialect = record.dialect as string
  const name = record.name as string
  const version = record.version as string
  const root = record.root as string
  const dataDir = record.dataDir as string
  const pin = record.pin as string
  const source = record.source === undefined ? undefined : validateSource(record.source, file, line)
  if (!DIALECT.test(dialect)) throw new InstallsFileError(`"dialect" must match ${DIALECT}`, where)
  if (!NAME.test(name)) throw new InstallsFileError(`"name" must be a bare plugin name (no ":", "/" or spaces)`, where)
  if (!VERSION.test(version)) throw new InstallsFileError('"version" must be non-empty and contain no whitespace', where)
  if (!isAbsolute(root)) throw new InstallsFileError('"root" must be an absolute path', where)
  if (!isAbsolute(dataDir)) throw new InstallsFileError('"dataDir" must be an absolute path', where)
  if (!PIN.test(pin)) throw new InstallsFileError('"pin" must look like "<tool>@<version>"', where)
  const result: InstallRecord = { dialect, name, version, root, dataDir, pin }
  if (source !== undefined) result.source = source
  return result
}

/** Validate a hand-built `Installs` value with the same rules as the reader. */
export function validateInstalls(installs: Installs): void {
  if (installs === null || typeof installs !== 'object') {
    throw new InstallsFileError('installs must be an object')
  }
  if (installs.schema !== INSTALLS_SCHEMA) {
    throw new InstallsFileError(`unsupported schema ${JSON.stringify(installs.schema)}; expected "${INSTALLS_SCHEMA}"`)
  }
  if (!Array.isArray(installs.plugins)) throw new InstallsFileError('"plugins" must be an array')
  const seen = new Map<string, number>()
  installs.plugins.forEach((record, index) => {
    const line = index + 1
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new InstallsFileError('each plugin must be an object', { line })
    }
    const raw = record as unknown as Record<string, unknown>
    const known = new Set<string>(FIELDS)
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) throw new InstallsFileError(`unknown field "${key}"`, { line })
    }
    const checked = validateRecord(raw, '<installs>', line)
    const id = `${checked.dialect}:${checked.name}`
    const previous = seen.get(id)
    if (previous !== undefined) {
      throw new InstallsFileError(`duplicate plugin "${id}" (first at record ${previous})`, { line })
    }
    seen.set(id, line)
  })
}

/**
 * Read and validate an `installs.yml`.
 *
 * Missing file is not an error: a profile that has never installed anything has
 * an empty lock. A file that exists but does not parse is an error — returning
 * an empty set there would silently uninstall every plugin.
 */
export function readInstalls(file: string): Installs {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: INSTALLS_SCHEMA, plugins: [] }
    throw error
  }
  return parseInstalls(text, file)
}

/** Pure parser, exported for tests and for callers that already hold the text. */
export function parseInstalls(text: string, file = '<installs>'): Installs {
  const lines = significantLines(text)
  if (lines.length === 0) throw new InstallsFileError('empty file; expected a schema line', { file, line: 1 })

  const schemaMatch = SCHEMA_LINE.exec(lines[0].text)
  if (!schemaMatch) {
    throw new InstallsFileError(`expected \`schema: "${INSTALLS_SCHEMA}"\` on the first line`, { file, line: lines[0].line })
  }
  const schema = unquote(file, lines[0].line, schemaMatch[1])
  if (schema !== INSTALLS_SCHEMA) {
    throw new InstallsFileError(`unsupported schema "${schema}"; expected "${INSTALLS_SCHEMA}"`, { file, line: lines[0].line })
  }
  if (lines.length < 2 || !PLUGINS_LINE.test(lines[1].text)) {
    throw new InstallsFileError('expected `plugins:` (or `plugins: []`) after the schema', {
      file,
      line: lines[1]?.line ?? lines[0].line + 1,
    })
  }

  const inlineEmpty = /^plugins:\s*\[\s*\]\s*$/.test(lines[1].text)
  const records: InstallRecord[] = []
  const seen = new Map<string, number>()
  let current: { values: Record<string, string>; line: number } | undefined

  const finish = (): void => {
    if (!current) return
    const checked = validateRecord(current.values, file, current.line)
    const id = `${checked.dialect}:${checked.name}`
    const previous = seen.get(id)
    if (previous !== undefined) {
      throw new InstallsFileError(`duplicate plugin "${id}" (first at line ${previous})`, { file, line: current.line })
    }
    seen.set(id, current.line)
    records.push(checked)
    current = undefined
  }

  for (let index = 2; index < lines.length; index++) {
    const { text: raw, line } = lines[index]
    let body: string
    if (raw.startsWith('  - ')) {
      if (inlineEmpty) {
        throw new InstallsFileError('`plugins: []` cannot be followed by plugin records', { file, line })
      }
      finish()
      current = { values: {}, line }
      body = raw.slice(4)
    } else if (raw.startsWith('    ') && !raw.startsWith('     ')) {
      if (!current) throw new InstallsFileError('field outside a plugin record', { file, line })
      body = raw.slice(4)
    } else {
      throw new InstallsFileError('expected "  - " to start a plugin record, or four spaces to continue one', {
        file,
        line,
      })
    }

    const field = FIELD.exec(body)
    if (!field) {
      throw new InstallsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
    }
    const [, key, token] = field
    if (!FIELDS.includes(key as (typeof FIELDS)[number])) {
      throw new InstallsFileError(`unknown field "${key}"`, { file, line })
    }
    if (key in current.values) throw new InstallsFileError(`duplicate field "${key}"`, { file, line })
    current.values[key] = unquote(file, line, token)
  }
  finish()

  return { schema: INSTALLS_SCHEMA, plugins: records }
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/** Serialize to the canonical form; validates first, so it cannot write junk. */
export function serializeInstalls(installs: Installs): string {
  validateInstalls(installs)
  const sorted = [...installs.plugins].sort((a, b) => {
    const left = `${a.dialect}:${a.name}`
    const right = `${b.dialect}:${b.name}`
    return left < right ? -1 : left > right ? 1 : 0
  })
  const lines = [
    '# dsh-anyplugin installs — generated; edit through the installer.',
    `schema: ${quote(INSTALLS_SCHEMA)}`,
  ]
  if (sorted.length === 0) {
    lines.push('plugins: []')
  } else {
    lines.push('plugins:')
    for (const record of sorted) {
      lines.push(`  - dialect: ${quote(record.dialect)}`)
      lines.push(`    name: ${quote(record.name)}`)
      lines.push(`    version: ${quote(record.version)}`)
      lines.push(`    root: ${quote(record.root)}`)
      lines.push(`    dataDir: ${quote(record.dataDir)}`)
      lines.push(`    pin: ${quote(record.pin)}`)
      if (record.source !== undefined) lines.push(`    source: ${quote(encodeSource(record.source))}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write the lock atomically: a temp file in the same directory, then rename.
 * A crash mid-write must never leave a half-valid installs.yml that the next
 * boot would reject (or worse, accept with fewer plugins).
 */
export function writeInstalls(file: string, installs: Installs): void {
  const text = serializeInstalls(installs)
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
