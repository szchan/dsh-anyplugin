/**
 * Reconcile — make the loader's `anyplugin.` subtree match a desired entry set.
 *
 * The loop is intentionally small and re-entrant: it never touches anything
 * outside `anyplugin.`, and a second call with the same desired set performs no
 * writes (`kept` names the entries it verified).
 *
 * Two substrate obligations are handled here rather than pushed to callers:
 *
 * - **Atomicity is not provided by group entries.** `EntryGroup.update()`
 *   catches each child's error, so a group can end up half-applied. After
 *   every apply we resolve the group and each child and require an active
 *   fiber (state 2); failures go into `failed` with the child id, and the
 *   group is *not* reported as created/updated/kept.
 * - **Teardown is not synchronous.** `remove()` drops the entry immediately and
 *   returns void. We capture the group and subtree fibers first, remove, then
 *   wait until they settle disposed (state 4), recording whether state 5
 *   (unloading) was observed on the way. `fiber.dispose()` is not reliably
 *   awaitable — it returns void once disposal is already in flight (S1).
 */
import { isDeepStrictEqual } from 'node:util'

import type { EntryOptions } from '../../dsh-anyplugin-emit/src/index.ts'

import { ENTRY_PREFIX } from './identity.ts'

export interface FiberLike {
  readonly state: number
  dispose?: () => unknown
}

export interface LoaderEntryLike {
  options: EntryOptions
  fiber?: FiberLike | null
  parent?: unknown
}

/** The narrow part of `EntryTree` that reconcile needs. */
export interface LoaderLike {
  root: unknown
  entries(): Iterable<LoaderEntryLike>
  resolve(id: string): LoaderEntryLike
  await(): Promise<unknown>
  create(options: EntryOptions): Promise<unknown>
  update(id: string, options: EntryOptions): Promise<unknown>
  remove(id: string): void
}

export interface ReconcileFailure {
  /** The group entry id. */
  id: string
  reason: string
  /** Set when a child (or grandchild) of the group is the one that failed. */
  child?: string
}

export interface ReconcileResult {
  created: string[]
  updated: string[]
  removed: string[]
  /** Desired entries whose loader options already matched; no write happened. */
  kept: string[]
  /** Entries that are not live after the loop. Never duplicated in the lists above. */
  failed: ReconcileFailure[]
}

export interface ReconcileOptions {
  /** How long to wait for a removed subtree to settle disposed. Default 2000 ms. */
  disposeTimeoutMs?: number
}

export interface DisposalObservation {
  /** Every captured fiber reached state 4 (disposed). */
  settled: boolean
  /** At least one fiber was seen in state 5 (unloading) during teardown. */
  sawUnloading: boolean
  /** Final observed states, in capture order. */
  states: number[]
}

const DISPOSED = 4
const UNLOADING = 5
const ACTIVE = 2

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wait for fibers captured before a `remove()` to reach the disposed state.
 *
 * State 5 is the unloading state; it is not the end state. The async disposer
 * chains to `_unload()`, which flips the fiber to 4 (uid null) when every
 * effect disposer has run — that is the only observable that proves teardown
 * finished. We still report whether 5 was seen, because the S1 protocol names
 * it and it distinguishes "disposed" from "never started".
 */
export async function waitForDisposal(
  fibers: readonly FiberLike[],
  timeoutMs = 2000,
): Promise<DisposalObservation> {
  const unique = [...new Set(fibers)]
  const pending = new Set(unique)
  let sawUnloading = false
  const observe = (): void => {
    for (const fiber of pending) {
      if (fiber.state === UNLOADING) sawUnloading = true
      if (fiber.state === DISPOSED) pending.delete(fiber)
    }
  }
  observe()
  const deadline = Date.now() + timeoutMs
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    observe()
  }
  return { settled: pending.size === 0, sawUnloading, states: unique.map((fiber) => fiber.state) }
}

function captureFibers(
  loader: LoaderLike,
  options: EntryOptions,
  seen: Set<string>,
  out: FiberLike[],
): void {
  if (seen.has(options.id)) return
  seen.add(options.id)
  let entry: LoaderEntryLike
  try {
    entry = loader.resolve(options.id)
  } catch {
    return
  }
  if (entry.fiber && !out.includes(entry.fiber)) out.push(entry.fiber)
  const config = entry.options?.config
  if (Array.isArray(config)) {
    for (const child of config as EntryOptions[]) captureFibers(loader, child, seen, out)
  }
}

function verifyChildren(
  loader: LoaderLike,
  options: EntryOptions,
  seen: Set<string>,
): { child: string; reason: string } | undefined {
  if (seen.has(options.id)) return undefined
  seen.add(options.id)
  const config = options.config
  if (!Array.isArray(config)) return undefined
  for (const child of config as EntryOptions[]) {
    let entry: LoaderEntryLike
    try {
      entry = loader.resolve(child.id)
    } catch {
      return { child: child.id, reason: 'child entry is missing after apply' }
    }
    const state = entry.fiber?.state
    if (state !== ACTIVE) {
      return { child: child.id, reason: `child fiber is ${state ?? 'absent'}, expected active (2)` }
    }
    const nested = verifyChildren(loader, entry.options ?? child, seen)
    if (nested) return nested
  }
  return undefined
}

/**
 * Reconcile the loader against `desired`.
 *
 * `desired` is the output of `compileEntries`. Only top-level entries whose id
 * starts with `anyplugin.` are considered; everything else in the loader is
 * left alone. The returned arrays name entry ids, sorted for determinism.
 * `failed` is authoritative: an id there may also have been written, but it is
 * not live afterward, so it is removed from `created`/`updated`/`kept`.
 */
export async function reconcile(
  loader: LoaderLike,
  desired: readonly EntryOptions[],
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const desiredById = new Map<string, EntryOptions>()
  for (const entry of desired) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error('reconcile: every desired entry needs a non-empty id')
    }
    if (!entry.id.startsWith(ENTRY_PREFIX)) {
      throw new Error(`reconcile: "${entry.id}" is outside the managed namespace ${ENTRY_PREFIX}`)
    }
    if (desiredById.has(entry.id)) {
      throw new Error(`reconcile: duplicate desired id "${entry.id}"`)
    }
    desiredById.set(entry.id, entry)
  }

  const actualById = new Map<string, LoaderEntryLike>()
  for (const entry of loader.entries()) {
    if (entry.parent !== loader.root) continue
    const id = entry.options?.id
    if (typeof id === 'string' && id.startsWith(ENTRY_PREFIX)) actualById.set(id, entry)
  }

  const result: ReconcileResult = { created: [], updated: [], removed: [], kept: [], failed: [] }
  const desiredIds = [...desiredById.keys()].sort()

  for (const id of desiredIds) {
    const wanted = desiredById.get(id) as EntryOptions
    const actual = actualById.get(id)
    if (actual && isDeepStrictEqual(actual.options, wanted)) {
      result.kept.push(id)
      continue
    }
    try {
      if (actual) {
        await loader.update(id, wanted)
        result.updated.push(id)
      } else {
        await loader.create(wanted)
        result.created.push(id)
      }
    } catch (error) {
      result.failed.push({ id, reason: describeError(error) })
    }
  }
  await loader.await()

  const timeoutMs = options.disposeTimeoutMs ?? 2000
  const removedIds = [...actualById.keys()].filter((id) => !desiredById.has(id)).sort()
  for (const id of removedIds) {
    const entry = actualById.get(id) as LoaderEntryLike
    const fibers: FiberLike[] = []
    captureFibers(loader, entry.options, new Set(), fibers)
    try {
      loader.remove(id)
    } catch (error) {
      result.failed.push({ id, reason: `remove failed: ${describeError(error)}` })
      continue
    }
    const disposal = await waitForDisposal(fibers, timeoutMs)
    let stillPresent = false
    try {
      loader.resolve(id)
      stillPresent = true
    } catch {
      stillPresent = false
    }
    if (!disposal.settled) {
      result.failed.push({ id, reason: `dispose did not settle (states: ${disposal.states.join(', ')})` })
    } else if (stillPresent) {
      result.failed.push({ id, reason: 'entry is still resolvable after remove' })
    } else {
      result.removed.push(id)
    }
  }
  await loader.await()

  for (const id of desiredIds) {
    if (result.failed.some((failure) => failure.id === id)) continue
    let entry: LoaderEntryLike
    try {
      entry = loader.resolve(id)
    } catch {
      result.failed.push({ id, reason: 'group entry is missing after apply' })
      continue
    }
    const state = entry.fiber?.state
    if (state !== ACTIVE) {
      result.failed.push({ id, reason: `group fiber is ${state ?? 'absent'}, expected active (2)` })
      continue
    }
    const child = verifyChildren(loader, entry.options ?? (desiredById.get(id) as EntryOptions), new Set())
    if (child) result.failed.push({ id, child: child.child, reason: child.reason })
  }

  const failedIds = new Set(result.failed.map((failure) => failure.id))
  result.created = result.created.filter((id) => !failedIds.has(id))
  result.updated = result.updated.filter((id) => !failedIds.has(id))
  result.kept = result.kept.filter((id) => !failedIds.has(id))
  return result
}
