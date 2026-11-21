/**
 * The output-style activation record — a profile-scoped choice of at most one
 * carried style (ticket #77).
 *
 * It lives next to `enabled.yml` in the profile's `anyplugin/` directory
 * (`$DSH_HOME/anyplugin/output-styles.yml`) rather than in the host settings:
 * this layer owns no host `outputStyle` setting, and writing one at run time
 * would break AGENTS §3.4. The record is read, never written.
 *
 * Canonical shape (the same strict YAML subset `installs.yml` uses):
 *
 *   schema: "dsh-anyplugin/output-styles@1"
 *   outputStyles:
 *     active: "my-plugin:terse"
 *
 * Absent file = no explicit activation (a `force-for-plugin` style may still
 * apply). Malformed file = typed `InstallsFileError` at load, never a silent
 * fallback: "cannot tell" must not become "no style".
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { InstallsFileError } from './installs.ts'

export const OUTPUT_STYLES_SCHEMA = 'dsh-anyplugin/output-styles@1'

/** `<plugin>:<style>`, as Claude's inventory spells a plugin style. */
export interface ActivationTarget {
  plugin: string
  style: string
}

export interface OutputStylesFile {
  /** The explicit record, when the file has one. */
  active?: ActivationTarget
  /** Path read (or the pseudo-path a test passed); used in traces. */
  file: string
}

export type ActivationRefusalCode =
  | 'unknown-plugin'
  | 'plugin-disabled'
  | 'plugin-unreadable'
  | 'unknown-style'
  | 'empty-style'

/** What the resolver needs to know about one installed plugin. */
export interface ActivationPlugin {
  name: string
  enabled: boolean
  /**
   * Styles the prepared IR carries. Absent when the record was not prepared:
   * disabled plugins and records that failed to compile.
   */
  styles?: readonly ActivationStyle[]
  /** Why preparation failed; surfaced by a `plugin-unreadable` refusal. */
  problem?: string
}

/** The part of `IrOutputStyle` activation needs, structurally. */
export interface ActivationStyle {
  name: string
  description?: string
  body: string
  keepCodingInstructions?: boolean
  forceForPlugin?: boolean
}

export type ActivationResolution =
  | { kind: 'none'; trace: string }
  | {
      kind: 'active'
      /** `explicit` is the profile record; `force` is the style's own flag. */
      source: 'explicit' | 'force'
      plugin: string
      style: ActivationStyle
      trace: string
    }
  | {
      kind: 'refused'
      code: ActivationRefusalCode
      /** The `plugin:style` the record asked for, verbatim. */
      requested: string
      reason: string
      trace: string
    }

const SCHEMA_LINE = /^schema:\s+"([^"]*)"\s*$/
const BLOCK_LINE = /^outputStyles:(?:\s*\{\s*\})?\s*$/
const ACTIVE_LINE = /^  active:\s*"((?:[^"\\]|\\.)*)"\s*$/
/** A Claude plugin name cannot contain `:`; the style half may. */
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/

export function outputStylesPath(home?: string): string {
  const root = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(root, 'anyplugin', 'output-styles.yml')
}

/** Read the record. A missing file is "no explicit activation", not an error. */
export function readActivation(options: { home?: string } = {}): OutputStylesFile {
  const file = outputStylesPath(options.home)
  if (!existsSync(file)) return { file }
  return parseOutputStyles(readFileSync(file, 'utf8'), file)
}

function unquote(raw: string): string {
  return raw.replace(/\\(["\\])/g, '$1')
}

/** Pure parser for one record; exported for tests. */
export function parseOutputStyles(text: string, file = '<output-styles>'): OutputStylesFile {
  const lines = text.replace(/^\uFEFF/, '').split('\n')
  let stage: 'schema' | 'block' | 'body' = 'schema'
  let active: ActivationTarget | undefined
  const significant = (line: string) => !/^\s*(?:#.*)?$/.test(line)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '')
    if (!significant(line)) continue
    const number = index + 1
    if (stage === 'schema') {
      const match = SCHEMA_LINE.exec(line)
      if (!match) {
        throw new InstallsFileError(`expected \`schema: "${OUTPUT_STYLES_SCHEMA}"\` on the first non-comment line`, { file, line: number })
      }
      if (match[1] !== OUTPUT_STYLES_SCHEMA) {
        throw new InstallsFileError(`expected schema "${OUTPUT_STYLES_SCHEMA}", got "${match[1]}"`, { file, line: number })
      }
      stage = 'block'
      continue
    }
    if (stage === 'block') {
      if (!BLOCK_LINE.test(line)) {
        throw new InstallsFileError('expected `outputStyles:` after the schema line', { file, line: number })
      }
      // `outputStyles: {}` is an explicit empty record; `outputStyles:` can
      // still be followed by one `active` row.
      stage = 'body'
      continue
    }
    const match = ACTIVE_LINE.exec(line)
    if (!match) {
      throw new InstallsFileError('expected `  active: "<plugin>:<style>"` (0 or 1 row)', { file, line: number })
    }
    if (active !== undefined) {
      throw new InstallsFileError('only one `active` record is allowed', { file, line: number })
    }
    const value = unquote(match[1])
    const colon = value.indexOf(':')
    if (colon <= 0 || colon === value.length - 1) {
      throw new InstallsFileError(`"${value}" is not a <plugin>:<style> id`, { file, line: number })
    }
    const plugin = value.slice(0, colon)
    const style = value.slice(colon + 1)
    if (!PLUGIN_NAME.test(plugin)) {
      throw new InstallsFileError(`"${plugin}" is not a plugin name`, { file, line: number })
    }
    if (style !== style.trim() || /[\u0000-\u001f]/.test(style)) {
      throw new InstallsFileError('style names must not be padded or contain control characters', { file, line: number })
    }
    active = { plugin, style }
  }
  if (stage === 'schema') throw new InstallsFileError('empty file; expected the schema line', { file, line: 1 })
  if (stage === 'block') throw new InstallsFileError('missing `outputStyles:` block', { file, line: lines.length })
  return { ...(active === undefined ? {} : { active }), file }
}

function label(target: { plugin: string; style: string }): string {
  return `${target.plugin}:${target.style}`
}

/**
 * Choose the style this compile applies.
 *
 * Precedence is declared, not inferred:
 *  - an explicit record wins whenever it resolves, and a refusal is final
 *    (force-for-plugin is not consulted after it, so a typo cannot quietly
 *    apply another plugin's style);
 *  - without a record, the first enabled plugin that declares
 *    `force-for-plugin: true` applies, in plugin-name order, the first such
 *    style in its file order. Upstream says "first one loaded"; this layer has
 *    no load order, so a stated sort is what makes it deterministic.
 *
 * Cross-pin note: Claude's docs say force overrides the user's `outputStyle`
 * setting. Here the explicit record is the operator's statement and wins; the
 * divergence is deliberate (there is no host setting to override).
 */
export function resolveActivation(
  plugins: readonly ActivationPlugin[],
  file: OutputStylesFile,
): ActivationResolution {
  const ordered = [...plugins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const explicit = file.active
  if (explicit !== undefined) {
    const requested = label(explicit)
    const record = ordered.find((plugin) => plugin.name === explicit.plugin)
    if (record === undefined) {
      return refuse('unknown-plugin', requested, `no installed plugin is named ${JSON.stringify(explicit.plugin)}`, file)
    }
    if (!record.enabled) {
      return refuse('plugin-disabled', requested, `plugin ${JSON.stringify(explicit.plugin)} is installed but disabled by the enablement layers`, file)
    }
    if (record.styles === undefined) {
      return refuse(
        'plugin-unreadable',
        requested,
        `plugin ${JSON.stringify(explicit.plugin)} could not be prepared: ${record.problem ?? 'unknown reason'}`,
        file,
      )
    }
    const style = record.styles.find((candidate) => candidate.name === explicit.style)
    if (style === undefined) {
      const available = record.styles.map((candidate) => candidate.name)
      const names = available.length === 0 ? 'it declares no output styles' : `it declares ${available.map((name) => JSON.stringify(name)).join(', ')}`
      return refuse('unknown-style', requested, `plugin ${JSON.stringify(explicit.plugin)} has no output style ${JSON.stringify(explicit.style)}; ${names}`, file)
    }
    if (style.body.length === 0) {
      return refuse('empty-style', requested, `output style ${JSON.stringify(requested)} has an empty body; applying it would be a silent no-op`, file)
    }
    // Name the force style that lost, when there is one, so the trace explains
    // why a plugin that asks to be forced is not active.
    const forced = firstForced(ordered)
    const note = forced === undefined ? '' : `; force-for-plugin ${JSON.stringify(label({ plugin: forced.plugin, style: forced.style.name }))} was not applied because the explicit record wins`
    return {
      kind: 'active',
      source: 'explicit',
      plugin: record.name,
      style,
      trace: `explicit activation ${JSON.stringify(requested)} from ${file.file}${note}`,
    }
  }
  const forced = firstForced(ordered)
  if (forced !== undefined) {
    return {
      kind: 'active',
      source: 'force',
      plugin: forced.plugin,
      style: forced.style,
      trace: `no explicit activation in ${file.file}; force-for-plugin ${JSON.stringify(label({ plugin: forced.plugin, style: forced.style.name }))} applies because plugin ${JSON.stringify(forced.plugin)} is enabled`,
    }
  }
  return {
    kind: 'none',
    trace: `no explicit activation in ${file.file} and no enabled plugin declares force-for-plugin; no output style is applied`,
  }
}

function refuse(
  code: ActivationRefusalCode,
  requested: string,
  reason: string,
  file: OutputStylesFile,
): ActivationResolution {
  return {
    kind: 'refused',
    code,
    requested,
    reason,
    trace: `explicit activation ${JSON.stringify(requested)} from ${file.file} was refused (${code}): ${reason}; force-for-plugin is not consulted after an explicit refusal`,
  }
}

function firstForced(plugins: readonly ActivationPlugin[]): { plugin: string; style: ActivationStyle } | undefined {
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.styles === undefined) continue
    const style = plugin.styles.find((candidate) => candidate.forceForPlugin === true)
    if (style !== undefined) return { plugin: plugin.name, style }
  }
  return undefined
}
