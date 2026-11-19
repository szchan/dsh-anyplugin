/**
 * Rendering for a terminal and for CI logs: the inventory `DiffReport`, and the
 * compile-side report of what the transplant would do to a plugin.
 *
 * The second one is deliberately a *reader* of the compiler, not a second
 * compiler: it summarizes the annotations the dialect wrote and the carry
 * decisions the emitter made, and adds no fidelity of its own. That is why it
 * needs neither a golden nor an installed harness.
 */
import type { DiffReport, DiffRow } from './inventory.ts'
import { emitPlugin, type EmitOptions } from '../../dsh-anyplugin-emit/src/index.ts'
import {
  summarizeIr,
  validateIr,
  type ClaudePluginIr,
  type Fidelity,
} from '../../dsh-anyplugin-ir/src/index.ts'

const STATUS_MARK: Record<DiffRow['status'], string> = {
  match: 'ok  ',
  missing: 'MISS',
  extra: 'EXTRA',
  changed: 'DIFF',
}

export function formatDiff(report: DiffReport, options: { verbose?: boolean } = {}): string {
  const lines: string[] = []
  const { summary } = report
  lines.push(
    `inventory: ${summary.actual} observed vs ${summary.expected} expected — ` +
      `${summary.match} match, ${summary.missing} missing, ${summary.extra} extra, ${summary.changed} changed`,
  )
  if (report.pin.expected || report.pin.actual) {
    const expected = report.pin.expected ? `${report.pin.expected.tool}@${report.pin.expected.version}` : '(unpinned)'
    const actual = report.pin.actual ? `${report.pin.actual.tool}@${report.pin.actual.version}` : '(unpinned)'
    lines.push(`pin: expected ${expected}, observed ${actual}${report.pin.mismatch ? '  ← MISMATCH' : ''}`)
  }
  for (const row of report.rows) {
    if (row.status === 'match' && !options.verbose) continue
    const detail = row.detail ? `  (${row.detail})` : ''
    lines.push(`  ${STATUS_MARK[row.status]}  ${row.surface}/${row.name}${detail}`)
  }
  lines.push(report.ok ? 'result: PASS' : 'result: FAIL')
  return lines.join('\n')
}

/** One observable face of a component, mirroring `IrSkill.faces`. */
export interface ReportFace {
  face: 'model' | 'human'
  class: Fidelity
  reason: string
}

export interface ReportComponent {
  surface: string
  name: string
  /** The component's overall class — the weakest face, by the IR's rule. */
  class: Fidelity
  reason: string
  /** `model` / `human` when the IR models more than one face; empty otherwise. */
  faces: ReportFace[]
  /** True when the emitter placed the component in the entry; false when it skipped it. */
  carried: boolean
}

/**
 * What the transplant would do to one plugin, compiled fresh.
 *
 * `totals` is `summarizeIr`'s aggregation, not a recount: the report exists to
 * make that number visible, so a second arithmetic path would be a second
 * claim. `skipped` is derived as the difference because emit is the only thing
 * that can decide emittability (AGENTS §3.1).
 */
export interface TransplantReport {
  ok: boolean
  plugin: string
  pin: { tool: string; version: string }
  components: ReportComponent[]
  totals: { declared: number; emittable: number; skipped: number }
  /** Validation problems; a non-empty list is what makes the command exit non-zero. */
  problems: string[]
}

function identityKey(surface: string, name: string): string {
  return `${surface}\u0000${name}`
}

/** Identity → the faces the IR models for it. Non-command skills carry none. */
function facesByName(ir: ClaudePluginIr): Map<string, ReportFace[]> {
  const faces = new Map<string, ReportFace[]>()
  for (const skill of ir.skills) {
    if (!skill.faces) continue
    const present: ReportFace[] = [
      { face: 'model', class: skill.faces.model.fidelity, reason: skill.faces.model.reason },
    ]
    if (skill.faces.human) {
      present.push({ face: 'human', class: skill.faces.human.fidelity, reason: skill.faces.human.reason })
    }
    faces.set(identityKey('skills', skill.name), present)
  }
  return faces
}

/**
 * The components the emitter can place at all. `EmitResult.skipped` only names
 * entries whose *surface* has a materializer, so a component absent from every
 * carried surface (agents, pending themes, …) must be skipped by its absence,
 * not by its name appearing in that list.
 */
function placeableKeys(ir: ClaudePluginIr): Set<string> {
  const keys = new Set<string>()
  for (const skill of ir.skills) keys.add(identityKey('skills', skill.name))
  for (const server of ir.mcpServers) keys.add(identityKey('mcpServers', server.name))
  for (const hook of ir.hooks) keys.add(identityKey('hooks', `${hook.event}#${hook.index}`))
  return keys
}

/**
 * Compile a plugin in memory and report what the transplant decided.
 *
 * Pure with respect to the filesystem: the dialect has already read the plugin,
 * emit is pure data (AGENTS §3.3), and nothing here probes a host. That is why
 * the report can run in CI, where `DSH_INSTALL_DIR` and `claude` are absent.
 */
export function buildTransplantReport(ir: ClaudePluginIr, options: EmitOptions): TransplantReport {
  const summary = summarizeIr(ir)
  const emit = emitPlugin(ir, options)
  const carriedSurfaces = new Set(emit.emitted)
  const skippedEntries = new Set(emit.skipped)
  const faces = facesByName(ir)
  const placeable = placeableKeys(ir)

  const components: ReportComponent[] = summary.entries.map((entry) => {
    const key = identityKey(entry.surface, entry.name)
    return {
      surface: entry.surface,
      name: entry.name,
      class: entry.fidelity,
      reason: entry.reason,
      faces: faces.get(key) ?? [],
      carried:
        placeable.has(key) &&
        carriedSurfaces.has(entry.surface) &&
        !skippedEntries.has(`${entry.surface}/${entry.name}`),
    }
  })

  const problems = validateIr(ir)
  return {
    ok: problems.length === 0,
    plugin: summary.plugin,
    pin: summary.pin,
    components,
    totals: {
      declared: summary.totals.declared,
      emittable: summary.totals.emittable,
      skipped: summary.totals.declared - summary.totals.emittable,
    },
    problems,
  }
}

/**
 * `plugin: <name>  pin: <tool>@<version>`, one block per component with its
 * class, reason and faces, then the totals and validation result.
 *
 * Reasons are printed in full and unwrapped: D16/D17 make them long on
 * purpose, and a truncated reason is a report that cannot be reviewed.
 */
export function formatTransplantReport(report: TransplantReport): string {
  const lines: string[] = [`plugin: ${report.plugin}  pin: ${report.pin.tool}@${report.pin.version}`]
  if (report.components.length === 0) lines.push('  (no components)')
  for (const component of report.components) {
    lines.push('')
    lines.push(
      `${component.surface}/${component.name}  class=${component.class}  carry=${component.carried ? 'emitted' : 'skipped'}`,
    )
    lines.push(`  reason: ${component.reason}`)
    for (const face of component.faces) {
      lines.push(`  face ${face.face}=${face.class}  reason: ${face.reason}`)
    }
  }
  lines.push('')
  lines.push(
    `totals: ${report.totals.declared} declared, ${report.totals.emittable} emittable, ${report.totals.skipped} skipped`,
  )
  if (report.problems.length > 0) {
    lines.push(`problems: ${report.problems.length}`)
    for (const problem of report.problems) lines.push(`  ${problem}`)
  }
  lines.push(report.ok ? 'result: PASS' : 'result: FAIL')
  return lines.join('\n')
}
