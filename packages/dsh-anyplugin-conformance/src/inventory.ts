/**
 * The normalized component inventory — the rig's unit of comparison.
 *
 * An inventory is what a host *reports* about a plugin: the components it
 * loaded and, where the host says so, what they cost. Two inventories come
 * from different hosts (Claude Code, DSH, or our own dialect) and are compared
 * only after both have been normalized here, so a diff never depends on
 * formatting, ordering or absolute paths.
 */
export const INVENTORY_SCHEMA = 'dsh-anyplugin/inventory@1'

export const SURFACES = [
  'skills',
  'commands',
  'agents',
  'hooks',
  'mcpServers',
  'lspServers',
  'outputStyles',
  'themes',
  'workflows',
  'bin',
  'monitors',
  'mods',
  'other',
] as const

export type Surface = (typeof SURFACES)[number]

export interface InventoryPin {
  tool: string
  version: string
}

export interface InventoryComponent {
  surface: Surface
  name: string
  details?: Record<string, string | number | boolean | null>
}

export interface TokenCost {
  value: number
  atMost?: boolean
}

export interface Inventory {
  $schema: typeof INVENTORY_SCHEMA
  plugin: { name: string; version?: string; source?: string }
  pin?: InventoryPin
  components: InventoryComponent[]
  tokens?: { alwaysOn?: TokenCost; perComponent?: Record<string, TokenCost> }
  notes?: string[]
}

export function emptyInventory(plugin: Inventory['plugin']): Inventory {
  return { $schema: INVENTORY_SCHEMA, plugin, components: [], notes: [] }
}

function compareComponents(a: InventoryComponent, b: InventoryComponent): number {
  if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && (SURFACES as readonly string[]).includes(value)
}

/**
 * Canonical form: trimmed non-empty names, known surfaces, sorted, deduped,
 * details keys sorted. Idempotent — normalizing twice changes nothing.
 */
export function normalizeInventory(input: Inventory): Inventory {
  const seen = new Map<string, InventoryComponent>()
  for (const component of input.components ?? []) {
    const name = String(component.name ?? '').trim()
    if (!name) continue
    const surface: Surface = isSurface(component.surface) ? component.surface : 'other'
    const key = `${surface}\u0000${name}`
    if (seen.has(key)) continue
    const details = component.details
    const normalized: InventoryComponent = { surface, name }
    if (details) {
      const entries = Object.entries(details).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      if (entries.length > 0) normalized.details = Object.fromEntries(entries)
    }
    seen.set(key, normalized)
  }
  const components = [...seen.values()].sort(compareComponents)

  const out: Inventory = {
    $schema: INVENTORY_SCHEMA,
    plugin: { ...input.plugin, name: String(input.plugin?.name ?? '').trim() },
    components,
  }
  if (input.pin?.tool && input.pin?.version) out.pin = { tool: input.pin.tool, version: input.pin.version }
  if (input.tokens?.alwaysOn) out.tokens = { alwaysOn: input.tokens.alwaysOn }
  if (input.tokens?.perComponent) {
    out.tokens = out.tokens ?? {}
    out.tokens.perComponent = Object.fromEntries(
      Object.entries(input.tokens.perComponent).sort(([a], [b]) => (a < b ? -1 : 1)),
    )
  }
  const notes = (input.notes ?? []).map((note) => String(note).trim()).filter(Boolean)
  if (notes.length > 0) out.notes = [...new Set(notes)].sort()
  return out
}

export type DiffStatus = 'match' | 'missing' | 'extra' | 'changed'

export interface DiffRow {
  surface: Surface
  name: string
  status: DiffStatus
  detail?: string
}

export interface DiffReport {
  ok: boolean
  pin: { expected?: InventoryPin; actual?: InventoryPin; mismatch: boolean }
  rows: DiffRow[]
  summary: {
    expected: number
    actual: number
    match: number
    missing: number
    extra: number
    changed: number
    bySurface: Record<string, { expected: number; actual: number; missing: number; extra: number; changed: number }>
  }
}

/**
 * Compare a golden (expected) inventory with a freshly observed one.
 *
 * A pin mismatch fails the diff on its own: "100 %" is only ever claimed
 * against a named version (AGENTS.md §3.8), so comparing across versions must
 * never look like a pass.
 */
export function diffInventories(
  expectedInput: Inventory,
  actualInput: Inventory,
  options: { allowPinMismatch?: boolean } = {},
): DiffReport {
  const expected = normalizeInventory(expectedInput)
  const actual = normalizeInventory(actualInput)
  const expectedKey = new Map(expected.components.map((c) => [`${c.surface}\u0000${c.name}`, c]))
  const actualKey = new Map(actual.components.map((c) => [`${c.surface}\u0000${c.name}`, c]))

  const rows: DiffRow[] = []
  for (const [key, component] of expectedKey) {
    const observed = actualKey.get(key)
    if (!observed) {
      rows.push({ surface: component.surface, name: component.name, status: 'missing' })
      continue
    }
    if (JSON.stringify(component.details ?? null) !== JSON.stringify(observed.details ?? null)) {
      rows.push({
        surface: component.surface,
        name: component.name,
        status: 'changed',
        detail: `expected ${JSON.stringify(component.details ?? null)}, actual ${JSON.stringify(observed.details ?? null)}`,
      })
      continue
    }
    rows.push({ surface: component.surface, name: component.name, status: 'match' })
  }
  for (const [key, component] of actualKey) {
    if (!expectedKey.has(key)) rows.push({ surface: component.surface, name: component.name, status: 'extra' })
  }
  rows.sort((a, b) => compareComponents(a, b))

  const pinMismatch = Boolean(
    expected.pin && actual.pin && (expected.pin.tool !== actual.pin.tool || expected.pin.version !== actual.pin.version),
  )

  const bySurface: DiffReport['summary']['bySurface'] = {}
  for (const row of rows) {
    const bucket = (bySurface[row.surface] ??= { expected: 0, actual: 0, missing: 0, extra: 0, changed: 0 })
    bucket[row.status] += 1
  }
  for (const component of expected.components) {
    const bucket = (bySurface[component.surface] ??= { expected: 0, actual: 0, missing: 0, extra: 0, changed: 0 })
    bucket.expected += 1
  }
  for (const component of actual.components) {
    const bucket = (bySurface[component.surface] ??= { expected: 0, actual: 0, missing: 0, extra: 0, changed: 0 })
    bucket.actual += 1
  }

  const count = (status: DiffStatus) => rows.filter((row) => row.status === status).length
  const rowsOk = rows.every((row) => row.status === 'match')
  return {
    ok: rowsOk && (options.allowPinMismatch ? true : !pinMismatch),
    pin: { expected: expected.pin, actual: actual.pin, mismatch: pinMismatch },
    rows,
    summary: {
      expected: expected.components.length,
      actual: actual.components.length,
      match: count('match'),
      missing: count('missing'),
      extra: count('extra'),
      changed: count('changed'),
      bySurface,
    },
  }
}
