/**
 * Output-style materializer — a DSH plugin whose *config* is the payload.
 *
 * The emitter never generates code (AGENTS §3.3): it places one child whose
 * config carries the selected style body, and loading that entry is what
 * applies it. Selection happened at compile time from the profile activation
 * record (or `force-for-plugin`); this plugin only performs the chosen effect,
 * so an unknown name can never be applied by accident at run time.
 *
 * The seam is agent-scoped (S11): `agent/created` is `@mode serial`, so this
 * listener runs before the agent's creation resolves, and the handler
 * registers on `payload.agent.ctx`. Registering there never mutates another
 * agent's prompt, and the section unwinds when that agent is disposed. Every
 * top-level agent created after load gets the style — including a fork, which
 * is the main conversation's continuation — but a `subagent` child does not:
 * the pinned docs say other subagents run their own system prompt, so styles
 * do not change how they respond (output-styles, 2.1.329). A `complete: true`
 * style on a subagent would otherwise replace its entire prompt.
 * `complete: true` replaces a top-level prompt; `interpolate: false` keeps the
 * body byte-for-byte, because a style body is prompt text, not a template.
 */
export const name = 'anyplugin-materialize-output-style'
/** No required service: the listener checks the agent's seam and degrades. */
export const inject: string[] = []

/**
 * Above every host-reserved order (`HARNESS_SOURCE` is 10000 and the persona
 * suffix 10200 in 0.2.2-rc.5), so an appended style renders after the host's
 * own sections and the composed bytes are deterministic.
 */
export const OUTPUT_STYLE_ORDER = 20_000

export interface Config {
  /** Plugin that owns the style; the identity is `<plugin>:<name>`. */
  plugin?: string
  name?: string
  description?: string
  /** The body exactly as the dialect read it; applied untrimmed. */
  body?: string
  keepCodingInstructions?: boolean
  forceForPlugin?: boolean
  /** `true` replaces the whole prompt; the emitter sets this for `keep-coding-instructions: false`. */
  complete?: boolean
  /** Which channel selected this style: an explicit profile record or the force flag. */
  source?: 'explicit' | 'force'
  /** The compile-time trace, kept for diagnostics in the composition. */
  trace?: string
}

export function apply(ctx: any, config: Config = {}): void {
  const body = config.body
  if (typeof body !== 'string' || body.trim().length === 0) {
    // A carried body is the payload; an empty or whitespace-only one would
    // silently be no style (and, with `complete`, would blank the prompt).
    ctx.logger?.warn?.('[anyplugin] output style is missing its body; no prompt section was registered')
    return
  }
  const plugin = config.plugin ?? 'unknown'
  const styleName = config.name ?? 'unknown'
  const label = `${plugin}:${styleName}`
  const sectionName = `anyplugin:output-style:${label}`
  const complete = config.complete === true

  ctx.on('agent/created', (payload: any) => {
    // A subagent session runs its own system prompt upstream; skip it before
    // touching the seam. `origin` is durable session-header metadata, not a
    // runtime guess (dsh-session SessionHeader.origin @ 0.2.2-rc.5).
    const agent = payload?.agent
    const origin = agent?.session?.header?.origin ?? agent?.session?.meta?.origin
    if (origin === 'subagent') return
    const prompt = agent?.ctx?.systemPrompt
    if (!prompt || typeof prompt.section !== 'function') {
      // Detect the seam, never assume it (AGENTS §6): the host stays usable
      // when the service is absent, and the reason is recorded in the log.
      ctx.logger?.warn?.(`[anyplugin] agent-scoped systemPrompt.section is unavailable; output style ${JSON.stringify(label)} was not applied`)
      return
    }
    prompt.section({
      name: sectionName,
      order: OUTPUT_STYLE_ORDER,
      text: body,
      // A style body is prompt text, not a template: `{{...}}` stays literal.
      interpolate: false,
      ...(complete ? { complete: true } : {}),
    })
  })
}
