/**
 * The interception kernel.
 *
 * One chain engine, two front-ends: classic hooks (v0.2) and mods (v0.5+).
 * Building the hook bridge as a one-off would guarantee rebuilding it for mods
 * and would leave mods architected out (ARCHITECTURE §7.2, AGENTS.md §3.6).
 *
 * This file is the *skeleton*: event points, matcher grammar, decision
 * protocol, tier ordering, budgets, timeouts and determinism. It has no
 * consumers yet and no I/O. Anything that later intercepts must go through
 * `runChain`, not around it.
 */

/** Where a handler sits relative to the others. Outermost first. */
export type Tier = 'prepend' | 'user' | 'append' | 'builtin'

/**
 * The single ordering table. `builtin` is innermost on purpose: it is the host
 * behaviour being intercepted (the tool runs, the prompt is sent), so every
 * other tier wraps it and can decline before it happens.
 *
 * ASSUMPTION (D13): the tier names and their order come from the Claude mod
 * documentation, not from the pinned `claude-code.d.ts` (mods land in v0.5).
 * Every consumer reads this table; none re-implements the order, so verifying
 * it against the declaration file is one edit here.
 */
export const TIER_ORDER = ['prepend', 'user', 'append', 'builtin'] as const

/**
 * The classic-hook event vocabulary at the pinned release. Derived from
 * `fixtures/hooks/payloads/*.json`, which are extracted from the docs page of
 * the pin and, where a live capture exists, cross-checked against it. Adding an
 * event is a fixture change, not a code change: `test/payloads.test.mjs` fails
 * when this table and the fixtures disagree.
 */
export const CLASSIC_HOOK_EVENTS = [
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'Elicitation',
  'ElicitationResult',
  'FileChanged',
  'InstructionsLoaded',
  'MessageDisplay',
  'Notification',
  'PermissionDenied',
  'PermissionRequest',
  'PostCompact',
  'PostToolBatch',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PreModelSwitch',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Setup',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'TaskCreated',
  'TeammateIdle',
  'UserPromptExpansion',
  'UserPromptSubmit',
  'WorktreeCreate',
  'WorktreeRemove',
] as const

/**
 * Which payload field a matcher is tested against, per event. Listed only where
 * the field is inferable from the payload fixture itself; the rest leave the
 * subject empty, so a matcher cannot narrow anything (a recorded gap, TODO).
 */
export const CLASSIC_SUBJECT_FIELD: Readonly<Record<string, string>> = {
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PostToolUseFailure: 'tool_name',
  PermissionRequest: 'tool_name',
  PermissionDenied: 'tool_name',
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
  Notification: 'notification_type',
  PreCompact: 'trigger',
  PostCompact: 'trigger',
  Setup: 'trigger',
  SessionStart: 'source',
  SessionEnd: 'reason',
  InstructionsLoaded: 'memory_type',
  UserPromptExpansion: 'command_name',
  Elicitation: 'mcp_server_name',
  ElicitationResult: 'mcp_server_name',
  FileChanged: 'event',
  TaskCreated: 'teammate_name',
  TaskCompleted: 'teammate_name',
  TeammateIdle: 'teammate_name',
  PreModelSwitch: 'source',
}

export interface ChainEvent {
  /** Event point, e.g. `PreToolUse`. */
  name: string
  /**
   * The string a matcher is tested against. Front-ends may set it explicitly;
   * when absent it is derived from the payload by `classicSubject` (mod events
   * carry their own shapes and set it themselves).
   */
  subject?: string
  /** Event payload; shape is per event point and owned by the front-end. */
  data: Record<string, unknown>
}

/** The string a matcher is tested against for a classic hook payload. */
export function classicSubject(event: ChainEvent): string {
  const field = CLASSIC_SUBJECT_FIELD[event.name]
  const value = field === undefined ? undefined : event.data[field]
  return typeof value === 'string' ? value : ''
}

export type Decision =
  | { kind: 'continue' }
  | { kind: 'deny'; reason: string }
  | { kind: 'text'; text: string }
  | { kind: 'result'; result: unknown }
  | { kind: 'block'; reason?: string }
  | { kind: 'approve'; reason?: string }

export const CONTINUE: Decision = { kind: 'continue' }

/**
 * Handler outcome. A handler may return nothing (continue), return a decision
 * of its own, or return what `next()` returned after adjusting it.
 */
export type HandlerOutcome = void | Decision | undefined

export interface Budget {
  /** The handler's own limit. */
  ms: number
  /** Milliseconds left before the whole chain's deadline. */
  remainingMs: number
}

export interface HandlerContext {
  /** Tier of the handler being run. */
  tier: Tier
  /** Position in the resolved order (0-based). */
  index: number
  budget: Budget
  /** Aborted on timeout or when the chain is aborted. */
  signal: AbortSignal
}

/**
 * Continue the chain. Calling it with a new event *rewrites* the event for
 * every downstream handler and for the final result; calling it with a tier
 * jumps to the first handler at that tier.
 */
export type Next = (event?: ChainEvent, tier?: Tier) => Promise<Decision>

export type Handler = (context: HandlerContext, event: ChainEvent, next: Next) => HandlerOutcome | Promise<HandlerOutcome>

export interface HandlerRegistration {
  /** Which intercept point this handler answers. */
  event: string
  tier: Tier
  /**
   * Claude's matcher grammar: an optional regular expression matched against
   * the event's subject (the tool name for tool events). Empty or absent
   * matches everything; an invalid pattern throws at registration time.
   */
  matcher?: string
  /**
   * `observe` (default, classic hooks) or `wrap` (mods). See runChain.
   */
  mode?: 'observe' | 'wrap'
  /** Budget for one run of this handler. */
  timeoutMs?: number
  /** Who registered it, for traces and the trust UI. */
  source: string
  run: Handler
}

export interface ChainOptions {
  /** Whole-chain deadline. */
  deadlineMs?: number
  /** Default per-handler budget. */
  timeoutMs?: number
}

export type StepStatus = 'ran' | 'skipped-matcher' | 'timeout' | 'error' | 'not-called'

export interface TraceStep {
  source: string
  tier: Tier
  index: number
  status: StepStatus
  /** Set for `error` and `timeout`. */
  detail?: string
  /** The decision a handler returned, if any. */
  decision?: Decision['kind']
}

export interface ChainResult {
  /** The first non-continue decision, or CONTINUE. */
  decision: Decision
  /** The event as the deepest handler saw it (rewrites included). */
  event: ChainEvent
  trace: TraceStep[]
}

export interface CompiledMatcher {
  pattern: string | undefined
  test: (subject: string) => boolean
}

/**
 * Compile a matcher once, at registration, so a typo fails in the installer and
 * not in the middle of a tool call.
 */
export function compileMatcher(pattern?: string): CompiledMatcher {
  const trimmed = pattern?.trim()
  if (trimmed === undefined || trimmed === '' || trimmed === '*') {
    return { pattern: undefined, test: () => true }
  }
  let expression: RegExp
  try {
    expression = new RegExp(trimmed)
  } catch (error) {
    throw new Error(`matcher ${JSON.stringify(pattern)} is not a valid regular expression: ${(error as Error).message}`)
  }
  return { pattern: trimmed, test: (subject) => expression.test(subject) }
}

export interface ResolvedHandler {
  registration: HandlerRegistration
  index: number
}

/**
 * Resolve the order a chain will run in. Registration order is preserved inside
 * a tier, and the whole thing is a pure function of the registrations, so two
 * runs of the same set always produce the same order (the determinism the
 * skeleton test pins).
 */
export function resolveOrder(registrations: readonly HandlerRegistration[]): ResolvedHandler[] {
  const rank = (tier: Tier): number => {
    const at = TIER_ORDER.indexOf(tier)
    return at === -1 ? TIER_ORDER.length : at
  }
  return registrations
    .map((registration, index) => ({ registration, index }))
    .sort((a, b) => rank(a.registration.tier) - rank(b.registration.tier) || a.index - b.index)
    .map((item, index) => ({ registration: item.registration, index }))
}

const TIMED_OUT = Symbol('timeout')
const TIMED_OUT_NOT = Symbol('error')

async function withinLimit<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return TIMED_OUT
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void signal
  }
}

/**
 * Run one event through the chain.
 *
 * Semantics that the two front-ends share:
 * - a handler that returns a decision ends the chain (first decision wins);
 * - in `observe` mode a handler that returns nothing has simply run: the trace
 *   records `ran` and the chain continues;
 * - in `wrap` mode a handler that returns nothing never handed control on, so
 *   it ends the chain and the trace records `not-called`;
 * - a handler that throws is skipped and recorded (`error`), never propagated;
 * - a handler that exceeds its budget is aborted, recorded (`timeout`), and
 *   skipped.
 */
/**
 * Run one event through the chain.
 *
 * Two shapes share one engine, because the two front-ends need different ones:
 *
 * - `observe` (classic hooks): the kernel always continues after the handler.
 *   A settings hook has no notion of "next"; several matching hooks all run.
 * - `wrap` (mods): the handler owns continuation. Not calling `next()` and
 *   returning nothing ends the chain — that is what a wrapper means. Returning
 *   a decision also ends it.
 *
 * Shared semantics:
 * - the first non-continue decision wins;
 * - a handler that throws is skipped and recorded (`error`), never propagated;
 * - a handler that exceeds its budget is aborted, recorded (`timeout`), and
 *   skipped;
 * - exactly one trace step per handler run, so a report can be diffed.
 */
export async function runChain(
  event: ChainEvent,
  registrations: readonly HandlerRegistration[],
  options: ChainOptions = {},
): Promise<ChainResult> {
  const ordered = resolveOrder(registrations)
  const trace: TraceStep[] = []
  const deadline = Date.now() + (options.deadlineMs ?? 30_000)
  const defaultTimeout = options.timeoutMs ?? 10_000
  let deepest = event

  const tierStart = (tier: Tier, at: number): number => {
    const found = ordered.findIndex((entry) => entry.registration.tier === tier)
    // A tier that already ran cannot be re-entered backwards; asking for it
    // resumes at the next handler instead of looping.
    return found === -1 ? ordered.length : found > at ? found : at + 1
  }

  const record = (registration: HandlerRegistration, index: number, status: StepStatus, extra: Partial<TraceStep> = {}): void => {
    trace.push({ source: registration.source, tier: registration.tier, index, status, ...extra })
  }

  const step = async (position: number, current: ChainEvent): Promise<Decision> => {
    for (let at = position; at < ordered.length; at += 1) {
      const { registration } = ordered[at]
      const subject = current.subject ?? classicSubject(current)
      if (!compileMatcher(registration.matcher).test(subject)) {
        record(registration, at, 'skipped-matcher')
        continue
      }

      const remainingMs = Math.max(0, deadline - Date.now())
      const ms = Math.min(registration.timeoutMs ?? defaultTimeout, remainingMs)
      const controller = new AbortController()
      let resumed: Promise<Decision> | undefined

      const next: Next = (nextEvent, tier) => {
        // One continuation per handler: a second call would run the remainder
        // of the chain twice.
        if (resumed !== undefined) return resumed
        if (nextEvent !== undefined) {
          deepest = nextEvent
          current = nextEvent
        }
        resumed = step(Math.max(0, tier === undefined ? at + 1 : tierStart(tier, at)), current)
        return resumed
      }

      let returned: HandlerOutcome = undefined
      let failure: string | undefined
      const outcome = await withinLimit(
        (async () =>
          registration.run(
            { tier: registration.tier, index: at, budget: { ms, remainingMs }, signal: controller.signal },
            current,
            next,
          ))(),
        ms,
        controller.signal,
      ).catch((error: unknown) => {
        failure = (error as Error)?.message ?? String(error)
        return TIMED_OUT_NOT
      })

      if (outcome === TIMED_OUT) {
        controller.abort()
        record(registration, at, 'timeout', { detail: `exceeded ${ms}ms` })
        continue
      }
      if (outcome === TIMED_OUT_NOT) {
        record(registration, at, 'error', { detail: failure })
        continue
      }
      returned = outcome as HandlerOutcome

      const own = returned ?? CONTINUE
      const decided = resumed === undefined ? own : await resumed
      const final = own !== CONTINUE ? own : decided

      if (resumed === undefined && own === CONTINUE) {
        if ((registration.mode ?? 'observe') === 'wrap') {
          // A wrapper that declined to continue has ended the chain.
          record(registration, at, 'not-called')
          return CONTINUE
        }
        // An observing hook has no "next": it ran, and the chain continues.
        record(registration, at, 'ran')
        continue
      }
      record(registration, at, 'ran', final === CONTINUE ? {} : { decision: final.kind })
      if (final !== CONTINUE) return final
    }
    return CONTINUE
  }

  const decision = await step(0, event)
  return { decision, event: deepest, trace }
}

/** Deterministic, human-readable trace for reports and failure output. */
export function describeTrace(trace: readonly TraceStep[]): string[] {
  return trace.map((entry) => `${entry.index} ${entry.tier}/${entry.source}: ${entry.status}${entry.detail === undefined ? '' : ` (${entry.detail})`}`)
}
