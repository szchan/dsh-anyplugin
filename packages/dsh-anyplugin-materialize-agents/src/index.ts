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
 */
export const name = 'anyplugin-materialize-agents'
// No static `inject`: apply() runs even when `ctx.tools` is late or missing, so
// the degradation is recorded instead of the plugin silently never applying.
export const inject = []

/** One agent as the emitter wrote it into this plugin's config. */
export interface MaterialAgent {
  name: string
  description: string
  /** Body exactly as authored, frontmatter removed. */
  content: string
  /** Source path, kept for diagnostics only. */
  path?: string
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
      const started = await subagents.startActivation({
        provider: config.provider ?? 'spawn',
        label,
        // Two blocks, in order: the persona body is the first content the child
        // reads, then the parent's task. Neither is ever a tool description.
        prompt: [
          { type: 'text', text: agent.content },
          { type: 'text', text: prompt },
        ],
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
