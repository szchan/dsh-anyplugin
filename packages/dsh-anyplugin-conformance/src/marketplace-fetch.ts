/**
 * Fetching a remote marketplace entry into the local cache (D27, D52).
 *
 * A marketplace entry may name bytes that are not on this machine: a git
 * subdirectory, an npm package, or an https tarball. This module turns one of
 * those into a directory plus a content address. The content address is the
 * contract: a git source records the commit it resolved to, an npm source the
 * sha512 of the tarball, a url source the sha256 of the bytes. Nothing is
 * installed before the artifact is in the cache and the address is known.
 *
 * Rules that are enforced here rather than trusted to the caller:
 *
 * 1. Transport is `https:` or `file:` only; `http:` is refused before any
 *    socket is opened. Credentials in a URL are refused: a catalog is not a
 *    secret store, and a fetched credential would be logged by the error path.
 * 2. git is run through `execFile` with a fixed argv (no shell, no user
 *    flags), shallow, without submodules. npm is run the same way with
 *    `--ignore-scripts`, so a package cannot execute code merely by being
 *    looked at. A plugin installs; it does not run a lifecycle script.
 * 3. An archive is extracted into a temporary directory, checked for a plugin
 *    manifest, and only then renamed into the content-addressed cache.
 * 4. A pinned artifact (git sha, exact npm version) may be reused from the
 *    cache without the network; a floating git ref and a url are always
 *    re-fetched, because their content can change and the pin move must be
 *    visible.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { get as httpsGet } from 'node:https'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { InstallCliError, type InstallCliCode } from './install-cli.ts'
import type { MarketplaceSource } from './marketplace.ts'
import { extractTarball, isGzip, TarError } from './tar.ts'

/** 20 MiB is far above any plugin tarball and far below a runaway download. */
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
export const MAX_REDIRECTS = 5
const TIMEOUT_MS = 30_000
const METADATA = '.dsh-anyplugin-artifact.json'
const PLUGIN_MANIFESTS = ['.claude-plugin/plugin.json', 'plugin.json', '.codex-plugin/plugin.json']

export type RemoteSourceKind = 'url' | 'git-subdir' | 'npm'

export interface FetchTarget {
  kind: RemoteSourceKind
  /** The grant target: `git:<url>@<ref>#<path>`, `npm:<spec>@<pin>`, `url:<url>`. */
  target: string
  /** The exact command a consent prompt prints; a URL query is redacted. */
  command: string
  /** True when the target already names one immutable artifact. */
  pinned: boolean
}

export interface FetchedArtifact {
  /** The cache directory (the artifact root). */
  root: string
  /** The plugin directory inside `root` that `installPlugin` reads. */
  pluginDir: string
  /** `git:<commit>`, `npm:<sha512>` or `sha256:<hex>`. */
  integrity: string
  /** The resolved identity: commit, package version, or content hash. */
  resolved: string
  /** ISO instant of the first fetch of these exact bytes (stable across reuse). */
  resolvedAt: string
  version?: string
}

export interface FetchRequest {
  /** Marketplace name, from the catalog's top-level `name`. */
  marketplace: string
  /** Entry name, as the catalog spells it. */
  entry: string
  /** The catalog entry's name; the fetched plugin must declare the same one. */
  name?: string
  source: MarketplaceSource
  /** The marketplace root, for a relative npm `file:` path. */
  root: string
  /** `<dir of installs.yml>/marketplace-cache`. */
  cacheRoot: string
}

interface Metadata {
  kind: RemoteSourceKind
  integrity: string
  resolved: string
  resolvedAt: string
  /** Plugin root relative to the cache directory; `.` for a package/url root. */
  plugin: string
  version?: string
  /** sha256 over the extracted files: what re-validates a reused cache entry. */
  contentHash?: string
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9._~-]*\/)?[a-z0-9-~][a-z0-9._~-]*$/u
const HEX40 = /^[0-9a-f]{40}$/u

function refusal(code: InstallCliCode, reason: string, hint?: string): InstallCliError {
  return new InstallCliError(code, reason, hint)
}

/** Drop credentials and the query string before a URL is printed or stored in a message. */
function redactAccess(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

function redactText(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/gu, (match) => redactAccess(match))
}

/**
 * The grant target for a URL: display-redacted, but with an opaque
 * fingerprint of the query string. Two catalog URLs that differ only in a
 * query (`?token=a` vs `?token=b`) must be two different grants — otherwise
 * consent for one authorizes the other — while the token itself never reaches
 * `grants.yml`, stdout or an error message.
 */
function targetUrl(url: URL): string {
  const redacted = redactAccess(url.toString())
  const query = url.search.replace(/^\?/u, '')
  if (query === '') return redacted
  const fingerprint = createHash('sha256').update(query).digest('hex').slice(0, 16)
  return `${redacted}#q=${fingerprint}`
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

/**
 * Validate a remote URL: `https:` or `file:` only, no credentials.
 * `http:` gets its own code so a test can tell "insecure transport" from
 * "the fetch itself failed".
 */
function remoteUrl(raw: string, field: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw refusal('marketplace-fetch-refused', `${field} "${raw}" is not an absolute URL`)
  }
  if (url.protocol === 'http:') {
    throw refusal(
      'insecure-marketplace-source',
      `${field} "${redactAccess(raw)}" uses http; marketplace fetches are https or file only`,
      'serve the artifact over https (or a file: URL in a test), never http',
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'file:') {
    throw refusal(
      'marketplace-fetch-refused',
      `${field} "${redactAccess(raw)}" uses ${url.protocol}; marketplace fetches are https or file only`,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw refusal(
      'marketplace-fetch-refused',
      `${field} "${redactAccess(raw)}" carries credentials; a catalog must not contain a secret`,
    )
  }
  if (url.protocol === 'file:' && url.host !== '' && url.host !== 'localhost') {
    throw refusal('marketplace-fetch-refused', `${field} "${redactAccess(raw)}" is not a local file URL`)
  }
  return url
}

/** Safe path segments for a git subdirectory; `..` and absolute paths escape. */
function subdirSegments(raw: string): string[] {
  if (raw.includes('\0')) throw refusal('marketplace-fetch-refused', 'git-subdir source.path contains a NUL byte')
  if (isAbsolute(raw) || raw.startsWith('/')) {
    throw refusal('marketplace-fetch-refused', `git-subdir source.path "${raw}" must be relative to the repository root`)
  }
  if (raw.includes('\\')) throw refusal('marketplace-fetch-refused', `git-subdir source.path "${raw}" contains a backslash`)
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw refusal(
        'marketplace-fetch-refused',
        `git-subdir source.path "${raw}" escapes the repository root`,
        'a marketplace fetch never reads outside the artifact it fetched',
      )
    }
    segments.push(segment)
  }
  return segments
}

/**
 * A ref that `git fetch` may receive as an argv word without being read as an
 * option or a refspec expression. `git fetch` runs a local transport's
 * `upload-pack` through a shell, so `--upload-pack=` plus backticks in a
 * catalog would be arbitrary code execution; a leading `-`, `..`, `@{` or a
 * control character is refused for the same reason.
 */
function gitRef(raw: string): string {
  const bad =
    raw === '' ||
    raw.startsWith('-') ||
    raw.length > 255 ||
    !/^[A-Za-z0-9._/-]+$/u.test(raw) ||
    raw.includes('..') ||
    raw.includes('@{') ||
    raw.includes('//') ||
    raw.startsWith('/') ||
    raw.endsWith('/') ||
    raw.endsWith('.') ||
    raw.endsWith('.lock') ||
    raw.split('/').some((part) => part === '' || part === '.' || part.startsWith('.'))
  if (bad) {
    throw refusal(
      'marketplace-fetch-refused',
      `git-subdir source.ref "${raw}" is not a plain git ref`,
      'use a branch, tag or refs/... name without options, "@{", ".." or a leading "-"',
    )
  }
  return raw
}

function localPath(value: string): string | undefined {
  if (value.startsWith('file:')) return value
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) return value
  return undefined
}

/**
 * The pre-fetch identity of a remote source: the grant target and the exact
 * command consent prints. This runs before any network and refuses anything
 * that cannot be fetched safely (bad scheme, credentials, an unpinned npm
 * registry spec, an escaping subdirectory).
 */
export function remoteTarget(source: MarketplaceSource, root: string): FetchTarget {
  switch (source.kind) {
    case 'git-subdir': {
      const url = remoteUrl(source.url, 'git-subdir source.url')
      const segments = subdirSegments(source.path)
      if (source.sha !== undefined && !HEX40.test(source.sha)) {
        throw refusal('marketplace-fetch-refused', `git-subdir source.sha "${source.sha}" must be a 40-character commit`)
      }
      const ref = source.sha !== undefined ? source.sha : gitRef(source.ref ?? 'HEAD')
      return {
        kind: 'git-subdir',
        // The grant target keeps an opaque query fingerprint (targetUrl) but
        // never the query itself; the printed command is display-redacted.
        target: `git:${targetUrl(url)}@${ref}#${segments.join('/')}`,
        command: `git fetch --depth=1 ${redactAccess(url.toString())} ${ref}`,
        pinned: source.sha !== undefined,
      }
    }
    case 'npm': {
      const local = localPath(source.package)
      if (local !== undefined) {
        const path = local.startsWith('file:') ? fileURLToPath(remoteUrl(local, 'npm source.package')) : resolve(root, local)
        if (!existsSync(path)) {
          throw refusal('marketplace-fetch-refused', `npm source "${source.package}" resolves to ${path}, which does not exist`)
        }
        if (/\s/u.test(path)) {
          throw refusal('marketplace-fetch-refused', `npm source path "${path}" contains whitespace, which the grant store cannot record`)
        }
        if (source.version !== undefined && !SEMVER.test(source.version)) {
          throw refusal('marketplace-fetch-refused', `npm source.version "${source.version}" must be an exact version`)
        }
        return {
          kind: 'npm',
          target: `npm:${path}@${source.version ?? '-'}`,
          command: `npm pack ${path} --ignore-scripts`,
          pinned: source.version !== undefined,
        }
      }
      if (!NPM_NAME.test(source.package)) {
        throw refusal('marketplace-fetch-refused', `npm source.package "${source.package}" is not a package name`)
      }
      if (source.version === undefined) {
        throw refusal(
          'marketplace-fetch-refused',
          `npm source "${source.package}" must pin an exact version; "latest" and ranges are not a pin`,
          'add "version" to the entry source (for example "1.2.3")',
        )
      }
      if (!SEMVER.test(source.version)) {
        throw refusal(
          'marketplace-fetch-refused',
          `npm source "${source.package}" version "${source.version}" is not an exact version`,
          'a range or tag can move; pin the version the catalog was tested against',
        )
      }
      return {
        kind: 'npm',
        target: `npm:${source.package}@${source.version}`,
        command: `npm pack ${source.package}@${source.version} --ignore-scripts`,
        pinned: true,
      }
    }
    case 'url': {
      const url = remoteUrl(source.url, 'url source.url')
      return {
        kind: 'url',
        target: `url:${targetUrl(url)}`,
        command: `GET ${redactAccess(url.toString())}`,
        pinned: false,
      }
    }
    default:
      throw refusal(
        'unsupported-marketplace-source',
        `${source.kind} sources are not installable: this slice fetches url, git-subdir and npm sources`,
      )
  }
}

/** Path-safe component for the cache layout. A name is already validated, but a resolved version is not. */
function component(value: string): string {
  return value.replace(/[^A-Za-z0-9._@+-]/gu, '-')
}

function cacheDirectory(cacheRoot: string, marketplace: string, entry: string, resolved: string): string {
  return join(cacheRoot, component(marketplace), `${component(entry)}@${component(resolved)}`)
}

function metadataPath(directory: string): string {
  return join(directory, METADATA)
}

function readMetadata(directory: string): Metadata | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(metadataPath(directory), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (
    (record.kind !== 'url' && record.kind !== 'git-subdir' && record.kind !== 'npm') ||
    typeof record.integrity !== 'string' ||
    typeof record.resolved !== 'string' ||
    typeof record.resolvedAt !== 'string' ||
    typeof record.plugin !== 'string'
  ) {
    return undefined
  }
  return {
    kind: record.kind,
    integrity: record.integrity,
    resolved: record.resolved,
    resolvedAt: record.resolvedAt,
    plugin: record.plugin,
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.contentHash === 'string' ? { contentHash: record.contentHash } : {}),
  }
}

function metadataFor(
  kind: RemoteSourceKind,
  integrity: string,
  resolved: string,
  plugin: string,
  version: string | undefined,
): Metadata {
  return {
    kind,
    integrity,
    resolved,
    resolvedAt: new Date().toISOString(),
    plugin,
    ...(version === undefined ? {} : { version }),
  }
}

/** A plugin root must carry one of the manifests a dialect recognises. */
function hasManifest(directory: string): boolean {
  return PLUGIN_MANIFESTS.some((manifest) => existsSync(join(directory, manifest)))
}

function escapes(resolvedPath: string, root: string): boolean {
  const rel = relative(root, resolvedPath)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * Locate the plugin inside an artifact tree. `subdir` is the git-subdir path;
 * without one, the artifact root is the plugin unless exactly one child
 * directory is (a tarball may wrap the plugin in its own directory).
 */
function pluginInside(
  artifactRoot: string,
  request: FetchRequest,
  subdir: string | undefined,
): { pluginDir: string; plugin: string } {
  let directory = artifactRoot
  if (subdir !== undefined) {
    directory = resolve(artifactRoot, subdir)
    if (escapes(directory, artifactRoot)) {
      throw refusal(
        'marketplace-fetch-refused',
        `git-subdir source.path "${subdir}" escapes the fetched repository`,
      )
    }
  }
  if (!existsSync(directory)) {
    throw refusal(
      'marketplace-artifact-invalid',
      `${request.marketplace}: entry "${request.entry}" does not contain ${subdir === undefined ? 'a plugin' : `"${subdir}"`}`,
    )
  }
  if (!hasManifest(directory)) {
    const children = readdirSync(directory, { withFileTypes: true }).filter((child) => child.isDirectory())
    const candidates = children
      .map((child) => join(directory, child.name))
      .filter((child) => hasManifest(child))
    if (candidates.length === 1 && subdir === undefined) {
      directory = candidates[0]
    } else {
      throw refusal(
        'marketplace-artifact-invalid',
        `${request.marketplace}: entry "${request.entry}" fetched no plugin manifest (.claude-plugin/plugin.json, plugin.json or .codex-plugin/plugin.json)`,
        'an npm package or url tarball must contain the plugin at its root (or one directory down)',
      )
    }
  }
  try {
    const realRoot = realpathSync(artifactRoot)
    const realDirectory = realpathSync(directory)
    if (escapes(realDirectory, realRoot)) {
      throw refusal(
        'marketplace-artifact-invalid',
        `${request.marketplace}: entry "${request.entry}" resolves through a symlink outside the fetched artifact`,
      )
    }
  } catch (error) {
    if (error instanceof InstallCliError) throw error
  }
  if (request.name !== undefined) {
    const declared = pluginName(directory)
    if (declared !== undefined && declared !== request.name) {
      throw refusal(
        'name-mismatch',
        `entry "${request.marketplace}:${request.entry}" fetched a plugin that calls itself "${declared}"`,
        'the catalog entry name and the plugin manifest name must be the same; the fetch was not committed to the cache',
      )
    }
  }
  return { pluginDir: directory, plugin: relative(artifactRoot, directory) || '.' }
}

/**
 * A git checkout preserves symlinks, while the tar extractor refuses them.
 * Refuse them here too: one artifact shape should not be trusted differently
 * because it arrived as a repository instead of a tarball.
 */
function rejectSymlinks(root: string, request: FetchRequest): void {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop() as string
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw refusal(
          'marketplace-fetch-refused',
          `${request.marketplace}: entry "${request.entry}" fetched a git artifact containing the symbolic link "${relative(root, full)}"`,
          'a fetched artifact is plain files; replace the symlink with the file it points at',
        )
      }
      if (entry.isDirectory()) pending.push(full)
    }
  }
}

/**
 * Content address of an extracted artifact, over the relative paths and the
 * bytes (the metadata sidecar is not content). A reused cache entry is
 * re-hashed against this; metadata alone is a claim, not evidence.
 */
function contentDigest(root: string): string {
  const hash = createHash('sha256')
  const files: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop() as string
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(root, full).split(sep).join('/')
      if (rel === METADATA) continue
      files.push(rel)
    }
  }
  files.sort()
  for (const rel of files) {
    const full = join(root, rel)
    hash.update(rel).update('\0')
    hash.update(String(statSync(full).mode & 0o777)).update('\0')
    hash.update(readFileSync(full)).update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function artifactFrom(directory: string, metadata: Metadata): FetchedArtifact {
  const pluginDir = resolve(directory, metadata.plugin)
  return {
    root: directory,
    pluginDir,
    integrity: metadata.integrity,
    resolved: metadata.resolved,
    resolvedAt: metadata.resolvedAt,
    ...(metadata.version === undefined ? {} : { version: metadata.version }),
  }
}

/** Reuse an identical cached artifact, but never one whose manifest vanished. */
function reusable(directory: string, expected: { kind: RemoteSourceKind; resolved: string }): FetchedArtifact | undefined {
  if (!existsSync(metadataPath(directory))) return undefined
  const metadata = readMetadata(directory)
  if (metadata === undefined || metadata.kind !== expected.kind || metadata.resolved !== expected.resolved) return undefined
  // Trust is pinned to the artifact hash, so a reused directory is re-hashed;
  // a metadata sidecar alone cannot keep a tampered cache alive.
  if (metadata.contentHash === undefined || metadata.contentHash !== contentDigest(directory)) return undefined
  const pluginDir = resolve(directory, metadata.plugin)
  if (escapes(pluginDir, directory) || !existsSync(pluginDir) || !hasManifest(pluginDir)) return undefined
  return artifactFrom(directory, metadata)
}

function prepareCacheRoot(cacheRoot: string, marketplace: string): string {
  const parent = join(cacheRoot, component(marketplace))
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, '.fetch-'))
}

/** Move a verified artifact into its content-addressed directory, atomically. */
function commitArtifact(artifactRoot: string, final: string, metadata: Metadata): FetchedArtifact {
  const complete: Metadata = { ...metadata, contentHash: contentDigest(artifactRoot) }
  writeFileSync(metadataPath(artifactRoot), `${JSON.stringify(complete, null, 2)}\n`, 'utf8')
  if (existsSync(final)) {
    const existing = readMetadata(final)
    const intact =
      existing !== undefined &&
      existing.integrity === complete.integrity &&
      existing.contentHash !== undefined &&
      existing.contentHash === contentDigest(final)
    if (intact) {
      rmSync(artifactRoot, { recursive: true, force: true })
      return artifactFrom(final, existing)
    }
    rmSync(final, { recursive: true, force: true })
  }
  renameSync(artifactRoot, final)
  return artifactFrom(final, complete)
}

function git(args: string[], cwd: string, display: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        // A git fetch that decides to prompt is a hang, not a consent dialog.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message
    throw refusal(
      'marketplace-fetch-failed',
      `git fetch failed for ${display}: ${redactText(firstLine(stderr))}`,
    )
  }
}

function pluginName(directory: string): string | undefined {
  for (const manifest of PLUGIN_MANIFESTS) {
    const file = join(directory, manifest)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }
      if (typeof parsed.name === 'string' && parsed.name.trim() !== '') return parsed.name
    } catch {
      return undefined
    }
  }
  return undefined
}

function pluginVersion(directory: string): string | undefined {
  for (const manifest of PLUGIN_MANIFESTS) {
    const file = join(directory, manifest)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.trim() !== '') return parsed.version
    } catch {
      return undefined
    }
  }
  return undefined
}

function fetchGit(request: FetchRequest, source: Extract<MarketplaceSource, { kind: 'git-subdir' }>): FetchedArtifact {
  const url = remoteUrl(source.url, 'git-subdir source.url').toString()
  const sha = source.sha
  if (sha !== undefined) {
    const final = cacheDirectory(request.cacheRoot, request.marketplace, request.entry, sha)
    const hit = reusable(final, { kind: 'git-subdir', resolved: sha })
    if (hit !== undefined) return hit
  }
  const work = prepareCacheRoot(request.cacheRoot, request.marketplace)
  try {
    git(['init', '-q', work], work, redactAccess(url))
    const ref = sha ?? source.ref ?? 'HEAD'
    // `--` ends options even though `url` and `ref` are validated: belt and braces.
    git(['fetch', '--depth=1', '--', url, ref], work, redactAccess(url))
    const commit = git(['rev-parse', 'FETCH_HEAD'], work, redactAccess(url)).trim()
    if (sha !== undefined && commit !== sha) {
      throw refusal(
        'marketplace-fetch-failed',
        `git source resolved to ${commit}, not the pinned ${sha}; the ref moved`,
      )
    }
    git(['checkout', '-q', '-f', commit], work, redactAccess(url))
    rmSync(join(work, '.git'), { recursive: true, force: true })
    rejectSymlinks(work, request)
    const { pluginDir, plugin } = pluginInside(work, request, source.path)
    const version = pluginVersion(pluginDir)
    const final = cacheDirectory(request.cacheRoot, request.marketplace, request.entry, commit)
    return commitArtifact(work, final, metadataFor('git-subdir', `git:${commit}`, commit, plugin, version))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function fetchNpm(request: FetchRequest, source: Extract<MarketplaceSource, { kind: 'npm' }>, target: FetchTarget): FetchedArtifact {
  const local = localPath(source.package)
  const registry = local === undefined
  if (registry) {
    const final = cacheDirectory(request.cacheRoot, request.marketplace, request.entry, source.version as string)
    const hit = reusable(final, { kind: 'npm', resolved: source.version as string })
    if (hit !== undefined) return hit
  }
  const work = prepareCacheRoot(request.cacheRoot, request.marketplace)
  try {
    const pack = join(work, 'pack')
    mkdirSync(pack, { recursive: true })
    const spec = registry
      ? `${source.package}@${source.version as string}`
      : local.startsWith('file:')
        ? fileURLToPath(remoteUrl(local, 'npm source.package'))
        : resolve(request.root, local)
    let output: string
    try {
      output = execFileSync('npm', ['pack', spec, '--ignore-scripts', '--pack-destination', pack], {
        cwd: work,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        env: {
          ...process.env,
          // Keep the fetch self-contained: npm's own cache and logs live under
          // the temporary directory, never in a root-owned global cache.
          npm_config_cache: join(work, '.npm-cache'),
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
          npm_config_global: 'false',
        },
      })
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message
      throw refusal(
        'marketplace-fetch-failed',
        `npm pack failed for ${target.command}: ${redactText(firstLine(stderr))}`,
      )
    }
    const tarballs = readdirSync(pack).filter((file) => file.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw refusal(
        'marketplace-fetch-failed',
        `npm pack produced ${tarballs.length} tarballs for "${target.command}"`,
      )
    }
    const bytes = readFileSync(join(pack, tarballs[0]))
    const digest = createHash('sha512').update(bytes).digest('hex')
    const artifactRoot = join(work, 'artifact')
    mkdirSync(artifactRoot, { recursive: true })
    try {
      extractTarball(bytes, artifactRoot, { stripComponents: 1, maxBytes: MAX_ARTIFACT_BYTES })
    } catch (error) {
      if (error instanceof TarError) {
        throw refusal('marketplace-fetch-refused', `npm tarball refused: ${error.message}`)
      }
      throw error
    }
    let packageJson: { version?: unknown }
    try {
      packageJson = JSON.parse(readFileSync(join(artifactRoot, 'package.json'), 'utf8')) as { version?: unknown }
    } catch {
      throw refusal('marketplace-artifact-invalid', `npm package "${source.package}" has no readable package.json`)
    }
    if (typeof packageJson.version !== 'string' || !SEMVER.test(packageJson.version)) {
      throw refusal('marketplace-artifact-invalid', `npm package "${source.package}" has no usable version`)
    }
    if (source.version !== undefined && packageJson.version !== source.version) {
      throw refusal(
        'marketplace-artifact-invalid',
        `npm source declared version "${source.version}" but the package says "${packageJson.version}"`,
      )
    }
    const { pluginDir, plugin } = pluginInside(artifactRoot, request, undefined)
    const final = cacheDirectory(request.cacheRoot, request.marketplace, request.entry, packageJson.version)
    return commitArtifact(
      artifactRoot,
      final,
      metadataFor('npm', `npm:${digest}`, packageJson.version, plugin, packageJson.version),
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function readUrlBytes(raw: string): Promise<Buffer> {
  const url = remoteUrl(raw, 'url source.url')
  if (url.protocol === 'file:') {
    const path = fileURLToPath(url)
    let size: number
    try {
      size = statSync(path).size
    } catch (error) {
      throw refusal('marketplace-fetch-failed', `url ${redactAccess(url.toString())}: ${redactText((error as Error).message)}`)
    }
    if (size > MAX_ARTIFACT_BYTES) {
      throw refusal('marketplace-fetch-refused', `url artifact is ${size} bytes, above the ${MAX_ARTIFACT_BYTES} byte cap`)
    }
    try {
      return readFileSync(path)
    } catch (error) {
      throw refusal('marketplace-fetch-failed', `url ${redactAccess(url.toString())}: ${redactText((error as Error).message)}`)
    }
  }
  return await httpsBytes(url, 0, new Set([url.toString()]))
}

function httpsBytes(url: URL, redirects: number, visited: Set<string>): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsGet(
      url,
      { headers: { accept: 'application/gzip, application/x-gzip, application/octet-stream' }, timeout: TIMEOUT_MS },
      (response) => {
        const status = response.statusCode ?? 0
        if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
          response.resume()
          const location = response.headers.location
          if (location === undefined) {
            rejectPromise(refusal('marketplace-fetch-failed', `url ${redactAccess(url.toString())} redirected without a Location`))
            return
          }
          if (redirects >= MAX_REDIRECTS) {
            rejectPromise(
              refusal(
                'marketplace-fetch-refused',
                `url ${redactAccess(url.toString())} redirected more than ${MAX_REDIRECTS} times`,
              ),
            )
            return
          }
          let next: URL
          try {
            next = new URL(location, url)
          } catch {
            rejectPromise(refusal('marketplace-fetch-refused', `url ${redactAccess(url.toString())} redirected to an invalid URL`))
            return
          }
          if (next.protocol === 'http:') {
            rejectPromise(
              refusal(
                'insecure-marketplace-source',
                `url ${redactAccess(url.toString())} redirected to http`,
                'a redirect must stay on https',
              ),
            )
            return
          }
          if (next.protocol !== 'https:') {
            rejectPromise(refusal('marketplace-fetch-refused', `url ${redactAccess(url.toString())} redirected to ${next.protocol}`))
            return
          }
          // A redirect must not add a credential either. Same-origin echo of
          // server-supplied userinfo is still an Authorization header the
          // catalog and the grant never named.
          if (next.username !== '' || next.password !== '') {
            rejectPromise(
              refusal(
                'marketplace-fetch-refused',
                `url ${redactAccess(url.toString())} redirected to a URL carrying credentials; a redirect must not add userinfo`,
                'a redirect cannot introduce a credential the catalog and the consent did not name',
              ),
            )
            return
          }
          // Consent is for an origin and an artifact, not for whichever host a
          // redirect names. A cross-origin hop would install bytes fetched from
          // a server the human never saw.
          if (next.origin !== url.origin) {
            rejectPromise(
              refusal(
                'marketplace-fetch-refused',
                `url ${redactAccess(url.toString())} redirected to a different origin (${redactAccess(next.origin)}); a fetch stays on the origin it was consented for`,
                'put the final https URL in the catalog entry so consent names the host that serves the bytes',
              ),
            )
            return
          }
          if (visited.has(next.toString())) {
            rejectPromise(refusal('marketplace-fetch-refused', `url ${redactAccess(url.toString())} redirects in a loop`))
            return
          }
          visited.add(next.toString())
          resolvePromise(httpsBytes(next, redirects + 1, visited))
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          rejectPromise(refusal('marketplace-fetch-failed', `url ${redactAccess(url.toString())} answered HTTP ${status}`))
          return
        }
        const declared = Number.parseInt(response.headers['content-length'] ?? '', 10)
        if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
          response.resume()
          rejectPromise(
            refusal(
              'marketplace-fetch-refused',
              `url ${redactAccess(url.toString())} is ${declared} bytes, above the ${MAX_ARTIFACT_BYTES} byte cap`,
            ),
          )
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_ARTIFACT_BYTES) {
            request.destroy(
              refusal(
                'marketplace-fetch-refused',
                `url ${redactAccess(url.toString())} exceeded the ${MAX_ARTIFACT_BYTES} byte cap`,
              ),
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolvePromise(Buffer.concat(chunks)))
        response.on('error', rejectPromise)
      },
    )
    request.on('timeout', () => {
      request.destroy(refusal('marketplace-fetch-failed', `url ${redactAccess(url.toString())} timed out`))
    })
    request.on('error', (error) => {
      rejectPromise(error instanceof InstallCliError ? error : refusal('marketplace-fetch-failed', `url ${redactAccess(url.toString())}: ${redactText(error.message)}`))
    })
  })
}

function fetchUrl(request: FetchRequest, source: Extract<MarketplaceSource, { kind: 'url' }>): Promise<FetchedArtifact> {
  const url = remoteUrl(source.url, 'url source.url').toString()
  return readUrlBytes(url).then((bytes) => {
    if (!isGzip(bytes)) {
      throw refusal('marketplace-fetch-refused', `url ${redactAccess(url)} is not a gzip tarball`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    const final = cacheDirectory(request.cacheRoot, request.marketplace, request.entry, digest)
    const hit = reusable(final, { kind: 'url', resolved: digest })
    if (hit !== undefined) return hit
    const work = prepareCacheRoot(request.cacheRoot, request.marketplace)
    try {
      const artifactRoot = join(work, 'artifact')
      mkdirSync(artifactRoot, { recursive: true })
      try {
        extractTarball(bytes, artifactRoot, { maxBytes: MAX_ARTIFACT_BYTES })
      } catch (error) {
        if (error instanceof TarError) {
          throw refusal('marketplace-fetch-refused', `url tarball refused: ${error.message}`)
        }
        throw error
      }
      const { pluginDir, plugin } = pluginInside(artifactRoot, request, undefined)
      const version = pluginVersion(pluginDir)
      return commitArtifact(
        artifactRoot,
        final,
        metadataFor('url', `sha256:${digest}`, digest, plugin, version),
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}

/**
 * Resolve one remote entry: validate, fetch into the cache, and return the
 * directory plus its content address. Every refusal happens before the cache
 * directory is renamed into place, so a refused fetch leaves no artifact
 * behind (the temporary directory is removed in a `finally`).
 */
export async function fetchEntry(request: FetchRequest): Promise<FetchedArtifact> {
  if (request.source.kind === 'git-subdir') {
    const target = remoteTarget(request.source, request.root)
    return fetchGit(request, request.source)
  }
  if (request.source.kind === 'npm') {
    const target = remoteTarget(request.source, request.root)
    return fetchNpm(request, request.source, target)
  }
  if (request.source.kind === 'url') {
    const target = remoteTarget(request.source, request.root)
    return fetchUrl(request, request.source)
  }
  throw refusal(
    'unsupported-marketplace-source',
    `${request.source.kind} sources are not installable: this slice fetches url, git-subdir and npm sources`,
  )
}

/** Stable cache key for a fetched entry, for tests and diagnostics. */
export function cacheKey(request: Pick<FetchRequest, 'marketplace' | 'entry'>, resolved: string): string {
  return `${component(request.marketplace)}/${component(request.entry)}@${component(resolved)}`
}

/** The basename of the metadata file, so tests do not hard-code it twice. */
export const ARTIFACT_METADATA = METADATA
