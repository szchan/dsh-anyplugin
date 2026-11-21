/**
 * The lifecycle commands (`install`, `list`, `enable`, `disable`, `uninstall`)
 * as data in and data out. `rig.ts` parses argv; this module owns the reads,
 * the refusals and the two writes.
 *
 * Three rules shape it:
 *
 * 1. There is exactly one writer per store. The lock goes through
 *    `writeInstalls`, one scope layer goes through `writeEnablements`. This
 *    module never formats YAML of its own.
 * 2. Reporting is the report path. Counts come from `buildTransplantReport`,
 *    the same rows `rig report` prints, so `list` and `report` cannot disagree.
 * 3. A refusal is typed and happens before a write. `--dry-run` runs the same
 *    plan and skips only the two `write*` calls, so the diff it prints is the
 *    diff a real run would apply.
 *
 * Enablement is a per-workspace fact (D2): the record says a plugin is
 * installed, a layer says whether it runs here. `disable` therefore edits the
 * layer, never the lock, and `uninstall` removes the lock row while leaving
 * the layers alone — a workspace's policy outlives a reinstall.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { readCodexPlugin } from '../../dsh-anyplugin-dialect-codex/src/index.ts'
import {
  defaultMaterializers,
  type Materializers,
} from '../../dsh-anyplugin-emit/src/index.ts'
import type { ClaudePluginIr } from '../../dsh-anyplugin-ir/src/index.ts'
import {
  GrantsFileError,
  grantsPath,
  readGrants,
  type Grants,
} from '../../dsh-anyplugin-trust/src/index.ts'
import {
  INSTALLS_SCHEMA,
  InstallsFileError,
  SCOPES,
  compileReport,
  enablementPaths,
  prepareInstalledRecord,
  readEnablements,
  readInstalls,
  resolveEnablement,
  serializeEnablements,
  serializeInstalls,
  sourceText,
  validateInstalls,
  writeEnablements,
  writeInstalls,
  type EnablementLayer,
  type Enablements,
  type InstalledMod,
  type InstallRecord,
  type InstallSource,
  type Installs,
  type ResolvedEnablement,
  type Scope,
} from '../../dsh-anyplugin-install/src/index.ts'
import { buildTransplantReport, type TransplantReport } from './report.ts'

/** A lifecycle refusal. `reason` is what to print; `code` is what to branch on. */
export type InstallCliCode =
  | 'unknown-dialect'
  | 'unreadable-directory'
  | 'unreadable-plugin'
  | 'missing-version'
  | 'invalid-version'
  | 'name-mismatch'
  | 'nothing-declared'
  | 'nothing-emitted'
  | 'invalid-plugin'
  | 'cross-root'
  | 'record-differs'
  | 'corrupt-lock'
  | 'corrupt-enablement'
  | 'corrupt-grants'
  | 'unreadable-lock'
  | 'unreadable-enablement'
  | 'unreadable-grants'
  | 'unknown-plugin'
  | 'ambiguous-plugin'
  | 'invalid-record'
  | 'unreadable-marketplace'
  | 'malformed-marketplace'
  | 'malformed-marketplace-entry'
  | 'unknown-marketplace-entry'
  | 'ambiguous-marketplace-entry'
  | 'unsupported-marketplace-source'
  | 'marketplace-entry-not-available'
  | 'marketplace-path-escape'
  | 'write-failed'

export class InstallCliError extends Error {
  readonly code: InstallCliCode
  readonly hint?: string

  constructor(code: InstallCliCode, reason: string, hint?: string) {
    super(reason)
    this.name = 'InstallCliError'
    this.code = code
    if (hint !== undefined) this.hint = hint
  }
}

/** The four paths every command resolves the same way. */
export interface InstallCliPaths {
  installs: string
  grants: string
  home: string
  projectDir: string
  /**
   * How `--config` was spelled. A relative path is only valid from the cwd
   * that holds it; read-only commands refuse a missing relative target
   * instead of reporting an empty lock from the wrong directory.
   */
  config?: { requested: string; relative: boolean }
}

export interface PathOptions {
  config?: string
  home?: string
  projectDir?: string
}

export function installCliPaths(options: PathOptions = {}): InstallCliPaths {
  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const installs = resolve(options.config ?? join(home, 'anyplugin', 'installs.yml'))
  return {
    installs,
    grants: grantsPath(installs),
    home,
    projectDir: resolve(options.projectDir ?? process.cwd()),
    ...(options.config === undefined
      ? {}
      : { config: { requested: options.config, relative: !isAbsolute(options.config) } }),
  }
}

interface LifecycleState {
  installs: Installs
  layers: Enablements
  grants: Grants
  paths: InstallCliPaths
}

function lift(
  corrupt: InstallCliCode,
  unreadable: InstallCliCode,
  file: string,
  error: unknown,
): InstallCliError {
  if (error instanceof InstallCliError) return error
  if (error instanceof InstallsFileError || error instanceof GrantsFileError) {
    // The parser's message already names the file and line; keep it verbatim.
    return new InstallCliError(corrupt, error.message)
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new InstallCliError(unreadable, `cannot read ${file}: ${detail}`)
}

function readLifecycle(
  paths: InstallCliPaths,
  options: { allowMissingConfig?: boolean } = {},
): LifecycleState {
  if (paths.config?.relative === true && !existsSync(paths.installs) && options.allowMissingConfig !== true) {
    throw new InstallCliError(
      'unreadable-lock',
      `${paths.installs}: --config "${paths.config.requested}" is relative and does not exist`,
      'run from the directory that holds it, or pass an absolute --config path',
    )
  }
  let installs: Installs
  try {
    installs = readInstalls(paths.installs)
  } catch (error) {
    throw lift('corrupt-lock', 'unreadable-lock', paths.installs, error)
  }
  let layers: Enablements
  try {
    layers = readEnablements({ projectDir: paths.projectDir, home: paths.home })
  } catch (error) {
    throw lift('corrupt-enablement', 'unreadable-enablement', paths.projectDir, error)
  }
  let grants: Grants
  try {
    grants = readGrants(paths.grants)
  } catch (error) {
    throw lift('corrupt-grants', 'unreadable-grants', paths.grants, error)
  }
  return { installs, layers, grants, paths }
}

const READERS = {
  'claude-code': readClaudePlugin,
  codex: readCodexPlugin,
} as const

export type InstallDialect = keyof typeof READERS

/**
 * The dialect a directory declares. The manifest location is the declaration;
 * a directory with none is read as Claude so manifest-less fixtures keep
 * working, exactly like `rig report`'s reader selection.
 */
export function detectDialect(pluginDir: string): InstallDialect {
  if (existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))) return 'claude-code'
  if (existsSync(join(pluginDir, 'plugin.json')) || existsSync(join(pluginDir, '.codex-plugin', 'plugin.json'))) {
    return 'codex'
  }
  return 'claude-code'
}

function selectDialect(requested: string | undefined, pluginDir: string): InstallDialect {
  if (requested === undefined) return detectDialect(pluginDir)
  if (!Object.hasOwn(READERS, requested)) {
    throw new InstallCliError(
      'unknown-dialect',
      `unknown dialect "${requested}"; this build reads ${Object.keys(READERS).join(', ')}`,
    )
  }
  return requested as InstallDialect
}

function sourceLabel(root: string): string {
  const rel = relative(process.cwd(), root)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? `plugin-dir:${rel}` : `plugin-dir:${root}`
}

function identity(record: { dialect: string; name: string }): string {
  return `${record.dialect}:${record.name}`
}

/**
 * The lock's copy of the exec pin: the manifest trust hashed at install time,
 * with plugin-relative paths, so `hashManifest({mode, invocation: entry, command: '',
 * files})` recomputes `artifactHash` without touching the plugin again.
 */
function recordedMods(report: TransplantReport): InstalledMod[] {
  return report.mods.map((mod) => {
    if (mod.manifest.mode !== 'file' && mod.manifest.mode !== 'composite') {
      throw new InstallCliError('invalid-record', `${mod.entry}: a mod artifact is a tree, not ${mod.manifest.mode}`)
    }
    return {
      entry: mod.entry,
      rootRelative: mod.rootRelative,
      mode: mod.manifest.mode,
      artifactHash: mod.artifactHash,
      files: mod.manifest.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
    }
  })
}

/** Short, diffable description of a record's mod set for `record-differs`. */
function describeMods(mods: InstalledMod[] | undefined): string {
  if (mods === undefined || mods.length === 0) return 'none'
  return mods.map((mod) => `${mod.entry} (${mod.mode}, ${mod.files.length} file(s), ${mod.artifactHash})`).join(', ')
}

function totalsLine(totals: TransplantReport['totals']): string {
  return `${totals.declared} declared, ${totals.emitted} emitted, ${totals.refused} refused, ${totals.skipped} skipped`
}

/** The exact canonical lines for one record, without the schema or siblings. */
function recordLines(record: InstallRecord): string[] {
  const text = serializeInstalls({ schema: INSTALLS_SCHEMA, plugins: [record] })
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('  - dialect:'))
  if (start < 0) return []
  const end = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  return lines.slice(start, end)
}

function recordDiff(before: InstallRecord | undefined, after: InstallRecord): string[] {
  const added = recordLines(after).map((line) => `+ ${line}`)
  if (before === undefined) return added
  return [...recordLines(before).map((line) => `- ${line}`), ...added]
}

/** `enable`/`disable` never invent a narrower scope; they edit the one that decides. */
export function decidingScope(id: string, layers: Enablements): Scope | null {
  for (const scope of SCOPES) {
    if (layers[scope]?.plugins[id] !== undefined) return scope
  }
  return null
}

function nextLayer(
  layers: Enablements,
  scope: Scope,
  id: string,
  enabled: boolean,
): { layer: EnablementLayer; changed: boolean; previous?: boolean } {
  const current = layers[scope] ?? { plugins: {} }
  const existing = current.plugins[id]
  if (existing !== undefined && existing.enabled === enabled) {
    return { layer: current, changed: false, previous: existing.enabled }
  }
  const entry = { enabled, grants: existing?.grants ?? [] }
  return {
    layer: { plugins: { ...current.plugins, [id]: entry } },
    changed: true,
    ...(existing === undefined ? {} : { previous: existing.enabled }),
  }
}

/** The exact canonical line for one entry, so the printed diff is the written diff. */
function layerEntryLine(layer: EnablementLayer, id: string): string | undefined {
  return serializeEnablements(layer)
    .split('\n')
    .find((line) => line.trimStart().startsWith(`${id}:`))
}

export function resolvePluginArgument(argument: string, installs: Installs): InstallRecord {
  const known = installs.plugins.map(identity)
  if (installs.plugins.length === 0) {
    throw new InstallCliError(
      'unknown-plugin',
      `no installed plugin "${argument}"; the lock is empty`,
      'run `rig install <plugin-dir>` first',
    )
  }
  const colon = argument.indexOf(':')
  if (colon >= 0) {
    const dialect = argument.slice(0, colon)
    const name = argument.slice(colon + 1)
    const found = installs.plugins.find((record) => record.dialect === dialect && record.name === name)
    if (found) return found
    throw new InstallCliError('unknown-plugin', `no installed plugin "${argument}"; known: ${known.join(', ')}`)
  }
  const matches = installs.plugins.filter((record) => record.name === argument)
  if (matches.length === 0) {
    throw new InstallCliError('unknown-plugin', `no installed plugin named "${argument}"; known: ${known.join(', ')}`)
  }
  if (matches.length > 1) {
    throw new InstallCliError(
      'ambiguous-plugin',
      `"${argument}" is installed under ${matches.map(identity).join(', ')}; name it as <dialect>:<name>`,
    )
  }
  return matches[0]
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface InstallOptions extends PathOptions {
  pluginDir: string
  /** Enablement scope written when the layer does not mention the plugin yet. */
  scope?: Scope
  dialect?: string
  /** Assertion only: the artifact's own name must equal this. */
  name?: string
  /** Replace a record this identity already owns (different root or fields). */
  force?: boolean
  /** Record a plugin whose compile emits nothing (all components refused). */
  allowEmpty?: boolean
  /**
   * Replace a recorded module set. A reinstall without a `mod:` grant (or with
   * a different tree) would otherwise drop or swap the lock's `mods` record
   * silently, which is outside D49's root/version/dataDir scope: the install
   * names the missing grant and needs this flag, or `uninstall`, to proceed.
   */
  dropMods?: boolean
  dryRun?: boolean
  /**
   * Provenance override. A marketplace install passes the catalog identity so
   * the lock can say where the record came from; a plain directory install
   * leaves it undefined and gets `plugin-dir:<path>`.
   */
  source?: InstallSource
  materializers?: Materializers
}

export interface InstallResult {
  ok: true
  plugin: string
  action: 'added' | 'updated' | 'unchanged'
  dryRun: boolean
  wrote: boolean
  record: InstallRecord
  lockFile: string
  lockBefore: number
  lockAfter: number
  /** `+`/`-` lines of the canonical record block; empty when unchanged. */
  lockDiff: string[]
  enablement: {
    scope: Scope
    file: string
    state: 'written' | 'would-write' | 'kept'
  }
  effective: ResolvedEnablement
  report: TransplantReport
  warning?: string
}

export function installPlugin(options: InstallOptions): InstallResult {
  const paths = installCliPaths(options)
  const materializers = options.materializers ?? defaultMaterializers()
  const dryRun = options.dryRun === true
  const scope = options.scope ?? 'user'
  if (!SCOPES.includes(scope)) {
    throw new InstallCliError('invalid-record', `--scope must be one of ${SCOPES.join(', ')}`)
  }
  // `install` may create a relative `--config`; every other command treats a
  // missing relative target as a wrong-directory error.
  const state = readLifecycle(paths, { allowMissingConfig: true })

  const root = resolve(options.pluginDir)
  let stat
  try {
    stat = statSync(root)
  } catch (error) {
    throw new InstallCliError(
      'unreadable-directory',
      `${root}: ${(error as Error).message}`,
      'pass a directory that exists and contains a plugin manifest',
    )
  }
  if (!stat.isDirectory()) {
    throw new InstallCliError('unreadable-directory', `${root} is not a directory`)
  }

  const dialect = selectDialect(options.dialect, root)
  const source = options.source ?? sourceLabel(root)
  let ir: ClaudePluginIr
  try {
    ir = READERS[dialect](root, { source: sourceText(source) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new InstallCliError('unreadable-plugin', `${root}: ${detail}`)
  }

  const name = ir.plugin.name
  if (options.name !== undefined && options.name !== name) {
    throw new InstallCliError(
      'name-mismatch',
      `--name "${options.name}" does not match the plugin name "${name}" that ${root} declares`,
      '--name asserts the artifact identity; it does not rename a record',
    )
  }
  const version = ir.plugin.version
  if (version === undefined || version.trim() === '') {
    throw new InstallCliError(
      'missing-version',
      `${identity({ dialect, name })} declares no version; installs.yml requires one`,
      'add "version" to the plugin manifest and install again',
    )
  }
  if (/\s/.test(version)) {
    throw new InstallCliError('invalid-version', `version "${version}" contains whitespace`)
  }

  const record: InstallRecord = {
    dialect,
    name,
    version,
    root,
    dataDir: join(dirname(paths.installs), 'data', dialect, name),
    pin: `${ir.pin.tool}@${ir.pin.version}`,
    source,
  }
  const id = identity(record)

  const report = buildTransplantReport(ir, { materializers, grants: state.grants })
  if (report.problems.length > 0) {
    throw new InstallCliError('invalid-plugin', `${id}: ${report.problems.join('; ')}`)
  }
  if (report.totals.declared === 0) {
    throw new InstallCliError(
      'nothing-declared',
      `${id}: the plugin declares no components, so there is nothing to install`,
      'add a skill, agent, hook, MCP server, command or output style to the plugin',
    )
  }
  if (report.totals.emitted === 0 && options.allowEmpty !== true) {
    const refused = report.components
      .filter((component) => component.refused !== undefined)
      .map((component) =>
        `${component.surface}/${component.name} refused:${component.refused}` +
        ` (${component.reason.replace(/^Not emitted:\\s*/, '')})`)
    throw new InstallCliError(
      'nothing-emitted',
      `${id}: nothing would be emitted (${totalsLine(report.totals)})${refused.length === 0 ? '' : `; ${refused.join(', ')}`}`,
      'pass --allow-empty to record an inert plugin, or grant the refused artifacts with `rig grant`',
    )
  }

  // Only a mod the gate allowed and emit carried becomes a lock record: an
  // ungranted tree is not "installed but inert", it is not installed at all.
  const mods = recordedMods(report)
  if (mods.length > 0) record.mods = mods

  const existing = state.installs.plugins.find((candidate) => identity(candidate) === id)
  let action: InstallResult['action']
  if (existing === undefined) {
    action = 'added'
  } else {
    const modsSame = JSON.stringify(existing.mods ?? []) === JSON.stringify(record.mods ?? [])
    const otherSame =
      existing.root === record.root &&
      existing.version === record.version &&
      existing.pin === record.pin &&
      existing.dataDir === record.dataDir
    const same = otherSame && modsSame
    action = same ? 'unchanged' : 'updated'
    if (!modsSame && options.dropMods !== true) {
      const dropped = (existing.mods ?? []).length > 0 && (record.mods ?? []).length === 0
      const help = dropped
        ? 'the install has no granted module tree, so it would drop the recorded one; grant the tree and reinstall, pass --drop-mods, or uninstall first'
        : 'grant the new tree and reinstall, pass --drop-mods, or uninstall first'
      throw new InstallCliError(
        'record-differs',
        `"${id}" is already recorded at ${existing.root} with a different module set (${describeMods(existing.mods)} → ${describeMods(record.mods)})`,
        help,
      )
    }
    if (!same && options.force !== true && !(otherSame && options.dropMods === true)) {
      if (existing.root !== record.root) {
        throw new InstallCliError(
          'cross-root',
          `"${id}" is already installed from ${existing.root}; refusing to repoint it to ${record.root}`,
          '--force replaces the record',
        )
      }
      const changed: string[] = []
      if (existing.version !== record.version) changed.push(`version ${existing.version} → ${record.version}`)
      if (existing.pin !== record.pin) changed.push(`pin ${existing.pin} → ${record.pin}`)
      if (existing.dataDir !== record.dataDir) changed.push(`dataDir ${existing.dataDir} → ${record.dataDir}`)
      if (!modsSame) changed.push(`mods ${describeMods(existing.mods)} → ${describeMods(record.mods)}`)
      throw new InstallCliError(
        'record-differs',
        `"${id}" is already recorded at ${existing.root} with a different ${changed.join(', ')}`,
        '--force replaces the record',
      )
    }
  }

  const plugins = state.installs.plugins.filter((candidate) => identity(candidate) !== id)
  const nextInstalls: Installs = { schema: INSTALLS_SCHEMA, plugins: [...plugins, record] }
  if (action !== 'unchanged') {
    try {
      validateInstalls(nextInstalls)
    } catch (error) {
      throw lift('invalid-record', 'invalid-record', paths.installs, error)
    }
  }

  const layerPaths = enablementPaths({ projectDir: paths.projectDir, home: paths.home })
  const enablementFile = layerPaths[scope]
  // A layer that already mentions the id owns the decision, including an
  // explicit `enabled: false`. Reinstalling must not flip it back on and call
  // that "nothing written"; only an absent mention is filled in.
  const mentioned = state.layers[scope]?.plugins[id]
  const planned =
    mentioned === undefined
      ? nextLayer(state.layers, scope, id, true)
      : { layer: state.layers[scope] ?? { plugins: {} }, changed: false, previous: mentioned.enabled }
  const effectiveLayers: Enablements = { ...state.layers, [scope]: planned.layer }
  const effective = resolveEnablement(id, effectiveLayers)
  const enablementState = planned.changed ? (dryRun ? 'would-write' : 'written') : 'kept'

  if (!dryRun && action !== 'unchanged') {
    try {
      writeInstalls(paths.installs, nextInstalls)
    } catch (error) {
      throw new InstallCliError('write-failed', `could not write ${paths.installs}: ${(error as Error).message}`)
    }
  }
  if (!dryRun && planned.changed) {
    try {
      writeEnablements(enablementFile, planned.layer)
    } catch (error) {
      const recordState = action === 'unchanged' ? 'the lock was unchanged' : 'the lock was written'
      throw new InstallCliError(
        'write-failed',
        `${recordState}, but ${enablementFile} could not be written: ${(error as Error).message}`,
      )
    }
  }

  const warning =
    effective.enabled === true
      ? undefined
      : `effective: disabled${effective.scope === null ? '' : ` at ${effective.scope}`}; ${id} is recorded but will not run until that layer changes`

  return {
    ok: true,
    plugin: id,
    action,
    dryRun,
    wrote: !dryRun && (action !== 'unchanged' || planned.changed),
    record,
    lockFile: paths.installs,
    lockBefore: state.installs.plugins.length,
    lockAfter: nextInstalls.plugins.length,
    lockDiff: action === 'unchanged' ? [] : recordDiff(action === 'updated' ? existing : undefined, record),
    enablement: { scope, file: enablementFile, state: enablementState },
    effective,
    report,
    ...(warning === undefined ? {} : { warning }),
  }
}

export function formatInstall(result: InstallResult): string {
  const lines: string[] = []
  const suffix = result.dryRun ? ' (dry run — nothing written)' : ''
  if (result.action === 'unchanged') {
    lines.push(`install ${result.plugin}: already installed; nothing written${suffix ? ' (dry run)' : ''}`)
  } else {
    lines.push(`install ${result.plugin}: ${result.action}${suffix}`)
  }
  lines.push(`  root: ${result.record.root}`)
  lines.push(`  version: ${result.record.version}  pin: ${result.record.pin}`)
  for (const mod of result.record.mods ?? []) {
    lines.push(`  mod: ${mod.entry} (${mod.mode}, ${mod.files.length} file${mod.files.length === 1 ? '' : 's'}) ${mod.artifactHash}`)
  }
  lines.push(`  report: ${totalsLine(result.report.totals)}`)
  const enablement =
    result.enablement.state === 'kept'
      ? `${result.enablement.scope} already mentions it; left as is`
      : `${result.enablement.scope} ${result.enablement.state === 'written' ? 'written' : 'would be written'} (enabled: true)`
  lines.push(`  enablement: ${enablement}`)
  lines.push(`  lock: ${result.lockFile} (${result.lockAfter} plugin${result.lockAfter === 1 ? '' : 's'})`)
  // A mod record carries its whole tree manifest (diff: ~1800 lines). The
  // lock is the place to read it; the terminal summary stays readable.
  const shown = result.lockDiff.slice(0, 12)
  for (const line of shown) lines.push(`  ${line}`)
  if (result.lockDiff.length > shown.length) {
    lines.push(`  … ${result.lockDiff.length - shown.length} more lock line(s) in ${result.lockFile}`)
  }
  if (result.warning !== undefined) lines.push(`  WARNING: ${result.warning}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListOptions extends PathOptions {
  materializers?: Materializers
}

export interface ListedPlugin {
  id: string
  dialect: string
  name: string
  version: string
  root: string
  dataDir: string
  pin: string
  source?: InstallSource
  /** Every layer that explicitly turns it on, narrowest first. */
  enabledScopes: Scope[]
  /** Hash-pinned grants still stored for this identity (D25). */
  grants: number
  /** Mods the lock records, with the manifest trust pinned at install (D23). */
  mods: InstalledMod[]
  effective: ResolvedEnablement
  report?: TransplantReport
  error?: { code: 'record-unusable'; reason: string }
}

export interface ListResult {
  ok: boolean
  file: string
  plugins: ListedPlugin[]
}

export function listPlugins(options: ListOptions = {}): ListResult {
  const paths = installCliPaths(options)
  const materializers = options.materializers ?? defaultMaterializers()
  const state = readLifecycle(paths)
  const records = [...state.installs.plugins].sort((left, right) =>
    identity(left) < identity(right) ? -1 : identity(left) > identity(right) ? 1 : 0,
  )

  const plugins: ListedPlugin[] = records.map((record) => {
    const id = identity(record)
    const enabledScopes = SCOPES.filter((scope) => state.layers[scope]?.plugins[id]?.enabled === true)
    const base = {
      id,
      dialect: record.dialect,
      name: record.name,
      version: record.version,
      root: record.root,
      dataDir: record.dataDir,
      pin: record.pin,
      ...(record.source === undefined ? {} : { source: record.source }),
      enabledScopes,
      grants: state.grants.grants.filter((grant) => grant.plugin === id).length,
      mods: record.mods ?? [],
      effective: resolveEnablement(id, state.layers),
    }
    try {
      const prepared = prepareInstalledRecord(record, { grants: state.grants })
      const report = buildTransplantReport(prepared.ungated, {
        materializers,
        grants: state.grants,
        // The lock is the install decision (M1): a 0.1-style record that
        // grants a tree still boots nothing until the tree is in the record.
        recorded: record.mods ?? [],
      })
      return { ...base, report }
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/^compileEntries:\s*/, '')
      return { ...base, error: { code: 'record-unusable', reason } }
    }
  })

  return {
    ok: plugins.every((plugin) => plugin.error === undefined && plugin.report?.ok !== false),
    file: paths.installs,
    plugins,
  }
}

export function formatList(result: ListResult): string {
  const count = result.plugins.length
  const lines = [`installs: ${result.file} (${count === 0 ? 'empty' : `${count} plugin${count === 1 ? '' : 's'}`})`]
  for (const plugin of result.plugins) {
    lines.push('')
    lines.push(`${plugin.id}  ${plugin.version}`)
    lines.push(`  root: ${plugin.root}`)
    lines.push(`  pin: ${plugin.pin}`)
    const scopes = plugin.enabledScopes.length === 0 ? 'none' : plugin.enabledScopes.join(', ')
    const effective =
      plugin.effective.scope === null
        ? 'inert (no layer mentions it)'
        : `${plugin.effective.enabled ? 'enabled' : 'disabled'} at ${plugin.effective.scope}`
    lines.push(`  enabled scopes: ${scopes}; effective: ${effective}`)
    lines.push(`  grants: ${plugin.grants} retained`)
    // What the lock records, with the drift the current tree implies.
    for (const mod of plugin.mods) {
      const component = plugin.report?.components.find(
        (candidate) => candidate.surface === 'mods' && candidate.name === mod.entry,
      )
      const drift =
        component === undefined
          ? ''
          : component.grantedHash !== undefined && component.grantedHash !== mod.artifactHash
            ? `  ← recorded pin is stale; the granted tree is now ${component.grantedHash}`
            : component.grantedHash === undefined
              ? `  ← no grant now, so the lock will not carry it`
              : ''
      lines.push(`  mod: ${mod.entry} (${mod.mode}, ${mod.files.length} file${mod.files.length === 1 ? '' : 's'}) ${mod.artifactHash}${drift}`)
    }
    // What the current tree + grants would actually emit (M1). A recorded mod
    // is listed above; this is the compile decision, so a lock that lost its
    // record, or a grant that moved, is visible without booting.
    for (const mod of plugin.report?.mods ?? []) {
      lines.push(`  mod (emitted): ${mod.entry} (${mod.manifest.mode}, ${mod.manifest.files.length} file${mod.manifest.files.length === 1 ? '' : 's'}) ${mod.artifactHash}`)
    }
    for (const refusal of plugin.report?.notRecorded ?? []) {
      lines.push(`  mod not recorded: ${refusal.name} — ${refusal.reason}`)
    }
    if (plugin.error !== undefined) lines.push(`  ERROR: ${plugin.error.reason}`)
    if (plugin.report !== undefined) {
      lines.push(`  report: ${totalsLine(plugin.report.totals)}${plugin.report.ok ? '' : ' — validation FAIL'}`)
      const refused = plugin.report.components.filter((component) => component.refused !== undefined)
      if (refused.length > 0) {
        lines.push(`  refused: ${refused.map((component) => `${component.surface}/${component.name} (${component.refused})`).join(', ')}`)
      }
      for (const problem of plugin.report.problems) lines.push(`    problem: ${problem}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

export interface SetEnabledOptions extends PathOptions {
  plugin: string
  enabled: boolean
  /** Absent means the narrowest layer that mentions it, else `user`. */
  scope?: Scope
  dryRun?: boolean
}

export interface SetEnabledResult {
  ok: true
  plugin: string
  requested: boolean
  action: 'enabled' | 'disabled' | 'unchanged'
  scope: Scope
  file: string
  previous?: boolean
  dryRun: boolean
  wrote: boolean
  diff: string[]
  effective: ResolvedEnablement
  warning?: string
}

export function setPluginEnabled(options: SetEnabledOptions): SetEnabledResult {
  const paths = installCliPaths(options)
  const dryRun = options.dryRun === true
  const state = readLifecycle(paths)
  const record = resolvePluginArgument(options.plugin, state.installs)
  const id = identity(record)
  const scope = options.scope ?? decidingScope(id, state.layers) ?? 'user'
  if (!SCOPES.includes(scope)) {
    throw new InstallCliError('invalid-record', `--scope must be one of ${SCOPES.join(', ')}`)
  }
  const file = enablementPaths({ projectDir: paths.projectDir, home: paths.home })[scope]
  const planned = nextLayer(state.layers, scope, id, options.enabled)
  const effectiveLayers: Enablements = { ...state.layers, [scope]: planned.layer }
  const effective = resolveEnablement(id, effectiveLayers)

  const diff = planned.changed
    ? [
        ...(state.layers[scope] === undefined
          ? []
          : [layerEntryLine(state.layers[scope], id)]
        )
          .filter((line): line is string => line !== undefined)
          .map((line) => `- ${line}`),
        `+ ${layerEntryLine(planned.layer, id) ?? `  ${id}: { enabled: ${options.enabled} }`}`,
      ]
    : []

  if (!dryRun && planned.changed) {
    try {
      writeEnablements(file, planned.layer)
    } catch (error) {
      throw new InstallCliError('write-failed', `could not write ${file}: ${(error as Error).message}`)
    }
  }

  const warning =
    effective.enabled === options.enabled
      ? undefined
      : `requested ${options.enabled ? 'enable' : 'disable'} at ${scope}, but ${effective.scope} still ${
          effective.enabled ? 'enables' : 'disables'
        } it; change that layer with --scope ${effective.scope}`

  return {
    ok: true,
    plugin: id,
    requested: options.enabled,
    action: planned.changed ? (options.enabled ? 'enabled' : 'disabled') : 'unchanged',
    scope,
    file,
    ...(planned.previous === undefined ? {} : { previous: planned.previous }),
    dryRun,
    wrote: !dryRun && planned.changed,
    diff,
    effective,
    ...(warning === undefined ? {} : { warning }),
  }
}

export function formatSetEnabled(result: SetEnabledResult): string {
  const lines: string[] = []
  if (result.action === 'unchanged') {
    lines.push(`${result.plugin} is already ${result.requested ? 'enabled' : 'disabled'} at ${result.scope} scope; nothing written.`)
  } else {
    const verb = result.dryRun
      ? `would ${result.requested ? 'enable' : 'disable'}`
      : result.requested
        ? 'enabled'
        : 'disabled'
    lines.push(`${verb} ${result.plugin} at ${result.scope} scope${result.dryRun ? ' (dry run — nothing written)' : ''}`)
  }
  lines.push(`  file: ${result.file}`)
  for (const line of result.diff) lines.push(`  ${line}`)
  const effective =
    result.effective.scope === null
      ? 'inert (no layer mentions it)'
      : `${result.effective.enabled ? 'enabled' : 'disabled'} at ${result.effective.scope}`
  lines.push(`  effective: ${effective}`)
  if (result.warning !== undefined) lines.push(`  WARNING: ${result.warning}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

export interface UninstallOptions extends PathOptions {
  plugin: string
  dryRun?: boolean
  materializers?: Materializers
}

export interface EntrySummary {
  id: string
  children: string[]
}

export interface UninstallResult {
  ok: true
  plugin: string
  record: InstallRecord
  dryRun: boolean
  wrote: boolean
  lockFile: string
  lockAfter: number
  diff: string[]
  /** Hash-pinned grants still stored for this identity (D25); uninstall keeps them. */
  grantsRetained: number
  /** Scope layers that still mention the id; uninstall leaves them alone. */
  dangling: Scope[]
  entries: {
    removed: EntrySummary[]
    remaining: EntrySummary[]
    problems: string[]
  }
}

function desiredEntries(
  installs: Installs,
  layers: Enablements,
  grants: Grants,
  materializers: Materializers,
): { entries: EntrySummary[]; problems: string[] } {
  // `activation` is explicit and empty: uninstalling a plugin must not depend
  // on the profile's output-style record being readable.
  const report = compileReport(installs, {
    materializers,
    enablements: layers,
    grants,
    activation: { file: '<uninstall>' },
  })
  return {
    entries: report.entries.map((entry) => ({
      id: entry.id,
      children: Array.isArray(entry.config) ? (entry.config as { id: string }[]).map((child) => child.id) : [],
    })),
    problems: report.problems.map((problem) => `${problem.plugin}: ${problem.reason}`),
  }
}

export function uninstallPlugin(options: UninstallOptions): UninstallResult {
  const paths = installCliPaths(options)
  const materializers = options.materializers ?? defaultMaterializers()
  const dryRun = options.dryRun === true
  const state = readLifecycle(paths)
  const record = resolvePluginArgument(options.plugin, state.installs)
  const id = identity(record)

  const nextInstalls: Installs = {
    schema: INSTALLS_SCHEMA,
    plugins: state.installs.plugins.filter((candidate) => identity(candidate) !== id),
  }
  try {
    validateInstalls(nextInstalls)
  } catch (error) {
    throw lift('invalid-record', 'invalid-record', paths.installs, error)
  }

  const before = desiredEntries(state.installs, state.layers, state.grants, materializers)
  const after = desiredEntries(nextInstalls, state.layers, state.grants, materializers)
  const afterIds = new Set(after.entries.map((entry) => entry.id))
  const removed = before.entries.filter((entry) => !afterIds.has(entry.id))
  const problems = after.problems

  const dangling = SCOPES.filter((scope) => state.layers[scope]?.plugins[id] !== undefined)
  const grantsRetained = state.grants.grants.filter((grant) => grant.plugin === id).length

  if (!dryRun) {
    try {
      writeInstalls(paths.installs, nextInstalls)
    } catch (error) {
      throw new InstallCliError('write-failed', `could not write ${paths.installs}: ${(error as Error).message}`)
    }
  }

  return {
    ok: true,
    plugin: id,
    record,
    dryRun,
    wrote: !dryRun,
    lockFile: paths.installs,
    lockAfter: nextInstalls.plugins.length,
    diff: recordLines(record).map((line) => `- ${line}`),
    grantsRetained,
    dangling,
    entries: { removed, remaining: after.entries, problems },
  }
}

export function formatUninstall(result: UninstallResult): string {
  const lines = [`uninstall ${result.plugin}${result.dryRun ? ' (dry run — nothing written)' : ''}`]
  lines.push(`  record: ${result.dryRun ? 'would remove' : 'removed'}`)
  lines.push(`  lock: ${result.lockFile} (${result.lockAfter} plugin${result.lockAfter === 1 ? '' : 's'} left)`)
  lines.push(`  grants: ${result.grantsRetained} retained`)
  for (const line of result.diff) lines.push(`  ${line}`)
  if (result.entries.removed.length === 0) {
    lines.push('  entry tree: no entry was contributed (disabled, or nothing emitted)')
  } else {
    for (const entry of result.entries.removed) {
      lines.push(
        `  entry tree: removed ${entry.id}${entry.children.length === 0 ? '' : ` and ${entry.children.length} child${entry.children.length === 1 ? '' : 'ren'}`}`,
      )
    }
  }
  lines.push(
    `  entry tree: remaining ${result.entries.remaining.length === 0 ? '(none)' : result.entries.remaining.map((entry) => entry.id).join(', ')}`,
  )
  if (result.entries.problems.length > 0) {
    lines.push(`  entry tree: ${result.entries.problems.length} problem(s) in the remaining lock`)
    for (const problem of result.entries.problems) lines.push(`    ${problem}`)
  }
  if (result.dangling.length > 0) {
    lines.push(`  enablement: ${result.dangling.join(', ')} still mention(s) it; it no longer decides anything`)
  }
  return lines.join('\n')
}

