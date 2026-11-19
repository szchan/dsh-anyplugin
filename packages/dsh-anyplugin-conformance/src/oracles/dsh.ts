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
import { existsSync } from 'node:fs'
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
    // reports what the model can call, not what a config file declared.
    const servers = (mcp?.servers ?? []).filter((server) =>
      exposed.some((name) => name.startsWith(`mcp__plugin_${mcp!.plugin}_${server.name}__`)))
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
      ...servers.map((server) => `mcpServers/${server.name}: ${exposed.filter((name) => name.startsWith(`mcp__plugin_${mcp!.plugin}_${server.name}__`)).length} tool(s) registered`),
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
