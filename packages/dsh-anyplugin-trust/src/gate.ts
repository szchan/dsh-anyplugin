/**
 * `gate(plugin, grants)` — turn refusals into IR annotations (AGENTS.md §3.1).
 *
 * The dialect reads the plugin and the IR is the source of truth for what may
 * be emitted. A refused hook or mod is therefore moved out of `hooks`/`mods`
 * (where the emitter would otherwise carry it) and into `pending` as a
 * `planned` node whose reason names the missing grant. The emitter then has
 * nothing to skip silently, and the report can say `refused` rather than
 * `skipped`.
 *
 * Allowed hooks and mods carry the resolved artifact (manifest + hash) this
 * gate saw. Emit copies those fields verbatim and never resolves the command a
 * second time; a trusted row without them fails closed. The input IR is not
 * mutated. Nothing is executed here.
 */
import type { ClaudePluginIr, IrHook, IrMod } from '../../dsh-anyplugin-ir/src/index.ts'
import { authorize, type Refusal, type TrustDecision } from './authorize.ts'
import { modTarget } from './classify.ts'
import type { Grants } from './grants.ts'
import type { TreeOptions } from './hash.ts'

export interface Gated {
  ir: ClaudePluginIr
  decision: TrustDecision
}

function carried(annotation: { fidelity: string }): boolean {
  return annotation.fidelity === 'exact' || annotation.fidelity === 'equivalent'
}

/** The `hooks/<event>#<index>` key the emitter and report use for this hook. */
export function hookEntryName(hook: IrHook): string {
  return `${hook.event}#${hook.index}`
}

/** The `mods/<entry>` key the emitter and report use for this mod. */
export function modEntryName(mod: IrMod): string {
  return modTarget(mod).slice('mod:'.length)
}

/**
 * A refused mod's pending row names the entry, not the tree hash: the hash is
 * in the refusal (and in the grant prompt), and the report row must stay the
 * identity a person installed.
 */
function refusedPending(plugin: ClaudePluginIr, refused: readonly Refusal[]): ClaudePluginIr['pending'] {
  return refused.map((refusal) => {
    if (refusal.target.startsWith('mod:')) {
      const mod = (plugin.mods ?? []).find((candidate) => modTarget(candidate) === refusal.target)
      return {
        surface: 'mods',
        name: refusal.target.slice('mod:'.length),
        sourcePath: mod?.sourcePath ?? 'hooks/hooks.json',
        annotation: { fidelity: 'planned' as const, reason: `Not emitted: ${refusal.reason}` },
      }
    }
    const hook = plugin.hooks.find((candidate) => `hook:${hookEntryName(candidate)}` === refusal.target)
    return {
      surface: 'hooks',
      name: refusal.target.slice('hook:'.length),
      sourcePath: hook?.sourcePath ?? 'hooks/hooks.json',
      annotation: { fidelity: 'planned' as const, reason: `Not emitted: ${refusal.reason}` },
    }
  })
}

export function gate(plugin: ClaudePluginIr, grants: Grants, options: TreeOptions = {}): Gated {
  const decision = authorize(plugin, grants, options)
  const byTarget = new Map(decision.refused.map((refusal) => [refusal.target, refusal]))
  const allowed = new Set(decision.allowed)
  const rows = new Map(decision.rows.map((row) => [row.target, row] as const))
  const hooks: IrHook[] = []
  const mods: IrMod[] = []
  const refused: Refusal[] = []

  for (const hook of plugin.hooks) {
    const key = `hook:${hookEntryName(hook)}`
    const refusal = byTarget.get(key)
    if (refusal !== undefined) {
      refused.push(refusal)
      continue
    }
    const row = rows.get(key)
    if (!carried(hook.annotation) || hook.command === undefined || row === undefined || !allowed.has(key)) {
      hooks.push(hook)
      continue
    }
    hooks.push({ ...hook, artifact: row.manifest, artifactHash: row.artifactHash })
  }

  for (const mod of plugin.mods ?? []) {
    const key = modTarget(mod)
    const refusal = byTarget.get(key)
    if (refusal !== undefined) {
      refused.push(refusal)
      continue
    }
    const row = rows.get(key)
    if (!carried(mod.annotation) || row === undefined || !allowed.has(key)) {
      mods.push(mod)
      continue
    }
    mods.push({ ...mod, artifact: row.manifest, artifactHash: row.artifactHash })
  }

  const pending = [...plugin.pending, ...refusedPending(plugin, refused)]

  return { ir: { ...plugin, hooks, ...(plugin.mods === undefined ? {} : { mods }), pending }, decision }
}
