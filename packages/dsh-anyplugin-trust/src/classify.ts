/**
 * `classify(plugin)` — one row per exec-class artifact (D25).
 *
 * Exec-class is `hook`, `monitor`, `bin`, `mod` (AGENTS.md §3.5). The IR has a
 * per-hook shape already; `bin/`, `monitors/` and `mods/` are still opaque
 * `pending` directories in the dialect, so this walks those directories itself.
 *
 * Targets are stable, plugin-local names:
 *   hook:<event>#<index>   monitor:<path inside monitors/>
 *   bin:<path inside bin/>  mod:<path inside mods/>
 *
 * A path in a target is descriptive only — the grant pins the hash. Renaming a
 * byte-identical script therefore invalidates the grant, which is intentional:
 * the grant says "this artifact", not "whatever sits at this path".
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import type { ClaudePluginIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { hashFile, hashHook, type HookArtifact } from './hash.ts'
import { EXEC_CAPABILITY } from './grants.ts'

export interface ArtifactRow {
  capability: typeof EXEC_CAPABILITY
  target: string
  artifactHash: string
  /** Plugin-relative file that was hashed, or `hooks/hooks.json` for inline text. */
  sourcePath: string
  /** `file` when bytes on disk were hashed, `inline` for command text. */
  mode: 'file' | 'inline'
}

/** `<dialect>:<plugin>` — the identity grants are keyed by. */
export function pluginIdentity(plugin: ClaudePluginIr): string {
  return `${plugin.pin.tool}:${plugin.plugin.name}`
}

function listFiles(root: string, dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(root, path))
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        if (!statSync(path).isFile()) continue
      } catch {
        continue
      }
      files.push(relative(root, path).split(sep).join('/'))
    }
  }
  return files.sort()
}

const EXEC_DIRS: ReadonlyArray<{ dir: string; prefix: string }> = [
  { dir: 'bin', prefix: 'bin' },
  { dir: 'monitors', prefix: 'monitor' },
  { dir: 'mods', prefix: 'mod' },
]

/**
 * Classify every exec artifact that the plugin declares. Hooks without a
 * command (prompt/agent handlers) have nothing to run and are not rows.
 */
export function classify(plugin: ClaudePluginIr): ArtifactRow[] {
  const rows: ArtifactRow[] = []
  const root = plugin.plugin.root

  for (const hook of plugin.hooks) {
    if (hook.command === undefined) continue
    const artifact: HookArtifact = hashHook(root, hook)
    rows.push({
      capability: EXEC_CAPABILITY,
      target: `hook:${hook.event}#${hook.index}`,
      artifactHash: artifact.artifactHash,
      sourcePath: artifact.sourcePath,
      mode: artifact.mode,
    })
  }

  for (const { dir, prefix } of EXEC_DIRS) {
    for (const file of listFiles(root, join(root, dir))) {
      const inside = file.slice(dir.length + 1)
      rows.push({
        capability: EXEC_CAPABILITY,
        target: `${prefix}:${inside}`,
        artifactHash: hashFile(join(root, file)),
        sourcePath: file,
        mode: 'file',
      })
    }
  }

  return rows.sort((left, right) => (left.target < right.target ? -1 : left.target > right.target ? 1 : 0))
}
