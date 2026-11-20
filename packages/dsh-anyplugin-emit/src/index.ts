/**
 * Emitter — IR in, an `EntryTree` patch out. Pure data on purpose
 * (AGENTS.md §3.3): no code generation, no `eval`, no files written.
 *
 * Shape: one foreign plugin becomes one group entry whose children are the
 * per-surface materializers. A group entry gives us the unit of enable/disable,
 * dispose and crash isolation that S1 verified; a stable id makes
 * re-materialization an update instead of a remove+create.
 */
import { isCarried } from '../../dsh-anyplugin-ir/src/index.ts'
import type { ClaudePluginIr, IrAgent, IrSkill } from '../../dsh-anyplugin-ir/src/index.ts'

export { DEFAULT_MATERIALIZERS, defaultMaterializers, materializerUrl } from './materializers.ts'

export const GROUP_PLUGIN = '@deepseek-ai/cordis-plugin-group'

/** Loader entry shape (`EntryOptions` in `@deepseek-ai/cordis-plugin-loader`). */
export interface EntryOptions {
  id: string
  name: string
  config?: unknown
  group?: boolean | null
  disabled?: boolean | null
  inject?: string[]
}

/**
 * D7 — loader ids are escaped, display names are not.
 *
 * `EntryTree.sep` is `:`, so a raw `my-plugin:sub` id is accepted by the store
 * but cannot be resolved (S1 finding 4). Every byte outside this set is
 * escaped as `~` + the UTF-8 hex of that byte, which is reversible in one
 * pass because `~` is itself escaped.
 */
const SAFE_ID = /[A-Za-z0-9_.@-]/

export function mangleId(raw: string): string {
  let out = ''
  for (const byte of Buffer.from(raw, 'utf8')) {
    const char = String.fromCharCode(byte)
    out += SAFE_ID.test(char) ? char : `~${byte.toString(16).padStart(2, '0')}`
  }
  return out
}

export function unmangleId(escaped: string): string {
  const bytes: number[] = []
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '~') {
      bytes.push(Number.parseInt(escaped.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(escaped.charCodeAt(i))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Absolute module specifiers for the materializers a build ships. */
export interface Materializers {
  skill: string
  /** The MCP materializer (D12); absent means MCP is not carried by this build. */
  mcp?: string
  [surface: string]: string | undefined
}

export interface EmitOptions {
  materializers: Materializers
  /**
   * Directory holding `@modelcontextprotocol/client` in the *target* harness.
   * The MCP materializer prefers a bare import and falls back to this path, so
   * emission stays data while still naming the environment it targets.
   */
  sdkRoot?: string
  /** Id prefix; `anyplugin.` keeps our subtree addressable in the same store. */
  prefix?: string
  /**
   * Exec targets (`hook:<event>#<index>`) that a hash-pinned grant authorized
   * (D25). Default is empty: exec is default-off, so a caller that does not
   * pass a decision cannot emit a hook by accident.
   */
  trusted?: readonly string[]
  /**
   * The plugin's `${CLAUDE_PLUGIN_DATA}`-equivalent directory (D2). Hooks are
   * the only surface that reads it, so it is emitted next to the hook config
   * rather than on every child. Absent means the materializer leaves the
   * variable unset, as a hand-written config would.
   */
  dataDir?: string
}

export interface EmitResult {
  entry: EntryOptions | null
  /** Surfaces that produced a child entry, for the report. */
  emitted: string[]
  /**
   * Every IR entry emit looked at, as `surface/name`, carried or refused.
   * Surfaces emit does not place (agents, output-styles, …) are absent, which
   * is how the report tells "refused" apart from "never considered".
   */
  considered: string[]
  /**
   * IR entries emit considered but could not place, as `surface/name` (hooks:
   * `hooks/<event>#<index>`): either no seam carries the annotation, or the
   * surface's materializer is absent. `considered` minus `skipped` is exactly
   * what the report calls carried.
   */
  skipped: string[]
  /**
   * Carried exec entries that were withheld because no grant authorized their
   * current artifact hash, as `surface/name`. Distinct from `skipped`: the
   * capability exists, but trust said no (D25).
   */
  refused: string[]
}

function skillConfig(skills: IrSkill[]): unknown {
  return {
    source: 'custom',
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      invocation: skill.invocation,
      ...(skill.sourcePath ? { path: skill.sourcePath } : {}),
      ...(skill.resourceDir ? { resourceDir: skill.resourceDir } : {}),
    })),
  }
}

/**
 * The agents child. The body is payload, never prompt text: the materializer
 * keeps it out of the tool description and hands it to `startActivation` when
 * the tool is invoked (S10).
 */
function agentConfig(agents: IrAgent[], plugin: string): unknown {
  return {
    plugin,
    agents: agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      content: agent.content,
      ...(agent.sourcePath ? { path: agent.sourcePath } : {}),
    })),
  }
}

/**
 * Emittability is decided per *face*, not per component. A command whose human
 * face is still `planned` is emitted as a skill on purpose — its overall
 * annotation keeps saying `planned`, so the report cannot read as a success
 * (AGENTS.md §3.1). Dropping it instead would hide a face we can serve today.
 */
export function emitPlugin(ir: ClaudePluginIr, options: EmitOptions): EmitResult {
  const children: EntryOptions[] = []
  const emitted: string[] = []
  const skipped: string[] = []
  const refused: string[] = []
  const trusted = new Set(options.trusted ?? [])
  // Every surface emit knows how to place. Skipping is a decision recorded
  // below; an IR entry on an unknown surface was never one emit made.
  const considered: string[] = []
  for (const skill of ir.skills) considered.push(`skills/${skill.name}`)
  for (const agent of ir.agents) considered.push(`agents/${agent.name}`)
  for (const server of ir.mcpServers) considered.push(`mcpServers/${server.name}`)
  for (const hook of ir.hooks) considered.push(`hooks/${hook.event}#${hook.index}`)

  const modelFace = (skill: IrSkill) => skill.faces?.model ?? skill.annotation
  const skills = ir.skills.filter((skill) => {
    const fidelity = modelFace(skill).fidelity
    return fidelity === 'exact' || fidelity === 'equivalent'
  })
  if (skills.length > 0) {
    children.push({ id: 'skill', name: options.materializers.skill, config: skillConfig(skills) })
    emitted.push('skills')
  }
  for (const skill of ir.skills) if (!skills.includes(skill)) skipped.push(`skills/${skill.name}`)

  // An agent is placed when its catalog face is carried: the tool name and
  // description are what the model reads. Its invocation/model/tools/limits
  // faces keep their own annotations; the overall stays the weakest (S10).
  const agentsMaterializer = options.materializers.agents
  const agents = ir.agents.filter((agent) => isCarried(agent.faces?.catalog ?? agent.annotation))
  if (agents.length > 0 && agentsMaterializer !== undefined) {
    children.push({ id: 'agents', name: agentsMaterializer, config: agentConfig(agents, ir.plugin.name) })
    emitted.push('agents')
  }
  for (const agent of ir.agents) {
    if (!agents.includes(agent) || agentsMaterializer === undefined) skipped.push(`agents/${agent.name}`)
  }

  const mcpMaterializer = options.materializers.mcp
  const servers = ir.mcpServers.filter((server) => isCarried(server.annotation))
  if (servers.length > 0 && mcpMaterializer !== undefined) {
    children.push({
      id: 'mcp',
      name: mcpMaterializer,
      config: {
        plugin: ir.plugin.name,
        ...(options.sdkRoot === undefined ? {} : { sdkRoot: options.sdkRoot }),
        servers: servers.map((server) => ({
          name: server.name,
          transport: server.transport,
          ...(server.command === undefined ? {} : { command: server.command }),
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(server.env === undefined ? {} : { env: server.env }),
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
          ...(server.url === undefined ? {} : { url: server.url }),
          ...(server.headers === undefined ? {} : { headers: server.headers }),
          // D33: a dialect may name its own tool prefix. Absent keeps Claude's
          // `mcp__plugin_<plugin>_<server>__` composition in the materializer,
          // so this is additive and the Claude path is byte-identical.
          ...(server.toolNamePrefix === undefined ? {} : { toolNamePrefix: server.toolNamePrefix }),
        })),
      },
    })
    emitted.push('mcpServers')
  }
  for (const server of ir.mcpServers) {
    // Without an MCP materializer no server can be placed, carried or not.
    if (!servers.includes(server) || mcpMaterializer === undefined) skipped.push(`mcpServers/${server.name}`)
  }

  // Hooks are mounted on the tool waterfalls (D19). Only command handlers that
  // land on PreToolUse/PostToolUse are `equivalent` today; everything else is
  // `planned` and stays out of the entry — the report keeps it visible.
  const hooks = ir.hooks.filter((hook) => {
    return (
      isCarried(hook.annotation) &&
      hook.command !== undefined &&
      trusted.has(`hook:${hook.event}#${hook.index}`) &&
      hook.artifact !== undefined &&
      hook.artifactHash !== undefined
    )
  })
  const hooksMaterializer = options.materializers.hooks
  if (hooks.length > 0 && hooksMaterializer !== undefined) {
    children.push({
      id: 'hook',
      name: hooksMaterializer,
      config: {
        pluginRoot: ir.plugin.root,
        ...(options.dataDir === undefined ? {} : { pluginData: options.dataDir }),
        hooks: hooks.map((hook) => ({
          event: hook.event,
          index: hook.index,
          ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
          command: hook.command,
          ...(hook.args === undefined ? {} : { args: hook.args }),
          ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
          // D25: the gate resolved this manifest once. Emit copies it verbatim;
          // the materializer re-reads exactly these paths before every spawn.
          artifactHash: hook.artifactHash,
          artifactMode: hook.artifact?.mode,
          artifactRoot: ir.plugin.root,
          artifact: hook.artifact,
        })),
      },
    })
    emitted.push('hooks')
  }
  for (const hook of ir.hooks) {
    const name = `hooks/${hook.event}#${hook.index}`
    // Without a hook materializer no hook can be placed, carried or not.
    if (!isCarried(hook.annotation) || hook.command === undefined || hooksMaterializer === undefined) {
      skipped.push(name)
    } else if (
      !trusted.has(`hook:${hook.event}#${hook.index}`) ||
      hook.artifact === undefined ||
      hook.artifactHash === undefined
    ) {
      // Trusted but unresolved fails closed: never emit a child emit cannot pin.
      refused.push(name)
    }
  }

  if (children.length === 0) return { entry: null, emitted, considered, skipped, refused }

  const prefix = options.prefix ?? 'anyplugin.'
  return {
    entry: {
      id: `${prefix}${mangleId(ir.plugin.name)}`,
      name: GROUP_PLUGIN,
      group: true,
      config: children,
    },
    emitted,
    considered,
    skipped,
    refused,
  }
}
