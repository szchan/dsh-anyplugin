// This layer's own policy for Claude model identity (D91). A Claude agent file
// may declare `model: opus|sonnet|haiku` and an `effort:` name; no DSH provider
// advertises those aliases, so the face is not upstream reimplementation. This
// module declares the mapping as data: shipped defaults, overridable by one
// user document, resolved against the session catalog before anything is
// forwarded. An id or effort the catalog does not advertise is never sent
// (S16: an unknown effort kills the child turn), and the gap is returned so
// the caller can record it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The effort-id vocabulary this layer accepts in the document. It is the
 * union of ids DSH providers advertise today; an id outside it is a document
 * error rather than something to discover at runtime. */
export const EFFORT_NAMES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortName = (typeof EFFORT_NAMES)[number]

/** Environment override for the user document path (tests and CI use it). */
export const MODEL_MAP_ENV = 'ANYPLUGIN_MODEL_MAP'
const MODEL_MAP_DIR = join('.config', 'dsh-anyplugin', 'model-map.json')

/** One provider route: an optional declared provider, a model id the catalog
 * must advertise, and an optional reasoning effort the catalog must advertise. */
export interface ModelRoute {
  provider?: string
  model: string
  effort?: EffortName
}

/** Alias -> route. Aliases are the Claude names a frontmatter `model:` uses. */
export type ModelMap = Record<string, ModelRoute>

/**
 * Shipped defaults. The mapping is this layer's policy, not Claude semantics:
 * a Claude alias names no provider model id, and the DSH runtime has no alias
 * resolution at all (S16). `deepseek-flash` is the v4.1 model as the maintainer
 * describes it; most users run a DeepSeek account, so the defaults target that
 * provider first and fall back to any other provider advertising the id.
 */
export const DEFAULT_MODEL_MAP: Readonly<ModelMap> = Object.freeze({
  opus: Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash', effort: 'max' }),
  sonnet: Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' }),
  haiku: Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash', effort: 'low' }),
})

export type Env = Record<string, string | undefined>

export interface ModelMapPathOptions {
  env?: Env
  homedir?: string
}

/** The user document path: `ANYPLUGIN_MODEL_MAP`, else `~/.config/dsh-anyplugin/model-map.json`. */
export function modelMapPath(options: ModelMapPathOptions = {}): string {
  const env = options.env ?? process.env
  const configured = env[MODEL_MAP_ENV]?.trim()
  if (configured !== undefined && configured !== '') return configured
  return join(options.homedir ?? osHomedir(), MODEL_MAP_DIR)
}

export interface DocumentValidation {
  /** Present only when every route validated; a document with a problem applies nothing. */
  models?: ModelMap
  problems: string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const ROUTE_KEYS = ['provider', 'model', 'effort']

/**
 * Validate one user document strictly: unknown keys are errors, an unknown
 * effort name is an error, and a route is `{provider?, model, effort?}`. A
 * single problem rejects the whole document, so a review can never see a
 * half-applied map whose provenance is ambiguous.
 */
export function validateModelMapDocument(text: string, source = 'model-map'): DocumentValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { problems: [`${source}: not valid JSON (${messageOf(error)})`] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { problems: [`${source}: the document must be a JSON object`] }
  }
  const problems: string[] = []
  const top = parsed as Record<string, unknown>
  for (const key of Object.keys(top)) {
    if (key !== 'models') problems.push(`${source}: unknown top-level key "${key}" (only "models" is accepted)`)
  }
  const rawModels = top.models
  if (rawModels === undefined) {
    problems.push(`${source}: "models" is required`)
    return { problems }
  }
  if (typeof rawModels !== 'object' || rawModels === null || Array.isArray(rawModels)) {
    problems.push(`${source}: "models" must be an object of alias -> route`)
    return { problems }
  }
  const models: ModelMap = {}
  for (const [alias, rawRoute] of Object.entries(rawModels as Record<string, unknown>)) {
    let routeProblems = 0
    const problem = (text: string): void => {
      routeProblems += 1
      problems.push(text)
    }
    if (alias.trim() === '') {
      problem(`${source}: a model alias must be a non-empty string`)
      continue
    }
    if (typeof rawRoute !== 'object' || rawRoute === null || Array.isArray(rawRoute)) {
      problem(`${source}: route for "${alias}" must be an object`)
      continue
    }
    const route = rawRoute as Record<string, unknown>
    for (const key of Object.keys(route)) {
      if (!ROUTE_KEYS.includes(key)) {
        problem(`${source}: route for "${alias}" has unknown key "${key}" (accepted: provider, model, effort)`)
      }
    }
    const model = route.model
    if (model === undefined) {
      problem(`${source}: route for "${alias}": "model" is required`)
    } else if (typeof model !== 'string' || model.trim() === '') {
      problem(`${source}: route for "${alias}": "model" must be a non-empty string`)
    }
    const provider = route.provider
    if (provider !== undefined && (typeof provider !== 'string' || provider.trim() === '')) {
      problem(`${source}: route for "${alias}": "provider" must be a non-empty string when present`)
    }
    const effort = route.effort
    if (effort !== undefined && (typeof effort !== 'string' || !isEffortName(effort))) {
      problem(
        `${source}: route for "${alias}": unknown effort "${String(effort)}" (accepted: ${EFFORT_NAMES.join(', ')})`,
      )
    }
    if (routeProblems === 0 && typeof model === 'string') {
      const clean: ModelRoute = { model }
      if (typeof provider === 'string') clean.provider = provider
      if (typeof effort === 'string' && isEffortName(effort)) clean.effort = effort
      models[alias] = clean
    }
  }
  if (problems.length > 0) return { problems }
  return { models, problems }
}

/** True when `value` is one of the effort ids this layer accepts. */
export function isEffortName(value: string): value is EffortName {
  return (EFFORT_NAMES as readonly string[]).includes(value)
}

/** Canonical on-disk form: sorted aliases, two-space indent, trailing newline. */
export function serializeModelMapDocument(models: ModelMap): string {
  const sorted: ModelMap = {}
  for (const alias of Object.keys(models).sort()) sorted[alias] = models[alias]
  return `${JSON.stringify({ models: sorted }, null, 2)}\n`
}

export type ModelMapSource = 'default' | 'user'

export interface EffectiveModelMapEntry {
  alias: string
  route: ModelRoute
  source: ModelMapSource
}

/** The merged map as one document plus its provenance and problems. */
export interface EffectiveModelMap {
  path: string
  /** The user document that was read, or null when none exists. */
  document: string | null
  entries: EffectiveModelMapEntry[]
  overrides: string[]
  problems: string[]
}

/**
 * Merge the shipped defaults with the user document. The user document is read
 * once; a missing document is the normal case, an unreadable or malformed one
 * is a visible problem and leaves the defaults in force.
 */
export function loadEffectiveModelMap(options: ModelMapPathOptions = {}): EffectiveModelMap {
  const path = modelMapPath(options)
  const problems: string[] = []
  let document: string | null = null
  let user: ModelMap | undefined
  let text: string | undefined
  try {
    text = readFileSync(path, 'utf8')
    document = path
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') problems.push(`${path}: the model-map document could not be read (${messageOf(error)})`)
  }
  if (text !== undefined) {
    const validation = validateModelMapDocument(text, path)
    problems.push(...validation.problems)
    user = validation.models
  }
  const merged = new Map<string, EffectiveModelMapEntry>()
  for (const alias of Object.keys(DEFAULT_MODEL_MAP).sort()) {
    merged.set(alias, { alias, route: DEFAULT_MODEL_MAP[alias], source: 'default' })
  }
  if (user !== undefined) {
    for (const alias of Object.keys(user)) merged.set(alias, { alias, route: user[alias], source: 'user' })
  }
  const entries = [...merged.values()].sort((left, right) => (left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0))
  const overrides = entries.filter((entry) => entry.source === 'user').map((entry) => entry.alias)
  return { path, document, entries, overrides, problems }
}

/** The route declared for an alias, or undefined when the alias is not mapped. */
export function findModelMapRoute(map: EffectiveModelMap, alias: string): EffectiveModelMapEntry | undefined {
  return map.entries.find((entry) => entry.alias === alias)
}

/**
 * Why mapped faces must not be honoured, or undefined when the map is usable.
 * A user document that exists but fails strict validation is unresolvable: the
 * shipped defaults are still *visible* as a fallback, but silently forwarding
 * them would carry a policy the user did not declare, so callers refuse the
 * mapping and the agent runs on the session default.
 */
export function modelMapRefusal(map: EffectiveModelMap): string | undefined {
  if (map.document === null || map.problems.length === 0) return undefined
  return `the model-map document ${map.document} is malformed, so no route can be trusted (${map.problems.join('; ')})`
}

/** A short human description of a route, used by reason strings and CLI text. */
export function describeModelRoute(route: ModelRoute): string {
  const provider = route.provider === undefined ? 'the session provider' : `provider "${route.provider}"`
  const effort = route.effort === undefined ? '' : ` at effort "${route.effort}"`
  return `${provider} model "${route.model}"${effort}`
}

/** The human `model-map` report line(s): path, provenance, problems. */
export function formatEffectiveModelMap(map: EffectiveModelMap): string {
  const lines = [
    `model-map: ${map.path} (${map.document === null ? 'no user document, built-in defaults' : 'user document plus built-in defaults'})`,
  ]
  for (const entry of map.entries) {
    lines.push(`  ${entry.alias} -> ${describeModelRoutePlain(entry.route)} (${entry.source})`)
  }
  for (const problem of map.problems) lines.push(`  problem: ${problem}`)
  return lines.join('\n')
}

function describeModelRoutePlain(route: ModelRoute): string {
  const provider = route.provider === undefined ? '' : `${route.provider}/`
  const effort = route.effort === undefined ? '' : ` @ ${route.effort}`
  return `${provider}${route.model}${effort}`
}

export interface ModelMapReport {
  path: string
  document: string | null
  entries: { alias: string; provider: string | null; model: string; effort: string | null; source: ModelMapSource }[]
  overrides: string[]
  problems: string[]
}

/** The `effectiveMapping` section `report --json` carries. */
export function modelMapReport(map: EffectiveModelMap): ModelMapReport {
  return {
    path: map.path,
    document: map.document,
    entries: map.entries.map((entry) => ({
      alias: entry.alias,
      provider: entry.route.provider ?? null,
      model: entry.route.model,
      effort: entry.route.effort ?? null,
      source: entry.source,
    })),
    overrides: map.overrides,
    problems: map.problems,
  }
}

/** The subset of the DSH `llm` service this module needs; structurally typed so
 * the materializer can pass the live service with no harness import. */
export interface ModelCatalogProvider {
  id: string
}

export interface ModelCatalogModel {
  id: string
}

export interface ModelCatalog {
  listProviders(): readonly ModelCatalogProvider[]
  listModels(provider: string): Promise<readonly ModelCatalogModel[]>
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts?: readonly { id: string }[] } }>
}

export interface RouteResolution {
  /** False when the model id cannot be forwarded: the child stays on the session default. */
  forward: boolean
  provider?: string
  model?: string
  effort?: string
  gaps: string[]
}

/** What `model-map set` did: the canonical document written, or the problems. */
export interface ModelMapSetResult {
  path: string
  written: boolean
  problems: string[]
  models?: ModelMap
}

/**
 * Validate `<path-or-json>` exactly as `model-map set` accepts it: an inline
 * JSON document when the argument starts with `{`, otherwise a path read from
 * disk. On success the canonical form is written to the user document path
 * (never to profile config); a single validation problem writes nothing.
 */
export function setModelMapDocument(input: string, options: ModelMapPathOptions = {}): ModelMapSetResult {
  const path = modelMapPath(options)
  const trimmed = input.trim()
  let text: string
  if (trimmed.startsWith('{')) {
    text = trimmed
  } else {
    try {
      text = readFileSync(input, 'utf8')
    } catch (error) {
      return { path, written: false, problems: [`${input}: could not read the document (${messageOf(error)})`] }
    }
  }
  const validation = validateModelMapDocument(text, trimmed.startsWith('{') ? 'inline document' : input)
  if (validation.models === undefined) return { path, written: false, problems: validation.problems }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializeModelMapDocument(validation.models), 'utf8')
  } catch (error) {
    return { path, written: false, problems: [`${path}: could not write the document (${messageOf(error)})`] }
  }
  return { path, written: true, problems: [], models: validation.models }
}

/** What `model-map reset` did: the user document is gone, defaults are in force. */
export interface ModelMapResetResult {
  path: string
  removed: boolean
  problems: string[]
}

/**
 * Remove the user document. Deleting an absent document is a success, not an
 * error: reset means "be on the shipped defaults".
 */
export function resetModelMapDocument(options: ModelMapPathOptions = {}): ModelMapResetResult {
  const path = modelMapPath(options)
  try {
    rmSync(path, { force: true })
  } catch (error) {
    return { path, removed: false, problems: [`${path}: could not remove the document (${messageOf(error)})`] }
  }
  return { path, removed: true, problems: [] }
}

export interface ResolveRouteOptions {
  /** The parent's current provider, preferred when it advertises the model id. */
  sessionProvider?: string
  signal?: AbortSignal
}

/**
 * Resolve a document route against the live catalog. The session provider is
 * tried first, then the declared provider, then every other registered
 * provider; the first one that advertises the model id owns the route. The
 * effort is forwarded only when the selected provider confirms it, because an
 * unknown reasoning-effort id fails the child turn (S16). Anything dropped is
 * returned in `gaps` so the caller can record it on the agent.
 */
export async function resolveModelRoute(
  catalog: ModelCatalog,
  route: ModelRoute,
  options: ResolveRouteOptions = {},
): Promise<RouteResolution> {
  const gaps: string[] = []
  const providers = catalog.listProviders().map((provider) => provider.id)
  const ordered: string[] = []
  for (const provider of [options.sessionProvider, route.provider, ...providers]) {
    if (provider !== undefined && providers.includes(provider) && !ordered.includes(provider)) ordered.push(provider)
  }
  let selected: string | undefined
  for (const provider of ordered) {
    let models: readonly ModelCatalogModel[]
    try {
      models = await catalog.listModels(provider)
    } catch (error) {
      gaps.push(`provider "${provider}" did not expose a model catalog (${messageOf(error)})`)
      continue
    }
    if (models.some((model) => model.id === route.model)) {
      selected = provider
      break
    }
  }
  if (selected === undefined) {
    gaps.push(
      `no registered provider advertises model id "${route.model}" (providers tried: ${ordered.length === 0 ? 'none' : ordered.join(', ')}); not forwarding the route, so the agent runs on the session default`,
    )
    return { forward: false, gaps }
  }
  if (
    route.provider !== undefined &&
    route.provider !== selected &&
    (selected !== options.sessionProvider || !providers.includes(route.provider))
  ) {
    gaps.push(
      `the declared provider "${route.provider}" ${providers.includes(route.provider) ? 'does not advertise' : 'is not registered and does not advertise'} "${route.model}"; resolved it on provider "${selected}" instead`,
    )
  }
  let effort: string | undefined
  if (route.effort !== undefined) {
    if (!isEffortName(route.effort)) {
      gaps.push(`effort "${route.effort}" is not one of this layer's accepted effort names (${EFFORT_NAMES.join(', ')}); dropped it`)
    } else if (catalog.resolveModelInfo === undefined) {
      gaps.push(`the catalog cannot report reasoning efforts; dropped effort "${route.effort}" rather than send an unverified id`)
    } else {
      let advertised: string[] | undefined
      let confirmed = false
      try {
        const info = await catalog.resolveModelInfo(selected, route.model, options.signal)
        advertised = info.reasoning?.efforts?.map((candidate) => candidate.id)
        confirmed = true
      } catch (error) {
        gaps.push(
          `could not confirm whether provider "${selected}" advertises effort "${route.effort}" for "${route.model}" (${messageOf(error)}); dropped the effort rather than risk an unknown reasoning-effort id`,
        )
      }
      // The no-reasoning gap must not depend on `gaps.length`: an unrelated
      // provider failing earlier in the walk would otherwise make the dropped
      // effort silent.
      if (confirmed && advertised === undefined) {
        gaps.push(`provider "${selected}" reports no reasoning efforts for "${route.model}"; dropped effort "${route.effort}"`)
      } else if (advertised !== undefined) {
        if (advertised.includes(route.effort)) effort = route.effort
        else {
          gaps.push(
            `provider "${selected}" does not advertise effort "${route.effort}" for "${route.model}" (advertised: ${advertised.length === 0 ? 'none' : advertised.join(', ')}); dropped it`,
          )
        }
      }
    }
  }
  return {
    forward: true,
    provider: selected,
    model: route.model,
    ...(effort === undefined ? {} : { effort }),
    gaps,
  }
}
