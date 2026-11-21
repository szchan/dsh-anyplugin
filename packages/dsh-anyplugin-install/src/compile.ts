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

import type { InstallRecord, Installs } from './installs.ts'
import { validateInstalls } from './installs.ts'
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
}

/**
 * The dialect registry. A lock row names its dialect; the row owns the reader
 * and the pin that reader stamps on the IR. Adding a source agent is one row
 * here, not another branch in `prepareRecord`.
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
interface PreparedRecord {
  record: InstallRecord
  decision: TrustDecision
  ir: ReturnType<typeof readClaudePlugin>
}

function prepareRecord(record: InstallRecord, options: CompileOptions): PreparedRecord {
  const id = `${record.dialect}:${record.name}`
  const dialect = DIALECTS[record.dialect]
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

  const ir = dialect.read(record.root, record.source === undefined ? {} : { source: record.source })
  if (ir.plugin.name !== record.name) {
    fail(`plugin "${id}" claims name "${record.name}" but ${record.root} declares "${ir.plugin.name}"`)
  }
  if (ir.pin.tool !== dialect.pin.tool || ir.pin.version !== dialect.pin.version) {
    fail(`plugin "${id}" was read at ${ir.pin.tool}@${ir.pin.version}, expected ${expectedPin}`)
  }

  // Gate before emit: refused exec artifacts become `planned` pending nodes and
  // the emitter is given only the targets whose current hash is granted.
  const gated = gate(ir, options.grants ?? emptyGrants())
  return { record, decision: gated.decision, ir: gated.ir }
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
      const compiled = prepareRecord(record, options)
      prepared.push(compiled)
      decisions.push(compiled.decision)
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

  return { entries, decisions, problems, activation }
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
