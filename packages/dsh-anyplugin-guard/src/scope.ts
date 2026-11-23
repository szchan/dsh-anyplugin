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
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import { realTarget, type ResolvedPolicy } from './policy.ts'

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
 * The git directory a working tree points at, or undefined.
 *
 * The main checkout has a directory `.git`; a linked worktree (a review or
 * verify tree as much as a ticket tree) has a file `gitdir: <common>/worktrees/
 * <name>`. A session started at a review worktree is still working on this
 * repository and must be *judged* — its cwd is not a licence to skip the rules
 * (reviewer finding on #230). Write permission is a separate list, so a review
 * worktree stays unwritable.
 */
const gitPointer = (path: string): string | undefined => {
  const pointer = join(path, '.git')
  let stat
  try {
    stat = statSync(pointer)
  } catch {
    return undefined
  }
  if (stat.isDirectory()) return realTarget(pointer)
  if (!stat.isFile()) return undefined
  try {
    const match = /^gitdir:\s*(.+)$/mu.exec(readFileSync(pointer, 'utf8'))
    if (match === null) return undefined
    // A linked worktree created with git 2.56's relative paths writes
    // `gitdir: ../main/.git/worktrees/review`; it is relative to the `.git`
    // file's directory, not to the guard's cwd (reviewer finding on #230).
    return realTarget(resolve(path, match[1].trim()))
  } catch {
    return undefined
  }
}

/**
 * The working tree containing `path`, if any. Checking only `path/.git` would
 * make a session started in a subdirectory of a review worktree inert, so walk
 * up to the nearest `.git` (reviewer finding on #230).
 */
const containingWorktree = (path: string): string | undefined => {
  for (let current = path; ; ) {
    if (gitPointer(current) !== undefined) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** True when `path` is a working tree of the protected repository (any branch). */
const isRepositoryWorktree = (path: string, policy: ResolvedPolicy): boolean => {
  const directory = gitPointer(path)
  if (directory === undefined) return false
  return policy.gitDirectories.some((common) => within(directory, realTarget(common)))
}

/**
 * A policy with neither roots nor worktrees is unconfigured (a hand-written
 * config, a unit test): behave globally, because silently switching an
 * unconfigured guard off is the worse failure. With a territory configured, a
 * session whose cwd is unknown is treated as outside it — the guard does not
 * guess. Paths are compared canonically: a symlink to the checkout is the
 * checkout, a relative gitdir resolves against its own tree, and a directory
 * inside a working tree is inside that tree.
 */
export const inTerritory = (cwd: string | undefined, policy: ResolvedPolicy): boolean => {
  const roots = territoryRoots(policy)
  if (roots.length === 0 && policy.worktrees.length === 0) return true
  if (cwd === undefined) return false
  const path = realTarget(cwd)
  if (roots.some((root) => within(path, realTarget(root)))) return true
  if (policy.worktrees.some((entry) => matchesPattern(path, realTarget(entry)))) return true
  // A subdirectory of a review or ticket worktree has no .git of its own; the
  // nearest ancestor that does is still a working tree of this repository.
  const tree = containingWorktree(path)
  return tree !== undefined && isRepositoryWorktree(tree, policy)
}
