/**
 * The interception kernel.
 *
 * One chain engine, two front-ends: classic hooks (v0.2) and mods (v0.5+).
 * Building the hook bridge as a one-off would guarantee rebuilding it for mods
 * and would leave mods architected out (ARCHITECTURE §7.2, AGENTS.md §3.6).
 *
 * This file is the kernel: event points, matcher grammar, decision protocol,
 * tier ordering, budgets, timeouts and determinism. It has no I/O. The classic
 * hook materializer is its first consumer; anything that intercepts must go
 * through `runChain`, not around it.
 */

import { MOD_EVENT_ROUTES, MOD_PINNED_EVENTS, modUnmappedReason, type ModEventRoute } from './mod-events.ts'

export * from './mod-events.ts'

/** Where a handler sits relative to the others. Outermost first. */
export type Tier = 'prepend' | 'user' | 'append' | 'builtin'

/**
 * The single ordering table. `builtin` is innermost on purpose: it is the host
 * behaviour being intercepted (the tool runs, the prompt is sent), so every
 * other tier wraps it and can decline before it happens.
 *
 * The pinned `claude-code.d.ts` names five tiers: these four plus `core`, the
 * engine's own innermost link (`TIERS`, d.ts:10022-10039), and a plugin is
 * never seated at `core` (`PluginRegisterInput.tier`, d.ts:6253-6265). The
 * four here are therefore exact, not an assumption. Every consumer reads this
 * table; none re-implements the order.
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
   * carry their own shapes and set it themselves). `null` means the front-end
   * knows this event has no subject: a matcher-bearing handler is then skipped
   * (recorded as `skipped-matcher` with no subject) instead of matching
   * everything.
   */
  subject?: string | null
  /** Event payload; shape is per event point and owned by the front-end. */
  data: Record<string, unknown>
}

/** The string a matcher is tested against for a classic hook payload. */
export function classicSubject(event: ChainEvent): string {
  const field = CLASSIC_SUBJECT_FIELD[event.name]
  const value = field === undefined ? undefined : event.data[field]
  return typeof value === 'string' ? value : ''
}

/**
 * Build a classic-hook event from its payload. Subject extraction stays in the
 * one table above: a front-end never re-derives the field. `null` records that
 * this event carries no subject, which the kernel uses to skip a matcher
 * instead of testing it against the empty string.
 */
export function classicEvent(name: string, data: Record<string, unknown>): ChainEvent {
  const field = CLASSIC_SUBJECT_FIELD[name]
  const value = field === undefined ? undefined : data[field]
  // An empty string is still a value the author can match; only a missing or
  // non-string field means there is no subject.
  return { name, data, subject: typeof value === 'string' ? value : null }
}

export type Decision =
  | { kind: 'continue' }
  | { kind: 'deny'; reason: string }
  | { kind: 'text'; text: string }
  | { kind: 'result'; result: unknown }
  | { kind: 'block'; reason?: string }
  | { kind: 'approve'; reason?: string }
  | { kind: 'unsupported'; field: string; reason: string }

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
   * A matcher compiled by the front-end at registration. When absent the
   * kernel compiles `matcher` itself. Front-ends that must fail closed on an
   * invalid pattern (classic hooks, D20) use `classicHookRegistration`, which
   * stores a matcher that never matches instead of throwing mid-turn.
   */
  compiledMatcher?: CompiledMatcher
  /**
   * `observe` (default, classic hooks) or `wrap` (mods). See runChain.
   */
  mode?: 'observe' | 'wrap'
  /**
   * Decision flow this registration needs. When no `continuation` is passed
   * to `runChain`, a chain whose registrations agree on this value uses it;
   * otherwise the chain default (`first-decision`) applies. Classic hooks
   * declare `fan-out`; mod registrations leave it unset.
   */
  continuation?: Continuation
  /** Budget for one run of this handler. */
  timeoutMs?: number
  /** Who registered it, for traces and the trust UI. */
  source: string
  run: Handler
}

/**
 * How a chain treats a handler decision.
 *
 * - `first-decision` (the default) is the mod contract: the first non-continue
 *   decision ends the chain.
 * - `fan-out` is the classic-hook contract: every matching handler runs in
 *   order and decisions are collected afterwards. A deny does not stop the
 *   next sibling; the front-end aggregates the decisions.
 */
export type Continuation = 'first-decision' | 'fan-out'

export interface ChainOptions {
  /** Whole-chain deadline. */
  deadlineMs?: number
  /** Default per-handler budget. */
  timeoutMs?: number
  /**
   * Decision flow. When omitted, registrations that declare `continuation`
   * select it (classic registrations declare `fan-out`); with no declaration
   * the default is `first-decision`.
   */
  continuation?: Continuation
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
  /**
   * Every non-continue decision, in execution order. In `first-decision` mode
   * there is at most one; in `fan-out` mode this is the full set the front-end
   * aggregates.
   */
  decisions: Decision[]
  /** The event as the deepest handler saw it (rewrites included). */
  event: ChainEvent
  trace: TraceStep[]
}

export interface CompiledMatcher {
  pattern: string | undefined
  /**
   * True when the declaration named a matcher. This is deliberately about the
   * authored text, not the compiled pattern: `*` compiles to match-all but is
   * still an authored matcher, and on an event with no subject the classic
   * lifecycle mounts report it and skip the handler rather than run it.
   */
  specified: boolean
  test: (subject: string) => boolean
}

/**
 * Compile a matcher once, at registration, so a typo fails in the installer and
 * not in the middle of a tool call.
 */
export function compileMatcher(pattern?: string): CompiledMatcher {
  const trimmed = pattern?.trim()
  if (trimmed === undefined || trimmed === '' || trimmed === '*') {
    return { pattern: undefined, specified: pattern !== undefined && pattern !== '', test: () => true }
  }
  let expression: RegExp
  try {
    expression = new RegExp(trimmed)
  } catch (error) {
    throw new Error(`matcher ${JSON.stringify(pattern)} is not a valid regular expression: ${(error as Error).message}`)
  }
  return { pattern: trimmed, specified: true, test: (subject) => expression.test(subject) }
}

/**
 * Compile a classic-hook matcher. The grammar is the kernel's, with two
 * differences from `compileMatcher` that the classic front-end has always had
 * and that a consumer may not reimplement:
 * - the authored text is used as is (no trimming): whitespace is significant
 *   in a regex, so `" Write "` is not `"Write"`;
 * - a malformed pattern matches nothing (D20), because the hook is already
 *   installed and a turn must not fail on a typo.
 * An empty or absent pattern matches everything; `*` is an authored matcher
 * (it matches everything, but it is still reported on a subject-less event).
 */
export function compileClassicMatcher(pattern?: string): CompiledMatcher {
  const specified = pattern !== undefined && pattern !== ''
  if (pattern === undefined || pattern === '' || pattern === '*') {
    return { pattern: undefined, specified, test: () => true }
  }
  let expression: RegExp
  try {
    expression = new RegExp(pattern)
  } catch {
    return { pattern, specified, test: () => false }
  }
  return { pattern, specified, test: (subject) => expression.test(subject) }
}

/** One classic hook as the materializer knows it, before the kernel orders it. */
export interface ClassicHookSpec {
  event: string
  matcher?: string
  /** Budget for one run, including the command's own timeout. */
  timeoutMs?: number
  /** Who registered it, for traces. */
  source: string
  run: Handler
}

/**
 * Translate one classic hook into a kernel registration. A settings hook has
 * no notion of `next`, so it is always `user` tier and `observe` mode, and
 * it declares `fan-out`: a decision never skips a sibling. The kernel owns
 * tier order, matcher skips and decision collection; `first-decision` is the
 * default for the mod front-end, not for classic hooks. The matcher is
 * compiled here, at registration, and an invalid one becomes a matcher that
 * never matches rather than an exception during a turn.
 */
export function classicHookRegistration(spec: ClassicHookSpec): HandlerRegistration {
  return {
    event: spec.event,
    tier: 'user',
    mode: 'observe',
    continuation: 'fan-out',
    matcher: spec.matcher,
    compiledMatcher: compileClassicMatcher(spec.matcher),
    timeoutMs: spec.timeoutMs,
    source: spec.source,
    run: spec.run,
  }
}

/**
 * The subset of a mod registration the adapter needs. Structural on purpose:
 * the kernel package is a leaf, so it cannot import the mod host, and D31's
 * `ModRegistration` is exactly this shape.
 */
export interface ModRegistrationLike {
  readonly event: string
  /** The authored matcher, unchanged (`undefined` for a bare `on`). */
  readonly matcher: unknown
  readonly handler: (event: unknown, next: (event?: unknown) => unknown) => unknown
}

export interface ModKernelOptions {
  /** The plugin's name, for the trace source. Required: a trace needs an owner. */
  plugin: string
  /**
   * The host's seating of the plugin (`PluginRegisterInput.tier`,
   * d.ts:6253-6265; never `core`). `user` is only a fallback for a caller with
   * no seating to pass, not a tier derived from the mod or the event name.
   */
  tier?: Tier
  /** The entry module, for the trace source. */
  entry?: string
  /** Budget for one run, forwarded to the kernel. */
  timeoutMs?: number
}

export interface ModKernelUnmapped {
  /** The mod's event name, verbatim. */
  event: string
  /** Its position in the authored source order. */
  index: number
  /** The kernel source it would have had, whether or not the event routed. */
  source: string
  /** Why it was not adapted; never an empty string. */
  reason: string
}

export interface ModKernelRoute {
  registration: HandlerRegistration
  route: ModEventRoute
}

export interface ModKernelResult {
  registrations: HandlerRegistration[]
  routes: ModKernelRoute[]
  unmapped: ModKernelUnmapped[]
}

const ROUTES_BY_MOD_EVENT = new Map(MOD_EVENT_ROUTES.map((route) => [route.modEvent, route]))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeMatcher(value: unknown): string {
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

interface AdaptedMatcher {
  matcher?: string
  compiledMatcher?: CompiledMatcher
}

/**
 * The kernel's matcher grammar is a regex over the event subject (the tool
 * name, the agent type). A mod's string is that regex; a cross-realm `RegExp`
 * is its own source; a structural matcher has no kernel spelling yet, so the
 * registration is reported instead of quietly matching everything.
 */
function adaptMatcher(value: unknown): AdaptedMatcher | { reason: string } {
  if (value === undefined) return {}
  if (typeof value === 'string') {
    return { matcher: value, compiledMatcher: compileMatcher(value) }
  }
  if (Object.prototype.toString.call(value) === '[object RegExp]') {
    const expression = value as RegExp
    if (expression.flags !== '') {
      return {
        reason: `matcher /${expression.source}/${expression.flags} uses RegExp flags; the kernel matcher grammar is a flagless regex over the event subject (D13/D32).`,
      }
    }
    return { matcher: expression.source, compiledMatcher: compileMatcher(expression.source) }
  }
  return {
    reason: `matcher is ${describeMatcher(value)}; the kernel matches a flagless regex against the event subject, so a structural matcher needs a bridge this adapter does not provide (D32).`,
  }
}

/**
 * Classic events hand the mod the host's payload as `data`. `classic.PreToolUse`
 * is the exception: its mod `e` is `ToolCallEnvelope` (`tool`, `tool_use_id`,
 * and the tool's arguments spread beside them, d.ts:10081-10093), while the
 * kernel event carries the classic payload (`tool_name`, `tool_use_id`,
 * `tool_input`).
 */
function toModEvent(route: ModEventRoute, event: ChainEvent): unknown {
  if (route.payload !== 'tool-call-envelope') return event.data
  const tool = event.data.tool_name
  const toolUseId = event.data.tool_use_id
  if (typeof tool !== 'string' || typeof toolUseId !== 'string') {
    throw new Error('PreToolUse host event lacks tool_name/tool_use_id; cannot build ToolCallEnvelope')
  }
  const input = isRecord(event.data.tool_input) ? event.data.tool_input : {}
  return { ...input, tool, tool_use_id: toolUseId }
}

/**
 * Translate a mod's `next(e)` rewrite back to the seam's shape. The two
 * reserved envelope fields (d.ts:1049-1057: a rewrite of `tool` or
 * `tool_use_id` is ignored by core) stay the originals; only the arguments can
 * change. A classic rewrite goes through `classicEvent` so the subject the
 * next matcher sees is recomputed from the rewritten payload.
 */
function fromModEvent(route: ModEventRoute, event: ChainEvent, rewritten: unknown): ChainEvent {
  if (!isRecord(rewritten)) {
    throw new TypeError('a mod rewrite must be an object')
  }
  if (route.payload === 'tool-call-envelope') {
    const tool = event.data.tool_name
    const toolUseId = event.data.tool_use_id
    if (typeof tool !== 'string' || typeof toolUseId !== 'string') {
      throw new Error('PreToolUse event lacks tool_name/tool_use_id; cannot accept a rewrite')
    }
    const { tool: _tool, tool_use_id: _toolUseId, ...input } = rewritten
    return {
      ...event,
      data: { ...event.data, tool_name: tool, tool_use_id: toolUseId, tool_input: input },
      subject: tool,
    }
  }
  if (route.payload === 'classic') {
    return classicEvent(event.name, rewritten)
  }
  return { ...event, data: rewritten }
}

/** What a kernel decision means to a mod's `next()`. */
function kernelDecisionToMod(decision: Decision, route: ModEventRoute): unknown {
  switch (decision.kind) {
    case 'continue':
      return undefined
    case 'deny':
      return route.kernelEvent === 'PreToolUse' ? { deny: decision.reason } : { block: decision.reason }
    case 'result':
      return route.kernelEvent === 'PostToolUse'
        ? { updatedToolOutput: decision.result }
        : { block: 'a kernel result cannot be expressed as a classic result on this event' }
    case 'text':
      return { additionalContext: [decision.text] }
    case 'block':
      return route.kernelEvent === 'PreToolUse'
        ? { deny: decision.reason ?? 'blocked' }
        : decision.reason === undefined
          ? { block: true }
          : { block: decision.reason }
    case 'approve':
      return route.kernelEvent === 'PreToolUse'
        ? { allow: true }
        : { block: 'a kernel approve cannot be expressed as a classic result on this event' }
    case 'unsupported':
      return route.kernelEvent === 'PreToolUse'
        ? { deny: `unsupported classic result field ${decision.field}: ${decision.reason}` }
        : { block: `unsupported classic result field ${decision.field}: ${decision.reason}` }
  }
}

/**
 * The classic fields the adapter knows how to classify. A field absent from
 * this set is reported as unsupported rather than treated as continue: a
 * classic result is `ClassicResultOf`, not the engine's verbs (d.ts:1086-1087),
 * and dropping one of its fields silently would change the hook's meaning.
 */
const CLASSIC_RESULT_FIELDS = new Set([
  'allow',
  'ask',
  'block',
  'additionalContext',
  'decision',
  'deny',
  'displayContent',
  'initialUserMessage',
  'permissionDecision',
  'permissionDecisionReason',
  'preventContinuation',
  'reloadSkills',
  'retry',
  'sessionTitle',
  'stopReason',
  'suppressOriginalPrompt',
  'updatedInput',
  'updatedMCPToolOutput',
  'updatedToolOutput',
  'watchPaths',
  'worktreePath',
])

/** The classic events whose `ClassicResultFields` include `additionalContext`. */
const CLASSIC_CONTEXT_EVENTS = new Set([
  'PreToolUse',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'Setup',
  'PostModelSwitch',
  'SubagentStart',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'SubagentStop',
])

function unsupported(field: string, reason: string): ModResultTranslation {
  return { decision: { kind: 'unsupported', field, reason } }
}

interface ModResultTranslation {
  decision: Decision
  /** A PreToolUse `updatedInput` the handler wants the chain beneath to see. */
  rewrite?: ChainEvent
}

/**
 * A mod's return value, as a kernel decision plus an optional rewrite.
 *
 * A mod uses the engine's verbs (`{ deny }`, `{ result }`, `{ text }`,
 * `{ block }`, `{ drop }`) or a classic event's `ClassicResultOf`. The two are
 * not the same type: classic events carry `block`, `preventContinuation`,
 * `stopReason`, `additionalContext`, `updatedInput` and their event fields
 * (d.ts:976-1087). Those that the kernel can carry are translated:
 *
 * - `additionalContext` becomes `text` (the kernel's context channel),
 * - `updatedInput` becomes an event rewrite for the chain beneath,
 * - `block` becomes `block`;
 *
 * the rest are a typed `unsupported` with the field and a reason, never a
 * silent `continue`. A tagged kernel `Decision` is accepted too so a front-end
 * can share the helper.
 */
function modResultToKernel(route: ModEventRoute, event: ChainEvent, value: unknown): ModResultTranslation {
  if (value === undefined || value === null) return { decision: CONTINUE }
  if (!isRecord(value)) {
    return { decision: { kind: 'block', reason: `a mod handler returned ${typeof value}; expected an object or undefined` } }
  }
  if (typeof value.kind === 'string') {
    switch (value.kind) {
      case 'continue':
        return { decision: CONTINUE }
      case 'deny':
        return { decision: { kind: 'deny', reason: typeof value.reason === 'string' ? value.reason : 'denied by a mod' } }
      case 'result':
        return { decision: { kind: 'result', result: value.result } }
      case 'text':
        return { decision: { kind: 'text', text: typeof value.text === 'string' ? value.text : '' } }
      case 'block':
        return { decision: typeof value.reason === 'string' ? { kind: 'block', reason: value.reason } : { kind: 'block' } }
      case 'approve':
        return { decision: typeof value.reason === 'string' ? { kind: 'approve', reason: value.reason } : { kind: 'approve' } }
      case 'unsupported':
        return unsupported(
          typeof value.field === 'string' ? value.field : 'unknown',
          typeof value.reason === 'string' ? value.reason : 'a mod reported an unsupported result',
        )
      default:
        return unsupported('kind', `unknown decision kind ${JSON.stringify(value.kind)}`)
    }
  }

  const present = Object.keys(value).filter((key) => value[key] !== undefined)
  // The engine verbs are the mod-facing protocol on every event, not only the
  // classic ones; a bare { result }, { text } or { drop } is not a classic field.
  if ('result' in value) {
    return present.length === 1
      ? { decision: { kind: 'result', result: value.result } }
      : unsupported('result', 'result cannot be combined with another field in one mod return')
  }
  if ('text' in value && !('additionalContext' in value)) {
    return present.length === 1 && typeof value.text === 'string'
      ? { decision: { kind: 'text', text: value.text } }
      : unsupported('text', 'text must be a string and cannot be combined with another field in one mod return')
  }
  if ('drop' in value) {
    if (present.length !== 1) return unsupported('drop', 'drop cannot be combined with another field in one mod return')
    if (value.drop === true) return { decision: { kind: 'block' } }
    if (typeof value.drop === 'string') return { decision: { kind: 'block', reason: value.drop } }
    return unsupported('drop', 'drop must be true or a string')
  }
  if (route.payload === 'engine') {
    // session.start's next(e) is { cwd }; returning it is the ordinary
    // observe result, not a classic field to translate.
    if (present.length === 1 && present[0] === 'cwd' && typeof value.cwd === 'string') return { decision: CONTINUE }
    const field = present[0] ?? 'result'
    return unsupported(field, `${route.modEvent} is an observe engine point; a classic result field cannot be applied`)
  }

  // Fields with no kernel carrier are reported before any translation, so a
  // result that mixes one with a translatable field is not half-applied.
  const unsupportedField = [
    'ask',
    'preventContinuation',
    'stopReason',
    'decision',
    'updatedToolOutput',
    'updatedMCPToolOutput',
    'sessionTitle',
    'suppressOriginalPrompt',
    'initialUserMessage',
    'watchPaths',
    'reloadSkills',
    'permissionDecision',
    'permissionDecisionReason',
    'retry',
    'displayContent',
    'worktreePath',
  ].find((field) => field in value)
  if (unsupportedField !== undefined) {
    const detail = unsupportedField === 'ask'
      ? 'classic.PreToolUse ask needs the host approval flow; the kernel has no ask decision'
      : unsupportedField === 'preventContinuation' || unsupportedField === 'stopReason'
        ? 'stopping the session after the event has no kernel decision; it would be a host-level stop'
        : unsupportedField === 'decision'
          ? 'the PermissionRequest decision cannot cross the partial approval/request seam (S9: no tool_input)'
          : `the kernel has no carrier for classic result field ${unsupportedField}`
    return unsupported(unsupportedField, detail)
  }

  const unknown = present.find((field) => !CLASSIC_RESULT_FIELDS.has(field))
  if (unknown !== undefined) {
    return unsupported(unknown, `unknown classic result field ${unknown}; a classic event returns ClassicResultOf, not the engine verbs`)
  }

  const effects = ['deny', 'block', 'allow', 'additionalContext'].filter((field) => field in value)
  if (effects.length > 1) {
    return unsupported(effects.join('+'), 'the kernel decision carries one effect; this classic result combines several')
  }

  let decision: Decision = CONTINUE
  if ('deny' in value) {
    // deny is both the engine verb and the classic.PreToolUse result; a mod may
    // use it on any event, as the engine verbs are the mod-facing protocol.
    if (typeof value.deny !== 'string') return unsupported('deny', 'deny must be a string')
    decision = { kind: 'deny', reason: value.deny }
  } else if ('block' in value) {
    if (typeof value.block !== 'string') return unsupported('block', 'block must be a string')
    decision = { kind: 'block', reason: value.block }
  } else if ('allow' in value) {
    if (route.kernelEvent !== 'PreToolUse' || value.allow !== true) {
      return unsupported('allow', 'only classic.PreToolUse returns allow: true')
    }
    decision = { kind: 'approve' }
  } else if ('additionalContext' in value) {
    if (!CLASSIC_CONTEXT_EVENTS.has(route.kernelEvent) || !Array.isArray(value.additionalContext) || !value.additionalContext.every((item) => typeof item === 'string')) {
      return unsupported('additionalContext', 'this classic event does not read additionalContext, or the value is not an array of strings')
    }
    const contexts = value.additionalContext as string[]
    if (contexts.length > 0) decision = { kind: 'text', text: contexts.join('\n') }
  }

  let rewrite: ChainEvent | undefined
  if ('updatedInput' in value) {
    if (route.kernelEvent !== 'PreToolUse' || !isRecord(value.updatedInput)) {
      return unsupported('updatedInput', 'only classic.PreToolUse rewrites tool arguments, and updatedInput must be an object')
    }
    rewrite = fromModEvent(route, event, value.updatedInput)
  }
  return rewrite === undefined ? { decision } : { decision, rewrite }
}

async function runModHandler(
  route: ModEventRoute,
  handler: ModRegistrationLike['handler'],
  event: ChainEvent,
  next: Next,
): Promise<Decision> {
  const modEvent = toModEvent(route, event)
  const modNext = async (rewritten?: unknown): Promise<unknown> => {
    const nextEvent = rewritten === undefined ? undefined : fromModEvent(route, event, rewritten)
    const resolved = await next(nextEvent)
    // `session.start`'s `next(e)` is `{ cwd }` (d.ts:3568-3578), not a decision.
    if (route.modEvent === 'session.start') {
      return { cwd: (nextEvent ?? event).data.cwd }
    }
    return kernelDecisionToMod(resolved, route)
  }
  const translation = modResultToKernel(route, event, await handler(modEvent, modNext))
  if (translation.rewrite === undefined) return translation.decision
  const resolved = await next(translation.rewrite)
  return translation.decision.kind === 'continue' ? resolved : translation.decision
}

/**
 * A Pattern selects event names (d.ts:6101): an exact name, `*`, a
 * `<namespace>.*` glob, or a `!` complement of one of those (d.ts:4211,
 * 5256). Expansion happens before routing so a single `on('classic.*', ...)`
 * becomes the classic routes it selects, and every selected name that is not
 * routed is reported with the reason the pin gives for it.
 */
interface ModPatternExpansion {
  selected: readonly string[]
  reason?: string
}

const PINNED_EVENT_SET = new Set(MOD_PINNED_EVENTS)
const GLOB_NAMESPACE = /^[a-z][a-z0-9-]*$/
const NOT_A_PATTERN =
  'not a Pattern at the pin (EventName | Glob | Negation, d.ts:6101, 4211, 5256); expected an event name, `*`, `<namespace>.*`, or `!<one of those>`'

function selectPattern(pattern: string, strict: boolean): readonly string[] | string {
  if (pattern === '*') return MOD_PINNED_EVENTS
  if (pattern.endsWith('.*')) {
    const namespace = pattern.slice(0, -2)
    if (!GLOB_NAMESPACE.test(namespace)) return NOT_A_PATTERN
    const selected = MOD_PINNED_EVENTS.filter((event) => event.startsWith(`${namespace}.`))
    return selected.length === 0 ? `pattern ${pattern} matches no event at the pin` : selected
  }
  if (pattern.includes('*')) return NOT_A_PATTERN
  if (PINNED_EVENT_SET.has(pattern)) return [pattern]
  if (strict) return `pattern ${pattern} is not an event at the pin`
  // An exact name that is not in the pin is still one name, not a pattern: the
  // ordinary "not an event" reason is more useful than "not a Pattern".
  return pattern.includes('.') ? [pattern] : NOT_A_PATTERN
}

function expandModPattern(pattern: string): ModPatternExpansion {
  if (typeof pattern !== 'string' || pattern === '') {
    return { selected: [], reason: NOT_A_PATTERN }
  }
  if (pattern.startsWith('!')) {
    const inner = pattern.slice(1)
    if (inner === '' || inner === '*') return { selected: [], reason: NOT_A_PATTERN }
    const excluded = selectPattern(inner, true)
    if (typeof excluded === 'string') return { selected: [], reason: excluded }
    const excludedSet = new Set(excluded)
    return { selected: MOD_PINNED_EVENTS.filter((event) => !excludedSet.has(event)) }
  }
  const selected = selectPattern(pattern, false)
  return typeof selected === 'string' ? { selected: [], reason: selected } : { selected }
}

/**
 * Translate a mod's `on()` registrations into kernel registrations — the mod
 * front-end of the one interception kernel (AGENTS.md §3.6, D13).
 *
 * - `mode` is `wrap` (D13): a mod owns the rest of its chain only by calling
 *   `next`, and the kernel records a mod that does not as `not-called`.
 * - `continuation` is left unset. A chain that also holds classic hooks takes
 *   the classic `fan-out` (D28); a mod-only chain keeps `first-decision`.
 * - `tier` is the host's seating, not the mod's declaration and not derived
 *   from the event name. `user` is only a fallback for a caller that has no
 *   seating to pass. The pinned d.ts allows every tier except `core`
 *   (`PluginRegisterInput.tier`, d.ts:6253-6265); the adapter never invents a
 *   per-mod table.
 * - A `Pattern` (d.ts:6101) expands to the routed names it selects: `classic.*`
 *   selects the sixteen classic routes, `*` selects all seventeen, and a
 *   negation selects the complement. Selected names that are not routed are
 *   reported with their pinned reason; a pattern that cannot be expanded gets
 *   its own reason.
 * - Source order is preserved; the kernel does the ordering.
 * - An event with no route, or a structural matcher, is returned in `unmapped`
 *   with a non-empty reason. Nothing is dropped silently.
 *
 * There is no production caller yet: this adapter and its tests are the shell.
 * The loader front-end that calls it is the follow-up (the `session.start` row
 * is that loader point, not a live host event).
 *
 * `$` is not here on purpose: the mod host calls `host.dollar()` once
 * immediately before each invocation (D31), one layer below the adapter, so
 * there is nothing here to cache.
 */
export function modRegistrationsToKernel(
  registrations: Iterable<ModRegistrationLike>,
  options: ModKernelOptions,
): ModKernelResult {
  if (typeof options !== 'object' || options === null || typeof options.plugin !== 'string' || options.plugin === '') {
    throw new TypeError('modRegistrationsToKernel: options.plugin must be a non-empty string')
  }
  const tier = options.tier ?? 'user'
  if (!TIER_ORDER.includes(tier)) {
    throw new TypeError(`modRegistrationsToKernel: unknown tier ${String(tier)}`)
  }
  const adapted: HandlerRegistration[] = []
  const routes: ModKernelRoute[] = []
  const unmapped: ModKernelUnmapped[] = []
  let index = 0
  for (const registration of registrations) {
    const authoredEvent = registration.event
    const baseSource = `${options.plugin}/${options.entry ?? 'mod'}#${index}`
    const expansion = expandModPattern(authoredEvent)
    if (expansion.reason !== undefined) {
      unmapped.push({ event: authoredEvent, index, source: baseSource, reason: expansion.reason })
      index += 1
      continue
    }
    const matcher = adaptMatcher(registration.matcher)
    for (const selectedEvent of expansion.selected) {
      const source = selectedEvent === authoredEvent ? baseSource : `${baseSource}[${selectedEvent}]`
      const route = ROUTES_BY_MOD_EVENT.get(selectedEvent)
      if (route === undefined) {
        unmapped.push({ event: selectedEvent, index, source, reason: modUnmappedReason(selectedEvent) })
        continue
      }
      if ('reason' in matcher) {
        unmapped.push({ event: selectedEvent, index, source, reason: matcher.reason })
        continue
      }
      const kernelRegistration: HandlerRegistration = {
        event: route.kernelEvent,
        tier,
        mode: 'wrap',
        matcher: matcher.matcher,
        compiledMatcher: matcher.compiledMatcher,
        timeoutMs: options.timeoutMs,
        source,
        run: (_context, kernelEvent, next) => runModHandler(route, registration.handler, kernelEvent, next),
      }
      adapted.push(kernelRegistration)
      routes.push({ registration: kernelRegistration, route })
    }
    index += 1
  }
  return { registrations: adapted, routes, unmapped }
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
 * The continuation a chain declares through its registrations. Classic hooks
 * declare `fan-out`; mods leave it unset so the chain default stays
 * `first-decision`. A chain whose registrations disagree must pass
 * `continuation` explicitly rather than silently taking one side.
 */
function declaredContinuation(registrations: readonly HandlerRegistration[]): Continuation {
  let declared: Continuation | undefined
  for (const registration of registrations) {
    if (registration.continuation === undefined) continue
    if (declared === undefined) declared = registration.continuation
    else if (declared !== registration.continuation) {
      throw new Error('registrations disagree about continuation; pass continuation explicitly')
    }
  }
  return declared ?? 'first-decision'
}

/**
 * Run one event through the chain.
 *
 * Two decision flows share one engine, because the two front-ends need
 * different ones:
 *
 * - `first-decision` (default, mods): the first non-continue decision ends the
 *   chain. A handler that returns nothing in `observe` mode simply continues;
 *   not calling `next()` and returning nothing in `wrap` mode ends the chain.
 * - `fan-out` (classic hooks): every matching handler runs in order; a
 *   decision is recorded and collected, never used to skip a sibling. The
 *   front-end aggregates `decisions` afterwards. `next()` in this mode only
 *   rewrites the event for later handlers; the kernel owns continuation.
 *
 * Shared semantics:
 * - a matcher-bearing handler is skipped when the event has no subject (`null`),
 *   rather than matching the empty string;
 * - a handler that throws is skipped and recorded (`error`), never propagated,
 *   and never stops a sibling in `fan-out` mode;
 * - a handler that exceeds its budget is aborted, recorded (`timeout`), and
 *   skipped, and never stops a sibling in `fan-out` mode;
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
  const continuation = options.continuation ?? declaredContinuation(registrations)
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

  type HandlerRun =
    | { status: 'ran'; decision: Decision }
    | { status: 'timeout'; ms: number }
    | { status: 'error'; detail: string | undefined }

  /**
   * Run one handler under its budget. A throw is reported, never propagated;
   * the caller decides whether to continue (fan-out) or skip (first-decision).
   */
  const invoke = async (
    registration: HandlerRegistration,
    at: number,
    current: ChainEvent,
    next: Next,
    ms: number,
    remainingMs: number,
  ): Promise<HandlerRun> => {
    const controller = new AbortController()
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
      return { status: 'timeout', ms }
    }
    if (outcome === TIMED_OUT_NOT) return { status: 'error', detail: failure }
    return { status: 'ran', decision: (outcome as HandlerOutcome) ?? CONTINUE }
  }

  const step = async (position: number, current: ChainEvent): Promise<Decision> => {
    for (let at = position; at < ordered.length; at += 1) {
      const { registration } = ordered[at]
      const subject = current.subject === undefined ? classicSubject(current) : current.subject
      const matcher = registration.compiledMatcher ?? compileMatcher(registration.matcher)
      // No subject means the matcher cannot be evaluated. Running it would
      // match everything; the classic front-end reports this as a skip.
      const matched = subject === null ? !matcher.specified : matcher.test(subject)
      if (!matched) {
        record(registration, at, 'skipped-matcher', subject === null ? { detail: 'no subject' } : {})
        continue
      }

      const remainingMs = Math.max(0, deadline - Date.now())
      const ms = Math.min(registration.timeoutMs ?? defaultTimeout, remainingMs)
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

      const run = await invoke(registration, at, current, next, ms, remainingMs)
      if (run.status === 'timeout') {
        record(registration, at, 'timeout', { detail: `exceeded ${run.ms}ms` })
        continue
      }
      if (run.status === 'error') {
        record(registration, at, 'error', { detail: run.detail })
        continue
      }

      const own = run.decision
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

  /**
   * Run every matching handler, collecting decisions. A decision, throw or
   * timeout only affects the handler that produced it; later siblings still
   * run. `next()` rewrites the event for downstream handlers but cannot jump
   * tiers or end the chain — there is nothing to continue.
   */
  const fanOut = async (): Promise<{ decision: Decision; decisions: Decision[] }> => {
    const decisions: Decision[] = []
    let first: Decision = CONTINUE
    let current = event
    for (let at = 0; at < ordered.length; at += 1) {
      const { registration } = ordered[at]
      const subject = current.subject === undefined ? classicSubject(current) : current.subject
      const matcher = registration.compiledMatcher ?? compileMatcher(registration.matcher)
      const matched = subject === null ? !matcher.specified : matcher.test(subject)
      if (!matched) {
        record(registration, at, 'skipped-matcher', subject === null ? { detail: 'no subject' } : {})
        continue
      }

      const remainingMs = Math.max(0, deadline - Date.now())
      const ms = Math.min(registration.timeoutMs ?? defaultTimeout, remainingMs)
      const next: Next = async (nextEvent, _tier) => {
        if (nextEvent !== undefined) {
          deepest = nextEvent
          current = nextEvent
        }
        return CONTINUE
      }

      const run = await invoke(registration, at, current, next, ms, remainingMs)
      if (run.status === 'timeout') {
        record(registration, at, 'timeout', { detail: `exceeded ${run.ms}ms` })
        continue
      }
      if (run.status === 'error') {
        record(registration, at, 'error', { detail: run.detail })
        continue
      }

      const own = run.decision
      record(registration, at, 'ran', own === CONTINUE ? {} : { decision: own.kind })
      if (own !== CONTINUE) {
        decisions.push(own)
        if (first === CONTINUE) first = own
      }
    }
    return { decision: first, decisions }
  }

  if (continuation === 'fan-out') {
    const fan = await fanOut()
    return { decision: fan.decision, decisions: fan.decisions, event: deepest, trace }
  }
  const decision = await step(0, event)
  return { decision, decisions: decision === CONTINUE ? [] : [decision], event: deepest, trace }
}

/** Deterministic, human-readable trace for reports and failure output. */
export function describeTrace(trace: readonly TraceStep[]): string[] {
  return trace.map((entry) => `${entry.index} ${entry.tier}/${entry.source}: ${entry.status}${entry.detail === undefined ? '' : ` (${entry.detail})`}`)
}
