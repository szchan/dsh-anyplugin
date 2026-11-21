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
 * clock, fs, store, settings, env, session, command, telemetry and the six
 * headless `ui` members. The two namespaces that would break the trust
 * boundary are refused with stable, catchable codes instead of returning
 * `undefined`:
 *
 * - `ui.ask`: the pin declares it, but its answer comes from a person and this
 *   host has no interaction to carry one (D32 leaves the surface open); the
 *   other `ui` members are served headless by `ui.ts`.
 * - `process.run`: exec grants are pinned to artifact bytes (D25); a mod is
 *   content-class and cannot turn a `$` call into an unpinned exec.
 *
 * `fs` follows the pinned d.ts: a relative path is resolved against the
 * invocation's session working directory and an absolute path is taken as
 * written. That is the directory the mod's own process would see upstream, and
 * the fetched `diff` graph reads its git directory through it; a plugin-data
 * root would silently answer a different file. `store` stays confined to the
 * plugin data directory (the pinned store is plugin-scoped), and `settings` is
 * read from the host's settings service when one supplies the merged snapshot;
 * this host has no such reader, so it refuses with a typed code instead of
 * serving a plugin-data file and calling it settings.
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
import { createUiSink, type ModUiSink, type UiRenderRequest } from './ui.ts'

/** Stable codes a bridged call refuses with; the reason always names the site. */
export type ModBridgeErrorCode =
  /** `$.ui.ask`: the pin declares a person's answer, and this host has none. */
  | 'ERR_MOD_HOST_UI_UNSUPPORTED'
  /** `$.ui.resolve`: the argument is not the pinned `ResolveInput` (surface + component). */
  | 'ERR_MOD_HOST_UI_INPUT'
  /** `$.process.run`: exec is pinned to the artifact, not to `$` (D25). */
  | 'ERR_MOD_HOST_EXEC_UNSUPPORTED'
  /** A path that is empty, not a string, or carries a NUL. */
  | 'ERR_MOD_HOST_PATH_INVALID'
  /** A store path whose lexical or resolved form leaves the plugin data directory. */
  | 'ERR_MOD_HOST_PATH_OUTSIDE'
  /** A path that does not exist (for `stat`, a broken link is `other`). */
  | 'ERR_MOD_HOST_PATH_MISSING'
  /** An OS refusal, a file too large to read, or a failed store write. */
  | 'ERR_MOD_HOST_FS'
  /** The host has no plugin data directory to root the store at. */
  | 'ERR_MOD_HOST_DATA_DIR_MISSING'
  /** A store key/value the host cannot persist (not a key, not JSON, over 4 MiB). */
  | 'ERR_MOD_HOST_STORE_INVALID'
  /** The host settings reader returned something that is not an object. */
  | 'ERR_MOD_HOST_SETTINGS_INVALID'
  /** `settings.read({ source })` asks for a source this host cannot serve. */
  | 'ERR_MOD_HOST_SETTINGS_SOURCE'
  /** No host settings reader supplies the merged snapshot `settings.read()` means. */
  | 'ERR_MOD_HOST_SETTINGS_UNAVAILABLE'
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
  /** `${CLAUDE_PLUGIN_DATA}`: the durable store's root (the pinned store is plugin-scoped). */
  readonly dataDir?: string
  /** The working directory `fs` resolves relative paths against; defaults to `process.cwd()`. */
  readonly cwd?: string
  /**
   * DSH's command service, when the host context has one. A resolver is
   * re-read at each `command.register`, so an optional service that mounts
   * after this plugin's apply is still found for a later handler.
   */
  readonly commands?: ModBridgeCommandRegistry | (() => ModBridgeCommandRegistry | undefined | null)
  /** Maps the invocation's agent to the session the `$` reads (raw DSH session or a view). */
  readonly session?: (agent: unknown) => unknown
  /** The host's merged settings snapshot; `settings.read()` refuses without one. */
  readonly settings?: () => unknown | Promise<unknown>
  /** Environment visible to `$.env.get`; the materializer passes its own. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Clock source; tests pin it, production uses `Date.now`. */
  readonly now?: () => number
  /** Telemetry sink; without one the host warning channel is used. */
  readonly telemetry?: (record: ModBridgeTelemetryRecord) => void
  /** Warning channel for reported-once omissions and refused sinks. */
  readonly warn?: (message: string) => void
  /**
   * The headless render sink (#75): `render` runs the mod's `ui.render`
   * chain for one pane, `onChange` is called whenever the recorded state
   * changes (the materializer registers its tool from it). Without `render`
   * a pane holds the engine's own default (`{ type: 'engine', ref: 0 }`) —
   * the same tree an upstream chain returns when every hook declines.
   */
  readonly ui?: {
    readonly render?: (request: UiRenderRequest) => unknown | Promise<unknown>
    readonly onChange?: () => void
  }
}

export interface ModBridge {
  /** A fresh `$` for one handler invocation, or a throw after `dispose()`. */
  dollar(agent?: unknown): Record<string, unknown>
  /**
   * The plugin's recorded panes, status and log lines. The `mod_ui` tool
   * reads this outside `$`; it is the same sink the handler calls.
   */
  readonly ui: ModUiSink
  /** Releases command registrations, timers and recorded panes; idempotent. */
  dispose(): void
}

const READ_LIMIT = 4 * 1024 * 1024
const STORE_FILE = '.anyplugin-store.json'
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

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const textOf = (message: any): string => {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('')
}

const inputOf = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Adapt a raw DSH session to the pinned `SessionMessage` shape. The tool
 * result turn is a **user** message carrying `toolResults` (d.ts:14943 at the 2.1.329 pin); the
 * assistant's `toolUses` entry also gains the observed `text`/`isError`
 * (d.ts:14938 at the 2.1.329 pin). A test view that already has `messages` passes through.
 */
export function sessionViewOf(value: unknown): ModBridgeSession | undefined {
  const session = isRecord(value) ? value : undefined
  if (session === undefined) return undefined
  if (typeof session.deriveMessages !== 'function') {
    if (!Array.isArray(session.messages)) return undefined
    return {
      ...(typeof session.id === 'string' ? { id: session.id } : {}),
      ...(typeof session.cwd === 'string' ? { cwd: session.cwd } : {}),
      messages: session.messages as readonly Record<string, unknown>[],
      ...(isRecord(session.usage) ? { usage: session.usage } : {}),
    }
  }
  const header = isRecord(session.header) ? session.header : undefined
  if (header === undefined) return undefined
  let derived: any[] = []
  try {
    derived = session.deriveMessages() as any[]
  } catch {
    derived = []
  }
  const messages: Array<Record<string, unknown>> = []
  const toolUses = new Map<string, Record<string, unknown>>()
  for (const message of derived) {
    if (message?.role === 'user') {
      messages.push({ role: 'user', text: textOf(message), toolUses: [] })
    } else if (message?.role === 'assistant') {
      const uses: Array<Record<string, unknown>> = []
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== 'tool-call') continue
          const use: Record<string, unknown> = {
            tool_use_id: String(block.id),
            tool: String(block.name),
            input: inputOf(block.arguments),
          }
          uses.push(use)
          toolUses.set(String(block.id), use)
        }
      }
      messages.push({ role: 'assistant', text: textOf(message), toolUses: uses })
    } else if (message?.role === 'tool') {
      const toolUseId = String(message.toolCallId)
      const resultText = textOf(message)
      const use = toolUses.get(toolUseId)
      if (use !== undefined) {
        if (resultText !== '') use.text = resultText
        if (message.isError === true) use.isError = true
      }
      messages.push({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{
          tool_use_id: toolUseId,
          ...(resultText === '' ? {} : { text: resultText }),
          ...(message.isError === true ? { isError: true } : {}),
        }],
      })
    }
  }

  const usage: Record<string, unknown> = {}
  if (finite(header.createdAt)) usage.startedAt = header.createdAt
  let events: any[] = []
  if (typeof session.snapshotEvents === 'function') {
    try {
      events = session.snapshotEvents() as any[]
    } catch {
      events = []
    }
  }
  let contextWindow: number | undefined
  let lastUsage: any
  for (const event of events) {
    if (event?.type === 'request/context') {
      const window = event.data?.contextWindow
      if (finite(window) && window > 0) contextWindow = window
    } else if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
      lastUsage = event.data.usage
    }
  }
  // The pinned usage never zeroes a figure the engine did not report. Only a
  // complete token accounting (input + both cache fields) next to a window is
  // a context block at all; a partial one is omitted and reported once.
  if (lastUsage !== undefined && finite(lastUsage.inputTokens) &&
      finite(lastUsage.cacheReadTokens) && finite(lastUsage.cacheWriteTokens) &&
      contextWindow !== undefined) {
    const tokens = lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens
    usage.context = {
      tokens,
      window: contextWindow,
      percent: Math.round((tokens / contextWindow) * 100),
    }
  }

  return {
    ...(typeof header.id === 'string' ? { id: header.id } : {}),
    cwd: typeof header.cwd === 'string' ? header.cwd : process.cwd(),
    messages,
    usage,
  }
}

/** The unscoped `ctx.get('commands')` read, as a re-read resolver. */
export function commandRegistryFromContext(ctx: any): () => ModBridgeCommandRegistry | undefined {
  return () => {
    try {
      return typeof ctx?.get === 'function' ? (ctx.get('commands') as ModBridgeCommandRegistry | undefined) : undefined
    } catch {
      return undefined
    }
  }
}

export function createModBridge(options: ModBridgeOptions): ModBridge {
  const plugin = options.plugin
  const label = `anyplugin mod ${plugin}`
  const warn = options.warn ?? ((): void => {})
  const env = options.env ?? {}
  const now = options.now ?? Date.now
  const sessionSource = options.session
  const settingsSource = options.settings
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

  // One sink per plugin load: panes, revisions, status and log lines are load
  // state (the pinned surface keeps them across handler invocations), while
  // each `$` still rebuilds the methods that reach it.
  const uiSink = createUiSink({
    plugin,
    ...(options.ui?.render === undefined ? {} : { render: options.ui.render }),
    ...(options.ui?.onChange === undefined ? {} : { onChange: options.ui.onChange }),
    warn: (message: string) => reportOnce(`ui:${message}`, message),
    refuse: fail,
  })

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
      // `fail` above is a stable refusal, not an OS error: rewrite it to FS
      // and a symlinked store would lose its OUTSIDE code.
      if (error instanceof ModBridgeError) throw error
      if (codeOf(error) === 'ENOENT') return { file }
      fail('ERR_MOD_HOST_FS', `${site}: cannot inspect ${file}: ${messageOf(error)}`, error)
    }
  }

  // ---- fs -----------------------------------------------------------------

  /** The pinned fs rule: relative to the invocation cwd, absolute as written. */
  const fsPathOf = (cwd: string, value: unknown, site: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      fail('ERR_MOD_HOST_PATH_INVALID', `${site}: path must be a non-empty string, got ${describeValue(value)}`)
    }
    if (value.includes('\0')) fail('ERR_MOD_HOST_PATH_INVALID', `${site}: path contains a NUL byte`)
    return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
  }

  const fsStat = async (cwd: string, path: unknown, statOptions?: unknown): Promise<unknown> => {
    const lexical = fsPathOf(cwd, path, '$.fs.stat')
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
    let realPath: string
    let target: ReturnType<typeof statSync>
    try {
      // Follow the whole path, including intermediate links, before deciding
      // anything about the final component (MF1).
      realPath = realpathSync(lexical)
      target = statSync(realPath)
    } catch (error) {
      if (isLink) {
        if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR' || codeOf(error) === 'ELOOP') {
          // A link that leads nowhere is `other`, the link's own bytes and mtime.
          return {
            kind: 'other' as const,
            size: link.size,
            mtimeMs: link.mtimeMs,
            isLink: true,
          }
        }
      }
      fail('ERR_MOD_HOST_FS', `$.fs.stat: ${JSON.stringify(path)}: ${messageOf(error)}`, error)
    }
    return {
      kind: kindOf(target.mode),
      size: target.size,
      mtimeMs: target.mtimeMs,
      isLink,
      ...(requested.resolve ? { realPath } : {}),
    }
  }

  const fsList = async (cwd: string, path?: unknown): Promise<unknown> => {
    const real = path === undefined ? cwd : fsPathOf(cwd, path, '$.fs.list')
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

  const fsRead = async (cwd: string, path: unknown, readOptions?: unknown): Promise<unknown> => {
    let as: 'text' | 'bytes' = 'text'
    if (readOptions !== undefined) {
      if (!isRecord(readOptions) || (readOptions.as !== 'text' && readOptions.as !== 'bytes')) {
        fail('ERR_MOD_HOST_PATH_INVALID', '$.fs.read: options must be { as: "text" | "bytes" }')
      }
      as = readOptions.as
    }
    const real = fsPathOf(cwd, path, '$.fs.read')
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
          `$.settings.read: source ${JSON.stringify(source)} is not bridged; the host serves the merged settings snapshot only`,
        )
      }
    }
    if (settingsSource === undefined) {
      fail(
        'ERR_MOD_HOST_SETTINGS_UNAVAILABLE',
        '$.settings.read: this host has no merged settings reader (ctx.settings exposes no readable snapshot); the field is refused rather than served from a plugin-data file',
      )
    }
    let value: unknown
    try {
      value = await settingsSource()
    } catch (error) {
      fail('ERR_MOD_HOST_SETTINGS_UNAVAILABLE', `$.settings.read: the host settings reader failed: ${messageOf(error)}`, error)
    }
    if (!isRecord(value)) {
      fail('ERR_MOD_HOST_SETTINGS_INVALID', `$.settings.read: the host settings reader returned ${describeValue(value)}, not an object`)
    }
    return value
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

  const sessionOfAgent = (agent: unknown): ModBridgeSession | undefined =>
    sessionSource === undefined ? undefined : sessionViewOf(sessionSource(agent))

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

  const sessionCwd = (agent: unknown): string => sessionOfAgent(agent)?.cwd ?? options.cwd ?? process.cwd()

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
          text: `/${name} is declared by anyplugin mod ${plugin}; its command.run hook is not bridged on this host`,
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
    const cwd = sessionCwd(agent)
    // The pinned `$ui` surface (#75): the same sink methods every invocation,
    // so a pane opened in `session.start` is still there for a later
    // `ui.render` hook. `invalidate`, `status` and `log` are void and throw
    // their typed refusals synchronously; `open`, `close` and `resolve` are
    // Promise-returning (`ask` rejects, everything else resolves).
    const ui: Record<string, unknown> = {
      invalidate: (event: unknown): void => uiSink.invalidate(event),
      status: (text: unknown): void => uiSink.status(text),
      log: (text: unknown, logOptions?: unknown): void => uiSink.log(text, logOptions),
      open: (pane: unknown): Promise<unknown> => uiSink.open(pane),
      close: (pane: unknown): Promise<void> => uiSink.close(pane),
      resolve: (input: unknown): unknown => uiSink.resolve(input),
      ask: () => uiSink.ask(),
    }
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
      fs: {
        stat: (path: unknown, statOptions?: unknown) => fsStat(cwd, path, statOptions),
        list: (path?: unknown) => fsList(cwd, path),
        read: (path: unknown, readOptions?: unknown) => fsRead(cwd, path, readOptions),
      },
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
    ui: uiSink,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      uiSink.dispose()
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
