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
 *
 * ## Schema history
 *
 * `dsh-anyplugin/installs@1` had no `mods` field: a mod was reachable only from
 * a hand-written hook row, outside the lock. `@2` adds one optional field,
 * `mods`, carrying the artifact manifest trust pins for the authored module
 * tree (D25): `{ entry, rootRelative, mode, artifactHash, files }`, where each
 * file is `{ path, sha256, bytes }` with the absolute path the tree digest was
 * taken over. The reader still accepts `@1` and treats it as "no mods"; the
 * writer always emits `@2`.
 *
 * The downgrade is a refusal, not a silent drop: a `@1`-only reader checks the
 * schema tag before it looks at any record, so a `@2` lock fails there with
 * `unsupported schema`. Inside a `@1` file a `mods` key is an unknown field.
 * Both are tested (`installs.test.mjs`), so an older binary cannot read a
 * lock, drop the mods and boot a plugin with a hole in it.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'

export const INSTALLS_SCHEMA = 'dsh-anyplugin/installs@2'

/** The 0.1.0 tag: accepted on read as "no mods"; never written. */
export const INSTALLS_SCHEMA_V1 = 'dsh-anyplugin/installs@1'

/** One file of an installed mod's authored tree, as the tree digest saw it. */
export interface InstalledModFile {
  /** Absolute path under the record's `root`; the digest frames this string. */
  path: string
  /** `sha256:<hex>` of the file's bytes. */
  sha256: string
  /** Byte length, checked against the file the digest read. */
  bytes: number
}

/**
 * One mod carried by the install record.
 *
 * The manifest is exactly what `treeArtifact` produced at install time:
 * `hashManifest({ mode, invocation: entry, command: '', files })` recomputes
 * `artifactHash`. `mode` is `file` for a one-file tree and `composite`
 * otherwise (D25's rule for a tree, with sorted paths our derived ordering).
 */
export interface InstalledMod {
  /** Entry, plugin-relative (`hooks/register.ts`): what `loadMod` takes. */
  entry: string
  /** Manifest directory the pinned payload was read from (`hooks`). */
  rootRelative: string
  /** `file` for a one-file tree, `composite` otherwise. */
  mode: 'file' | 'composite'
  /** The tree digest the grant is pinned to. */
  artifactHash: string
  files: InstalledModFile[]
}

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
  /** Granted-exec mods the installer carried, with the manifests trust pins. */
  mods?: InstalledMod[]
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
const MOD_FIELDS = ['entry', 'rootRelative', 'mode', 'artifactHash'] as const
const MOD_FILE_FIELDS = ['path', 'sha256', 'bytes'] as const
const FIELD = /^([a-z][A-Za-z0-9]*):\s+("(?:[^"\\]|\\.)*")\s*$/
const DIALECT = /^[a-z][a-z0-9-]*$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
const VERSION = /^\S+$/
const PIN = /^[a-z][a-z0-9-]*@\S+$/
const HASH = /^sha256:[0-9a-f]{64}$/
const BYTES = /^(0|[1-9][0-9]*)$/
const SCHEMA_LINE = /^schema:\s+("(?:[^"\\]|\\.)*")\s*$/
const PLUGINS_LINE = /^plugins:(?:\s*\[\s*\])?\s*$/
const SOURCE_FIELDS = ['marketplace', 'entry', 'version'] as const
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MODS_LINE = /^mods:(?:\s*\[\s*\])?\s*$/
const FILES_LINE = /^files:\s*$/

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

/**
 * Parse the quoted byte count a `files` entry carries. The canonical form
 * quotes every value, so `bytes` is text on disk and a number here.
 */
function byteCount(file: string, line: number, value: string | undefined): number {
  if (value === undefined || !BYTES.test(value)) {
    throw new InstallsFileError('"bytes" must be a non-negative integer', { file, line })
  }
  return Number(value)
}

/** Validate the manifest of one mod against the record it belongs to. */
function validateInstalledMod(mod: InstalledMod, file: string, line: number): void {
  const where = { file, line }
  if (mod === null || typeof mod !== 'object' || Array.isArray(mod)) {
    throw new InstallsFileError('each mod must be an object', where)
  }
  const raw = mod as unknown as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (key !== 'files' && !(MOD_FIELDS as readonly string[]).includes(key)) {
      throw new InstallsFileError(`unknown mod field "${key}"`, where)
    }
  }
  for (const field of MOD_FIELDS) {
    if (!(field in raw)) throw new InstallsFileError(`missing mod field "${field}"`, where)
    if (typeof raw[field] !== 'string') throw new InstallsFileError(`"${field}" must be a string`, where)
  }
  const { entry, rootRelative, mode, artifactHash } = raw as {
    entry: string
    rootRelative: string
    mode: string
    artifactHash: string
  }
  if (entry.length === 0) throw new InstallsFileError('"entry" must not be empty', where)
  if (rootRelative.length === 0) throw new InstallsFileError('"rootRelative" must not be empty', where)
  if (isAbsolute(entry) || isAbsolute(rootRelative)) {
    throw new InstallsFileError('"entry" and "rootRelative" must be plugin-relative', where)
  }
  if (!entry.startsWith(`${rootRelative.replace(/\/+$/, '')}/`)) {
    throw new InstallsFileError(`"entry" must be inside "rootRelative" (expected a "${rootRelative}/" prefix)`, where)
  }
  if (mode !== 'file' && mode !== 'composite') {
    throw new InstallsFileError('"mode" must be "file" or "composite"', where)
  }
  if (!HASH.test(artifactHash)) throw new InstallsFileError(`"artifactHash" must match ${HASH}`, where)
  if (!Array.isArray(mod.files) || mod.files.length === 0) {
    throw new InstallsFileError('"files" must list at least the entry file', where)
  }
  if ((mode === 'file') !== (mod.files.length === 1)) {
    throw new InstallsFileError(`"mode" is "${mode}" but the manifest lists ${mod.files.length} file(s)`, where)
  }
  const seen = new Set<string>()
  for (const item of mod.files) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new InstallsFileError('each mod file must be an object', where)
    }
    const fileRaw = item as unknown as Record<string, unknown>
    for (const key of Object.keys(fileRaw)) {
      if (!(MOD_FILE_FIELDS as readonly string[]).includes(key)) {
        throw new InstallsFileError(`unknown mod file field "${key}"`, where)
      }
    }
    for (const field of MOD_FILE_FIELDS) {
      if (!(field in fileRaw)) throw new InstallsFileError(`missing mod file field "${field}"`, where)
    }
    const { path, sha256, bytes } = item as InstalledModFile
    // D51: tree paths are plugin-relative. The digest is over those paths, so
    // an absolute path would tie the lock to one machine.
    if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) {
      throw new InstallsFileError('"path" must be plugin-relative, not absolute', where)
    }
    if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new InstallsFileError(`"path" ${path} must be a normalized plugin-relative path`, where)
    }
    if (seen.has(path)) throw new InstallsFileError(`duplicate mod file "${path}"`, where)
    seen.add(path)
    if (typeof sha256 !== 'string' || !HASH.test(sha256)) {
      throw new InstallsFileError(`"sha256" must match ${HASH}`, where)
    }
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || !BYTES.test(String(bytes))) {
      throw new InstallsFileError('"bytes" must be a non-negative integer', where)
    }
  }
  if (!seen.has(entry)) {
    throw new InstallsFileError(`"entry" ${entry} must be one of the recorded tree's files`, where)
  }
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
  // A caller may still hold a 0.1.0-shaped lock in memory (compile options,
  // tests); it means "no mods" and writing normalizes the schema line.
  const legacy = installs.schema === INSTALLS_SCHEMA_V1
  if (!legacy && installs.schema !== INSTALLS_SCHEMA) {
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
    const known = new Set<string>([...REQUIRED, ...OPTIONAL, 'mods'])
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) throw new InstallsFileError(`unknown field "${key}"`, { line })
      if (key === 'mods' && legacy) throw new InstallsFileError('unknown field "mods"', { line })
    }
    const mods = raw.mods
    if (mods !== undefined && !Array.isArray(mods)) throw new InstallsFileError('"mods" must be an array', { line })
    const checked = validateRecord(raw, '<installs>', line)
    if (mods !== undefined) {
      const entries = new Set<string>()
      for (const mod of mods as InstalledMod[]) {
        validateInstalledMod(mod, '<installs>', line)
        if (entries.has(mod.entry)) throw new InstallsFileError(`duplicate mod "${mod.entry}"`, { line })
        entries.add(mod.entry)
      }
      if ((mods as InstalledMod[]).length > 0) checked.mods = mods as InstalledMod[]
    }
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

interface RawFile {
  values: Record<string, string>
  line: number
}

interface RawMod {
  values: Record<string, string>
  files: RawFile[]
  filesSeen: boolean
  line: number
}

interface RawRecord {
  values: Record<string, string>
  mods: RawMod[]
  modsSeen: boolean
  line: number
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
  const legacy = schema === INSTALLS_SCHEMA_V1
  if (schema !== INSTALLS_SCHEMA && schema !== INSTALLS_SCHEMA_V1) {
    throw new InstallsFileError(`unsupported schema "${schema}"; expected "${INSTALLS_SCHEMA}"`, { file, line: lines[0].line })
  }
  // `@1` never had a `mods` field; the record loop below still refuses one as
  // an unknown field, so the old shape cannot be smuggled into the new tag.
  if (lines.length < 2 || !PLUGINS_LINE.test(lines[1].text)) {
    throw new InstallsFileError('expected `plugins:` (or `plugins: []`) after the schema', {
      file,
      line: lines[1]?.line ?? lines[0].line + 1,
    })
  }

  const inlineEmpty = /^plugins:\s*\[\s*\]\s*$/.test(lines[1].text)
  const records: InstallRecord[] = []
  const seen = new Map<string, number>()
  let current: RawRecord | undefined
  let currentMod: RawMod | undefined
  let currentFile: RawFile | undefined

  const finishFile = (): void => {
    if (!currentFile || !currentMod) return
    for (const field of MOD_FILE_FIELDS) {
      if (!(field in currentFile.values)) {
        throw new InstallsFileError(`missing mod file field "${field}"`, { file, line: currentFile.line })
      }
    }
    currentMod.files.push(currentFile)
    currentFile = undefined
  }

  const finishMod = (): void => {
    if (!currentMod) return
    finishFile()
    if (currentMod.files.length === 0) {
      throw new InstallsFileError('"files" must list at least the entry file', { file, line: currentMod.line })
    }
    current?.mods.push(currentMod)
    currentMod = undefined
  }

  const finishRecord = (): void => {
    if (!current) return
    finishMod()
    const checked = validateRecord(current.values, file, current.line)
    const id = `${checked.dialect}:${checked.name}`
    const previous = seen.get(id)
    if (previous !== undefined) {
      throw new InstallsFileError(`duplicate plugin "${id}" (first at line ${previous})`, { file, line: current.line })
    }
    seen.set(id, current.line)
    if (current.mods.length > 0) {
      const entries = new Set<string>()
      const mods: InstalledMod[] = current.mods.map((raw) => {
        const mod: InstalledMod = {
          entry: raw.values.entry,
          rootRelative: raw.values.rootRelative,
          mode: raw.values.mode as InstalledMod['mode'],
          artifactHash: raw.values.artifactHash,
          files: raw.files.map((entry) => ({
            path: entry.values.path,
            sha256: entry.values.sha256,
            bytes: byteCount(file, entry.line, entry.values.bytes),
          })),
        }
        if (entries.has(mod.entry)) throw new InstallsFileError(`duplicate mod "${mod.entry}"`, { file, line: raw.line })
        entries.add(mod.entry)
        validateInstalledMod(mod, checked.root, file, raw.line)
        return mod
      })
      checked.mods = mods
    }
    records.push(checked)
    current = undefined
  }

  for (let index = 2; index < lines.length; index++) {
    const { text: raw, line } = lines[index]
    const indent = raw.length - raw.trimStart().length
    const body = raw.trimStart()

    if (indent === 2 && body.startsWith('- ')) {
      if (inlineEmpty) {
        throw new InstallsFileError('`plugins: []` cannot be followed by plugin records', { file, line })
      }
      finishRecord()
      current = { values: {}, mods: [], modsSeen: false, line }
      currentMod = undefined
      currentFile = undefined
      const field = FIELD.exec(body.slice(2))
      if (!field) throw new InstallsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
      storeRecordField(field, line)
      continue
    }
    if (indent === 4) {
      if (!current) throw new InstallsFileError('field outside a plugin record', { file, line })
      if (currentMod !== undefined) throw new InstallsFileError('record field inside a mod block', { file, line })
      if (MODS_LINE.test(body)) {
        // `@1` had no `mods` field at all: an old record shape under the old
        // tag is still an unknown field, never a silent "no mods today".
        if (legacy) throw new InstallsFileError('unknown field "mods"', { file, line })
        if (current.modsSeen) throw new InstallsFileError('duplicate field "mods"', { file, line })
        current.modsSeen = true
        if (/^mods:\s*\[\s*\]\s*$/.test(body)) continue
        continue
      }
      const field = FIELD.exec(body)
      if (!field) throw new InstallsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
      storeRecordField(field, line)
      continue
    }
    if (indent === 6 && body.startsWith('- ')) {
      if (!current || !current.modsSeen) throw new InstallsFileError('mod outside a `mods` block', { file, line })
      if (currentFile !== undefined || currentMod !== undefined) finishMod()
      currentMod = { values: {}, files: [], filesSeen: false, line }
      const field = FIELD.exec(body.slice(2))
      if (!field) throw new InstallsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
      storeModField(field, line)
      continue
    }
    if (indent === 8) {
      if (!currentMod) throw new InstallsFileError('mod field outside a mod block', { file, line })
      if (FILES_LINE.test(body)) {
        if (currentMod.filesSeen) throw new InstallsFileError('duplicate field "files"', { file, line })
        currentMod.filesSeen = true
        continue
      }
      if (/^files:\s*\[\s*\]\s*$/.test(body)) {
        throw new InstallsFileError('"files" must list at least the entry file', { file, line })
      }
      const field = FIELD.exec(body)
      if (!field) throw new InstallsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
      storeModField(field, line)
      continue
    }
    if (indent === 10 && body.startsWith('- ')) {
      if (!currentMod || !currentMod.filesSeen) throw new InstallsFileError('mod file outside a `files` block', { file, line })
      if (currentFile !== undefined) finishFile()
      currentFile = { values: {}, line }
      const field = FIELD.exec(body.slice(2))
      if (!field) throw new InstallsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
      storeModFileField(field, line)
      continue
    }
    if (indent === 12) {
      if (!currentFile) throw new InstallsFileError('mod file field outside a file entry', { file, line })
      const field = FIELD.exec(body)
      if (!field) throw new InstallsFileError('expected `key: "<value>"` with a double-quoted string', { file, line })
      storeModFileField(field, line)
      continue
    }
    throw new InstallsFileError(
      'expected "  - " to start a plugin record, "    " a record field, "      - " a mod, "        " a mod field, or nested file indentation',
      { file, line },
    )
  }
  finishRecord()

  return { schema: INSTALLS_SCHEMA, plugins: records }

  function storeRecordField(field: RegExpExecArray, line: number): void {
    const [, key, token] = field
    if (![...REQUIRED, ...OPTIONAL].includes(key as (typeof REQUIRED)[number] | (typeof OPTIONAL)[number])) {
      throw new InstallsFileError(`unknown field "${key}"`, { file, line })
    }
    if (!current) throw new InstallsFileError('field outside a plugin record', { file, line })
    if (key in current.values) throw new InstallsFileError(`duplicate field "${key}"`, { file, line })
    current.values[key] = unquote(file, line, token)
  }

  function storeModField(field: RegExpExecArray, line: number): void {
    const [, key, token] = field
    if (!(MOD_FIELDS as readonly string[]).includes(key)) {
      throw new InstallsFileError(`unknown mod field "${key}"`, { file, line })
    }
    if (!currentMod) throw new InstallsFileError('mod field outside a mod block', { file, line })
    if (key in currentMod.values) throw new InstallsFileError(`duplicate mod field "${key}"`, { file, line })
    currentMod.values[key] = unquote(file, line, token)
  }

  function storeModFileField(field: RegExpExecArray, line: number): void {
    const [, key, token] = field
    if (!(MOD_FILE_FIELDS as readonly string[]).includes(key)) {
      throw new InstallsFileError(`unknown mod file field "${key}"`, { file, line })
    }
    if (!currentFile) throw new InstallsFileError('mod file field outside a file entry', { file, line })
    if (key in currentFile.values) throw new InstallsFileError(`duplicate mod file field "${key}"`, { file, line })
    currentFile.values[key] = unquote(file, line, token)
  }
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
      if (record.mods !== undefined && record.mods.length > 0) {
        lines.push('    mods:')
        for (const mod of record.mods) {
          lines.push(`      - entry: ${quote(mod.entry)}`)
          lines.push(`        rootRelative: ${quote(mod.rootRelative)}`)
          lines.push(`        mode: ${quote(mod.mode)}`)
          lines.push(`        artifactHash: ${quote(mod.artifactHash)}`)
          lines.push('        files:')
          for (const file of mod.files) {
            lines.push(`          - path: ${quote(file.path)}`)
            lines.push(`            sha256: ${quote(file.sha256)}`)
            lines.push(`            bytes: ${quote(String(file.bytes))}`)
          }
        }
      }
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
