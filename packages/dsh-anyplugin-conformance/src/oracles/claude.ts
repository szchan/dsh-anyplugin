/**
 * Upstream oracle: ask Claude Code itself what it loaded.
 *
 * `claude --plugin-dir <dir> plugin details <name>` loads the plugin for one
 * session and prints its component inventory plus projected token cost. That
 * makes the real loader the ground truth instead of our reading of its docs —
 * the whole point of the conformance rig.
 *
 * Every probe runs under a throwaway HOME and CLAUDE_CONFIG_DIR so it cannot
 * read or write the user's own installation, and so two runs on the same
 * plugin are byte-comparable.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import {
  emptyInventory,
  type Inventory,
  type InventoryComponent,
  type InventoryPin,
  type Surface,
  type TokenCost,
} from '../inventory.ts'

const run = promisify(execFile)

const SURFACE_LABELS: Record<string, Surface> = {
  skills: 'skills',
  commands: 'commands',
  agents: 'agents',
  hooks: 'hooks',
  'mcp servers': 'mcpServers',
  'lsp servers': 'lspServers',
  'output styles': 'outputStyles',
  themes: 'themes',
  workflows: 'workflows',
  monitors: 'monitors',
  mods: 'mods',
}

export interface ClaudeProbeResult {
  inventory: Inventory
  pin: InventoryPin
  raw: string
  stderr: string
}

export interface ClaudeProbeOptions {
  pluginDir: string
  /** Plugin name Claude should resolve; defaults to the manifest name or the directory name. */
  name?: string
  bin?: string
  timeoutMs?: number
}

/** The name Claude will resolve for a `--plugin-dir` plugin. */
export async function resolvePluginName(pluginDir: string): Promise<string> {
  for (const candidate of ['.claude-plugin/plugin.json', 'plugin.json']) {
    try {
      const parsed = JSON.parse(await readFile(join(pluginDir, candidate), 'utf8')) as { name?: unknown }
      if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim()
    } catch {
      // missing or unparsable manifest — fall through to the directory name
    }
  }
  return basename(pluginDir)
}

export async function claudeVersion(bin = 'claude', timeoutMs = 30_000): Promise<string> {
  const { stdout } = await run(bin, ['--version'], { timeout: timeoutMs })
  const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(stdout)
  if (!match) throw new Error(`could not read a version from ${bin} --version: ${stdout.trim()}`)
  return match[1]
}

function parseCost(cell: string): TokenCost | undefined {
  const text = cell.trim()
  const atMost = text.startsWith('<')
  const match = /(\d+)/.exec(text)
  if (!match) return undefined
  const value = Number(match[1])
  return atMost ? { value, atMost: true } : { value }
}

/**
 * Parse the human-readable `plugin details` report.
 *
 * The format is a report, not a schema, so the parser is deliberately strict
 * about what it claims to understand and records anything it cannot classify
 * as an explicit note rather than dropping it silently.
 */
export function parseClaudeDetails(text: string, fallbackName: string): { inventory: Inventory; pinlessNotes: string[] } {
  const lines = text.split(/\r?\n/)
  const notes: string[] = []

  let name = fallbackName
  let version: string | undefined
  const components: InventoryComponent[] = []
  const perComponent: Record<string, TokenCost> = {}
  let alwaysOn: TokenCost | undefined
  let section: 'header' | 'components' | 'tokens' | 'table' | 'footer' = 'header'
  let tableColumns: string[] = []

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue

    const heading = line.trim()
    if (heading === 'Component inventory') {
      section = 'components'
      continue
    }
    if (heading === 'Projected token cost') {
      section = 'tokens'
      continue
    }
    if (heading === 'Per-component (rounded)') {
      section = 'table'
      continue
    }
    if (section === 'footer' || heading.startsWith('Token counts are estimates') || heading.startsWith('On-invoke cost is paid')) {
      section = 'footer'
      continue
    }

    if (section === 'header') {
      const match = /^(\S+)(?:\s+(\d+\.\d+\.\d+(?:-[\w.]+)?))?$/.exec(heading)
      if (match && !heading.includes(':')) {
        name = match[1]
        version = match[2]
        continue
      }
      const described = /^Description:\s*(.*)$/.exec(heading)
      if (described) continue
      const source = /^Source:\s*(.*)$/.exec(heading)
      if (source) continue
      continue
    }

    if (section === 'components') {
      const match = /^(\S.*?)\s+\((\d+)\)(?:\s{2,}(.*))?$/.exec(heading)
      if (!match) {
        notes.push(`unparsed inventory line: ${heading}`)
        continue
      }
      const label = match[1].trim()
      const count = Number(match[2])
      const listed = (match[3] ?? '').split(',').map((part) => part.trim()).filter(Boolean)
      const surface = SURFACE_LABELS[label.toLowerCase()]
      if (!surface) {
        notes.push(`unmapped inventory label "${label}" (${count}) — recorded as surface "other"`)
        components.push({ surface: 'other', name: label })
        continue
      }
      // An entry may carry a trailing parenthetical, e.g.
      //   PostToolUse  (harness-only — no model context cost)
      // That parenthetical is information about the component, not part of its
      // name, so it becomes a detail instead of polluting the identity.
      const parsed = listed.map((part) => {
        const annotated = /^(.*?)\s{2,}\((.*)\)$/.exec(part)
        return annotated
          ? { name: annotated[1].trim(), note: annotated[2].trim() }
          : { name: part }
      })
      if (parsed.length !== count) {
        notes.push(`"${label}" reported ${count} but listed ${parsed.length}: ${listed.join(', ')}`)
      }
      const aggregated = new Map<string, { note?: string; occurrences: number }>()
      for (const item of parsed) {
        const existing = aggregated.get(item.name)
        if (existing) existing.occurrences += 1
        else aggregated.set(item.name, { ...(item.note ? { note: item.note } : {}), occurrences: 1 })
      }
      for (const [componentName, info] of aggregated) {
        const details: Record<string, string | number> = {}
        if (info.note) details.note = info.note
        if (info.occurrences > 1) details.occurrences = info.occurrences
        components.push(
          Object.keys(details).length > 0
            ? { surface, name: componentName, details }
            : { surface, name: componentName },
        )
      }
      continue
    }

    if (section === 'tokens') {
      const match = /^Always-on:\s*(.+?)\s+added to every session$/.exec(heading)
      if (match) {
        alwaysOn = parseCost(match[1])
        continue
      }
      notes.push(`unparsed token line: ${heading}`)
      continue
    }

    if (section === 'table') {
      if (heading.startsWith('component ')) {
        tableColumns = heading.split(/\s{2,}/).map((column) => column.trim())
        continue
      }
      const cells = heading.split(/\s{2,}/).map((cell) => cell.trim())
      if (cells.length < 2) {
        notes.push(`unparsed per-component row: ${heading}`)
        continue
      }
      const [componentName, ...costs] = cells
      const alwaysOnCost = parseCost(costs[0] ?? '')
      const onInvokeCost = parseCost(costs[1] ?? '')
      // Only the always-on column is kept: it is the cost paid every turn, and
      // it is the number a DSH-side projection can be asked to reproduce.
      if (alwaysOnCost) perComponent[componentName] = alwaysOnCost
      else notes.push(`per-component row without a numeric always-on cost: ${heading}`)
      if (alwaysOnCost && onInvokeCost === undefined && tableColumns.length > 2) {
        notes.push(`missing on-invoke cost for ${componentName}`)
      }
      continue
    }
  }

  const inventory = emptyInventory(version ? { name, version } : { name })
  inventory.components = components
  if (alwaysOn) inventory.tokens = { alwaysOn }
  if (Object.keys(perComponent).length > 0) {
    inventory.tokens = inventory.tokens ?? {}
    inventory.tokens.perComponent = perComponent
  }
  inventory.notes = notes
  return { inventory, pinlessNotes: notes }
}

export async function probeWithClaude(options: ClaudeProbeOptions): Promise<ClaudeProbeResult> {
  const bin = options.bin ?? 'claude'
  const name = options.name ?? (await resolvePluginName(options.pluginDir))
  const version = await claudeVersion(bin, options.timeoutMs)

  const home = await mkdtemp(join(tmpdir(), 'anyplugin-probe-'))
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE_')))
    const { stdout, stderr } = await run(bin, ['--plugin-dir', options.pluginDir, 'plugin', 'details', name], {
      timeout: options.timeoutMs ?? 120_000,
      env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
    })
    const { inventory } = parseClaudeDetails(stdout, name)
    const pin: InventoryPin = { tool: 'claude-code', version }
    return { inventory: { ...inventory, pin }, pin, raw: stdout, stderr }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
