/**
 * Marketplace catalogs: `rig marketplace list|install`.
 *
 * Both ecosystems name a catalog in JSON and both point at plugins that live
 * somewhere else. Claude writes `.claude-plugin/marketplace.json`; Codex writes
 * `.agents/plugins/marketplace.json` and also reads the Claude file as its
 * "legacy-compatible marketplace". The two entry shapes differ in the small
 * places (Claude's local source may be a bare string, Codex's is an object
 * with `source: "local"`; only Codex declares `policy`), so this module is one
 * normalizer over the union, not two parsers: an entry becomes
 * `{ name, description?, category?, version?, source, policy? }`.
 *
 * The rules that matter for the ticket:
 *
 * 1. A malformed entry is a recorded problem naming its index and, when the
 *    raw text allows it, its line — it never aborts the catalog. The Claude
 *    reference validates each entry on its own for exactly this reason.
 * 2. Four source kinds are installable: `local` (resolved under the catalog's
 *    root), and `url`, `git-subdir` and `npm` (fetched by `marketplace-fetch.ts`
 *    into a content-addressed cache under a `network` grant — D27/D52). The
 *    remaining kinds (`github`, `archive`, `command`) are valid catalog entries
 *    and are refused with the missing piece named, never skipped silently and
 *    never fetched here.
 * 3. Install delegates to `installPlugin`: the lock and the enablement layer
 *    still have exactly one writer each (D49). The only thing this module adds
 *    is the resolved directory and the record's `source` provenance.
 * 4. A fetch is consent, not a side effect. Without a `network` grant the
 *    command refuses before opening a socket and prints exactly what it would
 *    run; `--dry-run` never fetches and never creates the cache directory.
 *    A grant pins the content address, so a moved ref is a typed refusal that
 *    names both pins until the user passes `--yes`.
 * 5. Containment is a resolution fact, not a parse fact. `..` and symlinks are
 *    allowed through normalization so `resolveLocalSource` can refuse them by
 *    comparing the real paths against the marketplace root.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
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

/** Codex's installation/authentication policy. Carried, not acted on. */
export interface MarketplacePolicy {
  installation: string
  authentication: string
}

/** One catalog entry after normalization. Unknown fields land in `notes`. */
export interface MarketplaceEntry {
  name: string
  description?: string
  category?: string
  version?: string
  source: MarketplaceSource
  policy?: MarketplacePolicy
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
}

/** One catalog file, normalized. `entries` excludes malformed entries. */
export interface Marketplace {
  file: string
  name: string
  description?: string
  entries: MarketplaceEntry[]
  /** Fields the file declares that this slice reads but does not carry. */
  notes: string[]
  problems: MarketplaceProblem[]
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TOP_FIELDS = new Set(['name', 'description', 'plugins'])
const ENTRY_FIELDS = new Set(['name', 'description', 'category', 'version', 'source', 'policy'])
const POLICY_FIELDS = new Set(['installation', 'authentication'])
const SOURCE_KINDS = new Set<string>(['local', 'url', 'github', 'git-subdir', 'npm', 'archive', 'command'])

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

export function parseMarketplace(text: string, file = '<marketplace>'): Marketplace {
  let document: unknown
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch (error) {
    throw new InstallCliError('malformed-marketplace', `${file}: ${(error as Error).message}`)
  }
  if (!isPlainObject(document)) {
    throw new InstallCliError('malformed-marketplace', `${file}: the catalog must be a JSON object`)
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
  for (const key of Object.keys(document)) {
    if (!TOP_FIELDS.has(key)) notes.push(`marketplace: field "${key}" is not carried by this slice`)
  }
  let description: string | undefined
  try {
    description = optionalString(document.description, 'description')
  } catch (error) {
    if (!(error instanceof EntryError)) throw error
    notes.push(`marketplace: ${error.message}; ignored`)
  }

  const entries: MarketplaceEntry[] = []
  const problems: MarketplaceProblem[] = []
  const owners = new Map<string, number>()
  document.plugins.forEach((candidate, index) => {
    const recovered = isPlainObject(candidate) && typeof candidate.name === 'string' ? candidate.name : undefined
    try {
      const { entry, notes: entryNotes } = normalizeEntry(candidate)
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
      })
    }
  })

  return { file, name, description, entries, notes, problems }
}

function normalizeEntry(value: unknown): { entry: MarketplaceEntry; notes: string[] } {
  if (!isPlainObject(value)) throw new EntryError('entry is not an object')
  const name = value.name
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new EntryError('"name" must be a bare plugin name (no ":", "/" or spaces)')
  }
  const notes: string[] = []
  const source = normalizeSource(value.source, notes)
  const description = optionalString(value.description, 'description')
  const category = optionalString(value.category, 'category')
  const version = value.version
  if (version !== undefined && (typeof version !== 'string' || version.trim() === '' || /\s/u.test(version))) {
    throw new EntryError('"version" must be a non-empty string without whitespace')
  }
  const policy = normalizePolicy(value.policy, notes)
  for (const key of Object.keys(value)) {
    if (!ENTRY_FIELDS.has(key)) notes.push(`entry "${name}": field "${key}" is not carried by this slice`)
  }
  const entry: MarketplaceEntry = { name, source }
  if (description !== undefined) entry.description = description
  if (category !== undefined) entry.category = category
  if (version !== undefined) entry.version = version
  if (policy !== undefined) entry.policy = policy
  return { entry, notes }
}

function normalizeSource(value: unknown, notes: string[]): MarketplaceSource {
  if (typeof value === 'string') return { kind: 'local', path: localPath(value) }
  if (!isPlainObject(value)) {
    throw new EntryError('"source" must be a "./"-relative string or an object with a "source" kind')
  }
  const kind = value.source
  if (typeof kind !== 'string' || !SOURCE_KINDS.has(kind)) {
    throw new EntryError(`"source.source" must be one of ${[...SOURCE_KINDS].join(', ')}`)
  }
  const carried = new Set(['source'])
  try {
    switch (kind) {
      case 'local': {
        carried.add('path')
        return { kind: 'local', path: localPath(value.path) }
      }
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
        const sha = optionalString(value.sha, 'source.sha')
        if (sha !== undefined && !/^[0-9a-f]{40}$/u.test(sha)) {
          throw new EntryError('"source.sha" must be a 40-character commit')
        }
        const ref = optionalString(value.ref, 'source.ref')
        if (ref !== undefined && /\s/u.test(ref)) {
          throw new EntryError('"source.ref" must contain no whitespace')
        }
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
        const version = optionalString(value.version, 'source.version')
        if (version !== undefined && /\s/u.test(version)) {
          throw new EntryError('"source.version" must contain no whitespace')
        }
        return { kind: 'npm', package: requiredString(value.package, 'source.package'), ...(version === undefined ? {} : { version }) }
      }
      case 'archive': {
        carried.add('url')
        return { kind: 'archive', url: requiredString(value.url, 'source.url') }
      }
      default: {
        carried.add('command')
        return { kind: 'command', command: requiredString(value.command, 'source.command') }
      }
    }
  } finally {
    for (const key of Object.keys(value)) {
      if (!carried.has(key)) notes.push(`source.${key} is not carried by this slice`)
    }
  }
}

function normalizePolicy(value: unknown, notes: string[]): MarketplacePolicy | undefined {
  if (value === undefined) return undefined
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

/** Read and normalize a catalog. A missing file is a typed refusal, not empty. */
export function readMarketplace(file: string): Marketplace {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new InstallCliError(
      'unreadable-marketplace',
      `${file}: ${(error as Error).message}`,
      'pass --from the catalog file (for example .claude-plugin/marketplace.json)',
    )
  }
  return parseMarketplace(text, file)
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

function sourceTarget(source: MarketplaceSource): string {
  switch (source.kind) {
    case 'local':
      return source.path
    case 'github':
      return source.repo
    case 'git-subdir': {
      const pin = source.sha ?? source.ref
      return `${source.url} (${source.path})${pin === undefined ? '' : ` @ ${pin}`}`
    }
    case 'npm':
      return source.version === undefined ? source.package : `${source.package}@${source.version}`
    case 'command':
      return source.command
    default:
      return source.url
  }
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
  description?: string
  entries: ListedMarketplaceEntry[]
  notes: string[]
  problems: MarketplaceProblem[]
}

export interface MarketplaceListOptions {
  /** The catalog file; relative paths resolve against the cwd (D49). */
  from: string
}

export function listMarketplace(options: MarketplaceListOptions): MarketplaceListResult {
  const file = resolve(options.from)
  const marketplace = readMarketplace(file)
  const entries: ListedMarketplaceEntry[] = marketplace.entries.map((entry) => {
    if (entry.source.kind === 'local' || entry.source.kind === 'url' || entry.source.kind === 'git-subdir' || entry.source.kind === 'npm') {
      return { ...entry, installable: true }
    }
    return { ...entry, installable: false, unsupported: unsupportedReason(entry.source.kind) }
  })
  return {
    /** Malformed entries are problems; a remote entry is a valid catalog row. */
    ok: marketplace.problems.length === 0,
    file,
    name: marketplace.name,
    ...(marketplace.description === undefined ? {} : { description: marketplace.description }),
    entries,
    notes: marketplace.notes,
    problems: marketplace.problems,
  }
}

export function formatMarketplaceList(result: MarketplaceListResult): string {
  const count = `${result.entries.length} ${result.entries.length === 1 ? 'entry' : 'entries'}`
  const lines = [`marketplace: ${result.name}  ${result.file}  (${count}, ${result.problems.length} malformed)`]
  if (result.description !== undefined) lines.push(`  ${result.description}`)
  for (const entry of result.entries) {
    lines.push(`  ${entry.name}  ${entry.source.kind}  ${sourceTarget(entry.source)}`)
    if (entry.description !== undefined) lines.push(`    ${entry.description}`)
    const meta: string[] = []
    if (entry.category !== undefined) meta.push(`category: ${entry.category}`)
    if (entry.version !== undefined) meta.push(`version: ${entry.version}`)
    if (entry.policy !== undefined) meta.push(`policy: ${entry.policy.installation} / ${entry.policy.authentication}`)
    if (meta.length > 0) lines.push(`    ${meta.join('  ')}`)
    if (entry.unsupported !== undefined) lines.push(`    unsupported: ${entry.unsupported}`)
  }
  for (const note of result.notes) lines.push(`  note: ${note}`)
  for (const problem of result.problems) lines.push(`  problem: ${problemText(problem)}`)
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
}

export interface MarketplaceInstallOptions extends Omit<InstallOptions, 'pluginDir' | 'name' | 'source'> {
  /** The catalog file; relative paths resolve against the cwd (D49). */
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
    /** The pinned content address, when a grant exists. */
    integrity?: string
  }
}

export interface MarketplaceInstallResult extends InstallResult {
  marketplace: MarketplaceMetadata
}

export type MarketplaceInstallOutcome = MarketplaceInstallResult | MarketplaceFetchPreview

/**
 * The grant identity for a catalog entry. It is deliberately not the installed
 * plugin identity: consent is to fetch *this catalog entry*, and the artifact
 * may legitimately call itself something else. The name is the marketplace
 * slug plus the entry name, both validated by the catalog parser.
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

export async function installFromMarketplace(options: MarketplaceInstallOptions): Promise<MarketplaceInstallOutcome> {
  const { from, entry: requested, yes, ...install } = options
  const file = resolve(from)
  const marketplace = readMarketplace(file)
  // A duplicated name is not "the first one": the caller asked for a name the
  // catalog defines twice, so picking either entry would be a guess. The
  // duplicate is already a recorded problem; report that, not the emission
  // refusal the first (possibly inert) entry happens to produce.
  const duplicate = marketplace.problems.find(
    (problem) => problem.name === requested && problem.reason.startsWith('duplicate entry name'),
  )
  if (duplicate !== undefined) {
    throw new InstallCliError(
      'ambiguous-marketplace-entry',
      `${file}: ${problemText(duplicate)}`,
      'rename one of the entries in the catalog; an install never picks between duplicates',
    )
  }
  const entry = marketplace.entries.find((candidate) => candidate.name === requested)
  if (entry === undefined) {
    const problem = marketplace.problems.find((candidate) => candidate.name === requested)
    if (problem !== undefined) throw malformedEntryRefusal(file, problem)
    const known = marketplace.entries.map((candidate) => candidate.name)
    throw new InstallCliError(
      'unknown-marketplace-entry',
      `${file}: no entry named "${requested}"; known: ${known.length === 0 ? '(none)' : known.join(', ')}`,
      'list the catalog with `rig marketplace list --from <file>`',
    )
  }
  // Codex's policy is part of the catalog contract, not a display field. An
  // unavailable entry is refused before its source is even resolved.
  if (entry.policy?.installation === 'NOT_AVAILABLE') {
    throw new InstallCliError(
      'marketplace-entry-not-available',
      `${file}: entry "${entry.name}" declares policy.installation "NOT_AVAILABLE"; this catalog marks it as not installable`,
      'the catalog owner must change the entry policy before it can be installed',
    )
  }
  const root = marketplaceRoot(file)
  const metadata: MarketplaceMetadata = { name: marketplace.name, file, entry, root }

  if (entry.source.kind === 'local') {
    const resolved = resolveLocalSource(file, entry)
    const source = {
      marketplace: marketplace.name,
      entry: entry.name,
      ...(entry.version === undefined ? {} : { version: entry.version }),
    }
    const result = installPlugin({ ...install, pluginDir: resolved.pluginDir, source })
    return { ...result, marketplace: { ...metadata, root: resolved.root } }
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
  const identity = marketplaceIdentity(marketplace.name, entry.name)
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
        ...(prior === undefined ? {} : { integrity: prior.artifactHash }),
      },
    }
  }

  if (revoke) throw consentRevoked(identity, target.target, resolution.scope)
  if (prior === undefined && yes !== true) throw consentRequired(identity, target)

  const artifact = await fetchEntry({
    marketplace: marketplace.name,
    entry: entry.name,
    source: remote,
    root,
    cacheRoot,
  })
  const moved = prior !== undefined && prior.artifactHash !== artifact.integrity
  if (moved && yes !== true) throw pinMoved(identity, target.target, prior, artifact.integrity)
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

  const version = entry.version ?? artifact.version
  const source = {
    marketplace: marketplace.name,
    entry: entry.name,
    ...(version === undefined ? {} : { version }),
    integrity: artifact.integrity,
    resolvedAt: artifact.resolvedAt,
  }
  // A moved pin resolves to a different cache directory, so accepting it is
  // also the consent to repoint the record's root: --force here is implied by
  // --yes on a pin move, not a second user decision.
  const result = installPlugin({
    ...install,
    ...(moved && yes === true ? { force: true } : {}),
    pluginDir: artifact.pluginDir,
    source,
  })
  return { ...result, marketplace: { ...metadata, root: artifact.root } }
}

export function formatMarketplaceInstall(outcome: MarketplaceInstallOutcome): string {
  if ('fetch' in outcome) {
    const plan = outcome.fetch
    const consent =
      plan.consent === 'none'
        ? `none — pass --yes to fetch and record ${plan.target}`
        : plan.consent === 'granted'
          ? `granted (${plan.integrity ?? 'pinned'})`
          : `revoked${plan.scope === undefined ? '' : ` at ${plan.scope} scope`}`
    return [
      `marketplace: ${outcome.marketplace.name}  ${outcome.marketplace.file}`,
      `  entry: ${outcome.marketplace.entry.name}`,
      '  dry run — nothing fetched, nothing written',
      `  would fetch: ${plan.command}`,
      `  network grant: ${consent}`,
    ].join('\n')
  }
  const result = outcome
  const lines = [
    `marketplace: ${result.marketplace.name}  ${result.marketplace.file}`,
    `  entry: ${result.marketplace.entry.name}`,
  ]
  if (result.record.name !== result.marketplace.entry.name) {
    lines.push(
      `  note: the artifact calls itself "${result.record.name}"; the record is keyed by the artifact name`,
    )
  }
  const advertised = result.marketplace.entry.version
  if (advertised !== undefined && advertised !== result.record.version) {
    lines.push(
      `  note: the catalog advertises version "${advertised}" but the artifact declares "${result.record.version}"; the record keeps the artifact version and source.version keeps the catalog's`,
    )
  }
  lines.push(formatInstall(result))
  return lines.join('\n')
}
