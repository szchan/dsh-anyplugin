/**
 * `anyplugin-guard` — the call-time policy this repository runs on itself.
 *
 * One plugin, one root listener per host seam, no dispatcher:
 *
 * - `tools/pre-execute` (waterfall, D19): judge the call and return
 *   `{kind: 'deny', reason}` when a rule fires. This is the seam the host
 *   consults before executing a tool; a denial there is an actual rejection,
 *   not a warning in a log.
 * - `agent/pre-step` (waterfall): on a spawned worker's first step, append the
 *   brief as a user message to the continuation the host already computed.
 *   `subagent/start` is an emit with no value channel and the pin has no
 *   `instructions` field (S9/S10), so this is the only seam that can put text
 *   in front of the worker at spawn time. The brief is context, not a file the
 *   worker is told to read.
 *
 * The guard is deliberately *not* a second hook kernel: it has no matcher
 * grammar, no hook registrations and no event translation. It is a
 * first-party policy that reads the same payload the kernel reads, so a
 * classical hook and this guard can deny the same call without either
 * learning about the other.
 */
import { chooseWorktree, messageText, renderBrief, textMessage } from './brief.ts'
import { currentBranch } from './git.ts'
import {
  judgeCall,
  resolvePolicy,
  type GuardAgentView,
  type GuardCall,
  type GuardConfig,
  type ResolvedPolicy,
} from './policy.ts'

export const name = 'anyplugin-guard'
export const inject = ['tools']

interface AgentState {
  /** The worktree recorded from the spawn prompt; confinement follows it. */
  worktree?: string
  /** The first step was observed; the brief is delivered at most once. */
  resolved: boolean
}

function headerOf(agent: unknown): Record<string, unknown> | undefined {
  const header = (agent as { session?: { header?: unknown } } | undefined)?.session?.header
  return header !== null && typeof header === 'object' ? (header as Record<string, unknown>) : undefined
}

/** `session.header.parentSession` is set exactly for a spawned agent (S9). */
export function isWorker(agent: unknown): boolean {
  return headerOf(agent)?.parentSession !== undefined
}

export function agentCwd(agent: unknown): string | undefined {
  const cwd = headerOf(agent)?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function agentId(agent: unknown): string | undefined {
  const id = headerOf(agent)?.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

function viewOf(agent: unknown): GuardAgentView {
  return {
    ...(agentId(agent) === undefined ? {} : { id: agentId(agent) as string }),
    ...(agentCwd(agent) === undefined ? {} : { cwd: agentCwd(agent) as string }),
    worker: isWorker(agent),
  }
}

export async function apply(ctx: any, config: GuardConfig = {}): Promise<void> {
  const policy: ResolvedPolicy = resolvePolicy(config)
  const states = new WeakMap<object, AgentState>()
  const stateFor = (agent: unknown): AgentState => {
    const key = (agent ?? {}) as object
    const existing = states.get(key)
    if (existing !== undefined) return existing
    const created: AgentState = { resolved: false }
    states.set(key, created)
    return created
  }

  // `tools/pre-execute` is the same waterfall the classic-hook materializer
  // mounts; the guard adds one judgement and never rewrites the call.
  ctx.effect(() =>
    ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<unknown>) => {
      const agent = exec?.agent
      const state = stateFor(agent)
      const call: GuardCall = {
        tool: typeof exec?.name === 'string' ? exec.name : '',
        args: (exec?.arguments ?? {}) as Record<string, unknown>,
        agent: viewOf(agent),
        ...(state.worktree === undefined ? {} : { worktree: state.worktree }),
      }
      const verdict = judgeCall(call, policy, { branch: (cwd) => currentBranch(cwd ?? agentCwd(agent)) })
      if (verdict.kind === 'deny') return { kind: 'deny', reason: verdict.reason }
      return next()
    }),
  )

  // The brief is appended after the host's own continuation so the runtime
  // context the agent loop adds by default is kept (S9: the default
  // continuation is `{kind: 'enter', messages: [...claimed, context]}`).
  ctx.effect(() =>
    ctx.on('agent/pre-step', async (payload: any, next: () => Promise<unknown>) => {
      const agent = payload?.agent
      const result = (await next()) as { kind?: unknown; messages?: unknown } | undefined
      if (result?.kind !== 'enter' || !Array.isArray(result.messages)) return result
      if (!isWorker(agent)) return result
      const state = stateFor(agent)
      if (state.resolved) return result
      state.resolved = true
      const worktree = chooseWorktree({
        text: messageText(payload?.messages),
        ...(agentCwd(agent) === undefined ? {} : { cwd: agentCwd(agent) as string }),
        worktrees: policy.worktrees,
      })
      if (worktree !== undefined) state.worktree = worktree
      if (policy.brief === false) return result
      const cwd = agentCwd(agent)
      const brief = textMessage(
        renderBrief({
          ...(worktree === undefined ? {} : { worktree }),
          ...(cwd === undefined ? {} : { cwd }),
          config: policy.brief,
        }),
      )
      return { ...result, messages: [...result.messages, brief] }
    }),
  )
}
