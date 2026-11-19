/**
 * `gate(plugin, grants)` — turn refusals into IR annotations (AGENTS.md §3.1).
 *
 * The dialect reads the plugin and the IR is the source of truth for what may
 * be emitted. A refused hook is therefore moved out of `hooks` (where the
 * emitter would otherwise carry it) and into `pending` as a `planned` node
 * whose reason names the missing grant. The emitter then has nothing to skip
 * silently, and the report can say `refused` rather than `skipped`.
 *
 * Allowed hooks carry the resolved artifact (manifest + hash) this gate saw.
 * Emit copies those fields verbatim and never resolves the command a second
 * time; a trusted hook without them fails closed. The input IR is not
 * mutated. Nothing is executed here.
 */
import type { ClaudePluginIr, IrHook } from '../../dsh-anyplugin-ir/src/index.ts'
import { authorize, type Refusal, type TrustDecision } from './authorize.ts'
import type { Grants } from './grants.ts'

export interface Gated {
  ir: ClaudePluginIr
  decision: TrustDecision
}

function carried(hook: IrHook): boolean {
  return hook.annotation.fidelity === 'exact' || hook.annotation.fidelity === 'equivalent'
}

/** The `hooks/<event>#<index>` key the emitter and report use for this hook. */
export function hookEntryName(hook: IrHook): string {
  return `${hook.event}#${hook.index}`
}

export function gate(plugin: ClaudePluginIr, grants: Grants): Gated {
  const decision = authorize(plugin, grants)
  const byTarget = new Map(decision.refused.map((refusal) => [refusal.target, refusal]))
  const allowed = new Set(decision.allowed)
  const rows = new Map(decision.rows.map((row) => [row.target, row] as const))
  const hooks: IrHook[] = []
  const refused: Refusal[] = []

  for (const hook of plugin.hooks) {
    const key = `hook:${hookEntryName(hook)}`
    const refusal = byTarget.get(key)
    if (refusal !== undefined) {
      refused.push(refusal)
      continue
    }
    const row = rows.get(key)
    if (!carried(hook) || hook.command === undefined || row === undefined || !allowed.has(key)) {
      hooks.push(hook)
      continue
    }
    hooks.push({ ...hook, artifact: row.manifest, artifactHash: row.artifactHash })
  }

  const pending = [
    ...plugin.pending,
    ...refused.map((refusal) => {
      const hook = plugin.hooks.find((candidate) => `hook:${hookEntryName(candidate)}` === refusal.target)
      return {
        surface: 'hooks',
        name: refusal.target.slice('hook:'.length),
        sourcePath: hook?.sourcePath ?? 'hooks/hooks.json',
        annotation: { fidelity: 'planned' as const, reason: `Not emitted: ${refusal.reason}` },
      }
    }),
  ]

  return { ir: { ...plugin, hooks, pending }, decision }
}
