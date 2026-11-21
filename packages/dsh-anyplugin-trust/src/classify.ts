/**
 * `classify(plugin)` — one row per exec-class artifact (D25).
 *
 * Exec-class is `hook`, `monitor`, `bin`, `mod` (AGENTS.md §3.5). Hooks and
 * mods have an IR shape; the dialect also walks `bin/` and `monitors/` itself
 * because those remain opaque `pending` directories.
 *
 * Targets are stable, plugin-local names:
 *   hook:<event>#<index>   monitor:<path inside monitors/>
 *   bin:<path inside bin/>  mod:<plugin-relative entry>
 *
 * A target names the slot, not the bytes. The manifest includes every file's
 * absolute path, so moving a hook script to another path invalidates the grant
 * even when the bytes are identical; for bin/monitor/mod the relative path is
 * also the target, so a move is a new target. The hash, never the path or mtime,
 * is what the grant actually pins.
 *
 * A mod is an artifact over the **whole plugin tree** (D51): a mod may import
 * any file under its root, so every authored file is code-capable and every
 * one is pinned, in ascending plugin-relative path order (the derived rule
 * documented in `hash.ts`). `.git`, `node_modules` and the plugin's data
 * directory are excluded; a symlink that leaves the root is a typed refusal.
 * Mods the host refuses (`unsupported` annotation) are declarations, not
 * artifacts; they get no row, exactly like a planned hook.
 */
import { statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { ClaudePluginIr, IrMod } from '../../dsh-anyplugin-ir/src/index.ts'
import {
  fileArtifact,
  hashHook,
  hashManifest,
  listTreeFiles,
  treeArtifact,
  type ArtifactManifest,
  type ArtifactMode,
  type HookArtifact,
  type TreeOptions,
} from './hash.ts'
import { EXEC_CAPABILITY } from './grants.ts'

export interface ArtifactRow {
  capability: typeof EXEC_CAPABILITY
  target: string
  artifactHash: string
  /** Exact invocation, mode and ordered files; what the emitter carries. */
  manifest: ArtifactManifest
  /** Plugin-relative file that was hashed, or `hooks/hooks.json` for inline text. */
  sourcePath: string
  mode: ArtifactMode
  /** Present when the artifact cannot be honestly pinned (relative/outside/missing). */
  unsupported?: string
}

/** `<dialect>:<plugin>` — the identity grants are keyed by. */
export function pluginIdentity(plugin: ClaudePluginIr): string {
  return `${plugin.pin.tool}:${plugin.plugin.name}`
}

const EXEC_DIRS: ReadonlyArray<{ dir: string; prefix: string }> = [
  { dir: 'bin', prefix: 'bin' },
  { dir: 'monitors', prefix: 'monitor' },
  { dir: 'mods', prefix: 'mod' },
]

function carried(fidelity: string): boolean {
  return fidelity === 'exact' || fidelity === 'equivalent'
}

/**
 * The entry path inside `rootRelative`. The IR stores `entry` plugin-relative
 * (`hooks/register.ts`) because that is what `loadMod({ root, entry })` takes;
 * the manifest directory is `rootRelative`, so the tree is hashed from here.
 */
function entryWithin(mod: IrMod): string {
  const root = mod.rootRelative.replace(/\/+$/, '')
  const prefix = root === '' ? '' : `${root}/`
  return prefix !== '' && mod.entry.startsWith(prefix) ? mod.entry.slice(prefix.length) : mod.entry
}

/** The stable target of a mod: its entry, plugin-relative. */
export function modTarget(mod: IrMod): string {
  const root = mod.rootRelative.replace(/\/+$/, '')
  const inside = entryWithin(mod)
  return `mod:${root === '' ? inside : `${root}/${inside}`}`
}

/**
 * Why a mod's tree cannot be pinned, or `undefined` when it can.
 *
 * The checks are hostile on purpose: `rootRelative` and `entry` come from a
 * foreign manifest, and the grant must never hash files outside the plugin
 * root or silently pin an entry that does not exist.
 */
function modUnsupported(root: string, mod: IrMod): string | undefined {
  if (isAbsolute(mod.entry) || isAbsolute(mod.rootRelative)) {
    return `the manifest path is absolute (${mod.entry}); a mod entry must be plugin-relative`
  }
  const base = resolve(root)
  const dir = resolve(base, mod.rootRelative)
  const dirRelative = relative(base, dir)
  if (dirRelative.startsWith('..') || isAbsolute(dirRelative)) {
    return `"${mod.rootRelative}" is outside the plugin root`
  }
  const entry = resolve(base, mod.entry)
  const entryRelative = relative(dir, entry)
  if (entryRelative === '' || entryRelative.startsWith('..') || isAbsolute(entryRelative)) {
    return `"${mod.entry}" is outside "${mod.rootRelative}"`
  }
  try {
    if (!statSync(entry).isFile()) return `"${mod.entry}" is not a file`
  } catch {
    return `"${mod.entry}" does not exist under "${mod.rootRelative}"`
  }
  return undefined
}

/**
 * Classify every exec artifact that the plugin declares. Hooks without a
 * command (prompt/agent handlers) and mods the host refuses have nothing to
 * run and are not rows.
 */
export function classify(plugin: ClaudePluginIr, options: TreeOptions = {}): ArtifactRow[] {
  const rows: ArtifactRow[] = []
  const root = plugin.plugin.root

  for (const hook of plugin.hooks) {
    if (hook.command === undefined) continue
    const artifact: HookArtifact = hashHook(root, hook)
    rows.push({
      capability: EXEC_CAPABILITY,
      target: `hook:${hook.event}#${hook.index}`,
      artifactHash: artifact.artifactHash,
      manifest: artifact.manifest,
      sourcePath: artifact.sourcePath,
      mode: artifact.mode,
      ...(artifact.unsupported === undefined ? {} : { unsupported: artifact.unsupported }),
    })
  }

  for (const mod of plugin.mods ?? []) {
    if (!carried(mod.annotation.fidelity)) continue
    const unsupported = modUnsupported(root, mod)
    const tree = unsupported === undefined ? treeArtifact(root, mod.entry, options) : undefined
    const refusal = unsupported ?? (tree !== undefined && !tree.ok ? `${tree.refusal.path}: ${tree.refusal.reason}` : undefined)
    if (refusal !== undefined || tree === undefined || !tree.ok) {
      // Nothing could be read, so nothing is pinned. The refusal path uses
      // `code: 'unsupported'` before the hash matters; keeping a well-formed
      // manifest means every row has the same shape.
      const manifest: ArtifactManifest = { mode: 'text', invocation: mod.entry, command: '', files: [] }
      rows.push({
        capability: EXEC_CAPABILITY,
        target: modTarget(mod),
        artifactHash: hashManifest(manifest),
        manifest,
        sourcePath: mod.entry,
        mode: 'text',
        unsupported: refusal ?? 'the tree could not be pinned',
      })
      continue
    }
    rows.push({
      capability: EXEC_CAPABILITY,
      target: modTarget(mod),
      artifactHash: tree.artifact.artifactHash,
      manifest: tree.artifact.manifest,
      sourcePath: mod.entry,
      mode: tree.artifact.mode,
    })
  }

  for (const { dir, prefix } of EXEC_DIRS) {
    for (const file of listTreeFiles(root, join(root, dir))) {
      const inside = file.slice(dir.length + 1)
      const artifact = fileArtifact(join(root, file))
      rows.push({
        capability: EXEC_CAPABILITY,
        target: `${prefix}:${inside}`,
        artifactHash: artifact.artifactHash,
        manifest: artifact.manifest,
        sourcePath: file,
        mode: 'file',
      })
    }
  }

  rows.sort((left, right) => (left.target < right.target ? -1 : left.target > right.target ? 1 : 0))
  // Identity must be unique. The dialect promises a flat per-event index and
  // mods name their own entry; a regression there would silently let one grant
  // authorize two hooks, or one grant overwrite another, so fail loudly at the
  // boundary instead.
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.target)) throw new Error(`classify: duplicate exec target "${row.target}"`)
    seen.add(row.target)
  }
  return rows
}
