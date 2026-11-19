/**
 * DSH-side oracle — boots the *installed* harness packages and reads what they
 * report about a plugin we materialized.
 *
 * The installed tree is a real directory, not an asar archive, so plain Node
 * can import it. That matters for fidelity of the rig itself: the oracle runs
 * the exact `dsh-skill` / `cordis` builds the desktop app runs
 * (`0.2.2-rc.2` / `4.1.0`), not npm copies that may lag or not exist.
 *
 * One rule that is easy to get wrong: the `Context` must come from the
 * *installed* cordis. Two copies of cordis in one process give two `Service`
 * base classes, and the registry would never see the context that owns it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EntryOptions } from '../../dsh-anyplugin-emit/src/index.ts'
import type { Inventory } from '../inventory.ts'
import { emptyInventory, INVENTORY_SCHEMA } from '../inventory.ts'

export interface DshProbeOptions {
  /** Directory holding the installed `@deepseek-ai/*` packages. */
  installedDir: string
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
  /** Public tool names the harness actually exposes, for MCP assertions. */
  tools: string[]
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

function loadInstalled(installedDir: string, specifier: string): Promise<any> {
  return import(pathToFileURL(join(installedDir, specifier)).href)
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`dsh oracle: timed out waiting for ${label}`)
}

async function boot(installedDir: string, timeoutMs: number, needTools: boolean, needExecutor = false): Promise<BootedHarness> {
  const { Context } = await loadInstalled(installedDir, 'cordis/lib/index.js')
  const Loader = (await loadInstalled(installedDir, 'cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await loadInstalled(installedDir, 'dsh-skill/lib/index.js')).default

  const ctx = new Context()
  // Keep the fiber: `Loader` exposes no stop(), so the fiber *is* the teardown
  // handle (ARCHITECTURE §10.4). Disposing it runs every effect disposer.
  const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(join(installedDir, 'dsh') + '/').href })
  ctx.plugin(SkillRegistry, {})
  if (needTools) {
    // The tool registry reads the system prompt service; S5 booted the same pair.
    const SystemPrompt = (await loadInstalled(installedDir, 'dsh-system-prompt/lib/index.js')).default
    const ToolsService = (await loadInstalled(installedDir, 'dsh-tools/lib/index.js')).ToolsService
    ctx.plugin(SystemPrompt)
    await until(() => Boolean(ctx.systemPrompt), timeoutMs, 'system prompt service')
    ctx.plugin(ToolsService, {})
    await until(() => Boolean(ctx.tools), timeoutMs, 'tools service')
    if (needExecutor) {
      // Dispatch lives in a separate functional plugin (S8); without it a call
      // never reaches the tool waterfalls the hooks are mounted on.
      const nativeExecutor = await loadInstalled(installedDir, 'dsh-tool-executor-native/lib/index.js')
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

export function dshVersion(installedDir: string): string {
  const manifest = JSON.parse(readFileSync(join(installedDir, 'dsh', 'package.json'), 'utf8')) as { version?: string }
  return manifest.version ?? 'unknown'
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
  const behavior = options.behavior
  const booted = await boot(options.installedDir, timeoutMs, mcp !== undefined || behavior !== undefined, behavior !== undefined)
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
      // the handshake and the first registration.
      const toolNames = mcp === undefined ? '' : (ctx.tools?.schemas?.() ?? []).map((schema: { name: string }) => schema.name).join(',')
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
    const exposed: string[] = mcp === undefined ? [] : (booted.tools?.schemas?.() ?? []).map((schema: { name: string }) => schema.name)

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
    const inventory = emptyInventory({
      name: options.entry.id,
      version: undefined,
      source: `dsh:${dshVersion(options.installedDir)}`,
    })
    inventory.pin = { tool: 'dsh', version: dshVersion(options.installedDir) }
    inventory.components = [
      ...listed.map((skill) => ({ surface: 'skills' as const, name: skill.name })),
      ...servers.map((server) => ({ surface: 'mcpServers' as const, name: server.name })),
    ]
    inventory.notes = [
      `${INVENTORY_SCHEMA}: ${listed.length} skill(s) reported by dsh-skill`,
      ...listed.map((skill) => `skills/${skill.name} via ${skill.provider}`),
      ...servers.map((server) => `mcpServers/${server.name}: ${exposed.filter((name) => name.startsWith(`mcp__plugin_${mcp!.plugin}_${server.name}__`)).length} tool(s) registered`),
    ]
    return {
      inventory,
      dshVersion: dshVersion(options.installedDir),
      skills: listed,
      tools: exposed,
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
