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
 * clock, fs, store, settings, env, session, command, telemetry, the six
 * headless `ui` members, and the read-only `vcs` members `detect` and `diff`.
 * The two namespaces that would break the trust boundary are refused with
 * stable, catchable codes instead of returning `undefined`:
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
 * `vcs` is served for git only and is read-only. `detect` and `diff` run the
 * host's `git` through `execFile` (never a shell) with a timeout, no network
 * verb, no write and `--no-optional-locks`; external diff drivers, textconv,
 * the fsmonitor hook and every repository-configured `filter.*` clean/process
 * driver are disabled or neutralised because the repository configures them
 * and this host does not run a program a repository chooses. The filter
 * overrides travel through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` rather than
 * `-c`, because git splits `-c key=value` at the first `=` and a driver key
 * can itself contain one. A relative
 * `path` resolves under the session working directory, which is what the
 * pinned `$` prose says for `detect` even though the field comment says
 * absolute; a name over the pin's 4096-character bound refuses the call. The
 * child process always starts inside the session working directory; a path
 * outside it is refused before any process is spawned, unless `detect`
 * already reported that exact working-copy root through a path inside the
 * session.
 * `isolate`, `list`, `status` and `release` are typed refusals with a named
 * reason, never `undefined`.
 *
 * Refusals are values a mod can observe: async call sites reject with
 * `ModBridgeError`, sync `ui` getters throw it. Nothing here swallows a
 * failure and returns `undefined`.
 */
import { execFile } from 'node:child_process'
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
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path'

import { codeOf, describeValue, messageOf } from './errors.ts'
import { isWithin } from './resolve.ts'
import {
  createUiSink,
  type ModUiSink,
  type UiRenderRequest,
  type UiResolveInput,
  type UiSurface,
} from './ui.ts'

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
  /** `$.vcs.*` was given something that is not the pinned input shape. */
  | 'ERR_MOD_HOST_VCS_INVALID'
  /** `$.vcs.detect`/`diff` could not run git (missing binary, timeout, non-zero exit). */
  | 'ERR_MOD_HOST_VCS_FAILED'
  /** A pinned `vcs` member this host has no bridge for (typed refusal, not `undefined`). */
  | 'ERR_MOD_HOST_VCS_UNSUPPORTED'

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
  /** The working directory `fs` resolves relative paths against, and the boundary for `vcs` paths. */
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
    /** Declared surface the headless sink stands in for; defaults to `terminal`. */
    readonly surface?: UiSurface
    readonly render?: (request: UiRenderRequest) => unknown | Promise<unknown>
    /** The host's `ui.resolve` chain; without it the surface's own table is returned. */
    readonly resolve?: (input: UiResolveInput) => unknown
    /** Drops one host cache the seat owns; returns whether one was dropped. */
    readonly dropCache?: (event: string) => boolean
    /** The plugin holding a pane id, when it is not this one. */
    readonly ownerOf?: (id: string) => string | undefined
    readonly claim?: (id: string) => void
    readonly release?: (id: string) => void
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
    // The header is the session's own record; a missing cwd is reported as
    // absent, not replaced with the host process's directory.
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
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

// ---- vcs -------------------------------------------------------------------

/** The one system this bridge serves; the pinned `VcsWorkingCopy.vcs` slug is `git`. */
const VCS_GIT = 'git'
/** A hung git must not hold a handler open; the pinned surface carries no timeout of its own. */
const VCS_TIMEOUT_MS = 10_000
/** Beyond this a diff call refuses instead of returning a silently truncated patch. */
const VCS_MAX_BUFFER = 32 * 1024 * 1024
/** The pinned `VcsDiffFile` name bound (`claude-code.d.ts:20244` @ 2.1.329, pin). */
const VCS_MAX_NAME = 4096
/** The empty tree, so a repository with no commit yet can still answer `base: 'head'`. */
const VCS_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/**
 * Every invocation carries these. `--no-optional-locks` is the read-only
 * promise; the two overrides keep a repository-owned fsmonitor hook, and a
 * core.quotepath-quoted name, out of a read. No verbose/network verb is ever
 * assembled, and the argv is fixed here, never taken from the caller.
 */
const VCS_GLOBAL_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
] as const

/**
 * `git` inherits the host environment except every `GIT_*` switch (an
 * inherited `GIT_DIR`/`GIT_WORK_TREE` would redirect the read around the path
 * confinement) and the pager. Optional locks and the terminal prompt stay off
 * even where a repository would set them back.
 */
const vcsEnv = (): Record<string, string> => {
  const copy: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('GIT_') || key === 'PAGER' || key === 'LESS' || key === 'LV') continue
    copy[key] = value
  }
  copy.GIT_OPTIONAL_LOCKS = '0'
  copy.GIT_PAGER = 'cat'
  copy.GIT_TERMINAL_PROMPT = '0'
  return copy
}

interface VcsNumstatFile {
  readonly path: string
  readonly renamedFrom: string | null
  readonly added: number
  readonly removed: number
  readonly isBinary: boolean
}

/**
 * Parses `git diff --numstat -z`: `<added>\t<removed>\t<path>\0`, except a
 * rename, which is `<added>\t<removed>\t\0<old>\0<new>\0`, and a binary,
 * which is `-\t-\t<path>\0`. Paths are root-relative and unquoted.
 */
const parseNumstat = (text: string): VcsNumstatFile[] => {
  const files: VcsNumstatFile[] = []
  const tokens = text.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token === '') continue
    const first = token.indexOf('\t')
    const second = first === -1 ? -1 : token.indexOf('\t', first + 1)
    if (first === -1 || second === -1) continue
    const addedText = token.slice(0, first)
    const removedText = token.slice(first + 1, second)
    let path = token.slice(second + 1)
    let renamedFrom: string | null = null
    if (path === '') {
      renamedFrom = tokens[index + 1] ?? null
      path = tokens[index + 2] ?? ''
      index += 2
    }
    if (path === '') continue
    const isBinary = addedText === '-' || removedText === '-'
    files.push({
      path,
      renamedFrom,
      added: isBinary ? 0 : (Number.parseInt(addedText, 10) || 0),
      removed: isBinary ? 0 : (Number.parseInt(removedText, 10) || 0),
      isBinary,
    })
  }
  return files
}

/** The pinned patch: hunks from the first `@@`, so no file headers and no mode/rename lines. */
const patchBody = (text: string): string => {
  const match = /^@@/m.exec(text)
  return match === null ? '' : text.slice(match.index)
}

/**
 * Query parameters a remote may carry an answer token in. The pin's promise is
 * "credentials stripped", not just `user:password@`, so a token in the query
 * string is removed before the URL is handed to a mod.
 */
const VCS_CREDENTIAL_PARAM =
  /^(?:access[_-]?token|token|password|passwd|secret|client[_-]?secret|api[_-]?key|apikey|key|auth|authorization|signature|sig|credential|credentials|sas|sastoken|googleaccessid|x-goog-signature|x-goog-credential|x-goog-security-token|x-amz-signature|x-amz-credential|x-amz-security-token)$/i

/**
 * The pinned remote is the URL with userinfo, credential-bearing query
 * parameters and a credential-bearing fragment removed. Names are matched
 * after percent-decoding; a fragment is dropped whole when any of its
 * parameters is credential-bearing, because a fragment has no other meaning
 * to a remote.
 */
const withoutCredentials = (url: string): string => {
  const stripped = url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, '$1')
  const hashAt = stripped.indexOf('#')
  let head = hashAt === -1 ? stripped : stripped.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : stripped.slice(hashAt + 1)
  const carriesCredential = (part: string): boolean => {
    let name = part.split('=')[0] ?? ''
    try {
      name = decodeURIComponent(name)
    } catch {
      // Keep the raw name; a malformed escape cannot widen the match.
    }
    return name !== '' && VCS_CREDENTIAL_PARAM.test(name)
  }
  const queryAt = head.indexOf('?')
  if (queryAt !== -1) {
    const base = head.slice(0, queryAt)
    const params = head.slice(queryAt + 1).split('&')
    const kept = params.filter((param) => param === '' || !carriesCredential(param))
    if (kept.length !== params.length) head = kept.length === 0 ? base : `${base}?${kept.join('&')}`
  }
  if (fragment === '' || fragment.split('&').some(carriesCredential)) return head
  return `${head}#${fragment}`
}

/** First two meaningful stderr lines, bounded, so a refusal names git's own words. */
const gitDetail = (stderr: string): string => {
  const detail = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, 2).join('; ')
  return detail.length > 300 ? `${detail.slice(0, 297)}...` : detail
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
    ...(options.ui?.surface === undefined ? {} : { surface: options.ui.surface }),
    ...(options.ui?.render === undefined ? {} : { render: options.ui.render }),
    ...(options.ui?.resolve === undefined ? {} : { resolve: options.ui.resolve }),
    ...(options.ui?.dropCache === undefined ? {} : { dropCache: options.ui.dropCache }),
    ...(options.ui?.ownerOf === undefined ? {} : { ownerOf: options.ui.ownerOf }),
    ...(options.ui?.claim === undefined ? {} : { claim: options.ui.claim }),
    ...(options.ui?.release === undefined ? {} : { release: options.ui.release }),
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

  /**
   * The pinned `$.session.cwd()` reads the session's own directory, never the
   * host process's (`claude-code.d.ts:3339` @ 2.1.329). When no session view is
   * attached, or its header carries no cwd, refuse with the same typed code as
   * `$.session.id()` rather than guessing `process.cwd()`.
   */
  const sessionCwdOf = async (agent: unknown): Promise<string> => {
    const view = sessionOfAgent(agent)
    if (view?.cwd === undefined) {
      fail(
        'ERR_MOD_HOST_SESSION_UNAVAILABLE',
        '$.session.cwd: no session cwd is observable for this invocation; a load-time session.start has no session (D32 §4), and the session header carried none',
      )
    }
    return view.cwd
  }

  /**
   * The directory relative fs paths resolve against: the attached session's
   * cwd when it has one, else the host option, else `process.cwd()`. This stays
   * synchronous for fs/vcs; it is not `$.session.cwd()`, which refuses when no
   * session cwd is observable.
   */
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

  // ---- vcs -----------------------------------------------------------------

  interface GitRun {
    readonly status: number
    readonly stdout: Buffer
    readonly stderr: Buffer
  }

  interface VcsWorkingCopy {
    readonly dir: string
    readonly sessionRoot: string
    readonly cwd: string
    readonly root: string | null
  }

  // A working-copy root `detect` reported through a path inside the session is
  // the one outside-the-session path `diff` may serve: the pinned `diff` graph
  // calls `diff({ path: detect().root })`. Membership is load state, never a
  // caller-supplied allowance.
  const vcsRoots = new Map<string, Set<string>>()

  const runGit = (
    args: readonly string[],
    cwd: string,
    allowExit: readonly number[] = [0],
    configEnv: Readonly<Record<string, string>> = {},
  ): Promise<GitRun> =>
    new Promise<GitRun>((resolveRun, rejectRun) => {
      execFile(
        VCS_GIT,
        [...VCS_GLOBAL_ARGS, ...args],
        {
          cwd,
          env: { ...vcsEnv(), ...configEnv },
          timeout: VCS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: VCS_MAX_BUFFER,
          windowsHide: true,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
          const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '')
          if (error === null) {
            resolveRun({ status: 0, stdout: out, stderr: err })
            return
          }
          const rawCode: unknown = (error as { code?: unknown }).code
          const status = typeof rawCode === 'number' ? rawCode : undefined
          if (status !== undefined && allowExit.includes(status)) {
            resolveRun({ status, stdout: out, stderr: err })
            return
          }
          // Throwing out of this callback would escape the caller's await; a
          // refusal must arrive as the rejected promise the mod can catch.
          try {
            if (status !== undefined) {
              const detail = gitDetail(err.toString('utf8'))
              fail(
                'ERR_MOD_HOST_VCS_FAILED',
                `git ${args[0] ?? '<no verb>'} exited ${status}${detail === '' ? '' : `: ${detail}`}`,
                error,
              )
            }
            if (rawCode === 'ENOENT') {
              fail(
                'ERR_MOD_HOST_VCS_FAILED',
                `cannot run ${VCS_GIT}: no executable was found on PATH (the bridge inherits PATH and never accepts an executable from a caller)`,
              )
            }
            if (rawCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || rawCode === 'ENOBUFS') {
              fail(
                'ERR_MOD_HOST_VCS_FAILED',
                `git ${args[0] ?? '<no verb>'} wrote more than ${VCS_MAX_BUFFER} bytes; the call is refused rather than truncated`,
              )
            }
            if (error.killed === true || (error.signal !== undefined && error.signal !== null)) {
              fail(
                'ERR_MOD_HOST_VCS_FAILED',
                `git ${args[0] ?? '<no verb>'} did not finish within ${VCS_TIMEOUT_MS} ms and was killed`,
              )
            }
            fail('ERR_MOD_HOST_VCS_FAILED', `git ${args[0] ?? '<no verb>'} could not run: ${messageOf(error)}`, error)
          } catch (refusal) {
            rejectRun(refusal)
          }
        },
      )
    })

  const gitValue = async (args: readonly string[], cwd: string): Promise<string | undefined> => {
    const run = await runGit(args, cwd, [0, 1])
    if (run.status !== 0) return undefined
    const text = run.stdout.toString('utf8').trim()
    return text === '' ? undefined : text
  }

  // A repository can configure `filter.<driver>.clean`/`.process` and select
  // it from `.gitattributes`; git would then run that command while diffing
  // the worktree, even with external diff and textconv off. Every driver key
  // found in any config scope is neutralised with an empty value on each
  // worktree-touching invocation. The overrides travel through the
  // environment rather than `-c`: git splits `-c key=value` at the first `=`,
  // so a key such as `filter.a=b.clean` cannot be addressed as `-c` at all.
  // `GIT_CONFIG_KEY_n`/`VALUE_n` carry key and value separately. Enumerating
  // keys is a read; the git process that does it runs no filter.
  const vcsFilterEnv = async (cwd: string): Promise<Record<string, string>> => {
    const run = await runGit(['config', '--name-only', '-z', '--get-regexp', '^filter\\.'], cwd, [0, 1])
    if (run.status !== 0) return {}
    const keys = run.stdout
      .toString('utf8')
      .split('\0')
      .filter((key) => key !== '')
    if (keys.length === 0) return {}
    const overrides: Record<string, string> = { GIT_CONFIG_COUNT: String(keys.length) }
    keys.forEach((key, index) => {
      overrides[`GIT_CONFIG_KEY_${index}`] = key
      overrides[`GIT_CONFIG_VALUE_${index}`] = ''
    })
    return overrides
  }

  const vcsText = (site: string, value: unknown, field: string): string => {
    if (typeof value !== 'string' || value === '' || value.includes('\0')) {
      fail('ERR_MOD_HOST_VCS_INVALID', `${site}: ${field} must be a non-empty string without NUL, got ${describeValue(value)}`)
    }
    return value
  }

  const vcsRecord = (site: string, input: unknown): Record<string, unknown> => {
    if (!isRecord(input)) fail('ERR_MOD_HOST_VCS_INVALID', `${site}: input must be an object, got ${describeValue(input)}`)
    return input
  }

  /**
   * Resolves the pinned `path` input to a real folder and confines it to the
   * session working directory. Every refusal here happens before a process is
   * spawned; the recorded roots are the roots a previous `detect`/`diff`
   * reported from a path that was inside the session.
   */
  const vcsDirOf = (agent: unknown, value: unknown, site: string): { dir: string; sessionRoot: string } => {
    if (typeof value !== 'string' || value === '' || value.includes('\0')) {
      fail('ERR_MOD_HOST_VCS_INVALID', `${site}: path must be a non-empty string without NUL, got ${describeValue(value)}`)
    }
    let sessionRoot: string
    try {
      sessionRoot = realpathSync(resolve(sessionCwd(agent)))
    } catch (error) {
      const code = codeOf(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        fail('ERR_MOD_HOST_PATH_MISSING', `${site}: the session working directory cannot be resolved: ${messageOf(error)}`, error)
      }
      fail('ERR_MOD_HOST_FS', `${site}: the session working directory cannot be resolved: ${messageOf(error)}`, error)
    }
    const lexical = isAbsolute(value) ? resolve(value) : resolve(sessionRoot, value)
    let dir: string
    try {
      dir = realpathSync(lexical)
    } catch (error) {
      const code = codeOf(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        fail('ERR_MOD_HOST_PATH_MISSING', `${site}: ${JSON.stringify(value)} does not exist`, error)
      }
      fail('ERR_MOD_HOST_FS', `${site}: ${JSON.stringify(value)} cannot be resolved: ${messageOf(error)}`, error)
    }
    let isDirectory = false
    try {
      isDirectory = statSync(dir).isDirectory()
    } catch (error) {
      fail('ERR_MOD_HOST_FS', `${site}: ${JSON.stringify(value)} cannot be inspected: ${messageOf(error)}`, error)
    }
    if (!isDirectory) {
      fail('ERR_MOD_HOST_VCS_INVALID', `${site}: ${JSON.stringify(value)} is not a folder; the pinned input is the folder to inspect`)
    }
    const recorded = vcsRoots.get(sessionRoot)
    if (!isWithin(sessionRoot, dir) && !(recorded?.has(dir) ?? false)) {
      fail(
        'ERR_MOD_HOST_PATH_OUTSIDE',
        `${site}: ${JSON.stringify(value)} resolves to ${dir}, outside the session working directory ${sessionRoot}; a working-copy root detect already reported is the one exception`,
      )
    }
    return { dir, sessionRoot }
  }

  const vcsWorkingCopyOf = async (agent: unknown, value: unknown, site: string): Promise<VcsWorkingCopy> => {
    const { dir, sessionRoot } = vcsDirOf(agent, value, site)
    // git runs inside the session directory even when `value` is a recorded
    // root above it; discovery still finds that root. No caller path becomes a
    // child-process cwd outside the session.
    const cwd = isWithin(sessionRoot, dir) ? dir : sessionRoot
    const run = await runGit(['rev-parse', '--show-toplevel'], cwd, [0, 128])
    if (run.status !== 0) {
      const stderr = run.stderr.toString('utf8')
      if (/not a git repository|not a working tree|must be run in a work tree/i.test(stderr)) {
        return { dir, sessionRoot, cwd, root: null }
      }
      fail('ERR_MOD_HOST_VCS_FAILED', `${site}: git rev-parse --show-toplevel exited ${run.status}: ${gitDetail(stderr)}`)
    }
    const reported = run.stdout.toString('utf8').trim()
    if (reported === '') fail('ERR_MOD_HOST_VCS_FAILED', `${site}: git rev-parse --show-toplevel reported no folder`)
    let root: string
    try {
      root = realpathSync(reported)
    } catch (error) {
      fail(
        'ERR_MOD_HOST_VCS_FAILED',
        `${site}: git reported the working-copy root ${JSON.stringify(reported)}, which cannot be resolved: ${messageOf(error)}`,
        error,
      )
    }
    if (!isWithin(root, dir)) {
      fail('ERR_MOD_HOST_VCS_FAILED', `${site}: git reported ${root} as the working-copy root, but ${dir} is not inside it`)
    }
    const recorded = vcsRoots.get(sessionRoot) ?? new Set<string>()
    recorded.add(root)
    vcsRoots.set(sessionRoot, recorded)
    return { dir, sessionRoot, cwd, root }
  }

  const vcsDefaultBranchOf = async (cwd: string): Promise<{ name: string; ref: string } | null> => {
    const ref = await gitValue(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd)
    if (ref === undefined || !ref.startsWith('refs/remotes/origin/')) return null
    const name = ref.slice('refs/remotes/origin/'.length)
    if (name === '' || name === 'HEAD') return null
    const commit = await gitValue(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)
    return commit === undefined ? null : { name, ref }
  }

  const vcsDetect = async (agent: unknown, input: unknown): Promise<unknown> => {
    const record = vcsRecord('$.vcs.detect', input)
    const copy = await vcsWorkingCopyOf(agent, record.path, '$.vcs.detect')
    if (copy.root === null) return null
    const cwd = copy.cwd
    const [gitDirText, commonDirText, revision, branch, defaultRef, remote] = await Promise.all([
      gitValue(['rev-parse', '--absolute-git-dir'], cwd),
      gitValue(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd),
      gitValue(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd),
      gitValue(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd),
      gitValue(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd),
      gitValue(['config', '--get', 'remote.origin.url'], cwd),
    ])
    if (gitDirText === undefined || commonDirText === undefined) {
      fail('ERR_MOD_HOST_VCS_FAILED', '$.vcs.detect: git did not report the git directory')
    }
    const realpathOfVcs = (value: string, what: string): string => {
      try {
        return realpathSync(value)
      } catch (error) {
        fail(
          'ERR_MOD_HOST_VCS_FAILED',
          `$.vcs.detect: git reported the ${what} ${JSON.stringify(value)}, which cannot be resolved: ${messageOf(error)}`,
          error,
        )
      }
    }
    const gitDir = realpathOfVcs(gitDirText, 'git directory')
    const commonDir = realpathOfVcs(commonDirText, 'common git directory')
    // A linked worktree: the shared `.git` sits in the main working copy, so
    // its parent is `mainRoot`. A bare main repository has no main working
    // copy, and the pin says null where it is not known. A submodule checkout
    // is its own repository, but the superproject is the working copy that
    // registered it; this host does not inspect that parent, so it reports
    // null rather than claiming the submodule root is the main copy.
    const superproject = await gitValue(['rev-parse', '--show-superproject-working-tree'], cwd)
    const mainRoot =
      superproject !== undefined
        ? null
        : gitDir === commonDir
          ? copy.root
          : basename(commonDir) === '.git'
            ? dirname(commonDir)
            : null
    let defaultBranch: string | null = null
    if (defaultRef !== undefined && defaultRef.startsWith('refs/remotes/origin/')) {
      const candidate = defaultRef.slice('refs/remotes/origin/'.length)
      if (candidate !== '' && candidate !== 'HEAD') {
        const commit = await gitValue(['rev-parse', '--verify', '--quiet', `${defaultRef}^{commit}`], cwd)
        if (commit !== undefined) defaultBranch = candidate
      }
    }
    return {
      vcs: VCS_GIT,
      root: copy.root,
      mainRoot,
      revision: revision ?? null,
      branch: branch ?? null,
      defaultBranch,
      remote: remote === undefined ? null : withoutCredentials(remote),
    }
  }

  const vcsMatches = (path: string, renamedFrom: string | null, filter: readonly string[] | undefined): boolean => {
    if (filter === undefined) return true
    return filter.some((wanted) =>
      wanted === '' ||
      path === wanted ||
      renamedFrom === wanted ||
      path.startsWith(`${wanted}/`) ||
      (renamedFrom !== null && renamedFrom.startsWith(`${wanted}/`)),
    )
  }

  const vcsPathFilter = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) {
      fail('ERR_MOD_HOST_VCS_INVALID', `$.vcs.diff: paths must be an array, got ${describeValue(value)}`)
    }
    const filter: string[] = []
    for (const entry of value) {
      const text = vcsText('$.vcs.diff', entry, 'paths[]')
      if (text.length > VCS_MAX_NAME) {
        fail(
          'ERR_MOD_HOST_VCS_INVALID',
          `$.vcs.diff: a paths[] entry is ${text.length} characters, over the pin's ${VCS_MAX_NAME}-character name bound`,
        )
      }
      if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\')) {
        fail('ERR_MOD_HOST_VCS_INVALID', `$.vcs.diff: paths must be relative to the working-copy root, got ${JSON.stringify(text)}`)
      }
      const normalized = posix.normalize(text)
      if (normalized === '..' || normalized.startsWith('../')) {
        fail('ERR_MOD_HOST_VCS_INVALID', `$.vcs.diff: ${JSON.stringify(text)} leaves the working-copy root`)
      }
      const clean = normalized === '.' ? '' : normalized.replace(/\/+$/, '')
      if (!filter.includes(clean)) filter.push(clean)
    }
    return filter
  }

  const vcsUntrackedFile = async (
    root: string,
    cwd: string,
    path: string,
    isStatOnly: boolean,
    configEnv: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown>> => {
    const row: Record<string, unknown> = {
      path,
      renamedFrom: null,
      added: 0,
      removed: 0,
      isBinary: false,
      isUntracked: true,
    }
    let stats
    try {
      stats = lstatSync(join(root, path))
    } catch (error) {
      reportOnce(
        `vcs.untracked.${path}`,
        `$.vcs.diff: untracked ${JSON.stringify(path)} could not be inspected: ${messageOf(error)}; it is listed without a patch`,
      )
      return row
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      // A symlink, FIFO or socket has no bytes this host reads; git would
      // track a symlink by target, but the pinned patch is file content.
      return row
    }
    const absolute = join(root, path)
    if (isStatOnly) {
      const run = await runGit(
        ['diff', '--no-index', '--numstat', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '--', '/dev/null', absolute],
        cwd,
        [0, 1],
        configEnv,
      )
      const parsed = parseNumstat(run.stdout.toString('utf8'))[0]
      if (parsed !== undefined) {
        row.added = parsed.added
        row.removed = parsed.removed
        row.isBinary = parsed.isBinary
      }
      return row
    }
    const run = await runGit(
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', '/dev/null', absolute],
      cwd,
      [0, 1],
      configEnv,
    )
    const text = run.stdout.toString('utf8')
    if (/^Binary files /m.test(text)) {
      row.isBinary = true
      return row
    }
    const body = patchBody(text)
    if (body !== '') {
      row.added = body.split('\n').filter((line) => line.startsWith('+')).length
      row.patch = body
    }
    return row
  }

  const vcsDiff = async (agent: unknown, input: unknown): Promise<unknown> => {
    const record = vcsRecord('$.vcs.diff', input)
    const pathValue = vcsText('$.vcs.diff', record.path, 'path')
    const vcs = vcsText('$.vcs.diff', record.vcs, 'vcs')
    const base = record.base
    if (base !== 'head' && base !== 'default') {
      fail('ERR_MOD_HOST_VCS_INVALID', `$.vcs.diff: base must be "head" or "default", got ${describeValue(base)}`)
    }
    const filter = vcsPathFilter(record.paths)
    if (record.isStatOnly !== undefined && typeof record.isStatOnly !== 'boolean') {
      fail('ERR_MOD_HOST_VCS_INVALID', `$.vcs.diff: isStatOnly must be a boolean, got ${describeValue(record.isStatOnly)}`)
    }
    const isStatOnly = record.isStatOnly === true
    const copy = await vcsWorkingCopyOf(agent, pathValue, '$.vcs.diff')
    if (copy.root === null) {
      // The pin's diff result has an `unknown` arm exactly for "no hook can
      // say", and `detect` answers null here: return the arm, do not throw.
      return {
        unknown: `$.vcs.diff: ${JSON.stringify(pathValue)} is not in a working copy, so there is nothing to diff; $.vcs.detect answers null here`,
      }
    }
    const root: string = copy.root
    if (vcs !== VCS_GIT) {
      return {
        unknown: `$.vcs.diff: this host serves ${VCS_GIT}; ${JSON.stringify(vcs)} has no bridge at the 2.1.329 pin`,
      }
    }
    const cwd = copy.cwd
    const configEnv = await vcsFilterEnv(cwd)
    const revision = await gitValue(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd)
    let treeish: string
    let baseLabel: string
    if (base === 'head') {
      // What is checked out; an unborn branch diffs against the empty tree,
      // which is a read, not a `git commit`.
      treeish = revision ?? VCS_EMPTY_TREE
      baseLabel = 'HEAD'
    } else {
      const defaultBranch = await vcsDefaultBranchOf(cwd)
      if (defaultBranch === null) {
        return {
          unknown: `$.vcs.diff: ${JSON.stringify(pathValue)} has no default branch (refs/remotes/origin/HEAD is absent), so base "default" cannot be answered`,
        }
      }
      if (revision === undefined) {
        return {
          unknown: `$.vcs.diff: ${JSON.stringify(pathValue)} has no commit checked out, so base "default" cannot be answered`,
        }
      }
      const merge = await runGit(['merge-base', revision, defaultBranch.ref], cwd, [0, 1])
      if (merge.status !== 0) {
        return { unknown: `$.vcs.diff: ${defaultBranch.name} and HEAD share no merge base` }
      }
      treeish = merge.stdout.toString('utf8').trim()
      baseLabel = defaultBranch.name
    }
    if (treeish === '') fail('ERR_MOD_HOST_VCS_FAILED', '$.vcs.diff: git reported an empty base commit')
    if (filter !== undefined && filter.length === 0) return { base: baseLabel, files: [] }

    const statRun = await runGit(
      ['diff', '-M', '--numstat', '-z', '--no-color', '--no-ext-diff', '--no-textconv', treeish, '--'],
      cwd,
      [0],
      configEnv,
    )
    const tracked = parseNumstat(statRun.stdout.toString('utf8'))
    // Untracked files never appear in `git diff`; `-- :/` makes the listing
    // repo-wide even when the child cwd is a subdirectory.
    const untrackedRun = await runGit(
      ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/'],
      cwd,
      [0],
      configEnv,
    )
    const untracked = untrackedRun.stdout.toString('utf8').split('\0').filter((entry) => entry !== '')
    const files: Array<Record<string, unknown>> = []
    for (const change of tracked) {
      if (!vcsMatches(change.path, change.renamedFrom, filter)) continue
      files.push({
        path: change.path,
        renamedFrom: change.renamedFrom,
        added: change.added,
        removed: change.removed,
        isBinary: change.isBinary,
        isUntracked: false,
      })
    }
    for (const path of untracked) {
      if (!vcsMatches(path, null, filter)) continue
      files.push(await vcsUntrackedFile(root, cwd, path, isStatOnly, configEnv))
    }
    for (const file of files) {
      const name = String(file.path)
      const previous = typeof file.renamedFrom === 'string' ? file.renamedFrom : null
      if (name.length > VCS_MAX_NAME || (previous !== null && previous.length > VCS_MAX_NAME)) {
        fail(
          'ERR_MOD_HOST_VCS_FAILED',
          `$.vcs.diff: git reported a name longer than the pin's ${VCS_MAX_NAME}-character bound; the result would not match the pinned shape, so the call is refused`,
        )
      }
    }
    files.sort((left, right) => {
      const a = String(left.path)
      const b = String(right.path)
      return a < b ? -1 : a > b ? 1 : 0
    })
    if (!isStatOnly) {
      for (const file of files) {
        if (file.isUntracked === true || file.isBinary === true) continue
        const added = typeof file.added === 'number' ? file.added : 0
        const removed = typeof file.removed === 'number' ? file.removed : 0
        if (added + removed === 0) continue
        const path = String(file.path)
        const renamedFrom = typeof file.renamedFrom === 'string' ? file.renamedFrom : null
        // Both names keep a rename a rename; a one-sided pathspec makes git
        // print an add and a delete instead.
        const spec = ['--', `:(top,literal)${path}`]
        if (renamedFrom !== null && renamedFrom !== path) spec.push(`:(top,literal)${renamedFrom}`)
        const patchRun = await runGit(
          ['diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv', treeish, ...spec],
          cwd,
          [0],
          configEnv,
        )
        const body = patchBody(patchRun.stdout.toString('utf8'))
        if (body !== '') file.patch = body
      }
    }
    return { base: baseLabel, files }
  }

  // These four are pinned members this host does not implement: the engine
  // owns worktree bookkeeping (create/list/remove) and a trust record, and
  // this host keeps neither. A typed refusal says so; it is never `undefined`
  // and never a fabricated `{ deny }`/`{ kept }`/`[]` that claims state.
  const vcsIsolate = async (): Promise<never> =>
    fail(
      'ERR_MOD_HOST_VCS_UNSUPPORTED',
      '$.vcs.isolate: the host creates no worktree or copy on a mod call (the pinned engine answers { deny } when it makes none: for a Git worktree, spawn an agent with `isolation: "worktree"`); this host owns no copy bookkeeping, so the call is refused at the 2.1.329 pin (D40)',
    )
  const vcsList = async (): Promise<never> =>
    fail(
      'ERR_MOD_HOST_VCS_UNSUPPORTED',
      '$.vcs.list: the pinned engine lists Git worktrees only for a repository the person trusted; this host keeps no trust record or worktree directory, so it refuses instead of inventing a list',
    )
  const vcsStatus = async (): Promise<never> =>
    fail(
      'ERR_MOD_HOST_VCS_UNSUPPORTED',
      '$.vcs.status: the pinned engine answers only for a copy it made for an agent of this process; this host makes no copies, so it refuses instead of an `{ unknown }` it cannot back',
    )
  const vcsRelease = async (): Promise<never> =>
    fail(
      'ERR_MOD_HOST_VCS_UNSUPPORTED',
      '$.vcs.release: the pinned engine removes nothing on this call and answers `{ kept }` for a copy it owns; this host owns no copy, so it refuses with a named reason instead of claiming one was kept',
    )

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
        cwd: () => sessionCwdOf(agent),
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
      vcs: {
        detect: (input: unknown): Promise<unknown> => vcsDetect(agent, input),
        diff: (input: unknown): Promise<unknown> => vcsDiff(agent, input),
        isolate: (): Promise<never> => vcsIsolate(),
        list: (): Promise<never> => vcsList(),
        status: (): Promise<never> => vcsStatus(),
        release: (): Promise<never> => vcsRelease(),
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
