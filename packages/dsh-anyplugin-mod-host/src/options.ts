/**
 * `PluginOptions` for one activation, from the pin's two facts.
 *
 * The pinned type is
 *
 *     export type PluginOptions =
 *       Readonly<Record<string, string | number | boolean | readonly string[]>>
 *
 * and its documentation says the object is "the values of the fields its
 * manifest's `userConfig` declares, defaults filled in", validated "against
 * the declared `type` before the module loads"; a required field with no
 * value fails the load, naming the field; a string field with an `options`
 * list treats a stored value outside it as unset, so the default applies
 * (`claude-code.d.ts` 2.1.322, lines 6231–6243).
 *
 * There is no `plugin`/root or data-dir member in that type. The host keeps
 * those as host facts (the root bounds resolution; the bridge owns the data
 * dir) and does not add them here: a field that the pin does not declare is
 * not a field we may fabricate.
 *
 * The manifest is JSON at `<plugin-root>/.claude-plugin/plugin.json`; the
 * complete plugins under `mods/` at the pin carry one (see `mods/README.md`).
 * `loadMod`'s `root` is the code root, which for those plugins is their
 * `hooks/` directory, so discovery proves the manifest at `root` or at its
 * parent — no wider search, no candidate list.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { ModHostError, describeValue, messageOf } from './errors.ts'

/** The pinned `PluginOptions` value union (claude-code.d.ts line 6243). */
export type PluginOptionValue = string | number | boolean | readonly string[]

/** A plugin's options as `register(on, options)` receives them. */
export type PluginOptions = Readonly<Record<string, PluginOptionValue>>

export interface ResolvePluginOptionsInput {
  /** The mod's code root, absolute or resolvable against `process.cwd()`. */
  readonly root: string
  /**
   * The plugin directory holding `.claude-plugin/plugin.json`. When omitted,
   * the host proves it at `root` or at the parent of `root`.
   */
  readonly pluginRoot?: string
  /**
   * The activation's stored option values (settings.json
   * `pluginConfigs[<plugin>].options`). A value the manifest does not declare
   * is ignored; a declared value is validated before use.
   */
  readonly values?: Readonly<Record<string, unknown>>
}

export interface ResolvedPluginOptions {
  /** The plugin directory the manifest was read from, when there is one. */
  readonly pluginRoot: string | undefined
  readonly options: PluginOptions
}

/** The manifest of a complete plugin, relative to the plugin root. */
export const PLUGIN_MANIFEST_PATH = join('.claude-plugin', 'plugin.json')

const EMPTY_OPTIONS: PluginOptions = Object.freeze({})

const TYPES = new Set(['string', 'number', 'boolean'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isManifest(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function optionError(reason: string, file: string | undefined, cause?: unknown): ModHostError {
  return new ModHostError('ERR_MOD_HOST_OPTIONS', reason, {
    ...(file === undefined ? {} : { file }),
    ...(cause === undefined ? {} : { cause }),
  })
}

/** Resolve the plugin directory, without inventing one. */
function findPluginRoot(root: string, explicit: string | undefined): string | undefined {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.length === 0) {
      throw optionError('pluginRoot must be a non-empty path', undefined)
    }
    const pluginRoot = resolve(explicit)
    let stat
    try {
      stat = statSync(pluginRoot)
    } catch (cause) {
      throw optionError('pluginRoot does not exist', pluginRoot, cause)
    }
    if (!stat.isDirectory()) {
      throw optionError('pluginRoot is not a directory', pluginRoot)
    }
    const manifest = join(pluginRoot, PLUGIN_MANIFEST_PATH)
    if (!isManifest(manifest)) {
      throw optionError(
        `pluginRoot has no ${PLUGIN_MANIFEST_PATH}; a complete plugin carries its manifest there`,
        manifest,
      )
    }
    return pluginRoot
  }

  if (isManifest(join(root, PLUGIN_MANIFEST_PATH))) return root
  const parent = dirname(root)
  if (parent !== root && isManifest(join(parent, PLUGIN_MANIFEST_PATH))) return parent
  return undefined
}

function readManifest(pluginRoot: string): Record<string, unknown> {
  const manifestPath = join(pluginRoot, PLUGIN_MANIFEST_PATH)
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (cause) {
    throw optionError(`cannot read plugin manifest: ${messageOf(cause)}`, manifestPath, cause)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch (cause) {
    throw optionError(`plugin manifest is not JSON: ${messageOf(cause)}`, manifestPath, cause)
  }
  if (!isRecord(manifest)) {
    throw optionError('plugin manifest must be a JSON object', manifestPath)
  }
  return manifest
}

function typeOf(value: unknown): 'string' | 'number' | 'boolean' | undefined {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return undefined
}

function readStringChoices(
  field: string,
  spec: Record<string, unknown>,
  manifestPath: string,
): readonly string[] | undefined {
  const declared = spec.options
  if (declared === undefined) return undefined
  if (!Array.isArray(declared) || !declared.every((choice) => typeof choice === 'string')) {
    throw optionError(
      `userConfig.${field}.options must be an array of strings, got ${describeValue(declared)}`,
      manifestPath,
    )
  }
  return declared as readonly string[]
}

function declaredDefault(
  field: string,
  type: 'string' | 'number' | 'boolean',
  spec: Record<string, unknown>,
  choices: readonly string[] | undefined,
  manifestPath: string,
): PluginOptionValue | undefined {
  if (!Object.hasOwn(spec, 'default')) return undefined
  const value = spec.default
  if (typeOf(value) !== type) {
    throw optionError(
      `userConfig.${field} declares type ${type} but its default is ${describeValue(value)}`,
      manifestPath,
    )
  }
  if (type === 'string' && choices !== undefined && !choices.includes(value as string)) {
    throw optionError(
      `userConfig.${field} default ${describeValue(value)} is outside its declared options`,
      manifestPath,
    )
  }
  return value as PluginOptionValue
}

function activationValue(
  field: string,
  type: 'string' | 'number' | 'boolean',
  choices: readonly string[] | undefined,
  values: Readonly<Record<string, unknown>>,
): PluginOptionValue | undefined {
  if (!Object.hasOwn(values, field)) return undefined
  const value = values[field]
  if (value === undefined) return undefined
  if (typeOf(value) !== type) {
    throw optionError(
      `userConfig.${field} is declared ${type} but the activation value is ${describeValue(value)}`,
      undefined,
    )
  }
  if (type === 'string' && choices !== undefined && !choices.includes(value as string)) {
    // The pin says a stored value outside `options` counts as unset, so the
    // default applies; it is not an error.
    return undefined
  }
  return value as PluginOptionValue
}

/**
 * Build the activation's `PluginOptions`.
 *
 * - a manifest with no `userConfig` declares no fields, so the result is an
 *   empty frozen record (a synthetic module with no manifest is the same case:
 *   nothing was declared);
 * - every declared field is served with its activation value or its manifest
 *   default; a required field with neither refuses the load naming the field;
 * - a declared `type` outside the pinned value union is refused rather than
 *   guessed at, naming the field;
 * - traversal is the manifest's declaration order, so the object is stable.
 */
export function resolvePluginOptions(input: ResolvePluginOptionsInput): ResolvedPluginOptions {
  const root = resolve(input.root)
  const pluginRoot = findPluginRoot(root, input.pluginRoot)
  if (pluginRoot === undefined) {
    return { pluginRoot: undefined, options: EMPTY_OPTIONS }
  }

  const manifestPath = join(pluginRoot, PLUGIN_MANIFEST_PATH)
  const manifest = readManifest(pluginRoot)
  if (!Object.hasOwn(manifest, 'userConfig') || manifest.userConfig === undefined) {
    return { pluginRoot, options: EMPTY_OPTIONS }
  }
  const userConfig = manifest.userConfig
  if (!isRecord(userConfig)) {
    throw optionError(`userConfig must be an object, got ${describeValue(userConfig)}`, manifestPath)
  }

  const values = input.values ?? {}
  if (!isRecord(values)) {
    throw optionError(`activation options must be an object, got ${describeValue(values)}`, manifestPath)
  }

  const options: Record<string, PluginOptionValue> = {}
  for (const [field, unknownSpec] of Object.entries(userConfig)) {
    if (!isRecord(unknownSpec)) {
      throw optionError(
        `userConfig.${field} must be an object, got ${describeValue(unknownSpec)}`,
        manifestPath,
      )
    }
    const spec = unknownSpec
    const type = spec.type
    if (typeof type !== 'string' || !TYPES.has(type)) {
      throw optionError(
        `userConfig.${field} declares type ${describeValue(type)}; the host serves only the pinned PluginOptions values (string, number, boolean) and does not guess at another declaration`,
        manifestPath,
      )
    }
    if (Object.hasOwn(spec, 'required') && typeof spec.required !== 'boolean') {
      throw optionError(
        `userConfig.${field}.required must be a boolean, got ${describeValue(spec.required)}`,
        manifestPath,
      )
    }
    const choices = type === 'string' ? readStringChoices(field, spec, manifestPath) : undefined
    const kind = type as 'string' | 'number' | 'boolean'
    const fallback = declaredDefault(field, kind, spec, choices, manifestPath)
    const stored = activationValue(field, kind, choices, values)
    const value = stored ?? fallback
    if (value === undefined) {
      if (spec.required === true) {
        throw optionError(
          `userConfig.${field} is required but has no value; the pinned loader fails the load naming the field`,
          manifestPath,
        )
      }
      continue
    }
    options[field] = value
  }

  return { pluginRoot, options: Object.freeze(options) }
}
