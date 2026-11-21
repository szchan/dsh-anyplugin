/**
 * Compile the lock + scope replay into loader entries.
 *
 * One enabled installed plugin with an emittable surface → one group entry,
 * with children produced by
 * `emitPlugin` (AGENTS.md §3.3: there is no second emitter). Identity is the
 * only thing this layer adds: the group id is dialect-qualified and the
 * emitter's per-surface child ids are made profile-global (see identity.ts).
 *
 * A plugin whose resolved enablement is false (or that no layer mentions)
 * contributes **no entry**. It is installed in the lock, but it does not run —
 * that is what "inert" means here. Making it a disabled entry instead is not
 * possible at the group level: cordis' `Entry.disabled` getter returns false
 * for a group entry, so `disabled: true` would be accepted and ignored (S1).
 *
 * Output styles are the one selection this layer makes: the profile activation
 * record (or a plugin's `force-for-plugin`) names at most one style, and the
 * compiler places it on the plugin that owns it. Resolution happens *after*
 * every record is prepared, so a refusal can be typed against the actual IR
 * rather than guessed from the lock.
 */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { AGENT_PLUGINS_PIN, readCodexPlugin } from '../../dsh-anyplugin-dialect-codex/src/index.ts'
import { emitPlugin, type EntryOptions, type Materializers } from '../../dsh-anyplugin-emit/src/index.ts'
import { emptyGrants, gate, type Grants, type TrustDecision } from '../../dsh-anyplugin-trust/src/index.ts'

import type { InstallRecord, InstalledMod, Installs } from './installs.ts'
import { sourceText, validateInstalls } from './installs.ts'
import { readEnablements, resolveEnablement, type Enablements } from './enablements.ts'
import { childEntryId, pluginEntryId, pluginScope } from './identity.ts'
import {
  readActivation,
  resolveActivation,
  type ActivationPlugin,
  type ActivationRefusalCode,
  type ActivationResolution,
  type ActivationStyle,
  type OutputStylesFile,
} from './output-styles.ts'

// The IR type is the reader's return, not a second import of dsh-anyplugin-ir
// (R1: the install layer may depend only on the dialects, emit and trust).
type ClaudePluginIr = ReturnType<typeof readClaudePlugin>
type IrMod = NonNullable<ClaudePluginIr['mods']>[number]

export interface CompileOptions {
  /** Absolute module specifiers for the materializers this build ships. */
  materializers: Materializers
  /** SDK root handed to the emitter (MCP/Hook materializers need it). */
  sdkRoot?: string
  /**
   * The workspace whose resolved set is being materialized. Required only when
   * `enablements` is omitted and the three layer files are read here.
   */
  projectDir?: string
  /** Override for `$DSH_HOME` (tests, alternate profiles). */
  home?: string
  /** Already-read layers. When present, no file is touched. */
  enablements?: Enablements
  /**
   * Hash-pinned exec grants (D25). Absent means an empty store, so exec
   * artifacts stay off. The installer reads `grants.yml` next to
   * `installs.yml` and passes it here.
   */
  grants?: Grants
  /**
   * Already-read output-style activation record (ticket #77). Absent means
   * `readActivation` reads `$DSH_HOME/anyplugin/output-styles.yml`; a missing
   * file is no explicit activation, and a malformed one is an error at load.
   */
  activation?: OutputStylesFile
  /**
   * Require every carried mod to be recorded in the lock (D51, M1).
   *
   * The lock is the install decision. A mod the dialect can read but the lock
   * does not record must not boot: otherwise a 0.1.0/empty-known `@1` lock plus
   * a `mod:` grant runs a tree the install never recorded. **True is the
   * default**: `list`, the controller and uninstall all enforce it without
   * saying so. Only the install path (`buildTransplantReport`, which is
   * creating the record) passes `false`.
   */
  requireRecordedMods?: boolean
}

/** One carried mod the lock does not record; emitted by no path. */
export interface ModRecordingRefusal {
  plugin: string
  code: 'not-recorded'
  /** Plugin-relative entry. */
  name: string
  reason: string
}

function sameRecordedMod(mod: IrMod, record: InstalledMod): boolean {
  if (mod.entry !== record.entry || mod.rootRelative !== record.rootRelative) return false
  if (mod.artifactHash !== record.artifactHash) return false
  if (mod.artifact === undefined || mod.artifact.mode !== record.mode) return false
  if (mod.artifact.files.length !== record.files.length) return false
  const now = [...mod.artifact.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const then = [...record.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return now.every(
    (file, index) =>
      file.path === then[index]?.path && file.sha256 === then[index]?.sha256 && file.bytes === then[index]?.bytes,
  )
}

/**
 * Drop every carried mod the lock does not record (D51, M1). A grant authorizes
 * bytes; the lock records that the install saw them. A boot has neither the
 * installer UI nor a second chance to ask, so an unrecorded tree is refused
 * with a typed `not-recorded` reason and never emitted.
 */
export function requireRecordedMods(
  ir: ClaudePluginIr,
  recorded: readonly InstalledMod[],
): { ir: ClaudePluginIr; refused: { name: string; reason: string }[] } {
  if (ir.mods === undefined || ir.mods.length === 0) return { ir, refused: [] }
  const mods: IrMod[] = []
  const refused: { name: string; reason: string }[] = []
  const pending = [...ir.pending]
  for (const mod of ir.mods) {
    if (mod.artifact === undefined || mod.artifactHash === undefined) {
      mods.push(mod)
      continue
    }
    const record = recorded.find((candidate) => candidate.entry === mod.entry)
    if (record !== undefined && sameRecordedMod(mod, record)) {
      mods.push(mod)
      continue
    }
    const recordedHash = record === undefined ? undefined : record.artifactHash
    const where =
      recordedHash === undefined
        ? `no mod for this entry`
        : `the recorded tree is ${recordedHash}`
    const reason = `not-recorded: the lock does not record this module tree (entry: ${mod.entry}, granted tree: ${mod.artifactHash}; ${where}); a grant alone does not install it — reinstall so \`installs.yml\` carries the pinned tree (D51)`
    refused.push({ name: mod.entry, reason })
    pending.push({
      surface: 'mods',
      name: mod.entry,
      sourcePath: mod.sourcePath,
      annotation: { fidelity: 'planned', reason: `Not emitted: ${reason}` },
    })
  }
  return { ir: { ...ir, mods, pending }, refused }
}

/**
 * The dialect registry. A lock row names its dialect; the row owns the reader
 * and the pin that reader stamps on the IR. Adding a source agent is one row
 * here, not another branch in `prepareInstalledRecord`.
 *
 * `read` is typed as the Claude reader: both dialects return the same
 * `ClaudePluginIr`, and the point of the registry is that the install path
 * never cares which one produced it.
 */
interface DialectRegistryEntry {
  readonly pin: { tool: string; version: string }
  readonly read: typeof readClaudePlugin
}

const DIALECTS: Readonly<Record<string, DialectRegistryEntry>> = {
  'claude-code': { pin: CLAUDE_CODE_PIN, read: readClaudePlugin },
  codex: { pin: AGENT_PLUGINS_PIN, read: readCodexPlugin },
}

function fail(message: string): never {
  throw new Error(`compileEntries: ${message}`)
}

function layersFor(options: CompileOptions): Enablements {
  if (options.enablements) return options.enablements
  const projectDir = options.projectDir
  if (!projectDir) {
    fail('projectDir is required when enablements is not supplied (the scope files are read from it)')
  }
  return readEnablements({ projectDir, home: options.home })
}

export interface CompileProblem {
  plugin: string
  /** Readable reason, without the internal `compileEntries:` prefix. */
  reason: string
}

export interface CompileReport {
  /** One group per enabled plugin with at least one carried surface. */
  entries: EntryOptions[]
  /**
   * One decision per compiled plugin, including plugins that produced no
   * entry. This is where a refused exec artifact stays visible: reconcile has
   * no loader entry to report it against, and inventing a disabled one would
   * claim a surface exists.
   */
  decisions: TrustDecision[]
  /**
   * A per-record failure: unsupported dialect, pin/name mismatch, unreadable
   * plugin. One bad lock row must not abort every other installed plugin; the
   * row is reported here and the rest still compile.
   */
  problems: CompileProblem[]
  /**
   * The output-style decision for this compile. `none` and `active` are normal;
   * `refused` is typed (`unknown-plugin`, `plugin-disabled`,
   * `plugin-unreadable`, `unknown-style`, `empty-style`) and carries the trace
   * that says why no style was applied. A refusal is deliberately not a
   * `problem`: the rest of the lock still compiles, and the caller surfaces the
   * refusal instead of mistaking it for "nothing to do".
   */
  activation: ActivationResolution
}

/** A record that passed every check and can be emitted. */
export interface PreparedRecord {
  record: InstallRecord
  decision: TrustDecision
  /** The IR after the trust gate: refused exec artifacts are `pending` nodes. */
  ir: ReturnType<typeof readClaudePlugin>
  /**
   * The IR exactly as the dialect read it. Reporting gates it again, and
   * gating an already-gated IR would erase the refusal rows, so the report
   * must start from this copy rather than `ir`.
   */
  ungated: ReturnType<typeof readClaudePlugin>
}

/**
 * Read one lock record through its dialect and apply the trust gate.
 *
 * Exported because the CLI needs the same checks the controller does — a
 * record is only usable when its dialect is known, its pin matches this build,
 * its root is an absolute directory, and the artifact still calls itself by
 * the recorded name. Re-implementing those checks in the CLI would be a second
 * compiler that could disagree with this one.
 */
export function prepareInstalledRecord(
  record: InstallRecord,
  options: CompileOptions | { grants?: Grants } = {},
): PreparedRecord {
  const id = `${record.dialect}:${record.name}`
  // `record.dialect` matches the install-file identifier grammar, but
  // `constructor` is a legal identifier and also an inherited
  // `Object.prototype` key. Own-key lookup keeps the registry a closed set
  // instead of letting the prototype answer for a dialect we do not support.
  const dialect = Object.hasOwn(DIALECTS, record.dialect) ? DIALECTS[record.dialect] : undefined
  if (dialect === undefined) {
    fail(
      `plugin "${id}" uses unsupported dialect "${record.dialect}" (installed dialects: ${Object.keys(DIALECTS).join(', ')})`,
    )
  }
  const expectedPin = `${dialect.pin.tool}@${dialect.pin.version}`
  if (record.pin !== expectedPin) {
    fail(`plugin "${id}" was installed against pin "${record.pin}", this build reads "${expectedPin}"`)
  }
  if (!isAbsolute(record.root)) fail(`plugin "${id}" has a non-absolute root "${record.root}"`)
  try {
    if (!statSync(record.root).isDirectory()) {
      fail(`plugin "${id}" root ${JSON.stringify(record.root)} is not a directory`)
    }
  } catch (error) {
    if ((error as Error).message.startsWith('compileEntries:')) throw error
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    fail(`plugin "${id}" root ${JSON.stringify(record.root)} could not be read (${code}): ${(error as Error).message}`)
  }

  const ir = dialect.read(record.root, record.source === undefined ? {} : { source: sourceText(record.source) })
  if (ir.plugin.name !== record.name) {
    fail(`plugin "${id}" claims name "${record.name}" but ${record.root} declares "${ir.plugin.name}"`)
  }
  if (ir.pin.tool !== dialect.pin.tool || ir.pin.version !== dialect.pin.version) {
    fail(`plugin "${id}" was read at ${ir.pin.tool}@${ir.pin.version}, expected ${expectedPin}`)
  }

  // Gate before emit: refused exec artifacts become `planned` pending nodes and
  // the emitter is given only the targets whose current hash is granted.
  // The data directory is written by the host after the plugin starts, so it
  // is not part of the artifact (D51); the loader's scan makes the same
  // exclusion, or the digest would move the first time a mod writes data.
  const gated = gate(ir, options.grants ?? emptyGrants(), { exclude: [record.dataDir] })
  // Safe by default (M2): an omitted flag still enforces the record. The one
  // caller that may skip it is the install path, which is writing that record.
  if (options.requireRecordedMods === false) {
    return { record, decision: gated.decision, ir: gated.ir, ungated: ir, refusals: [] }
  }
  const recorded = requireRecordedMods(gated.ir, record.mods ?? [])
  return {
    record,
    decision: gated.decision,
    ir: recorded.ir,
    ungated: ir,
    refusals: recorded.refused.map((refusal) => ({ plugin: id, code: 'not-recorded' as const, ...refusal })),
  }
}

function activationStyle(style: {
  name: string
  description?: string
  body: string
  keepCodingInstructions?: boolean
  forceForPlugin?: boolean
}): ActivationStyle {
  return {
    name: style.name,
    ...(style.description === undefined ? {} : { description: style.description }),
    body: style.body,
    ...(style.keepCodingInstructions === undefined ? {} : { keepCodingInstructions: style.keepCodingInstructions }),
    ...(style.forceForPlugin === undefined ? {} : { forceForPlugin: style.forceForPlugin }),
  }
}

/**
 * Compile the lock and retain the trust decisions alongside the entries.
 *
 * `compileEntries` returns only `entries`; the install path calls this when it
 * needs to surface refusals rather than treat them as "nothing to do".
 */
export function compileReport(installs: Installs, options: CompileOptions): CompileReport {
  validateInstalls(installs)
  if (!options.materializers || typeof options.materializers.skill !== 'string') {
    fail('materializers.skill is required')
  }
  const layers = layersFor(options)
  const entries: EntryOptions[] = []
  const decisions: TrustDecision[] = []
  const problems: CompileProblem[] = []
  const refusals: ModRecordingRefusal[] = []
  const prepared: PreparedRecord[] = []
  const activationPlugins: ActivationPlugin[] = []
  const records = [...installs.plugins].sort((a, b) => {
    const left = `${a.dialect}:${a.name}`
    const right = `${b.dialect}:${b.name}`
    return left < right ? -1 : left > right ? 1 : 0
  })

  for (const record of records) {
    const id = `${record.dialect}:${record.name}`
    const enablement = resolveEnablement(id, layers)
    if (!enablement.enabled) {
      // Disabled plugins are still named to the resolver: an explicit record
      // that names one is a `plugin-disabled` refusal, not `unknown-plugin`.
      activationPlugins.push({ name: record.name, enabled: false })
      continue
    }
    try {
      const compiled = prepareInstalledRecord(record, options)
      prepared.push(compiled)
      decisions.push(compiled.decision)
      refusals.push(...compiled.refusals)
      activationPlugins.push({
        name: record.name,
        enabled: true,
        styles: (compiled.ir.outputStyles ?? []).map(activationStyle),
      })
    } catch (error) {
      const reason = (error as Error).message.replace(/^compileEntries:\s*/, '')
      problems.push({ plugin: id, reason })
      // An enabled record that failed to prepare is `plugin-unreadable`, not
      // `unknown-plugin`: the lock row exists, its IR just could not be read.
      activationPlugins.push({ name: record.name, enabled: true, problem: reason })
    }
  }

  // Read the record only after every preparation, so resolution can name the
  // actual styles. A malformed file throws here, at load: there is no silent
  // "no style" path.
  const activation = resolveActivation(activationPlugins, options.activation ?? readActivation({ home: options.home }))

  for (const record of prepared) {
    const selected = activation.kind === 'active' && activation.plugin === record.record.name
      ? {
          plugin: activation.plugin,
          name: activation.style.name,
          ...(activation.style.description === undefined ? {} : { description: activation.style.description }),
          body: activation.style.body,
          ...(activation.style.keepCodingInstructions === undefined ? {} : { keepCodingInstructions: activation.style.keepCodingInstructions }),
          ...(activation.style.forceForPlugin === undefined ? {} : { forceForPlugin: activation.style.forceForPlugin }),
          // Ticket #77: only an explicit `false` replaces the prompt; an absent
          // key appends, so the host's coding instructions stay.
          complete: activation.style.keepCodingInstructions === false,
          source: activation.source,
          trace: activation.trace,
        }
      : undefined
    const emitted = emitPlugin(record.ir, {
      materializers: options.materializers,
      ...(options.sdkRoot === undefined ? {} : { sdkRoot: options.sdkRoot }),
      trusted: record.decision.allowed,
      // The lock is the only place that knows where `${CLAUDE_PLUGIN_DATA}`
      // points: versioned artifacts get a root, data survives an update.
      dataDir: record.record.dataDir,
      ...(selected === undefined ? {} : { outputStyle: selected }),
    })
    if (!emitted.entry) continue
    const scope = pluginScope(record.record.dialect, record.record.name)
    const children = emitted.entry.config
    if (!Array.isArray(children)) fail(`plugin "${record.record.dialect}:${record.record.name}" emitted a group without a config array`)
    const qualified = (children as EntryOptions[]).map((child) => ({
      ...child,
      id: childEntryId(scope, child.id),
    }))
    entries.push({
      ...emitted.entry,
      id: pluginEntryId(record.record.dialect, record.record.name),
      config: qualified,
    })
  }

  return { entries, decisions, problems, refusals, activation }
}

/**
 * Return one `EntryOptions` group per enabled installed plugin, in stable id
 * order. Disabled/inert plugins and plugins with no emittable surface are
 * absent rather than empty groups: there is nothing for the loader to start.
 *
 * A per-record problem fails closed here instead of being dropped: callers that
 * want to keep compiling the rest of the lock and report each problem must use
 * `compileReport`. Refused artifacts are decisions, not problems. A refused
 * output-style activation is likewise not a problem — it is returned on
 * `compileReport().activation` — so this function's behaviour for a bad
 * activation record is unchanged: no style child, no throw.
 */
export class OutputStyleActivationError extends Error {
  readonly code: ActivationRefusalCode
  readonly requested: string
  readonly trace: string

  constructor(activation: Extract<ActivationResolution, { kind: 'refused' }>) {
    super(
      `compileEntries: output style activation ${JSON.stringify(activation.requested)} was refused (${activation.code}): ${activation.reason}`,
    )
    this.name = 'OutputStyleActivationError'
    this.code = activation.code
    this.requested = activation.requested
    this.trace = activation.trace
  }
}

export function compileEntries(installs: Installs, options: CompileOptions): EntryOptions[] {
  const report = compileReport(installs, options)
  if (report.problems.length > 0) {
    throw new Error(`compileEntries: ${report.problems.map((problem) => problem.reason).join('; ')}`)
  }
  // A refused activation is a configuration error, not "nothing to do": the
  // convenience path fails closed so a bad record cannot silently compile the
  // lock without the style the operator asked for. Callers that must keep
  // compiling use `compileReport` and read `activation` themselves.
  if (report.activation.kind === 'refused') throw new OutputStyleActivationError(report.activation)
  return report.entries
}
