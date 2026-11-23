/**
 * Where the guard is allowed to act (D80).
 *
 * The guard is installed in a *user* profile, so it loads for every DSH
 * session on the machine — including the sessions that have nothing to do with
 * this repository. The maintainer asked for it to stay out of their way
 * (#221): inside this checkout and its ticket worktrees it enforces; anywhere
 * else it is inert — no denial, no brief, no audit record.
 *
 * The territory is already in the composed policy: `protectedRoots` names this
 * checkout (and its `.git`), `worktrees` names the ticket worktrees, exact
 * paths or `<stem>-*` namespaces. No new configuration is invented here.
 */
import { resolve, sep } from 'node:path'

import type { ResolvedPolicy } from './policy.ts'

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** `a === root` or `a` is below `root`; a bare prefix (`/work/repository`) is not below `/work/repo`. */
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`)

/**
 * A worktree entry may be a namespace (`/tmp/wt/ticket-*`). The `*` matches one
 * path segment, and anything below a matched directory is still inside it.
 */
const matchesPattern = (path: string, pattern: string): boolean => {
  if (!pattern.includes('*')) return within(path, pattern)
  const expression = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}(${escapeRegExp(sep)}|$)`, 'u')
  return expression.test(path)
}

/** The checkout roots, without the `.git` entry (that is a write target, not a session cwd). */
export const territoryRoots = (policy: ResolvedPolicy): string[] =>
  policy.protectedRoots.filter((root) => !root.endsWith(`${sep}.git`))

/**
 * `undefined` means the territory is unconfigured (a hand-written config or a
 * test): behave globally, because silently switching an unconfigured guard off
 * is the worse failure. With a territory configured, a session whose cwd is
 * unknown is treated as outside it — the guard does not guess.
 */
export const inTerritory = (cwd: string | undefined, policy: ResolvedPolicy): boolean => {
  const roots = territoryRoots(policy)
  if (roots.length === 0 && policy.worktrees.length === 0) return true
  if (cwd === undefined) return false
  const path = resolve(cwd)
  return roots.some((root) => within(path, root)) || policy.worktrees.some((entry) => matchesPattern(path, entry))
}
