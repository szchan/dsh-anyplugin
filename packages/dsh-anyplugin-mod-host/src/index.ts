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
 * 4. calls the authored `register(on)` with a controlled `on()` and returns the
 *    registrations in source order.
 *
 * A registration's handler is wrapped by the host: the returned wrapper is
 * `handler(event, next)`, and immediately before each invocation the host calls
 * `host.dollar()` exactly once and passes the result to the authored
 * `handler($, event, next)` as its first argument. The host never caches,
 * clones or freezes that namespace: `ModHost.dollar()` must return the
 * namespace for that one invocation. If a host returns the same object for two
 * calls, it has reused it — a `ModHost` bug, not host-side freshness.
 * `$` is never a global, so module-level code that reads it fails with the
 * realm's own `ReferenceError`; the host does not wrap authored errors.
 *
 * This is not a security boundary (D6/D30): it isolates the tested global
 * surface, not timers, promises, memory or permissions. It is also not the
 * element runtime or the bridges — `$` is whatever the caller supplies, and
 * the `.tsx` realm's `h`/`Fragment` only build descriptors; nothing renders
 * (D34).
 */
import { readFileSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as vm from 'node:vm'

import { ModHostError, codeOf, describeValue, messageOf } from './errors.ts'
import { jsxRealmGlobals, transformTsx } from './jsx.ts'
import { isWithin, resolveModSpecifier } from './resolve.ts'

export { ModHostError, type ModHostErrorCode } from './errors.ts'
export {
  createModBridge,
  ModBridgeError,
  type ModBridge,
  type ModBridgeCommandDefinition,
  type ModBridgeCommandRegistry,
  type ModBridgeErrorCode,
  type ModBridgeOptions,
  type ModBridgeSession,
  type ModBridgeTelemetryRecord,
} from './bridge.ts'
export {
  resolveModSpecifier,
  type ModResolutionBehavior,
  type ResolveModSpecifierOptions,
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
   */
  readonly handler: (event: unknown, next: ModNext) => unknown
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
}

type Registration = {
  readonly event: string
  readonly matcher: unknown
  readonly handler: (dollar: unknown, event: unknown, next: ModNext) => unknown
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
  let rootStat
  try {
    rootStat = statSync(root)
  } catch (cause) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'mod root does not exist', { file: root, cause })
  }
  if (!rootStat.isDirectory()) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'mod root is not a directory', { file: root })
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
  let entryStat
  try {
    entryStat = statSync(entryFile)
  } catch (cause) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'entry does not exist', { file: entryFile, cause })
  }
  if (!entryStat.isFile()) {
    throw new ModHostError('ERR_MOD_HOST_MISSING', 'entry is not a file', { file: entryFile })
  }

  const host = options.host
  if (host === null || typeof host !== 'object' || typeof host.dollar !== 'function') {
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      'host.dollar must be a function; it supplies $ for one handler invocation',
    )
  }

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
    try {
      source = readFileSync(file, 'utf8')
    } catch (cause) {
      throw new ModHostError(
        codeOf(cause) === 'ENOENT' ? 'ERR_MOD_HOST_MISSING' : 'ERR_MOD_HOST_LINK',
        `cannot read module: ${messageOf(cause)}`,
        { file, cause },
      )
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
    const resolved = resolveModSpecifier({
      specifier,
      parent: fileURLToPath(parent),
      root,
    })
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
  const on = (event: unknown, matcherOrHandler?: unknown, maybeHandler?: unknown): void => {
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
    declared.push({ event, matcher, handler: handler as Registration['handler'] })
  }

  try {
    await exported(on)
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
          return registration.handler(dollar, event, next)
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
