/**
 * The `$` a mod handler receives, bridged onto this host.
 *
 * D31 gives the mod host exactly one seam: `host.dollar()` immediately before
 * each handler invocation. This module is the other side of that seam. It is
 * constructed **once per plugin load** (the command disposers, the timer
 * handles and the "reported once" set are load state), but `dollar(agent)`
 * returns a fresh table on every call: no mutable namespace object can leak
 * from one invocation to the next, and the session nouns are captured from
 * the agent that is running this invocation.
 *
 * What is bridged is the surface a real mod (the pinned `diff` graph) calls:
 * clock, fs, store, settings, env, session, command and telemetry. The two
 * namespaces that would break the trust boundary are refused with stable,
 * catchable codes instead of returning `undefined`:
 *
 * - `ui.*`: the element runtime does not exist in this host (D32).
 * - `process.run`: exec grants are pinned to artifact bytes (D25); a mod is
 *   content-class and cannot turn a `$` call into an unpinned exec.
 *
 * The three path-taking namespaces (`fs`, `store`, `settings`) are rooted at
 * the plugin's data directory, the directory the mod's own
 * `${CLAUDE_PLUGIN_DATA}` names. A relative path is resolved against that
 * root; every existing path is then checked by its **real** path, so a `..`
 * spelling and a symlink both refuse when they land outside. This is a
 * deliberate, declared confinement, narrower than the pinned d.ts's "session
 * working directory" rule: a mod is not a hook, and its data directory is the
 * only directory the host has granted it. `env.get` reads the environment the
 * host passes, never a path.
 *
 * Refusals are values a mod can observe: async call sites reject with
 * `ModBridgeError`, sync `ui` getters throw it. Nothing here swallows a
 * failure and returns `undefined`.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { codeOf, describeValue, messageOf } from './errors.ts'
import { isWithin } from './resolve.ts'

/** Stable codes a bridged call refuses with; the reason always names the site. */
export type ModBridgeErrorCode =
  /** `$.ui.*`: the element runtime is not part of this host (D32). */
  | 'ERR_MOD_HOST_UI_UNSUPPORTED'
  /** `$.process.run`: exec is pinned to the artifact, not to `$` (D25). */
  | 'ERR_MOD_HOST_EXEC_UNSUPPORTED'
  /** A path that is empty, not a string, or carries a NUL. */
  | 'ERR_MOD_HOST_PATH_INVALID'
  /** A path whose lexical or resolved form leaves the plugin data directory. */
  | 'ERR_MOD_HOST_PATH_OUTSIDE'
  /** A path that does not exist (for `stat`, a broken link is `other`). */
  | 'ERR_MOD_HOST_PATH_MISSING'
  /** An OS refusal, a file too large to read, or a failed store write. */
  | 'ERR_MOD_HOST_FS'
  /** The host has no plugin data directory to root a namespace at. */
  | 'ERR_MOD_HOST_DATA_DIR_MISSING'
  /** A store key/value the host cannot persist (not a key, not JSON, over 4 MiB). */
  | 'ERR_MOD_HOST_STORE_INVALID'
  /** `settings.json` in the data directory is not a JSON object. */
  | 'ERR_MOD_HOST_SETTINGS_INVALID'
  /** `settings.read({ source })` asks for a source this host cannot serve. */
  | 'ERR_MOD_HOST_SETTINGS_SOURCE'
  /** `env.get` was given a name that is not a non-empty string. */
  | 'ERR_MOD_HOST_ENV_INVALID'
  /** `session.id()` with no session on this invocation (D32 §4). */
  | 'ERR_MOD_HOST_SESSION_UNAVAILABLE'
  /** `clock.now`/`after`/`every` got a value that is not a duration. */
  | 'ERR_MOD_HOST_CLOCK_INVALID'
  /** `command.register` was given a spec this host cannot accept. */
  | 'ERR_MOD_HOST_COMMAND_INVALID'
  /** The command registry is not mounted on this host context. */
  | 'ERR_MOD_HOST_COMMAND_UNAVAILABLE'
  /** Another registration already owns that command name. */
  | 'ERR_MOD_HOST_COMMAND_DUPLICATE'
  /** The command registry refused the definition for another reason. */
  | 'ERR_MOD_HOST_COMMAND_REJECTED'
  /** The load was disposed; a new handler invocation is already impossible. */
  | 'ERR_MOD_HOST_DISPOSED'

export interface ModBridgeErrorOptions {
  /** The plugin the bridge belongs to; the message names it. */
  readonly plugin?: string
  /** The original error, kept for `error.cause`. */
  readonly cause?: unknown
}

export class ModBridgeError extends Error {
  readonly code: ModBridgeErrorCode
  readonly plugin: string | undefined
  /** The reason without the plugin prefix; the full message adds it. */
  readonly reason: string

  constructor(code: ModBridgeErrorCode, reason: string, options: ModBridgeErrorOptions = {}) {
    const message = options.plugin === undefined ? reason : `${options.plugin}: ${reason}`
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModBridgeError'
    this.code = code
    this.plugin = options.plugin
    this.reason = reason
  }
}

/** One telemetry entry the host sink accepted. */
export interface ModBridgeTelemetryRecord {
  readonly plugin: string
  readonly kind: 'mark' | 'log'
  readonly entry: unknown
}

/**
 * A command registration as the mod means it. `handler` is the host's
 * definition handler; the bridge supplies a stub that reports that the mod's
 * `command.run` hook is the real dispatcher, so the registry entry exists for
 * the load's lifetime and `/diff` is discoverable.
 */
export interface ModBridgeCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
  readonly handler: (invocation: unknown) => unknown
}

/** The slice of DSH's `ctx.commands` the bridge uses. */
export interface ModBridgeCommandRegistry {
  register(definition: ModBridgeCommandDefinition): () => void
}

/** A session view, already mapped to the pinned `SessionMessage`/`SessionUsage` shapes. */
export interface ModBridgeSession {
  readonly id?: string
  readonly cwd?: string
  readonly messages: readonly Record<string, unknown>[]
  readonly usage?: Readonly<Record<string, unknown>>
}

export interface ModBridgeOptions {
  /** Plugin name; every refusal message is prefixed with it. */
  readonly plugin: string
  /** `${CLAUDE_PLUGIN_DATA}`: the root of fs/store/settings. */
  readonly dataDir?: string
  /**
   * DSH's command service, when the host context has one. A resolver is
   * re-read at each `command.register`, so an optional service that mounts
   * after this plugin's apply is still found for a later handler.
   */
  readonly commands?: ModBridgeCommandRegistry | (() => ModBridgeCommandRegistry | undefined | null)
  /** Maps the invocation's agent to the session the `$` reads. */
  readonly session?: (agent: unknown) => ModBridgeSession | undefined
  /** Environment visible to `$.env.get`; the materializer passes its own. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Clock source; tests pin it, production uses `Date.now`. */
  readonly now?: () => number
  /** Telemetry sink; without one the host warning channel is used. */
  readonly telemetry?: (record: ModBridgeTelemetryRecord) => void
  /** Warning channel for reported-once omissions and refused sinks. */
  readonly warn?: (message: string) => void
}

export interface ModBridge {
  /** A fresh `$` for one handler invocation, or a throw after `dispose()`. */
  dollar(agent?: unknown): Record<string, unknown>
  /** Releases command registrations and timers; idempotent. */
  dispose(): void
}

const READ_LIMIT = 4 * 1024 * 1024
const STORE_FILE = '.anyplugin-store.json'
const SETTINGS_FILE = 'settings.json'
const UI_METHODS = [
  'invalidate',
  'status',
  'log',
  'open',
  'close',
  'resolve',
] as const
type UiMethod = (typeof UI_METHODS)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const kindOf = (mode: number): 'file' | 'dir' | 'other' => {
  // The numeric file-type bits are stable across the platforms Node supports;
  // `lstatSync().isFile()` is not available from a raw mode, so use the same
  // S_IF* values Node's own `Stats` predicates test.
  if ((mode & 0o170000) === 0o100000) return 'file'
  if ((mode & 0o170000) === 0o040000) return 'dir'
  return 'other'
}

const jsonText = (value: unknown): string => {
  try {
    const text = JSON.stringify(value)
    return text ?? String(value)
  } catch {
    return String(value)
  }
}

export function createModBridge(options: ModBridgeOptions): ModBridge {
  const plugin = options.plugin
  const label = `anyplugin mod ${plugin}`
  const warn = options.warn ?? ((): void => {})
  const env = options.env ?? {}
  const now = options.now ?? Date.now
  const sessionOf = options.session ?? ((): ModBridgeSession | undefined => undefined)
  const telemetrySink = options.telemetry
  const reported = new Set<string>()
  const commandDisposers = new Map<string, () => void>()
  const timers = new Set<{ handle: ReturnType<typeof setTimeout>; repeat: boolean }>()
  let disposed = false

  const fail = (code: ModBridgeErrorCode, reason: string, cause?: unknown): never => {
    throw new ModBridgeError(code, reason, {
      plugin,
      ...(cause === undefined ? {} : { cause }),
    })
  }

  const reportOnce = (key: string, message: string): void => {
    if (reported.has(key)) return
    reported.add(key)
    warn(`${label}: ${message}`)
  }

  let root: string | undefined
  let rootReason: string | undefined
  if (options.dataDir === undefined || options.dataDir === '') {
    rootReason = 'the materializer config carries no pluginData directory'
  } else {
    try {
      mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
      root = realpathSync(options.dataDir)
    } catch (error) {
      rootReason = `cannot open the plugin data directory ${options.dataDir}: ${messageOf(error)}`
    }
  }
  const rootOf = (): string => {
    if (root === undefined) fail('ERR_MOD_HOST_DATA_DIR_MISSING', rootReason ?? 'no plugin data directory')
    return root
  }

  /** The lexical path, checked to sit at or under the data directory. */
  const lexicalOf = (value: unknown, site: string): string => {
    const base = rootOf()
    if (typeof value !== 'string' || value.length === 0) {
      fail('ERR_MOD_HOST_PATH_INVALID', `${site}: path must be a non-empty string, got ${describeValue(value)}`)
    }
    if (value.includes('\0')) fail('ERR_MOD_HOST_PATH_INVALID', `${site}: path contains a NUL byte`)
    const lexical = isAbsolute(value) ? resolve(value) : resolve(base, value)
    if (!isWithin(base, lexical)) {
      fail(
        'ERR_MOD_HOST_PATH_OUTSIDE',
        `${site}: ${JSON.stringify(value)} resolves to ${lexical}, outside the plugin data directory ${base}`,
      )
    }
    return lexical
  }

  /** A path that must exist: lexical and real-path confinement, then its real path. */
  const existingRealOf = (value: unknown, site: string): string => {
    const lexical = lexicalOf(value, site)
    let real: string
    try {
      real = realpathSync(lexical)
    } catch (error) {
      if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') {
        fail('ERR_MOD_HOST_PATH_MISSING', `${site}: ${JSON.stringify(value)} does not exist`, error)
      }
      fail('ERR_MOD_HOST_FS', `${site}: cannot resolve ${JSON.stringify(value)}: ${messageOf(error)}`, error)
    }
    const base = rootOf()
    if (!isWithin(base, real)) {
      fail(
        'ERR_MOD_HOST_PATH_OUTSIDE',
        `${site}: ${JSON.stringify(value)} resolves through a link to ${real}, outside the plugin data directory ${base}`,
      )
    }
    return real
  }

  /** A fixed file under the data directory; a symlink that leaves the root refuses. */
  const confinedFile = (name: string, site: string): { file: string; real?: string } => {
    const base = rootOf()
    const file = join(base, name)
    try {
      const real = realpathSync(file)
      if (!isWithin(base, real)) {
        fail('ERR_MOD_HOST_PATH_OUTSIDE', `${site}: ${file} links to ${real}, outside the plugin data directory ${base}`)
      }
      return { file, real }
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return { file }
      fail('ERR_MOD_HOST_FS', `${site}: cannot inspect ${file}: ${messageOf(error)}`, error)
    }
  }

  // ---- fs -----------------------------------------------------------------

  const fsStat = async (path: unknown, statOptions?: unknown): Promise<unknown> => {
    const lexical = lexicalOf(path, '$.fs.stat')
    let requested: { resolve: boolean } = { resolve: false }
    if (statOptions !== undefined) {
      if (!isRecord(statOptions) || typeof statOptions.resolve !== 'boolean') {
        fail('ERR_MOD_HOST_PATH_INVALID', '$.fs.stat: options must be { resolve: boolean }')
      }
      requested = { resolve: statOptions.resolve }
    }
    let link: ReturnType<typeof lstatSync>
    try {
      link = lstatSync(lexical)
    } catch (error) {
      if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') {
        fail('ERR_MOD_HOST_PATH_MISSING', `$.fs.stat: ${JSON.stringify(path)} does not exist`, error)
      }
      fail('ERR_MOD_HOST_FS', `$.fs.stat: ${JSON.stringify(path)}: ${messageOf(error)}`, error)
    }
    const isLink = link.isSymbolicLink()
    let target = link
    let realPath: string | undefined
    if (isLink) {
      try {
        realPath = realpathSync(lexical)
        target = statSync(lexical)
      } catch (error) {
        if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR' || codeOf(error) === 'ELOOP') {
          // A link that leads nowhere is `other`, the link's own bytes and mtime.
          return {
            kind: 'other' as const,
            size: link.size,
            mtimeMs: link.mtimeMs,
            isLink: true,
          }
        }
        fail('ERR_MOD_HOST_FS', `$.fs.stat: ${JSON.stringify(path)}: ${messageOf(error)}`, error)
      }
      const base = rootOf()
      if (!isWithin(base, realPath)) {
        fail(
          'ERR_MOD_HOST_PATH_OUTSIDE',
          `$.fs.stat: ${JSON.stringify(path)} leads to ${realPath}, outside the plugin data directory ${base}`,
        )
      }
    } else if (requested.resolve) {
      try {
        realPath = realpathSync(lexical)
      } catch (error) {
        fail('ERR_MOD_HOST_FS', `$.fs.stat: cannot resolve ${JSON.stringify(path)}: ${messageOf(error)}`, error)
      }
    }
    return {
      kind: kindOf(target.mode),
      size: target.size,
      mtimeMs: target.mtimeMs,
      isLink,
      ...(requested.resolve && realPath === undefined ? {} : requested.resolve ? { realPath } : {}),
    }
  }

  const fsList = async (path?: unknown): Promise<unknown> => {
    const base = rootOf()
    const real = path === undefined ? base : existingRealOf(path, '$.fs.list')
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(real, { withFileTypes: true })
    } catch (error) {
      fail('ERR_MOD_HOST_FS', `$.fs.list: cannot list ${JSON.stringify(path ?? '.')}: ${messageOf(error)}`, error)
    }
    const listed: Array<{ name: string; kind: string; size: number; isLink: boolean }> = []
    for (const entry of entries) {
      const name = String(entry.name)
      let info: ReturnType<typeof lstatSync>
      try {
        info = lstatSync(join(real, name))
      } catch (error) {
        fail('ERR_MOD_HOST_FS', `$.fs.list: cannot stat ${JSON.stringify(name)}: ${messageOf(error)}`, error)
      }
      const isLink = info.isSymbolicLink()
      listed.push({
        name,
        kind: isLink ? 'other' : kindOf(info.mode),
        size: info.size,
        isLink,
      })
    }
    listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return listed
  }

  const fsRead = async (path: unknown, readOptions?: unknown): Promise<unknown> => {
    let as: 'text' | 'bytes' = 'text'
    if (readOptions !== undefined) {
      if (!isRecord(readOptions) || (readOptions.as !== 'text' && readOptions.as !== 'bytes')) {
        fail('ERR_MOD_HOST_PATH_INVALID', '$.fs.read: options must be { as: "text" | "bytes" }')
      }
      as = readOptions.as
    }
    const real = existingRealOf(path, '$.fs.read')
    let data: Buffer
    try {
      const info = statSync(real)
      if (!info.isFile()) fail('ERR_MOD_HOST_FS', `$.fs.read: ${JSON.stringify(path)} is not a file`)
      if (info.size > READ_LIMIT) {
        fail('ERR_MOD_HOST_FS', `$.fs.read: ${JSON.stringify(path)} is over the 4 MiB read limit (${info.size} bytes)`)
      }
      data = readFileSync(real)
    } catch (error) {
      if (error instanceof ModBridgeError) throw error
      fail('ERR_MOD_HOST_FS', `$.fs.read: cannot read ${JSON.stringify(path)}: ${messageOf(error)}`, error)
    }
    if (data.byteLength > READ_LIMIT) {
      fail('ERR_MOD_HOST_FS', `$.fs.read: ${JSON.stringify(path)} is over the 4 MiB read limit (${data.byteLength} bytes)`)
    }
    return as === 'bytes' ? { base64: data.toString('base64') } : data.toString('utf8')
  }

  // ---- store --------------------------------------------------------------

  let storeQueue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(work: () => T): Promise<T> => {
    const result = storeQueue.then(work, work)
    storeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const readStore = (): Record<string, unknown> => {
    const { file, real } = confinedFile(STORE_FILE, '$.store')
    if (real === undefined) return {}
    let text: string
    try {
      text = readFileSync(real, 'utf8')
    } catch (error) {
      fail('ERR_MOD_HOST_FS', `$.store: cannot read ${file}: ${messageOf(error)}`, error)
    }
    if (text.trim() === '') return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      fail('ERR_MOD_HOST_STORE_INVALID', `$.store: ${file} is not JSON: ${messageOf(error)}`, error)
    }
    if (!isRecord(parsed)) fail('ERR_MOD_HOST_STORE_INVALID', `$.store: ${file} is not a JSON object`)
    return parsed
  }

  const writeStore = (document: Record<string, unknown>): void => {
    const base = rootOf()
    const file = join(base, STORE_FILE)
    // Refuse to replace a symlink that leaves the root; the rename below
    // replaces the link itself, never the file it names.
    confinedFile(STORE_FILE, '$.store')
    const temporary = join(base, `${STORE_FILE}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify(document), { mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The original write failed; the temporary cleanup must not mask it.
      }
      fail('ERR_MOD_HOST_FS', `$.store: cannot write ${file}: ${messageOf(error)}`, error)
    }
  }

  const cloneJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

  const storeGet = async (key: unknown): Promise<unknown> => {
    if (typeof key !== 'string' || key.length === 0) {
      fail('ERR_MOD_HOST_STORE_INVALID', `$.store.get: key must be a non-empty string, got ${describeValue(key)}`)
    }
    return serialized(() => {
      const document = readStore()
      if (!Object.hasOwn(document, key)) return undefined
      return cloneJson(document[key])
    })
  }

  const storeSet = async (key: unknown, value: unknown): Promise<void> => {
    if (typeof key !== 'string' || key.length === 0) {
      fail('ERR_MOD_HOST_STORE_INVALID', `$.store.set: key must be a non-empty string, got ${describeValue(key)}`)
    }
    let encoded: string | undefined
    try {
      encoded = JSON.stringify(value)
    } catch (error) {
      fail('ERR_MOD_HOST_STORE_INVALID', `$.store.set: value is not JSON: ${messageOf(error)}`, error)
    }
    if (encoded === undefined) {
      fail('ERR_MOD_HOST_STORE_INVALID', `$.store.set: value is not a JSON value, got ${describeValue(value)}`)
    }
    if (Buffer.byteLength(encoded, 'utf8') > READ_LIMIT) {
      fail('ERR_MOD_HOST_STORE_INVALID', `$.store.set: value is over the 4 MiB store limit`)
    }
    await serialized(() => {
      const document = readStore()
      document[key] = JSON.parse(encoded)
      writeStore(document)
    })
  }

  const storeDelete = async (key: unknown): Promise<boolean> => {
    if (typeof key !== 'string' || key.length === 0) {
      fail('ERR_MOD_HOST_STORE_INVALID', `$.store.delete: key must be a non-empty string, got ${describeValue(key)}`)
    }
    return serialized(() => {
      const document = readStore()
      if (!Object.hasOwn(document, key)) return false
      delete document[key]
      writeStore(document)
      return true
    })
  }

  const storeKeys = async (): Promise<string[]> =>
    serialized(() => Object.keys(readStore()))

  // ---- settings -----------------------------------------------------------

  const settingsRead = async (args?: unknown): Promise<Record<string, unknown>> => {
    if (args !== undefined) {
      if (!isRecord(args)) fail('ERR_MOD_HOST_SETTINGS_INVALID', `$.settings.read: arguments must be an object, got ${describeValue(args)}`)
      const source = args.source
      if (source !== undefined) {
        fail(
          'ERR_MOD_HOST_SETTINGS_SOURCE',
          `$.settings.read: source ${JSON.stringify(source)} is not bridged; this host serves the plugin data directory's settings.json only`,
        )
      }
    }
    const { file, real } = confinedFile(SETTINGS_FILE, '$.settings.read')
    if (real === undefined) return {}
    let text: string
    try {
      text = readFileSync(real, 'utf8')
    } catch (error) {
      fail('ERR_MOD_HOST_FS', `$.settings.read: cannot read ${file}: ${messageOf(error)}`, error)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      fail('ERR_MOD_HOST_SETTINGS_INVALID', `$.settings.read: ${file} is not JSON: ${messageOf(error)}`, error)
    }
    if (!isRecord(parsed)) fail('ERR_MOD_HOST_SETTINGS_INVALID', `$.settings.read: ${file} is not a JSON object`)
    return parsed
  }

  // ---- env -----------------------------------------------------------------

  const envGet = async (name: unknown): Promise<string | undefined> => {
    if (typeof name !== 'string' || name.length === 0) {
      fail('ERR_MOD_HOST_ENV_INVALID', `$.env.get: name must be a non-empty string, got ${describeValue(name)}`)
    }
    if (!Object.hasOwn(env, name)) return undefined
    const value = env[name]
    return typeof value === 'string' ? value : undefined
  }

  // ---- session -------------------------------------------------------------

  const sessionOfAgent = (agent: unknown): ModBridgeSession | undefined => sessionOf(agent)

  const sessionId = async (agent: unknown): Promise<string> => {
    const view = sessionOfAgent(agent)
    if (view?.id === undefined) {
      fail(
        'ERR_MOD_HOST_SESSION_UNAVAILABLE',
        '$.session.id: no session is attached to this invocation; a load-time session.start has none (D32 §4)',
      )
    }
    return view.id
  }

  const sessionCwd = (agent: unknown): string => sessionOfAgent(agent)?.cwd ?? process.cwd()

  const sessionMessages = async (agent: unknown): Promise<readonly Record<string, unknown>[]> =>
    sessionOfAgent(agent)?.messages ?? []

  const sessionUsage = async (agent: unknown): Promise<Readonly<Record<string, unknown>>> => {
    const usage = sessionOfAgent(agent)?.usage ?? {}
    for (const field of ['startedAt', 'context', 'rateLimits', 'cost'] as const) {
      if (!Object.hasOwn(usage, field)) {
        reportOnce(
          `usage.${field}`,
          `$.session.usage() has no ${field} observable on this host; the field is omitted, never zeroed`,
        )
      }
    }
    if (isRecord(usage.context)) {
      for (const field of ['tokens', 'window'] as const) {
        if (!Object.hasOwn(usage.context, field)) {
          reportOnce(
            `usage.context.${field}`,
            `$.session.usage().context has no ${field} observable on this host; the field is omitted, never zeroed`,
          )
        }
      }
    }
    return usage
  }

  // ---- clock ---------------------------------------------------------------

  const durationOf = (value: unknown, site: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail('ERR_MOD_HOST_CLOCK_INVALID', `${site}: delay must be a finite number of milliseconds >= 0, got ${describeValue(value)}`)
    }
    return Math.max(1, Math.floor(value))
  }

  const timerOf = (ms: unknown, fn: unknown, repeat: boolean, site: string): { cancel: () => void } => {
    const delay = durationOf(ms, site)
    if (typeof fn !== 'function') fail('ERR_MOD_HOST_CLOCK_INVALID', `${site}: callback must be a function, got ${describeValue(fn)}`)
    const handle = repeat ? setInterval(fn, delay) : setTimeout(fn, delay)
    const timer = { handle, repeat }
    timers.add(timer)
    return {
      cancel: (): void => {
        if (!timers.delete(timer)) return
        if (repeat) clearInterval(handle)
        else clearTimeout(handle)
      },
    }
  }

  // ---- commands ------------------------------------------------------------

  const registerCommand = async (spec: unknown): Promise<{ command: string }> => {
    if (disposed) fail('ERR_MOD_HOST_DISPOSED', '$.command.register: the load has been disposed')
    if (!isRecord(spec)) fail('ERR_MOD_HOST_COMMAND_INVALID', `$.command.register: spec must be an object, got ${describeValue(spec)}`)
    const name = spec.name
    const description = spec.description
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(name)) {
      fail(
        'ERR_MOD_HOST_COMMAND_INVALID',
        `$.command.register: name ${JSON.stringify(name)} is not a DSH command name (lowercase /^[a-z][a-z0-9_-]*$/); the mod's authored name is not rewritten`,
      )
    }
    if (typeof description !== 'string') {
      fail('ERR_MOD_HOST_COMMAND_INVALID', '$.command.register: description must be a string')
    }
    let registry: ModBridgeCommandRegistry | undefined
    try {
      registry = typeof options.commands === 'function' ? (options.commands() ?? undefined) : options.commands
    } catch (error) {
      warn(`${label}: resolving the command registry failed: ${messageOf(error)}`)
      registry = undefined
    }
    if (registry === undefined) {
      fail(
        'ERR_MOD_HOST_COMMAND_UNAVAILABLE',
        '$.command.register: the host context has no command registry (ctx.commands); the command cannot be listed',
      )
    }
    // Re-registering a name replaces it upstream, so release this mod's own
    // previous registration before asking DSH. A duplicate that remains is a
    // different owner and is refused below, naming this mod.
    const previous = commandDisposers.get(name)
    if (previous !== undefined) {
      previous()
      commandDisposers.delete(name)
    }
    let dispose: unknown
    try {
      dispose = registry.register({
        name,
        description,
        handler: () => ({
          kind: 'error',
          text: `/${name} is declared by anyplugin mod ${plugin}; its command.run hook answers the run`,
        }),
      })
    } catch (error) {
      const message = messageOf(error)
      if (/already registered/i.test(message)) {
        fail('ERR_MOD_HOST_COMMAND_DUPLICATE', `$.command.register: ${JSON.stringify(name)} is already registered: ${message}`, error)
      }
      fail('ERR_MOD_HOST_COMMAND_REJECTED', `$.command.register: the command registry refused ${JSON.stringify(name)}: ${message}`, error)
    }
    if (typeof dispose !== 'function') {
      fail('ERR_MOD_HOST_COMMAND_REJECTED', '$.command.register: the command registry returned no disposer')
    }
    commandDisposers.set(name, dispose)
    return { command: name }
  }

  // ---- telemetry -----------------------------------------------------------

  const emitTelemetry = (kind: 'mark' | 'log', entry: unknown): void => {
    const record: ModBridgeTelemetryRecord = { plugin, kind, entry }
    if (telemetrySink !== undefined) {
      try {
        telemetrySink(record)
      } catch (error) {
        warn(`${label}: telemetry.${kind} sink failed: ${messageOf(error)}`)
      }
      return
    }
    warn(`${label}: telemetry.${kind} ${jsonText(entry)}`)
  }

  // ---- the table -----------------------------------------------------------

  const dollar = (agent?: unknown): Record<string, unknown> => {
    if (disposed) fail('ERR_MOD_HOST_DISPOSED', 'the bridge was disposed; no further handler can run')
    const ui = Object.fromEntries(
      UI_METHODS.map((method: UiMethod) => {
        const refuse = (): never =>
          fail(
            'ERR_MOD_HOST_UI_UNSUPPORTED',
            `$.ui.${method} is refused: the element runtime (D32) is not implemented on this host, so a pane, status line, log, or invalidation has nowhere to land`,
          )
        // `invalidate`, `status` and `log` are void in the pinned d.ts and
        // throw synchronously; `open`, `close` and `resolve` are Promise-returning
        // and reject.
        const refuseAsync = async (): Promise<never> => refuse()
        return [method, method === 'open' || method === 'close' || method === 'resolve' ? refuseAsync : refuse]
      }),
    ) as Record<string, unknown>
    return {
      session: {
        id: () => sessionId(agent),
        cwd: sessionCwd(agent),
        messages: () => sessionMessages(agent),
        usage: () => sessionUsage(agent),
      },
      clock: {
        now: async (): Promise<number> => {
          const value = now()
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            fail('ERR_MOD_HOST_CLOCK_INVALID', `$.clock.now: host clock returned ${describeValue(value)}`)
          }
          return value
        },
        after: (ms: unknown, fn: unknown): { cancel: () => void } => timerOf(ms, fn, false, '$.clock.after'),
        every: (ms: unknown, fn: unknown): { cancel: () => void } => timerOf(ms, fn, true, '$.clock.every'),
      },
      process: {
        run: async (): Promise<never> =>
          fail(
            'ERR_MOD_HOST_EXEC_UNSUPPORTED',
            '$.process.run is refused: exec is granted per pinned artifact bytes (D25) and a mod is content-class; an unpinned argv from a handler has no grant',
          ),
      },
      fs: { stat: fsStat, list: fsList, read: fsRead },
      store: { get: storeGet, set: storeSet, delete: storeDelete, keys: storeKeys },
      settings: { read: settingsRead },
      env: { get: envGet },
      ui,
      command: { register: registerCommand },
      telemetry: {
        mark: (entry: unknown): void => emitTelemetry('mark', entry),
        log: (entry: unknown): void => emitTelemetry('log', entry),
      },
    }
  }

  return {
    dollar,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      for (const dispose of commandDisposers.values()) {
        try {
          dispose()
        } catch (error) {
          warn(`${label}: command disposer failed: ${messageOf(error)}`)
        }
      }
      commandDisposers.clear()
      for (const timer of timers) {
        if (timer.repeat) clearInterval(timer.handle)
        else clearTimeout(timer.handle)
      }
      timers.clear()
    },
  }
}
