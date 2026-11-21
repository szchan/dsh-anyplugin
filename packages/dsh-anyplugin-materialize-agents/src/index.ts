/**
 * Agents materializer — one model-facing tool per `agents/*.md` persona (S10).
 *
 * Why this shape: `dsh-tool-subagent` registers one tool per *provider* with a
 * fixed description, and its optional `agent_preset` enum carries ids only. A
 * plugin that wants the model to see the agent's own name and description has
 * to register its own tool, which `ctx.tools` allows (S5). The frontmatter
 * description becomes the tool description verbatim; the body never does — it
 * travels to the child only when the tool is invoked.
 *
 * Invocation goes through `ctx.subagents.startActivation`. The child receives
 * the body as the first block of its initial *user* message, because
 * `SubagentStartRequest` has no instructions/system-prompt field at the pin
 * (S10). A true system prompt needs an independent `agentPreset` whose
 * composition mounts `@deepseek-ai/dsh-persona`; that route is deliberately
 * not required here, so the catalog survives a harness without the preset
 * registry (§8, P4).
 *
 * Seam-adaptive degradation (AGENTS.md §6): `inject` names only `tools`, so the
 * plugin loads with or without `subagents`. With the seam absent the tools are
 * still listed (the catalog is real) and invocation fails with a message that
 * names the missing service instead of crashing the group at load time.
 *
 * Frontmatter faces (S16). `skills` is the one key the host can honour today:
 * every skill body the compiler resolved is prepended to the child's first user
 * message, which is where Claude starts the subagent with the full skill
 * content. The other keys are *not* forwarded. `startActivation` has no field
 * for tools, turns, isolation, memory, background, CLAUDE.md suppression,
 * colour or compaction, and forwarding `model`/`effort` through
 * `agentOptions` would put Claude's alias/levels into a provider id space that
 * observed them literally (S16). The IR annotation on each face says so; this
 * materializer must not pretend otherwise.
 */
export const name = 'anyplugin-materialize-agents'
// No static `inject`: apply() runs even when `ctx.tools` is late or missing, so
// the degradation is recorded instead of the plugin silently never applying.
export const inject = []

/** A skill body the compiler resolved for this agent's `skills:` preload. */
export interface MaterialAgentSkill {
  name: string
  content: string
}

/**
 * One agent as the emitter wrote it into this plugin's config. The frontmatter
 * faces are carried as data even when the pin cannot honour them; only
 * `skillContents` changes what the child receives (S16).
 */
export interface MaterialAgent {
  name: string
  description: string
  /** Body exactly as authored, frontmatter removed. */
  content: string
  /** Source path, kept for diagnostics only. */
  path?: string
  model?: string
  tools?: string[]
  disallowedTools?: string[]
  effort?: string
  maxTurns?: number
  isolation?: string
  skills?: string[]
  skillContents?: MaterialAgentSkill[]
  memory?: string
  background?: boolean
  omitClaudeMd?: boolean
  color?: string
  autoCompactWindow?: number
}

export interface Config {
  /** Plugin name; tool names are `<plugin>:<agent>`, Claude's Task convention. */
  plugin?: string
  agents?: MaterialAgent[]
  /** Subagent provider name; the in-process spawn provider registers as `spawn`. */
  provider?: string
}

/** Model-facing arguments of one agent tool. */
interface AgentArgs {
  prompt?: unknown
  description?: unknown
}

interface AgentExec {
  agent?: unknown
  signal?: AbortSignal
}

/** Why an agent cannot become a tool, or undefined when it can. */
export function agentProblem(agent: MaterialAgent, plugin: string | undefined): string | undefined {
  if (typeof plugin !== 'string' || plugin.trim() === '') {
    return 'config has no plugin name; model-facing tool names are scoped <plugin>:<agent>'
  }
  if (!agent || typeof agent.name !== 'string' || agent.name.trim() === '') return 'agent has no name'
  if (typeof agent.description !== 'string' || agent.description.trim() === '') {
    return 'agent has no description; Claude requires one and it is the only catalog text the model would see'
  }
  if (typeof agent.content !== 'string' || agent.content.trim() === '') {
    return 'agent body is empty; forked persona would carry no instructions'
  }
  return undefined
}

/**
 * The tool definition for one agent. Exported so the test can assert the exact
 * description (byte equality) without booting a harness.
 */
/** The provider label the host puts in a skill's `<skill_resources>` note. */
const SKILL_PROVIDER = 'anyplugin'

// The host's `escapeAttr`/`escapeText` (dsh-skill `renderSkillContent`), so the
// envelope is byte-identical for any name or provider label.
const escapeSkillAttr = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const escapeSkillText = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The host's own skill envelope at 0.2.2-rc.5 (`dsh-skill/src/index.ts:170`,
 * `renderSkillContent`) for a skill with no resource base: the
 * provider-managed note is what the host renders when it has no directory or
 * URL to point at. The conformance test builds the expected bytes by calling
 * the pinned host function, so any drift reddens.
 */
function renderSkillEnvelope(preload: MaterialAgentSkill): string {
  return [
    `<skill_content name="${escapeSkillAttr(preload.name)}">`,
    '<skill_resources>',
    `Resources for this skill are managed by provider "${escapeSkillText(SKILL_PROVIDER)}".`,
    'Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    preload.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

export function agentTool(agent: MaterialAgent, ctx: any, config: Config): unknown {
  const toolName = `${config.plugin}:${agent.name}`
  return {
    name: toolName,
    // The contract of this materializer: frontmatter description, verbatim.
    description: agent.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'The task for this agent. It arrives after the persona instructions.',
        },
        description: {
          type: 'string',
          description: 'Short label for this delegation, shown in the parent transcript.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      },
      render: (_args: unknown, value: { name: string }) => [{ type: 'text', text: `started agent ${value.name}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args: AgentArgs, exec: AgentExec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error(`agent ${JSON.stringify(toolName)} requires a calling agent (exec.agent was undefined)`)
      }
      const subagents = ctx.get('subagents')
      if (!subagents) {
        throw new Error(
          `agent ${JSON.stringify(toolName)} cannot start a child: the subagents service is absent. ` +
            'Mount @deepseek-ai/dsh-subagent and a provider (ARCHITECTURE §8, P4).',
        )
      }
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error(`agent ${JSON.stringify(toolName)} requires a non-empty prompt`)
      const label =
        typeof args?.description === 'string' && args.description.trim() !== '' ? args.description.trim() : agent.name
      // Persona first, then each preloaded skill body, then the parent's task.
      // None of it is ever a tool description. The envelope is byte-for-byte
      // the host's own `renderSkillContent` output for a skill with no
      // resource base (S16); the conformance test renders the expected bytes
      // with the pinned host function and asserts the whole child message, so
      // an insertion anywhere between the blocks reddens.
      const blocks: { type: 'text'; text: string }[] = [{ type: 'text', text: agent.content }]
      for (const preload of agent.skillContents ?? []) {
        if (typeof preload?.name !== 'string' || typeof preload?.content !== 'string') {
          throw new Error(
            `agent ${JSON.stringify(toolName)} carries a malformed skill preload; refusing to start a child that would silently drop it`,
          )
        }
        if (preload.content.trim() === '') {
          throw new Error(
            `agent ${JSON.stringify(toolName)} declares skill ${JSON.stringify(preload.name)} with an empty body; the host would preload nothing, so the equivalent face would be a lie`,
          )
        }
        blocks.push({ type: 'text', text: renderSkillEnvelope(preload) })
      }
      blocks.push({ type: 'text', text: prompt })
      const started = await subagents.startActivation({
        provider: config.provider ?? 'spawn',
        label,
        prompt: blocks,
        parent,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        delivery: 'parent',
      })
      return { name: started?.name ?? 'agent' }
    },
  }
}

export function apply(ctx: any, config: Config = {}): void {
  const agents = Array.isArray(config.agents) ? config.agents : []
  if (agents.length > 0 && ctx.get('subagents') === undefined) {
    // A warning, not a throw: the catalog is still true and useful; only
    // invocation is degraded, and the tool itself says so per call.
    ctx.logger?.warn?.(
      'anyplugin-materialize-agents: ctx.subagents is absent; agents are listed but cannot start a child (ARCHITECTURE §8, P4)',
    )
  }

  const register = (scope: any): void => {
    for (const agent of agents) {
      const problem = agentProblem(agent, config.plugin)
      if (problem !== undefined) {
        ctx.logger?.warn?.(`anyplugin-materialize-agents: skipped ${JSON.stringify(agent?.name ?? '?')}: ${problem}`)
        continue
      }
      const definition = agentTool(agent, ctx, config)
      ctx.effect(() => {
        try {
          return scope.get('tools').register(definition)
        } catch (error) {
          // A duplicate name must not take the whole group down; the report
          // still shows the agent and this states why the tool is absent.
          ctx.logger?.warn?.(
            `anyplugin-materialize-agents: could not register ${JSON.stringify((definition as { name: string }).name)}: ${(error as Error).message}`,
          )
          return () => {}
        }
      })
    }
  }

  if (ctx.get('tools') === undefined) {
    // The catalog cannot be registered yet. Record why instead of leaving the
    // group silently without tools, then register when the service appears.
    ctx.logger?.warn?.(
      'anyplugin-materialize-agents: ctx.tools is absent; agents are declared but cannot be registered until the tools service appears (ARCHITECTURE §8, P4)',
    )
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (scoped: any) => register(scoped))
    }
    return
  }
  register(ctx)
}
