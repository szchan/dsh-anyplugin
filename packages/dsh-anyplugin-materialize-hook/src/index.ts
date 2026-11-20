/**
 * Hook materializer — mounts a plugin's command hooks on this host's tool
 * waterfalls and on the host events that carry the five lifecycle hooks, and
 * seats an authored mod's registrations on the same agent channels.
 *
 * Mount points are the ones S8/S9 proved: `tools/pre-execute` can deny (the
 * model reads `Error: <reason>`), `tools/post-execute` can attach
 * additionalContexts, and `agent/created`, `agent/turn-stopping`,
 * `agent/disposed`, `subagent/start` and `subagent/end` carry SessionStart,
 * Stop, SessionEnd, SubagentStart and SubagentStop. Every listener is
 * registered through `ctx.effect` so unloading the plugin removes it
 * (S1 finding 3).
 *
 * A mod is loaded once per plugin entry, its `session.start` fires during this
 * apply, and its registrations are seated on each agent's own context
 * (`payload.agent.ctx`, S9). That context sees only that agent's events, so a
 * mod's `$` cannot read a sibling session; the plugin entry's untagged context
 * would see every agent. The seat runs the mod's registrations and the
 * plugin's classic registrations for the same event through one `runChain`
 * (fan-out), so a mod rewrite is visible to the classic arm and to the tool
 * execution that follows. `tools/pre-execute` has no value channel, so the
 * seat applies the chain's final `tool_input` to `exec.arguments` before
 * `next()`; no second dispatcher is added.
 *
 * Matcher evaluation, tier order, decision flow and per-handler budgets belong
 * to `dsh-anyplugin-intercept` (D13): every mount translates its hooks into
 * `classicHookRegistration`s and calls `runChain` with `fan-out` continuation.
 * A hook decision never skips a sibling — upstream runs every matching hook —
 * so each mount aggregates the collected decisions itself. This file keeps only
 * the host wiring, the trust re-hash, the spawn and the verdict translation.
 *
 * PreToolUse runs *before* the host dispatches; every matching hook runs and a
 * denial from any of them becomes the block reason (the first denial by order
 * wins), matching the upstream "block" semantics. PostToolUse runs after the
 * call settled and only when it was accepted — a failed call takes the
 * upstream's separate PostToolUseFailure path, which S9 found on
 * `tools/post-execute` but which is not mounted yet. PostToolUse denial is
 * feedback: it joins the additionalContexts instead of blocking a call that
 * already ran.
 *
 * The five lifecycle mounts are emits or serial events, not waterfalls: the
 * handler runs, but a `block` decision or additionalContext has nowhere to go.
 * Those verdicts are reported with a warning instead of being silently dropped,
 * and the dialect's annotation names the gap (see `LIFECYCLE_HOOKS`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import {
  CONTINUE,
  classicEvent,
  classicHookRegistration,
  modRegistrationsToKernel,
  runChain,
  type ChainEvent,
  type ChainResult,
  type Decision,
  type HandlerRegistration,
} from '../../dsh-anyplugin-intercept/src/index.ts'
import {
  buildHookPayload,
  judgeHookResult,
  runCommandHook,
  type HookVerdict,
} from '../../dsh-anyplugin-hook-runner/src/index.ts'
import { loadMod, type LoadedMod } from '../../dsh-anyplugin-mod-host/src/index.ts'
import { hashManifest, hashManifestAtSpawn, type ArtifactManifest, type ArtifactMode } from '../../dsh-anyplugin-trust/src/index.ts'

export const name = 'anyplugin-materialize-hook'
export const inject = ['tools']

export interface MaterialHook {
  event: string
  /** Flat per-event position; names the artifact in refusal messages. */
  index?: number
  matcher?: string
  command: string
  args?: string[]
  timeout?: number
  /** D25 pin carried by the emitter; absent on a hand-written config. */
  artifactHash?: string
  /** How the pin was taken: a pure file, command text, or a composite. */
  artifactMode?: ArtifactMode
  artifactRoot?: string
  /** The resolved manifest: exact invocation plus ordered files and hashes. */
  artifact?: ArtifactManifest
}

/**
 * One authored mod to load and seat alongside the plugin's classic hooks.
 *
 * A mod is a directory pair (root + entry) because Claude loads mods from a
 * plugin's `hooks/` directory while the plugin root stays the trust unit. The
 * entry is relative to `pluginRoot`; `loadMod` owns resolution and `.tsx`
 * refusal (D31), so this config never rewrites an authored path.
 */
export interface MaterialMod {
  /** Entry path relative to `pluginRoot`, e.g. `hooks/hooks.ts`. */
  entry: string
  /** Kernel tier; D32 leaves the choice to the host, defaulting to `user`. */
  tier?: 'prepend' | 'user' | 'append' | 'builtin'
  /** Kernel budget for every registration this mod declares. */
  timeoutMs?: number
}

export interface Config {
  /** Directory the plugin was loaded from; `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRoot?: string
  /** Persistent directory across versions; `${CLAUDE_PLUGIN_DATA}`. */
  pluginData?: string
  /** Name used in kernel source strings, `${plugin}/${entry}#index`. */
  plugin?: string
  hooks?: MaterialHook[]
  mods?: MaterialMod[]
  /**
   * Diagnostic sink for the kernel trace of every chain run. The conformance
   * rig uses it to diff hook and mod steps; it must not change behavior, and a
   * sink that throws is reported as a warning rather than failing the turn.
   */
  onTrace?: (event: string, result: ChainResult) => void
  /**
   * Diagnostic sink for a loader-configured plugin: the same trace record as
   * `onTrace`, appended as one JSON line. The conformance rig reads it to prove
   * that a mod step and a classic step ran in one chain and in load-before-turn
   * order; writes never affect the chain, and a failed write warns.
   */
  traceFile?: string
}

interface ExecView {
  callId: string | number
  name: string
  arguments: unknown
  /** The agent that owns the call; absent on the standalone tools probe (S8). */
  agent?: unknown
}

interface PostDecision {
  kind: string
  value?: unknown
  additionalContexts?: unknown[]
}

interface LifecycleOccurrence {
  /** Event-specific payload fields; the mount adds hook_event_name and cwd. */
  fields: Record<string, unknown>
}

/** `agent/created`, `agent/turn-stopping` and `agent/disposed` carry the agent. */
interface RootAgentEvent {
  agent?: {
    session?: {
      header?: { id?: unknown; cwd?: unknown; parentSession?: unknown }
    }
    /** Durable model choice; `current()` is the supported read (no session log). */
    model?: { current?: () => { model?: unknown } | undefined }
  }
  source?: unknown
}

/** `subagent/start` and `subagent/end` carry the child's identity and outcome. */
interface SubagentEvent {
  parentSessionId?: unknown
  id?: unknown
  lastAssistantMessage?: unknown
}

/**
 * Upstream SessionStart/SessionEnd/Stop are about the session itself, so every
 * one of them is a root-only mount: a child creation, turn stop or disposal is
 * the SubagentStart/SubagentStop pair's business. The host signals the
 * difference with the child's parentSession header (S9).
 */
const isRoot = (value: RootAgentEvent): boolean => value.agent?.session?.header?.parentSession === undefined

/**
 * Fields every root lifecycle payload can carry without reading the session
 * log: the id and cwd are on the immutable header, and the model choice has a
 * supported accessor (`agent.model.current()`), so no appraisal of the log is
 * needed. A child has its own header, but these hooks are root-only.
 */
const rootFields = (value: RootAgentEvent): Record<string, unknown> => {
  const header = value.agent?.session?.header
  const fields: Record<string, unknown> = {}
  if (header?.id !== undefined) fields.session_id = header.id
  if (typeof header?.cwd === 'string') fields.cwd = header.cwd
  return fields
}

/** The model id Claude puts in `model`; undefined when no choice is named yet. */
const modelName = (value: RootAgentEvent): string | undefined => {
  try {
    const model = value.agent?.model?.current?.()?.model
    return typeof model === 'string' && model !== '' ? model : undefined
  } catch {
    return undefined
  }
}

/** subagent/end carries the final content blocks; Claude's field is the text. */
const messageText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts: string[] = []
  for (const block of value) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  const joined = parts.join('')
  return joined === '' ? undefined : joined
}

/**
 * The five hooks whose host events S9 observed on a real turn. SessionStart and
 * SessionEnd are root-only; a child creation/disposal is a SubagentStart/Stop
 * concern upstream. Stop is root-only for the same reason: a child's last turn
 * takes SubagentStop, and agent/turn-stopping fires for child turns too.
 */
const LIFECYCLE_EVENTS = ['SessionStart', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'] as const

/**
 * The runner's own default when the declaration names no timeout. The kernel
 * budget is this plus a grace window, so the command's timeout (and its kill)
 * settles before the kernel treats the handler as over budget.
 */
const DEFAULT_HOOK_TIMEOUT_MS = 60_000
const KERNEL_GRACE_MS = 5_000

const textify = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const textContext = (text: string): unknown => ({ role: 'user', content: [{ type: 'text', text }] })

/**
 * The text a PostToolUse handler contributed, in the order the handler
 * produced it. A handler that has both an `additionalContext` and a denial
 * returns one `result` decision carrying both, so the two contexts stay
 * adjacent exactly as they did when the handler pushed them itself.
 */
const decisionTexts = (decision: Decision): string[] => {
  if (decision.kind === 'text') return [decision.text]
  if (decision.kind === 'deny') return [decision.reason]
  if (decision.kind === 'result' && Array.isArray(decision.result)) {
    return decision.result.filter((value): value is string => typeof value === 'string')
  }
  return []
}

export async function apply(ctx: any, config: Config = {}): Promise<void> {
  const hooks = config.hooks ?? []
  const mods = config.mods ?? []
  if (hooks.length === 0 && mods.length === 0) return

  /**
   * The agent whose channel is currently running a kernel chain. A mod's `$`
   * is built once immediately before every invocation (D31/D32 §8), and the
   * host's `dollar()` reads this store; a chain seated on an agent channel runs
   * inside `runKernel`'s `invocation.run`, so the `$` belongs to the invocation
   * that called it, not to the load.
   */
  const invocation = new AsyncLocalStorage<{ agent?: unknown }>()

  /**
   * The `$` handed to a mod handler. D31 pins the shape to "whatever the host
   * supplies"; this host can answer the clock, the session header and the
   * message list without a session log, while command/tool registration are
   * host seams that do not exist yet. Those throw a typed bridge error instead
   * of silently succeeding (D32 §7: an unsupported result is recorded, never
   * dropped).
   */
  const dollarFor = (agent: any): Record<string, unknown> => {
    const header = agent?.session?.header
    const cwd = typeof header?.cwd === 'string' ? header.cwd : (config.pluginRoot ?? process.cwd())
    const notBridged = (surface: string) => async (): Promise<never> => {
      throw new Error(`anyplugin mod: ${surface} is not bridged on this host yet`)
    }
    return {
      session: {
        ...(header?.id === undefined ? {} : { id: header.id }),
        cwd,
        // Claude reads `$.session.messages()` as the session's messages. The
        // host reads them from the agent's own log; a chain with no agent (a
        // load-time session.start) sees no session and therefore no messages.
        messages: async () => {
          const log = agent?.session?.log
          if (!Array.isArray(log)) return []
          const messages: unknown[] = []
          for (const entry of log) {
            if (entry?.type === 'user/message' || entry?.type === 'assistant/message') {
              messages.push(entry.data)
            }
          }
          return messages
        },
        usage: async () => undefined,
      },
      clock: { now: async () => Date.now() },
      command: { register: notBridged('command.register') },
      tool: { register: notBridged('tool.register') },
    }
  }

  const modHost = {
    dollar: async (): Promise<Record<string, unknown>> => dollarFor(invocation.getStore()?.agent),
  }

  const env: NodeJS.ProcessEnv = { ...process.env }
  // Claude's spelling is what existing hooks read; Codex-compatible hooks read
  // PLUGIN_ROOT/PLUGIN_DATA. Both names point at the same directories, and
  // setting an extra variable does not change any existing command (T2).
  if (config.pluginRoot !== undefined) {
    env.CLAUDE_PLUGIN_ROOT = config.pluginRoot
    env.PLUGIN_ROOT = config.pluginRoot
  }
  if (config.pluginData !== undefined) {
    env.CLAUDE_PLUGIN_DATA = config.pluginData
    env.PLUGIN_DATA = config.pluginData
  }
  env.CLAUDE_PROJECT_DIR = process.cwd()

  /**
   * Re-read exactly the manifest's files immediately before every spawn (D25).
   * The command is never re-scanned: a grant pins one resolution, so an output
   * a hook writes (`--out ./out.txt`) or a later-created relative file can
   * neither change the artifact nor trigger a false refusal. A mismatch means
   * the bytes that would run are not the granted bytes, and the invocation is
   * refused.
   */
  const sameInvocation = (hook: MaterialHook, manifest: ArtifactManifest): boolean => {
    if (typeof manifest.invocation === 'string') {
      return hook.args === undefined && manifest.invocation === hook.command
    }
    if (hook.args === undefined) return false
    return (
      manifest.invocation.length === hook.args.length + 1 &&
      manifest.invocation[0] === hook.command &&
      hook.args.every((arg, index) => manifest.invocation[index + 1] === arg)
    )
  }

  const artifactChange = (hook: MaterialHook): string | undefined => {
    const label = `${hook.event}#${hook.index ?? 0}`
    const invocation = hook.args === undefined
      ? hook.command
      : [hook.command, ...hook.args].map((part) => JSON.stringify(part)).join(' ')
    if (hook.artifactHash === undefined) {
      return `refused ${label}: no hash-pinned grant was carried; command: ${invocation}`
    }
    const manifest = hook.artifact
    if (manifest === undefined) {
      return `refused ${label}: no artifact manifest was carried with the grant; pinned ${hook.artifactHash}; command: ${invocation}`
    }
    const pinnedManifest = hashManifest(manifest)
    if (pinnedManifest !== hook.artifactHash) {
      return `refused ${label}: the carried manifest does not match the grant (granted ${hook.artifactHash}, manifest ${pinnedManifest}); command: ${invocation}`
    }
    if (hook.artifactMode !== undefined && manifest.mode !== hook.artifactMode) {
      return `refused ${label}: artifact mode changed since the grant (pinned ${hook.artifactMode}, now ${manifest.mode}); command: ${invocation}`
    }
    if (!sameInvocation(hook, manifest)) {
      return `refused ${label}: the config no longer names the pinned invocation; command: ${invocation}`
    }
    let current: string
    try {
      current = hashManifestAtSpawn(manifest)
    } catch (error) {
      return `refused ${label}: artifact cannot be re-hashed (${(error as Error).message}); pinned ${hook.artifactHash}; command: ${invocation}`
    }
    if (current === hook.artifactHash) return undefined
    return `refused ${label}: artifact changed since the grant (pinned ${hook.artifactHash}, now ${current}); command: ${invocation}`
  }

  const warn = (message: string): void => {
    const logger = ctx.logger
    if (typeof logger?.warn === 'function') logger.warn(message)
    else if (typeof logger === 'function') logger(message)
  }

  // The install record names the plugin's data directory (D2), but creating it
  // is the loader's job at the point the plugin starts. A hook that writes
  // `$CLAUDE_PLUGIN_DATA/...` would otherwise fail with a shell error that
  // never mentions the missing directory.
  if (config.pluginData !== undefined) {
    try {
      mkdirSync(config.pluginData, { recursive: true })
    } catch (error) {
      warn(`anyplugin hook: cannot create plugin data directory ${config.pluginData} (${(error as Error).message}); hooks that write there will fail`)
    }
  }

  const of = (event: string): MaterialHook[] => hooks.filter((hook) => hook.event === event)

  /**
   * One classic hook's kernel budget: the command's own timeout plus headroom.
   * The chain deadline is the sum of the budgets, because handlers run in
   * sequence; a slow handler is then cut off by the kernel at its own budget
   * instead of stretching the turn past it. The kernel deadline equals the sum
   * exactly; the grace is already inside each per-handler budget.
   */
  const hookBudgetMs = (hook: MaterialHook): number =>
    (hook.timeout === undefined ? DEFAULT_HOOK_TIMEOUT_MS : hook.timeout * 1000) + KERNEL_GRACE_MS

  const runKernel = async (
    event: ChainEvent,
    registrations: readonly HandlerRegistration[],
    agent?: unknown,
  ): Promise<ChainResult> => {
    // A seat owns every host event, including ones this plugin has no handler
    // for. Running an empty chain would add an empty trace and an empty
    // decision, so it is skipped: no handler, no dispatch.
    if (registrations.length === 0) {
      return { decision: CONTINUE, decisions: [], event, trace: [] }
    }
    const result = await invocation.run({ agent }, () =>
      runChain(event, registrations, {
        continuation: 'fan-out',
        timeoutMs: DEFAULT_HOOK_TIMEOUT_MS + KERNEL_GRACE_MS,
        // A mod registration carries no timeout of its own unless the host set
        // one; the chain still needs a budget, so an all-zero sum means "use
        // the default" rather than "expire immediately".
        deadlineMs: (() => {
          const budget = registrations.reduce((total, registration) => total + (registration.timeoutMs ?? 0), 0)
          return budget > 0 ? budget : DEFAULT_HOOK_TIMEOUT_MS + KERNEL_GRACE_MS
        })(),
      }),
    )
    try {
      config.onTrace?.(event.name, result)
    } catch (error) {
      warn(`anyplugin hook ${event.name}: trace observer failed (${(error as Error).message})`)
    }
    if (config.traceFile !== undefined) {
      try {
        appendFileSync(config.traceFile, `${JSON.stringify({
          event: event.name,
          sources: registrations.map((registration) => registration.source),
          trace: result.trace,
          decision: result.decision,
        })}\n`)
      } catch (error) {
        warn(`anyplugin hook ${event.name}: trace file ${config.traceFile} is not writable (${(error as Error).message})`)
      }
    }
    return result
  }

  /** Spawn one hook with the chain event's payload and translate its verdict. */
  const execute = async (hook: MaterialHook, event: ChainEvent): Promise<HookVerdict> => {
    const result = await runCommandHook(hook, event.data, { env })
    const verdict = judgeHookResult(result, hook.event)
    if (verdict.warn !== undefined) warn(`anyplugin hook ${hook.event}: ${verdict.warn}`)
    return verdict
  }

  /**
   * One seat per agent. A seat is the agent's own channel context
   * (`payload.agent.ctx`, S9): listeners mounted there see that agent's events
   * and its descendants', never a sibling's. Every agent is seated, because a
   * subagent's tool call runs on the child's channel; `parentBySession` lets a
   * call resolve to an ancestor seat when the child was not seated (for example
   * a child created before this plugin loaded).
   */
  const seats = new Map<string, { agent: any; ctx: any; dispose: () => void }>()
  const parentBySession = new Map<string, unknown>()
  const seatForAgent = (agent: any): { agent: any; ctx: any; dispose: () => void } | undefined => {
    let id: unknown = agent?.session?.header?.id
    while (id !== undefined) {
      const seat = seats.get(String(id))
      if (seat !== undefined) return seat
      id = parentBySession.get(String(id))
    }
    return undefined
  }

  const pre = of('PreToolUse')
  const preRegistrations = pre.map((hook, index) =>
    classicHookRegistration({
      event: hook.event,
      matcher: hook.matcher,
      timeoutMs: hookBudgetMs(hook),
      source: `${hook.event}#${hook.index ?? index}`,
      run: async (_context, event) => {
        const changed = artifactChange(hook)
        if (changed !== undefined) return { kind: 'deny', reason: changed }
        const verdict = await execute(hook, event)
        return verdict.deny === undefined ? CONTINUE : { kind: 'deny', reason: verdict.deny }
      },
    }),
  )
  if (preRegistrations.length > 0) {
    ctx.effect(() =>
      ctx.on('tools/pre-execute', async (exec: ExecView, next: () => Promise<unknown>) => {
        // A seated agent's own listener runs the mixed chain. This global
        // fallback exists for tool calls with no agent (the classic-only
        // conformance probe) and for a client that starts a call outside a
        // seat; it must not run a second chain when a seat covers the call.
        if (seatForAgent(exec.agent) !== undefined) return next()
        const payload = buildHookPayload('PreToolUse', {
          toolName: exec.name,
          toolInput: exec.arguments,
          toolUseId: String(exec.callId),
        })
        const result = await runKernel(classicEvent('PreToolUse', payload), preRegistrations)
        const denied = result.decisions.find((decision): decision is { kind: 'deny'; reason: string } => decision.kind === 'deny')
        if (denied !== undefined) return { kind: 'deny', reason: denied.reason }
        return next()
      }),
    )
  }

  const postRegistrations = of('PostToolUse').map((hook, index) =>
    classicHookRegistration({
      event: hook.event,
      matcher: hook.matcher,
      timeoutMs: hookBudgetMs(hook),
      source: `${hook.event}#${hook.index ?? index}`,
      run: async (_context, event) => {
        const changed = artifactChange(hook)
        if (changed !== undefined) {
          warn(changed)
          return { kind: 'text', text: changed }
        }
        const verdict = await execute(hook, event)
        if (verdict.additionalContext !== undefined && verdict.deny !== undefined) {
          return { kind: 'result', result: [verdict.additionalContext, verdict.deny] }
        }
        if (verdict.deny !== undefined) return { kind: 'deny', reason: verdict.deny }
        if (verdict.additionalContext !== undefined) return { kind: 'text', text: verdict.additionalContext }
        return CONTINUE
      },
    }),
  )
  if (postRegistrations.length > 0) {
    ctx.effect(() =>
      ctx.on('tools/post-execute', async (exec: ExecView, result: unknown, next: () => Promise<PostDecision>) => {
        // As with pre-execute: a seat owns the mixed chain; this global
        // fallback only covers calls outside every seat (classic-only probe).
        if (seatForAgent(exec.agent) !== undefined) return next()
        const decision = await next()
        if (decision.kind !== 'accept') return decision
        const before = decision.additionalContexts ?? []
        const contexts: unknown[] = [...before]
        const payload = buildHookPayload('PostToolUse', {
          toolName: exec.name,
          toolInput: exec.arguments,
          toolUseId: String(exec.callId),
          toolResponse: result,
        })
        // PostToolUse is feedback, never a block: every matching handler runs
        // and its collected decision is folded into additionalContexts. A
        // denial is feedback too — the call already ran — so it is text here,
        // never a chain stop.
        const run = await runKernel(classicEvent('PostToolUse', payload), postRegistrations)
        for (const outcome of run.decisions) {
          for (const text of decisionTexts(outcome)) contexts.push(textContext(text))
        }
        if (contexts.length === before.length) return decision
        return { ...decision, additionalContexts: contexts }
      }),
    )
  }

  /**
   * One lifecycle mount for all five events: matcher, artifact re-hash, spawn
   * and verdict translation are the same code the tool mounts use. The host
   * event is an emit or a serial, never a waterfall, so a decision is reported
   * and dropped rather than applied; every handler returns CONTINUE so the
   * kernel still runs all matching hooks.
   */
  const lifecycleRegistrations = new Map<string, HandlerRegistration[]>()
  const modsMode = mods.length > 0
  const lifecycle = <T>(
    event: (typeof LIFECYCLE_EVENTS)[number],
    host: string,
    read: (value: T) => LifecycleOccurrence | undefined,
    mount = true,
  ): void => {
    const selected = of(event)
    if (selected.length === 0) return
    const registrations = selected.map((hook, index) =>
      classicHookRegistration({
        event: hook.event,
        matcher: hook.matcher,
        timeoutMs: hookBudgetMs(hook),
        source: `${hook.event}#${hook.index ?? index}`,
        run: async (_context, chainEvent) => {
          const changed = artifactChange(hook)
          if (changed !== undefined) {
            warn(changed)
            return CONTINUE
          }
          const verdict = await execute(hook, chainEvent)
          if (verdict.additionalContext !== undefined) {
            warn(`anyplugin hook ${event}: ${host} has no context channel; additionalContext reported, not delivered`)
          }
          if (verdict.deny !== undefined) {
            warn(`anyplugin hook ${event}: ${textify(verdict.deny)} cannot be enforced through ${host}; reported, not obeyed`)
          }
          return CONTINUE
        },
      }),
    )
    lifecycleRegistrations.set(event, registrations)
    // With mods loaded, the seat owns every lifecycle chain (one chain per
    // agent channel). The generic mount would be a second dispatch of the
    // same classic registration, which fan-out would run twice.
    if (!mount) return
    ctx.effect(() =>
      ctx.on(host, async (value: T) => {
        const occurrence = read(value)
        if (occurrence === undefined) return
        const payload = { hook_event_name: event, cwd: process.cwd(), ...occurrence.fields }
        const chainEvent = classicEvent(event, payload)
        // A host event with no matcher subject skips every authored matcher;
        // the kernel records that, and this front-end reports it (D19).
        if (chainEvent.subject === null) {
          for (const hook of selected) {
            if (hook.matcher !== undefined && hook.matcher !== '') {
              warn(`anyplugin hook ${event}: matcher ${JSON.stringify(hook.matcher)} has no value in ${host}; skipped`)
            }
          }
        }
        await runKernel(chainEvent, registrations)
      }),
    )
  }

  lifecycle<RootAgentEvent>('SessionStart', 'agent/created', (value) => {
    if (!isRoot(value)) return undefined
    const fields = rootFields(value)
    if (value.source !== undefined) fields.source = value.source
    const model = modelName(value)
    if (model !== undefined) fields.model = model
    return { fields }
  }, !modsMode)
  // Stop and SessionEnd carry the agent only; the session id and cwd still come
  // from the header. No matcher subject exists for either, so a configured
  // matcher is reported and skipped rather than silently ignored.
  lifecycle<RootAgentEvent>('Stop', 'agent/turn-stopping', (value) =>
    isRoot(value) ? { fields: rootFields(value) } : undefined,
  !modsMode)
  lifecycle<RootAgentEvent>('SessionEnd', 'agent/disposed', (value) =>
    isRoot(value) ? { fields: rootFields(value) } : undefined,
  !modsMode)
  lifecycle<SubagentEvent>('SubagentStart', 'subagent/start', (value) =>
    value.parentSessionId === undefined
      ? undefined
      : {
          fields: {
            session_id: value.parentSessionId,
            ...(value.id === undefined ? {} : { agent_id: value.id }),
          },
        },
  !modsMode)
  lifecycle<SubagentEvent>('SubagentStop', 'subagent/end', (value) => {
    if (value.parentSessionId === undefined) return undefined
    const last = messageText(value.lastAssistantMessage)
    return {
      fields: {
        session_id: value.parentSessionId,
        ...(value.id === undefined ? {} : { agent_id: value.id }),
        ...(last === undefined ? {} : { last_assistant_message: last }),
      },
    }
  }, !modsMode)

  if (modsMode) {
    const classicByEvent = (event: string): HandlerRegistration[] => {
      if (event === 'PreToolUse') return preRegistrations
      if (event === 'PostToolUse') return postRegistrations
      return lifecycleRegistrations.get(event) ?? []
    }
    const modByEvent = new Map<string, HandlerRegistration[]>()
    const pluginName = config.plugin ?? 'mod'
    const modRoot = config.pluginRoot ?? process.cwd()

    for (const mod of mods) {
      let handle: LoadedMod
      try {
        handle = await loadMod({ root: modRoot, entry: mod.entry, host: modHost })
      } catch (error) {
        warn(`anyplugin mod ${pluginName}/${mod.entry}: load refused (${(error as Error).message})`)
        continue
      }
      // One realm per mod, owned by the plugin entry (D31): unloading the
      // plugin disposes the realm; the entries' own ctx effects remove every
      // seat listener in the same step.
      ctx.effect(() => () => handle.dispose())
      const adapted = modRegistrationsToKernel(handle.registrations, {
        plugin: pluginName,
        entry: mod.entry,
        ...(mod.tier === undefined ? {} : { tier: mod.tier }),
        ...(mod.timeoutMs === undefined ? {} : { timeoutMs: mod.timeoutMs }),
      })
      for (const registration of adapted.registrations) {
        const bucket = modByEvent.get(registration.event)
        if (bucket === undefined) modByEvent.set(registration.event, [registration])
        else bucket.push(registration)
      }
      for (const row of adapted.unmapped) {
        warn(`anyplugin mod ${row.source}: ${row.reason}`)
      }
    }

    /** One chain per host event: the mod's wrap handlers first, then classic. */
    const combined = (event: string): HandlerRegistration[] => [
      ...(modByEvent.get(event) ?? []),
      ...classicByEvent(event),
    ]

    // `session.start` is a loader point, not an agent event (D32 §4): it fires
    // once per load, before the plugin's first turn, from the same async apply
    // that loaded the realm. The loader awaits this apply, so the first turn
    // cannot start before the fire settles. A reload runs a new apply and thus
    // a new fire with exactly this load's registrations.
    const sessionStart = modByEvent.get('session.start') ?? []
    if (sessionStart.length > 0) {
      const event: ChainEvent = {
        name: 'session.start',
        subject: null,
        data: { cwd: modRoot, surface: null, isInteractive: false },
      }
      await runKernel(event, sessionStart)
    }

    const createSeat = (agent: any): void => {
      const header = agent?.session?.header
      const id = header?.id
      if (id === undefined) {
        warn(`anyplugin mod ${pluginName}: agent/created carried no session id; not seated`)
        return
      }
      const key = String(id)
      if (seats.has(key)) return
      const agentCtx = agent.ctx
      if (agentCtx === undefined || agentCtx === null || typeof agentCtx.on !== 'function') {
        warn(`anyplugin mod ${pluginName}: agent/created carried no agent ctx; not seated`)
        return
      }
      // The seat's listeners are owned by the plugin effect (so unloading the
      // plugin removes them) and additionally disposed when this agent goes
      // away. A subagent must not leave five listeners on a dead context.
      const disposers: Array<() => void> = []
      const mount = (listener: () => unknown): void => {
        const dispose = ctx.effect(listener)
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
      }
      seats.set(key, {
        agent,
        ctx: agentCtx,
        dispose: () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try {
              dispose()
            } catch {
              // The plugin effect may already have disposed this listener.
            }
          }
          parentBySession.delete(key)
        },
      })
      parentBySession.set(key, header.parentSession)

      mount(() =>
        agentCtx.on('tools/pre-execute', async (exec: ExecView, next: () => Promise<unknown>) => {
          const payload = buildHookPayload('PreToolUse', {
            toolName: exec.name,
            toolInput: exec.arguments,
            toolUseId: String(exec.callId),
            cwd: typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined,
          })
          const result = await runKernel(classicEvent('PreToolUse', payload), combined('PreToolUse'), agent)
          const denied = result.decisions.find(
            (decision): decision is { kind: 'deny'; reason: string } => decision.kind === 'deny',
          )
          if (denied !== undefined) return { kind: 'deny', reason: denied.reason }
          const rewritten = result.event?.data
          const toolInput = rewritten !== null && typeof rewritten === 'object'
            ? (rewritten as Record<string, unknown>).tool_input
            : undefined
          if (toolInput !== null && typeof toolInput === 'object') {
            // Same chain, same seam: the pre-execute gate has no value channel,
            // so the host applies the chain's final rewrite to the execution
            // object before calling next(). The executor reads exec.arguments
            // at dispatch time; the original snapshot stays frozen and unused.
            ;(exec as { arguments: unknown }).arguments = toolInput
          }
          return next()
        }),
      )

      mount(() =>
        agentCtx.on('tools/post-execute', async (exec: ExecView, result: unknown, next: () => Promise<PostDecision>) => {
          const decision = await next()
          if (decision.kind !== 'accept') return decision
          const before = decision.additionalContexts ?? []
          const contexts: unknown[] = [...before]
          const payload = buildHookPayload('PostToolUse', {
            toolName: exec.name,
            toolInput: exec.arguments,
            toolUseId: String(exec.callId),
            toolResponse: result,
            cwd: typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined,
          })
          const run = await runKernel(classicEvent('PostToolUse', payload), combined('PostToolUse'), agent)
          for (const outcome of run.decisions) {
            for (const text of decisionTexts(outcome)) contexts.push(textContext(text))
          }
          if (contexts.length === before.length) return decision
          return { ...decision, additionalContexts: contexts }
        }),
      )

      mount(() =>
        agentCtx.on('agent/turn-stopping', async (value: RootAgentEvent) => {
          if (!isRoot(value)) return
          const occurrence = { fields: rootFields(value) }
          const payload = { hook_event_name: 'Stop', cwd: process.cwd(), ...occurrence.fields }
          await runKernel(classicEvent('Stop', payload), combined('Stop'), agent)
        }),
      )

      mount(() =>
        agentCtx.on('subagent/start', async (value: SubagentEvent) => {
          if (value.parentSessionId === undefined) return
          const payload = {
            hook_event_name: 'SubagentStart',
            cwd: process.cwd(),
            session_id: value.parentSessionId,
            ...(value.id === undefined ? {} : { agent_id: value.id }),
          }
          await runKernel(classicEvent('SubagentStart', payload), combined('SubagentStart'), agent)
        }),
      )

      mount(() =>
        agentCtx.on('subagent/end', async (value: SubagentEvent) => {
          if (value.parentSessionId === undefined) return
          const last = messageText(value.lastAssistantMessage)
          const payload = {
            hook_event_name: 'SubagentStop',
            cwd: process.cwd(),
            session_id: value.parentSessionId,
            ...(value.id === undefined ? {} : { agent_id: value.id }),
            ...(last === undefined ? {} : { last_assistant_message: last }),
          }
          await runKernel(classicEvent('SubagentStop', payload), combined('SubagentStop'), agent)
        }),
      )
    }

    // Every agent gets a seat, but SessionStart is a root-session event: a
    // subagent's `agent/created` must not run the plugin's SessionStart again.
    // The seat is created first so the SessionStart chain (a mod's
    // classic.SessionStart and the plugin's classic SessionStart hooks) runs on
    // the agent channel itself.
    ctx.effect(() =>
      ctx.on('agent/created', async (value: RootAgentEvent) => {
        const agent = (value as { agent?: any }).agent
        if (agent === undefined || agent === null) return
        createSeat(agent)
        if (!isRoot(value)) return
        const fields = rootFields(value)
        if (value.source !== undefined) fields.source = value.source
        const model = modelName(value)
        if (model !== undefined) fields.model = model
        const payload = { hook_event_name: 'SessionStart', cwd: process.cwd(), ...fields }
        await runKernel(classicEvent('SessionStart', payload), combined('SessionStart'), agent)
      }),
    )

    // SessionEnd stays on the plugin channel: an agent's own ctx may be
    // disposing when `agent/disposed` is emitted, and the seat must be gone
    // before the plugin entry unloads. A subagent disposal removes its seat but
    // does not end the root session.
    ctx.effect(() =>
      ctx.on('agent/disposed', async (value: RootAgentEvent) => {
        const header = value.agent?.session?.header
        const id = header?.id
        if (id !== undefined) {
          const seat = seats.get(String(id))
          if (seat !== undefined) {
            seat.dispose()
            seats.delete(String(id))
          }
        }
        if (!isRoot(value)) return
        const payload = { hook_event_name: 'SessionEnd', cwd: process.cwd(), ...rootFields(value) }
        await runKernel(classicEvent('SessionEnd', payload), combined('SessionEnd'), value.agent)
      }),
    )
  }

  const mounted = new Set<string>(['PreToolUse', 'PostToolUse', ...LIFECYCLE_EVENTS])
  const unmounted = hooks.filter((hook) => !mounted.has(hook.event))
  for (const hook of unmounted) {
    warn(`anyplugin hook ${hook.event}: no host event fires here; not mounted (${textify(hook.matcher ?? '*')})`)
  }
}
