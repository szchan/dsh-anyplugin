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
 */
import { isAbsolute } from 'node:path'

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin, type EntryOptions, type Materializers } from '../../dsh-anyplugin-emit/src/index.ts'
import { emptyGrants, gate, type Grants, type TrustDecision } from '../../dsh-anyplugin-trust/src/index.ts'

import type { InstallRecord, Installs } from './installs.ts'
import { validateInstalls } from './installs.ts'
import { readEnablements, resolveEnablement, type Enablements } from './enablements.ts'
import { childEntryId, pluginEntryId, pluginScope } from './identity.ts'

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
}

const SUPPORTED_DIALECT = 'claude-code'
const EXPECTED_PIN = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`

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
  const records = [...installs.plugins].sort((a, b) => {
    const left = `${a.dialect}:${a.name}`
    const right = `${b.dialect}:${b.name}`
    return left < right ? -1 : left > right ? 1 : 0
  })

  for (const record of records) {
    const enablement = resolveEnablement(`${record.dialect}:${record.name}`, layers)
    if (!enablement.enabled) continue
    try {
      const compiled = compileRecord(record, options)
      decisions.push(compiled.decision)
      if (compiled.entry) entries.push(compiled.entry)
    } catch (error) {
      problems.push({
        plugin: `${record.dialect}:${record.name}`,
        reason: (error as Error).message.replace(/^compileEntries:\s*/, ''),
      })
    }
  }
  return { entries, decisions, problems }
}

/**
 * Return one `EntryOptions` group per enabled installed plugin, in stable id
 * order. Disabled/inert plugins and plugins with no emittable surface are
 * absent rather than empty groups: there is nothing for the loader to start.
 *
 * A per-record problem fails closed here instead of being dropped: callers that
 * want to keep compiling the rest of the lock and report each problem must use
 * `compileReport`. Refused artifacts are decisions, not problems.
 */
export function compileEntries(installs: Installs, options: CompileOptions): EntryOptions[] {
  const report = compileReport(installs, options)
  if (report.problems.length > 0) {
    throw new Error(`compileEntries: ${report.problems.map((problem) => problem.reason).join('; ')}`)
  }
  return report.entries
}

function compileRecord(
  record: InstallRecord,
  options: CompileOptions,
): { entry?: EntryOptions; decision: TrustDecision } {
  const id = `${record.dialect}:${record.name}`
  if (record.dialect !== SUPPORTED_DIALECT) {
    fail(`plugin "${id}" uses unsupported dialect "${record.dialect}" (only ${SUPPORTED_DIALECT} is installed)`)
  }
  if (record.pin !== EXPECTED_PIN) {
    fail(`plugin "${id}" was installed against pin "${record.pin}", this build reads "${EXPECTED_PIN}"`)
  }
  if (!isAbsolute(record.root)) fail(`plugin "${id}" has a non-absolute root "${record.root}"`)

  const ir = readClaudePlugin(record.root, record.source === undefined ? {} : { source: record.source })
  if (ir.plugin.name !== record.name) {
    fail(`plugin "${id}" claims name "${record.name}" but ${record.root} declares "${ir.plugin.name}"`)
  }
  if (ir.pin.tool !== CLAUDE_CODE_PIN.tool || ir.pin.version !== CLAUDE_CODE_PIN.version) {
    fail(`plugin "${id}" was read at ${ir.pin.tool}@${ir.pin.version}, expected ${EXPECTED_PIN}`)
  }

  // Gate before emit: refused exec artifacts become `planned` pending nodes and
  // the emitter is given only the targets whose current hash is granted.
  const gated = gate(ir, options.grants ?? emptyGrants())
  const emitted = emitPlugin(gated.ir, {
    materializers: options.materializers,
    ...(options.sdkRoot === undefined ? {} : { sdkRoot: options.sdkRoot }),
    trusted: gated.decision.allowed,
    // The lock is the only place that knows where `${CLAUDE_PLUGIN_DATA}`
    // points: versioned artifacts get a root, data survives an update.
    dataDir: record.dataDir,
  })
  if (!emitted.entry) return { decision: gated.decision }
  const scope = pluginScope(record.dialect, record.name)
  const children = emitted.entry.config
  if (!Array.isArray(children)) fail(`plugin "${id}" emitted a group without a config array`)
  const qualified = (children as EntryOptions[]).map((child) => ({
    ...child,
    id: childEntryId(scope, child.id),
  }))
  return {
    entry: {
      ...emitted.entry,
      id: pluginEntryId(record.dialect, record.name),
      config: qualified,
    },
    decision: gated.decision,
  }
}
