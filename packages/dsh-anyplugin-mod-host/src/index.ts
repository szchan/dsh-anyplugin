/**
 * dsh-anyplugin-mod-host — the host skeleton from D30 (S13 follow-up).
 *
 * One call to `loadMod()`:
 *
 * 1. resolves the entry under `root` and refuses anything that leaves it;
 * 2. creates a fresh `node:vm` context per mod (no `process`, no `URL`, no `$`;
 *    a `.tsx` realm also gets the classic `h`/`Fragment` globals, D34);
 * 3. creates every reachable module, applies the narrow classic JSX transform
 *    to `.tsx` (classic pragma required), strips types in memory, links once,
 *    evaluates once (D30/D34's create → transform → link → evaluate);
 * 4. calls the authored `register(on, options)` with a controlled `on()` and the
 *    `PluginOptions` its manifest declares, and returns the registrations in
 *    source order.
 *
 * `on(event, hook)` returns the pinned `Registration`: a frozen object whose
 * one member is `.catch(handler)`. A registration without `.catch` behaves as
 * before. With one, a throw from the authored hook is passed to the catch
 * handler as `HookFailure` (`kind: 'throw'`, the authored message, the pin's
 * 1s `catchMs` grace) together with a replay-safe `next`: `next.called` says
 * whether the hook called beneath it, and `next(e)` replays the last call
 * instead of running the hooks beneath again. A second `.catch`, a `.catch`
 * after `register(on)` returned, and `.catch` on `engine.create` are refused
 * with `ERR_MOD_HOST_REGISTRATION`; the host never leaves an undefined member
 * for the mod's first call to trip over.
 *
 * `PluginOptions` is built from the two facts the pin names: the plugin
 * manifest's `userConfig` (at `<root>/.claude-plugin/plugin.json`, or at the
 * parent when `root` is the plugin's `hooks/` directory) and the activation's
 * stored values. Fields the manifest declares are served with the pinned
 * value union; a malformed or unservable declaration is refused with
 * `ERR_MOD_HOST_OPTIONS`, naming the field. A module with no manifest declared
 * no fields, so its options are an empty frozen record — not a `{}` stub.
 *
 * A registration's handler is wrapped by the host: the returned wrapper is
 * `handler(event, next)`, and immediately before each invocation the host calls
 * `host.dollar()` exactly once and passes the result to the authored
 * `handler($, event, next)` as its first argument. A caught invocation calls
 * `host.dollar()` once more for the catch handler, because the pin gives it a
 * `$` of its own. The host never caches, clones or freezes that namespace:
 * `ModHost.dollar()` must return the namespace for that one invocation. If a
 * host returns the same object for two calls, it has reused it — a `ModHost`
 * bug, not host-side freshness. `$` is never a global, so module-level code
 * that reads it fails with the realm's own `ReferenceError`; the host does not
 * wrap authored errors.
 *
 * The pinned `PluginOptions` has no plugin-root or data-dir member, so the
 * host does not add one: those stay host facts (`root` and the bridge's data
 * dir), traced to D30 and the bridge rather than invented in this object.
 *
 * This is not a security boundary (D6/D30): it isolates the tested global
 * surface, not timers, promises, memory or permissions. It is also not the
 * element runtime or the bridges — `$` is whatever the caller supplies, and
 * the `.tsx` realm's `h`/`Fragment` only build descriptors; nothing renders
 * (D34).
 */
import { readFileSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as vm from 'node:vm'

import { ModHostError, codeOf, describeValue, messageOf } from './errors.ts'
import { jsxRealmGlobals, transformTsx } from './jsx.ts'
import { resolvePluginOptions } from './options.ts'
import { isWithin, resolveModSpecifier, resolveSnapshotSpecifier } from './resolve.ts'

export { ModHostError, type ModHostErrorCode } from './errors.ts'
export {
  PLUGIN_MANIFEST_PATH,
  resolvePluginOptions,
  type PluginOptionValue,
  type PluginOptions,
  type ResolvePluginOptionsInput,
  type ResolvedPluginOptions,
} from './options.ts'
export {
  commandRegistryFromContext,
  createModBridge,
  ModBridgeError,
  sessionViewOf,
  type ModBridge,
  type ModBridgeCommandDefinition,
  type ModBridgeCommandRegistry,
  type ModBridgeErrorCode,
  type ModBridgeOptions,
  type ModBridgeSession,
  type ModBridgeTelemetryRecord,
} from './bridge.ts'
export {
  createUiSink,
  elementsForSurface,
  uiEventPatternMatches,
  uiRenderMatcherMatches,
  validateUiTree,
  UI_COMPONENTS,
  UI_ENGINE_NODE,
  UI_SURFACES,
  type ModUiSink,
  type UiComponent,
  type UiElementConstructor,
  type UiElementTable,
  type UiLogRecord,
  type UiPaneSnapshot,
  type UiRenderRequest,
  type UiRenderViewport,
  type UiResolveInput,
  type UiSinkOptions,
  type UiSinkSnapshot,
  type UiSurface,
  type UiTreeValidation,
} from './ui.ts'
export {
  resolveModSpecifier,
  resolveSnapshotSpecifier,
  type ModResolutionBehavior,
  type ResolveModSpecifierOptions,
  type ResolveSnapshotSpecifierOptions,
  type ResolvedModSpecifier,
} from './resolve.ts'

/** What a mod sees as `$`: host-supplied, per handler invocation. */
export type ModDollar = Record<string, unknown>

/** The continuation the host passes to a handler alongside `$`. */
export type ModNext = (event?: unknown) => unknown

export interface ModHost {
  /**
   * Return the namespace for one handler invocation. Called exactly once,
   * immediately before each invocation; the host never caches the result,
   * never clones it and never freezes it. Returning the same object for two
   * calls reuses a namespace — a `ModHost` bug, not a guarantee of freshness.
   */
  dollar(): ModDollar | Promise<ModDollar>
}

export interface ModRegistration {
  /** The authored event name, unchanged. */
  readonly event: string
  /** The authored matcher value, unchanged (`undefined` for a bare `on`). */
  readonly matcher: unknown
  /**
   * The host wrapper `handler(event, next)`. It calls `host.dollar()` exactly
   * once per invocation and invokes the authored `handler($, event, next)`.
   * When the authored registration has a `.catch`, a hook failure is routed
   * to it instead of rejecting this wrapper.
   */
  readonly handler: (event: unknown, next: ModNext) => unknown
}

/**
 * The pinned `Registration<F>` surface this host serves: one `.catch`, during
 * `register`, on declarations other than `engine.create` (claude-code.d.ts
 * line 7480). It is frozen, so a later write does not replace the member the
 * host armed.
 */
export interface RegistrationHandle {
  catch(handler: (dollar: unknown, event: unknown, next: ModNext) => unknown): void
}

export interface LoadedMod {
  /** What `register(on)` declared, in source order. */
  readonly registrations: readonly ModRegistration[]
  /**
   * Resolves when the (already performed) evaluation settles; it never
   * re-evaluates the mod. After `dispose()` it rejects with
   * `ERR_MOD_HOST_LINK` (reason: the mod was disposed).
   */
  evaluate(): Promise<unknown>
  /** Make the realm inert: handlers and `evaluate()` refuse from now on. */
  dispose(): void
}

export interface LoadModOptions {
  /** The mod's root directory; every resolved module must stay inside it. */
  readonly root: string
  /** The entry file, relative to `root` (typically `register.ts`). */
  readonly entry: string
  /** Supplies `$` per handler invocation. */
  readonly host: ModHost
  /**
   * The plugin directory carrying `.claude-plugin/plugin.json`, when the
   * caller knows it. Omitted, the host proves it at `root` or at the parent
   * of `root` (the pinned complete plugins keep their manifest one level above
   * `hooks/`). It is not an option member: `PluginOptions` in the pin has no
   * plugin-root field.
   */
  readonly pluginRoot?: string
  /**
   * The activation's stored option values (settings.json
   * `pluginConfigs[<plugin>].options`). Omitted, only manifest defaults
   * apply. Values for fields the manifest does not declare are ignored, as
   * the pin stores them for the loader but does not pass them through.
   */
  readonly pluginOptions?: Readonly<Record<string, unknown>>
  /**
   * Every plugin-relative path the grant pinned (D51). When present, the entry
   * and every module the linker resolves must be in the set; anything else
   * refuses with `ERR_MOD_HOST_UNGRANTED` before it is created. A mod may
   * import any file under its root, so the set — not the import graph — is the
   * boundary. Omitted only when a caller has already proven the bytes (the
   * host tests).
   */
  readonly files?: readonly string[]
  /**
   * The pinned bytes themselves, keyed by plugin-relative path (D51, M1).
   * When present, `loadMod` compiles from this map and never opens a path
   * under `root`: the digest the grant pinned and the code that evaluates are
   * one snapshot, so rewriting a file between the scan and the link cannot
   * change what runs. `files` then defaults to the map's keys.
   */
  readonly sources?: ReadonlyMap<string, Uint8Array | string>
}

/** Plugin-relative POSIX path, the form a tree manifest stores (D51). */
function relativePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}

type Registration = {
  readonly event: string
  readonly matcher: unknown
  readonly handler: (dollar: unknown, event: unknown, next: ModNext) => unknown
  /** The one `.catch` the pinned Registration accepts, when authored. */
  caughtBy: ((dollar: unknown, event: unknown, next: ModNext) => unknown) | undefined
}

/** The pinned `HookFailure` shape this host produces (claude-code.d.ts 4305). */
interface HookFailure {
  readonly kind: 'throw'
  readonly message?: string
  readonly budget: number
}

/** `HookBudget.catchMs` in the pinned claude-code.d.ts (line 4269). */
const CATCH_GRACE_MS = 1_000

interface NextState {
  called: boolean
  last: Promise<unknown> | undefined
}

/** Function members the tracked continuation owns; they are not copied. */
const NEXT_HOST_KEYS = new Set([
  'length',
  'name',
  'prototype',
  'arguments',
  'caller',
  'called',
  'error',
])

/**
 * Carry the pinned `Next` surface (`to`, `origin`, `trace`, `budget`, ...)
 * from the host's continuation onto the tracking wrapper, so a catch handler
 * sees the same members the hook did. The property descriptors are copied, not
 * the values, because some are accessors.
 */
function copyNextSurface(target: ModNext, source: ModNext): void {
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === 'string' && NEXT_HOST_KEYS.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) continue
    try {
      Object.defineProperty(target, key, descriptor)
    } catch {
      // A non-configurable authored property the wrapper cannot carry stays
      // on the original; the pinned members are data and are copied.
    }
  }
}

function makeTrackedNext(source: ModNext, state: NextState, replay: boolean): ModNext {
  const invoke = (event?: unknown): unknown => {
    state.called = true
    let result: unknown
    try {
      result = source(event)
    } catch (error) {
      const failed = Promise.reject(error)
      // The value is replayed only if the catch handler asks; keep an unused
      // sync failure from becoming an unhandled rejection in the meantime.
      failed.catch(() => undefined)
      state.last = failed
      throw error
    }
    state.last = Promise.resolve(result)
    return result
  }
  const tracked = ((event?: unknown): unknown => {
    if (replay && state.called) return state.last
    return invoke(event)
  }) as ModNext
  copyNextSurface(tracked, source)
  return tracked
}

/** The pinned `N & Caught`: replay-safe `next`, `called`, and `error`. */
function makeCaughtNext(source: ModNext, state: NextState, failure: HookFailure): ModNext {
  const tracked = makeTrackedNext(source, state, true)
  // `called` describes the failed hook's invocation of `next`; it is fixed at
  // the moment the catch handler is built, like the pin's readonly field.
  Object.defineProperty(tracked, 'called', {
    value: state.called,
    enumerable: true,
  })
  Object.defineProperty(tracked, 'error', {
    value: failure,
    enumerable: true,
  })
  return tracked
}

function hookFailure(error: unknown): HookFailure {
  return Object.freeze({
    kind: 'throw' as const,
    message: messageOf(error),
    budget: CATCH_GRACE_MS,
  })
}

/**
 * Load one authored mod, evaluate it once and return its registrations.
 *
 * Host-surface failures reject with `ModHostError`; errors raised by the
 * authored code itself (a module-level `$`, a throw from `register`, a
 * rejection from a handler) pass through unchanged.
 */
export async function loadMod(options: LoadModOptions): Promise<LoadedMod> {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      'node:vm SourceTextModule is unavailable; run Node with --experimental-vm-modules (D30)',
    )
  }
  if (options === null || typeof options !== 'object') {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'loadMod() requires a { root, entry, host } object')
  }
  if (typeof options.root !== 'string' || options.root.length === 0) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'root must be a non-empty path')
  }

  const root = resolve(options.root)
  const sources = options.sources
  if (sources === undefined) {
    let rootStat
    try {
      rootStat = statSync(root)
    } catch (cause) {
      throw new ModHostError('ERR_MOD_HOST_MISSING', 'mod root does not exist', { file: root, cause })
    }
    if (!rootStat.isDirectory()) {
      throw new ModHostError('ERR_MOD_HOST_MISSING', 'mod root is not a directory', { file: root })
    }
  }

  if (typeof options.entry !== 'string' || options.entry.length === 0) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'entry must be a non-empty path relative to the mod root')
  }
  if (isAbsolute(options.entry)) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'entry must be relative to the mod root', {
      file: options.entry,
    })
  }
  const entryFile = resolve(root, options.entry)
  if (!isWithin(root, entryFile)) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'entry resolves outside the mod root', {
      file: entryFile,
    })
  }
  if (sources === undefined) {
    let entryStat
    try {
      entryStat = statSync(entryFile)
    } catch (cause) {
      throw new ModHostError('ERR_MOD_HOST_MISSING', 'entry does not exist', { file: entryFile, cause })
    }
    if (!entryStat.isFile()) {
      throw new ModHostError('ERR_MOD_HOST_MISSING', 'entry is not a file', { file: entryFile })
    }
  }

  // Manifest paths are already plugin-relative (D51); an absolute path is
  // accepted for a caller holding one and normalized against the same root.
  const granted =
    sources !== undefined
      ? new Set(
          options.files === undefined
            ? [...sources.keys()]
            : options.files.map((file) => (isAbsolute(file) ? relativePath(root, file) : file.split(sep).join('/'))),
        )
      : options.files === undefined
        ? undefined
        : new Set(options.files.map((file) => (isAbsolute(file) ? relativePath(root, file) : file.split(sep).join('/'))))
  const entryPath = relativePath(root, entryFile)
  if (granted !== undefined && !granted.has(entryPath)) {
    throw new ModHostError(
      'ERR_MOD_HOST_UNGRANTED',
      `the entry "${entryPath}" is not in the granted file set; a mod runs only files the grant pinned`,
      { file: entryFile },
    )
  }

  const host = options.host
  if (host === null || typeof host !== 'object' || typeof host.dollar !== 'function') {
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      'host.dollar must be a function; it supplies $ for one handler invocation',
    )
  }

  // The pin validates a plugin's options before its module loads, so resolve
  // them before creating the realm: a refusal must not run authored code.
  const plugin = resolvePluginOptions({
    root,
    ...(options.pluginRoot === undefined ? {} : { pluginRoot: options.pluginRoot }),
    ...(options.pluginOptions === undefined ? {} : { values: options.pluginOptions }),
  })

  const context = vm.createContext(jsxRealmGlobals())
  const modules = new Map<string, vm.SourceTextModule>()
  let disposed = false

  function assertLive(): void {
    if (disposed) {
      throw new ModHostError('ERR_MOD_HOST_LINK', 'the mod was disposed; it must not run again')
    }
  }

  function createModule(file: string): vm.SourceTextModule {
    const cached = modules.get(file)
    if (cached !== undefined) return cached

    const extension = extname(file)
    if (extension !== '.ts' && extension !== '.tsx' && extension !== '.js' && extension !== '.mjs') {
      throw new ModHostError(
        'ERR_MOD_HOST_UNSUPPORTED_EXT',
        `cannot load '${extension === '' ? '(no extension)' : extension}': D30/D34 permits .ts (type-stripped), .tsx (classic JSX transform then type strip), .js and .mjs only`,
        { file },
      )
    }

    let source: string
    if (sources === undefined) {
      try {
        source = readFileSync(file, 'utf8')
      } catch (cause) {
        throw new ModHostError(
          codeOf(cause) === 'ENOENT' ? 'ERR_MOD_HOST_MISSING' : 'ERR_MOD_HOST_LINK',
          `cannot read module: ${messageOf(cause)}`,
          { file, cause },
        )
      }
    } else {
      const pinned = sources.get(relativePath(root, file))
      if (pinned === undefined) {
        throw new ModHostError(
          'ERR_MOD_HOST_UNGRANTED',
          `"${relativePath(root, file)}" is not in the granted snapshot`,
          { file },
        )
      }
      source = typeof pinned === 'string' ? pinned : Buffer.from(pinned).toString('utf8')
    }

    let code = source
    if (extension === '.tsx') {
      code = transformTsx(source, file)
    }
    if (extension === '.ts' || extension === '.tsx') {
      try {
        code = stripTypeScriptTypes(code, { mode: 'strip' })
      } catch (cause) {
        throw new ModHostError('ERR_MOD_HOST_LINK', `type stripping failed: ${messageOf(cause)}`, {
          file,
          cause,
        })
      }
    }

    let module: vm.SourceTextModule
    try {
      module = new vm.SourceTextModule(code, {
        identifier: pathToFileURL(file).href,
        context,
      })
    } catch (cause) {
      throw new ModHostError('ERR_MOD_HOST_LINK', `not loadable as an ES module: ${messageOf(cause)}`, {
        file,
        cause,
      })
    }
    modules.set(file, module)
    return module
  }

  // Every child is created from inside the linker: creating one during link()
  // is the documented order (S13; D30). Node allows one link() and one
  // evaluate() per module.
  const linker = async (specifier: string, referencing: vm.Module): Promise<vm.SourceTextModule> => {
    const parent = referencing.identifier
    if (typeof parent !== 'string') {
      throw new ModHostError(
        'ERR_MOD_HOST_LINK',
        `cannot resolve '${specifier}': the importing module has no file identifier`,
      )
    }
    const resolved =
      sources === undefined
        ? resolveModSpecifier({ specifier, parent: fileURLToPath(parent), root })
        : (() => {
            const snapshot = resolveSnapshotSpecifier({
              specifier,
              parent: relativePath(root, fileURLToPath(parent)),
              files: new Set(sources.keys()),
            })
            return { file: resolve(root, snapshot.file), behavior: snapshot.behavior }
          })()
    if (granted !== undefined) {
      const file = relativePath(root, resolved.file)
      if (!granted.has(file)) {
        throw new ModHostError(
          'ERR_MOD_HOST_UNGRANTED',
          `'${specifier}' resolves to "${file}", which the grant does not pin`,
          { file: resolved.file },
        )
      }
    }
    return createModule(resolved.file)
  }

  const entryModule = createModule(entryFile)
  try {
    await entryModule.link(linker)
  } catch (error) {
    if (error instanceof ModHostError) throw error
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      `cannot link the module graph: ${messageOf(error)}`,
      { file: entryFile, cause: error },
    )
  }
  const evaluation = entryModule.evaluate()
  await evaluation

  const exported = entryModule.namespace.register
  if (typeof exported !== 'function') {
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      `entry must export a function named 'register' (found ${describeValue(exported)})`,
      { file: entryFile },
    )
  }

  const declared: Registration[] = []
  let registering = true
  const on = (event: unknown, matcherOrHandler?: unknown, maybeHandler?: unknown): RegistrationHandle => {
    if (!registering) {
      throw new ModHostError(
        'ERR_MOD_HOST_LINK',
        'on() was called after register(on) returned; registrations must be declared in register()',
        { file: entryFile },
      )
    }
    if (typeof event !== 'string' || event.length === 0) {
      throw new ModHostError(
        'ERR_MOD_HOST_LINK',
        `on(event, ...): event must be a non-empty string, got ${describeValue(event)}`,
        { file: entryFile },
      )
    }
    let matcher: unknown
    let handler: unknown
    if (typeof matcherOrHandler === 'function' && maybeHandler === undefined) {
      matcher = undefined
      handler = matcherOrHandler
    } else {
      matcher = matcherOrHandler
      handler = maybeHandler
    }
    if (typeof handler !== 'function') {
      throw new ModHostError(
        'ERR_MOD_HOST_LINK',
        `on('${event}', ...): handler must be a function, got ${describeValue(handler)}`,
        { file: entryFile },
      )
    }
    const registration: Registration = {
      event,
      matcher,
      handler: handler as Registration['handler'],
      caughtBy: undefined,
    }
    declared.push(registration)
    let catchTaken = false
    return Object.freeze({
      catch(catchHandler: unknown): void {
        if (!registering) {
          throw new ModHostError(
            'ERR_MOD_HOST_REGISTRATION',
            `Registration.catch for '${event}' was called after register(on) returned; the pinned .catch is declared during register()`,
            { file: entryFile },
          )
        }
        if (event === 'engine.create') {
          throw new ModHostError(
            'ERR_MOD_HOST_REGISTRATION',
            "Registration.catch cannot be served on 'engine.create': the pinned hook has no budget, so its failure is the load's",
            { file: entryFile },
          )
        }
        if (catchTaken) {
          throw new ModHostError(
            'ERR_MOD_HOST_REGISTRATION',
            `Registration.catch for '${event}' was already set; the pinned Registration takes one .catch`,
            { file: entryFile },
          )
        }
        if (typeof catchHandler !== 'function') {
          throw new ModHostError(
            'ERR_MOD_HOST_REGISTRATION',
            `Registration.catch for '${event}' requires a function, got ${describeValue(catchHandler)}`,
            { file: entryFile },
          )
        }
        catchTaken = true
        registration.caughtBy = catchHandler as NonNullable<Registration['caughtBy']>
      },
    })
  }

  try {
    await exported(on, plugin.options)
  } finally {
    registering = false
  }

  const registrations = Object.freeze(
    declared.map((registration) =>
      Object.freeze({
        event: registration.event,
        matcher: registration.matcher,
        handler: async (event: unknown, next: ModNext): Promise<unknown> => {
          assertLive()
          const dollar = await host.dollar()
          assertLive()
          const caughtBy = registration.caughtBy
          if (caughtBy === undefined) {
            return registration.handler(dollar, event, next)
          }
          const state: NextState = { called: false, last: undefined }
          const tracked = makeTrackedNext(next, state, false)
          let failure: HookFailure
          try {
            return await registration.handler(dollar, event, tracked)
          } catch (error) {
            failure = hookFailure(error)
          }
          assertLive()
          // The pin gives the catch handler a `$` of its own; the hook's
          // namespace belongs to the invocation that failed.
          const catchDollar = await host.dollar()
          assertLive()
          return caughtBy(catchDollar, event, makeCaughtNext(next, state, failure))
        },
      }),
    ),
  )

  return Object.freeze({
    registrations,
    evaluate: async (): Promise<unknown> => {
      assertLive()
      return evaluation
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      declared.length = 0
      modules.clear()
    },
  })
}
