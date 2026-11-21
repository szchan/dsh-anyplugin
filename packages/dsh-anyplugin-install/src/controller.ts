/**
 * `dsh-anyplugin` — the one loader row the bundle patch inserts.
 *
 * The published package is a bundle: its `cordis.patch.yml` adds this
 * controller to the profile, and the controller is what turns `installs.yml`
 * plus the enabled layers into loader entries. Everything below this row is
 * created at runtime by `reconcile`, from data. The package contains no
 * generated code and the controller never writes profile config: the lock and
 * the grants file are read, the loader is reconciled, and nothing is persisted.
 *
 * What is shipped in 0.2.0 is the *compile path* — skills (a slash command
 * lands as a skill on its model face), MCP servers, hooks whose host events
 * exist, agents, one activated output style — and the *mods kernel* in
 * `lib/materialize/hook.js`. The lock (`dsh-anyplugin/installs@2`) carries a
 * module as one `mods` entry with its tree manifest; a granted tree reaches
 * the hook row's `mods` config from here, and the packaged materializer loads
 * it as authored (D30/D31/D34) after re-reading the pinned files. Mods need
 * Node's `--experimental-vm-modules`. A row config written by hand is refused
 * unless it carries the same pin, so the controller passes mods; nothing
 * reaches `loadMod` on the strength of a hand-edited row.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { grantsPath, readGrants, type Grants } from '../../dsh-anyplugin-trust/src/index.ts'
import type { Materializers } from '../../dsh-anyplugin-emit/src/index.ts'

import { compileReport } from './compile.ts'
import { readEnablements } from './enablements.ts'
import { readInstalls } from './installs.ts'
import { reconcile, type LoaderLike, type ReconcileResult } from './reconcile.ts'

export const name = 'dsh-anyplugin'

/** The loader service; the controller is inert without it. */
export const inject = ['loader']

export interface Config {
  /**
   * The lock file. Default `$DSH_HOME/anyplugin/installs.yml`, the same place
   * the installer writes (D23: absent means no installs, malformed is an
   * error — never "silently uninstalled").
   */
  installs?: string
  /** Grants file. Default `grants.yml` next to the lock. */
  grants?: string
  /** `$DSH_HOME` override; defaults to the harness-provided `dshHomePath`. */
  home?: string
  /** Workspace whose `.dsh/anyplugin*.yml` layers apply. Default `process.cwd()`. */
  projectDir?: string
}

/**
 * Published subpath specifiers, not file URLs: the profile's package manager
 * installs the package, and the loader resolves bare names (including package
 * subpath exports) from the profile's package scope. Absolute URLs would pin
 * the build tree and break as soon as the tarball moves.
 */
export const MATERIALIZERS: Materializers = {
  skill: 'dsh-anyplugin/materialize/skill',
  agents: 'dsh-anyplugin/materialize/agents',
  mcp: 'dsh-anyplugin/materialize/mcp',
  hooks: 'dsh-anyplugin/materialize/hook',
  outputStyle: 'dsh-anyplugin/materialize/output-style',
}

interface Logger {
  debug?: (message: string) => void
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/**
 * The harness provides `dshHomePath(segments…)` on the root context (app-boot
 * does this before the loader mounts). Tests and embedders do not, so the
 * documented fallback order is repeated here: `$DSH_HOME`, then `~/.dsh`.
 */
function resolveHome(ctx: { get?: (name: string) => unknown }): string {
  const provided = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
  if (typeof provided === 'function') {
    const value = (provided as () => unknown)()
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const env = process.env.DSH_HOME?.trim()
  if (env) return env
  return join(homedir(), '.dsh')
}

function loggerOf(ctx: { logger?: unknown }): Logger | undefined {
  try {
    if (typeof ctx.logger === 'function') return (ctx.logger as (scope: string) => Logger)('dsh-anyplugin')
    if (ctx.logger && typeof ctx.logger === 'object') return ctx.logger as Logger
  } catch {
    // Logging must never be the reason a plugin fails to start.
  }
  return undefined
}

function summary(result: ReconcileResult): string {
  const parts = ['created', 'updated', 'removed', 'kept'].map(
    (key) => `${key} ${result[key as 'created' | 'updated' | 'removed' | 'kept'].length}`,
  )
  if (result.failed.length > 0) parts.push(`failed ${result.failed.length}`)
  if (result.refused.length > 0) parts.push(`refused ${result.refused.length}`)
  return parts.join(', ')
}

export async function apply(ctx: { loader: LoaderLike; get?: (name: string) => unknown; logger?: unknown }, config: Config = {}): Promise<void> {
  const log = loggerOf(ctx)
  const home = config.home ?? resolveHome(ctx)
  const installsFile = config.installs ?? join(home, 'anyplugin', 'installs.yml')

  if (!existsSync(installsFile)) {
    log?.debug?.(`no lock at ${installsFile}; nothing to reconcile`)
    return
  }

  const installs = readInstalls(installsFile)
  const grantsFile = config.grants ?? grantsPath(installsFile)
  let grants: Grants | undefined
  if (existsSync(grantsFile)) grants = readGrants(grantsFile)

  const projectDir = config.projectDir ?? process.cwd()
  const enablements = readEnablements({ projectDir, home })
  const report = compileReport(installs, {
    materializers: MATERIALIZERS,
    enablements,
    ...(grants === undefined ? {} : { grants }),
    home,
    projectDir,
  })

  for (const problem of report.problems) {
    log?.error?.(`${problem.plugin}: ${problem.reason}`)
  }

  // A style is a profile selection (D42): say which one won, and why a record
  // did not apply. A refusal is not a compile problem — the lock still compiles
  // without the style — so it is surfaced here and never silently dropped.
  if (report.activation.kind === 'active') {
    log?.info?.(
      `output style ${report.activation.plugin}:${report.activation.style.name} (${report.activation.source})`,
    )
  } else if (report.activation.kind === 'refused') {
    log?.warn?.(
      `output style ${JSON.stringify(report.activation.requested)} not applied (${report.activation.code}): ${report.activation.reason}`,
    )
  }

  const result = await reconcile(ctx.loader, report.entries, {
    decisions: report.decisions,
    // We run inside our own apply, so `loader.await()` would wait for the very
    // entry whose apply is in flight. Reconcile awaits each mutation itself and
    // verifies every group and child fiber active; boot awaits the tree after us.
    settle: false,
    onRefused: (refused) => {
      for (const item of refused) {
        log?.warn?.(
          `refused ${item.capability} artifact ${item.target} of ${item.plugin}: ${item.reason} (grant it in ${grantsFile} to enable it)`,
        )
      }
    },
  })

  for (const failure of result.failed) {
    const where = failure.child === undefined ? failure.id : `${failure.id} (${failure.child})`
    log?.error?.(`${where}: ${failure.reason}`)
  }

  const installed = installs.plugins.length
  const enabled = report.entries.length
  log?.info?.(
    `reconciled ${enabled} of ${installed} installed plugin(s) from ${installsFile}: ${summary(result)}`,
  )
}
