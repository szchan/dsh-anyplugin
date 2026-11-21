/**
 * Enablement — the second scope axis (D2). Installation is profile-global;
 * whether an installed plugin runs is decided per workspace by replaying three
 * layers, narrowest first:
 *
 *   local   <workspace>/.dsh/anyplugin.local.yml   (gitignored)
 *   project <workspace>/.dsh/anyplugin.yml          (committed)
 *   user    $DSH_HOME/anyplugin/enabled.yml
 *
 * First layer that mentions a plugin wins, even when it disables it. A plugin
 * nobody mentions is installed but inert. There is no fourth default.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { InstallsFileError } from './installs.ts'

export type Scope = 'local' | 'project' | 'user'

export interface Enablement {
  enabled: boolean
  /** Capability grants carried by the layer; reconcile does not consume them yet. */
  grants: string[]
}

export type EnablementLayer = { plugins: Record<string, Enablement> }

export interface Enablements {
  local?: EnablementLayer
  project?: EnablementLayer
  user?: EnablementLayer
}

export interface ResolvedEnablement {
  enabled: boolean
  /** The layer that decided, or `null` when no layer mentions the plugin. */
  scope: Scope | null
  grants: string[]
}

export const SCOPES: Scope[] = ['local', 'project', 'user']
const ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._@-]*$/
const PLUGINS_LINE = /^\s*plugins:(?:\s*\[\s*\])?\s*$/
const ENTRY_LINE = /^\s{2}(\S+):\s*\{\s*enabled:\s*(true|false)\s*(?:,\s*grants:\s*\[([^\]]*)\])?\s*\}\s*$/

export function enablementPaths(options: { projectDir: string; home?: string }): Record<Scope, string> {
  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    local: join(options.projectDir, '.dsh', 'anyplugin.local.yml'),
    project: join(options.projectDir, '.dsh', 'anyplugin.yml'),
    user: join(home, 'anyplugin', 'enabled.yml'),
  }
}

/**
 * Read the three layer files that exist. Missing files are empty layers;
 * a malformed file is an error, because "cannot tell" must not become "off"
 * (that would silently disable plugins in a shared repo).
 */
export function readEnablements(options: { projectDir: string; home?: string }): Enablements {
  const paths = enablementPaths(options)
  const layers: Enablements = {}
  for (const scope of SCOPES) {
    const file = paths[scope]
    if (!existsSync(file)) continue
    layers[scope] = parseEnablements(readFileSync(file, 'utf8'), file)
  }
  return layers
}

/** Pure parser for one layer; exported for tests. */
export function parseEnablements(text: string, file = '<enablements>'): EnablementLayer {
  const plugins: Record<string, Enablement> = {}
  let sawPlugins = false
  let inlineEmpty = false
  const lines = text.replace(/^\uFEFF/, '').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '')
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const number = index + 1
    if (!sawPlugins) {
      if (!PLUGINS_LINE.test(line)) {
        throw new InstallsFileError('expected `plugins:` on the first non-comment line', { file, line: number })
      }
      sawPlugins = true
      inlineEmpty = /^\s*plugins:\s*\[\s*\]\s*$/.test(line)
      continue
    }
    if (inlineEmpty) {
      throw new InstallsFileError('`plugins: []` cannot be followed by plugin entries', { file, line: number })
    }
    const match = ENTRY_LINE.exec(line)
    if (!match) {
      throw new InstallsFileError(
        'expected `  <dialect>:<plugin>: { enabled: true|false }` (grants optional)',
        { file, line: number },
      )
    }
    const [, id, enabled, grants] = match
    if (!ID.test(id)) {
      throw new InstallsFileError(`"${id}" is not a <dialect>:<plugin> id`, { file, line: number })
    }
    if (Object.hasOwn(plugins, id)) {
      throw new InstallsFileError(`duplicate plugin "${id}"`, { file, line: number })
    }
    const values = grants === undefined || grants.trim() === ''
      ? []
      : grants.split(',').map((grant) => grant.trim())
    if (values.some((grant) => grant.length === 0 || /\s/.test(grant))) {
      throw new InstallsFileError('grants must be comma-separated bare capability names', { file, line: number })
    }
    plugins[id] = { enabled: enabled === 'true', grants: values }
  }
  if (!sawPlugins) {
    throw new InstallsFileError('empty file; expected `plugins:`', { file, line: 1 })
  }
  return { plugins }
}

/**
 * Serialize one layer in the canonical form the parser above accepts.
 *
 * The writer is deliberately as small as the reader: sorted ids, one line per
 * entry, `grants` preserved when present (the CLI never authors them, but a
 * hand-written layer may carry them and a rewrite must not drop consent state).
 */
export function serializeEnablements(layer: EnablementLayer): string {
  if (layer === null || typeof layer !== 'object' || layer.plugins === null || typeof layer.plugins !== 'object') {
    throw new InstallsFileError('an enablement layer must be an object with a "plugins" record')
  }
  const ids = Object.keys(layer.plugins).sort()
  for (const id of ids) {
    if (!ID.test(id)) throw new InstallsFileError(`"${id}" is not a <dialect>:<plugin> id`)
    const entry = layer.plugins[id]
    if (entry === null || typeof entry !== 'object' || typeof entry.enabled !== 'boolean') {
      throw new InstallsFileError(`enablement for "${id}" must have a boolean "enabled"`)
    }
    if (!Array.isArray(entry.grants) || entry.grants.some((grant) => typeof grant !== 'string' || grant.length === 0 || /[\s,]/.test(grant))) {
      throw new InstallsFileError(`enablement for "${id}" has invalid grants`)
    }
  }
  const lines = ['# dsh-anyplugin enablement — generated; edit through the installer.']
  if (ids.length === 0) {
    lines.push('plugins: []')
  } else {
    lines.push('plugins:')
    for (const id of ids) {
      const entry = layer.plugins[id]
      const grants = entry.grants.length === 0 ? '' : `, grants: [${entry.grants.join(', ')}]`
      lines.push(`  ${id}: { enabled: ${entry.enabled}${grants} }`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write one layer atomically (temp + rename), for the same reason
 * `writeInstalls` does: a crash mid-write must not leave a half-valid layer
 * that the next read would have to reject — or worse, read as "off".
 */
export function writeEnablements(file: string, layer: EnablementLayer): void {
  const text = serializeEnablements(layer)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** First mention wins: local, then project, then user. No mention means inert. */
export function resolveEnablement(id: string, enablements: Enablements): ResolvedEnablement {
  for (const scope of SCOPES) {
    const layer = enablements[scope]
    if (!layer) continue
    const entry = layer.plugins[id]
    if (entry) return { enabled: entry.enabled, scope, grants: [...entry.grants] }
  }
  return { enabled: false, scope: null, grants: [] }
}
