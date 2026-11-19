/**
 * Skill materializer — a DSH plugin whose *config* is the payload.
 *
 * The emitter never generates code (AGENTS.md §3.3): it produces a group entry
 * whose child is this plugin with a config listing the skills to add. Loading
 * the entry is what performs the side effect.
 *
 * Lifecycle: registers through `ctx.effect`, because cordis has no `dispose`
 * event (S1 finding 3) — a bare `ctx.skills.register()` would leak the skill
 * after the plugin is unloaded.
 */
export const name = 'anyplugin-materialize-skill'
export const inject = ['skills']

export interface MaterialSkill {
  name: string
  description: string
  content: string
  whenToUse?: string
  invocation?: { modelInvocable: boolean; userInvocable: boolean }
  /** Absolute instruction file path, when the skill came from a file. */
  path?: string
  resourceDir?: string
}

export interface Config {
  /** `SkillSource` label reported by the registry. */
  source?: string
  skills?: MaterialSkill[]
}

interface Registration {
  name: string
  description: string
  content: string
  source: string
  whenToUse?: string
  invocation?: { modelInvocable: boolean; userInvocable: boolean }
  path?: string
}

export function apply(ctx: any, config: Config = {}): void {
  const source = config.source ?? 'custom'
  for (const skill of config.skills ?? []) {
    const registration: Registration = {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source,
    }
    if (skill.whenToUse !== undefined) registration.whenToUse = skill.whenToUse
    if (skill.invocation !== undefined) registration.invocation = skill.invocation
    if (skill.path !== undefined) registration.path = skill.path
    const resourceBase = skill.resourceDir
      ? { kind: 'directory' as const, path: skill.resourceDir }
      : undefined
    ctx.effect(() =>
      ctx.skills.register(
        resourceBase ? { ...registration, resourceBase } : registration,
      ),
    )
  }
}
