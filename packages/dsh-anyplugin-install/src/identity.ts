/**
 * Loader identity — the one place plugin-local names become profile-global ids.
 *
 * Three substrate facts drive this (S1, re-probed on cordis 4.1.0):
 *
 * 1. `EntryTree.sep` is `:`, and an id containing it is stored but cannot be
 *    resolved. Raw foreign ids are therefore mangled (D7).
 * 2. Group children live in the *root* tree's store, not in a per-group store
 *    (`Group extends EntryGroup` with `ctx.fiber.entry.parent.tree`). Child ids
 *    are consequently profile-global: two plugins that both emit a `skill`
 *    child collide, and the second group steals the first one's fiber. So the
 *    emitter's bare surface ids (`skill`, `mcp`, `hook`) are qualified with
 *    the plugin scope before they reach a loader.
 * 3. `EntryGroup.create` does `store[id] ??= new Entry(...)`: an id is reused,
 *    not rejected. Prefixing children with `anyplugin.` keeps them inside the
 *    namespace reconcile owns; `reconcile` additionally refuses to apply when
 *    a desired child id is already held by an entry outside the group, because
 *    the store would otherwise be reparented and its disposers never run in
 *    our teardown.
 */
import { mangleId } from '../../dsh-anyplugin-emit/src/index.ts'

/** Namespace owned by this layer. Reconcile never touches anything else. */
export const ENTRY_PREFIX = 'anyplugin.'

/** `claude-code:my-plugin` → loader-safe, colon-free key. */
export function pluginScope(dialect: string, name: string): string {
  return mangleId(`${dialect}:${name}`)
}

export function pluginEntryId(dialect: string, name: string): string {
  return `${ENTRY_PREFIX}${pluginScope(dialect, name)}`
}

/**
 * Child ids are global in the root store; qualify them with the plugin scope
 * and keep them under `anyplugin.` so a foreign entry can never be mistaken
 * for ours (and vice versa).
 */
export function childEntryId(scope: string, surfaceId: string): string {
  return `${ENTRY_PREFIX}${scope}.${surfaceId}`
}
