/**
 * The intermediate representation (IR) — the only thing materializers and the
 * emitter are allowed to see. A dialect reads a foreign plugin and produces an
 * IR; nothing downstream ever reads the foreign format again.
 *
 * Fidelity is annotated *at the source* (AGENTS.md §3.1): every node carries a
 * class and a reason, and the reason is mandatory. A node that cannot be
 * materialized is still represented — as `planned` or `unsupported` — so the
 * fidelity report cannot have silent holes.
 */
export const IR_SCHEMA = 'dsh-anyplugin/ir@1'

/**
 * - `exact` — bytes or identity are preserved.
 * - `equivalent` — same observable effect, not the same bytes (and the reason
 *   says what differs).
 * - `derived` — a design decision of ours with no upstream counterpart.
 * - `planned` — recognized, not materialized yet; a roadmap slot exists.
 * - `unsupported` — cannot be materialized, and there is no plan to change it.
 */
export type Fidelity = 'exact' | 'equivalent' | 'derived' | 'planned' | 'unsupported'

export interface Annotation {
  fidelity: Fidelity
  /** Human-readable justification. Empty or whitespace-only is a bug. */
  reason: string
}

export interface IrInvocation {
  modelInvocable: boolean
  userInvocable: boolean
}

export type SkillOrigin = 'skills-dir' | 'commands-dir' | 'root-skill'

export interface IrSkill {
  kind: 'skill'
  name: string
  description: string
  /** Skill body exactly as authored, frontmatter removed. */
  content: string
  whenToUse?: string
  invocation: IrInvocation
  origin: SkillOrigin
  /** Repository-relative path of the source file, for diffs and reports. */
  sourcePath: string
  /** Directory the body's relative references resolve against. */
  resourceDir?: string
  /**
   * One artifact can have more than one observable face. A Claude command is
   * exactly that: a model-catalog face (the host lists it with the same name,
   * description and body as a skill) and a human face (`/plugin:name args`
   * expanded into a user message). Materializing one face while the other is
   * missing is a partial result, not a silent success, so each face carries its
   * own annotation. `annotation` above is then the *weakest* face — the
   * component is only as faithful as its worst surface.
   */
  faces?: { model: Annotation; human?: Annotation }
  annotation: Annotation
}

export interface IrAgent {
  kind: 'agent'
  name: string
  description?: string
  content: string
  model?: string
  tools?: string[]
  origin: 'agents-dir'
  sourcePath: string
  annotation: Annotation
}

export interface IrHook {
  kind: 'hook'
  event: string
  matcher?: string
  /** Position within the event's handler list, for stable identity. */
  index: number
  /** `command` | `http` | `mcp_tool` | `prompt` | `agent` | `unknown`. */
  handler: string
  /** Shell command, verbatim as authored. Only for `handler: 'command'`. */
  command?: string
  /** Exec-form arguments; when present the command runs without a shell. */
  args?: readonly string[]
  /** Per-handler timeout in seconds, as authored. */
  timeout?: number
  sourcePath: string
  annotation: Annotation
}

export interface IrMcpServer {
  kind: 'mcp-server'
  name: string
  /**
   * Where the server lives. `stdio` is a child process; `http` is Streamable
   * HTTP. Claude's `sse` transport is not carried yet, so it arrives as an
   * `unsupported` entry rather than a server.
   */
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** Absolute path that `${CLAUDE_PLUGIN_ROOT}` resolved to, kept for the report. */
  pluginRoot?: string
  sourcePath: string
  annotation: Annotation
}

export interface IrUnmaterialized {
  surface: string
  /** Free-form identity of the thing inside the surface (a name, or a path). */
  name: string
  sourcePath: string
  annotation: Annotation
}

export interface IrPin {
  tool: string
  version: string
}

export interface ClaudePluginIr {
  ir: typeof IR_SCHEMA
  plugin: {
    name: string
    version?: string
    description?: string
    /** Where the package came from, e.g. `plugin-dir:fixtures/x`. */
    source: string
    /** Absolute root, recorded for a run but never used as an identity. */
    root: string
  }
  pin: IrPin
  skills: IrSkill[]
  agents: IrAgent[]
  hooks: IrHook[]
  mcpServers: IrMcpServer[]
  /** Recognized, not materialized yet — every one annotated `planned`. */
  pending: IrUnmaterialized[]
  /** Recognized, cannot be materialized — every one annotated `unsupported`. */
  unsupported: IrUnmaterialized[]
}

export interface FidelityEntry {
  surface: string
  name: string
  fidelity: Fidelity
  reason: string
}

export interface FidelityReport {
  plugin: string
  pin: IrPin
  entries: FidelityEntry[]
  counts: Record<Fidelity, number>
  /** Components we can emit today, against everything the source declares. */
  totals: { declared: number; emittable: number }
}

const FIDELITIES: readonly Fidelity[] = ['exact', 'equivalent', 'derived', 'planned', 'unsupported']

/** Strongest first. A component's overall annotation may never be stronger than its weakest face. */
const RANK: Record<Fidelity, number> = { exact: 0, equivalent: 1, derived: 2, planned: 3, unsupported: 4 }

function annotationProblems(where: string, annotation: Annotation | undefined): string[] {
  if (!annotation) return [`${where}: missing annotation`]
  const problems: string[] = []
  if (!FIDELITIES.includes(annotation.fidelity)) {
    problems.push(`${where}: unknown fidelity ${JSON.stringify(annotation.fidelity)}`)
  }
  if (!annotation.reason || !annotation.reason.trim()) problems.push(`${where}: empty reason`)
  return problems
}

/**
 * Every annotation must be present and justified. Returns problems instead of
 * throwing so the rig can report *all* of them at once.
 */
export function validateIr(ir: ClaudePluginIr): string[] {
  const problems: string[] = []
  if (ir.ir !== IR_SCHEMA) problems.push(`ir: expected ${IR_SCHEMA}, got ${String(ir.ir)}`)
  if (!ir.plugin?.name?.trim()) problems.push('plugin.name: empty')
  if (!ir.pin?.tool || !ir.pin?.version) problems.push('pin: tool and version are required')

  for (const skill of ir.skills ?? []) {
    const where = `skill ${JSON.stringify(skill.name)}`
    if (!skill.name?.trim()) problems.push(`${where}: empty name`)
    if (typeof skill.content !== 'string') problems.push(`${where}: content must be a string`)
    // Emittability is decided by the model face: a command whose human face is
    // still `planned` is emitted as a skill on purpose, and the reason on its
    // overall annotation says exactly what is missing.
    const modelFace = skill.faces?.model ?? skill.annotation
    if (modelFace?.fidelity === 'planned' || modelFace?.fidelity === 'unsupported') {
      problems.push(`${where}: ${modelFace.fidelity} nodes must not sit in the emittable lists`)
    }
    problems.push(...annotationProblems(where, skill.annotation))
    if (skill.faces) {
      problems.push(...annotationProblems(`${where} model face`, skill.faces.model))
      if (skill.faces.human) problems.push(...annotationProblems(`${where} human face`, skill.faces.human))
      const weakest = Math.max(...[skill.faces.model, skill.faces.human].filter(Boolean).map((face) => RANK[face.fidelity]))
      if (skill.annotation && RANK[skill.annotation.fidelity] < weakest) {
        problems.push(`${where}: overall ${skill.annotation.fidelity} claims more than its weakest face`)
      }
    }
  }
  for (const agent of ir.agents ?? []) {
    problems.push(...annotationProblems(`agent ${JSON.stringify(agent.name)}`, agent.annotation))
  }
  for (const hook of ir.hooks ?? []) {
    problems.push(...annotationProblems(`hook ${hook.event}#${hook.index}`, hook.annotation))
  }
  for (const server of ir.mcpServers ?? []) {
    const where = `mcp ${JSON.stringify(server.name)}`
    problems.push(...annotationProblems(where, server.annotation))
    // A server that cannot be started is a claim with no mechanism behind it.
    if (server.transport === 'stdio' && !server.command?.trim()) problems.push(`${where}: stdio server needs a command`)
    if (server.transport === 'http' && !server.url?.trim()) problems.push(`${where}: http server needs a url`)
  }
  for (const item of ir.pending ?? []) {
    const where = `pending ${item.surface}/${JSON.stringify(item.name)}`
    if (item.annotation?.fidelity !== 'planned') problems.push(`${where}: pending nodes must be planned`)
    problems.push(...annotationProblems(where, item.annotation))
  }
  for (const item of ir.unsupported ?? []) {
    const where = `unsupported ${item.surface}/${JSON.stringify(item.name)}`
    if (item.annotation?.fidelity !== 'unsupported') problems.push(`${where}: must be unsupported`)
    problems.push(...annotationProblems(where, item.annotation))
  }
  return problems
}

/** Project the IR into the report shape. Pure function of the IR, by design. */
export function summarizeIr(ir: ClaudePluginIr): FidelityReport {
  const entries: FidelityEntry[] = []
  const push = (surface: string, name: string, annotation: Annotation): void => {
    entries.push({ surface, name, fidelity: annotation.fidelity, reason: annotation.reason })
  }
  for (const skill of ir.skills) push('skills', skill.name, skill.annotation)
  for (const agent of ir.agents) push('agents', agent.name, agent.annotation)
  for (const hook of ir.hooks) push('hooks', `${hook.event}#${hook.index}`, hook.annotation)
  for (const server of ir.mcpServers) push('mcpServers', server.name, server.annotation)
  for (const item of ir.pending) push(item.surface, item.name, item.annotation)
  for (const item of ir.unsupported) push(item.surface, item.name, item.annotation)

  const counts = Object.fromEntries(FIDELITIES.map((f) => [f, 0])) as Record<Fidelity, number>
  for (const entry of entries) counts[entry.fidelity] += 1

  return {
    plugin: ir.plugin.name,
    pin: ir.pin,
    entries,
    counts,
    totals: {
      declared: entries.length,
      emittable: ir.skills.length,
    },
  }
}
