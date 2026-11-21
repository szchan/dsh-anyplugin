/**
 * Claude Code dialect — reads a plugin directory and produces an IR.
 *
 * Every rule here is pinned to the behaviour *observed* from the host at
 * `CLAUDE_CODE_PIN`, not to the documentation (D8: the host's own report wins).
 * When the pin moves, `npm run capture:fixtures` must be re-run and this file
 * re-read against the new goldens.
 *
 * The dialect never inspects DSH. Whether a node can be materialized is the
 * materializer's business; this file only records what the source declares and
 * how faithfully we expect to carry it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  Annotation,
  ClaudePluginIr,
  IrAgent,
  IrAgentFaces,
  IrAgentSkill,
  IrHook,
  IrMcpServer,
  IrOutputStyle,
  IrOutputStyleFaces,
  IrPin,
  IrSkill,
  IrUnmaterialized,
} from '../../dsh-anyplugin-ir/src/index.ts'
import { IR_SCHEMA, weakestAnnotation } from '../../dsh-anyplugin-ir/src/index.ts'

export const CLAUDE_CODE_PIN: IrPin = { tool: 'claude-code', version: '2.1.329' }

export interface ReadOptions {
  pin?: IrPin
  /** Label recorded in the IR, e.g. `plugin-dir:fixtures/claude-skills-only`. */
  source?: string
}

export interface Frontmatter {
  data: Record<string, unknown>
  body: string
  /** False when the file opens with `---` but never closes it. */
  closed: boolean
}

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === '') return ''
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => parseScalar(part))
      .filter((part) => part !== '')
  }
  return value
}

/**
 * Minimal YAML subset: scalar keys, inline arrays, and `|` block scalars.
 * Deliberately not a full YAML parser — anything it does not understand stays a
 * raw string rather than being silently dropped.
 */
export function parseFrontmatter(text: string): Frontmatter {
  // A byte-order mark is not part of the document, but it does defeat `^---`.
  // Strip it before matching so a BOM cannot turn the whole file into the body.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(source)
  if (!match) return { data: {}, body: source, closed: true }
  const data: Record<string, unknown> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1]
    const rest = pair[2]
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const collected: string[] = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        collected.push(lines[i + 1])
        i++
      }
      const block = dedentBlock(collected)
      const value = rest.startsWith('>')
        ? foldBlock(block)
        : block.join('\n').replace(/\n+$/, '')
      data[key] = rest.endsWith('-') ? value.replace(/\n+$/, '') : value
      continue
    }
    // A plain scalar continues on the following indented lines. Claude's
    // frontmatter is full of wrapped descriptions; dropping the continuation
    // would silently shorten the value.
    const parts = [rest.trim()]
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      parts.push(lines[++i].trim())
    }
    data[key] = parseScalar(parts.filter(Boolean).join(' '))
  }
  return { data, body: source.slice(match[0].length), closed: true }
}

/** Remove the block scalar's common indentation, keeping deeper nesting. */
function dedentBlock(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(indent, /^[ \t]*/.exec(line)?.[0].length ?? 0)))
}

/** YAML folded style: single line breaks become spaces, a blank line one newline. */
function foldBlock(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/([^\n])\n(?=[^\n])/g, '$1 ')
    .replace(/\n{2,}/g, (breaks) => '\n'.repeat(breaks.length - 1))
    .replace(/\n+$/, '')
}

function stringField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function boolField(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/**
 * Claude accepts a comma-separated string (`tools: Read, Grep`) as well as an
 * inline array. The string form is the common one in agent files, so a parser
 * that only accepts arrays silently drops the restriction.
 */
function stringListField(data: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) {
      const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      if (list.length > 0) return list
    }
    if (typeof value === 'string' && value.trim()) {
      const list = value.split(',').map((item) => item.trim()).filter(Boolean)
      if (list.length > 0) return list
    }
  }
  return undefined
}

function numberField(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  }
  return undefined
}

function readIfFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

interface MarkdownFile {
  /** Path relative to the plugin root, with forward slashes. */
  rel: string
  abs: string
  /** 1 for `dir/file.md`, 2 for `dir/sub/file.md`, … */
  depth: number
}

function markdownFiles(dir: string, root: string): MarkdownFile[] {
  const found: MarkdownFile[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name)
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const rel = abs.slice(root.length + 1).split('\\').join('/')
        found.push({ rel, abs, depth: rel.split('/').length - 1 })
      }
    }
  }
  visit(dir)
  return found.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

function readManifest(root: string): Record<string, unknown> {
  const path = join(root, '.claude-plugin', 'plugin.json')
  const text = readIfFile(path)
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The body survives byte for byte; the envelope it arrives in does not. Claude
 * Code hands a loaded skill to the model as a user message that opens with
 * "Base directory for this skill: <dir>", DSH wraps the same body in
 * <skill_content name="..."><skill_resources>...</skill_resources>
 * <skill_instructions>...</skill_instructions></skill_content>. Equal
 * information, different bytes, so this is equivalent and not exact.
 *
 * A second difference surfaced with the trace: Claude substitutes the
 * frontmatter's `arguments:` placeholders ($name, $ARGUMENTS) before delivery.
 * DSH's skill tool cannot: it takes `{name}` and has no args channel (D17).
 */
const SKILL_EQUIVALENT: Annotation = {
  fidelity: 'equivalent',
  reason:
    'Body is preserved byte for byte inside a different envelope (DSH wraps it in <skill_content>/<skill_instructions>; Claude sends it as a user message prefixed with the base-directory line). Argument placeholders ($ARGUMENTS, $N, $name) are not substituted: DSH\'s skill tool takes {name} and Claude\'s takes {skill, args} (DECISIONS D17).',
}

/**
 * The human face of a command: typing `/plugin:name args` and having the body
 * expanded and submitted as a user message. Needs two additive DSH seams
 * (DECISIONS D10) that the installed harness does not have yet.
 */
const COMMAND_HUMAN_PLANNED: Annotation = {
  fidelity: 'planned',
  reason:
    'DSH refuses a colon in a command name (dsh-commands COMMAND_NAME) and a command handler cannot submit a prompt ("without sending the command to the model"). Both seams are additive and proposed (DECISIONS D10); the expansion engine is implemented and tested, waiting for them.',
}

/** The model face of a command: the host lists it in the skills inventory. */
const COMMAND_MODEL_EQUIVALENT: Annotation = {
  fidelity: 'equivalent',
  reason:
    'At this pin the host reports a command in the same Skills inventory as a SKILL.md, with the same name, description and body, so the catalog face matches. The invocation face does not, which is why the component overall is planned.',
}

const COMMAND_PLANNED: Annotation = {
  fidelity: 'planned',
  reason:
    'Weakest-face rule: the model catalog face is materialized as a skill, but the human face (/plugin:name with $ARGUMENTS) still needs the two additive seams described in DECISIONS D10.',
}

function nestedUnsupported(surface: 'commands' | 'agents'): Annotation {
  const detail =
    surface === 'agents'
      ? 'a nested `agents/**/*.md` file is outside the top-level agents surface; `claude --plugin-dir … plugin details` reports Agents (0) for a nested-only tree (the fixture reports Agents (1) because `agents/reviewer.md` is top-level)'
      : 'a nested command file is outside the top-level commands surface'
  return {
    fidelity: 'unsupported',
    reason: `Not loaded by the host at this pin: ${detail}. Recorded so the gap is visible rather than silently dropped.`,
  }
}

function skillFromFile(
  file: MarkdownFile,
  root: string,
  origin: IrSkill['origin'],
  annotation: Annotation,
  fallbackName?: string,
  faces?: IrSkill['faces'],
): IrSkill | undefined {
  const parsed = parseFrontmatter(readFileSync(file.abs, 'utf8'))
  if (!parsed.closed) {
    // A broken frontmatter block still loads upstream, with every field
    // ignored — so the body is kept and the identity falls back to the path.
    return {
      kind: 'skill',
      name: fallbackName ?? basename(dirname(file.abs)),
      description: '',
      content: readFileSync(file.abs, 'utf8'),
      invocation: { modelInvocable: true, userInvocable: true },
      origin,
      sourcePath: file.rel,
      annotation: {
        fidelity: 'equivalent',
        reason: 'Unterminated frontmatter: the host ignores all fields but still loads the body, so the raw file is used as the body and identity falls back to the path.',
      },
    }
  }
  const name = stringField(parsed.data, 'name') ?? fallbackName
  if (!name) return undefined
  const invocation = {
    modelInvocable: !boolField(parsed.data, 'disable-model-invocation'),
    userInvocable: boolField(parsed.data, 'user-invocable') !== false,
  }
  const argumentNames = argumentNamesFrom(parsed.data['arguments'])
  return {
    kind: 'skill',
    name,
    description: stringField(parsed.data, 'description') ?? '',
    content: parsed.body,
    ...(stringField(parsed.data, 'whenToUse', 'when-to-use')
      ? { whenToUse: stringField(parsed.data, 'whenToUse', 'when-to-use') }
      : {}),
    invocation,
    origin,
    sourcePath: file.rel,
    resourceDir: dirname(file.abs),
    ...(argumentNames ? { argumentNames } : {}),
    ...(faces ? { faces } : {}),
    annotation,
  }
}

function readSkillsAndCommands(root: string): {
  skills: IrSkill[]
  pending: IrUnmaterialized[]
  unsupported: IrUnmaterialized[]
} {
  const skills: IrSkill[] = []
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []

  const rootSkill = readIfFile(join(root, 'SKILL.md'))
  if (rootSkill !== undefined) {
    if (rootSkill.trim() === '') {
      // A zero-byte file is present but carries nothing; saying it is missing
      // would be false, and calling it a skill would claim a body it lacks.
      pending.push({
        surface: 'skills',
        name: basename(root),
        sourcePath: 'SKILL.md',
        annotation: { fidelity: 'planned', reason: 'SKILL.md is empty; nothing to load.' },
      })
    } else {
      const skill = skillFromFile(
        { rel: 'SKILL.md', abs: join(root, 'SKILL.md'), depth: 0 },
        root,
        'root-skill',
        SKILL_EQUIVALENT,
        basename(root),
      )
      if (skill) skills.push(skill)
    }
  }

  const skillsDir = join(root, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(skillsDir, entry.name)
      if (entry.isDirectory()) {
        const file = join(abs, 'SKILL.md')
        const text = readIfFile(file)
        if (text === undefined) {
          pending.push({
            surface: 'skills',
            name: entry.name,
            sourcePath: `skills/${entry.name}`,
            annotation: {
              fidelity: 'planned',
              reason: 'Directory has no SKILL.md; nothing to load. Kept in the report so an empty skill slot is visible.',
            },
          })
          continue
        }
        if (text.trim() === '') {
          // `readIfFile` returns '' for a zero-byte file, which used to fall
          // into the "no SKILL.md" branch and report a false reason.
          pending.push({
            surface: 'skills',
            name: entry.name,
            sourcePath: `skills/${entry.name}/SKILL.md`,
            annotation: { fidelity: 'planned', reason: 'SKILL.md is empty; nothing to load.' },
          })
          continue
        }
        const skill = skillFromFile(
          { rel: `skills/${entry.name}/SKILL.md`, abs: file, depth: 2 },
          root,
          'skills-dir',
          SKILL_EQUIVALENT,
        )
        if (skill) skills.push(skill)
      } else if (entry.name.endsWith('.md')) {
        unsupported.push({
          surface: 'skills',
          name: entry.name.replace(/\.md$/, ''),
          sourcePath: `skills/${entry.name}`,
          annotation: {
            fidelity: 'unsupported',
            reason: 'A bare skills/<name>.md is a DSH discovery form, not a Claude Code one; the host loads only skills/<dir>/SKILL.md.',
          },
        })
      }
    }
  }

  const commandsDir = join(root, 'commands')
  if (existsSync(commandsDir)) {
    for (const file of markdownFiles(commandsDir, root)) {
      const name = basename(file.abs).replace(/\.md$/, '')
      if (file.depth !== 1) {
        unsupported.push({ surface: 'commands', name, sourcePath: file.rel, annotation: nestedUnsupported('commands') })
        continue
      }
      const skill = skillFromFile(file, root, 'commands-dir', COMMAND_PLANNED, name, {
        model: COMMAND_MODEL_EQUIVALENT,
        human: COMMAND_HUMAN_PLANNED,
      })
      if (skill) skills.push(skill)
    }
  }

  return { skills, pending, unsupported }
}

/**
 * S16 — every agent frontmatter face, observed against the host at the pin.
 *
 * The catalog face is exact because a plugin can register its own tool with the
 * agent's name and its frontmatter description, verbatim; `ctx.tools.schemas()`
 * is what the model reads. The invocation face is equivalent because the seam
 * starts the child with the body as a *user message*
 * (`SubagentStartRequest.prompt`), not as its system prompt, and because N tools
 * replace Claude's single `Task` with a `subagent_type` enum.
 *
 * The remaining keys are one face each. `spikes/s16-agent-faces` found that the
 * pin ignores all of them as activation fields: the child keeps the parent's
 * toolset (`echo` still visible under `tools: [Read, Grep]`), runs past
 * `maxTurns: 1` (three requests), keeps the parent's cwd under
 * `isolation: worktree`, and receives no skill text. `agentOptions.model` does
 * reach the provider, but literally — `sonnet` arrives as a model id the
 * provider may know nothing about — and `agentOptions.reasoningEffort` only
 * works when the provider advertises that exact id. So model and effort are
 * `unsupported` (the escape layer that delegates to the real client is the only
 * path), tools and maxTurns are `unsupported`, isolation is `planned` behind a
 * named child-composition seam, and `skills` is `equivalent` only when every
 * declared name resolves to a body this plugin ships (prepended to the child's
 * first user message), `planned` otherwise. The overall annotation is the
 * weakest face, so a component can never read as fully carried.
 */
export function agentFaces(
  agent: Pick<
    IrAgent,
    | 'name'
    | 'model'
    | 'tools'
    | 'disallowedTools'
    | 'effort'
    | 'maxTurns'
    | 'isolation'
    | 'skills'
    | 'skillContents'
    | 'memory'
    | 'background'
    | 'omitClaudeMd'
    | 'color'
    | 'autoCompactWindow'
  >,
  plugin: string,
  emptySkills: readonly string[] = [],
): IrAgentFaces {
  const toolName = `${plugin}:${agent.name}`
  const catalog: Annotation = {
    fidelity: 'exact',
    reason:
      `Registered as the model-facing tool named ${JSON.stringify(toolName)} (Claude's \`<plugin>:<agent>\` convention) with the frontmatter description byte for byte. ` +
      'The model sees exactly the name/description pair Claude\'s Task tool shows for `subagent_type` (S10).',
  }
  const invocation: Annotation = {
    fidelity: 'equivalent',
    reason:
      'Invoking the tool calls `ctx.subagents.startActivation`; the agent body is the first block of the child\'s initial user message. ' +
      'Claude starts the child with the body as its system prompt and exposes one `Task` tool with a `subagent_type` field, so the effect is the same but the tool shape and message position differ (S10).',
  }

  const faces: IrAgentFaces = { catalog, invocation }

  if (agent.model !== undefined) {
    faces.model = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`model: ${agent.model}\` names a Claude model or alias (sonnet/opus/haiku/...), not a route this deployment has. ` +
        '`startActivation` carries only `agentOptions.model`; S16 observed it reach the child model call verbatim, so forwarding `sonnet` asks the provider for a model named "sonnet". ' +
        'A vendor model identity cannot be reimplemented here: the escape layer that delegates the component to the real client (docs/TODO.md "Escape layer") is the only path.',
    }
  }

  if (agent.effort !== undefined) {
    faces.effort = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`effort: ${agent.effort}\` names a Claude effort level, not a provider one. ` +
        '`startActivation` carries `agentOptions.reasoningEffort`, but the ids are the provider\'s advertised set: S16 observed the requested id reach the child only after the provider advertised it, and with none advertised the turn dies with `UNSUPPORTED_REASONING_EFFORT`. ' +
        'Claude\'s low/medium/high/xhigh/max are model-dependent, so naming one would guess at another vendor\'s route; the escape layer is the only path.',
    }
  }

  const tools = [...(agent.tools ?? [])]
  const disallowed = [...(agent.disallowedTools ?? [])]
  if (tools.length > 0 || disallowed.length > 0) {
    const declared = [
      ...(tools.length === 0 ? [] : [`tools: ${JSON.stringify(tools)}`]),
      ...(disallowed.length === 0 ? [] : [`disallowedTools: ${JSON.stringify(disallowed)}`]),
    ]
    faces.tools = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter ${declared.join(', ')} recorded, not enforced. ` +
        '`SubagentStartRequest` has no tool filter, and S16 observed a child declared `tools: [Read, Grep]`/`disallowedTools: [Bash]` still see a tool the filter would remove. ' +
        '`ctx.tools.restrict()` takes DSH global tool names, is agent-scoped, refuses unknown names and `run_code`, and denies whole tools; the only composition hook is `agentPreset`, which needs a preset registered on the host and is not something emitted data can carry. Claude names (`Read`, `Grep`, `mcp__*`) and specifiers (`Bash(git push *)`) would also need a translation with per-specifier semantics.',
    }
  }

  if (agent.maxTurns !== undefined) {
    faces.maxTurns = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`maxTurns: ${agent.maxTurns}\` recorded, not enforced: neither \`SubagentStartRequest\` nor the agent loop exposes a turn cap. ` +
        'S16 observed a child declared `maxTurns: 1` issue three model requests (two tool calls and an answer) and end `completed`, not partial.',
    }
  }

  if (agent.isolation !== undefined) {
    faces.isolation = {
      fidelity: 'planned',
      reason:
        `Frontmatter \`isolation: ${agent.isolation}\` recorded, not applied. ` +
        'A named seam would fix it: `SubagentStartRequest.isolation`, handled in `dsh-subagent` child composition by creating a `ctx.worktrees` checkout as the child cwd and reclaiming it at disposal. ' +
        'Today `worktrees.create` re-points the calling session, and S16 observed the child cwd equal the parent cwd.',
    }
  }

  if (agent.skills !== undefined && agent.skills.length > 0) {
    const bodies = new Map((agent.skillContents ?? []).map((preload) => [preload.name, preload.content]))
    const bodiless = agent.skills.filter((name) => emptySkills.includes(name))
    const missing = agent.skills.filter((name) => !bodies.has(name) && !bodiless.includes(name))
    const preloaded = agent.skills.filter((name) => bodies.has(name))
    if (bodiless.length === 0 && missing.length === 0) {
      faces.skills = {
        fidelity: 'equivalent',
        reason:
          `Frontmatter skills ${JSON.stringify(agent.skills)} are preloaded: each full body (frontmatter removed, as the skill materializer does) is a text block of the child\'s initial user message, after the agent body and before the task. ` +
          'Claude 2.1.329 injects the full skill content at startup behind a `Base directory for this skill: <dir>` line; this uses the host\'s own `renderSkillContent` shape at the pin (`<skill_content name>`, a `<skill_resources>` provider note, `<skill_instructions>`). ' +
          'The body bytes are identical and the first child request is observed (S16), but the base-directory hint, the skill\'s resource files and provider-managed loading are not carried: the body travels as prompt text, not as a registry skill.',
      }
    } else {
      const problems = [
        ...(bodiless.length === 0
          ? []
          : [`${JSON.stringify(bodiless)} ship a SKILL.md with no body, so the host would preload nothing`]),
        ...(missing.length === 0
          ? []
          : [`${JSON.stringify(missing)} are not shipped by this plugin, so the compiler cannot read their bodies`]),
      ]
      faces.skills = {
        fidelity: 'planned',
        reason:
          `Frontmatter skills ${JSON.stringify(agent.skills)} recorded, not fully preloaded: ${problems.join('; ')}. ` +
          (preloaded.length === 0
            ? 'No body is prepended for this agent. '
            : `The ${preloaded.length} with a body ${preloaded.length === 1 ? 'is' : 'are'} still prepended. `) +
          'A named seam would fix the rest: resolve the names against `ctx.skills` when the activation starts and prepend the bodies; emitted data can carry only bodies this plugin authored. ' +
          'Claude would inject the full content of every listed skill at startup.',
      }
    }
  }

  if (agent.memory !== undefined) {
    faces.memory = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`memory: ${agent.memory}\` asks for a persistent per-agent memory directory. ` +
        'DSH has no per-agent memory directory: `startActivation` has no field for one and the session store is per-session/per-cwd, so a child cannot read or write the directory Claude would give it.',
    }
  }

  if (agent.background !== undefined) {
    faces.background = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`background: ${agent.background}\` cannot be enforced. ` +
        'The materializer\'s tool returns as soon as the activation resolves, so `true` coincides with today\'s behaviour, but `false` (start in the foreground and wait) cannot be expressed: `SubagentActivation.result` is a promise the tool does not await, and `delivery` only chooses where the final answer goes. Background subagents also get a smaller tool set in Claude, which has no counterpart.',
    }
  }

  if (agent.omitClaudeMd !== undefined) {
    faces.omitClaudeMd = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`omitClaudeMd: ${agent.omitClaudeMd}\` asks to start the child without CLAUDE.md. ` +
        'The child receives the instructions the session already loaded (`dsh-agent-instructions` is a session-level baseline with no per-activation suppression), and `startActivation` has no field to remove them.',
    }
  }

  if (agent.color !== undefined) {
    faces.color = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`color: ${agent.color}\` is display-only in Claude\'s TUI. ` +
        'DSH has no per-agent colour channel on an activation or on the registered tool; the only model-visible metadata is the description, and adding a colour to it would change the byte-equal catalog face.',
    }
  }

  if (agent.autoCompactWindow !== undefined) {
    faces.autoCompactWindow = {
      fidelity: 'unsupported',
      reason:
        `Frontmatter \`autoCompactWindow: ${agent.autoCompactWindow}\` lowers auto-compaction for one agent. ` +
        'Compaction is configured on the session/engine (`dsh-compaction`), not per activation: `startActivation` has no context-window field and the child loop does not read one.',
    }
  }

  return faces
}

/**
 * Bodies an agent's `skills:` list can be preloaded with (S16). Only plain
 * skills count: a command has the same model-catalog shape but is a different
 * artifact, and preloading its body as a skill would claim the wrong thing.
 */
function resolveAgentSkills(
  names: readonly string[] | undefined,
  available: readonly IrSkill[],
): { contents: IrAgentSkill[]; empty: string[] } {
  if (names === undefined) return { contents: [], empty: [] }
  const byName = new Map(available.filter((skill) => skill.origin !== 'commands-dir').map((skill) => [skill.name, skill]))
  const contents: IrAgentSkill[] = []
  const empty: string[] = []
  for (const name of names) {
    const skill = byName.get(name)
    if (skill === undefined) continue
    if (skill.content.trim() === '') {
      // An empty body is not a preload. Report it as empty rather than
      // silently dropping the name: `equivalent` would then be a lie.
      empty.push(name)
      continue
    }
    contents.push({ name, content: skill.content })
  }
  return { contents, empty }
}

function readAgents(root: string, plugin: string, availableSkills: readonly IrSkill[]): { agents: IrAgent[]; unsupported: IrUnmaterialized[] } {
  const agents: IrAgent[] = []
  const unsupported: IrUnmaterialized[] = []
  const seen = new Map<string, string>()
  const dir = join(root, 'agents')
  if (!existsSync(dir)) return { agents, unsupported }
  for (const file of markdownFiles(dir, root)) {
    const fallback = basename(file.abs).replace(/\.md$/, '')
    if (file.depth !== 1) {
      unsupported.push({ surface: 'agents', name: fallback, sourcePath: file.rel, annotation: nestedUnsupported('agents') })
      continue
    }
    const parsed = parseFrontmatter(readFileSync(file.abs, 'utf8'))
    const name = stringField(parsed.data, 'name') ?? fallback
    const description = stringField(parsed.data, 'description')
    if (description === undefined) {
      // Claude's agent format requires a description: it is the text the Task
      // tool shows when the model chooses a subagent_type. Without it there is
      // no model-visible entry to carry, and inventing one would be a fake row.
      unsupported.push({
        surface: 'agents',
        name,
        sourcePath: file.rel,
        annotation: {
          fidelity: 'unsupported',
          reason:
            'Malformed agent: Claude requires a non-empty `description` in the frontmatter (it is the subagent_type description the Task tool shows). Nothing model-visible is defined to carry.',
        },
      })
      continue
    }
    if (parsed.body.trim() === '') {
      // The body is the only instructions the child receives. Emitting an
      // empty tool would let the model select a persona that says nothing.
      unsupported.push({
        surface: 'agents',
        name,
        sourcePath: file.rel,
        annotation: {
          fidelity: 'unsupported',
          reason:
            'Malformed agent: the body is empty, so the tool would start a child with no instructions. Nothing model-visible is lost by refusing it, and emitting it silently would imply a persona that does not exist.',
        },
      })
      continue
    }
    const previous = seen.get(name)
    if (previous !== undefined) {
      unsupported.push({
        surface: 'agents',
        name,
        sourcePath: file.rel,
        annotation: {
          fidelity: 'unsupported',
          reason: `Duplicate agent name ${JSON.stringify(name)}: ${file.rel} and ${previous} both declare it. Claude registers one subagent_type per name, so the later file is skipped rather than shadowing the first silently.`,
        },
      })
      continue
    }
    seen.set(name, file.rel)
    const model = stringField(parsed.data, 'model')
    const tools = stringListField(parsed.data, 'tools')
    const disallowedTools = stringListField(parsed.data, 'disallowedTools')
    const effort = stringField(parsed.data, 'effort')
    const maxTurns = numberField(parsed.data, 'maxTurns')
    const isolation = stringField(parsed.data, 'isolation')
    const skills = stringListField(parsed.data, 'skills')
    const memory = stringField(parsed.data, 'memory')
    const background = boolField(parsed.data, 'background')
    const omitClaudeMd = boolField(parsed.data, 'omitClaudeMd')
    const color = stringField(parsed.data, 'color')
    const autoCompactWindow = numberField(parsed.data, 'autoCompactWindow')
    // Only skills this plugin ships can be read at compile time. A name that
    // resolves to a command is not a skill; it stays unresolved so the face
    // reports what is missing instead of preloading the wrong content.
    const resolvedSkills = resolveAgentSkills(skills, availableSkills)
    const skillContents = resolvedSkills.contents
    const faces = agentFaces(
      {
        name,
        model,
        tools,
        disallowedTools,
        effort,
        maxTurns,
        isolation,
        skills,
        skillContents,
        memory,
        background,
        omitClaudeMd,
        color,
        autoCompactWindow,
      },
      plugin,
      resolvedSkills.empty,
    )
    const agent: IrAgent = {
      kind: 'agent',
      name,
      description,
      content: parsed.body,
      ...(model === undefined ? {} : { model }),
      ...(tools === undefined ? {} : { tools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(effort === undefined ? {} : { effort }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(isolation === undefined ? {} : { isolation }),
      ...(skills === undefined ? {} : { skills }),
      ...(skillContents.length === 0 ? {} : { skillContents }),
      ...(memory === undefined ? {} : { memory }),
      ...(background === undefined ? {} : { background }),
      ...(omitClaudeMd === undefined ? {} : { omitClaudeMd }),
      ...(color === undefined ? {} : { color }),
      ...(autoCompactWindow === undefined ? {} : { autoCompactWindow }),
      origin: 'agents-dir',
      sourcePath: file.rel,
      faces,
      annotation: weakestAnnotation(Object.values(faces).filter((face): face is Annotation => face !== undefined)),
    }
    agents.push(agent)
  }
  return { agents, unsupported }
}

/**
 * The four listener seams and the five notification records ride host events S9
 * observed on a real headless turn; the five lifecycle events do the same in
 * `LIFECYCLE_HOOKS`. None can be byte-identical: the host event carries less
 * than Claude's payload (and some of it in a different shape), and only
 * Stop/SubagentStop have a decision channel upstream, which this host does not
 * expose here. Each reason names the seam, the fields that survive, and every
 * field or channel that does not.
 */
const SEAM_HOOKS: Record<string, string> = {
  UserPromptSubmit:
    'Rides the agent/pre-step waterfall (S9), filtered to step 1 and to the newest user-source message. ' +
    'Fires once per prompt, before the first model step; a delegated child is filtered out and takes SubagentStart. ' +
    'The payload carries hook_event_name, cwd, session_id and prompt. ' +
    'It omits transcript_path and permission_mode, which this host has no source for. ' +
    'A decision is not applied: agent/pre-step can enter or reject a step, so a block or continue verdict is reported with a warning instead of changing the turn.',
  PermissionRequest:
    'Rides the approval/request waterfall (S9), scoped to the agent whose tool is being decided. ' +
    'The payload carries hook_event_name, cwd, session_id, tool_name and tool_use_id (the request callId); ' +
    'it omits tool_input and permission_suggestions, which this host never puts on the seam, so a tool_input matcher is skipped with a warning. ' +
    'Report-only: the hook runs while the request is decided, but its decision is not applied and never approves or denies the tool.',
  PostToolUseFailure:
    'Rides the tools/post-execute waterfall (S9), filtered to result.isError === true. ' +
    'The payload carries hook_event_name, cwd, session_id, tool_name, tool_input, tool_use_id and error (the failed result message); ' +
    'it omits is_interrupt and duration_ms, which this host does not record. ' +
    'A failed result value cannot be replaced (D19), so a decision is reported with a warning instead of obeyed. ' +
    'A denied call is excluded: the host materializes a gate denial as an ordinary failed result, so the callId recorded on approval/decided or on a PreToolUse deny is skipped and the denial fires PermissionDenied alone, as upstream does.',
  FileChanged:
    'Rides the fs/observed emit (S9), filtered to the write, edit and apply_patch tools and observation.kind === \'present\'. ' +
    'The payload carries hook_event_name, cwd, session_id and file_path (the host displayPath); ' +
    'it omits the upstream event kind (add/change/unlink): fs/observed reports present/absent, so an event matcher cannot be evaluated and is skipped with a warning, and a handler runs for every present mutation. ' +
    'The emit carries no content delta and no decision channel.',
  PreCompact:
    'Rides the session/event record compaction/start (S9), before summarization. ' +
    'The payload carries hook_event_name, cwd, session_id, compaction_id and turn; ' +
    'it omits trigger (manual/auto) and custom_instructions, which the record does not carry, so a trigger matcher is skipped with a warning. ' +
    'The record is a notification: no decision channel, and additionalContext is reported with a warning instead of delivered.',
  PostCompact:
    'Rides the session/event record compaction/end (S9), after the summary committed. ' +
    'The payload carries hook_event_name, cwd, session_id, compaction_id and turn; ' +
    'it omits trigger and compact_summary (the summary is a separate compaction/summary record), so a trigger matcher is skipped with a warning. ' +
    'Notification only: no decision channel.',
  PermissionDenied:
    'Rides the session/event record approval/decided (S9), filtered to the non-grant outcomes (rejected, cancelled, unavailable); tool_name and callId are correlated from the approval/asked record carrying the same id. ' +
    'The payload carries hook_event_name, cwd, session_id, tool_name, tool_use_id and outcome (the host enum); ' +
    'it omits tool_input and reason, which the records do not carry. Notification only: no decision channel.',
  CwdChanged:
    'Rides the session/event record working-directory/change (S9). ' +
    'The payload carries hook_event_name, cwd (the new directory, which is what upstream cwd means) and session_id; ' +
    'it omits old_cwd and new_cwd, which the record does not carry: repeating the new directory under new_cwd would be a guess. ' +
    'Notification only: no decision channel.',
  ConfigChange:
    'Rides the settings/document-updated emit (S9), which also fires on the first read (revision 0) and only again when the document changes. ' +
    'The payload carries hook_event_name, cwd (the process directory), namespace and revision; ' +
    'it omits source, file_path and session_id, which the emit does not carry. Notification only: no decision channel.',
}

const LIFECYCLE_HOOKS: Record<string, string> = {
  SessionStart:
    'Rides the agent/created serial event (S9). Fires for the root agent only; a child creation is filtered out and takes SubagentStart. ' +
    'The payload carries hook_event_name, cwd and session_id (from the session header), source, and model when a model choice is named; a source matcher is evaluated. ' +
    'It omits transcript_path: this host keeps an event log, not a transcript file path. ' +
    'additionalContext has no channel into the first model step, so it is reported with a warning instead of delivered.',
  Stop:
    'Rides the agent/turn-stopping serial event (S9). Fires for the root agent only; a child\'s last turn takes SubagentStop. ' +
    'The payload carries hook_event_name, cwd and session_id (from the session header). ' +
    'It omits both upstream-specific fields: the event carries only the agent, the turn number and an abort signal, so last_assistant_message is in the session log but this materializer does not read it (synchronous log reads are deprecated on this host), and stop_hook_active has no source. ' +
    'The event cannot continue a turn, so a block decision is reported with a warning instead of obeyed.',
  SessionEnd:
    'Rides the agent/disposed emit (S9). Fires when the root agent detaches; a child disposal is filtered out and takes SubagentStop. ' +
    'The payload carries hook_event_name, cwd and session_id (from the session header) but no reason: the emit carries only the agent, so a reason matcher cannot be evaluated, and it is skipped with a warning rather than guessed. ' +
    'Upstream has no decision channel here either.',
  SubagentStart:
    'Rides the subagent/start emit (S9). Fires for a child activation only. ' +
    'The payload carries hook_event_name, session_id (the parent session), agent_id and cwd (the harness process directory, because the emit carries no session header); ' +
    'it omits agent_type, so a matcher on the agent type cannot be evaluated and is skipped with a warning. ' +
    'additionalContext has no channel into the child\'s context, so it is reported with a warning instead of delivered.',
  SubagentStop:
    'Rides the subagent/end emit (S9). Fires for a child completion only. ' +
    'The payload carries hook_event_name, session_id (the parent session), agent_id, cwd (the harness process directory) and last_assistant_message (flattened from the child\'s final content blocks); ' +
    'it omits agent_type (a matcher on it is skipped with a warning), stop_hook_active and agent_transcript_path. ' +
    'The emit cannot continue a child, so a block decision is reported with a warning instead of obeyed.',
}

/**
 * Sixteen events have a host: the two tool-scoped ones ride
 * `tools/pre-execute` and `tools/post-execute` (S8, D19), the lifecycle five
 * ride the host events named in `LIFECYCLE_HOOKS` below (S9), and the four
 * listener seams plus the five notification records ride the events named in
 * `SEAM_HOOKS` (S9). Even there the payload is not byte-identical — the
 * host has no transcript path or permission mode, and the root lifecycle ids
 * and cwd come from the session header rather than from Claude's payload (a
 * subagent's id comes from the emit, and its cwd is the harness process
 * directory) — so the honest class is `equivalent`, not `exact`.
 */
function hookAnnotation(event: string, type: string, command: string | undefined): Annotation {
  if (type !== 'command' || command === undefined) {
    return {
      fidelity: 'planned',
      reason: `Handler type ${JSON.stringify(type)} is not carried: only shell commands are executed in this release.`,
    }
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    return {
      fidelity: 'equivalent',
      reason:
        `Rides the ${event === 'PreToolUse' ? 'tools/pre-execute' : 'tools/post-execute'} waterfall (S8, D19). The payload carries tool_name, tool_input, tool_use_id and cwd; it omits session_id, transcript_path, permission_mode and effort, which this host has no source for. ` +
        '`continue:false` has no equivalent and is ignored with a warning.',
    }
  }
  const lifecycle = LIFECYCLE_HOOKS[event]
  if (lifecycle !== undefined) {
    return { fidelity: 'equivalent', reason: lifecycle }
  }
  const seam = SEAM_HOOKS[event]
  if (seam !== undefined) {
    return { fidelity: 'equivalent', reason: seam }
  }
  return {
    fidelity: 'planned',
    reason:
      `${event} has no host event yet: no DSH event fires at that point in the turn, so the handler is recorded but not run.`,
  }
}

function readHooks(root: string): { hooks: IrHook[]; pending: IrUnmaterialized[] } {
  const hooks: IrHook[] = []
  const pending: IrUnmaterialized[] = []
  const path = join(root, 'hooks', 'hooks.json')
  const text = readIfFile(path)
  if (!text) return { hooks, pending }
  let document: Record<string, unknown>
  try {
    document = JSON.parse(text) as Record<string, unknown>
  } catch {
    pending.push({
      surface: 'hooks',
      name: 'hooks.json',
      sourcePath: 'hooks/hooks.json',
      annotation: { fidelity: 'unsupported', reason: 'hooks.json is not valid JSON; the host cannot load it either.' },
    })
    return { hooks, pending }
  }
  const table = (document.hooks ?? {}) as Record<string, unknown>
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) {
      pending.push({
        surface: 'hooks',
        name: event,
        sourcePath: 'hooks/hooks.json',
        annotation: { fidelity: 'unsupported', reason: 'Event value is not an array of matcher groups; not a shape the host accepts.' },
      })
      continue
    }
    let index = 0
    for (const group of groups as Record<string, unknown>[]) {
      const handlers = Array.isArray(group.hooks) ? (group.hooks as Record<string, unknown>[]) : []
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      handlers.forEach((handler) => {
        const type = typeof handler.type === 'string' ? handler.type : 'unknown'
        const command = typeof handler.command === 'string' ? handler.command : undefined
        const args = Array.isArray(handler.args) && handler.args.every((item) => typeof item === 'string')
          ? (handler.args as string[])
          : undefined
        const timeout = typeof handler.timeout === 'number' ? handler.timeout : undefined
        hooks.push({
          kind: 'hook',
          event,
          ...(matcher === undefined ? {} : { matcher }),
          index: index++,
          handler: type,
          ...(command === undefined ? {} : { command }),
          ...(args === undefined ? {} : { args }),
          ...(timeout === undefined ? {} : { timeout }),
          sourcePath: 'hooks/hooks.json',
          annotation: hookAnnotation(event, type, command),
        })
      })
    }
  }
  if (Array.isArray(document.modules) && document.modules.length > 0) {
    pending.push({
      surface: 'mods',
      name: 'modules',
      sourcePath: 'hooks/hooks.json',
      annotation: {
        fidelity: 'planned',
        reason: 'In-process mods are seated and live (D32 §4/§9): the 23 $ sites the pinned diff mod calls across 10 namespaces are covered (#46): fs resolves in the session cwd, store confines to plugin data, and settings.read serves only a host merged snapshot; ui.*, process.run and settings.read without a merged reader are typed refusals. Remaining gaps are the element runtime, the rest of the ~21 namespaces, the unmapped engine and classic events, and classic command-hook updatedInput schema validation. Loaded as authored, never transpiled (D30/D34).',
      },
    })
  }
  return { hooks, pending }
}

/**
 * `$` + 'CLAUDE_PLUGIN_ROOT' is the only path variable the dialect can resolve:
 * the project directory and user config belong to the loading session, not to
 * the install, so a server that needs them is reported rather than guessed.
 */
const PLUGIN_ROOT_VARIABLE = /\$\{CLAUDE_PLUGIN_ROOT\}/g

function substitutePluginRoot(value: string, root: string): string {
  return value.replace(PLUGIN_ROOT_VARIABLE, root)
}

/** Frontmatter `arguments` is a YAML list or a space-separated string (skills docs). */
function argumentNamesFrom(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const names = value.trim().split(/\s+/).filter(Boolean)
    return names.length > 0 ? names : undefined
  }
  const list = stringList(value)
  return list !== undefined && list.length > 0 ? list : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => (typeof item === 'string' ? item : String(item)))
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const map: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') map[key] = entry
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * MCP servers we connect ourselves (D12). The name is Claude's, byte for byte;
 * the schema is passed through; the reason names what this path does not carry
 * yet — server instructions and a reconnect policy.
 */
const MCP_EQUIVALENT: Annotation = {
  fidelity: 'equivalent',
  reason:
    'Tool names and input schemas are registered byte for byte under mcp__plugin_<plugin>_<server>__<tool>. Server instructions are not injected into the system prompt and no reconnect policy is applied yet (D12).',
}

const MCP_UNRESOLVED: Annotation = {
  fidelity: 'planned',
  reason:
    'The server configuration references ${CLAUDE_PROJECT_DIR} or ${user_config.*}, which belong to the loading session; resolving them needs the install-time-to-load-time context handoff that the scope layer (D2) owns.',
}

function readMcp(root: string, plugin: string): {
  servers: IrMcpServer[]
  pending: IrUnmaterialized[]
  unsupported: IrUnmaterialized[]
} {
  const servers: IrMcpServer[] = []
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []
  const text = readIfFile(join(root, '.mcp.json'))
  if (text === undefined) return { servers, pending, unsupported }
  let table: Record<string, unknown>
  try {
    const document = JSON.parse(text) as Record<string, unknown>
    table = (document.mcpServers ?? document) as Record<string, unknown>
  } catch {
    unsupported.push({
      surface: 'mcpServers',
      name: '.mcp.json',
      sourcePath: '.mcp.json',
      annotation: { fidelity: 'unsupported', reason: '.mcp.json is not valid JSON.' },
    })
    return { servers, pending, unsupported }
  }
  for (const [name, raw] of Object.entries(table)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      unsupported.push({
        surface: 'mcpServers',
        name,
        sourcePath: '.mcp.json',
        annotation: { fidelity: 'unsupported', reason: 'A server entry must be an object.' },
      })
      continue
    }
    const entry = raw as Record<string, unknown>
    const serialized = JSON.stringify(entry)
    if (serialized.includes('${CLAUDE_PROJECT_DIR}') || serialized.includes('${user_config.')) {
      pending.push({ surface: 'mcpServers', name, sourcePath: '.mcp.json', annotation: MCP_UNRESOLVED })
      continue
    }
    const command = typeof entry.command === 'string' ? entry.command : undefined
    const url = typeof entry.url === 'string' ? entry.url : undefined
    const type = typeof entry.type === 'string' ? entry.type : command !== undefined ? 'stdio' : url !== undefined ? 'http' : ''
    const substitute = (value: string): string => substitutePluginRoot(value, root)
    // Both hosts limit a tool name to 64 characters (D11). Every tool from this
    // server would carry the same prefix, so an over-budget prefix means the
    // whole server is unusable — refusing here is honest; truncating would
    // register a name the model cannot call.
    const prefix = `mcp__plugin_${plugin}_${name}__`
    if (prefix.length + 1 > 64) {
      unsupported.push({
        surface: 'mcpServers',
        name,
        sourcePath: '.mcp.json',
        annotation: {
          fidelity: 'unsupported',
          reason: `Every tool of this server would start with ${JSON.stringify(prefix)} (${prefix.length} characters) before the tool's own name, so even a one-character tool exceeds the shared 64-character limit; refused rather than truncated (D11).`,
        },
      })
      continue
    }
    if (type === 'stdio') {
      if (command === undefined || command.trim() === '') {
        unsupported.push({ surface: 'mcpServers', name, sourcePath: '.mcp.json', annotation: { fidelity: 'unsupported', reason: 'stdio server without a command cannot start.' } })
        continue
      }
      const args = stringList(entry.args)?.map(substitute)
      const env = stringMap(entry.env)
      servers.push({
        kind: 'mcp-server',
        name,
        transport: 'stdio',
        command: substitute(command),
        ...(args === undefined ? {} : { args }),
        ...(env === undefined ? {} : { env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, substitute(value)])) }),
        ...(typeof entry.cwd === 'string' ? { cwd: substitute(entry.cwd) } : {}),
        pluginRoot: root,
        sourcePath: '.mcp.json',
        annotation: MCP_EQUIVALENT,
      })
      continue
    }
    if (type === 'http' || type === 'streamable-http') {
      if (url === undefined || url.trim() === '') {
        unsupported.push({ surface: 'mcpServers', name, sourcePath: '.mcp.json', annotation: { fidelity: 'unsupported', reason: 'http server without a url cannot connect.' } })
        continue
      }
      const headers = stringMap(entry.headers)
      servers.push({
        kind: 'mcp-server',
        name,
        transport: 'http',
        url: substitute(url),
        ...(headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, substitute(value)])) }),
        pluginRoot: root,
        sourcePath: '.mcp.json',
        annotation: MCP_EQUIVALENT,
      })
      continue
    }
    unsupported.push({
      surface: 'mcpServers',
      name,
      sourcePath: '.mcp.json',
      annotation: {
        fidelity: 'unsupported',
        reason: `Transport ${JSON.stringify(type)} is not carried: this materializer speaks stdio and Streamable HTTP (D12).`,
      },
    })
  }
  for (const [surface, dir, reason] of [
    ['lspServers', '.lsp.json', 'LSP server registration needs a DSH LSP seam; not shipped in the Desktop bundle.'],
    ['themes', 'themes', 'Terminal colour palettes have no DSH palette seam yet (F2); planned for v0.4.'],
    ['workflows', 'workflows', 'Workflow scripts are close to dsh-tool-workflow but the agent()/pipeline() contract differs; planned for v0.4.'],
    ['bin', 'bin', 'bin/ must join the model shell PATH; dsh-shell-env only manages DSH_* keys (ARCHITECTURE §9). Planned for v0.3.'],
    ['monitors', 'monitors', 'Monitors need a channel from a background process stdout into the model context; planned for v0.4.'],
  ] as const) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    pending.push({
      surface,
      name: dir,
      sourcePath: dir,
      annotation: { fidelity: 'planned', reason },
    })
  }
  return { servers, pending, unsupported }
}

/**
 * Why an output style can be carried at this pin, and the two faces that
 * decide how far.
 *
 * Upstream spec (pinned): `claude-code.d.ts:9867 @ 2.1.329` lists a plugin
 * output style as `<plugin>:<style>`; `claude-code.d.ts:11238 @ 2.1.329`
 * describes the composed prompt's `outputStyle` as
 * `{ name, isKeepingCodingInstructions } | null`. The frontmatter keys are
 * documented at https://code.claude.com/docs/en/output-styles @ 2.1.329.
 *
 * The spoken half is reachable: S11 proved an `agent/created` listener on the
 * agent's own context can register a `SystemPrompt` section with
 * `complete: true`, and the section is then the agent's whole prompt (and
 * survives compaction). The named half is not: `/<plugin>:<name>` still needs
 * the additive command-alias seam (D10), and this dialect never fakes a
 * command.
 */
const OUTPUT_STYLE_ACTIVATION =
  'Activation is applied at agent start: the materializer registers an `agent/created` listener whose handler calls `payload.agent.ctx.systemPrompt.section(...)` on the agent\'s own context (S11), so a sibling agent is unaffected. ' +
  'The section sets `interpolate: false`, because a style body is prompt text, not a template, and sets `complete: true` only when the frontmatter says `keep-coding-instructions: false`; otherwise the body is appended as a section and the host\'s own instructions stay. ' +
  'It is `equivalent`, not `exact`: the surrounding system prompt is DSH\'s rather than Claude\'s, the body is applied as authored where Claude trims its prompt, and an absent `keep-coding-instructions` appends here where Claude\'s documented default removes its coding instructions. ' +
  'The named half `/<plugin>:<name>` (claude-code.d.ts:9867 @ 2.1.329) stays `planned`: the additive command-alias seam does not exist (D10). ' +
  '`force-for-plugin: true` applies only when its plugin is enabled and no explicit profile record overrides it; an explicit record wins and the compile trace names the winner. That precedence is declared here on purpose: the docs page (https://code.claude.com/docs/en/output-styles @ 2.1.329) says force overrides the user\'s selection, but the profile activation record is this layer\'s only activation channel, so it is the operator\'s explicit statement and none of the host\'s own settings are being overridden.'

function outputStyleReason(name: string, description: string | undefined, keepCodingInstructions: boolean | undefined): string {
  const label = description === undefined
    ? `Output style ${JSON.stringify(name)}`
    : `Output style ${JSON.stringify(name)} (${JSON.stringify(description)})`
  const composition = keepCodingInstructions === undefined
    ? 'An absent `keep-coding-instructions` stays absent: the body is appended as a section and no declaration is synthesized.'
    : keepCodingInstructions
      ? '`keep-coding-instructions: true` appends the body as a section, so the coding instructions stay alongside it.'
      : '`keep-coding-instructions: false` makes the body the complete prompt through `complete: true`.'
  return `${label} is prompt text applied at agent start when a profile record activates it; its body is carried byte for byte and applied as authored. The spoken half is \`equivalent\`; the row stays \`planned\` because the human \`/<plugin>:<name>\` command needs the additive command-alias seam (D10) and \`claude plugin details\` does not inventory output styles at 2.1.322 (D37), so there is no inventory anchor. ${composition} ${OUTPUT_STYLE_ACTIVATION}`
}

function outputStyleFaces(name: string, description: string | undefined, keepCodingInstructions: boolean | undefined): IrOutputStyleFaces {
  const activation = [
    `Output style ${JSON.stringify(name)} applies at agent start through the agent-scoped system-prompt seam (S11).`,
    keepCodingInstructions === false
      ? '`keep-coding-instructions: false` makes the body the complete prompt (`complete: true`), so the host\'s coding instructions are replaced.'
      : keepCodingInstructions === true
        ? '`keep-coding-instructions: true` appends the body as a section, so the host\'s coding instructions stay.'
        : 'An absent `keep-coding-instructions` appends the body as a section; the documented default is not synthesized.',
    'Equivalent, not exact: DSH\'s surrounding prompt is not Claude\'s, the body is applied as authored (Claude trims its prompt), and an absent `keep-coding-instructions` appends where Claude\'s default removes its coding instructions.',
    'The section sets `interpolate: false`, because a style body is prompt text, not a template.',
  ].join(' ')
  const command = `The human \`/<plugin>:<name>\` command for ${JSON.stringify(name)} is planned: a command name cannot contain \`:\` until the additive command-alias seam lands (D10), and this dialect does not fake an alias.`
  return {
    activation: { fidelity: 'equivalent', reason: outputStyleReason(name, description, keepCodingInstructions) + ' ' + activation },
    command: { fidelity: 'planned', reason: command },
  }
}

/**
 * Claude's `output-styles/*.md` is F1: the body is the prompt the model reads at
 * agent start. A flat file is carried as an `IrOutputStyle` — identity from the
 * frontmatter `name` (falling back to the file stem, as the host does), the
 * description for the row, the two composition keys as written, and the body
 * byte for byte. The overall row stays `planned` because the named half is not
 * reachable; the activation face is `equivalent` and the materializer applies
 * it through the agent-scoped prompt seam. A nested file is outside the flat
 * surface and stays in `pending`; so does a manifest-declared directory, which
 * is not read at all.
 */
function readOutputStyles(root: string): { styles: IrOutputStyle[]; pending: IrUnmaterialized[] } {
  const dir = join(root, 'output-styles')
  if (!existsSync(dir)) return { styles: [], pending: [] }
  const styles: IrOutputStyle[] = []
  const pending: IrUnmaterialized[] = []
  for (const file of markdownFiles(dir, root)) {
    const fallback = basename(file.abs).replace(/\.md$/, '')
    if (file.depth !== 1) {
      pending.push({
        surface: 'outputStyles',
        name: fallback,
        sourcePath: file.rel,
        annotation: {
          fidelity: 'planned',
          reason: 'A nested output-style file is outside the flat `output-styles/*.md` surface this dialect reads; reading nested directories is a separate decision, not part of the flat-file carry.',
        },
      })
      continue
    }
    const parsed = parseFrontmatter(readFileSync(file.abs, 'utf8'))
    const name = stringField(parsed.data, 'name') ?? fallback
    const description = stringField(parsed.data, 'description')
    const keepCodingInstructions = boolField(parsed.data, 'keep-coding-instructions')
    const forceForPlugin = boolField(parsed.data, 'force-for-plugin')
    styles.push({
      surface: 'outputStyles',
      name,
      ...(description === undefined ? {} : { description }),
      ...(keepCodingInstructions === undefined ? {} : { keepCodingInstructions }),
      ...(forceForPlugin === undefined ? {} : { forceForPlugin }),
      faces: outputStyleFaces(name, description, keepCodingInstructions),
      body: parsed.body,
      sourcePath: file.rel,
      annotation: { fidelity: 'planned', reason: outputStyleReason(name, description, keepCodingInstructions) },
    })
  }
  return { styles, pending }
}

export function readClaudePlugin(root: string, options: ReadOptions = {}): ClaudePluginIr {
  const manifest = readManifest(root)
  const pin = options.pin ?? CLAUDE_CODE_PIN
  const pluginName = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : basename(root)
  const { skills, pending: skillPending, unsupported: skillUnsupported } = readSkillsAndCommands(root)
  const { agents, unsupported: agentUnsupported } = readAgents(root, pluginName, skills)
  const { hooks, pending: hookPending } = readHooks(root)
  const { servers, pending: mcpPending, unsupported: mcpUnsupported } = readMcp(root, pluginName)
  const { styles: outputStyles, pending: stylePending } = readOutputStyles(root)

  const pending: IrUnmaterialized[] = [...skillPending, ...hookPending, ...mcpPending, ...stylePending]
  const unsupported: IrUnmaterialized[] = [...skillUnsupported, ...agentUnsupported, ...mcpUnsupported]

  for (const key of ['commands', 'skills', 'agents', 'hooks', 'mcpServers'] as const) {
    if (key in manifest) {
      pending.push({
        surface: key,
        name: `manifest:${key}`,
        sourcePath: '.claude-plugin/plugin.json',
        annotation: {
          fidelity: 'planned',
          reason: `Inline manifest \`${key}\` overrides directory discovery upstream; carrying the override is planned for the same release as that surface's materializer.`,
        },
      })
    }
  }
  if ('outputStyles' in manifest) {
    // A manifest directory is a second place a style can live. It needs its own
    // row: silently ignoring the declaration would hide the plugin's intent.
    pending.push({
      surface: 'outputStyles',
      name: 'manifest:outputStyles',
      sourcePath: '.claude-plugin/plugin.json',
      annotation: {
        fidelity: 'planned',
        reason: 'The manifest declares custom output-style directories; the dialect reads only the flat `output-styles/*.md` surface, so honoring this declaration is a separate decision, not part of the flat-file carry.',
      },
    })
  }

  return {
    ir: IR_SCHEMA,
    plugin: {
      name: pluginName,
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
      ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
      source: options.source ?? `plugin-dir:${root}`,
      root,
    },
    pin,
    skills,
    agents,
    hooks,
    mcpServers: servers,
    outputStyles,
    pending,
    unsupported,
  }
}
