/**
 * Codex / Agent Plugins dialect — reads a portable plugin directory into the
 * same IR the Claude dialect produces.
 *
 * The portable format is specified, not observed: at the time of writing there
 * is no offline `codex plugin details` oracle (the ticket says so, and the
 * golden is hand-authored from the schemas). Every reason in this file is
 * therefore a statement about the published 1.0.0 schema or the Codex hooks
 * documentation, not a trace of a host run. Where a claim would need an
 * observation, the reason says so.
 *
 * Reused from the Claude dialect: the frontmatter reader, the skill envelope,
 * the hook seam table (S9/D32 — one table, not a second mapping), and the
 * 64-character name budget (D11). Changed only where the format changes it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  Annotation,
  ClaudePluginIr,
  IrHook,
  IrMcpServer,
  IrPin,
  IrSkill,
  IrUnmaterialized,
} from '../../dsh-anyplugin-ir/src/index.ts'
import { IR_SCHEMA } from '../../dsh-anyplugin-ir/src/index.ts'

/**
 * The pin names the specification this reader implements, not a Codex binary.
 * There is no observable Codex version to pin here: the only authority we can
 * run is the schema document itself.
 */
export const AGENT_PLUGINS_PIN: IrPin = { tool: 'agent-plugins', version: '1.0.0' }

export const PORTABLE_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const PORTABLE_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
export const CODEX_MANIFEST = '.codex-plugin/plugin.json'

const PORTABLE_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const HOOK_TIMEOUT_DEFAULT_SECONDS = 600

export interface ReadOptions {
  pin?: IrPin
  /** Label recorded in the IR, e.g. `plugin-dir:fixtures/codex-portable`. */
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
  if (!match) {
    // A file that opens a fence but never closes it is not "no frontmatter";
    // the host still loads the body, so keep the raw text and say so.
    return { data: {}, body: text, closed: !/^---\r?\n/.test(text) }
  }
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

function numberField(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  }
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined
}

function readIfFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

function readJson(path: string): { value?: unknown; error?: string } {
  const text = readIfFile(path)
  if (text === undefined) return { error: 'not a regular file' }
  try {
    return { value: JSON.parse(text) as unknown }
  } catch (error) {
    return { error: `not valid JSON (${(error as Error).message})` }
  }
}

function relPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

function insideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function resolvePath(root: string, value: string): string | undefined {
  const raw = value.startsWith('${PLUGIN_ROOT}/') ? join(root, value.slice('${PLUGIN_ROOT}/'.length)) : value
  const abs = resolve(root, raw)
  return insideRoot(root, abs) ? abs : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string')
  return list.length === value.length ? list : undefined
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    out[key] = item
  }
  return out
}

const SKILL_EQUIVALENT: Annotation = {
  fidelity: 'equivalent',
  reason:
    'Body is preserved byte for byte. DSH wraps a skill in <skill_content>/<skill_instructions>; the Codex envelope was not observed (there is no offline oracle for it), so equivalence is claimed from the format contract, not from a diff. Frontmatter name/description are carried; no argument placeholders are substituted (D17).',
}

const MCP_EQUIVALENT: Annotation = {
  fidelity: 'equivalent',
  reason:
    'Tool names and input schemas are registered byte for byte under Codex\'s `mcp__<server>__<tool>` composition (no `plugin_` segment). Server instructions and reconnect policy are not carried (D12); name length is checked from the server name and never truncated (D11/D33).',
}

const MCP_UNRESOLVED: Annotation = {
  fidelity: 'planned',
  reason:
    'The server configuration references `${PLUGIN_DATA}`, which is resolved by the loading host and has no value at read time; carrying it needs the install-time-to-load-time context handoff owned by the scope layer (D2).',
}

const HOOK_EQUIVALENT: Record<string, string> = {
  PreToolUse: 'tools/pre-execute',
  PostToolUse: 'tools/post-execute',
  SessionStart: 'agent/created',
  SessionEnd: 'agent/disposed',
  Stop: 'agent/turn-stopping',
  SubagentStart: 'subagent/start',
  SubagentStop: 'subagent/end',
}

const HOOK_PLANNED: Record<string, string> = {
  PermissionRequest:
    '`PermissionRequest` has a DSH seam (`approval/request`), but S9 shows the request carries no tool input, so a Codex hook that decides from the requested tool cannot be honoured. Planned, not mapped (S9/D32).',
  UserPromptSubmit:
    '`UserPromptSubmit` fires once per model step in DSH (`agent/pre-step`, filtered to `step === 1`), while the Codex hook contract can rewrite or block the prompt before the model sees it; that payload and decision are not established. Planned, not mapped (S9/D32).',
  PreCompact:
    '`PreCompact` maps only to notification-only compaction events in DSH; the Codex hook can veto compaction, and that decision is not carried. Planned (S9/D32).',
  PostCompact:
    '`PostCompact` maps only to notification-only compaction events in DSH; the Codex hook\'s post-compaction side effects are not in the carried seam. Planned (S9/D32).',
  Interrupt: '`Interrupt` has no DSH host event at this pin. Planned, naming the event rather than inventing a mapping (D32).',
  PreModelRequest:
    '`PreModelRequest` has no DSH host event at this pin. Planned, naming the event rather than inventing a mapping (D32).',
  PostModelRequest:
    '`PostModelRequest` has no DSH host event at this pin. Planned, naming the event rather than inventing a mapping (D32).',
}

/** Codex documents these matchers as ignored; carrying one would add a filter. */
const MATCHER_IGNORED = new Set(['UserPromptSubmit', 'Stop', 'Interrupt', 'PreModelRequest', 'PostModelRequest'])

function hookAnnotation(
  event: string,
  handler: Record<string, unknown>,
  options: { matcherDropped?: boolean; timeoutDefaulted?: boolean; timeoutSeconds?: number; timeoutCappedFrom?: number } = {},
): Annotation {
  const seam = HOOK_EQUIVALENT[event]
  const async = handler.async === true
  const dataCommand = typeof handler.command === 'string' && handler.command.includes('${PLUGIN_DATA}')
  const extra: string[] = []
  if (handler.statusMessage !== undefined) extra.push('`statusMessage` is UI chrome and is not carried')
  if (handler.commandWindows !== undefined) extra.push('`commandWindows` is not carried')
  if (handler.additionalContextLimit !== undefined) extra.push('`additionalContextLimit` is not carried')
  if (typeof handler.command === 'string' && handler.command.includes('${PLUGIN_ROOT}')) {
    extra.push(
      '`${PLUGIN_ROOT}` is stored as `${CLAUDE_PLUGIN_ROOT}` because the trust pin resolves only the Claude spelling; both variables point at the same directory at spawn (Codex injects both for Claude-compatible hooks)',
    )
  }
  if (options.matcherDropped) {
    extra.push('Codex ignores `matcher` for this event, so it is dropped rather than filtering where Codex would run every match')
  }
  if (options.timeoutDefaulted && seam !== undefined) {
    extra.push(
      `No timeout was declared, so Codex's ${String(options.timeoutSeconds)}s default is carried explicitly; DSH's own default would be 60s`,
    )
  }
  if (options.timeoutCappedFrom !== undefined) {
    extra.push(
      `Codex caps \`timeout\` at 3s for SessionEnd/Interrupt; the declared ${String(options.timeoutCappedFrom)}s is carried as 3s`,
    )
  }
  if (dataCommand) {
    return {
      fidelity: 'planned',
      reason:
        `\`${event}\` command depends on \`\${PLUGIN_DATA}\`. Trust pins a hook to the artifact bytes it can hash, and the data directory is created by the host after install, so no stable artifact exists; running it would exceed the pinned grant (D25). Planned, not run.`,
    }
  }
  if (async) {
    return {
      fidelity: 'planned',
      reason:
        `\`${event}\` handler sets \`async: true\`. DSH's hook chain is synchronous: the command would block the turn where Codex would let it run behind the event, so running it would change behaviour. Planned, not run (S9/D32).`,
    }
  }
  if (seam !== undefined) {
    return {
      fidelity: 'equivalent',
      reason:
        `\`${event}\` maps to DSH \`${seam}\` (S9/D32). The command receives the event payload on stdin and returns the same continue/block contract; the host's timeout is the declared one, or Codex's default when none was declared.` +
        (extra.length > 0 ? ` ${extra.join('; ')}.` : ''),
    }
  }
  const planned = HOOK_PLANNED[event]
  if (planned !== undefined) return { fidelity: 'planned', reason: planned }
  return {
    fidelity: 'planned',
    reason:
      `\`${event}\` is not in Codex's published hook vocabulary (or has no DSH host event); no mapping is invented. Recorded so the gap is visible.`,
  }
}

function normalizeHookCommand(command: string): string {
  // Codex injects both spellings; the trust pin understands only Claude's.
  // Rewriting here keeps the artifact pinnable without teaching trust a new
  // variable, and the spawned environment resolves both names identically.
  return command.replaceAll('${PLUGIN_ROOT}', '${CLAUDE_PLUGIN_ROOT}')
}

interface HookDocument {
  sourcePath: string
  document: Record<string, unknown>
}

function looksLikeHookTable(document: Record<string, unknown>): boolean {
  if (isObject(document.hooks)) return true
  return Object.keys(document).some((key) => key in HOOK_EQUIVALENT || key in HOOK_PLANNED)
}

function readHookDocuments(
  root: string,
  value: unknown,
  label: string,
): { docs: HookDocument[]; unsupported: IrUnmaterialized[] } {
  const docs: HookDocument[] = []
  const unsupported: IrUnmaterialized[] = []

  const addInline = (document: unknown, sourcePath: string): void => {
    const object = asObject(document)
    if (object === undefined) {
      unsupported.push({
        surface: 'hooks',
        name: sourcePath,
        sourcePath,
        annotation: { fidelity: 'unsupported', reason: 'An inline hooks value must be an object with a `hooks` table.' },
      })
      return
    }
    docs.push({ sourcePath, document: object })
  }

  const addPath = (raw: string, sourcePath: string): void => {
    const abs = resolvePath(root, raw)
    if (abs === undefined) {
      unsupported.push({
        surface: 'hooks',
        name: raw,
        sourcePath,
        annotation: {
          fidelity: 'unsupported',
          reason: `Hook file ${JSON.stringify(raw)} resolves outside the plugin root; the 1.0.0 containment rule forbids reading it.`,
        },
      })
      return
    }
    const loaded = readJson(abs)
    const object = asObject(loaded.value)
    if (object === undefined) {
      unsupported.push({
        surface: 'hooks',
        name: relPath(root, abs),
        sourcePath: relPath(root, abs),
        annotation: {
          fidelity: 'unsupported',
          reason: `Hook file ${relPath(root, abs)} is ${loaded.error ?? 'not a JSON object'}; Codex skips a malformed hook file and so does this reader.`,
        },
      })
      return
    }
    docs.push({ sourcePath: relPath(root, abs), document: object })
  }

  const visit = (item: unknown, index: number): void => {
    if (typeof item === 'string') {
      addPath(item, `${label}[${index}]`)
      return
    }
    if (isObject(item)) {
      addInline(item, `${label}[${index}]`)
      return
    }
    if (Array.isArray(item)) {
      item.forEach((child, childIndex) => visit(child, childIndex))
      return
    }
    unsupported.push({
      surface: 'hooks',
      name: `${label}[${index}]`,
      sourcePath: label,
      annotation: {
        fidelity: 'unsupported',
        reason: 'A hooks value must be a path, an inline hooks object, or an array of those.',
      },
    })
  }

  visit(value, 0)
  return { docs, unsupported }
}

function readHooks(
  root: string,
  openai: Record<string, unknown> | undefined,
  openaiSource: string,
): { hooks: IrHook[]; pending: IrUnmaterialized[]; unsupported: IrUnmaterialized[] } {
  const hooks: IrHook[] = []
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []
  const explicit = openai?.hooks
  const explicitLabel = openaiSource === 'plugin.json' ? 'extensions.com.openai.hooks' : `${openaiSource}#hooks`

  const documents: HookDocument[] = []
  if (explicit !== undefined) {
    const loaded = readHookDocuments(root, explicit, explicitLabel)
    documents.push(...loaded.docs)
    unsupported.push(...loaded.unsupported)
    // The manifest value replaces default discovery; Codex does not merge it.
    // Record the shadowed file so a hook that looks present cannot go missing
    // without a line in the report.
    const discovered = join(root, 'hooks', 'hooks.json')
    if (existsSync(discovered)) {
      unsupported.push({
        surface: 'hooks',
        name: 'hooks/hooks.json',
        sourcePath: 'hooks/hooks.json',
        annotation: {
          fidelity: 'unsupported',
          reason:
            'Ignored by design: `extensions.com.openai.hooks` is present, and the manifest value replaces default `hooks/hooks.json` discovery. Codex does not merge the two, so this file is not read.',
        },
      })
    }
  } else {
    const defaultPath = join(root, 'hooks', 'hooks.json')
    if (existsSync(defaultPath)) {
      const loaded = readJson(defaultPath)
      const object = asObject(loaded.value)
      if (object === undefined) {
        unsupported.push({
          surface: 'hooks',
          name: 'hooks/hooks.json',
          sourcePath: 'hooks/hooks.json',
          annotation: {
            fidelity: 'unsupported',
            reason: `hooks/hooks.json is ${loaded.error ?? 'not a JSON object'}; Codex skips a malformed hook file and so does this reader.`,
          },
        })
      } else {
        documents.push({ sourcePath: 'hooks/hooks.json', document: object })
      }
    }
    // Codex's older compatibility layout used hooks.json at the root. It is
    // not the portable discovery location, so record it rather than read it.
    const legacy = join(root, 'hooks.json')
    if (existsSync(legacy) && !existsSync(defaultPath)) {
      pending.push({
        surface: 'hooks',
        name: 'hooks.json',
        sourcePath: 'hooks.json',
        annotation: {
          fidelity: 'planned',
          reason:
            'A root `hooks.json` is the Codex compatibility location; the portable discovery path is `hooks/hooks.json`. Recorded, not read, so the difference is visible.',
        },
      })
    }
  }

  const counters = new Map<string, number>()
  for (const { sourcePath, document } of documents) {
    const table = isObject(document.hooks) ? document.hooks : looksLikeHookTable(document) ? document : undefined
    if (table === undefined) {
      unsupported.push({
        surface: 'hooks',
        name: sourcePath,
        sourcePath,
        annotation: {
          fidelity: 'unsupported',
          reason: 'A hook document must contain a `hooks` object (or a bare event table); this one has neither.',
        },
      })
      continue
    }
    for (const [event, groups] of Object.entries(table)) {
      if (event === 'description') continue
      if (!Array.isArray(groups)) {
        unsupported.push({
          surface: 'hooks',
          name: `${event}`,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: `Hook event ${JSON.stringify(event)} must be an array of matcher groups.` },
        })
        continue
      }
      for (const group of groups) {
        const groupObject = asObject(group)
        if (groupObject === undefined) {
          unsupported.push({
            surface: 'hooks',
            name: `${event}`,
            sourcePath,
            annotation: { fidelity: 'unsupported', reason: `A matcher group for ${JSON.stringify(event)} must be an object.` },
          })
          continue
        }
        const groupMatcher = stringField(groupObject, 'matcher')
        const handlers = Array.isArray(groupObject.hooks) ? groupObject.hooks : []
        if (handlers.length === 0) {
          pending.push({
            surface: 'hooks',
            name: `${event}#${counters.get(event) ?? 0}`,
            sourcePath,
            annotation: {
              fidelity: 'planned',
              reason: `Hook event ${JSON.stringify(event)} declares a matcher group with no handlers; nothing runs, so there is nothing to carry.`,
            },
          })
          continue
        }
        for (const handler of handlers) {
          const handlerObject = asObject(handler)
          const index = counters.get(event) ?? 0
          counters.set(event, index + 1)
          if (handlerObject === undefined) {
            unsupported.push({
              surface: 'hooks',
              name: `${event}#${index}`,
              sourcePath,
              annotation: { fidelity: 'unsupported', reason: 'A hook handler must be an object.' },
            })
            continue
          }
          const type = stringField(handlerObject, 'type') ?? 'command'
          const command = stringField(handlerObject, 'command')
          const declaredTimeout = numberField(handlerObject, 'timeout')
          const shortEvent = event === 'SessionEnd' || event === 'Interrupt'
          const timeoutMax = shortEvent ? 3 : undefined
          const timeoutSeconds =
            declaredTimeout === undefined
              ? (shortEvent ? 1 : HOOK_TIMEOUT_DEFAULT_SECONDS)
              : timeoutMax === undefined
                ? declaredTimeout
                : Math.min(declaredTimeout, timeoutMax)
          const matcherDropped = groupMatcher !== undefined && MATCHER_IGNORED.has(event)
          const annotation =
            type === 'command' && command !== undefined
              ? hookAnnotation(event, handlerObject, {
                  matcherDropped,
                  timeoutDefaulted: declaredTimeout === undefined,
                  timeoutSeconds,
                  ...(declaredTimeout !== undefined && timeoutSeconds !== declaredTimeout
                    ? { timeoutCappedFrom: declaredTimeout }
                    : {}),
                })
              : {
                  fidelity: 'planned' as const,
                  reason:
                    `\`${event}\` handler type ${JSON.stringify(type)} is recognized but not runnable here: only \`command\` handlers have a DSH seam, and this handler ${command === undefined ? 'has no command' : 'is not a command'} (S9/D32).`,
                }
          hooks.push({
            kind: 'hook',
            event,
            ...(groupMatcher === undefined || MATCHER_IGNORED.has(event) ? {} : { matcher: groupMatcher }),
            index,
            handler: type,
            ...(command === undefined ? {} : { command: normalizeHookCommand(command) }),
            ...(type === 'command' && command !== undefined ? { timeout: timeoutSeconds } : {}),
            sourcePath,
            annotation,
          })
        }
      }
    }
  }

  return { hooks, pending, unsupported }
}

function readSkills(root: string): { skills: IrSkill[]; pending: IrUnmaterialized[]; unsupported: IrUnmaterialized[] } {
  const skills: IrSkill[] = []
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []

  const skillFromFile = (
    abs: string,
    rel: string,
    origin: IrSkill['origin'],
    fallbackName: string,
    resourceDir: string,
  ): IrSkill | undefined => {
    const text = readIfFile(abs)
    if (text === undefined) return undefined
    const parsed = parseFrontmatter(text)
    if (!parsed.closed) {
      return {
        kind: 'skill',
        name: fallbackName,
        description: '',
        content: text,
        invocation: { modelInvocable: true, userInvocable: true },
        origin,
        sourcePath: rel,
        resourceDir,
        annotation: {
          fidelity: 'equivalent',
          reason:
            'Unterminated frontmatter: the host ignores all fields but still loads the body, so the raw file is used as the body and identity falls back to the path.',
        },
      }
    }
    const name = stringField(parsed.data, 'name') ?? fallbackName
    return {
      kind: 'skill',
      name,
      description: stringField(parsed.data, 'description') ?? '',
      content: parsed.body,
      invocation: { modelInvocable: true, userInvocable: true },
      origin,
      sourcePath: rel,
      resourceDir,
      annotation: SKILL_EQUIVALENT,
    }
  }

  const rootSkill = join(root, 'SKILL.md')
  if (readIfFile(rootSkill) !== undefined) {
    const skill = skillFromFile(rootSkill, 'SKILL.md', 'root-skill', basename(root), root)
    if (skill) skills.push(skill)
  }

  const skillsDir = join(root, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(skillsDir, entry.name)
      if (entry.isDirectory()) {
        const file = join(abs, 'SKILL.md')
        if (readIfFile(file) === undefined) {
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
        const skill = skillFromFile(file, `skills/${entry.name}/SKILL.md`, 'skills-dir', entry.name, abs)
        if (skill) skills.push(skill)
      } else if (entry.name.endsWith('.md')) {
        unsupported.push({
          surface: 'skills',
          name: entry.name.replace(/\.md$/, ''),
          sourcePath: `skills/${entry.name}`,
          annotation: {
            fidelity: 'unsupported',
            reason:
              'The portable spec discovers only `skills/<dir>/SKILL.md`; a bare `skills/<name>.md` is a DSH discovery form, not a Codex one.',
          },
        })
      }
    }
  }

  return { skills, pending, unsupported }
}

function readMcp(root: string): { servers: IrMcpServer[]; pending: IrUnmaterialized[]; unsupported: IrUnmaterialized[] } {
  const servers: IrMcpServer[] = []
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []

  const portablePath = join(root, 'mcp.json')
  const compatibilityPath = join(root, '.mcp.json')
  const path = readIfFile(portablePath) !== undefined ? portablePath : readIfFile(compatibilityPath) !== undefined ? compatibilityPath : undefined
  if (path === undefined) return { servers, pending, unsupported }
  const sourcePath = relPath(root, path)
  if (path === compatibilityPath) {
    pending.push({
      surface: 'mcpServers',
      name: 'mcp.json',
      sourcePath,
      annotation: {
        fidelity: 'planned',
        reason:
          'The portable `mcp.json` is absent; `.mcp.json` is the Codex compatibility location. It is read so a real plugin is not silently empty, but it is not part of the portable 1.0.0 guarantee.',
      },
    })
  }

  const loaded = readJson(path)
  const document = asObject(loaded.value)
  if (document === undefined) {
    unsupported.push({
      surface: 'mcpServers',
      name: sourcePath,
      sourcePath,
      annotation: { fidelity: 'unsupported', reason: `${sourcePath} is ${loaded.error ?? 'not a JSON object'}; no MCP server can be read.` },
    })
    return { servers, pending, unsupported }
  }

  const schema = document.$schema
  if (schema === undefined) {
    pending.push({
      surface: 'mcpServers',
      name: '$schema',
      sourcePath,
      annotation: {
        fidelity: 'planned',
        reason: `The published mcp schema requires \`$schema: ${PORTABLE_MCP_SCHEMA}\`; this file omits it. Servers are read as a compatibility guest, not as a conformant 1.0.0 document.`,
      },
    })
  } else if (schema !== PORTABLE_MCP_SCHEMA) {
    unsupported.push({
      surface: 'mcpServers',
      name: '$schema',
      sourcePath,
      annotation: {
        fidelity: 'unsupported',
        reason: `\`mcp.json\` declares ${JSON.stringify(schema)}; a non-1.0.0 schema makes the document invalid, so the whole MCP component is refused rather than half-read.`,
      },
    })
    return { servers, pending, unsupported }
  }

  let table: Record<string, unknown> | undefined
  if (isObject(document.mcpServers)) {
    table = document.mcpServers
  } else if (document.mcpServers === undefined) {
    const keys = Object.keys(document).filter((key) => key !== '$schema' && key !== 'description')
    const flat = keys.length > 0 && keys.every((key) => isObject(document[key]))
    if (flat) {
      table = Object.fromEntries(keys.map((key) => [key, document[key]]))
      pending.push({
        surface: 'mcpServers',
        name: 'mcpServers',
        sourcePath,
        annotation: {
          fidelity: 'planned',
          reason:
            'The file is a flat server map. The ticket described that shape, but the published 1.0.0 schema requires a top-level `mcpServers` object; the flat read is a recorded compatibility extension, not the portable contract.',
        },
      })
    }
  }
  if (table === undefined) {
    unsupported.push({
      surface: 'mcpServers',
      name: 'mcpServers',
      sourcePath,
      annotation: {
        fidelity: 'unsupported',
        reason: '`mcp.json` must contain a `mcpServers` object (the published 1.0.0 schema), with no other top-level server table.',
      },
    })
    return { servers, pending, unsupported }
  }

  const substituteRoot = (value: string): string => value.replaceAll('${PLUGIN_ROOT}', root)
  const unresolvedData = (value: string): boolean => value.includes('${PLUGIN_DATA}')

  for (const [name, raw] of Object.entries(table)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      unsupported.push({
        surface: 'mcpServers',
        name,
        sourcePath,
        annotation: { fidelity: 'unsupported', reason: 'A server entry must be an object.' },
      })
      continue
    }
    const entry = raw as Record<string, unknown>
    if (servers.some((server) => server.name === name)) {
      unsupported.push({
        surface: 'mcpServers',
        name,
        sourcePath,
        annotation: { fidelity: 'unsupported', reason: 'Duplicate server name; only the first would be reachable, so the duplicate is refused.' },
      })
      continue
    }
    const serialized = JSON.stringify(entry)
    if (serialized.includes('${PLUGIN_DATA}')) {
      pending.push({ surface: 'mcpServers', name, sourcePath, annotation: MCP_UNRESOLVED })
      continue
    }

    // Codex's composition has no plugin segment: `mcp__<server>__<tool>`.
    // Budget arithmetic is enforced here, before any tool is listed.
    const prefix = `mcp__${name}__`
    if (prefix.length + 1 > 64) {
      unsupported.push({
        surface: 'mcpServers',
        name,
        sourcePath,
        annotation: {
          fidelity: 'unsupported',
          reason: `Every tool of this server would start with ${JSON.stringify(prefix)} (${prefix.length} characters), so the shortest possible name is ${prefix.length + 1} characters and exceeds the shared 64-character limit; refused rather than truncated (D11, D33).`,
        },
      })
      continue
    }

    const type = stringField(entry, 'type')
    if (type === undefined) {
      unsupported.push({
        surface: 'mcpServers',
        name,
        sourcePath,
        annotation: {
          fidelity: 'unsupported',
          reason: 'Each portable server must declare `type` (`stdio` or `streamable-http`); without it the transport is ambiguous and no connection is attempted.',
        },
      })
      continue
    }

    if (type === 'stdio') {
      const command = stringField(entry, 'command')
      if (command === undefined) {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: 'A stdio server needs a `command`; without one it cannot start.' },
        })
        continue
      }
      if (command.includes('${')) {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: {
            fidelity: 'unsupported',
            reason:
              'The 1.0.0 schema forbids placeholder expansion in `command` (only `args`, `env`, `cwd` expand `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`); a placeholder here would be passed literally to exec and could not resolve.',
          },
        })
        continue
      }
      const args = stringList(entry.args)
      if (entry.args !== undefined && args === undefined) {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: '`args` must be an array of strings.' },
        })
        continue
      }
      const env = entry.env === undefined ? undefined : stringMap(entry.env)
      if (entry.env !== undefined && env === undefined) {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: '`env` must be an object of string values.' },
        })
        continue
      }
      if (env !== undefined && (Object.hasOwn(env, 'PLUGIN_ROOT') || Object.hasOwn(env, 'PLUGIN_DATA'))) {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: {
            fidelity: 'unsupported',
            reason: 'The schema forbids setting `PLUGIN_ROOT`/`PLUGIN_DATA` in `env`; those names are supplied by the host, not the server.',
          },
        })
        continue
      }
      let cwd: string | undefined
      if (entry.cwd !== undefined) {
        if (typeof entry.cwd !== 'string') {
          unsupported.push({
            surface: 'mcpServers',
            name,
            sourcePath,
            annotation: { fidelity: 'unsupported', reason: '`cwd` must be a string.' },
          })
          continue
        }
        const value = entry.cwd
        const allowed =
          value === '.' ||
          value.startsWith('./') ||
          value.startsWith('${PLUGIN_ROOT}') ||
          value.startsWith('${PLUGIN_DATA}')
        if (!allowed) {
          unsupported.push({
            surface: 'mcpServers',
            name,
            sourcePath,
            annotation: {
              fidelity: 'unsupported',
              reason: '`cwd` must be `./…`, `${PLUGIN_ROOT}…`, or `${PLUGIN_DATA}…`; an absolute or escaping path could leave the plugin root.',
            },
          })
          continue
        }
        cwd = value === '.' ? root : substituteRoot(value)
      }
      servers.push({
        kind: 'mcp-server',
        name,
        transport: 'stdio',
        command,
        ...(args === undefined ? {} : { args: args.map(substituteRoot) }),
        ...(env === undefined ? {} : { env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, substituteRoot(value)])) }),
        ...(cwd === undefined ? {} : { cwd }),
        toolNamePrefix: prefix,
        pluginRoot: root,
        sourcePath,
        annotation: MCP_EQUIVALENT,
      })
      continue
    }

    if (type === 'streamable-http' || type === 'http') {
      const url = stringField(entry, 'url')
      if (url === undefined) {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: 'An HTTP server needs a `url`; without one it cannot connect.' },
        })
        continue
      }
      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: `\`url\` ${JSON.stringify(url)} is not an absolute URL.` },
        })
        continue
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: '`url` must be http(s); other schemes have no Streamable HTTP transport.' },
        })
        continue
      }
      const headers = entry.headers === undefined ? undefined : stringMap(entry.headers)
      if (entry.headers !== undefined && headers === undefined) {
        unsupported.push({
          surface: 'mcpServers',
          name,
          sourcePath,
          annotation: { fidelity: 'unsupported', reason: '`headers` must be an object of string values.' },
        })
        continue
      }
      servers.push({
        kind: 'mcp-server',
        name,
        transport: 'http',
        url,
        ...(headers === undefined ? {} : { headers }),
        toolNamePrefix: prefix,
        pluginRoot: root,
        sourcePath,
        annotation:
          type === 'http'
            ? {
                fidelity: 'equivalent',
                reason:
                  'Codex\'s compatibility spelling is `http`; the portable spelling is `streamable-http`, and both name the same Streamable HTTP transport. Tool names use `mcp__<server>__<tool>`; instructions and reconnect policy are not carried (D12).',
              }
            : MCP_EQUIVALENT,
      })
      continue
    }

    unsupported.push({
      surface: 'mcpServers',
      name,
      sourcePath,
      annotation: {
        fidelity: 'unsupported',
        reason: `Transport ${JSON.stringify(type)} is not carried. The portable 1.0.0 schema defines stdio and streamable-http (legacy sse is schema-valid but has no DSH materializer).`,
      },
    })
  }

  return { servers, pending, unsupported }
}

function readManifest(root: string): {
  manifest: Record<string, unknown>
  manifestSource: string
  portable: boolean
  overlay: Record<string, unknown> | undefined
  pending: IrUnmaterialized[]
  unsupported: IrUnmaterialized[]
} {
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []
  const rootManifestPath = join(root, 'plugin.json')
  const fallbackPath = join(root, CODEX_MANIFEST)

  let manifest: Record<string, unknown> = {}
  let manifestSource = ''
  let portable = false
  let overlay: Record<string, unknown> | undefined

  if (readIfFile(rootManifestPath) !== undefined) {
    const loaded = readJson(rootManifestPath)
    if (isObject(loaded.value)) {
      manifest = loaded.value
      manifestSource = 'plugin.json'
      portable = true
    } else {
      unsupported.push({
        surface: 'manifest',
        name: 'plugin.json',
        sourcePath: 'plugin.json',
        annotation: { fidelity: 'unsupported', reason: `plugin.json is ${loaded.error ?? 'not a JSON object'}; no portable manifest can be read.` },
      })
    }
  } else if (readIfFile(fallbackPath) !== undefined) {
    const loaded = readJson(fallbackPath)
    if (isObject(loaded.value)) {
      manifest = loaded.value
      overlay = loaded.value
      manifestSource = CODEX_MANIFEST
    } else {
      unsupported.push({
        surface: 'manifest',
        name: CODEX_MANIFEST,
        sourcePath: CODEX_MANIFEST,
        annotation: { fidelity: 'unsupported', reason: `${CODEX_MANIFEST} is ${loaded.error ?? 'not a JSON object'}; no Codex manifest can be read.` },
      })
    }
  } else {
    unsupported.push({
      surface: 'manifest',
      name: 'plugin.json',
      sourcePath: 'plugin.json',
      annotation: {
        fidelity: 'unsupported',
        reason: 'No `plugin.json` at the root and no `.codex-plugin/plugin.json` fallback; the plugin has no manifest and its identity is the directory name.',
      },
    })
  }

  // A portable root and an overlay can coexist. Under the replacement rule the
  // root's extensions.com.openai object is the only source of OpenAI settings;
  // the overlay is kept solely as the fallback when that object is absent.
  if (manifestSource === 'plugin.json' && readIfFile(fallbackPath) !== undefined) {
    const loaded = readJson(fallbackPath)
    if (isObject(loaded.value)) overlay = loaded.value
  }

  return { manifest, manifestSource, portable, overlay, pending, unsupported }
}

function readExtensionSurfaces(
  manifest: Record<string, unknown>,
  manifestSource: string,
  overlay: Record<string, unknown> | undefined,
): {
  openai: Record<string, unknown> | undefined
  openaiSource: string
  pending: IrUnmaterialized[]
  unsupported: IrUnmaterialized[]
} {
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []
  const extensions = asObject(manifest.extensions)
  let openai: Record<string, unknown> | undefined
  let openaiSource = manifestSource

  if (manifest.extensions !== undefined && extensions === undefined) {
    unsupported.push({
      surface: 'manifest',
      name: 'extensions',
      sourcePath: manifestSource,
      annotation: { fidelity: 'unsupported', reason: '`extensions` must be an object of namespace objects; a non-object extension table is not read.' },
    })
  } else if (extensions !== undefined) {
    for (const [namespace, value] of Object.entries(extensions)) {
      if (namespace === 'com.openai') continue
      pending.push({
        surface: 'extensions',
        name: namespace,
        sourcePath: manifestSource,
        annotation: {
          fidelity: 'planned',
          reason: `Extension namespace ${JSON.stringify(namespace)} belongs to another host and has no DSH seam; recorded only, never guessed at.`,
        },
      })
    }
    if (extensions['com.openai'] !== undefined) {
      if (isObject(extensions['com.openai'])) {
        openai = extensions['com.openai']
      } else {
        unsupported.push({
          surface: 'manifest',
          name: 'extensions.com.openai',
          sourcePath: manifestSource,
          annotation: { fidelity: 'unsupported', reason: '`extensions.com.openai` must be an object; a scalar cannot supply hooks, interface, apps, or onboardingSkill.' },
        })
      }
    }
  }

  if (openai !== undefined) {
    // Replacement, not merge. Every overlay key that the root extension could
    // have supplied is dead data, and the report says which one.
    const owned = ['hooks', 'interface', 'apps', 'onboardingSkill', 'skills', 'mcpServers']
    for (const key of owned) {
      if (overlay === undefined || overlay[key] === undefined) continue
      unsupported.push({
        surface: `manifest.${key}`,
        name: `${CODEX_MANIFEST}#${key}`,
        sourcePath: CODEX_MANIFEST,
        annotation: {
          fidelity: 'unsupported',
          reason:
            `Replaced, not merged: \`extensions.com.openai\` is an object, so it is the sole source of OpenAI settings and the overlay's ${JSON.stringify(key)} is not read. Codex does not merge the two.`,
        },
      })
    }
  } else if (overlay !== undefined) {
    openai = overlay
    openaiSource = CODEX_MANIFEST
  }

  if (openai?.interface !== undefined) {
    const name = typeof openai.interface === 'string' ? openai.interface : 'com.openai.interface'
    unsupported.push({
      surface: 'interface',
      name,
      sourcePath: openaiSource,
      annotation: {
        fidelity: 'unsupported',
        reason:
          '`interface` is presentation-only chrome (F3): displayName, shortDescription, composerIcon, logo, and screenshots have no DSH plugin-detail surface at this pin. Recorded, never rendered.',
      },
    })
  }

  if (openai?.apps !== undefined) {
    const name = typeof openai.apps === 'string' ? openai.apps : 'com.openai.apps'
    pending.push({
      surface: 'apps',
      name,
      sourcePath: openaiSource,
      annotation: {
        fidelity: 'planned',
        reason:
          'Codex apps are host-managed connectors/apps; DSH has no app directory seam. Recorded only, including any `.app.json` the pointer names.',
      },
    })
  }

  if (openai?.onboardingSkill !== undefined) {
    const name = typeof openai.onboardingSkill === 'string' ? openai.onboardingSkill : 'com.openai.onboardingSkill'
    pending.push({
      surface: 'onboardingSkill',
      name,
      sourcePath: openaiSource,
      annotation: {
        fidelity: 'planned',
        reason:
          'Codex uses this pointer during onboarding; DSH has no onboarding surface. The skill itself is read only if it lives under `skills/`; this pointer is recorded, not followed.',
      },
    })
  }

  if (typeof openai?.skills === 'string') {
    const declared = openai.skills
    if (declared !== './skills/' && declared !== './skills' && declared !== 'skills/') {
      pending.push({
        surface: 'skills',
        name: declared,
        sourcePath: openaiSource,
        annotation: {
          fidelity: 'planned',
          reason:
            'The extension points at a non-default skills directory; the portable reader discovers `skills/<dir>/SKILL.md` only. Recorded so the external directory is not silently emptied.',
        },
      })
    }
  }

  if (openai?.mcpServers !== undefined) {
    pending.push({
      surface: 'mcpServers',
      name: 'com.openai.mcpServers',
      sourcePath: openaiSource,
      annotation: {
        fidelity: 'planned',
        reason:
          'An inline `mcpServers` table is not the portable `mcp.json` location; the published format puts servers in a separate file. Recorded only, not merged with `mcp.json`.',
      },
    })
  }

  return { openai, openaiSource, pending, unsupported }
}

function readDirectorySurfaces(root: string): { pending: IrUnmaterialized[]; unsupported: IrUnmaterialized[] } {
  const pending: IrUnmaterialized[] = []
  const unsupported: IrUnmaterialized[] = []
  const assets = join(root, 'assets')
  if (existsSync(assets)) {
    unsupported.push({
      surface: 'assets',
      name: 'assets',
      sourcePath: 'assets',
      annotation: {
        fidelity: 'unsupported',
        reason:
          'F4 asset files (icons, screenshots, binaries) have no DSH surface; they are recorded, not copied into the profile and not rendered.',
      },
    })
  }
  for (const [dir, reason] of [
    [
      'agents',
      'The portable 1.0.0 spec has no agents component. The Codex compatibility layout uses `agents/`, but this dialect does not map agents yet; recorded only.',
    ],
    [
      'commands',
      'Codex compatibility layout commands; DSH refuses a colon in a command name and a command handler cannot submit a prompt (D10). Recorded only.',
    ],
  ] as const) {
    if (existsSync(join(root, dir))) {
      pending.push({
        surface: dir,
        name: dir,
        sourcePath: dir,
        annotation: { fidelity: 'planned', reason },
      })
    }
  }
  return { pending, unsupported }
}

/**
 * Read a portable (Agent Plugins 1.0.0) plugin, or the Codex compatibility
 * layout's `.codex-plugin/plugin.json`, into the shared IR.
 *
 * The reader never decides whether DSH can materialize a node; it records the
 * declaration and the fidelity it expects. Trust and emit decide the rest.
 */
export function readCodexPlugin(root: string, options: ReadOptions = {}): ClaudePluginIr {
  const absoluteRoot = resolve(root)

  const manifestRead = readManifest(absoluteRoot)
  const manifest = manifestRead.manifest
  const manifestSource = manifestRead.manifestSource || 'plugin.json'
  const pending: IrUnmaterialized[] = [...manifestRead.pending]
  const unsupported: IrUnmaterialized[] = [...manifestRead.unsupported]

  if (manifestRead.portable) {
    const schema = manifest.$schema
    if (schema === undefined) {
      unsupported.push({
        surface: 'manifest',
        name: '$schema',
        sourcePath: 'plugin.json',
        annotation: {
          fidelity: 'unsupported',
          reason: `A portable plugin.json must declare \`$schema: ${PORTABLE_PLUGIN_SCHEMA}\`; without it the file is not a 1.0.0 manifest. The remaining fields are read for diagnosis only.`,
        },
      })
    } else if (schema !== PORTABLE_PLUGIN_SCHEMA) {
      unsupported.push({
        surface: 'manifest',
        name: '$schema',
        sourcePath: 'plugin.json',
        annotation: {
          fidelity: 'unsupported',
          reason: `plugin.json declares ${JSON.stringify(schema)}; the only portable schema accepted here is ${PORTABLE_PLUGIN_SCHEMA}.`,
        },
      })
    }
  }

  const declaredName = stringField(manifest, 'name')
  if (manifestRead.portable && declaredName === undefined) {
    unsupported.push({
      surface: 'manifest',
      name: 'name',
      sourcePath: 'plugin.json',
      annotation: {
        fidelity: 'unsupported',
        reason: 'The portable schema requires a `name` (1–64 chars, lowercase, digits, dots, hyphens); identity falls back to the directory name so the report still has a plugin.',
      },
    })
  } else if (declaredName !== undefined && manifestRead.portable && !PORTABLE_NAME.test(declaredName)) {
    unsupported.push({
      surface: 'manifest',
      name: 'name',
      sourcePath: manifestSource,
      annotation: {
        fidelity: 'unsupported',
        reason: `Manifest name ${JSON.stringify(declaredName)} does not match the portable grammar (1–64 chars, lowercase, digits, dots, hyphens, no \`--\` or \`..\`); the name is used as authored so nothing is silently rewritten.`,
      },
    })
  }

  const allowedTopLevel = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
  if (manifestRead.portable) {
    for (const key of Object.keys(manifest)) {
      if (allowedTopLevel.has(key)) continue
      unsupported.push({
        surface: 'manifest',
        name: key,
        sourcePath: 'plugin.json',
        annotation: {
          fidelity: 'unsupported',
          reason: `Unknown top-level field ${JSON.stringify(key)}: the 1.0.0 schema says report and ignore it. There is nothing to carry, so it is recorded here and never mapped onto a DSH field.`,
        },
      })
    }
  }

  const extensionRead = readExtensionSurfaces(manifest, manifestSource, manifestRead.overlay)
  pending.push(...extensionRead.pending)
  unsupported.push(...extensionRead.unsupported)

  const skillsRead = readSkills(absoluteRoot)
  pending.push(...skillsRead.pending)
  unsupported.push(...skillsRead.unsupported)

  const hooksRead = readHooks(absoluteRoot, extensionRead.openai, extensionRead.openaiSource)
  pending.push(...hooksRead.pending)
  unsupported.push(...hooksRead.unsupported)

  const mcpRead = readMcp(absoluteRoot)
  pending.push(...mcpRead.pending)
  unsupported.push(...mcpRead.unsupported)

  const directoryRead = readDirectorySurfaces(absoluteRoot)
  pending.push(...directoryRead.pending)
  unsupported.push(...directoryRead.unsupported)

  const name = declaredName ?? basename(absoluteRoot)
  const version = stringField(manifest, 'version')
  const description = stringField(manifest, 'description')

  return {
    ir: IR_SCHEMA,
    plugin: {
      name,
      ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }),
      source: options.source ?? `plugin-dir:${absoluteRoot}`,
      root: absoluteRoot,
    },
    pin: options.pin ?? AGENT_PLUGINS_PIN,
    skills: skillsRead.skills,
    agents: [],
    hooks: hooksRead.hooks,
    mcpServers: mcpRead.servers,
    pending,
    unsupported,
  }
}
