/**
 * Hook materializer — mounts a plugin's command hooks on this host's tool
 * waterfalls.
 *
 * Mount points are the ones S8 proved: `tools/pre-execute` can deny (the model
 * reads `Error: <reason>`), `tools/post-execute` can attach additionalContexts.
 * Every listener is registered through `ctx.effect` so unloading the plugin
 * removes it (S1 finding 3).
 *
 * PreToolUse runs *before* the host dispatches; the first denial wins, matching
 * the upstream "block" semantics. PostToolUse runs after the call settled and
 * only when it was accepted — a failed call takes the upstream's separate
 * PostToolUseFailure path, which has no host event yet.
 */
import {
  buildHookPayload,
  judgeHookResult,
  matcherMatches,
  runCommandHook,
} from '../../dsh-anyplugin-hook-runner/src/index.ts'
import { hashHook } from '../../dsh-anyplugin-trust/src/index.ts'

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
  /** How the pin was taken: bytes on disk, or the command text/structure. */
  artifactMode?: 'file' | 'inline'
  artifactRoot?: string
}

export interface Config {
  /** Directory the plugin was loaded from; `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRoot?: string
  /** Persistent directory across versions; `${CLAUDE_PLUGIN_DATA}`. */
  pluginData?: string
  hooks?: MaterialHook[]
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

const textify = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function apply(ctx: any, config: Config = {}): void {
  const hooks = config.hooks ?? []
  if (hooks.length === 0) return

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (config.pluginRoot !== undefined) env.CLAUDE_PLUGIN_ROOT = config.pluginRoot
  if (config.pluginData !== undefined) env.CLAUDE_PLUGIN_DATA = config.pluginData
  env.CLAUDE_PROJECT_DIR = process.cwd()

  /**
   * Re-check the bytes immediately before every spawn (D25). A grant is
   * checked at reconcile time, but the file can change between reconcile and
   * the next tool call; pinning the hash in the child config and re-reading
   * here is what makes "any change invalidates" true at the only moment it
   * matters. One file read per matched hook call is acceptable: a hook that
   * runs is already spawning a process.
   */
  const artifactChange = (hook: MaterialHook): string | undefined => {
    if (hook.artifactHash === undefined) return undefined
    const root = hook.artifactRoot ?? config.pluginRoot
    if (root === undefined) {
      return `refused ${hook.event}#${hook.index ?? 0}: no plugin root to re-hash the artifact; pinned ${hook.artifactHash}`
    }
    const invocation = hook.args === undefined
      ? hook.command
      : [hook.command, ...hook.args].map((part) => JSON.stringify(part)).join(' ')
    let current
    try {
      current = hashHook(root, {
        kind: 'hook',
        event: hook.event,
        index: hook.index ?? 0,
        handler: 'command',
        command: hook.command,
        ...(hook.args === undefined ? {} : { args: hook.args }),
        sourcePath: 'hooks/hooks.json',
        annotation: { fidelity: 'exact', reason: 'materializer re-hash adapter' },
      })
    } catch (error) {
      return `refused ${hook.event}#${hook.index ?? 0}: artifact cannot be re-hashed (${(error as Error).message}); pinned ${hook.artifactHash}; command: ${invocation}`
    }
    if (hook.artifactMode !== undefined && current.mode !== hook.artifactMode) {
      return `refused ${hook.event}#${hook.index ?? 0}: artifact is no longer a ${hook.artifactMode} (pinned ${hook.artifactHash}, now ${current.mode} ${current.artifactHash}); command: ${invocation}`
    }
    if (current.artifactHash === hook.artifactHash) return undefined
    return `refused ${hook.event}#${hook.index ?? 0}: artifact changed since the grant (pinned ${hook.artifactHash}, now ${current.artifactHash}); command: ${invocation}`
  }

  const warn = (message: string): void => {
    const logger = ctx.logger
    if (typeof logger?.warn === 'function') logger.warn(message)
    else if (typeof logger === 'function') logger(message)
  }

  const of = (event: string): MaterialHook[] =>
    hooks.filter((hook) => hook.event === event).sort((a, b) => (a.matcher ?? '').localeCompare(b.matcher ?? ''))

  const pre = of('PreToolUse')
  if (pre.length > 0) {
    ctx.effect(() =>
      ctx.on('tools/pre-execute', async (exec: ExecView, next: () => Promise<unknown>) => {
        for (const hook of pre) {
          if (!matcherMatches(hook.matcher, exec.name)) continue
          const changed = artifactChange(hook)
          if (changed !== undefined) return { kind: 'deny', reason: changed }
          const payload = buildHookPayload('PreToolUse', {
            toolName: exec.name,
            toolInput: exec.arguments,
            toolUseId: String(exec.callId),
          })
          const result = await runCommandHook(hook, payload, { env })
          const verdict = judgeHookResult(result, 'PreToolUse')
          if (verdict.warn !== undefined) warn(`anyplugin hook PreToolUse: ${verdict.warn}`)
          if (verdict.deny !== undefined) return { kind: 'deny', reason: verdict.deny }
        }
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
        const contexts: unknown[] = [...(decision.additionalContexts ?? [])]
        for (const hook of post) {
          if (!matcherMatches(hook.matcher, exec.name)) continue
          const changed = artifactChange(hook)
          if (changed !== undefined) {
            warn(changed)
            contexts.push({ role: 'user', content: [{ type: 'text', text: changed }] })
            continue
          }
          const payload = buildHookPayload('PostToolUse', {
            toolName: exec.name,
            toolInput: exec.arguments,
            toolUseId: String(exec.callId),
            toolResponse: result,
          })
          const ran = await runCommandHook(hook, payload, { env })
          const verdict = judgeHookResult(ran, 'PostToolUse')
          if (verdict.warn !== undefined) warn(`anyplugin hook PostToolUse: ${verdict.warn}`)
          if (verdict.additionalContext !== undefined) {
            contexts.push({ role: 'user', content: [{ type: 'text', text: verdict.additionalContext }] })
          }
          // A PostToolUse denial is feedback, not a block: the call already ran.
          if (verdict.deny !== undefined) {
            contexts.push({ role: 'user', content: [{ type: 'text', text: verdict.deny }] })
          }
        }
        if (contexts.length === (decision.additionalContexts ?? []).length) return decision
        return { ...decision, additionalContexts: contexts }
      }),
    )
  }

  const unmounted = hooks.filter((hook) => hook.event !== 'PreToolUse' && hook.event !== 'PostToolUse')
  for (const hook of unmounted) {
    warn(`anyplugin hook ${hook.event}: no host event fires here; recorded but not mounted (${textify(hook.matcher ?? '*')})`)
  }
}
