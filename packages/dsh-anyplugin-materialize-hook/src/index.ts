/**
 * Hook materializer — mounts a plugin's command hooks on this host's tool
 * waterfalls and on the host events that carry the five lifecycle hooks.
 *
 * Mount points are the ones S8/S9 proved: `tools/pre-execute` can deny (the
 * model reads `Error: <reason>`), `tools/post-execute` can attach
 * additionalContexts, and `agent/created`, `agent/turn-stopping`,
 * `agent/disposed`, `subagent/start` and `subagent/end` carry SessionStart,
 * Stop, SessionEnd, SubagentStart and SubagentStop. Every listener is
 * registered through `ctx.effect` so unloading the plugin removes it
 * (S1 finding 3).
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
import { mkdirSync } from 'node:fs'
import {
  CONTINUE,
  classicEvent,
  classicHookRegistration,
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

export interface Config {
  /** Directory the plugin was loaded from; `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRoot?: string
  /** Persistent directory across versions; `${CLAUDE_PLUGIN_DATA}`. */
  pluginData?: string
  hooks?: MaterialHook[]
  /**
   * Diagnostic sink for the kernel trace of every chain run. The conformance
   * rig uses it to diff hook steps; it must not change hook behavior, and a
   * sink that throws is reported as a warning rather than failing the turn.
   */
  onTrace?: (event: string, result: ChainResult) => void
}

interface ExecView {
  callId: string | number
  name: string
  arguments: unknown
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

export function apply(ctx: any, config: Config = {}): void {
  const hooks = config.hooks ?? []
  if (hooks.length === 0) return

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (config.pluginRoot !== undefined) env.CLAUDE_PLUGIN_ROOT = config.pluginRoot
  if (config.pluginData !== undefined) env.CLAUDE_PLUGIN_DATA = config.pluginData
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

  const runKernel = async (event: ChainEvent, registrations: readonly HandlerRegistration[]): Promise<ChainResult> => {
    const result = await runChain(event, registrations, {
      continuation: 'fan-out',
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS + KERNEL_GRACE_MS,
      deadlineMs: registrations.reduce((total, registration) => total + (registration.timeoutMs ?? 0), 0),
    })
    try {
      config.onTrace?.(event.name, result)
    } catch (error) {
      warn(`anyplugin hook ${event.name}: trace observer failed (${(error as Error).message})`)
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

  const pre = of('PreToolUse')
  if (pre.length > 0) {
    const registrations = pre.map((hook, index) =>
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
    ctx.effect(() =>
      ctx.on('tools/pre-execute', async (exec: ExecView, next: () => Promise<unknown>) => {
        const payload = buildHookPayload('PreToolUse', {
          toolName: exec.name,
          toolInput: exec.arguments,
          toolUseId: String(exec.callId),
        })
        const result = await runKernel(classicEvent('PreToolUse', payload), registrations)
        const denied = result.decisions.find((decision): decision is { kind: 'deny'; reason: string } => decision.kind === 'deny')
        if (denied !== undefined) return { kind: 'deny', reason: denied.reason }
        return next()
      }),
    )
  }

  const post = of('PostToolUse')
  if (post.length > 0) {
    ctx.effect(() =>
      ctx.on('tools/post-execute', async (exec: ExecView, result: unknown, next: () => Promise<PostDecision>) => {
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
        const registrations = post.map((hook, index) =>
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
        const run = await runKernel(classicEvent('PostToolUse', payload), registrations)
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
  const lifecycle = <T>(
    event: (typeof LIFECYCLE_EVENTS)[number],
    host: string,
    read: (value: T) => LifecycleOccurrence | undefined,
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
  })
  // Stop and SessionEnd carry the agent only; the session id and cwd still come
  // from the header. No matcher subject exists for either, so a configured
  // matcher is reported and skipped rather than silently ignored.
  lifecycle<RootAgentEvent>('Stop', 'agent/turn-stopping', (value) =>
    isRoot(value) ? { fields: rootFields(value) } : undefined,
  )
  lifecycle<RootAgentEvent>('SessionEnd', 'agent/disposed', (value) =>
    isRoot(value) ? { fields: rootFields(value) } : undefined,
  )
  lifecycle<SubagentEvent>('SubagentStart', 'subagent/start', (value) =>
    value.parentSessionId === undefined
      ? undefined
      : {
          fields: {
            session_id: value.parentSessionId,
            ...(value.id === undefined ? {} : { agent_id: value.id }),
          },
        },
  )
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
  })

  const mounted = new Set<string>(['PreToolUse', 'PostToolUse', ...LIFECYCLE_EVENTS])
  const unmounted = hooks.filter((hook) => !mounted.has(hook.event))
  for (const hook of unmounted) {
    warn(`anyplugin hook ${hook.event}: no host event fires here; not mounted (${textify(hook.matcher ?? '*')})`)
  }
}
