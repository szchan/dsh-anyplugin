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
  IrHook,
  IrMcpServer,
  IrPin,
  IrSkill,
  IrUnmaterialized,
} from '../../dsh-anyplugin-ir/src/index.ts'
import { IR_SCHEMA } from '../../dsh-anyplugin-ir/src/index.ts'

export const CLAUDE_CODE_PIN: IrPin = { tool: 'claude-code', version: '2.1.322' }

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
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text, closed: true }
  const data: Record<string, unknown> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1]
    const rest = pair[2]
    if (rest === '|' || rest === '>' || rest === '|-') {
      const collected: string[] = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        collected.push(lines[i + 1].replace(/^\s{2}/, ''))
        i++
      }
      data[key] = collected.join('\n').replace(/\n+$/, '')
      continue
    }
    data[key] = parseScalar(rest)
  }
  return { data, body: text.slice(match[0].length), closed: true }
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

const NESTED_UNSUPPORTED: Annotation = {
  fidelity: 'unsupported',
  reason:
    'Not loaded by the host at this pin: `claude --plugin-dir … plugin details` reports Skills (0) / Agents (1) for nested files. Recorded so the gap is visible rather than silently dropped.',
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
    const skill = skillFromFile(
      { rel: 'SKILL.md', abs: join(root, 'SKILL.md'), depth: 0 },
      root,
      'root-skill',
      SKILL_EQUIVALENT,
      basename(root),
    )
    if (skill) skills.push(skill)
  }

  const skillsDir = join(root, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(skillsDir, entry.name)
      if (entry.isDirectory()) {
        const file = join(abs, 'SKILL.md')
        if (!readIfFile(file)) {
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
        unsupported.push({ surface: 'commands', name, sourcePath: file.rel, annotation: NESTED_UNSUPPORTED })
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

function readAgents(root: string): { agents: IrAgent[]; unsupported: IrUnmaterialized[] } {
  const agents: IrAgent[] = []
  const unsupported: IrUnmaterialized[] = []
  const dir = join(root, 'agents')
  if (!existsSync(dir)) return { agents, unsupported }
  for (const file of markdownFiles(dir, root)) {
    const fallback = basename(file.abs).replace(/\.md$/, '')
    if (file.depth !== 1) {
      unsupported.push({ surface: 'agents', name: fallback, sourcePath: file.rel, annotation: NESTED_UNSUPPORTED })
      continue
    }
    const parsed = parseFrontmatter(readFileSync(file.abs, 'utf8'))
    const name = stringField(parsed.data, 'name') ?? fallback
    agents.push({
      kind: 'agent',
      name,
      ...(stringField(parsed.data, 'description') ? { description: stringField(parsed.data, 'description') } : {}),
      content: parsed.body,
      ...(stringField(parsed.data, 'model') ? { model: stringField(parsed.data, 'model') } : {}),
      ...(Array.isArray(parsed.data.tools) ? { tools: parsed.data.tools as string[] } : {}),
      origin: 'agents-dir',
      sourcePath: file.rel,
      annotation: {
        fidelity: 'planned',
        reason:
          'DSH has no description-driven named-agent catalog (dsh-subagent is a named provider registry), so an agent has no address to occupy yet. Planned for v0.4 (ARCHITECTURE §9).',
      },
    })
  }
  return { agents, unsupported }
}

/**
 * Only the two tool-scoped events have a host (S8, D19): they ride
 * `tools/pre-execute` and `tools/post-execute`. Even there the payload is not
 * byte-identical — the host has no session id, transcript path or permission
 * mode to put in it — so the honest class is `equivalent`, not `exact`.
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
        reason: 'In-process mods are a second subsystem (ARCHITECTURE §7): static scanner + mod host, v0.5+. Loaded as authored, never transpiled.',
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
    ['outputStyles', 'output-styles', 'Output styles are prompt-level and byte-preservable; planned after the command seam (v0.4).'],
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

export function readClaudePlugin(root: string, options: ReadOptions = {}): ClaudePluginIr {
  const manifest = readManifest(root)
  const pin = options.pin ?? CLAUDE_CODE_PIN
  const pluginName = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : basename(root)
  const { skills, pending: skillPending, unsupported: skillUnsupported } = readSkillsAndCommands(root)
  const { agents, unsupported: agentUnsupported } = readAgents(root)
  const { hooks, pending: hookPending } = readHooks(root)
  const { servers, pending: mcpPending, unsupported: mcpUnsupported } = readMcp(root, pluginName)

  const pending: IrUnmaterialized[] = [...skillPending, ...hookPending, ...mcpPending]
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
    pending,
    unsupported,
  }
}
