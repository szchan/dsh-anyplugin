/**
 * Marketplace catalogs: `rig marketplace list|install`.
 *
 * Claude writes `.claude-plugin/marketplace.json`; Codex (Agent Plugins 1.0.0)
 * writes `.agents/plugins/marketplace.json` and also reads the Claude file as
 * its "legacy-compatible marketplace". The files look alike and are not the
 * same shape:
 *
 * - a Claude entry's `source` is a `"./"`-relative string or an object whose
 *   `source` discriminator is `github`, `url`, `git-subdir`, `npm`, `archive`
 *   or `command`;
 * - a Codex entry's `source` is an object whose `source` discriminator is
 *   `local`, `url`, `git-subdir` or `npm` (the page also allows a plain string
 *   for a local entry), and only Codex declares `policy`.
 *
 * So this module detects the format by the file's path and parses each file to
 * its own shape. An entry that does not match the shape of the file it sits in
 * is a recorded problem naming the field; it is never guessed into the other
 * format. A root may carry both files: `list` shows both catalogs, each row
 * says which format it came from (so `install` pairs the dialect without
 * guessing), and a name declared in both is an ambiguity that `install`
 * refuses instead of picking one.
 *
 * The rules that matter for the ticket:
 *
 * 1. A malformed entry is a recorded problem naming its index and, when the
 *    raw text allows it, its line — it never aborts the catalog. The Claude
 *    reference validates each entry on its own for exactly this reason.
 * 2. Four source kinds are installable: `local` (resolved under the catalog's
 *    root), and `url`, `git-subdir` and `npm` (fetched by `marketplace-fetch.ts`
 *    into a content-addressed cache under a `network` grant — D27/D53). The
 *    remaining kinds (`github`, `archive`, `command`) are valid Claude catalog
 *    entries and are refused with the missing piece named, never skipped
 *    silently and never fetched here.
 * 3. Install delegates to `installPlugin`: the lock and the enablement layer
 *    still have exactly one writer each (D49). This module adds the resolved
 *    directory, the dialect the catalog format names, and the record's
 *    `source` provenance.
 * 4. A fetch is consent, not a side effect. Without a `network` grant the
 *    command refuses before opening a socket and prints exactly what it would
 *    run; `--dry-run` never fetches and never creates the cache directory.
 *    A grant pins the content address, so a moved ref is a typed refusal that
 *    names both pins until the user passes `--yes`.
 * 5. Containment is a resolution fact, not a parse fact. `..` and symlinks are
 *    allowed through normalization so `resolveLocalSource` can refuse them by
 *    comparing the real paths against the marketplace root.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { SCOPES } from '../../dsh-anyplugin-install/src/index.ts'
import { NETWORK_CAPABILITY, grant, readGrants, resolveGrant, updateGrants, type Scope } from '../../dsh-anyplugin-trust/src/index.ts'
import {
  InstallCliError,
  formatInstall,
  installCliPaths,
  installPlugin,
  type InstallOptions,
  type InstallResult,
} from './install-cli.ts'
import { fetchEntry, remoteTarget, type RemoteSourceKind } from './marketplace-fetch.ts'
import { PROGRAM } from './program.ts'

/** Which file shape a catalog uses. Detected by path, never guessed from content. */
export type MarketplaceFormat = 'claude' | 'codex'

/** Source kinds either ecosystem declares. Four are installable; the rest refuse. */
export type MarketplaceSourceKind = 'local' | 'url' | 'github' | 'git-subdir' | 'npm' | 'archive' | 'command'

/**
 * One normalized source. `kind` is the discriminant; the remaining field is
 * the smallest thing needed to name the target (and, for `local`, to resolve
 * it under the marketplace root).
 */
export type MarketplaceSource =
  | { kind: 'local'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'github'; repo: string }
  | { kind: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
  | { kind: 'npm'; package: string; version?: string }
  | { kind: 'archive'; url: string }
  | { kind: 'command'; command: string }

/** Codex's installation/authentication policy. `installation` is enforced at install. */
export interface MarketplacePolicy {
  installation: string
  authentication: string
}

/** One catalog entry after normalization. */
export interface MarketplaceEntry {
  name: string
  description?: string
  category?: string
  version?: string
  source: MarketplaceSource
  policy?: MarketplacePolicy
  /** The file shape this entry was read from; install pairs the dialect by it. */
  format: MarketplaceFormat
  /** The catalog's own name (a root may carry one catalog per format). */
  marketplace: string
  /** The catalog file this entry came from (local sources resolve from its root). */
  file: string
}

/**
 * A malformed entry. `reason` is the field-level refusal; `line` is where the
 * entry's `name` token sits in the file, when the raw text allows finding it.
 */
export interface MarketplaceProblem {
  /** Position in the catalog's `plugins` array. */
  index: number
  /** Recovered when `name` is a usable string, so `install <name>` can explain itself. */
  name?: string
  line?: number
  reason: string
  /** The file shape that produced the problem. */
  format?: MarketplaceFormat
  /** The catalog file that produced the problem. */
  file?: string
}

/** One catalog in a listing, so a merged root can name its two files. */
export interface MarketplaceCatalog {
  file: string
  format: MarketplaceFormat
  name: string
  displayName?: string
  description?: string
  entries: number
  problems: number
}

/** One catalog, normalized (or both catalogs of a root, merged for listing). */
export interface Marketplace {
  file: string
  format: MarketplaceFormat | 'mixed'
  name: string
  displayName?: string
  description?: string
  catalogs: MarketplaceCatalog[]
  entries: MarketplaceEntry[]
  /** Fields the file declares that this slice reads but does not carry. */
  notes: string[]
  problems: MarketplaceProblem[]
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const POLICY_FIELDS = new Set(['installation', 'authentication'])

/** Claude's top-level fields this slice reads or deliberately notes. */
const CLAUDE_TOP_FIELDS = new Set(['name', 'description', 'plugins'])
/** Codex's top-level fields, per the 1.0.0 marketplace page. */
const CODEX_TOP_FIELDS = new Set(['name', 'interface', 'plugins'])

/**
 * Claude entry fields the reference names. The ones this slice does not carry
 * are notes (Claude's own validator treats unknown keys as warnings); a key
 * outside this set is a note too.
 */
const CLAUDE_ENTRY_FIELDS = new Set([
  'name',
  'description',
  'source',
  'version',
  'category',
  'tags',
  'strict',
  'relevance',
  'dependencies',
  'engines',
  'defaultEnabled',
  'displayName',
  'metadata',
  'headers',
  'headersHelper',
  'author',
  'commands',
  'hooks',
  'skills',
  'agents',
  'mcpServers',
  'lspServers',
  'userConfig',
  'channels',
  'homepage',
  'repository',
  'license',
  'keywords',
])

/** The subset of Claude entry fields this slice actually keeps; the rest note. */
const CLAUDE_CARRIED_ENTRY_FIELDS = new Set(['name', 'description', 'source', 'version', 'category'])

/** Codex entry fields, per the 1.0.0 marketplace page. Everything else refuses. */
const CODEX_ENTRY_FIELDS = new Set(['name', 'source', 'policy', 'category'])

const CLAUDE_SOURCE_KINDS = new Set<string>(['github', 'url', 'git-subdir', 'npm', 'archive', 'command'])
const CODEX_SOURCE_KINDS = new Set<string>(['local', 'url', 'git-subdir', 'npm'])

const CLAUDE_CATALOG = join('.claude-plugin', 'marketplace.json')
const CODEX_CATALOG = join('.agents', 'plugins', 'marketplace.json')

const FOLLOW_UP = 'Follow-up: slice 2 of #117 (remote marketplace sources: fetch, hash pinning, consent).'

/** Internal: a single entry is wrong, the catalog is still readable. */
class EntryError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The line of an entry's `name` token, for a refusal that names file:line and
 * not just an array index. Falls back to `undefined` when the token is not
 * unique in the raw text; a wrong line is worse than no line.
 */
function entryLine(text: string, name: string): number | undefined {
  const token = new RegExp(`"name"\\s*:\\s*${escapeRegExp(JSON.stringify(name))}`, 'gu')
  const first = token.exec(text)
  if (first === null) return undefined
  if (token.exec(text) !== null) return undefined
  return text.slice(0, first.index).split('\n').length
}

/** Index of the first character after the string that starts at `start`. */
function skipString(text: string, start: number): number {
  let index = start + 1
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] === '"') return index + 1
    index += 1
  }
  return index
}

/** Index just past the `{…}` or `[…]` that starts at `start`. */
function skipBalanced(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      index = skipString(text, index)
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return index
}

/**
 * Line of the `plugins[index]` element, for an entry that has no usable
 * `name` to search for. Small brace/string scanner rather than a second
 * parser: it only has to find where an element starts, and a wrong answer
 * would be worse than none.
 */
function entryStartLine(text: string, index: number): number | undefined {
  const array = /"plugins"\s*:\s*\[/u.exec(text)
  if (array === null) return undefined
  let cursor = array.index + array[0].length
  for (let current = 0; cursor < text.length; current += 1) {
    while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1
    if (text[cursor] === ']') return undefined
    const start = cursor
    if (text[cursor] === '"') cursor = skipString(text, cursor)
    else if (text[cursor] === '{' || text[cursor] === '[') cursor = skipBalanced(text, cursor)
    else {
      while (cursor < text.length && !/[,}\]]/u.test(text[cursor])) cursor += 1
    }
    if (current === index) return text.slice(0, start).split('\n').length
    while (cursor < text.length && text[cursor] !== ',') cursor += 1
    cursor += 1
  }
  return undefined
}

/** Why a known source kind is not installable in this slice. */
export function unsupportedReason(kind: Exclude<MarketplaceSourceKind, 'local'>): string {
  return `${kind} sources are not installable: this slice fetches url, git-subdir and npm sources; a ${kind} source needs its own fetch policy (a content hash and consent, D27). ${FOLLOW_UP}`
}

/**
 * Which format a catalog path names, or `undefined` when the path is neither
 * ecosystem's declared location. The distinction matters: the two files carry
 * different `source` shapes, so a parser that guesses can only guess wrong.
 */
export function marketplaceFormat(file: string): MarketplaceFormat | undefined {
  const parts = resolve(file).split(sep)
  const endsWith = (suffix: string[]): boolean =>
    parts.length >= suffix.length && suffix.every((part, index) => parts[parts.length - suffix.length + index] === part)
  if (endsWith(['.claude-plugin', 'marketplace.json'])) return 'claude'
  if (endsWith(['.agents', 'plugins', 'marketplace.json'])) return 'codex'
  return undefined
}

function formatLabel(format: MarketplaceFormat): string {
  return format === 'claude' ? 'claude-code' : 'codex'
}

function dialectFor(format: MarketplaceFormat): string {
  return format === 'claude' ? 'claude-code' : 'codex'
}

function hasLayout(directory: string, format: MarketplaceFormat): boolean {
  if (format === 'claude') return existsSync(join(directory, '.claude-plugin', 'plugin.json'))
  return existsSync(join(directory, 'plugin.json')) || existsSync(join(directory, '.codex-plugin', 'plugin.json'))
}

function layoutFormat(dialect: string): MarketplaceFormat | undefined {
  if (dialect === 'claude-code') return 'claude'
  if (dialect === 'codex') return 'codex'
  return undefined
}

/**
 * An explicit `--dialect` may override the catalog's format, but when it names
 * the other format and the artifact only declares the catalog's own layout, say
 * that instead of letting the reader report a missing version.
 */
function assertDialect(entry: MarketplaceEntry, requested: string | undefined, pluginDir: string): void {
  if (requested === undefined) return
  const requestedFormat = layoutFormat(requested)
  if (requestedFormat === undefined || requestedFormat === entry.format) return
  if (hasLayout(pluginDir, requestedFormat) || !hasLayout(pluginDir, entry.format)) return
  throw new InstallCliError(
    'dialect-mismatch',
    `${entry.file}: entry "${entry.name}" is a ${formatLabel(entry.format)} entry; --dialect ${requested} would read ${pluginDir} as ${requested}, but it declares a ${formatLabel(entry.format)} plugin`,
    `drop --dialect to read it as ${dialectFor(entry.format)}, or pass a plugin that declares the ${requested} layout`,
  )
}

function localPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EntryError('a local source must name a "./"-relative path')
  }
  if (value.includes('\\')) throw new EntryError(`local source "${value}" contains a backslash`)
  if (value.includes('\0')) throw new EntryError('local source contains a NUL byte')
  if (isAbsolute(value)) throw new EntryError(`local source "${value}" must be relative to the marketplace root`)
  if (value !== '.' && !value.startsWith('./')) {
    throw new EntryError(`local source "${value}" must start with "./" (or be "." for the marketplace root)`)
  }
  return value
}

/** A non-empty string field, or a typed entry error naming the field. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EntryError(`"${field}" must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new EntryError(`"${field}" must be a string`)
  return value.trim() === '' ? undefined : value
}

/**
 * Parse one catalog. `format` may be passed explicitly; otherwise it is read
 * from the path, and a path that names neither catalog is refused rather than
 * guessed. A direct importer must therefore pass the format or a real path.
 */
export function parseMarketplace(text: string, file = '<marketplace>', format?: MarketplaceFormat): Marketplace {
  let document: unknown
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch (error) {
    throw new InstallCliError('malformed-marketplace', `${file}: ${(error as Error).message}`)
  }
  if (!isPlainObject(document)) {
    throw new InstallCliError('malformed-marketplace', `${file}: the catalog must be a JSON object`)
  }
  const actual = format ?? marketplaceFormat(file)
  if (actual === undefined) {
    throw new InstallCliError(
      'unknown-marketplace-format',
      `${file}: not a Claude or Codex marketplace path`,
      `expected ...${sep}.claude-plugin${sep}marketplace.json (Claude) or ...${sep}.agents${sep}plugins${sep}marketplace.json (Codex)`,
    )
  }
  const name = document.name
  if (typeof name !== 'string' || !MARKETPLACE_NAME.test(name)) {
    throw new InstallCliError(
      'malformed-marketplace',
      `${file}: "name" must be the marketplace name (letters, digits, ".", "_", "-")`,
    )
  }
  if (!Array.isArray(document.plugins)) {
    throw new InstallCliError('malformed-marketplace', `${file}: "plugins" must be an array`)
  }

  const notes: string[] = []
  const top = actual === 'claude' ? CLAUDE_TOP_FIELDS : CODEX_TOP_FIELDS
  for (const key of Object.keys(document)) {
    if (!top.has(key)) notes.push(`marketplace: field "${key}" is not carried by this slice`)
  }
  let description: string | undefined
  let displayName: string | undefined
  if (actual === 'claude') {
    try {
      description = optionalString(document.description, 'description')
    } catch (error) {
      if (!(error instanceof EntryError)) throw error
      notes.push(`marketplace: ${error.message}; ignored`)
    }
  } else {
    // Codex has no top-level description; `interface.displayName` is its title.
    const display = document.interface
    if (display !== undefined) {
      if (!isPlainObject(display)) {
        notes.push('marketplace.interface is not an object; ignored')
      } else {
        try {
          displayName = optionalString(display.displayName, 'interface.displayName')
        } catch (error) {
          if (!(error instanceof EntryError)) throw error
          notes.push(`marketplace.interface: ${error.message}; ignored`)
        }
        for (const key of Object.keys(display)) {
          if (key !== 'displayName') notes.push(`marketplace.interface.${key} is not carried by this slice`)
        }
      }
    }
  }

  const entries: MarketplaceEntry[] = []
  const problems: MarketplaceProblem[] = []
  const owners = new Map<string, number>()
  document.plugins.forEach((candidate, index) => {
    const recovered = isPlainObject(candidate) && typeof candidate.name === 'string' ? candidate.name : undefined
    try {
      const { entry, notes: entryNotes } = normalizeEntry(candidate, actual, name, file)
      const first = owners.get(entry.name)
      if (first !== undefined) {
        throw new EntryError(`duplicate entry name "${entry.name}" (first at plugins[${first}])`)
      }
      owners.set(entry.name, index)
      entries.push(entry)
      notes.push(...entryNotes)
    } catch (error) {
      if (!(error instanceof EntryError)) throw error
      const line =
        (recovered === undefined ? undefined : entryLine(text, recovered)) ?? entryStartLine(text, index)
      problems.push({
        index,
        ...(recovered === undefined ? {} : { name: recovered }),
        ...(line === undefined ? {} : { line }),
        reason: error.message,
        format: actual,
        file,
      })
    }
  })

  const catalog: MarketplaceCatalog = {
    file,
    format: actual,
    name,
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    entries: entries.length,
    problems: problems.length,
  }
  return {
    file,
    format: actual,
    name,
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    catalogs: [catalog],
    entries,
    notes,
    problems,
  }
}

function normalizeEntry(
  value: unknown,
  format: MarketplaceFormat,
  marketplace: string,
  file: string,
): { entry: MarketplaceEntry; notes: string[] } {
  if (!isPlainObject(value)) throw new EntryError('entry is not an object')
  const name = value.name
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new EntryError('"name" must be a bare plugin name (no ":", "/" or spaces)')
  }
  const notes: string[] = []
  const fields = format === 'claude' ? CLAUDE_ENTRY_FIELDS : CODEX_ENTRY_FIELDS
  for (const key of Object.keys(value)) {
    if (format === 'claude') {
      // Claude's reference names more fields than this slice carries; both a
      // known-but-uncarried field and an unknown one are warnings, never data.
      if (!CLAUDE_CARRIED_ENTRY_FIELDS.has(key)) {
        notes.push(`entry "${name}": field "${key}" is not carried by this slice`)
      }
      continue
    }
    if (fields.has(key)) continue
    // Codex's entry is a closed shape, so a key it does not declare is a
    // refusal naming the key.
    throw new EntryError(
      `entry "${name}": field "${key}" is not a Codex marketplace entry field (a Codex entry carries name, source, policy and category)`,
    )
  }
  const source = format === 'claude' ? claudeSource(value.source, notes) : codexSource(value.source)

  const entry: MarketplaceEntry = { name, source, format, marketplace, file }
  if (format === 'claude') {
    const description = optionalString(value.description, 'description')
    const category = optionalString(value.category, 'category')
    const version = value.version
    if (version !== undefined && (typeof version !== 'string' || version.trim() === '' || /\s/u.test(version))) {
      throw new EntryError('"version" must be a non-empty string without whitespace')
    }
    if (description !== undefined) entry.description = description
    if (category !== undefined) entry.category = category
    if (version !== undefined) entry.version = version
  } else {
    // The Codex page says to include policy.installation, policy.authentication
    // and category on every entry. A bare entry is not a Codex entry shape; it
    // is refused naming the missing field rather than listed as installable.
    if (value.category === undefined) {
      throw new EntryError('"category" is required for a Codex marketplace entry (the page says to include it on every entry)')
    }
    entry.category = requiredString(value.category, 'category')
    entry.policy = codexPolicy(value.policy)
  }
  return { entry, notes }
}

function claudeSource(value: unknown, notes: string[]): MarketplaceSource {
  if (typeof value === 'string') return { kind: 'local', path: localPath(value) }
  if (!isPlainObject(value)) {
    throw new EntryError('"source" must be a "./"-relative string or an object with a "source" kind')
  }
  const kind = value.source
  if (kind === 'local') {
    throw new EntryError(
      '"source.source" is "local"; a Claude local source is a "./"-relative path string, not an object',
    )
  }
  if (typeof kind !== 'string' || !CLAUDE_SOURCE_KINDS.has(kind)) {
    throw new EntryError(
      `"source.source" must be one of ${[...CLAUDE_SOURCE_KINDS].join(', ')} for a Claude marketplace entry`,
    )
  }
  const carried = new Set(['source'])
  try {
    switch (kind) {
      case 'url': {
        carried.add('url')
        return { kind: 'url', url: requiredString(value.url, 'source.url') }
      }
      case 'github': {
        carried.add('repo')
        return { kind: 'github', repo: requiredString(value.repo, 'source.repo') }
      }
      case 'git-subdir': {
        carried.add('url')
        carried.add('path')
        carried.add('ref')
        carried.add('sha')
        const { sha, ref } = gitPin(value, 'source')
        return {
          kind: 'git-subdir',
          url: requiredString(value.url, 'source.url'),
          path: requiredString(value.path, 'source.path'),
          ...(sha === undefined ? {} : { sha }),
          ...(sha === undefined && ref !== undefined ? { ref } : {}),
        }
      }
      case 'npm': {
        carried.add('package')
        carried.add('version')
        carried.add('registry')
        const version = optionalString(value.version, 'source.version')
        if (version !== undefined && /\s/u.test(version)) {
          throw new EntryError('"source.version" must contain no whitespace')
        }
        return { kind: 'npm', package: requiredString(value.package, 'source.package'), ...(version === undefined ? {} : { version }) }
      }
      case 'archive': {
        carried.add('url')
        carried.add('sha256')
        return { kind: 'archive', url: requiredString(value.url, 'source.url') }
      }
      default: {
        carried.add('command')
        carried.add('timeout')
        carried.add('mode')
        return { kind: 'command', command: requiredString(value.command, 'source.command') }
      }
    }
  } finally {
    for (const key of Object.keys(value)) {
      if (!carried.has(key)) notes.push(`source.${key} is not carried by this slice`)
    }
  }
}

function codexSource(value: unknown): MarketplaceSource {
  // The Codex page allows a plain string for a local entry. It is still a
  // local source (not a Claude-style remote kind), so it keeps the same
  // containment rules as the object form.
  if (typeof value === 'string') return { kind: 'local', path: localPath(value) }
  if (!isPlainObject(value)) {
    throw new EntryError('"source" must be a "./"-relative string or a Codex source object')
  }
  const kind = value.source
  if (typeof kind !== 'string' || !CODEX_SOURCE_KINDS.has(kind)) {
    const shown = typeof kind === 'string' ? `"${kind}"` : 'missing'
    throw new EntryError(`"source.source" is ${shown}; a Codex source must be one of local, url, git-subdir, npm`)
  }
  switch (kind) {
    case 'local': {
      codexOnlyKeys(value, ['source', 'path'], kind)
      return { kind: 'local', path: localPath(value.path) }
    }
    case 'url': {
      codexOnlyKeys(value, ['source', 'url'], kind)
      return { kind: 'url', url: requiredString(value.url, 'source.url') }
    }
    case 'git-subdir': {
      codexOnlyKeys(value, ['source', 'url', 'path', 'ref', 'sha'], kind)
      const { sha, ref } = gitPin(value, 'source')
      return {
        kind: 'git-subdir',
        url: requiredString(value.url, 'source.url'),
        path: requiredString(value.path, 'source.path'),
        ...(sha === undefined ? {} : { sha }),
        ...(sha === undefined && ref !== undefined ? { ref } : {}),
      }
    }
    default: {
      codexOnlyKeys(value, ['source', 'package', 'version'], kind)
      const version = optionalString(value.version, 'source.version')
      if (version !== undefined && /\s/u.test(version)) {
        throw new EntryError('"source.version" must contain no whitespace')
      }
      return { kind: 'npm', package: requiredString(value.package, 'source.package'), ...(version === undefined ? {} : { version }) }
    }
  }
}

/** A Codex source is a closed object: an un-carried key is refused, not noted. */
function codexOnlyKeys(value: Record<string, unknown>, carried: string[], kind: string): void {
  for (const key of Object.keys(value)) {
    if (!carried.includes(key)) {
      throw new EntryError(
        `"source.${key}" is not carried for a Codex "${kind}" source by this slice; the fetch would ignore it, so the entry is refused`,
      )
    }
  }
}

function gitPin(value: Record<string, unknown>, prefix: string): { sha?: string; ref?: string } {
  const sha = optionalString(value.sha, `${prefix}.sha`)
  if (sha !== undefined && !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new EntryError(`"${prefix}.sha" must be a 40-character commit`)
  }
  const ref = optionalString(value.ref, `${prefix}.ref`)
  if (ref !== undefined && /\s/u.test(ref)) {
    throw new EntryError(`"${prefix}.ref" must contain no whitespace`)
  }
  return { ...(sha === undefined ? {} : { sha }), ...(ref === undefined ? {} : { ref }) }
}

function codexPolicy(value: unknown, notes: string[]): MarketplacePolicy {
  if (value === undefined) {
    throw new EntryError('"policy" is required for a Codex marketplace entry (policy.installation and policy.authentication)')
  }
  if (!isPlainObject(value)) throw new EntryError('"policy" must be an object')
  const installation = value.installation
  const authentication = value.authentication
  if (typeof installation !== 'string' || installation.trim() === '') {
    throw new EntryError('"policy.installation" must be a non-empty string')
  }
  if (typeof authentication !== 'string' || authentication.trim() === '') {
    throw new EntryError('"policy.authentication" must be a non-empty string')
  }
  for (const key of Object.keys(value)) {
    if (!POLICY_FIELDS.has(key)) notes.push(`policy.${key} is not carried by this slice`)
  }
  return { installation, authentication }
}

/**
 * The directory a catalog's local sources resolve from.
 *
 * Both ecosystems define the root by where the file lives, not by the file's
 * own directory: `<root>/.claude-plugin/marketplace.json` for Claude and
 * `<root>/.agents/plugins/marketplace.json` for Codex (where `source.path` is
 * documented as relative to the marketplace root, not to `.agents/plugins/`).
 * A file elsewhere is treated as living at the root, which is the only
 * guess-free reading left for `--from <file>`.
 */
export function marketplaceRoot(file: string): string {
  const absolute = resolve(file)
  const parent = dirname(absolute)
  if (basename(parent) === '.claude-plugin') return dirname(parent)
  if (basename(parent) === 'plugins' && basename(dirname(parent)) === '.agents') return dirname(dirname(parent))
  return parent
}

/** Read and normalize one catalog file. A missing file is a typed refusal, not empty. */
export function readMarketplace(file: string): Marketplace {
  const absolute = resolve(file)
  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new InstallCliError(
      'unreadable-marketplace',
      `${absolute}: ${(error as Error).message}`,
      `pass --from a catalog file (${CLAUDE_CATALOG} for Claude, ${CODEX_CATALOG} for Codex) or the root that contains one`,
    )
  }
  const format = marketplaceFormat(absolute)
  if (format === undefined) {
    throw new InstallCliError(
      'unknown-marketplace-format',
      `${absolute}: not a Claude or Codex marketplace path`,
      `expected ...${sep}${CLAUDE_CATALOG} (Claude) or ...${sep}${CODEX_CATALOG} (Codex)`,
    )
  }
  return parseMarketplace(text, absolute, format)
}

/**
 * Open `--from`: a catalog file, or a marketplace root. A directory is looked
 * up at both ecosystems' declared locations; both files are read and merged
 * for listing, and the duplicate names between them become problems so an
 * install refuses instead of picking a format. A directory with neither file
 * is `marketplace-not-found`, naming both paths that were tried.
 */
export function loadMarketplace(from: string): Marketplace {
  const target = resolve(from)
  let stats
  try {
    stats = statSync(target)
  } catch (error) {
    throw new InstallCliError(
      'unreadable-marketplace',
      `${target}: ${(error as Error).message}`,
      `pass --from a catalog file (${CLAUDE_CATALOG} for Claude, ${CODEX_CATALOG} for Codex) or the root that contains one`,
    )
  }
  if (!stats.isDirectory()) return readMarketplace(target)
  const files = [join(target, CLAUDE_CATALOG), join(target, CODEX_CATALOG)].filter((file) => existsSync(file))
  if (files.length === 0) {
    throw new InstallCliError(
      'marketplace-not-found',
      `${target}: no marketplace catalog in this root`,
      `looked for ${join(target, CLAUDE_CATALOG)} (Claude) and ${join(target, CODEX_CATALOG)} (Codex); pass --from a catalog file or a root that contains one`,
    )
  }
  const catalogs = files.map((file) => readMarketplace(file))
  return catalogs.length === 1 ? catalogs[0] : mergeCatalogs(catalogs, target)
}

function mergeCatalogs(catalogs: Marketplace[], root: string): Marketplace {
  const entries = catalogs.flatMap((catalog) => catalog.entries)
  const problems = catalogs.flatMap((catalog) =>
    catalog.problems.map((problem) => ({
      ...problem,
      ...(problem.format === undefined ? { format: catalog.format } : {}),
      ...(problem.file === undefined ? { file: catalog.file } : {}),
    })),
  )
  const first = new Map<string, MarketplaceEntry>()
  for (const entry of entries) {
    const prior = first.get(entry.name)
    if (prior === undefined) {
      first.set(entry.name, entry)
      continue
    }
    // A duplicate inside one file was already a problem and the second entry
    // never entered `entries`; this loop only sees names declared in both.
    if (prior.file === entry.file) continue
    const owner = catalogs.find((catalog) => catalog.file === entry.file)
    const index = owner === undefined ? 0 : owner.entries.findIndex((candidate) => candidate === entry)
    problems.push({
      index: index < 0 ? 0 : index,
      name: entry.name,
      reason: `duplicate entry name "${entry.name}"; also declared by ${prior.file}`,
      format: entry.format,
      file: entry.file,
    })
  }
  // A malformed declaration never becomes an entry, so the loop above cannot
  // see it. The catalog still declared the name: if the other file declares
  // an entry with that name, the ambiguity is real and install must refuse it.
  for (const catalog of catalogs) {
    for (const problem of catalog.problems) {
      if (problem.name === undefined) continue
      const other = catalogs.find(
        (candidate) => candidate.file !== catalog.file && candidate.entries.some((entry) => entry.name === problem.name),
      )
      if (other === undefined) continue
      const already = problems.some(
        (row) =>
          row.file === catalog.file &&
          row.name === problem.name &&
          row.reason.startsWith('duplicate entry name'),
      )
      if (already) continue
      problems.push({
        index: problem.index,
        name: problem.name,
        reason: `duplicate entry name "${problem.name}"; also declared by ${other.file}`,
        format: catalog.format,
        file: catalog.file,
      })
    }
  }
  const names = catalogs.map((catalog) => catalog.name)
  return {
    file: root,
    format: 'mixed',
    name: names.join(' + '),
    catalogs: catalogs.flatMap((catalog) => catalog.catalogs),
    entries,
    notes: catalogs.flatMap((catalog) => catalog.notes.map((note) => `[${formatLabel(catalog.format)}] ${note}`)),
    problems,
  }
}

function escapes(resolved: string, root: string): boolean {
  const rel = relative(root, resolved)
  // A directory named `..weird` is inside the root: only `..` itself, or a
  // path that begins with `../`, actually leaves. `startsWith('..')` alone
  // would refuse every sibling whose name begins with two dots.
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

export interface ResolvedLocalSource {
  root: string
  pluginDir: string
}

/**
 * Resolve one `local` entry inside its marketplace root.
 *
 * Two checks, because there are two ways out: the lexical one refuses `..`
 * before touching the filesystem, and the realpath one refuses a symlink whose
 * target is outside even when the declared path looks contained.
 */
export function resolveLocalSource(file: string, entry: MarketplaceEntry): ResolvedLocalSource {
  if (entry.source.kind !== 'local') {
    throw new InstallCliError(
      'unsupported-marketplace-source',
      `entry "${entry.name}" installs from ${entry.source.kind}: ${unsupportedReason(entry.source.kind)}`,
    )
  }
  const root = marketplaceRoot(file)
  const pluginDir = resolve(root, entry.source.path)
  if (escapes(pluginDir, root)) {
    throw new InstallCliError(
      'marketplace-path-escape',
      `entry "${entry.name}" source "${entry.source.path}" resolves to ${pluginDir}, outside the marketplace root ${root}`,
      'a marketplace installs only plugins inside its own tree',
    )
  }
  if (existsSync(root) && existsSync(pluginDir)) {
    try {
      const realRoot = realpathSync(root)
      const realPluginDir = realpathSync(pluginDir)
      if (escapes(realPluginDir, realRoot)) {
        throw new InstallCliError(
          'marketplace-path-escape',
          `entry "${entry.name}" source "${entry.source.path}" resolves through a symlink to ${realPluginDir}, outside the marketplace root ${realRoot}`,
          'a marketplace installs only plugins inside its own tree',
        )
      }
    } catch (error) {
      if (error instanceof InstallCliError) throw error
      // A realpath failure means the path is unreadable; `installPlugin`
      // reports that with the path and the OS error, which is the better message.
    }
  }
  return { root, pluginDir }
}

/** A URL as it may be printed: no credentials, no query (a token is not display text). */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw
  }
}

function sourceTarget(source: MarketplaceSource): string {
  switch (source.kind) {
    case 'local':
      return source.path
    case 'github':
      return source.repo
    case 'git-subdir': {
      const pin = source.sha ?? source.ref
      return `${displayUrl(source.url)} (${source.path})${pin === undefined ? '' : ` @ ${pin}`}`
    }
    case 'npm':
      return source.version === undefined ? source.package : `${source.package}@${source.version}`
    case 'command':
      return source.command
    default:
      return displayUrl(source.url)
  }
}

/**
 * The catalog entry as a result may carry it: the name and metadata are
 * public, but a source URL may hold a token in its query and must not reach
 * `--json` (or a log line) intact.
 */
function redactEntry(entry: MarketplaceEntry): MarketplaceEntry {
  const source = entry.source
  if (source.kind === 'url') return { ...entry, source: { ...source, url: displayUrl(source.url) } }
  if (source.kind === 'git-subdir') return { ...entry, source: { ...source, url: displayUrl(source.url) } }
  if (source.kind === 'github') {
    return { ...entry, source: { ...source, repo: /^https?:/u.test(source.repo) ? displayUrl(source.repo) : source.repo } }
  }
  return entry
}

function problemText(problem: MarketplaceProblem): string {
  const label = problem.name === undefined ? `plugins[${problem.index}]` : `plugins[${problem.index}] ("${problem.name}")`
  const where = problem.line === undefined ? '' : ` at line ${problem.line}`
  return `${label}${where}: ${problem.reason}`
}

/** The typed refusal for a malformed entry that the caller asked for by name. */
export function malformedEntryRefusal(file: string, problem: MarketplaceProblem): InstallCliError {
  return new InstallCliError('malformed-marketplace-entry', `${file}: ${problemText(problem)}`)
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListedMarketplaceEntry extends MarketplaceEntry {
  /** False for a kind this slice does not install; `unsupported` says why. */
  installable: boolean
  unsupported?: string
}

export interface MarketplaceListResult {
  ok: boolean
  file: string
  name: string
  format: MarketplaceFormat | 'mixed'
  displayName?: string
  description?: string
  catalogs: MarketplaceCatalog[]
  entries: ListedMarketplaceEntry[]
  notes: string[]
  problems: MarketplaceProblem[]
}

export interface MarketplaceListOptions {
  /** A catalog file or a marketplace root; relative paths resolve against the cwd (D49). */
  from: string
}

export function listMarketplace(options: MarketplaceListOptions): MarketplaceListResult {
  const marketplace = loadMarketplace(options.from)
  const entries: ListedMarketplaceEntry[] = marketplace.entries.map((entry) => {
    const shown = redactEntry(entry)
    if (entry.source.kind === 'local' || entry.source.kind === 'url' || entry.source.kind === 'git-subdir' || entry.source.kind === 'npm') {
      return { ...shown, installable: true }
    }
    return { ...shown, installable: false, unsupported: unsupportedReason(entry.source.kind) }
  })
  return {
    /** Malformed entries are problems; a remote entry is a valid catalog row. */
    ok: marketplace.problems.length === 0,
    file: marketplace.file,
    name: marketplace.name,
    format: marketplace.format,
    ...(marketplace.displayName === undefined ? {} : { displayName: marketplace.displayName }),
    ...(marketplace.description === undefined ? {} : { description: marketplace.description }),
    catalogs: marketplace.catalogs,
    entries,
    notes: marketplace.notes,
    problems: marketplace.problems,
  }
}

export function formatMarketplaceList(result: MarketplaceListResult): string {
  const count = `${result.entries.length} ${result.entries.length === 1 ? 'entry' : 'entries'}`
  // A duplicate is an ambiguity, not a malformed entry: both rows are valid.
  const ambiguous = result.problems.filter((problem) => problem.reason.startsWith('duplicate entry name')).length
  const malformed = result.problems.length - ambiguous
  const problems = `${malformed} malformed${ambiguous === 0 ? '' : `, ${ambiguous} ambiguous`}`
  const lines = [`marketplace: ${result.name}  ${result.file}  (${count}, ${problems})`]
  if (result.displayName !== undefined) lines.push(`  ${result.displayName}`)
  if (result.description !== undefined) lines.push(`  ${result.description}`)
  if (result.format === 'mixed') {
    for (const catalog of result.catalogs) {
      lines.push(`  catalog: ${catalog.name}  ${formatLabel(catalog.format)}  ${catalog.file}`)
    }
  }
  for (const entry of result.entries) {
    lines.push(`  ${entry.name}  ${formatLabel(entry.format)}  ${entry.source.kind}  ${sourceTarget(entry.source)}`)
    if (entry.description !== undefined) lines.push(`    ${entry.description}`)
    const meta: string[] = []
    if (entry.category !== undefined) meta.push(`category: ${entry.category}`)
    if (entry.version !== undefined) meta.push(`version: ${entry.version}`)
    if (entry.policy !== undefined) meta.push(`policy: ${entry.policy.installation} / ${entry.policy.authentication}`)
    if (meta.length > 0) lines.push(`    ${meta.join('  ')}`)
    if (entry.unsupported !== undefined) lines.push(`    unsupported: ${entry.unsupported}`)
  }
  for (const note of result.notes) lines.push(`  note: ${note}`)
  for (const problem of result.problems) {
    const prefix =
      result.format === 'mixed' && problem.format !== undefined ? `[${formatLabel(problem.format)}] ` : ''
    lines.push(`  problem: ${prefix}${problemText(problem)}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface MarketplaceMetadata {
  name: string
  file: string
  entry: MarketplaceEntry
  /** The directory the install reads: the local plugin dir, or the cache artifact. */
  root: string
  /** The catalog format this entry came from. */
  format: MarketplaceFormat
  /** The dialect the install reads with (from the format unless --dialect overrides). */
  dialect: string
}

export interface MarketplaceInstallOptions extends Omit<InstallOptions, 'pluginDir' | 'name' | 'source'> {
  /** A catalog file or a marketplace root; relative paths resolve against the cwd (D49). */
  from: string
  /** Entry name as the catalog spells it (Claude: the name users type before `@`). */
  entry: string
  /** Consent to the fetch, per invocation. Without it a remote entry is refused. */
  yes?: boolean
}

export interface MarketplaceFetchPreview {
  ok: true
  dryRun: true
  marketplace: MarketplaceMetadata
  fetch: {
    kind: RemoteSourceKind
    /** The grant target, e.g. `git:https://…@main#plugins/x`. */
    target: string
    /** The exact command the fetch would run (URL query redacted). */
    command: string
    consent: 'none' | 'granted' | 'revoked'
    /** The scope of the deciding grant/revoke, when one exists. */
    scope?: Scope
    /**
     * The current artifact integrity. A dry run fetches nothing, so it cannot
     * check whether a floating ref moved: this is always `unknown` here.
     */
    integrity: 'unknown'
    /** The content address an existing grant pins, when there is one. */
    pinnedIntegrity?: string
  }
}

export interface MarketplaceInstallResult extends InstallResult {
  marketplace: MarketplaceMetadata
}

export type MarketplaceInstallOutcome = MarketplaceInstallResult | MarketplaceFetchPreview

/**
 * The grant identity for a catalog entry. It is deliberately not the installed
 * plugin identity: consent is to fetch *this catalog entry*. The name is the
 * marketplace slug plus the entry name, both validated by the catalog parser;
 * the install separately asserts that the artifact declares the entry's name.
 */
export function marketplaceIdentity(marketplace: string, entry: string): string {
  const slug = marketplace.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'marketplace'
  return `${slug}:${entry}`
}

function consentRequired(identity: string, target: { kind: RemoteSourceKind; target: string; command: string }): InstallCliError {
  return new InstallCliError(
    'network-consent-required',
    `entry "${identity}" is fetched, not read: ${target.command}`,
    `re-run with --yes to fetch it and record a network grant pinned to the resolved bytes (target ${target.target}); this grant never authorizes exec/mod`,
  )
}

function consentRevoked(identity: string, target: string, scope: Scope | undefined): InstallCliError {
  return new InstallCliError(
    'network-consent-revoked',
    `${identity} has a network revoke${scope === undefined ? '' : ` at ${scope} scope`} for ${target}`,
    'a revoke beats a grant at the same or a narrower scope; delete the revoke before fetching again (--yes does not override it)',
  )
}

function pinMoved(
  identity: string,
  target: string,
  previous: { artifactHash: string; grantedAt: string },
  fetched: string,
): InstallCliError {
  return new InstallCliError(
    'network-pin-moved',
    `${identity} resolved to ${fetched}, but the grant (granted ${previous.grantedAt}) pins ${previous.artifactHash} for ${target}; the pin moved`,
    're-run with --yes to accept the new pin and install the fetched bytes',
  )
}

/** Name the catalog entry when its artifact declares a different name. */
function withEntryName(entry: MarketplaceEntry, error: unknown): unknown {
  if (error instanceof InstallCliError && error.code === 'name-mismatch') {
    return new InstallCliError(
      'name-mismatch',
      `${entry.file}: entry "${entry.name}" does not match the plugin its source declares (${error.message})`,
      'the catalog entry name and the plugin manifest name must be the same; rename one of them',
    )
  }
  return error
}

export async function installFromMarketplace(options: MarketplaceInstallOptions): Promise<MarketplaceInstallOutcome> {
  const { from, entry: requested, yes, ...install } = options
  const fromFile = resolve(from)
  const marketplace = loadMarketplace(fromFile)
  // A duplicated name is not "the first one": the caller asked for a name the
  // catalog defines twice, so picking either entry would be a guess. This also
  // covers a root that carries both formats and declares the name in both.
  const duplicate = marketplace.problems.find(
    (problem) => problem.name === requested && problem.reason.startsWith('duplicate entry name'),
  )
  if (duplicate !== undefined) {
    throw new InstallCliError(
      'ambiguous-marketplace-entry',
      `${duplicate.file ?? fromFile}: ${problemText(duplicate)}`,
      'rename one of the entries in the catalog; an install never picks between duplicates',
    )
  }
  const entry = marketplace.entries.find((candidate) => candidate.name === requested)
  if (entry === undefined) {
    const problem = marketplace.problems.find((candidate) => candidate.name === requested)
    if (problem !== undefined) throw malformedEntryRefusal(problem.file ?? fromFile, problem)
    const known = marketplace.entries.map((candidate) => candidate.name)
    throw new InstallCliError(
      'unknown-marketplace-entry',
      `${fromFile}: no entry named "${requested}"; known: ${known.length === 0 ? '(none)' : known.join(', ')}`,
      `list the catalog with \`${PROGRAM} marketplace list --from <file>\``,
    )
  }
  // Codex's policy is part of the catalog contract, not a display field. An
  // unavailable entry is refused before its source is even resolved.
  if (entry.policy?.installation === 'NOT_AVAILABLE') {
    throw new InstallCliError(
      'marketplace-entry-not-available',
      `${entry.file}: entry "${entry.name}" declares policy.installation "NOT_AVAILABLE"; this catalog marks it as not installable`,
      'the catalog owner must change the entry policy before it can be installed',
    )
  }
  const root = marketplaceRoot(entry.file)
  // The catalog format names the dialect. An explicit --dialect still wins,
  // but the entry's format means the default is never guessed from the tree.
  const dialect = install.dialect ?? dialectFor(entry.format)
  const metadata: MarketplaceMetadata = {
    name: entry.marketplace,
    file: entry.file,
    entry: redactEntry(entry),
    root,
    format: entry.format,
    dialect,
  }

  if (entry.source.kind === 'local') {
    const resolved = resolveLocalSource(entry.file, entry)
    assertDialect(entry, install.dialect, resolved.pluginDir)
    const source = {
      marketplace: entry.marketplace,
      entry: entry.name,
      ...(entry.version === undefined ? {} : { version: entry.version }),
    }
    try {
      const result = installPlugin({ ...install, dialect, pluginDir: resolved.pluginDir, source, name: entry.name })
      return { ...result, marketplace: { ...metadata, root: resolved.root } }
    } catch (error) {
      throw withEntryName(entry, error)
    }
  }

  const remote = entry.source
  if (remote.kind !== 'url' && remote.kind !== 'git-subdir' && remote.kind !== 'npm') {
    throw new InstallCliError(
      'unsupported-marketplace-source',
      `entry "${entry.name}" installs from ${remote.kind}: ${unsupportedReason(remote.kind)}`,
    )
  }

  const scope = install.scope ?? 'user'
  if (!SCOPES.includes(scope)) {
    throw new InstallCliError('invalid-record', `--scope must be one of ${SCOPES.join(', ')}`)
  }
  const target = remoteTarget(remote, root)
  const paths = installCliPaths(install)
  const cacheRoot = join(dirname(paths.installs), 'marketplace-cache')
  const identity = marketplaceIdentity(entry.marketplace, entry.name)
  const resolution = resolveGrant(readGrants(paths.grants), identity, NETWORK_CAPABILITY, target.target)
  const deciding = resolution.record
  const revoke = deciding?.kind === 'revoke'
  const prior = deciding?.kind === 'grant' ? deciding.record : undefined

  if (install.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      marketplace: { ...metadata, root: cacheRoot },
      fetch: {
        kind: target.kind,
        target: target.target,
        command: target.command,
        consent: revoke ? 'revoked' : prior === undefined ? 'none' : 'granted',
        ...(resolution.scope === undefined ? {} : { scope: resolution.scope }),
        integrity: 'unknown',
        ...(prior === undefined ? {} : { pinnedIntegrity: prior.artifactHash }),
      },
    }
  }

  if (revoke) throw consentRevoked(identity, target.target, resolution.scope)
  if (prior === undefined && yes !== true) throw consentRequired(identity, target)

  const artifact = await fetchEntry({
    marketplace: entry.marketplace,
    entry: entry.name,
    name: entry.name,
    dialect,
    source: remote,
    root,
    cacheRoot,
  })
  const moved = prior !== undefined && prior.artifactHash !== artifact.integrity
  if (moved && yes !== true) throw pinMoved(identity, target.target, prior, artifact.integrity)

  assertDialect(entry, install.dialect, artifact.pluginDir)
  const version = entry.version ?? artifact.version
  const source = {
    marketplace: entry.marketplace,
    entry: entry.name,
    ...(version === undefined ? {} : { version }),
    integrity: artifact.integrity,
    resolvedAt: artifact.resolvedAt,
  }
  // A moved pin resolves to a different cache directory, so accepting it is
  // also the consent to repoint the record's root: --force here is implied by
  // --yes on a pin move, not a second user decision.
  let result: InstallResult
  try {
    result = installPlugin({
      ...install,
      ...(moved && yes === true ? { force: true } : {}),
      dialect,
      pluginDir: artifact.pluginDir,
      source,
      name: entry.name,
    })
  } catch (error) {
    throw withEntryName(entry, error)
  }
  // The grant is written only after the install succeeded. A fetch that is
  // followed by a refused install leaves no standing network authorization.
  if (prior === undefined || moved) {
    updateGrants(paths.grants, (current) =>
      grant(
        current,
        {
          plugin: identity,
          capability: NETWORK_CAPABILITY,
          target: target.target,
          artifactHash: artifact.integrity,
        },
        { scope },
      ),
    )
  }
  return { ...result, marketplace: { ...metadata, root: artifact.root } }
}

export function formatMarketplaceInstall(outcome: MarketplaceInstallOutcome): string {
  if ('fetch' in outcome) {
    const plan = outcome.fetch
    const consent =
      plan.consent === 'none'
        ? `none — pass --yes to fetch and record ${plan.target}`
        : plan.consent === 'granted'
          ? `granted (grant pins ${plan.pinnedIntegrity ?? 'not recorded'}; current integrity unknown — a dry run fetches nothing)`
          : `revoked${plan.scope === undefined ? '' : ` at ${plan.scope} scope`}`
    return [
      `marketplace: ${outcome.marketplace.name}  ${outcome.marketplace.file}`,
      `  entry: ${outcome.marketplace.entry.name}  (${formatLabel(outcome.marketplace.format)})`,
      '  dry run — nothing fetched, nothing written',
      `  would fetch: ${plan.command}`,
      '  integrity: unknown — a dry run fetches nothing',
      `  network grant: ${consent}`,
    ].join('\n')
  }
  const result = outcome
  const lines = [
    `marketplace: ${result.marketplace.name}  ${result.marketplace.file}`,
    `  entry: ${result.marketplace.entry.name}  (${formatLabel(result.marketplace.format)})`,
  ]
  const advertised = result.marketplace.entry.version
  if (advertised !== undefined && advertised !== result.record.version) {
    lines.push(
      `  note: the catalog advertises version "${advertised}" but the artifact declares "${result.record.version}"; the record keeps the artifact version and source.version keeps the catalog's`,
    )
  }
  lines.push(formatInstall(result))
  return lines.join('\n')
}
