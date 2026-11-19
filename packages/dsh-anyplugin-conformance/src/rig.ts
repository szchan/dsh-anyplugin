#!/usr/bin/env node
// arch-check: cli — this file is the command-line surface; stdout is its output.
/**
 * The conformance rig CLI.
 *
 *   rig capture --plugin <dir> [--out <file>] [--name <plugin-name>]
 *   rig verify  --plugin <dir> --golden <file> [--allow-pin-mismatch] [--verbose]
 *   rig diff    --expected <file> --actual <file> [--allow-pin-mismatch] [--verbose]
 *   rig trace   --left <a.jsonl> --right <b.jsonl> [--root <plugin-dir>] [--verbose]
 *   rig report  <plugin-dir> [--json] [--grants <grants.yml>]
 *   rig grant   --plugin <dir> --grants <file> [--scope <s>] [--yes] [--replace-revoke] [--partial] [--json]
 *   rig revoke  --plugin <dir> --grants <file> --target <t> [--scope <s>] [--json]
 *
 * `capture` records what the upstream host reports about a plugin. `verify`
 * replays the probe and diffs it against that golden, which is how a pin bump
 * that changes behavior gets caught instead of silently redefining "100 %".
 * `report` compiles a plugin in memory and prints what the transplant would do
 * to it — no host, no golden, no installed harness. `grant`/`revoke` are the
 * authoring side of the D25 store: grant prints the exact command line, writes
 * only with `--yes`, is all-or-nothing unless `--partial` is explicit, and
 * never erases a same-scope revoke unless `--replace-revoke` is given; revoke
 * says which record still decides.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import type { ClaudePluginIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { diffInventories, normalizeInventory, type Inventory } from './inventory.ts'
import { probeWithClaude, resolvePluginName } from './oracles/claude.ts'
import { readInventoryFile } from './oracles/file.ts'
import { buildTransplantReport, formatDiff, formatTransplantReport } from './report.ts'
import { SCOPES, readGrants, type Scope } from '../../dsh-anyplugin-trust/src/index.ts'
import {
  GrantTargetError,
  classify,
  grantFor,
  pluginIdentity,
  resolveGrant,
  revoke,
  updateGrants,
  type ArtifactMode,
  type ArtifactRow,
  type GrantRecord,
  type Grants,
} from '../../dsh-anyplugin-trust/src/index.ts'
import { diffTraces, formatTraceDiff, normalizeTrace, readTraceFile } from './trace.ts'

interface Args {
  command: string
  options: Map<string, string | boolean>
  positionals: string[]
}

/** Flags that never take a value, so a following token is a positional. */
const BOOLEAN_OPTIONS = new Set([
  'json',
  'help',
  'verbose',
  'allow-pin-mismatch',
  'yes',
  'replace-revoke',
  'partial',
])

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const options = new Map<string, string | boolean>()
  const positionals: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const key = token.slice(2)
    if (BOOLEAN_OPTIONS.has(key)) {
      options.set(key, true)
      continue
    }
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      options.set(key, next)
      index += 1
    } else {
      options.set(key, true)
    }
  }
  return { command, options, positionals }
}

function requiredOptions(args: Args, ...names: string[]): string[] {
  return names.map((name) => {
    const value = args.options.get(name)
    if (typeof value !== 'string') throw new Error(`missing --${name}`)
    return value
  })
}

const USAGE = `usage:
  rig capture --plugin <dir> [--out <file>] [--name <plugin-name>]
  rig verify  --plugin <dir> --golden <file> [--allow-pin-mismatch] [--verbose]
  rig diff    --expected <file> --actual <file> [--allow-pin-mismatch] [--verbose]
  rig trace   --left <a.jsonl> --right <b.jsonl> [--root <plugin-dir>] [--verbose]
  rig report  <plugin-dir> [--json] [--grants <grants.yml>]   what the transplant would do
  rig report  --ir <file> [--json] [--grants <grants.yml>]    report a compiled IR instead
  rig grant   --plugin <dir> --grants <file> [--scope <s>] [--yes] [--replace-revoke] [--partial] [--json]
  rig revoke  --plugin <dir> --grants <file> --target <t> [--scope <s>] [--json]

  --grants reads the hash-pinned exec grant store; without it the store is
  empty, so exec artifacts report refused:exec and are not emitted (D25).
  --scope is local, project, or user (default: user). \`grant\` prints every
  ungranted exec artifact and the exact command line, and writes only with
  --yes. It writes nothing if any artifact is unpinnable unless --partial is
  given, and it never erases a same-scope revoke unless --replace-revoke is
  given. \`revoke\` writes at one scope and then names the record that decides.`

/** Scope is a record field (D25); the CLI authors one scope at a time. */
function parseScope(value: string | boolean | undefined): Scope {
  if (value === undefined) return 'user'
  if (typeof value !== 'string') throw new Error(`missing value for --scope\n${USAGE}`)
  if (!(SCOPES as readonly string[]).includes(value)) {
    throw new Error(`--scope must be one of ${SCOPES.join(', ')}\n${USAGE}`)
  }
  return value as Scope
}

/**
 * The materializer set this build ships, named the way emit expects. The report
 * must ask emit with the real set: "skipped" has to mean the compiler decided
 * not to place a component, never that the reporter forgot to pass a seam.
 */
const MATERIALIZERS = {
  skill: new URL('../../dsh-anyplugin-materialize-skill/src/index.ts', import.meta.url).href,
  mcp: new URL('../../dsh-anyplugin-materialize-mcp/src/index.ts', import.meta.url).href,
  hooks: new URL('../../dsh-anyplugin-materialize-hook/src/index.ts', import.meta.url).href,
}

function hasString(record: object, key: string): boolean {
  return typeof (record as Record<string, unknown>)[key] === 'string'
}

/** The shape emit and `summarizeIr` read unconditionally; a missing array is a usage error, not a crash. */
function isClaudePluginIr(value: unknown): value is ClaudePluginIr {
  if (typeof value !== 'object' || value === null) return false
  const ir = value as Record<string, unknown>
  for (const key of ['skills', 'agents', 'hooks', 'mcpServers', 'pending', 'unsupported']) {
    if (!Array.isArray(ir[key])) return false
  }
  return (
    typeof ir.plugin === 'object' &&
    ir.plugin !== null &&
    hasString(ir.plugin, 'name') &&
    typeof ir.pin === 'object' &&
    ir.pin !== null &&
    hasString(ir.pin, 'tool') &&
    hasString(ir.pin, 'version')
  )
}

function parseIrJson(text: string, path: string): ClaudePluginIr {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`--ir: ${path} is not JSON (${detail})\n${USAGE}`)
  }
  if (!isClaudePluginIr(parsed)) {
    throw new Error(
      `--ir: expected a ClaudePluginIr (skills/agents/hooks/mcpServers/pending/unsupported arrays, plugin.name, pin.tool, pin.version)\n${USAGE}`,
    )
  }
  return parsed
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const verbose = args.options.get('verbose') === true
  const allowPinMismatch = args.options.get('allow-pin-mismatch') === true
  if (args.command !== 'report' && args.positionals.length > 0) {
    throw new Error(`unexpected argument: ${args.positionals[0]}\n${USAGE}`)
  }

  if (args.command === 'report') {
    if (args.options.get('help') === true) {
      console.log(USAGE)
      return 0
    }
    const irPath = args.options.get('ir')
    let ir: ClaudePluginIr
    if (typeof irPath === 'string') {
      if (args.positionals.length > 0) {
        throw new Error(`--ir and <plugin-dir> are alternatives; got ${args.positionals[0]}`)
      }
      ir = parseIrJson(await readFile(irPath, 'utf8'), irPath)
    } else {
      const pluginDir = args.positionals[0]
      if (!pluginDir) throw new Error(`missing <plugin-dir>\n${USAGE}`)
      ir = readClaudePlugin(pluginDir)
    }
    const grantsPath = args.options.get('grants')
    const grants = typeof grantsPath === 'string' ? readGrants(grantsPath) : undefined
    const report = buildTransplantReport(ir, {
      materializers: MATERIALIZERS,
      ...(grants === undefined ? {} : { grants }),
    })
    console.log(args.options.get('json') === true ? JSON.stringify(report, null, 2) : formatTransplantReport(report))
    return report.ok ? 0 : 1
  }

  if (args.command === 'grant' || args.command === 'revoke') {
    if (args.options.get('help') === true) {
      console.log(USAGE)
      return 0
    }
    const [pluginDir, grantsFile] = requiredOptions(args, 'plugin', 'grants')
    const scope = parseScope(args.options.get('scope'))
    if (args.command === 'grant') {
      const run = runGrant(readClaudePlugin(pluginDir), grantsFile, {
        scope,
        yes: args.options.get('yes') === true,
        replaceRevoke: args.options.get('replace-revoke') === true,
        partial: args.options.get('partial') === true,
      })
      console.log(args.options.get('json') === true ? JSON.stringify(grantJson(run), null, 2) : formatGrant(run))
      return run.ok ? 0 : 1
    }
    if (args.options.get('yes') === true) {
      throw new Error(`--yes does not apply to revoke; revoking is immediate\n${USAGE}`)
    }
    if (args.options.get('replace-revoke') === true || args.options.get('partial') === true) {
      throw new Error(`--replace-revoke and --partial apply only to grant\n${USAGE}`)
    }
    const [target] = requiredOptions(args, 'target')
    let plugin: ClaudePluginIr | undefined
    let pluginError: string | undefined
    if (!existsSync(pluginDir)) {
      pluginError = `plugin directory does not exist: ${pluginDir}`
    } else {
      try {
        plugin = readClaudePlugin(pluginDir)
      } catch (error: unknown) {
        // Revoking consent must not require the artifact to still exist. Fall
        // back to the record; planRevoke decides whether it is enough.
        pluginError = error instanceof Error ? error.message : String(error)
      }
    }
    const run = runRevoke(plugin, grantsFile, target, scope, pluginError)
    console.log(args.options.get('json') === true ? JSON.stringify(revokeJson(run), null, 2) : formatRevoke(run))
    return run.ok ? 0 : 1
  }

  if (args.command === 'capture') {
    const [pluginDir] = requiredOptions(args, 'plugin')
    const nameOption = args.options.get('name')
    const probe = await probeWithClaude({
      pluginDir,
      ...(typeof nameOption === 'string' ? { name: nameOption } : {}),
    })
    const inventory = normalizeInventory({ ...probe.inventory, pin: probe.pin })
    const out = typeof args.options.get('out') === 'string'
      ? (args.options.get('out') as string)
      : join(pluginDir, '.inventory', `${probe.pin.tool}@${probe.pin.version}.json`)
    await mkdir(dirname(out), { recursive: true })
    // Keep the recorded source repo-relative so a golden captured here and a
    // golden captured in CI are comparable.
    const rel = relative(process.cwd(), pluginDir)
    const source = rel && !rel.startsWith('..') ? `plugin-dir:${rel}` : `plugin-dir:${pluginDir}`
    const body: Inventory = { ...inventory, plugin: { ...inventory.plugin, source } }
    await writeFile(out, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    console.log(`captured ${inventory.components.length} component(s) from ${probe.pin.tool}@${probe.pin.version} → ${out}`)
    for (const note of inventory.notes ?? []) console.log(`  note: ${note}`)
    return 0
  }

  if (args.command === 'verify') {
    const [pluginDir, golden] = requiredOptions(args, 'plugin', 'golden')
    const expected = await readInventoryFile(golden)
    const probe = await probeWithClaude({ pluginDir })
    const actual = normalizeInventory({ ...probe.inventory, pin: probe.pin })
    const report = diffInventories(expected, actual, { allowPinMismatch })
    console.log(formatDiff(report, { verbose }))
    return report.ok ? 0 : 1
  }

  if (args.command === 'diff') {
    const [expectedPath, actualPath] = requiredOptions(args, 'expected', 'actual')
    const report = diffInventories(await readInventoryFile(expectedPath), await readInventoryFile(actualPath), {
      allowPinMismatch,
    })
    console.log(formatDiff(report, { verbose }))
    return report.ok ? 0 : 1
  }

  if (args.command === 'trace') {
    const [leftPath, rightPath] = requiredOptions(args, 'left', 'right')
    const root = args.options.get('root')
    const options = typeof root === 'string' ? { root } : {}
    const left = normalizeTrace(readTraceFile(leftPath), options)
    const right = normalizeTrace(readTraceFile(rightPath), options)
    const diff = diffTraces(left, right)
    console.log(formatTraceDiff(diff, { verbose }))
    return diff.summary.differing === 0 && diff.summary.onlyLeft === 0 && diff.summary.onlyRight === 0 ? 0 : 1
  }

  throw new Error(`unknown command "${args.command}"\n${USAGE}`)
}

export type ArtifactForm = 'shell' | 'argv'

/** One classified artifact as the CLI shows it. */
export interface ArtifactPlan {
  target: string
  mode: ArtifactMode
  artifactHash: string
  sourcePath: string
  form: ArtifactForm
  /**
   * Expanded text for the shell form; a JSON argv array for the exec form,
   * where the host spawns words without a shell.
   */
  command: string
  /** Present on an already-granted artifact: the scope whose record allows it. */
  grantedScope?: Scope
  grantedAt?: string
  /** Present when a same-scope grant is being replaced: the hash the human saw before. */
  previousHash?: string
  /** Present on a pending artifact: `--replace-revoke` will clear a same-scope revoke. */
  clearsRevoke?: boolean
  /** A revoke broader than the requested scope that remains on file after the write. */
  broaderRevoke?: Scope
  /** A revoke at the requested scope that an already-granted artifact leaves inert. */
  inertRevoke?: Scope
  /** Present on a refused artifact: why it cannot be granted. */
  reason?: string
}

export interface GrantPlan {
  plugin: string
  root: string
  grants: string
  scope: Scope
  /** Grantable artifacts that are not allowed yet. */
  pending: ArtifactPlan[]
  /** Artifacts already allowed by a grant at this scope or narrower. */
  alreadyGranted: ArtifactPlan[]
  /** Artifacts that cannot be pinned, or that a narrower record outranks. */
  refused: ArtifactPlan[]
  /** Same-scope revokes a run must clear before granting these targets. */
  clearsRevokes: string[]
  /** Broader revokes that will remain on file after the write. */
  remainingRevokes: Array<{ target: string; scope: Scope }>
}

export interface GrantRun {
  plan: GrantPlan
  dryRun: boolean
  wrote: boolean
  granted: GrantRecord[]
  /** Refused artifacts that `--partial` left unwritten. */
  skipped: ArtifactPlan[]
  ok: boolean
  replaceRevoke: boolean
  partial: boolean
}

export interface ResolutionRecord {
  kind: 'grant' | 'revoke'
  scope: Scope
  artifactHash?: string
  grantedAt?: string
  decides: boolean
}

export interface ShadowedGrant {
  scope: Scope
  artifactHash: string
  grantedAt: string
  reason: string
}

/** The reader-friendly view of one D25 resolution, shared by text and JSON. */
export interface ResolutionView {
  status: 'allowed' | 'revoked' | 'hash-mismatch' | 'no-record' | 'unresolved'
  allowed: boolean
  decidingScope: Scope | null
  decidingKind: 'grant' | 'revoke' | null
  records: ResolutionRecord[]
  /** Grants still on file that do not allow the artifact now, with why. */
  shadowedGrants: ShadowedGrant[]
  /** Present only when the artifact is allowed. */
  allowedBy: { scope: Scope; artifactHash: string; grantedAt: string } | null
  verdict: string
  warning?: string
}

export interface RevokePlan {
  plugin: string
  root: string
  grants: string
  target: string
  scope: Scope
  capability: string
  /** False when the plugin directory could not be read; the record still revokes. */
  pluginRead: boolean
  pluginError?: string
  /** Absent when the plugin is gone or no longer contains this target. */
  mode?: ArtifactMode
  artifactHash?: string
  sourcePath?: string
  /** Human-readable reason the artifact is unavailable, when it is. */
  note?: string
  alreadyRevoked: boolean
  /** Resolution *after* the revoke; record-based when the artifact is unavailable. */
  resolution: ResolutionView
}

export interface RevokeRun {
  plan: RevokePlan
  wrote: boolean
  ok: boolean
}

function rank(scope: Scope): number {
  return SCOPES.indexOf(scope)
}

/**
 * Exec-form hooks are passed to `spawn` as argv, with no shell. Printing them
 * as a JSON array keeps the display exact: a word containing a space or a
 * literal `$` is one element, not something a shell should re-split.
 */
function renderArgv(words: readonly string[]): string {
  return JSON.stringify([...words])
}

/**
 * Expand `CLAUDE_PLUGIN_ROOT` the way `sh -c` will for the shell form.
 *
 * Only the variable is expanded: `$HOME`, command substitution and globs are
 * left to the shell, because pretending to know their values would be a lie.
 * A single-quoted occurrence is not expanded, and `\$` is an escaped dollar.
 * The hash still covers the unexpanded invocation; this is the display.
 */
export function expandPluginRoot(text: string, root: string): string {
  const braced = '${CLAUDE_PLUGIN_ROOT}'
  const bare = '$CLAUDE_PLUGIN_ROOT'
  let out = ''
  let quote: "'" | '"' | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (char === '\\' && quote !== "'") {
      const next = text[index + 1]
      out += next === undefined ? char : char + next
      if (next !== undefined) index += 1
      continue
    }
    if (quote === undefined && (char === "'" || char === '"')) {
      quote = char
      out += char
      continue
    }
    if (quote === char) {
      quote = undefined
      out += char
      continue
    }
    if (quote !== "'") {
      if (text.startsWith(braced, index)) {
        out += root
        index += braced.length - 1
        continue
      }
      if (text.startsWith(bare, index)) {
        const after = text[index + bare.length]
        if (after === undefined || !/[A-Za-z0-9_]/.test(after)) {
          out += root
          index += bare.length - 1
          continue
        }
      }
    }
    out += char
  }
  return out
}

function artifactPlan(plugin: ClaudePluginIr, row: ArtifactRow): ArtifactPlan {
  const root = plugin.plugin.root
  const hook =
    row.target.startsWith('hook:') ? plugin.hooks.find((candidate) => `hook:${candidate.event}#${candidate.index}` === row.target) : undefined
  let form: ArtifactForm = 'argv'
  let command: string
  if (hook !== undefined && hook.command !== undefined) {
    if (hook.args === undefined) {
      form = 'shell'
      command = expandPluginRoot(hook.command, root)
    } else {
      form = 'argv'
      command = renderArgv([hook.command, ...hook.args])
    }
  } else if (typeof row.manifest.invocation === 'string') {
    command = renderArgv([row.manifest.invocation])
  } else {
    command = renderArgv(row.manifest.invocation)
  }
  return {
    target: row.target,
    mode: row.mode,
    artifactHash: row.artifactHash,
    sourcePath: row.sourcePath,
    form,
    command,
  }
}

export function planGrant(
  plugin: ClaudePluginIr,
  store: Grants,
  options: { scope: Scope; grants: string },
): GrantPlan {
  const id = pluginIdentity(plugin)
  const pending: ArtifactPlan[] = []
  const alreadyGranted: ArtifactPlan[] = []
  const refused: ArtifactPlan[] = []
  const clearsRevokes: string[] = []
  const remainingRevokes: Array<{ target: string; scope: Scope }> = []
  const requested = rank(options.scope)

  for (const row of classify(plugin)) {
    const artifact = artifactPlan(plugin, row)
    if (row.unsupported !== undefined) {
      refused.push({
        ...artifact,
        reason: `cannot pin ${row.target} of ${id}: ${row.unsupported}`,
      })
      continue
    }

    const resolution = resolveGrant(store, id, row.capability, row.target)
    const deciding = resolution.record
    const decidingRank = deciding === undefined ? Number.POSITIVE_INFINITY : rank(deciding.record.scope)
    const broaderRevoke = resolution.records.find(
      (candidate) => candidate.kind === 'revoke' && rank(candidate.record.scope) > requested,
    )
    const noted: ArtifactPlan =
      broaderRevoke === undefined ? artifact : { ...artifact, broaderRevoke: broaderRevoke.record.scope }

    if (deciding?.kind === 'grant' && deciding.record.artifactHash === row.artifactHash && decidingRank <= requested) {
      const inertRevoke = resolution.records.find(
        (candidate) => candidate.kind === 'revoke' && candidate.record.scope === options.scope,
      )
      alreadyGranted.push({
        ...noted,
        grantedScope: deciding.record.scope,
        grantedAt: deciding.record.grantedAt,
        ...(inertRevoke === undefined ? {} : { inertRevoke: options.scope }),
      })
      if (broaderRevoke !== undefined) {
        remainingRevokes.push({ target: row.target, scope: broaderRevoke.record.scope })
      }
      continue
    }

    if (deciding?.kind === 'grant' && deciding.record.artifactHash !== row.artifactHash && decidingRank < requested) {
      refused.push({
        ...artifact,
        reason: `${row.capability} grant for ${row.target} of ${id} pins ${deciding.record.artifactHash} but the artifact is now ${row.artifactHash}; that grant is narrower than ${options.scope} and decides, so a broader grant would be inert — re-grant at ${deciding.record.scope} scope`,
      })
      continue
    }

    // A same-scope grant with different bytes is a re-prompt, not an
    // escalation: the human is looking at the new bytes, and `--yes` replaces
    // the record. A broader one is replaced as well, because the narrower
    // grant is the one that will decide.
    if (deciding?.kind === 'grant' && deciding.record.artifactHash !== row.artifactHash) {
      pending.push({
        ...noted,
        previousHash: deciding.record.artifactHash,
      })
      if (broaderRevoke !== undefined) {
        remainingRevokes.push({ target: row.target, scope: broaderRevoke.record.scope })
      }
      continue
    }

    if (deciding?.kind === 'revoke' && decidingRank < requested) {
      refused.push({
        ...artifact,
        reason: `${row.capability} for ${row.target} of ${id} is revoked at ${deciding.record.scope} scope, which is narrower than ${options.scope}; a narrower refusal never falls back to a broader grant — re-grant at ${deciding.record.scope} scope (which replaces that revoke) or remove it from the store`,
      })
      continue
    }

    if (deciding?.kind === 'revoke' && decidingRank === requested) {
      pending.push({ ...noted, clearsRevoke: true })
      clearsRevokes.push(row.target)
      if (broaderRevoke !== undefined) {
        remainingRevokes.push({ target: row.target, scope: broaderRevoke.record.scope })
      }
      continue
    }

    pending.push(noted)
    if (broaderRevoke !== undefined) {
      remainingRevokes.push({ target: row.target, scope: broaderRevoke.record.scope })
    }
  }

  return {
    plugin: id,
    root: plugin.plugin.root,
    grants: options.grants,
    scope: options.scope,
    pending,
    alreadyGranted,
    refused,
    clearsRevokes,
    remainingRevokes,
  }
}

function clearRevoke(store: Grants, id: string, target: string, scope: Scope): Grants {
  const revokes = store.revokes.filter(
    (record) => !(record.plugin === id && record.capability === 'exec' && record.target === target && record.scope === scope),
  )
  if (revokes.length === store.revokes.length) return store
  return { schema: store.schema, grants: store.grants, revokes }
}

/** Everything the plan read from the plugin bytes. */
function pluginSignature(artifact: ArtifactPlan): string {
  return JSON.stringify([artifact.target, artifact.artifactHash, artifact.mode, artifact.form, artifact.command])
}

/** Everything the plan read from the grants store and the requested scope. */
function storeSignature(artifact: ArtifactPlan): string {
  return JSON.stringify([
    artifact.clearsRevoke === true,
    artifact.previousHash ?? '',
    artifact.inertRevoke ?? '',
    artifact.broaderRevoke ?? '',
  ])
}

export function runGrant(
  plugin: ClaudePluginIr,
  file: string,
  options: {
    scope: Scope
    yes: boolean
    replaceRevoke: boolean
    partial: boolean
    /** Test seam: mutate state after the store lock is taken, before re-planning. */
    onLocked?: (current: Grants) => Grants
  },
): GrantRun {
  const preview = planGrant(plugin, readGrants(file), { scope: options.scope, grants: file })
  const blocked = preview.clearsRevokes.length > 0 && !options.replaceRevoke
  const refusedBlocks = preview.refused.length > 0 && !options.partial

  if (!options.yes) {
    return {
      plan: preview,
      dryRun: true,
      wrote: false,
      granted: [],
      skipped: [],
      ok: preview.pending.length === 0 && preview.refused.length === 0,
      replaceRevoke: options.replaceRevoke,
      partial: options.partial,
    }
  }

  if (preview.pending.length === 0) {
    return {
      plan: preview,
      dryRun: false,
      wrote: false,
      granted: [],
      skipped: [],
      ok: preview.refused.length === 0 && !blocked,
      replaceRevoke: options.replaceRevoke,
      partial: options.partial,
    }
  }

  if (blocked || refusedBlocks) {
    return {
      plan: preview,
      dryRun: false,
      wrote: false,
      granted: [],
      skipped: [],
      ok: false,
      replaceRevoke: options.replaceRevoke,
      partial: options.partial,
    }
  }

  const id = pluginIdentity(plugin)
  let written: GrantPlan | undefined
  const store = updateGrants(file, (current) => {
    const locked = options.onLocked === undefined ? current : options.onLocked(current)
    const fresh = planGrant(plugin, locked, { scope: options.scope, grants: file })
    if (fresh.clearsRevokes.length > 0 && !options.replaceRevoke) {
      throw new Error('the grants store changed while planning: a same-scope revoke appeared; re-run the command')
    }

    // Recompute the preview under the lock and require it to match what the
    // human saw. Plugin bytes and store records are separated so the message
    // names the thing that actually moved.
    const allArtifacts = (plan: GrantPlan): Map<string, ArtifactPlan> =>
      new Map(
        [...plan.pending, ...plan.alreadyGranted, ...plan.refused].map((artifact) => [artifact.target, artifact]),
      )
    const previewAll = allArtifacts(preview)
    const freshAll = allArtifacts(fresh)
    if (previewAll.size !== freshAll.size || [...previewAll.keys()].some((target) => !freshAll.has(target))) {
      throw new Error('the plugin bytes changed while planning; re-run the command')
    }
    for (const [target, before] of previewAll) {
      const after = freshAll.get(target)
      if (after === undefined) continue
      if (pluginSignature(before) !== pluginSignature(after)) {
        throw new Error('the plugin bytes changed while planning; re-run the command')
      }
    }
    const category = (plan: GrantPlan, target: string): string =>
      plan.pending.some((artifact) => artifact.target === target)
        ? 'pending'
        : plan.alreadyGranted.some((artifact) => artifact.target === target)
          ? 'granted'
          : 'refused'
    for (const [target, before] of previewAll) {
      const after = freshAll.get(target)
      if (after === undefined) continue
      if (storeSignature(before) !== storeSignature(after) || category(preview, target) !== category(fresh, target)) {
        throw new Error('the grants store changed while planning; re-run the command')
      }
    }
    written = fresh

    let next = locked
    for (const artifact of fresh.pending) {
      if (artifact.clearsRevoke === true) next = clearRevoke(next, id, artifact.target, options.scope)
      next = grantFor(plugin, next, artifact.target, {
        scope: options.scope,
        expectedHash: artifact.artifactHash,
      })
    }
    return next
  })

  const plan = written as GrantPlan
  const granted = plan.pending.map((artifact) => {
    const record = store.grants.find(
      (candidate) =>
        candidate.plugin === id &&
        candidate.capability === 'exec' &&
        candidate.target === artifact.target &&
        candidate.scope === options.scope,
    )
    if (record === undefined) throw new Error(`grant for ${artifact.target} is missing after the write`)
    return record
  })

  return {
    plan,
    dryRun: false,
    wrote: plan.pending.length > 0,
    granted,
    skipped: plan.refused,
    ok: plan.refused.length === 0,
    replaceRevoke: options.replaceRevoke,
    partial: options.partial,
  }
}

function viewResolution(
  artifactHash: string | undefined,
  resolution: ReturnType<typeof resolveGrant>,
  requested: Scope,
  target: string,
): ResolutionView {
  const records: ResolutionRecord[] = resolution.records.map((candidate) => ({
    kind: candidate.kind,
    scope: candidate.record.scope,
    ...(candidate.kind === 'grant'
      ? { artifactHash: candidate.record.artifactHash, grantedAt: candidate.record.grantedAt }
      : {}),
    decides: candidate === resolution.record,
  }))

  const deciding = resolution.record
  const decidingScope = resolution.scope ?? null
  const decidingKind = deciding?.kind ?? null
  let status: ResolutionView['status']
  if (deciding === undefined) status = 'no-record'
  else if (deciding.kind === 'revoke') status = 'revoked'
  else if (artifactHash === undefined) status = 'unresolved'
  else status = deciding.record.artifactHash === artifactHash ? 'allowed' : 'hash-mismatch'

  const allowedBy =
    status === 'allowed' && deciding !== undefined && deciding.kind === 'grant'
      ? { scope: deciding.record.scope, artifactHash: deciding.record.artifactHash, grantedAt: deciding.record.grantedAt }
      : null

  const shadowedGrants: ShadowedGrant[] =
    status === 'allowed'
      ? []
      : records
          .filter((record): record is ResolutionRecord & { artifactHash: string; grantedAt: string } => record.kind === 'grant')
          .map((record) => ({
            scope: record.scope,
            artifactHash: record.artifactHash,
            grantedAt: record.grantedAt,
            reason:
              decidingKind === 'revoke'
                ? record.scope === decidingScope
                  ? `at ${decidingScope} a revoke beats a grant; the grant is still on file but does not allow the artifact`
                  : `outranked by the narrower ${decidingScope} revoke; a narrower refusal never falls back to a broader grant`
                : record.decides
                  ? artifactHash === undefined
                    ? `decides; the stored hash is ${record.artifactHash}, but the artifact could not be read to compare it`
                    : `decides, but pins ${record.artifactHash} while the artifact is ${artifactHash}`
                  : `outranked by the ${decidingScope} grant, which pins a different hash`,
          }))

  let verdict: string
  if (status === 'no-record') {
    verdict = `no record mentions ${target}; exec is default-off.`
  } else if (status === 'revoked') {
    verdict = `at ${decidingScope} scope the revoke decides; ${target} is refused.`
    const sameScopeGrant = shadowedGrants.find((grant) => grant.scope === decidingScope)
    const broaderGrant = shadowedGrants.find((grant) => grant.scope !== decidingScope)
    if (sameScopeGrant !== undefined) {
      verdict += ` At ${decidingScope} a revoke beats a grant; the grant remains on file but does not allow the artifact.`
    } else if (broaderGrant !== undefined) {
      verdict += ` The ${broaderGrant.scope} grant is broader; a narrower refusal never falls back to a broader grant.`
    } else {
      verdict += ' no grant records this target.'
    }
    if (records.some((record) => record.kind === 'revoke' && !record.decides)) {
      verdict += ' Other revokes remain on file (listed below).'
    }
  } else if (status === 'allowed') {
    verdict = `still allowed by the ${decidingScope} grant ${allowedBy?.artifactHash}.`
    if (decidingScope !== requested) {
      verdict += ` Your ${requested} revoke did not take effect: the ${decidingScope} grant is narrower and decides; revoke at ${decidingScope} scope to refuse it.`
    }
  } else if (status === 'unresolved') {
    const decidingHash = shadowedGrants.find((grant) => grant.decides)?.artifactHash
    verdict = `the ${decidingScope} grant pins ${decidingHash}, but the artifact could not be read to compare the current bytes; the record still decides. Revoke at ${decidingScope} scope to refuse it.`
    if (decidingScope !== requested) {
      verdict += ` Your ${requested} revoke did not take effect: the ${decidingScope} grant is narrower and decides.`
    }
  } else {
    const decidingHash = shadowedGrants.find((grant) => grant.decides)?.artifactHash
    verdict = `the ${decidingScope} grant pins ${decidingHash} but the artifact is now ${artifactHash}; it remains refused.`
    if (decidingScope !== requested) {
      verdict += ` Your ${requested} revoke did not take effect: the ${decidingScope} grant is narrower and decides, even though its hash no longer matches.`
    }
  }

  const warning =
    status === 'allowed' && decidingScope !== requested
      ? `the artifact is still allowed; your ${requested} revoke did not take effect. Revoke at ${decidingScope} scope to refuse it there.`
      : undefined

  return {
    status,
    allowed: status === 'allowed',
    decidingScope,
    decidingKind,
    records,
    shadowedGrants,
    allowedBy,
    verdict,
    ...(warning === undefined ? {} : { warning }),
  }
}

export function planRevoke(
  plugin: ClaudePluginIr | undefined,
  store: Grants,
  target: string,
  scope: Scope,
  grantsFile: string,
  pluginError?: string,
): RevokePlan {
  const recordIds = [
    ...new Set(
      [...store.grants, ...store.revokes]
        .filter((record) => record.capability === 'exec' && record.target === target)
        .map((record) => record.plugin),
    ),
  ]

  let id: string
  let root: string
  if (plugin !== undefined) {
    id = pluginIdentity(plugin)
    root = plugin.plugin.root
  } else {
    if (recordIds.length === 0) {
      throw new GrantTargetError(
        target,
        `cannot revoke "${target}": the plugin directory could not be read${pluginError === undefined ? '' : ` (${pluginError})`}, and no store record mentions this target`,
      )
    }
    if (recordIds.length > 1) {
      throw new Error(
        `cannot determine which plugin "${target}" belongs to: the store records ${recordIds.join(', ')}, and the plugin directory could not be read`,
      )
    }
    id = recordIds[0]
    root = '(plugin directory could not be read)'
  }

  const rows = plugin === undefined ? [] : classify(plugin)
  const row = rows.find((candidate) => candidate.target === target)
  const pluginId = id
  let records = resolveGrant(store, id, 'exec', target)
  let storeFallback = false
  if (records.records.length === 0 && recordIds.length === 1 && recordIds[0] !== id) {
    // The directory was deleted (or renamed) and the dialect fell back to the
    // basename. The revoke belongs to the identity the store actually records.
    id = recordIds[0]
    records = resolveGrant(store, id, 'exec', target)
    storeFallback = true
  }

  if (records.records.length === 0 && row === undefined) {
    if (recordIds.length > 1) {
      throw new Error(
        `cannot determine which plugin "${target}" belongs to: the store records ${recordIds.join(', ')}, and the plugin contains no such artifact`,
      )
    }
    if (plugin !== undefined) {
      const known = rows.slice(0, 8).map((candidate) => candidate.target).join(', ')
      throw new GrantTargetError(
        target,
        `no exec artifact "${target}" in ${id}${known.length === 0 ? '' : `; known targets: ${known}`}`,
      )
    }
    throw new GrantTargetError(target, `no exec artifact "${target}" in ${id}`)
  }

  // An unsupported row is a declaration, not the artifact that was granted.
  // Attaching its mode/source/hash would show a hash the person never approved.
  const artifact =
    row === undefined || plugin === undefined || row.unsupported !== undefined
      ? undefined
      : artifactPlan(plugin, row)
  const note =
    plugin === undefined
      ? `the plugin directory could not be read${pluginError === undefined ? '' : ` (${pluginError})`}; revoking the store record`
      : storeFallback
        ? `the store records this target under ${id}, not ${pluginId}; revoking the store record`
        : row === undefined
          ? `the plugin no longer contains ${target}; revoking the store record`
          : row.unsupported !== undefined
            ? `${row.unsupported}; revoking the store record`
            : undefined
  const alreadyRevoked = records.records.some(
    (candidate) => candidate.kind === 'revoke' && candidate.record.scope === scope,
  )

  return {
    plugin: id,
    root,
    grants: grantsFile,
    target,
    scope,
    capability: 'exec',
    pluginRead: plugin !== undefined,
    ...(pluginError === undefined ? {} : { pluginError }),
    ...(artifact === undefined
      ? {}
      : { mode: artifact.mode, artifactHash: artifact.artifactHash, sourcePath: artifact.sourcePath }),
    ...(note === undefined ? {} : { note }),
    alreadyRevoked,
    resolution: viewResolution(artifact?.artifactHash, records, scope, target),
  }
}

/** The store's view of the target: identity plus every record that decides it. */
function revokeStoreSignature(plan: RevokePlan): string {
  return JSON.stringify([
    plan.plugin,
    ...plan.resolution.records.map((record) =>
      record.kind === 'grant'
        ? ['grant', record.scope, record.artifactHash]
        : ['revoke', record.scope],
    ),
  ])
}

export function runRevoke(
  plugin: ClaudePluginIr | undefined,
  file: string,
  target: string,
  scope: Scope,
  pluginError?: string,
  options: {
    /** Test seam: mutate state after the store lock is taken, before re-planning. */
    onLocked?: (current: Grants) => Grants
  } = {},
): RevokeRun {
  const preview = planRevoke(plugin, readGrants(file), target, scope, file, pluginError)
  if (preview.alreadyRevoked) {
    return { plan: preview, wrote: false, ok: preview.resolution.status === 'revoked' }
  }

  const store = updateGrants(file, (current) => {
    const locked = options.onLocked === undefined ? current : options.onLocked(current)
    const fresh = planRevoke(plugin, locked, target, scope, file, pluginError)
    if (fresh.alreadyRevoked) throw new Error('the grants store changed while planning; re-run the command')
    if (fresh.plugin !== preview.plugin || revokeStoreSignature(fresh) !== revokeStoreSignature(preview)) {
      throw new Error('the grants store changed while planning; re-run the command')
    }
    return revoke(locked, { plugin: preview.plugin, capability: 'exec', target }, { scope })
  })

  const plan = planRevoke(plugin, store, target, scope, file, pluginError)
  // R2: the write just created this revoke; report the preview's value so the
  // first run is not indistinguishable from a no-op re-run.
  plan.alreadyRevoked = preview.alreadyRevoked
  return { plan, wrote: true, ok: plan.resolution.status === 'revoked' }
}

export function grantJson(run: GrantRun): Record<string, unknown> {
  return {
    command: 'grant',
    ok: run.ok,
    plugin: run.plan.plugin,
    root: run.plan.root,
    grants: run.plan.grants,
    scope: run.plan.scope,
    dryRun: run.dryRun,
    wrote: run.wrote,
    replaceRevoke: run.replaceRevoke,
    partial: run.partial,
    pending: run.plan.pending,
    alreadyGranted: run.plan.alreadyGranted,
    refused: run.plan.refused,
    skipped: run.skipped,
    clearsRevokes: run.plan.clearsRevokes,
    remainingRevokes: run.plan.remainingRevokes,
    granted: run.granted,
  }
}

export function revokeJson(run: RevokeRun): Record<string, unknown> {
  return {
    command: 'revoke',
    ok: run.ok,
    plugin: run.plan.plugin,
    root: run.plan.root,
    grants: run.plan.grants,
    target: run.plan.target,
    scope: run.plan.scope,
    pluginRead: run.plan.pluginRead,
    ...(run.plan.pluginError === undefined ? {} : { pluginError: run.plan.pluginError }),
    wrote: run.wrote,
    alreadyRevoked: run.plan.alreadyRevoked,
    artifact:
      run.plan.artifactHash === undefined
        ? null
        : {
            target: run.plan.target,
            mode: run.plan.mode,
            artifactHash: run.plan.artifactHash,
            sourcePath: run.plan.sourcePath,
          },
    ...(run.plan.note === undefined ? {} : { note: run.plan.note }),
    resolution: run.plan.resolution,
  }
}

function formLabel(form: ArtifactForm): string {
  return form === 'shell' ? 'shell (sh -c; ${CLAUDE_PLUGIN_ROOT} expanded)' : 'argv (no shell; words passed literally)'
}

function formatArtifact(artifact: ArtifactPlan, indent: string): string[] {
  return [
    `${indent}${artifact.target}`,
    `${indent}  mode: ${artifact.mode}`,
    `${indent}  artifact: ${artifact.artifactHash}`,
    `${indent}  source: ${artifact.sourcePath}`,
    `${indent}  form: ${formLabel(artifact.form)}`,
    `${indent}  command: ${artifact.command}`,
  ]
}

export function formatGrant(run: GrantRun): string {
  const { plan } = run
  const blocked = plan.clearsRevokes.length > 0 && !run.replaceRevoke
  const refusedBlocks = plan.refused.length > 0 && !run.partial
  const lines = [
    `plugin: ${plan.plugin}`,
    `root: ${plan.root}`,
    `store: ${plan.grants}`,
    `scope: ${plan.scope}`,
    '',
  ]

  if (plan.pending.length > 0) {
    lines.push(`${plan.pending.length} artifact(s) to grant at ${plan.scope} scope:`)
    for (const artifact of plan.pending) {
      lines.push(...formatArtifact(artifact, '  '))
      if (artifact.previousHash !== undefined) {
        lines.push(`    re-consent: old ${artifact.previousHash} → new ${artifact.artifactHash}`)
      }
      if (artifact.clearsRevoke === true) {
        lines.push(
          `    revoke: a ${plan.scope} revoke currently refuses this target; --replace-revoke clears it before granting`,
        )
      }
      if (artifact.broaderRevoke !== undefined) {
        lines.push(`    note: the ${artifact.broaderRevoke} revoke remains on file; this ${plan.scope} grant outranks it`)
      }
    }
    lines.push('')
  }

  if (plan.alreadyGranted.length > 0) {
    lines.push(`${plan.alreadyGranted.length} artifact(s) already granted:`)
    for (const artifact of plan.alreadyGranted) {
      lines.push(
        `  ${artifact.target} — ${artifact.artifactHash} granted at ${artifact.grantedScope} scope (${artifact.grantedAt})`,
      )
      if (artifact.inertRevoke !== undefined) {
        lines.push(
          `    note: a ${artifact.inertRevoke} revoke remains on file; it is inert while the ${artifact.grantedScope} grant decides`,
        )
      }
    }
    lines.push('')
  }

  if (blocked) {
    lines.push(`${plan.clearsRevokes.length} revoke(s) at ${plan.scope} scope would be erased:`)
    for (const target of plan.clearsRevokes) lines.push(`  ${target}`)
    lines.push('')
  }

  if (plan.refused.length > 0) {
    lines.push(`${plan.refused.length} artifact(s) cannot be granted:`)
    for (const artifact of plan.refused) {
      lines.push(...formatArtifact(artifact, '  '))
      lines.push(`    refused: ${artifact.reason}`)
    }
    lines.push('')
  }

  if (run.wrote) {
    lines.push(`granted ${plan.pending.length} artifact(s) at ${plan.scope} scope in ${plan.grants}`)
    for (const record of run.granted) lines.push(`  ${record.target} — ${record.artifactHash}`)
    if (run.replaceRevoke) {
      for (const target of plan.clearsRevokes) lines.push(`cleared revoke: ${target}`)
    }
    for (const revoke of plan.remainingRevokes) {
      lines.push(
        `note: the ${revoke.scope} revoke for ${revoke.target} remains on file; the ${plan.scope} grant outranks it`,
      )
    }
    if (run.skipped.length > 0) {
      lines.push(`not granted (${run.skipped.length}):`)
      for (const artifact of run.skipped) {
        lines.push(`  ${artifact.target}`)
        lines.push(`    ${artifact.reason}`)
      }
    }
  } else if (run.dryRun) {
    if (blocked) {
      lines.push(
        `no grants written: re-run with --yes --replace-revoke to clear the ${plan.clearsRevokes.length} listed revoke(s) and grant the artifacts above.`,
      )
    } else if (plan.pending.length > 0) {
      if (plan.refused.length > 0 && !run.partial) {
        lines.push(
          `no grants written: ${plan.refused.length} artifact(s) cannot be granted; fix them or re-run with --yes --partial to grant the rest of the ${plan.pending.length} artifact(s).`,
        )
      } else {
        lines.push(
          `no grants written: re-run with --yes${run.partial ? ' --partial' : ''} to grant the ${plan.pending.length} artifact(s) above at ${plan.scope} scope.`,
        )
      }
    } else if (plan.refused.length > 0) {
      lines.push('no grants written: no artifact was grantable.')
    } else {
      lines.push('no grants written: every exec artifact is already granted.')
    }
  } else if (plan.pending.length === 0 && plan.refused.length === 0) {
    lines.push('no grants written: every exec artifact is already granted.')
  } else if (blocked) {
    lines.push(
      `no grants written: ${plan.clearsRevokes.length} revoke(s) would be erased. Re-run with --yes --replace-revoke to clear them and grant the artifacts above.`,
    )
  } else if (refusedBlocks) {
    lines.push(
      `no grants written: ${plan.refused.length} artifact(s) cannot be granted; fix them or re-run with --yes --partial to grant the rest.`,
    )
  } else {
    lines.push(`no grants written: no artifact was granted at ${plan.scope} scope.`)
  }

  return lines.join('\n').trimEnd()
}

export function formatRevoke(run: RevokeRun): string {
  const { plan } = run
  const resolution = plan.resolution
  const lines = [
    `plugin: ${plan.plugin}`,
    `root: ${plan.root}`,
    `store: ${plan.grants}`,
    `target: ${plan.target}`,
    `scope: ${plan.scope}`,
    '',
  ]

  if (!plan.pluginRead) {
    lines.push('plugin read: no; the revoke is record-based.')
    lines.push('')
  }
  if (plan.artifactHash !== undefined) {
    lines.push(`artifact: ${plan.artifactHash}`)
    lines.push(`  mode: ${plan.mode}`)
    lines.push(`  source: ${plan.sourcePath}`)
  } else {
    lines.push('artifact: unavailable')
  }
  if (plan.note !== undefined) lines.push(`note: ${plan.note}`)
  lines.push('')

  if (run.wrote) lines.push(`revoke written at ${plan.scope} scope.`)
  else if (plan.alreadyRevoked) lines.push(`already revoked at ${plan.scope} scope; nothing written.`)
  else lines.push('no revoke written.')

  const artifactState =
    resolution.allowed
      ? 'allowed'
      : resolution.status === 'unresolved' || plan.artifactHash === undefined
        ? 'unavailable'
        : 'refused'
  lines.push(`effective: ${resolution.status.toUpperCase()} (artifact ${artifactState})`)
  lines.push(`  ${resolution.verdict}`)
  if (resolution.records.length > 0) {
    lines.push('records for this target (narrowest first):')
    for (const record of resolution.records) {
      const detail =
        record.kind === 'grant' ? ` ${record.artifactHash} (granted ${record.grantedAt})` : ''
      lines.push(`  ${record.scope} ${record.kind}${detail}${record.decides ? ' — decides' : ''}`)
    }
  }
  if (resolution.shadowedGrants.length > 0) {
    lines.push('grants still on file but not allowing it now:')
    for (const grant of resolution.shadowedGrants) {
      lines.push(`  ${grant.scope} grant ${grant.artifactHash} (granted ${grant.grantedAt})`)
      lines.push(`    ${grant.reason}`)
    }
  }
  if (resolution.warning !== undefined) {
    lines.push('')
    lines.push(`WARNING: ${resolution.warning}`)
  }

  return lines.join('\n').trimEnd()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 2
    })
}
