/**
 * DSH-side oracle — boots the *resolved* harness packages and reads what they
 * report about a plugin we materialized.
 *
 * The harness may be the Desktop installation or a released npm harness fetched
 * into `.harness/<version>` by `scripts/fetch-harness.mjs`; `harness.ts` owns the
 * resolution order and reports which source named the tree. Either way the tree
 * is a real directory of `@deepseek-ai/*` packages, so plain Node can import it,
 * and the oracle runs whatever pin was resolved instead of assuming a version.
 *
 * One rule that is easy to get wrong: the `Context` must come from the
 * *harness* cordis. Two copies of cordis in one process give two `Service`
 * base classes, and the registry would never see the context that owns it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EntryOptions } from '../../dsh-anyplugin-emit/src/index.ts'
import type { Inventory } from '../inventory.ts'
import { emptyInventory, INVENTORY_SCHEMA } from '../inventory.ts'
import { readHarnessVersion } from '../harness.ts'

export interface DshProbeOptions {
  /** Directory holding the harness's `@deepseek-ai/*` packages (`HarnessLocation.harnessDir`). */
  harnessDir: string
  /** The group entry the emitter produced. */
  entry: EntryOptions
  /** How long to wait for plugins to apply, in milliseconds. */
  timeoutMs?: number
  /**
   * Fire one real tool call after the plugin settled. This is how a hook is
   * observed: a hook that never runs and a hook that runs but changes nothing
   * both leave the inventory untouched, so the caller has to read the result.
   */
  behavior?: BehaviorProbe
}

export interface BehaviorProbe {
  /** Tool name the fixture's matcher targets, e.g. `Write`. */
  tool: string
  arguments?: unknown
}

export interface BehaviorObservation {
  /** The tool result as the model would receive it, JSON-encoded. */
  text: string
  isError: boolean
}

export interface DshSkillReport {
  name: string
  description: string
  provider: string
}

export interface DshProbeResult {
  inventory: Inventory
  dshVersion: string
  skills: DshSkillReport[]
  /** Public tool names the harness actually exposes, for MCP and agent assertions. */
  tools: string[]
  /** The public schemas behind {@link tools}; agent rows compare `description` byte for byte. */
  toolSchemas: Array<{ name: string; description?: string }>
  /** Present when the caller asked for a behavioural probe. */
  behavior?: BehaviorObservation
}

interface BootedHarness {
  ctx: any
  loader: any
  /** The fiber that owns the loader; disposing it tears down every entry. */
  loaderFiber: any
  skills: any
  tools: any
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function loadFromHarness(harnessDir: string, specifier: string): Promise<any> {
  return import(pathToFileURL(join(harnessDir, specifier)).href)
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`dsh oracle: timed out waiting for ${label}`)
}

/**
 * The loader resolves entry names (notably `@deepseek-ai/cordis-plugin-group`)
 * against its config scope. A Desktop tree has the `dsh` package to anchor that
 * scope; an npm harness does not, so the install root (which carries the
 * `package.json` written by `fetch-harness.mjs`) is the anchor there.
 */
function loaderBaseUrl(harnessDir: string): string {
  const product = join(harnessDir, 'dsh')
  const anchor = existsSync(join(product, 'package.json')) ? product : join(harnessDir, '..', '..')
  return pathToFileURL(anchor + '/').href
}

async function boot(harnessDir: string, timeoutMs: number, needTools: boolean, needExecutor = false): Promise<BootedHarness> {
  const { Context } = await loadFromHarness(harnessDir, 'cordis/lib/index.js')
  const Loader = (await loadFromHarness(harnessDir, 'cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await loadFromHarness(harnessDir, 'dsh-skill/lib/index.js')).default

  const ctx = new Context()
  // Keep the fiber: `Loader` exposes no stop(), so the fiber *is* the teardown
  // handle (ARCHITECTURE §10.4). Disposing it runs every effect disposer.
  const loaderFiber = ctx.plugin(Loader, { baseUrl: loaderBaseUrl(harnessDir) })
  ctx.plugin(SkillRegistry, {})
  if (needTools) {
    // The tool registry reads the system prompt service; S5 booted the same pair.
    const SystemPrompt = (await loadFromHarness(harnessDir, 'dsh-system-prompt/lib/index.js')).default
    const ToolsService = (await loadFromHarness(harnessDir, 'dsh-tools/lib/index.js')).ToolsService
    ctx.plugin(SystemPrompt)
    await until(() => Boolean(ctx.systemPrompt), timeoutMs, 'system prompt service')
    ctx.plugin(ToolsService, {})
    await until(() => Boolean(ctx.tools), timeoutMs, 'tools service')
    if (needExecutor) {
      // Dispatch lives in a separate functional plugin (S8); without it a call
      // never reaches the tool waterfalls the hooks are mounted on.
      const nativeExecutor = await loadFromHarness(harnessDir, 'dsh-tool-executor-native/lib/index.js')
      ctx.plugin(nativeExecutor, {})
    }
  }
  await until(() => Boolean(ctx.loader) && Boolean(ctx.skills), timeoutMs, 'loader and skills services')
  return { ctx, loader: ctx.loader, loaderFiber, skills: ctx.skills, tools: ctx.tools }
}

/** The MCP child entry, when the emitter placed one. */
function mcpChild(entry: EntryOptions): { plugin: string; servers: Array<{ name: string }> } | undefined {
  const children = (entry.config ?? []) as Array<{ id?: string; config?: { plugin?: string; servers?: Array<{ name: string }> } }>
  const child = children.find((item) => item.id === 'mcp')
  if (child?.config?.plugin === undefined) return undefined
  return { plugin: child.config.plugin, servers: child.config.servers ?? [] }
}

/** The agents child, when the emitter placed one. */
function agentsChild(
  entry: EntryOptions,
): { plugin: string; agents: Array<{ name: string; toolName: string; description: string }> } | undefined {
  const children = (entry.config ?? []) as Array<{
    id?: string
    config?: { plugin?: unknown; agents?: Array<{ name?: unknown; description?: unknown }> }
  }>
  const child = children.find((item) => item.id === 'agents')
  if (!Array.isArray(child?.config?.agents)) return undefined
  const plugin = typeof child.config.plugin === 'string' ? child.config.plugin : ''
  if (plugin.trim() === '') return undefined
  // The materializer registers `<plugin>:<agent>` (S10); the expected name is
  // derived here rather than trusted from a per-agent field, so a config that
  // claims a different tool name cannot make the oracle agree with itself.
  const agents = child.config.agents
    .filter(
      (agent): agent is { name: string; description: string } =>
        typeof agent?.name === 'string' && typeof agent?.description === 'string',
    )
    .map((agent) => ({ name: agent.name, toolName: `${plugin}:${agent.name}`, description: agent.description }))
  return agents.length === 0 ? undefined : { plugin, agents }
}

/** Version of the harness packages under `harnessDir` (see `readHarnessVersion`). */
export function dshVersion(harnessDir: string): string {
  return readHarnessVersion(harnessDir)
}

/**
 * Materialize `entry` into a real harness, wait for the registry to settle, and
 * read the inventory back. The wait is stability-based rather than
 * count-based: a plugin that registers three skills and then one more should
 * not be sampled halfway.
 */
export async function probeWithDsh(options: DshProbeOptions): Promise<DshProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000
  const mcp = mcpChild(options.entry)
  const agents = agentsChild(options.entry)
  const wantTools = mcp !== undefined || agents !== undefined
  const behavior = options.behavior
  const booted = await boot(options.harnessDir, timeoutMs, wantTools || behavior !== undefined, behavior !== undefined)
  const { ctx, loader, skills } = booted

  try {
    await loader.create(options.entry)
    let lastSignature = ''
    let stable = 0
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const names = (await skills.list({})).map((skill: { name: string }) => skill.name).join(',')
      // MCP registration is asynchronous (connect, then list, then register), so
      // the signal has to include the tool names or the sample could land between
      // the handshake and the first registration. Agent tools register during
      // apply, but the inventory still reads the registry, so they belong to the
      // same signal.
      const toolNames = wantTools
        ? (ctx.tools?.schemas?.() ?? []).map((schema: { name: string }) => schema.name).join(',')
        : ''
      const signature = `${names}|${toolNames}`
      if (signature === lastSignature) stable += 1
      else {
        lastSignature = signature
        stable = 0
      }
      // An MCP registration is only observable once it happens, so "no change"
      // is not settle evidence until at least one tool exists; otherwise a slow
      // server would be reported as missing after one poll.
      const waiting = mcp !== undefined && toolNames === ''
      if (stable >= 3 && !waiting) break
      await sleep(10)
    }

    const listed = (await skills.list({})) as DshSkillReport[]
    const schemas = (booted.tools?.schemas?.() ?? []) as Array<{ name: string; description?: string }>
    const exposed: string[] = wantTools ? schemas.map((schema) => schema.name) : []

    // One real call through the pipeline. The tool is registered here, after the
    // plugin applied, so a hook mounted on the waterfall cannot be applied too
    // late to see it either.
    let observation: BehaviorObservation | undefined
    if (behavior !== undefined) {
      const disposeProbe = booted.tools.register({
        name: behavior.tool,
        description: 'anyplugin behavioural probe; returns the arguments it was given',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [] },
        execute: async (args: unknown) => ({ probe: true, received: args }),
      })
      try {
        const raw = await booted.tools.execute({
          calls: [
            {
              type: 'tool-call',
              id: 'call_anyplugin_probe',
              name: behavior.tool,
              arguments: JSON.stringify(behavior.arguments ?? {}),
            },
          ],
          signal: new AbortController().signal,
        })
        const text = JSON.stringify(raw) ?? ''
        observation = { text, isError: /"isError":true/.test(text) }
      } finally {
        disposeProbe()
      }
    }
    // A server is observable exactly when it contributes a tool: the inventory
    // reports what the model can call, not what a config file declared. The
    // dialect decided the prefix; an absent field means Claude's composition,
    // so the Claude path keeps its exact bytes (D11, D33).
    const toolPrefix = (server: { name: string; toolNamePrefix?: string }): string =>
      server.toolNamePrefix ?? `mcp__plugin_${mcp!.plugin}_${server.name}__`
    const servers = (mcp?.servers ?? []).filter((server) =>
      exposed.some((name) => name.startsWith(toolPrefix(server))))
    // An agent is observable only when a registered tool carries its name *and*
    // its description byte for byte. The IR's declaration is the claim; the
    // registry is the evidence (S10). A tool with the right name but different
    // text is the exact failure this row exists to catch, so it does not count.
    const declaredAgents = agents?.agents ?? []
    const observedAgents = declaredAgents.filter((agent) =>
      schemas.some((schema) => schema.name === agent.toolName && schema.description === agent.description))
    const unobservedAgents = declaredAgents.filter((agent) => !observedAgents.includes(agent))
    const inventory = emptyInventory({
      name: options.entry.id,
      version: undefined,
      source: `dsh:${dshVersion(options.harnessDir)}`,
    })
    inventory.pin = { tool: 'dsh', version: dshVersion(options.harnessDir) }
    inventory.components = [
      ...listed.map((skill) => ({ surface: 'skills' as const, name: skill.name })),
      ...observedAgents.map((agent) => ({ surface: 'agents' as const, name: agent.name })),
      ...servers.map((server) => ({ surface: 'mcpServers' as const, name: server.name })),
    ]
    inventory.notes = [
      `${INVENTORY_SCHEMA}: ${listed.length} skill(s) reported by dsh-skill`,
      ...listed.map((skill) => `skills/${skill.name} via ${skill.provider}`),
      ...observedAgents.map(
        (agent) => `agents/${agent.name}: tool "${agent.toolName}" matches the emitted declaration (name and description)`,
      ),
      ...unobservedAgents.map(
        (agent) => `agents/${agent.name}: no registered tool with the declared name and description`,
      ),
      ...servers.map((server) => `mcpServers/${server.name}: ${exposed.filter((name) => name.startsWith(toolPrefix(server))).length} tool(s) registered`),
    ]
    return {
      inventory,
      dshVersion: dshVersion(options.harnessDir),
      skills: listed,
      tools: exposed,
      toolSchemas: schemas,
      ...(observation === undefined ? {} : { behavior: observation }),
    }
  } finally {
    try {
      await Promise.resolve(booted?.loaderFiber?.dispose?.())
      await sleep(20)
    } catch {
      // Teardown failures must not mask the assertion that follows.
    }
  }
}

/** A caller that wants to observe the five lifecycle hooks on one real turn. */
export interface DshLifecycleProbeOptions {
  /** Directory holding the harness's `@deepseek-ai/*` packages. */
  harnessDir: string
  /** The group entry the emitter produced, carrying a hook child with `pluginData`. */
  entry: EntryOptions
  /**
   * The labels the handlers must write, one line each. The probe polls until
   * every one is present (handlers are unawaited spawns, so presence — not a
   * file size or a quiet period — is the completion signal), bounded by
   * `timeoutMs`; a label that never arrives fails with the lines already seen.
   * The caller owns any ordering assertions: the host does not promise a total
   * order across the root and the child.
   */
  expected: readonly string[]
  /**
   * A tool the stub model may call. Registered before the plugin loads, so a
   * real turn's `tools/pre-execute` sees it; the adapter's first stream asks
   * for it, and its second stream answers in text.
   */
  tool?: unknown
  /** The tool call the first model stream requests; `arguments` is JSON text. */
  toolCall?: { id: string; name: string; arguments: string }
  /** Run a second root turn on a sibling session after the first one. */
  secondAgent?: boolean
  /** Reload the entry before the first turn, proving session.start runs again. */
  reload?: boolean
  /** How long to wait for boot, the turn, the child and the expected labels, in milliseconds. */
  timeoutMs?: number
}

export interface DshLifecycleObservation {
  /** The `${CLAUDE_PLUGIN_DATA}` directory the entry named. */
  dataDir: string
  /** Every non-empty line of `events.log`, in the order the handlers wrote them. */
  events: string[]
}

/** The hook child's data directory, which the emitter copied from the install lock. */
function lifecycleDataDir(entry: EntryOptions): string {
  const children = (entry.config ?? []) as Array<{ id?: string; config?: { pluginData?: unknown } }>
  const child = children.find((item) => item.id === 'hook')
  if (typeof child?.config?.pluginData !== 'string' || child.config.pluginData.trim() === '') {
    throw new Error('dsh lifecycle probe: the hook child carries no pluginData directory')
  }
  return child.config.pluginData
}

const textChunks = (text: string): unknown[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: 'stop' },
]

/** One model turn that requests a tool call instead of answering in text. */
const toolCallChunks = (call: { id: string; name: string; arguments: string }): unknown[] => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } },
  { type: 'finish', reason: 'tool-calls' },
]

/**
 * Boot a full headless turn (session store, tools, agent loop, subagent
 * runtime), materialize `entry`, run one root turn and one delegated child, and
 * return the lines the fixture's handlers appended to `$CLAUDE_PLUGIN_DATA`
 * once every `expected` label has been written.
 *
 * The turn is real: the model is a local stub `dsh-llm` adapter, but the agent
 * registry, the agent loop, the turn stopper and the subagent runtime are the
 * pinned harness's own, so every lifecycle event is produced by the host rather
 * than emitted by this function. A stub adapter keeps the probe offline and
 * keyless (S9).
 */
export async function probeLifecycleWithDsh(options: DshLifecycleProbeOptions): Promise<DshLifecycleObservation> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const dataDir = lifecycleDataDir(options.entry)
  mkdirSync(dataDir, { recursive: true })
  const logFile = join(dataDir, 'events.log')
  rmSync(logFile, { force: true })
  // A payload file from an earlier run would otherwise satisfy the payload
  // assertions even when this run's handler never wrote one.
  rmSync(join(dataDir, 'payloads'), { recursive: true, force: true })

  const { Context } = await loadFromHarness(options.harnessDir, 'cordis/lib/index.js')
  const Loader = (await loadFromHarness(options.harnessDir, 'cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await loadFromHarness(options.harnessDir, 'dsh-skill/lib/index.js')).default
  const SessionStore = (await loadFromHarness(options.harnessDir, 'dsh-session/lib/index.js')).default
  const SessionProjections = (await loadFromHarness(options.harnessDir, 'dsh-session-projection/lib/index.js')).default
  const SystemPrompt = (await loadFromHarness(options.harnessDir, 'dsh-system-prompt/lib/index.js')).default
  const ToolsService = (await loadFromHarness(options.harnessDir, 'dsh-tools/lib/index.js')).default
  const AgentRegistry = (await loadFromHarness(options.harnessDir, 'dsh-agent/lib/index.js')).default
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await loadFromHarness(
    options.harnessDir,
    'dsh-llm/lib/index.js',
  )
  const AgentLoop = (await loadFromHarness(options.harnessDir, 'dsh-agent-loop/lib/index.js')).default
  const nativeExecutor = await loadFromHarness(options.harnessDir, 'dsh-tool-executor-native/lib/index.js')
  const SubagentRuntime = (await loadFromHarness(options.harnessDir, 'dsh-subagent/lib/index.js')).default
  const ForkProvider = await loadFromHarness(options.harnessDir, 'dsh-subagent-fork-in-process/lib/index.js')
  const FileSystem = (await loadFromHarness(options.harnessDir, 'dsh-fs-local/lib/index.js')).default
  const WorkingDirectory = (await loadFromHarness(options.harnessDir, 'dsh-working-directory/lib/index.js')).default

  class StubAdapter extends LlmAdapter {
    #calls = 0

    async resolveModel(provider: string, model: string): Promise<unknown> {
      return { provider, id: model, name: model, context: { contextWindow: 8192 }, defaultMaxTokens: 1024 }
    }

    async *stream(): AsyncGenerator<unknown> {
      this.#calls += 1
      const call = options.toolCall
      // Alternate call/answer for the two root sessions: calls 1 and 3 request
      // the probe tool, calls 2 and 4 answer in text. The delegated child then
      // gets a text answer (call 5), so a second-agent trace is not polluted by
      // the child's own tool call.
      const chunks =
        call !== undefined && this.#calls % 2 === 1 && this.#calls <= 4
          ? toolCallChunks(call)
          : textChunks('stub answer')
      for (const chunk of chunks) yield chunk
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
  ctx.plugin(FileSystem, { cwd: process.cwd() })
  ctx.plugin(WorkingDirectory, { defaultDirectory: process.cwd() })
  ctx.plugin(SubagentRuntime, {})
  ctx.plugin(ForkProvider, { providerName: 'fork' })
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentLoop)

  try {
    for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'subagents']) {
      await until(() => Boolean(ctx.get(name)), timeoutMs, `${name} service`)
    }
    ctx.llm.registerAdapter(['fake'], new StubAdapter())
    await until(() => Boolean(ctx.get('llm')), timeoutMs, 'llm service')
    await until(() => Boolean(ctx.get('agentLoop')), timeoutMs, 'agent loop service')
    if (options.tool !== undefined) ctx.tools.register(options.tool)
    await ctx.loader.create(options.entry)
    await ctx.loader.await()
    if (options.reload === true) {
      // A reload is a fresh load of the same entry: the plugin's apply runs
      // again, so a load-time session.start must run again with exactly one
      // registration. The turn starts only after the second apply settles.
      ctx.loader.remove(options.entry.id)
      await ctx.loader.await()
      await ctx.loader.create(options.entry)
      await ctx.loader.await()
    }

    // The header carries no cwd unless the creator seeds one, and the payload
    // builder reads it from the header. Seed it with the probe's own data
    // directory, which is distinct from the process cwd, so a payload that
    // silently fell back would fail the assertion instead of matching.
    const waitTurnEnd = (sessionId: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`dsh lifecycle probe: turn on ${sessionId} did not end`)),
          timeoutMs,
        )
        const off = ctx.on(
          'session/event',
          (session: { id?: unknown }, event: { type?: string; data?: { turn?: number } }) => {
            if (session.id !== sessionId) return
            if (event.type === 'turn/end' && event.data?.turn === 1) {
              clearTimeout(timer)
              off()
              resolve()
            }
          },
        )
      })
    const root = await ctx.agentLoop.create(
      'anyplugin-lifecycle-root',
      { provider: 'fake', model: 'fake-1' },
      { cwd: dataDir },
    )
    const turnEnded = waitTurnEnd(root.id)
    root.followup(createUserMessage({ content: [{ type: 'text', text: 'one turn' }], source: { kind: 'user' } }))
    await turnEnded

    let secondRoot: any
    if (options.secondAgent === true) {
      secondRoot = await ctx.agentLoop.create(
        'anyplugin-lifecycle-root-2',
        { provider: 'fake', model: 'fake-1' },
        { cwd: dataDir },
      )
      const secondEnded = waitTurnEnd(secondRoot.id)
      secondRoot.followup(createUserMessage({ content: [{ type: 'text', text: 'second turn' }], source: { kind: 'user' } }))
      await secondEnded
    }

    const childEnded = new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(undefined)
      }, timeoutMs)
      const off = ctx.on('subagent/end', (payload: Record<string, unknown>) => {
        if (payload.parentSessionId !== root.id) return
        clearTimeout(timer)
        off()
        resolve(payload)
      })
    })
    const activation = await ctx.subagents.startActivation({
      provider: 'fork',
      parent: root,
      prompt: [{ type: 'text', text: 'child prompt' }],
      delivery: 'caller',
      label: 'anyplugin lifecycle child',
      signal: new AbortController().signal,
    })
    const ended = await childEnded
    if (ended === undefined) throw new Error('dsh lifecycle probe: the delegated child did not end')
    await activation?.dispose?.()

    const entryFor = (sessionId: string): { id?: unknown } | undefined =>
      [...(ctx.agents.store?.values?.() ?? [])].find((item: { id?: unknown }) => item.id === sessionId) as
        | { id?: unknown }
        | undefined
    const entry = entryFor(root.id)
    if (entry === undefined) throw new Error('dsh lifecycle probe: root agent is not in the registry')
    const disposed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dsh lifecycle probe: root agent did not dispose')), timeoutMs)
      const off = ctx.on('agent/disposed', (payload: { agent?: { id?: unknown } }) => {
        if (payload.agent?.id !== root.id) return
        clearTimeout(timer)
        off()
        resolve()
      })
    })
    ctx.agents.detachEntered(entry)
    await disposed
    if (secondRoot !== undefined) {
      const secondEntry = entryFor(secondRoot.id)
      if (secondEntry !== undefined) ctx.agents.detachEntered(secondEntry)
    }

    // The host does not await async emit listeners, and each handler spawns
    // `sh`, so the await above proves the event was announced, not that the
    // handler finished. The fixture writes its payload file *before* the log
    // line, making the line the completion marker: wait until every expected
    // label exists, never for a quiet file, because a slow handler is still a
    // valid run and a quiet one can still be missing the last line.
    const readEvents = (): string[] =>
      existsSync(logFile)
        ? readFileSync(logFile, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
        : []
    const deadline = Date.now() + timeoutMs
    let events = readEvents()
    let missing = options.expected.filter((label) => !events.includes(label))
    while (missing.length > 0 && Date.now() < deadline) {
      await sleep(25)
      events = readEvents()
      missing = options.expected.filter((label) => !events.includes(label))
    }
    if (missing.length > 0) {
      const seen = events.length === 0 ? 'nothing' : events.join(', ')
      throw new Error(
        `dsh lifecycle probe: no ${missing.join(', ')} line after ${timeoutMs}ms; the log has ${seen}`,
      )
    }
    return { dataDir, events }
  } finally {
    try {
      await Promise.resolve(loaderFiber?.dispose?.())
      await sleep(20)
    } catch {
      // Teardown failures must not mask the assertion that follows.
    }
  }
}
