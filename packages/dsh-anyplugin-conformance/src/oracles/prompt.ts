/**
 * Prompt oracle — boots the pinned harness, materializes a loader entry, runs
 * one real agent turn, and returns the composed system prompt the model
 * actually received.
 *
 * This is the observation an output-style activation needs (ticket #77): the
 * style body is prompt text, so the only honest assertion is against the bytes
 * composed for a turn, not against the skill/tool inventory. The model is a
 * local stub adapter (S9); the session, agent loop, prompt assembly and section
 * waterfall are the resolved harness's own.
 *
 * The baseline control is a real turn on an agent created *before* the entry
 * loads: a plugin that never applies cannot change that prompt, so a test can
 * compare the same boot's before/after bytes instead of a hard-coded host
 * prompt that would drift with the pin.
 */
import type { EntryOptions } from '../../dsh-anyplugin-emit/src/index.ts'
import { readHarnessVersion } from '../harness.ts'
import { loadFromHarness, loaderBaseUrl, until } from './dsh.ts'

export type PromptAgentRole = 'main' | 'sibling' | 'subagent' | 'fork'

export interface PromptProbeOptions {
  /** Directory holding the harness's `@deepseek-ai/*` packages. */
  harnessDir: string
  /** The group entry to load; `null` runs the control turn only. */
  entry: EntryOptions | null
  /** Run a turn on an agent created before the entry loads; its prompt is `baseline`. */
  baseline?: boolean
  /** User text for the post-load turn. Unique per probe, so calls are attributable. */
  text?: string
  /** How long to wait for boot and each turn, in milliseconds. */
  timeoutMs?: number
  /**
   * Extra agents to create and run after the entry loads. `main` is always
   * created; `sibling` is another top-level agent, `subagent` a session with
   * `origin: 'subagent'`, and `fork` a seeded continuation of `main`.
   */
  roles?: readonly PromptAgentRole[]
}

export interface PromptProbeResult {
  /** System prompt of the pre-load control agent, when `baseline` was asked. */
  baseline?: string
  /** System prompt of the agent created after the entry loaded and settled. */
  prompt: string
  /** Every system prompt captured, in model-call order (diagnostics). */
  prompts: string[]
  dshVersion: string
  /** The prompt each requested non-main role received, keyed by role. */
  rolePrompts?: Partial<Record<PromptAgentRole, string>>
}

const textChunks = (text: string): unknown[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: 'stop' },
]

function messageText(message: any): string {
  if (typeof message?.content === 'string') return message.content
  return (message?.content ?? [])
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => block.text)
    .join('')
}

export async function probePromptWithDsh(options: PromptProbeOptions): Promise<PromptProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const { Context } = await loadFromHarness(options.harnessDir, 'cordis/lib/index.js')
  const Loader = (await loadFromHarness(options.harnessDir, 'cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await loadFromHarness(options.harnessDir, 'dsh-skill/lib/index.js')).default
  const SessionStore = (await loadFromHarness(options.harnessDir, 'dsh-session/lib/index.js')).default
  const SessionProjections = (await loadFromHarness(options.harnessDir, 'dsh-session-projection/lib/index.js')).default
  const SystemPrompt = (await loadFromHarness(options.harnessDir, 'dsh-system-prompt/lib/index.js')).default
  const ToolsService = (await loadFromHarness(options.harnessDir, 'dsh-tools/lib/index.js')).default
  const AgentRegistry = (await loadFromHarness(options.harnessDir, 'dsh-agent/lib/index.js')).default
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await loadFromHarness(options.harnessDir, 'dsh-llm/lib/index.js')
  const AgentLoop = (await loadFromHarness(options.harnessDir, 'dsh-agent-loop/lib/index.js')).default
  const nativeExecutor = await loadFromHarness(options.harnessDir, 'dsh-tool-executor-native/lib/index.js')

  const captured: Array<{ system?: string; texts: string[] }> = []
  class Capture extends LlmAdapter {
    async resolveModel(provider: string, model: string): Promise<unknown> {
      return { provider, id: model, name: model, context: { contextWindow: 8192 }, defaultMaxTokens: 1024 }
    }

    async *stream(input: any): AsyncGenerator<unknown> {
      const messages = (input.messages ?? []).map((message: any) => ({ role: message.role, text: messageText(message) }))
      captured.push({
        system: messages.find((message: any) => message.role === 'system')?.text,
        texts: messages.map((message: any) => message.text),
      })
      for (const chunk of textChunks('stub answer')) yield chunk
    }
  }

  const ctx = new Context()
  const loaderFiber = ctx.plugin(Loader, { baseUrl: loaderBaseUrl(options.harnessDir) })
  ctx.plugin(SkillRegistry, {})
  ctx.plugin(SessionStore)
  ctx.plugin(SessionProjections)
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolsService, {})
  ctx.plugin(AgentRegistry)
  ctx.plugin(nativeExecutor, {})
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentLoop)

  const promptFor = (needle: string): string | undefined => {
    const call = [...captured].reverse().find((entry) => entry.texts.some((text) => text.includes(needle)))
    return call?.system
  }

  const waitTurnEnd = (sessionId: string, turn: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`dsh prompt probe: turn ${turn} on ${sessionId} did not end`)),
        timeoutMs,
      )
      const off = ctx.on('session/event', (session: { id?: unknown }, event: { type?: string; data?: { turn?: number } }) => {
        if (session.id !== sessionId) return
        if (event.type === 'turn/end' && event.data?.turn === turn) {
          clearTimeout(timer)
          off()
          resolve()
        }
      })
    })

  const makeAgent = (id: string): Promise<any> => ctx.agentLoop.create(id, { provider: 'fake', model: 'fake-1' })
  const runTurn = async (agent: any, text: string): Promise<void> => {
    const ended = waitTurnEnd(agent.id, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await ended
  }

  try {
    for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents']) {
      await until(() => Boolean(ctx.get(name)), timeoutMs, `${name} service`)
    }
    ctx.llm.registerAdapter(['fake'], new Capture())
    await until(() => Boolean(ctx.get('llm')), timeoutMs, 'llm service')
    await until(() => Boolean(ctx.get('agentLoop')), timeoutMs, 'agent loop service')

    let baseline: string | undefined
    if (options.baseline === true) {
      const control = await makeAgent('anyplugin-prompt-baseline')
      await runTurn(control, 'baseline prompt turn')
      baseline = promptFor('baseline prompt turn')
      if (baseline === undefined) throw new Error('dsh prompt probe: the control turn produced no system prompt')
    }

    if (options.entry !== null) {
      await ctx.loader.create(options.entry)
      await ctx.loader.await()
    }

    const text = options.text ?? 'probe prompt turn'
    const agent = await makeAgent('anyplugin-prompt-agent')
    await runTurn(agent, text)
    const prompt = promptFor(text)
    if (prompt === undefined) throw new Error('dsh prompt probe: the probe turn produced no system prompt')

    const roles = new Set(options.roles ?? [])
    const rolePrompts: Partial<Record<PromptAgentRole, string>> = {}
    const handles: Array<{ dispose(): Promise<void> | void }> = []
    const runRole = async (role: PromptAgentRole, target: any): Promise<void> => {
      if (!roles.has(role)) return
      const roleText = `${text} as ${role}`
      await runTurn(target, roleText)
      const rolePrompt = promptFor(roleText)
      if (rolePrompt === undefined) throw new Error(`dsh prompt probe: the ${role} turn produced no system prompt`)
      rolePrompts[role] = rolePrompt
    }

    if (roles.has('sibling')) {
      await runRole('sibling', await makeAgent('anyplugin-prompt-sibling'))
    }
    if (roles.has('subagent') || roles.has('fork')) {
      const factory = (ctx as any).agents
      if (!factory || typeof factory.create !== 'function') {
        throw new Error('dsh prompt probe: the agents registry has no create() for role agents')
      }
      const agentOptions = { provider: 'fake', model: 'fake-1' }
      if (roles.has('subagent')) {
        const handle = await factory.create({
          sessionId: 'anyplugin-prompt-subagent',
          meta: { origin: 'subagent', parentSession: agent.id },
          agentOptions,
        })
        handles.push(handle)
        await runRole('subagent', handle.agent)
      }
      if (roles.has('fork')) {
        const handle = await factory.create({
          sessionId: 'anyplugin-prompt-fork',
          meta: { parentSession: agent.id, isSeeded: true },
          inheritedEventCount: 0,
          seed: [],
          agentOptions,
        })
        handles.push(handle)
        await runRole('fork', handle.agent)
      }
    }

    for (const handle of handles) {
      try {
        await handle.dispose()
      } catch {
        // The prompt was already captured; teardown failures are not the probe.
      }
    }

    return {
      ...(baseline === undefined ? {} : { baseline }),
      prompt,
      prompts: captured.map((call) => call.system).filter((value): value is string => value !== undefined),
      dshVersion: readHarnessVersion(options.harnessDir),
      ...(Object.keys(rolePrompts).length === 0 ? {} : { rolePrompts }),
    }
  } finally {
    loaderFiber.dispose?.()
  }
}
