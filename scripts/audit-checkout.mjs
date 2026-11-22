// The checkout that owns a repository's `.git`, resolved for the audit script.
//
// This mirrors `mainCheckout` in `packages/dsh-anyplugin-guard/src/composition.ts`
// (the function the guard's denial log uses) so the reader and the writer name
// the same directory. The one difference is the fallback: the guard reports
// "unknown layout" and walks up to the nearest `.git`, while this script keeps
// the root it was invoked from, because a digest must name some path.
//
// Checkout shape matters here:
//
// - ordinary clone: git dir === common dir, so the checkout is the toplevel;
// - submodule: both point at `<super>/.git/modules/<name>`, still equal, and
//   `--show-toplevel` is the submodule, not the superproject;
// - `git init --separate-git-dir`: both point at the external directory, and
//   `--show-toplevel` is the checkout;
// - linked worktree: the git dir differs from the common dir, which is the main
//   checkout's `.git`; its parent is the checkout that survives deleting the
//   worktree;
// - anything else: keep `start`.
//
// Uses `--path-format=absolute`, which needs git >= 2.31.
import { execFileSync } from 'node:child_process'
import { basename, dirname } from 'node:path'

function gitValue(start, args) {
  try {
    const output = execFileSync('git', ['-C', start, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return output.length === 0 ? undefined : output
  } catch {
    return undefined
  }
}

export function mainCheckout(start) {
  const gitDir = gitValue(start, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const commonDir = gitValue(start, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (gitDir === undefined || commonDir === undefined) return start
  if (gitDir === commonDir) return gitValue(start, ['rev-parse', '--show-toplevel']) ?? start
  if (basename(commonDir) === '.git') return dirname(commonDir)
  return start
}
