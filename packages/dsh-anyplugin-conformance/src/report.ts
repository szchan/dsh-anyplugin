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
import { emptyGrants, gate, type Grants } from '../../dsh-anyplugin-trust/src/index.ts'

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
  /**
   * Set when the component was carried by the IR but withheld by trust, e.g.
   * `exec` for a hook with no matching grant. Distinct from `carried: false`
   * alone, which also covers "no seam". D25.
   */
  refused?: string
}

/**
 * What the transplant would do to one plugin, compiled fresh.
 *
 * `totals` is an aggregation of the component rows above it: `declared` from
 * the IR's entry list, `emitted` and `skipped` from each component's carry
 * decision. There is deliberately no second derivation — the line exists to
 * summarize what emit did, so it can never disagree with the rows (AGENTS §3.1).
 */
export interface TransplantReport {
  ok: boolean
  plugin: string
  pin: { tool: string; version: string }
  components: ReportComponent[]
  totals: { declared: number; emitted: number; refused: number; skipped: number }
  /** `validateIr` problems; a non-empty list is what makes the command exit non-zero. */
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
 * Compile a plugin in memory and report what the transplant decided.
 *
 * Pure with respect to the filesystem: the dialect has already read the plugin,
 * emit is pure data (AGENTS §3.3), and nothing here probes a host. That is why
 * the report can run in CI, where `DSH_INSTALL_DIR` and `claude` are absent.
 */
export function buildTransplantReport(
  ir: ClaudePluginIr,
  options: EmitOptions & { grants?: Grants },
): TransplantReport {
  // Trust runs before emission: refused hooks become `planned` pending nodes,
  // so the emitter cannot place them and the report can name the reason. An
  // absent store means no grants, which is the default-off state (D25).
  const gated = gate(ir, options.grants ?? emptyGrants())
  const summary = summarizeIr(gated.ir)
  const emit = emitPlugin(gated.ir, {
    materializers: options.materializers,
    ...(options.sdkRoot === undefined ? {} : { sdkRoot: options.sdkRoot }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    trusted: gated.decision.allowed,
  })
  const considered = new Set(emit.considered)
  const skippedEntries = new Set(emit.skipped)
  const refusedTargets = new Map(
    gated.decision.refused.map((refusal) => [`hooks/${refusal.target.slice('hook:'.length)}`, refusal.capability]),
  )
  const faces = facesByName(gated.ir)

  const components: ReportComponent[] = summary.entries.map((entry) => {
    const key = identityKey(entry.surface, entry.name)
    const refused = refusedTargets.get(`${entry.surface}/${entry.name}`)
    return {
      surface: entry.surface,
      name: entry.name,
      class: entry.fidelity,
      reason: entry.reason,
      faces: faces.get(key) ?? [],
      // `carried = considered minus skipped`: surfaces emit never looks at
      // (agents, output-styles, …) are neither, so the row cannot claim a
      // placement emit did not decide, as it did for `skills/legacy`.
      carried:
        considered.has(`${entry.surface}/${entry.name}`) &&
        !skippedEntries.has(`${entry.surface}/${entry.name}`),
      ...(refused === undefined ? {} : { refused }),
    }
  })

  const emitted = components.filter((component) => component.carried).length
  const refused = components.filter((component) => component.refused !== undefined).length
  const problems = validateIr(gated.ir)
  return {
    ok: problems.length === 0,
    plugin: summary.plugin,
    pin: summary.pin,
    components,
    totals: {
      declared: summary.totals.declared,
      emitted,
      refused,
      skipped: components.length - emitted - refused,
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
    const carry = component.refused === undefined ? (component.carried ? 'emitted' : 'skipped') : `refused:${component.refused}`
    lines.push(`${component.surface}/${component.name}  class=${component.class}  carry=${carry}`)
    lines.push(`  reason: ${component.reason}`)
    for (const face of component.faces) {
      lines.push(`  face ${face.face}=${face.class}  reason: ${face.reason}`)
    }
  }
  lines.push('')
  lines.push(
    `totals: ${report.totals.declared} declared, ${report.totals.emitted} emitted, ` +
      `${report.totals.refused} refused, ${report.totals.skipped} skipped`,
  )
  if (report.problems.length > 0) {
    lines.push(`problems: ${report.problems.length}`)
    for (const problem of report.problems) lines.push(`  ${problem}`)
  }
  lines.push(report.ok ? 'validation: PASS' : 'validation: FAIL')
  return lines.join('\n')
}
