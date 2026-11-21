/**
 * Where the checked-out branch comes from, without running git.
 *
 * A bare `git push` pushes `push.default`, which is the current branch in
 * every configuration a developer is likely to have. The guard therefore has
 * to know the branch of the directory the push runs in, and it must know it
 * the same way git does: read `.git/HEAD`. A linked worktree has `.git` as a
 * file (`gitdir: /repo/.git/worktrees/<name>`), the main checkout has it as a
 * directory — both are handled here.
 *
 * The reader never throws: an unreadable repository is "branch unknown", and
 * the policy turns that into a deny that asks for an explicit refspec instead
 * of guessing.
 */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Read `<cwd>/.git` (file or directory) and return the checked-out branch. */
export function currentBranch(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  try {
    const dotGit = join(cwd, '.git')
    const info = statSync(dotGit)
    let gitDir = dotGit
    if (info.isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim()
      const match = pointer.match(/^gitdir:\s*(.+)$/u)
      if (match === null) return undefined
      const target = match[1].trim()
      gitDir = isAbsolute(target) ? target : resolve(cwd, target)
    } else if (!info.isDirectory()) {
      return undefined
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/u)
    return ref === null ? undefined : ref[1]
  } catch {
    return undefined
  }
}

const MAIN = new Set(['main', 'master'])

/** True for `main`, `master`, `refs/heads/main` and `refs/remotes/origin/main`. */
export function isMainRef(ref: string): boolean {
  const cleaned = ref.replace(/^refs\/heads\//u, '').replace(/^refs\/remotes\/[^/]+\//u, '')
  return MAIN.has(cleaned.trim())
}
