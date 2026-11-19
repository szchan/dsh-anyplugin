/**
 * `gate(plugin, grants)` — turn refusals into IR annotations (AGENTS.md §3.1).
 *
 * The dialect reads the plugin and the IR is the source of truth for what may
 * be emitted. A refused hook is therefore moved out of `hooks` (where the
 * emitter would otherwise carry it) and into `pending` as a `planned` node
 * whose reason names the missing grant. The emitter then has nothing to skip
 * silently, and the report can say `refused` rather than `skipped`.
 *
 * The input IR is not mutated; the caller gets a shallow copy with new
 * `hooks`/`pending` arrays. Nothing is executed here.
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
  if (decision.refused.length === 0) return { ir: plugin, decision }

  const byTarget = new Map(decision.refused.map((refusal) => [refusal.target, refusal]))
  const hooks: IrHook[] = []
  const refused: Refusal[] = []
  for (const hook of plugin.hooks) {
    if (!carried(hook) || hook.command === undefined) {
      hooks.push(hook)
      continue
    }
    const refusal = byTarget.get(`hook:${hookEntryName(hook)}`)
    if (refusal === undefined) {
      hooks.push(hook)
      continue
    }
    refused.push(refusal)
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
