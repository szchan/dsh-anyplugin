/**
 * `anyplugin-guard` — the call-time policy this repository runs on itself.
 *
 * One plugin, no dispatcher:
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
 * - `session/event` (emit): a worker that moves itself into its worktree makes
 *   the host append a structured `working-directory/change` event. That
 *   announcement is session-scoped, so it still arrives for a resumed session
 *   whose seat was lost with the previous Agent object — the seat source that
 *   survives a resume (#266).
 *
 * Both seams are dispatched through the *agent's* scope carrier
 * (`dsh-agent/lib/index.js:385-386` is the waterfall call; the loop builds the
 * carrier in `dsh-agent-loop/lib/index.js:551`). The app-level listener does
 * receive a child's call — an instrumented run confirmed it — so the app-level
 * `tools/pre-execute` mount is the authoritative one for every carrier. The
 * per-agent seat is an addition for the `agent/pre-step` brief only; it never
 * replaces the app-level listener. That is still one policy and one event
 * path — not a second kernel.
 *
 * The guard is deliberately *not* a hook kernel: it has no matcher grammar, no
 * hook registrations and no event translation. It is a first-party policy that
 * reads the same payload the kernel reads, so a classical hook and this guard
 * can deny the same call without either learning about the other.
 */
import { chooseWorktree, messageText, renderBrief, textMessage } from './brief.ts'
import { denialSubject, recordDenial } from './denials.ts'
import { currentBranch } from './git.ts'
import { inTerritory } from './scope.ts'
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
  /** The worktree recorded from step text or a directory announcement; confinement follows it. */
  worktree?: string
  /**
   * A worktree was derived. Resolution must not be marked just because a step
   * was seen: a fresh child's first pre-step can arrive before the message
   * that names its worktree (the spawn prompt or a working-directory notice),
   * and a seat that gave up there confines every later write for the
   * session's whole life (#250).
   */
  resolved: boolean
  /** The brief is delivered at most once, even while resolution is retried. */
  briefed?: boolean
}

function headerOf(agent: unknown): Record<string, unknown> | undefined {
  const header = (agent as { session?: { header?: unknown } } | undefined)?.session?.header
  return header !== null && typeof header === 'object' ? (header as Record<string, unknown>) : undefined
}

/**
 * A spawned agent, by the pin's own classifier: the subagent runtime stamps
 * `session.header.origin = 'subagent'` (dsh-subagent/lib/index.js:300, typed
 * in dsh-session/lib/types/types.d.ts:86). `parentSession` is accepted too —
 * the loop sets it for a fork — but presence alone is not the classifier.
 */
export function isWorker(agent: unknown): boolean {
  const header = headerOf(agent)
  return header?.origin === 'subagent' || header?.parentSession !== undefined
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

  const decideTool = async (exec: any, next: () => Promise<unknown>): Promise<unknown> => {
    const agent = exec?.agent
    // D80: outside this checkout and its ticket worktrees the guard is inert —
    // the plugin loads in a user profile, so most sessions are not ours.
    if (!inTerritory(agentCwd(agent), policy)) return next()
    const state = stateFor(agent)
    // Seats come from step text and from the host's own directory announcement
    // (`working-directory/change`, see `learnSeat`). A child's header cwd is
    // creation metadata copied from its parent (`dsh-session` freezes the
    // header and `dsh-subagent` copies the parent's cwd), so deriving a seat
    // from it here would lock a child spawned elsewhere to its parent's
    // worktree; the spawn cwd reaches the child as a working-directory notice
    // in its messages, which the retrying step seat reads instead (#250).
    const call: GuardCall = {
      tool: typeof exec?.name === 'string' ? exec.name : '',
      args: (exec?.arguments ?? {}) as Record<string, unknown>,
      agent: viewOf(agent),
      ...(state.worktree === undefined ? {} : { worktree: state.worktree }),
    }
    const verdict = judgeCall(call, policy, { branch: (cwd) => currentBranch(cwd ?? agentCwd(agent)) })
    if (verdict.kind === 'deny') {
      // F16: the denial is evidence too. The recorder is best-effort by
      // construction — it never throws, so the verdict below is unchanged.
      recordDenial({
        callId: exec?.callId,
        role: call.agent.worker ? 'worker' : 'root',
        rule: verdict.rule,
        tool: call.tool,
        cwd: call.agent.cwd ?? null,
        worktree: state.worktree ?? null,
        session: call.agent.id ?? null,
        subject: denialSubject(call.tool, call.args),
      })
      return { kind: 'deny', reason: verdict.reason }
    }
    return next()
  }

  // The brief is appended after the host's own continuation so the runtime
  // context the agent loop adds by default is kept (S9: the default
  // continuation is `{kind: 'enter', messages: [...claimed, context]}`).
  const decideStep = async (payload: any, next: () => Promise<unknown>): Promise<unknown> => {
    const agent = payload?.agent
    if (!inTerritory(agentCwd(agent), policy)) return next()
    const result = (await next()) as { kind?: unknown; messages?: unknown } | undefined
    if (result?.kind !== 'enter' || !Array.isArray(result.messages)) return result
    if (!isWorker(agent)) return result
    const state = stateFor(agent)
    // Keep trying while the seat is unknown: a fresh child's first pre-step
    // can arrive before the message that names its worktree (#250). Marking
    // `resolved` on the attempt is what turned that timing race into a
    // write-nothing session. The seat is derived from message text only: a
    // spawn prompt or a working-directory notice that arrives one step late
    // still wins, and a cwd is never consulted (`dsh-subagent` copies the
    // parent's cwd into a child, so a cwd seat can lock a child to the wrong
    // worktree; see `decideTool`).
    if (!state.resolved) {
      const worktree = chooseWorktree({
        text: messageText(payload?.messages),
        worktrees: policy.worktrees,
      })
      if (worktree !== undefined) {
        state.worktree = worktree
        state.resolved = true
      }
    }
    if (state.briefed === true) return result
    state.briefed = true
    if (policy.brief === false) return result
    const cwd = agentCwd(agent)
    const brief = textMessage(
      renderBrief({
        ...(state.worktree === undefined ? {} : { worktree: state.worktree }),
        ...(cwd === undefined ? {} : { cwd }),
        config: policy.brief,
      }),
    )
    return { ...result, messages: [...result.messages, brief] }
  }

  // The seat a resume loses. A session resumed with a steering message is
  // announced as a new Agent (`agent/created` fires again), but the state is
  // keyed by the Agent object and the cold resume replays the stored log
  // without re-publishing it, so neither the spawn prompt nor a directory
  // notice is claimed again: every write stays unseated (#266). The host does
  // publish the directory change itself, because the worker asks for it
  // (`working-directory` tool -> `working-directory/change` `{cwd}`); that
  // event is both structured and session-scoped, so it can seat the live
  // agent for the resumed session without trusting the frozen header cwd
  // (#250). Learn at most one seat: a recorded seat never moves, and an
  // announcement that does not resolve to exactly one installed worktree —
  // the primary checkout, outside every pattern, or an ambiguous match — is
  // still not a seat.
  const learnSeat = (session: any, event: any): void => {
    if (event?.type !== 'working-directory/change') return
    const id = session?.header?.id
    const cwd = event?.data?.cwd
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof cwd !== 'string' || cwd.length === 0) return
    const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = typeof registry?.get === 'function' ? registry.get(String(id)) : undefined
    if (agent === undefined || agent === null) return
    const state = stateFor(agent)
    if (state.resolved) return
    // The announcement is a directory, not text: chooseWorktree's text branch
    // contributes nothing, and the cwd branch keeps the same exactly-one rule
    // the step seat uses.
    const worktree = chooseWorktree({ text: '', cwd, worktrees: policy.worktrees })
    if (worktree === undefined) return
    state.worktree = worktree
    state.resolved = true
  }

  // Agent-scoped seats for the brief. The seams are dispatched through the
  // agent's carrier, but the app-level listener below receives child calls too;
  // a seat is an addition, not a replacement, and `state.briefed` keeps the
  // brief to one delivery when both mounts see the same step.
  const seats = new Map<string, { agent: unknown; dispose: () => void }>()

  // App-level mounts: authoritative for every carrier, root or child.
  ctx.effect(() => ctx.on('tools/pre-execute', decideTool))
  ctx.effect(() => ctx.on('agent/pre-step', decideStep))
  ctx.effect(() => ctx.on('session/event', learnSeat))

  const mountAgent = (agent: any): void => {
    const id = agentId(agent)
    const agentCtx = agent?.ctx
    if (id === undefined || agentCtx === undefined || agentCtx === null || typeof agentCtx.on !== 'function') return
    if (seats.has(id)) return
    const disposers: Array<() => void> = []
    const mount = (listener: () => unknown): void => {
      const dispose = ctx.effect(listener)
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
    // The pre-execute mount is app-level only; mounting it again here used to
    // make the app-level listener skip the call (seats.has(...) ? next()).
    mount(() => agentCtx.on('agent/pre-step', decideStep))
    seats.set(id, {
      agent,
      dispose: () => {
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose()
          } catch {
            // The plugin effect may already have disposed this listener.
          }
        }
      },
    })
  }

  ctx.effect(() =>
    ctx.on('agent/created', (value: any) => {
      if (value?.agent !== undefined && value.agent !== null) mountAgent(value.agent)
    }),
  )
  ctx.effect(() =>
    ctx.on('agent/disposed', (value: any) => {
      const id = agentId(value?.agent)
      const seat = id === undefined ? undefined : seats.get(id)
      if (seat === undefined) return
      seats.delete(id as string)
      seat.dispose()
    }),
  )

  // A plugin can be loaded while agents are already live (the loader reload
  // path): seat what the registry has instead of waiting for a new creation.
  const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const live = typeof registry?.list === 'function' ? registry.list() : []
  for (const agent of Array.isArray(live) ? live : []) mountAgent(agent)
}
