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
  AGENT_FACE_KEYS,
  summarizeIr,
  validateIr,
  type ClaudePluginIr,
  type Fidelity,
} from '../../dsh-anyplugin-ir/src/index.ts'
import {
  emptyGrants,
  gate,
  type ArtifactManifest,
  type Grants,
} from '../../dsh-anyplugin-trust/src/index.ts'
import { requireRecordedMods, type InstalledMod } from '../../dsh-anyplugin-install/src/index.ts'

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

/** One observable face of a component, mirroring the IR's per-face annotations. */
export interface ReportFace {
  face: 'model' | 'human' | 'catalog' | 'invocation' | 'tools' | 'limits'
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
   * The artifact hash the grant pins, when trust allowed an exec artifact and
   * the emitter carried it. This is the hash a human consented to; the report
   * would otherwise show "emitted" without the value the gate checked.
   */
  grantedHash?: string
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
  /**
   * Mods trust allowed and emit carried, with the exact manifest the tree
   * digest was taken over. `rig install` copies this into `installs.yml`
   * (D23), so the lock records the bytes a human granted, not a second hash
   * computed later; `rig list` compares it with what the tree hashes to now.
   */
  mods: { entry: string; rootRelative: string; artifactHash: string; manifest: ArtifactManifest }[]
  /**
   * Carried mods the lock does not record (M1). Present only when the caller
   * supplied the record (`recorded`); an empty list means every carried tree
   * is backed by the lock.
   */
  notRecorded: { name: string; reason: string }[]
}

function identityKey(surface: string, name: string): string {
  return `${surface}\u0000${name}`
}

/** Identity → the faces the IR models for it. Non-command skills carry none; agents carry catalog/invocation plus optional model/tools/limits. */
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
  for (const agent of ir.agents) {
    if (!agent.faces) continue
    const present: ReportFace[] = [
      { face: 'catalog', class: agent.faces.catalog.fidelity, reason: agent.faces.catalog.reason },
      { face: 'invocation', class: agent.faces.invocation.fidelity, reason: agent.faces.invocation.reason },
    ]
    // One row per declared frontmatter key (S16); `limits` is the deprecated
    // union field an older producer may still carry.
    for (const name of AGENT_FACE_KEYS) {
      const face = agent.faces[name]
      if (face) present.push({ face: name, class: face.fidelity, reason: face.reason })
    }
    faces.set(identityKey('agents', agent.name), present)
  }
  for (const style of ir.outputStyles ?? []) {
    if (!style.faces) continue
    // The spoken half and the named half are reported separately: activation
    // can be `equivalent` while `/<plugin>:<name>` is still `planned` (D10).
    faces.set(identityKey('outputStyles', style.name), [
      { face: 'activation', class: style.faces.activation.fidelity, reason: style.faces.activation.reason },
      { face: 'command', class: style.faces.command.fidelity, reason: style.faces.command.reason },
    ])
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
  options: EmitOptions & { grants?: Grants; recorded?: readonly InstalledMod[]; exclude?: readonly string[] },
): TransplantReport {
  // Trust runs before emission: refused hooks become `planned` pending nodes,
  // so the emitter cannot place them and the report can name the reason. An
  // absent store means no grants, which is the default-off state (D25).
  const gated = gate(ir, options.grants ?? emptyGrants(), { exclude: options.exclude ?? [] })
  // The lock is the install decision (M1): a caller that holds the record
  // requires every carried tree to be in it. A grant alone is authorization,
  // not installation. Only the install path omits `recorded`, because it is
  // creating the record; every boot and list passes it.
  const recording =
    options.recorded === undefined ? { ir: gated.ir, refused: [] } : requireRecordedMods(gated.ir, options.recorded)
  const installed = recording.ir
  const summary = summarizeIr(installed)
  const emit = emitPlugin(installed, {
    materializers: options.materializers,
    ...(options.sdkRoot === undefined ? {} : { sdkRoot: options.sdkRoot }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    trusted: gated.decision.allowed,
  })
  const considered = new Set(emit.considered)
  const skippedEntries = new Set(emit.skipped)
  // A mod's report identity is `mods/<entry>`, mirroring summarizeIr's row;
  // the refusal target is `mod:<entry>`, so the two are one prefix apart.
  const refusedTargets = new Map(
    gated.decision.refused.map((refusal) =>
      refusal.target.startsWith('mod:')
        ? [`mods/${refusal.target.slice('mod:'.length)}`, refusal.capability]
        : [`hooks/${refusal.target.slice('hook:'.length)}`, refusal.capability],
    ),
  )
  const allowedTargets = new Set(gated.decision.allowed)
  const grantedHashes = new Map<string, string>()
  for (const hook of installed.hooks) {
    const target = `hook:${hook.event}#${hook.index}`
    if (hook.artifactHash !== undefined && allowedTargets.has(target)) {
      grantedHashes.set(target, hook.artifactHash)
    }
  }
  for (const mod of installed.mods ?? []) {
    if (mod.artifactHash !== undefined && allowedTargets.has(`mod:${mod.entry}`)) {
      grantedHashes.set(`mods/${mod.entry}`, mod.artifactHash)
    }
  }
  const faces = facesByName(installed)

  const components: ReportComponent[] = summary.entries.map((entry) => {
    const key = identityKey(entry.surface, entry.name)
    const refused = refusedTargets.get(`${entry.surface}/${entry.name}`)
    const grantedHash =
      entry.surface === 'hooks'
        ? grantedHashes.get(`hook:${entry.name}`)
        : entry.surface === 'mods'
          ? grantedHashes.get(`mods/${entry.name}`)
          : undefined
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
      ...(grantedHash === undefined ? {} : { grantedHash }),
      ...(refused === undefined ? {} : { refused }),
    }
  })

  const mods = (installed.mods ?? []).flatMap((mod) => {
    if (mod.artifact === undefined || mod.artifactHash === undefined) return []
    if (!allowedTargets.has(`mod:${mod.entry}`)) return []
    if (!considered.has(`mods/${mod.entry}`) || skippedEntries.has(`mods/${mod.entry}`)) return []
    return [{ entry: mod.entry, rootRelative: mod.rootRelative, artifactHash: mod.artifactHash, manifest: mod.artifact }]
  })

  const emitted = components.filter((component) => component.carried).length
  const refused = components.filter((component) => component.refused !== undefined).length
  const problems = validateIr(installed)
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
    mods,
    notRecorded: recording.refused,
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
    if (component.grantedHash !== undefined) lines.push(`  grant: ${component.grantedHash}`)
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
