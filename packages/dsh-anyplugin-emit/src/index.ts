/**
 * Emitter — IR in, an `EntryTree` patch out. Pure data on purpose
 * (AGENTS.md §3.3): no code generation, no `eval`, no files written.
 *
 * Shape: one foreign plugin becomes one group entry whose children are the
 * per-surface materializers. A group entry gives us the unit of enable/disable,
 * dispose and crash isolation that S1 verified; a stable id makes
 * re-materialization an update instead of a remove+create.
 */
import type { ClaudePluginIr, IrSkill } from '../../dsh-anyplugin-ir/src/index.ts'

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
  // The three surfaces emit can place. An IR entry on any other surface
  // (agents, output-styles, pending themes, …) was never a decision emit made.
  const considered: string[] = []
  for (const skill of ir.skills) considered.push(`skills/${skill.name}`)
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

  const carried = (annotation: { fidelity: string }) =>
    annotation.fidelity === 'exact' || annotation.fidelity === 'equivalent'
  const mcpMaterializer = options.materializers.mcp
  const servers = ir.mcpServers.filter((server) => carried(server.annotation))
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
  const hooks = ir.hooks.filter(
    (hook) =>
      carried(hook.annotation) &&
      hook.command !== undefined &&
      trusted.has(`hook:${hook.event}#${hook.index}`),
  )
  const hooksMaterializer = options.materializers.hooks
  if (hooks.length > 0 && hooksMaterializer !== undefined) {
    children.push({
      id: 'hook',
      name: hooksMaterializer,
      config: {
        pluginRoot: ir.plugin.root,
        hooks: hooks.map((hook) => ({
          event: hook.event,
          ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
          command: hook.command,
          ...(hook.args === undefined ? {} : { args: hook.args }),
          ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
        })),
      },
    })
    emitted.push('hooks')
  }
  for (const hook of ir.hooks) {
    const name = `hooks/${hook.event}#${hook.index}`
    // Without a hook materializer no hook can be placed, carried or not.
    if (!carried(hook.annotation) || hook.command === undefined || hooksMaterializer === undefined) {
      skipped.push(name)
    } else if (!hooks.includes(hook)) {
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
