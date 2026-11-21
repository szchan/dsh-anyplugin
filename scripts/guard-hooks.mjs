#!/usr/bin/env node
// Defence in depth: a real git `pre-push` hook.
//
// The tool-call policy is what sees a tool call; this hook is the second net
// for a push that reaches git without going through `tools/pre-execute`.
// git itself resolves the refspec, so `remote.origin.push`, `push.default`,
// `branch.<name>.merge` and the spelling zoo all end here — unless the caller
// uses `--no-verify`, which skips the hook by design. The hook is installed by `guard:install`, checked by
// `guard:status`, and removed by `guard:install --uninstall`. It is a managed
// file: a foreign `pre-push` hook is never overwritten or deleted.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PRE_PUSH_MARKER = '# >>> dsh-anyplugin guard pre-push'
export const PRE_PUSH_END = '# <<< dsh-anyplugin guard pre-push'
export const PRE_PUSH_FILE = 'pre-push'

/** `git -C <repo> rev-parse --path-format=absolute --git-path hooks` */
export function hooksDirectory(repoRoot) {
  const output = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
    encoding: 'utf8',
  })
  return output.trim()
}

/** The configured hooks directory, when core.hooksPath moves it out of the checkout. */
export function configuredHooksPath(repoRoot) {
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.trim() === '' ? undefined : output.trim()
  } catch {
    return undefined
  }
}

/** Every worktree shares one hooks directory; callers install once per path. */
export function hookTargets(worktrees) {
  const seen = new Set()
  const targets = []
  for (const worktree of worktrees) {
    const directory = hooksDirectory(worktree)
    if (seen.has(directory)) continue
    seen.add(directory)
    targets.push({ worktree, directory, file: join(directory, PRE_PUSH_FILE) })
  }
  return targets
}

/** Refuse any push whose destination branch is protected, whatever the source. */
export function renderPrePushHook(branches = ['main', 'master']) {
  const names = [...new Set(branches)].filter((name) => /^[A-Za-z0-9._/-]+$/u.test(name))
  const patterns = names.length === 0 ? ['refs/heads/main', 'refs/heads/master'] : names.map((name) => `refs/heads/${name}`)
  return `${PRE_PUSH_MARKER}
# Managed by \`npm run guard:install\`; removed by \`guard:install --uninstall\`.
# Do not edit: the next install rewrites this file.
while read local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    ${patterns.join('|')})
      echo "anyplugin-guard: refusing to push $local_ref to $remote_ref; open a pull request" >&2
      exit 1
      ;;
  esac
done
exit 0
${PRE_PUSH_END}
`
}

export function readPrePushHook(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

/** missing | current | stale | foreign (foreign = a hook this tool did not write) */
export function prePushStatus(file) {
  if (!existsSync(file)) return 'missing'
  const content = readFileSync(file, 'utf8')
  if (!content.includes(PRE_PUSH_MARKER) || !content.includes(PRE_PUSH_END)) return 'foreign'
  return content === renderPrePushHook() ? 'current' : 'stale'
}

/** Write a managed hook body atomically (used by install and by its rollback). */
export function writePrePushHook(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.guard.tmp`
  writeFileSync(temporary, content, { mode: 0o755 })
  chmodSync(temporary, 0o755)
  renameSync(temporary, file)
}

export function installPrePushHook(file, expected = renderPrePushHook()) {
  const existing = readPrePushHook(file)
  if (existing !== undefined && !existing.includes(PRE_PUSH_MARKER)) {
    throw new Error(`guard: refusing to overwrite ${file}: it is a pre-push hook this tool did not write`)
  }
  if (existing === expected) return 'current'
  writePrePushHook(file, expected)
  return 'installed'
}

/** Remove only the managed hook; a foreign hook is left untouched. */
export function removePrePushHook(file) {
  if (!existsSync(file)) return 'absent'
  const content = readFileSync(file, 'utf8')
  if (!content.includes(PRE_PUSH_MARKER)) return 'foreign'
  unlinkSync(file)
  return 'removed'
}
