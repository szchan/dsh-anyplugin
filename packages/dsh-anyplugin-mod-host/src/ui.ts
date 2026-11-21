/**
 * The headless render sink behind `$.ui` (#75).
 *
 * Upstream draws a plugin's `ui.render` hooks into the terminal, the desktop
 * window, mobile or the editor. This host has no surface, so the six `ui`
 * members a mod can reach — `open`, `close`, `invalidate`, `log`, `status`
 * and `resolve` — are served *headless*: `open` records a pane, the host's
 * render chain runs the mod's own `ui.render` hook for it, and the returned
 * tree is checked before it is stored as the pane's latest revision. Nothing
 * is drawn, no ANSI is produced, and no client is touched; the recorded tree is
 * the observable (D32 is the decision that the element runtime belongs behind
 * this seam, not in the bridge).
 *
 * What is checked is the pin's published shape: every tag must be one the
 * surface's element table declares (`Elements`, claude-code.d.ts:4776 @ 2.1.329),
 * every tree member must be on the pinned key list, every prop must be one the
 * element's pinned interface declares, and every value must have the type or
 * literal union that interface gives it (`BoxProps` 1280, `TextProps` 16722,
 * `ImageSource` 6997, `Matcher` 7460, and the per-element interfaces in
 * `RenderElement`, 12513-12884). The members the pin marks required must be
 * present. The refusal sentence (`a tree Pane refuses: Text prop "x" is not
 * allowed`) follows the shape the ticket asks for; the exact wording is
 * *derived*, because the pin's validator is compiled into the runtime and its
 * strings are not part of the declaration file.
 *
 * The host synthesizes `ui.render` for `component: 'Pane'` on
 * `surface: 'terminal'`, for the mod's own panes only: that is the one render
 * site this host owns. `ToolUse`, `ContextMenu` and the other components have
 * no host drawing site here and stay documented as planned.
 *
 * Two further behaviours are derived and are labelled as such in
 * `docs/ARCHITECTURE.md`:
 *
 * - a tree the pin would reject is not drawn. Upstream falls back to the
 *   engine's own component (12506-12512) and this host has nothing to draw, so
 *   the pane keeps its last validated tree and its revision; only a pane that
 *   never drew is reported unplaced (`isPlaced: false`, 19546-19597).
 * - `press` handles are recorded as data (the pin stamps them), but no press is
 *   delivered because there is no surface to deliver it from.
 *
 * `ui.ask` is declared by the pin (2856) but answers through a person; the
 * host has no interaction, so it stays a typed refusal.
 *
 * `ui.render` is dispatched by the materializer through the same kernel
 * (`runChain`, `mode: 'wrap'`, tier `user`) as every other mod event — it is
 * not a host event, but it is not a second path either (AGENTS §3.6).
 */
import { describeValue, messageOf } from './errors.ts'
import type { ModBridgeErrorCode } from './bridge.ts'

/** The four surfaces the pin's element tables cover (`RenderSurface`, d.ts:13952 @ 2.1.329). */
export const UI_SURFACES = ['terminal', 'desktop', 'mobile', 'vscode'] as const
export type UiSurface = (typeof UI_SURFACES)[number]

/**
 * The components a `ui.render` hook can be registered for (`RenderComponent`,
 * claude-code.d.ts:12503 @ 2.1.329). This is what a matcher may name and what
 * `$.ui.resolve` accepts.
 */
export const UI_COMPONENTS = [
  'AskUserQuestion',
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'ToolProgress',
  'CommandOutput',
  'Spinner',
  'TurnDuration',
  'InfoNotice',
  'SessionMode',
  'PromptHint',
  'AbovePrompt',
  'AbovePromptList',
  'AgentRow',
  'ContextMenu',
  'Pane',
  'Placed',
  'Backdrop',
] as const
export type UiComponent = (typeof UI_COMPONENTS)[number]

/** The viewport a render hook sees (`RenderViewport`, d.ts:13962 @ 2.1.329). */
export interface UiRenderViewport {
  readonly columns: number
  readonly rows: number
  readonly isFullscreen?: boolean
}

/**
 * What the host hands the render chain: the pinned `RenderInput` minus the
 * members only a real surface can fill (`RenderInputOf`, claude-code.d.ts:12893 @ 2.1.329). `props` is doubled as `RenderPropsOf[C]`, because the sink cannot
 * type a union here and the render hook reads the members it knows.
 */
export interface UiRenderRequest {
  readonly surface: UiSurface
  readonly component: UiComponent
  readonly requestId: string
  readonly plugin: string
  readonly viewport: UiRenderViewport
  readonly props: Readonly<Record<string, unknown>>
}

/** The pinned `ResolveInput`: the surface and the component, never the props (d.ts:13998 @ 2.1.329). */
export interface UiResolveInput {
  readonly surface: UiSurface
  readonly component: UiComponent
}

/** A constructor the element table hands a render hook (`ElementConstructor`, d.ts:4753 @ 2.1.329). */
export type UiElementConstructor = (props?: unknown, ...children: unknown[]) => unknown

/** One surface's element table (`Elements[P]`, d.ts:4776 @ 2.1.329). */
export type UiElementTable = Readonly<Record<string, UiElementConstructor>>

/** One recorded pane, as the debug tool reads it. */
export interface UiPaneSnapshot {
  readonly plugin: string
  readonly id: string
  readonly title: string
  /** Monotonic per pane: bumped by every successful draw. */
  readonly revision: number
  readonly isPlaced: boolean
  readonly isFocused: boolean
  readonly placement: 'dock' | 'inline' | 'widget'
  readonly rows: number
  readonly columns: number
  /** The latest validated tree; absent while the pane has never drawn one. */
  readonly tree?: unknown
  /** Why the latest render did not place a tree. */
  readonly refusal?: string
}

/** One `$.ui.log` entry (`UiLogSink`, d.ts:19423 @ 2.1.329). */
export interface UiLogRecord {
  readonly text: string
  readonly to: 'transcript' | 'debug'
}

/** Everything one plugin's sink recorded; the tool aggregates these. */
export interface UiSinkSnapshot {
  readonly kind: 'mod-ui-headless'
  readonly plugin: string
  readonly surface: UiSurface
  readonly viewport: UiRenderViewport
  readonly panes: readonly UiPaneSnapshot[]
  readonly status?: string
  readonly logs: readonly UiLogRecord[]
  readonly invalidations: readonly string[]
  /** Typed refusals the sink made instead of throwing into the mod. */
  readonly refusals: readonly string[]
}

/** What the bridge exposes outside `$`, for the `mod_ui` tool. */
export interface ModUiSink {
  open(pane: unknown): Promise<unknown>
  close(pane: unknown): Promise<void>
  invalidate(event: unknown): void
  status(text: unknown): void
  log(text: unknown, options?: unknown): void
  resolve(input: unknown): unknown
  ask(): Promise<never>
  snapshot(): UiSinkSnapshot
  /** Resolves when every queued render (e.g. from `invalidate`) has settled. */
  settle(): Promise<void>
  dispose(): void
}

export interface UiSinkOptions {
  readonly plugin: string
  /** The declared surface; the headless sink is a termless stand-in for it. */
  readonly surface?: UiSurface
  /** The host's `ui.render` chain; absent means the engine draws (ref 0). */
  readonly render?: (request: UiRenderRequest) => unknown | Promise<unknown>
  /** The host's `ui.resolve` chain; absent means the surface's own table. */
  readonly resolve?: (input: UiResolveInput) => unknown
  /** Drops one host cache the seat owns (`prompt.context`/`prompt.section`). */
  readonly dropCache?: (event: string) => boolean
  /** The plugin currently holding a pane id, when another one does. */
  readonly ownerOf?: (id: string) => string | undefined
  readonly claim?: (id: string) => void
  readonly release?: (id: string) => void
  readonly onChange?: () => void
  readonly warn?: (message: string) => void
  readonly viewport?: UiRenderViewport
  /** The bridge's typed-failure factory (keeps one error type and one plugin prefix). */
  readonly refuse: (code: ModBridgeErrorCode, reason: string) => never
}

export type UiTreeValidation = { ok: true; tree: unknown } | { ok: false; refusal: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isWhole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** A title the pin refuses (`PaneOpenArgs.title`, claude-code.d.ts:9356 @ 2.1.329). */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/** `UiLogSink` (`claude-code.d.ts:19423` @ 2.1.329). */
const isLogSink = (value: unknown): value is 'transcript' | 'debug' =>
  value === 'transcript' || value === 'debug'

// ---- the pinned element schema -------------------------------------------

/**
 * The props a `Box` may carry (`BoxProps`, claude-code.d.ts:1280 @ 2.1.329).
 * `hover` is not here: it is an element member (`StyledElement`, 16359), and a
 * `Box` tree puts it beside `props`, not inside.
 */
const BOX_PROPS = [
  'key',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'flexDirection',
  'flexGrow',
  'flexShrink',
  'flexWrap',
  'alignItems',
  'alignSelf',
  'justifyContent',
  'gap',
  'columnGap',
  'rowGap',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'margin',
  'marginX',
  'marginY',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'padding',
  'paddingX',
  'paddingY',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'borderStyle',
  'borderColor',
  'borderDimColor',
  'backgroundColor',
  'overflow',
  'overflowX',
  'display',
] as const

/** `TextProps` (claude-code.d.ts:16722 @ 2.1.329); `hover` is element-level and there is no `key`. */
const TEXT_PROPS = [
  'color',
  'backgroundColor',
  'dimColor',
  'size',
  'weight',
  'mono',
  'tabular',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'inverse',
  'dir',
  'wrap',
  'maxLines',
] as const

/** `BoxHoverProps` (claude-code.d.ts:1240 @ 2.1.329). */
const BOX_HOVER_PROPS = [
  'scope',
  'borderStyle',
  'borderColor',
  'borderDimColor',
  'backgroundColor',
  'display',
  'top',
  'left',
  'right',
  'bottom',
] as const

/** `TextHoverProps` (claude-code.d.ts:16698 @ 2.1.329). */
const TEXT_HOVER_PROPS = [
  'scope',
  'color',
  'backgroundColor',
  'dimColor',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'inverse',
] as const

/**
 * One pinned prop type, from the declaration the tag's `*Props` names: scalars,
 * literal unions, `Space` steps, `Color`, `ImageSource`, and the two object
 * shapes a tree may carry (`SelectOption[]`, `Shader.values`).
 */
type PropRule =
  | 'string'
  | 'number'
  | 'boolean'
  | 'true'
  | 'number-or-string'
  | 'space'
  | 'color'
  | 'string-list'
  | 'options'
  | 'number-record'
  | 'json'
  | 'image-source'
  | { readonly oneOf: readonly string[] }

const oneOf = (...values: readonly string[]): PropRule => ({ oneOf: values })

/** `Space` (claude-code.d.ts:16051 @ 2.1.329). */
const SPACE_STEPS = ['xs', 'sm', 'md', 'lg', 'xl'] as const

/** `SelectOption` (claude-code.d.ts:14050 @ 2.1.329). */
const selectOptionsError = (tag: string, prop: string, value: unknown): string | undefined => {
  const quoted = JSON.stringify(prop)
  if (!Array.isArray(value) || value.length === 0) {
    return `${tag} prop ${quoted} must be a non-empty list of { value, label? } options`
  }
  for (const option of value) {
    if (!isRecord(option)) {
      return `${tag} prop ${quoted} option is ${describeValue(option)}; expected { value, label? }`
    }
    for (const key of Object.keys(option)) {
      if (key !== 'value' && key !== 'label') {
        return `${tag} prop ${quoted} option member ${JSON.stringify(key)} is not allowed`
      }
    }
    if (typeof option.value !== 'string') {
      return `${tag} prop ${quoted} option "value" must be a string`
    }
    if (option.label !== undefined && typeof option.label !== 'string') {
      return `${tag} prop ${quoted} option "label" must be a string`
    }
  }
  return undefined
}

/** `ImageSource` (claude-code.d.ts:6997-7081 @ 2.1.329): five pinned shapes, no others. */
const imageSourceIsValid = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const only = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key))
  const pixelRange = (candidate: unknown, atLeast: number, atMost: number): boolean =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= atLeast && candidate <= atMost
  const generationOk = value.generation === undefined || isWhole(value.generation)
  if (hasOwn(value, 'png')) return only('png') && typeof value.png === 'string'
  if (hasOwn(value, 'rgba')) {
    return (
      only('rgba', 'width', 'height') &&
      typeof value.rgba === 'string' &&
      pixelRange(value.width, 1, 2048) &&
      pixelRange(value.height, 1, 2048)
    )
  }
  if (hasOwn(value, 'file')) {
    if (!only('file', 'format', 'width', 'height', 'generation') || typeof value.file !== 'string' || !generationOk) {
      return false
    }
    if (value.format === 'png') return value.width === undefined && value.height === undefined
    if (value.format === 'rgba' || value.format === 'rgb') {
      return pixelRange(value.width, 1, 4096) && pixelRange(value.height, 1, 4096)
    }
    return false
  }
  if (hasOwn(value, 'shm')) {
    if (!only('shm', 'format', 'width', 'height', 'generation') || typeof value.shm !== 'string' || !generationOk) {
      return false
    }
    if (value.format !== 'rgba' && value.format !== 'rgb') return false
    return pixelRange(value.width, 1, 4096) && pixelRange(value.height, 1, 4096)
  }
  return false
}

const numberRecordError = (tag: string, prop: string, value: unknown): string | undefined => {
  const quoted = JSON.stringify(prop)
  if (!isRecord(value)) return `${tag} prop ${quoted} must be an object of finite numbers`
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return `${tag} prop ${quoted} value ${JSON.stringify(name)} must be a finite number`
    }
  }
  return undefined
}

const propValueError = (tag: string, prop: string, rule: PropRule, value: unknown): string | undefined => {
  const quoted = JSON.stringify(prop)
  if (rule === 'string') return typeof value === 'string' ? undefined : `${tag} prop ${quoted} must be a string`
  if (rule === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? undefined : `${tag} prop ${quoted} must be a number`
  }
  if (rule === 'boolean') return typeof value === 'boolean' ? undefined : `${tag} prop ${quoted} must be a boolean`
  if (rule === 'true') return value === true ? undefined : `${tag} prop ${quoted} must be true`
  if (rule === 'number-or-string') {
    return typeof value === 'number' || typeof value === 'string'
      ? undefined
      : `${tag} prop ${quoted} must be a number or a string`
  }
  if (rule === 'space') {
    return typeof value === 'number' || (typeof value === 'string' && (SPACE_STEPS as readonly string[]).includes(value))
      ? undefined
      : `${tag} prop ${quoted} must be a number or one of ${SPACE_STEPS.map((step) => JSON.stringify(step)).join(', ')}`
  }
  if (rule === 'color') return typeof value === 'string' ? undefined : `${tag} prop ${quoted} must be a color string`
  if (rule === 'string-list') {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
      ? undefined
      : `${tag} prop ${quoted} must be a list of strings`
  }
  if (rule === 'options') return selectOptionsError(tag, prop, value)
  if (rule === 'number-record') return numberRecordError(tag, prop, value)
  if (rule === 'json') return undefined
  if (rule === 'image-source') {
    return imageSourceIsValid(value)
      ? undefined
      : `${tag} prop ${quoted} must be one of { png }, { rgba, width, height }, { file, format }, or { shm, format, width, height }`
  }
  const allowed = rule.oneOf.map((entry) => JSON.stringify(entry)).join(', ')
  return typeof value === 'string' && rule.oneOf.includes(value)
    ? undefined
    : `${tag} prop ${quoted} must be one of ${allowed}`
}

/**
 * The pinned type of every `props` member a tree may carry, per tag. Every
 * allowlisted holder below has an entry; `boxes and texts` carry only the
 * primitive types their declarations name, not the old "any primitive".
 */
const PROP_TYPES: Readonly<Record<string, Readonly<Record<string, PropRule>>>> = {
  Box: {
    key: 'string',
    position: oneOf('relative', 'absolute'),
    top: 'number',
    left: 'number',
    right: 'number',
    bottom: 'number',
    flexDirection: oneOf('row', 'column', 'row-reverse', 'column-reverse'),
    flexGrow: 'number',
    flexShrink: 'number',
    flexWrap: oneOf('nowrap', 'wrap', 'wrap-reverse'),
    alignItems: oneOf('flex-start', 'center', 'flex-end', 'stretch'),
    alignSelf: oneOf('flex-start', 'center', 'flex-end', 'auto'),
    justifyContent: oneOf('flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'),
    gap: 'space',
    columnGap: 'space',
    rowGap: 'space',
    width: 'number-or-string',
    height: 'number-or-string',
    minWidth: 'number-or-string',
    minHeight: 'number-or-string',
    margin: 'space',
    marginX: 'space',
    marginY: 'space',
    marginTop: 'space',
    marginBottom: 'space',
    marginLeft: 'space',
    marginRight: 'space',
    padding: 'space',
    paddingX: 'space',
    paddingY: 'space',
    paddingTop: 'space',
    paddingBottom: 'space',
    paddingLeft: 'space',
    paddingRight: 'space',
    borderStyle: 'string',
    borderColor: 'color',
    borderDimColor: 'boolean',
    backgroundColor: 'color',
    overflow: oneOf('visible', 'hidden'),
    overflowX: oneOf('visible', 'scroll'),
    display: oneOf('flex', 'none'),
  },
  Text: {
    color: 'color',
    backgroundColor: 'color',
    dimColor: 'boolean',
    size: oneOf('caption', 'footnote', 'body', 'heading', 'title'),
    weight: oneOf('regular', 'medium', 'semibold', 'bold'),
    mono: 'boolean',
    tabular: 'boolean',
    bold: 'boolean',
    italic: 'boolean',
    underline: 'boolean',
    strikethrough: 'boolean',
    inverse: 'boolean',
    dir: oneOf('ltr', 'rtl'),
    wrap: oneOf('wrap', 'end', 'middle', 'truncate', 'truncate-start', 'truncate-middle', 'truncate-end', 'clip'),
    maxLines: 'number',
  },
  Button: {
    key: 'string',
    label: 'string',
    hotkey: 'string',
    action: 'string',
    plain: 'true',
    dimColor: 'boolean',
    variant: oneOf('primary', 'secondary'),
    role: oneOf('dismiss'),
    autoFocus: 'true',
  },
  Input: {
    key: 'string',
    label: 'string',
    placeholder: 'string',
    value: 'string',
    submitLabel: 'string',
    rows: 'number',
    autoFocus: 'true',
  },
  Select: { key: 'string', label: 'string', options: 'options', value: 'string', autoFocus: 'true' },
  Link: { href: 'string', label: 'string' },
  Code: {
    source: 'string',
    language: 'string',
    path: 'string',
    startLine: 'number',
    format: oneOf('source', 'diff'),
    wrap: oneOf('wrap', 'truncate-end'),
  },
  Markdown: { key: 'string', text: 'string', dimColor: 'boolean', pressableLinks: 'string-list' },
  Progress: { label: 'string', value: 'number', max: 'number', valueText: 'string', color: 'color' },
  Client: {
    key: 'string',
    module: 'string',
    props: 'json',
    width: 'number-or-string',
    height: 'number-or-string',
    flexGrow: 'number',
  },
  Svg: { source: 'string', alt: 'string', width: 'number', height: 'number', isInteractive: 'boolean' },
  Shader: { module: 'string', values: 'number-record' },
  Raster: { key: 'string', columns: 'number', rows: 'number', cells: 'string' },
  Image: { key: 'string', source: 'image-source', columns: 'number', rows: 'number', alt: 'string' },
}

const BOX_HOVER_TYPES: Readonly<Record<string, PropRule>> = {
  scope: 'string',
  borderStyle: 'string',
  borderColor: 'color',
  borderDimColor: 'boolean',
  backgroundColor: 'color',
  display: oneOf('flex'),
  top: 'number',
  left: 'number',
  right: 'number',
  bottom: 'number',
}

const TEXT_HOVER_TYPES: Readonly<Record<string, PropRule>> = {
  scope: 'string',
  color: 'color',
  backgroundColor: 'color',
  dimColor: 'boolean',
  bold: 'boolean',
  italic: 'boolean',
  underline: 'boolean',
  strikethrough: 'boolean',
  inverse: 'boolean',
}

interface ElementRule {
  /** Members of the tree node itself. */
  readonly keys: readonly string[]
  /** Members of `props`; the tree's own allowlist for this tag. */
  readonly props: readonly string[]
  /** What `children` may hold, when anything. */
  readonly children: 'nodes' | 'inline' | 'button' | 'none'
  /** `props` members the pinned declaration marks required. */
  readonly required?: readonly string[]
  /** Which hover allowlist applies. */
  readonly hover?: 'box' | 'text'
  /** Whether the tree node carries a `press` handle, and whether it must. */
  readonly press?: 'required' | 'optional'
  /** Required runtime stamps (`client`, `raster`, `image`). */
  readonly requiredStamps?: readonly string[]
}

const STYLED_KEYS = ['type', 'props', 'hover', 'group', 'part', 'children'] as const

/**
 * The tree-node and prop allowlists, one entry per tag in `RenderElement`
 * (claude-code.d.ts:12513-12884 @ 2.1.329). The constructor-side members
 * (`onPress`, `onInput`, `onSubmit`, `onSelect`, `onLinkPress`) are not here:
 * they are stamped into `press` and must not survive into the tree.
 */
const ELEMENT_RULES: Readonly<Record<string, ElementRule>> = {
  Box: { keys: STYLED_KEYS, props: BOX_PROPS, children: 'nodes', hover: 'box' },
  Text: { keys: STYLED_KEYS, props: TEXT_PROPS, children: 'inline', hover: 'text' },
  Button: {
    keys: ['type', 'props', 'press', 'hover', 'children'],
    props: ['key', 'label', 'hotkey', 'action', 'plain', 'dimColor', 'variant', 'role', 'autoFocus'],
    children: 'button',
    required: ['key', 'label'],
    press: 'required',
    hover: 'text',
  },
  Input: {
    keys: ['type', 'props', 'press'],
    props: ['key', 'label', 'placeholder', 'value', 'submitLabel', 'rows', 'autoFocus'],
    children: 'none',
    required: ['key'],
    press: 'required',
  },
  Select: {
    keys: ['type', 'props', 'press'],
    props: ['key', 'label', 'options', 'value', 'autoFocus'],
    children: 'none',
    required: ['key', 'options'],
    press: 'required',
  },
  Link: {
    keys: ['type', 'props', 'children'],
    props: ['href', 'label'],
    children: 'inline',
    required: ['href'],
  },
  Code: {
    keys: ['type', 'props'],
    props: ['source', 'language', 'path', 'startLine', 'format', 'wrap'],
    children: 'none',
    required: ['source'],
  },
  Markdown: {
    keys: ['type', 'props', 'part', 'press'],
    props: ['key', 'text', 'dimColor', 'pressableLinks'],
    children: 'none',
    required: ['text'],
    press: 'optional',
  },
  Client: {
    keys: ['type', 'props', 'client'],
    props: ['key', 'module', 'props', 'width', 'height', 'flexGrow'],
    children: 'none',
    required: ['key', 'module'],
    requiredStamps: ['client'],
  },
  Svg: {
    keys: ['type', 'props'],
    props: ['source', 'alt', 'width', 'height', 'isInteractive'],
    children: 'none',
    required: ['source', 'alt'],
  },
  Shader: {
    keys: ['type', 'props', 'shader', 'children'],
    props: ['module', 'values'],
    children: 'nodes',
    required: ['module'],
  },
  Progress: {
    keys: ['type', 'props'],
    props: ['label', 'value', 'max', 'valueText', 'color'],
    children: 'none',
    required: ['label'],
  },
  Raster: {
    keys: ['type', 'props', 'raster'],
    props: ['key', 'columns', 'rows', 'cells'],
    children: 'none',
    required: ['key', 'columns', 'rows', 'cells'],
    requiredStamps: ['raster'],
  },
  Image: {
    keys: ['type', 'props', 'image'],
    props: ['key', 'source', 'columns', 'rows', 'alt'],
    children: 'none',
    required: ['source', 'columns', 'rows', 'alt'],
    requiredStamps: ['image'],
  },
  engine: { keys: ['type', 'ref'], props: [], children: 'none' },
}

const MAX_TREE_DEPTH = 64
const MAX_TREE_NODES = 4096

const stampIsValid = (value: unknown): boolean => isRecord(value) && typeof value.plugin === 'string'

/** The element names one surface declares (`Elements`, claude-code.d.ts:4776 @ 2.1.329). */
const ELEMENT_TAGS: Readonly<Record<UiSurface, readonly string[]>> = {
  terminal: [
    'Box',
    'Text',
    'Button',
    'Input',
    'Select',
    'Link',
    'Code',
    'Markdown',
    'Progress',
    'Client',
    'Raster',
    'Image',
  ],
  desktop: ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Progress', 'Client', 'Svg', 'Shader'],
  mobile: ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Progress', 'Svg', 'Shader'],
  vscode: ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Progress', 'Svg'],
}

/**
 * Validate one submitted tree against the pinned element schema for `surface`.
 *
 * `component` names the render site in every refusal (`a tree Pane refuses:
 * ...`), because that is the sentence a mod author has to be able to find. The
 * check is structural, not a TypeScript compile: the tree is plain data (the
 * host's render chain never hands back a hook), so the allowlists, required
 * members and surface table above are the whole contract. A tag the surface
 * does not declare refuses even when the pin declares it elsewhere.
 */
export const validateUiTree = (
  tree: unknown,
  component: string,
  surface: UiSurface = 'terminal',
): UiTreeValidation => {
  const name = `a tree ${component}`
  const refuse = (reason: string): UiTreeValidation => ({ ok: false, refusal: `${name} refuses: ${reason}` })
  const declared = ELEMENT_TAGS[surface] ?? ELEMENT_TAGS.terminal
  let nodes = 0
  const seen = new WeakSet<object>()

  const walk = (node: unknown, depth: number, parent: 'nodes' | 'inline' | 'button' | 'root'): string | undefined => {
    if (depth > MAX_TREE_DEPTH) return `the tree nests deeper than ${MAX_TREE_DEPTH} elements`
    if (typeof node === 'string') {
      if (parent === 'inline' || parent === 'button' || parent === 'nodes' || parent === 'root') return undefined
      return undefined
    }
    if (!isRecord(node)) return `a child is ${describeValue(node)}; elements and strings only`
    if (seen.has(node)) return 'the tree contains a cycle'
    seen.add(node)
    nodes += 1
    if (nodes > MAX_TREE_NODES) return `the tree holds more than ${MAX_TREE_NODES} elements`
    const type = node.type
    if (typeof type !== 'string') return `element type is ${describeValue(type)}; expected a tag string`
    if (type !== 'engine' && !declared.includes(type)) {
      return `${type} is not declared on the ${surface} surface`
    }
    const rule = ELEMENT_RULES[type]
    if (rule === undefined) return `element type ${describeValue(type)} is not one the pin declares`
    for (const key of Object.keys(node)) {
      if (!rule.keys.includes(key)) return `${type} member ${JSON.stringify(key)} is not allowed`
    }
    for (const key of rule.requiredStamps ?? []) {
      if (!hasOwn(node, key)) return `${type} ${key} stamp is required`
      if (!stampIsValid(node[key])) return `${type} ${key} must be { plugin: string }`
    }
    for (const key of ['group', 'part', 'client', 'raster', 'image', 'shader']) {
      if (hasOwn(node, key) && !stampIsValid(node[key])) return `${type} ${key} must be { plugin: string }`
    }
    if (rule.press === 'required') {
      if (!hasOwn(node, 'press')) return `${type} press is required`
    }
    if (rule.press !== undefined && hasOwn(node, 'press')) {
      const press = node.press
      if (!isRecord(press) || typeof press.plugin !== 'string' || !isWhole(press.handle)) {
        return `${type} press must be { plugin: string, handle: number }`
      }
    }
    if (rule.hover !== undefined && hasOwn(node, 'hover')) {
      const hover = node.hover
      if (!isRecord(hover)) return `${type} hover must be an object`
      const allowed = rule.hover === 'box' ? BOX_HOVER_PROPS : TEXT_HOVER_PROPS
      const hoverTypes = rule.hover === 'box' ? BOX_HOVER_TYPES : TEXT_HOVER_TYPES
      for (const key of Object.keys(hover)) {
        if (!(allowed as readonly string[]).includes(key)) return `${type} hover ${JSON.stringify(key)} is not allowed`
      }
      for (const [key, value] of Object.entries(hover)) {
        const typed = hoverTypes[key]
        if (typed === undefined) return `${type} hover ${JSON.stringify(key)} is not allowed`
        const problem = propValueError(`${type} hover`, key, typed, value)
        if (problem !== undefined) return problem
      }
    }
    if (type === 'engine') {
      if (!isWhole(node.ref)) return 'engine ref must be a non-negative whole number'
      if (hasOwn(node, 'props') || hasOwn(node, 'children')) return 'engine carries a ref only'
      return undefined
    }
    if (hasOwn(node, 'props')) {
      const props = node.props
      if (props === undefined || props === null) {
        // An absent `props` is the pinned `props?`; null is not.
        if (props !== undefined) return `${type} props must be an object`
      } else {
        if (!isRecord(props)) return `${type} props must be an object`
        for (const key of Object.keys(props)) {
          if (!rule.props.includes(key)) return `${type} prop ${JSON.stringify(key)} is not allowed`
        }
        for (const key of rule.required ?? []) {
          if (!hasOwn(props, key)) return `${type} prop ${JSON.stringify(key)} is required`
        }
        for (const [key, value] of Object.entries(props)) {
          const typed = PROP_TYPES[type]?.[key]
          if (typed === undefined) return `${type} prop ${JSON.stringify(key)} has no pinned type`
          const problem = propValueError(type, key, typed, value)
          if (problem !== undefined) return problem
        }
      }
    } else {
      for (const key of rule.required ?? []) return `${type} prop ${JSON.stringify(key)} is required`
    }
    if (parent === 'inline' && type === 'engine') return 'inline children cannot hold an engine node'
    if (!hasOwn(node, 'children')) return undefined
    const children = node.children
    if (children === undefined) return undefined
    if (!Array.isArray(children)) return `${type} children must be an array`
    if (rule.children === 'none' && children.length > 0) return `${type} has no children`
    for (const child of children) {
      if (typeof child === 'string') continue
      if (!isRecord(child)) return `${type} child is ${describeValue(child)}; elements and strings only`
      const childType = child.type
      if (rule.children === 'inline' && childType === 'engine') return `${type} children cannot hold an engine node`
      if (rule.children === 'button' && childType !== 'Text') {
        return `${type} children may be strings and Text, not ${describeValue(childType)}`
      }
      if (rule.children === 'inline' && childType !== 'Text' && childType !== 'Link') {
        return `${type} children may be strings, Text and Link, not ${describeValue(childType)}`
      }
      const childParent = rule.children === 'nodes' ? 'nodes' : rule.children
      const problem = walk(child, depth + 1, childParent)
      if (problem !== undefined) return problem
    }
    return undefined
  }

  const rootRule = isRecord(tree) ? ELEMENT_RULES[String(tree.type)] : undefined
  const problem = walk(tree, 0, rootRule?.children === 'inline' ? 'inline' : 'root')
  if (problem !== undefined) return refuse(problem)
  return { ok: true, tree }
}

// ---- the element tables ---------------------------------------------------

/** Constructor-only members, stamped into `press` instead of the tree. */
const PRESS_MEMBERS: Readonly<Record<string, string>> = {
  Button: 'onPress',
  Input: 'onSubmit',
  Select: 'onSelect',
  Markdown: 'onLinkPress',
}

/** The runtime stamps the pin adds around a constructor call (`client`, `raster`, `image`). */
const STAMP_MEMBERS: Readonly<Record<string, string>> = {
  Client: 'client',
  Raster: 'raster',
  Image: 'image',
}

const flattenChildren = (value: unknown, into: unknown[]): void => {
  if (Array.isArray(value)) {
    for (const child of value) flattenChildren(child, into)
    return
  }
  if (value === null || value === undefined) return
  if (typeof value === 'boolean') return
  if (typeof value === 'number') {
    into.push(String(value))
    return
  }
  into.push(value)
}

const constructorOf = (tag: string, plugin: string, nextHandle: () => number): UiElementConstructor => {
  if (tag === 'engine') return () => ({ type: 'engine', ref: 0 })
  return (props?: unknown, ...children: unknown[]): unknown => {
    const collected: unknown[] = []
    let source: Record<string, unknown> = {}
    if (isRecord(props)) source = props
    else if (props !== undefined && props !== null) flattenChildren(props, collected)
    for (const child of children) flattenChildren(child, collected)
    const node: Record<string, unknown> = { type: tag }
    const treeProps: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      if (key === 'children') {
        flattenChildren(value, collected)
        continue
      }
      if (key === 'hover' || key === 'group' || key === 'part' || key === 'press') continue
      if (PRESS_MEMBERS[tag] === key) continue
      treeProps[key] = value
    }
    if (tag === 'Button') {
      // The pin defaults `key` to `label`, and both to the one string child
      // (`RenderElement` Button entry, claude-code.d.ts:12533-12600 @ 2.1.329).
      if (treeProps.label === undefined && collected.length === 1 && typeof collected[0] === 'string') {
        treeProps.label = collected[0]
      }
      if (treeProps.key === undefined && typeof treeProps.label === 'string') {
        treeProps.key = treeProps.label
      }
    }
    if (Object.keys(treeProps).length > 0) node.props = treeProps
    const hover = isRecord(source.hover) ? source.hover : undefined
    if (hover !== undefined) node.hover = hover
    if (isRecord(source.group)) node.group = source.group
    if (isRecord(source.part)) node.part = source.part
    const stamp = STAMP_MEMBERS[tag]
    if (stamp !== undefined) node[stamp] = { plugin }
    if (PRESS_MEMBERS[tag] !== undefined) {
      node.press = { plugin, handle: nextHandle() }
    }
    if (collected.length > 0) node.children = collected
    return node
  }
}

const tableCache = new Map<string, UiElementTable>()

/**
 * The element constructors one render site hands a mod: the pinned table for
 * `surface`, with every `press` and required runtime stamp bound to this
 * plugin. The constructors return plain descriptors — nothing draws, and the
 * descriptor is exactly what `validateUiTree` checks.
 */
export const elementsForSurface = (surface: UiSurface, plugin: string): UiElementTable => {
  const cacheKey = `${surface}\u0000${plugin}`
  const cached = tableCache.get(cacheKey)
  if (cached !== undefined) return cached
  let handle = 0
  const table: Record<string, UiElementConstructor> = {}
  for (const tag of ELEMENT_TAGS[surface]) {
    table[tag] = constructorOf(tag, plugin, () => {
      handle += 1
      return handle
    })
  }
  const frozen = Object.freeze(table)
  tableCache.set(cacheKey, frozen)
  return frozen
}

// ---- matchers and patterns -------------------------------------------------

const isUiSurface = (value: unknown): value is UiSurface =>
  typeof value === 'string' && (UI_SURFACES as readonly string[]).includes(value)

const isUiComponent = (value: unknown): value is UiComponent =>
  typeof value === 'string' && (UI_COMPONENTS as readonly string[]).includes(value)

/** The fields a `ui.render` matcher may narrow on (Matcher, d.ts:7460 @ 2.1.329). */
const RENDER_MATCHER_FIELDS = new Set(['component', 'requestId', 'surface', 'plugin', 'viewport', 'props'])

/**
 * One pinned matcher leaf: equality, a RegExp against the value as a string, an
 * array of alternatives, or a partial object (d.ts:7460-7545 @ 2.1.329). An
 * array VALUE holds when one of its elements matches.
 */
const matcherValueMatches = (rule: unknown, value: unknown): boolean => {
  if (Array.isArray(value)) return value.some((entry) => matcherValueMatches(rule, entry))
  if (rule instanceof RegExp) return rule.test(String(value))
  if (Array.isArray(rule)) return rule.some((entry) => matcherValueMatches(entry, value))
  if (isRecord(rule)) {
    if (!isRecord(value)) return false
    return Object.entries(rule).every(([key, entry]) => matcherValueMatches(entry, value[key]))
  }
  return rule === value
}

/**
 * Whether one authored `ui.render` matcher selects this request. `props` is a
 * partial object match, the same reading as the pin's ContextMenu example
 * (`{ component: 'ContextMenu', props: { link: { href: /.../ } } }`,
 * claude-code.d.ts:13723 @ 2.1.329).
 */
export const uiRenderMatcherMatches = (matcher: unknown, request: unknown): boolean => {
  if (matcher === undefined || matcher === null) return true
  if (!isRecord(matcher)) return false
  for (const [key, rule] of Object.entries(matcher)) {
    if (!RENDER_MATCHER_FIELDS.has(key)) return false
    // `plugin: "*"` names every plugin, an `e` without the key included
    // (Matcher doc, claude-code.d.ts:7520-7545 @ 2.1.329).
    if (key === 'plugin' && rule === '*') continue
    const value = isRecord(request) ? request[key] : undefined
    if (!matcherValueMatches(rule, value)) return false
  }
  return true
}

const escapeRegExpCharacter = (character: string): string =>
  character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether one authored event name selects `event`. A pattern is the pin's
 * `EventName | Glob | Negation` (d.ts:9447 @ 2.1.329): `*` and `classic.*`
 * globs, and `!` negatives. This is what makes `on('ui.*')` reach a
 * `ui.render` dispatch.
 */
export const uiEventPatternMatches = (pattern: unknown, event: string): boolean => {
  if (typeof pattern === 'string') {
    const trimmed = pattern.trim()
    if (trimmed === '') return false
    if (trimmed.startsWith('!')) return !uiEventPatternMatches(trimmed.slice(1), event)
    if (trimmed === '*') return true
    let source = ''
    for (const character of trimmed) {
      source += character === '*' ? '.*' : escapeRegExpCharacter(character)
    }
    return new RegExp(`^${source}$`).test(event)
  }
  if (Array.isArray(pattern)) return pattern.some((entry) => uiEventPatternMatches(entry, event))
  return false
}

/** What `next(e)` resolves to when no hook below rewrites the tree. */
export const UI_ENGINE_NODE = Object.freeze({ type: 'engine', ref: 0 })

// ---- the sink -------------------------------------------------------------

const DEFAULT_VIEWPORT: UiRenderViewport = Object.freeze({
  columns: 80,
  rows: 24,
  isFullscreen: false,
})

/** `InvalidatableEventName` (claude-code.d.ts:7229 @ 2.1.329). */
const INVALIDATABLE_EVENTS = [
  'ui.render',
  'prompt.section',
  'prompt.context',
  'prompt.attachment',
  'tool.describe',
  'tool.list',
  'command.describe',
  'config.describe',
] as const

interface PaneState {
  readonly id: string
  title: string
  revision: number
  isPlaced: boolean
  placement: 'dock' | 'inline' | 'widget'
  rows: number
  columns: number
  tree: unknown
  refusal: string | undefined
}

export const createUiSink = (options: UiSinkOptions): ModUiSink => {
  const plugin = options.plugin
  const surface = options.surface ?? 'terminal'
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  const panes = new Map<string, PaneState>()
  const logs: UiLogRecord[] = []
  const invalidations: string[] = []
  const refusals: string[] = []
  let status: string | undefined
  let focused: string | undefined
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  const onChange = (): void => {
    try {
      options.onChange?.()
    } catch (error) {
      options.warn?.(`ui sink change listener failed: ${messageOf(error)}`)
    }
  }

  const recordRefusal = (refusal: string): void => {
    refusals.push(refusal)
    options.warn?.(refusal)
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task, task).catch((error: unknown) => {
      recordRefusal(`a pane render refused: ${messageOf(error)}`)
    })
    queue = run
    return run
  }

  const draw = async (pane: PaneState): Promise<void> => {
    if (disposed) return
    const request: UiRenderRequest = {
      surface,
      component: 'Pane',
      requestId: pane.id,
      plugin,
      viewport,
      props: {
        title: pane.title,
        isFocused: focused === pane.id,
        bodyColumns: Math.max(1, pane.columns - 2),
        placement: pane.placement,
        scroll: { offset: 0, bodyRows: Math.max(1, pane.rows - 2) },
        view: {},
      },
    }
    let tree: unknown
    let problem: string | undefined
    if (options.render === undefined) {
      tree = UI_ENGINE_NODE
    } else {
      try {
        tree = await options.render(request)
      } catch (error) {
        problem = `the render hook threw: ${messageOf(error)}`
      }
      if (problem === undefined) {
        const checked = validateUiTree(tree, request.component, surface)
        if (checked.ok) tree = checked.tree
        else problem = checked.refusal
      }
    }
    if (disposed) return
    if (problem === undefined) {
      pane.tree = tree
      pane.refusal = undefined
      pane.isPlaced = true
      pane.revision += 1
    } else {
      // Derived fallback: upstream draws the engine's own component
      // (claude-code.d.ts:12506-12512 @ 2.1.329) and this host has no drawing,
      // so the last validated tree stays and the refusal is recorded beside it.
      // `isPlaced: false` is reserved for a pane that never drew (19546-19597).
      pane.refusal = problem.startsWith(`a tree ${request.component} refuses:`)
        ? problem
        : `a tree ${request.component} refuses: ${problem}`
      recordRefusal(pane.refusal)
      if (pane.tree === undefined) {
        pane.isPlaced = false
        pane.revision = 0
      }
    }
    onChange()
  }

  const open = async (raw: unknown): Promise<unknown> => {
    if (disposed) return { isPlaced: false, reason: 'the bridge was disposed; a pane has nowhere to land' }
    if (!isRecord(raw)) {
      return {
        isPlaced: false,
        reason: `$.ui.open: the pane argument was ${describeValue(raw)}; expected { id }`,
      }
    }
    const id = raw.id
    if (typeof id !== 'string' || !PANE_ID.test(id)) {
      return {
        isPlaced: false,
        reason: '$.ui.open: the pane id must be 1-64 characters of letters, digits, "_" or "-"',
      }
    }
    if (hasOwn(raw, 'title') && typeof raw.title !== 'string') {
      return { isPlaced: false, reason: '$.ui.open: the pane title must be a string' }
    }
    if (typeof raw.title === 'string' && CONTROL_CHARACTER.test(raw.title)) {
      // PaneOpenArgs.title refuses a control character (d.ts:9356 @ 2.1.329).
      return { isPlaced: false, reason: '$.ui.open: the pane title contains a control character' }
    }
    for (const size of ['rows', 'columns'] as const) {
      if (hasOwn(raw, size) && !isPositive(raw[size])) {
        return { isPlaced: false, reason: `$.ui.open: the pane ${size} must be a positive whole number` }
      }
    }
    // `placement` is 'widget' or ignored: a surface without widgets opens as if
    // the member were left out (d.ts:9435-9441 @ 2.1.329). A non-widget value
    // is not an error.
    const existing = panes.get(id)
    if (existing === undefined) {
      const owner = options.ownerOf?.(id)
      if (owner !== undefined && owner !== plugin) {
        return {
          isPlaced: false,
          reason: `$.ui.open: pane id ${JSON.stringify(id)} is already held by ${owner}`,
        }
      }
    }
    const pane: PaneState = existing ?? {
      id,
      title: id,
      revision: 0,
      isPlaced: false,
      placement: 'dock',
      rows: viewport.rows,
      columns: viewport.columns,
      tree: undefined,
      refusal: undefined,
    }
    if (typeof raw.title === 'string') pane.title = raw.title
    if (isPositive(raw.rows)) pane.rows = raw.rows
    if (isPositive(raw.columns)) pane.columns = raw.columns
    if (raw.placement === 'widget') pane.placement = 'widget'
    if (raw.focus === true) focused = id
    if (existing === undefined) {
      panes.set(id, pane)
      options.claim?.(id)
    }
    await enqueue(() => draw(pane))
    if (pane.isPlaced) return { isPlaced: true }
    return { isPlaced: false, reason: pane.refusal ?? 'the pane was not drawn' }
  }

  const close = async (raw: unknown): Promise<void> => {
    if (disposed) return
    if (!isRecord(raw) || typeof raw.id !== 'string' || !PANE_ID.test(raw.id)) return
    if (!panes.delete(raw.id)) return
    options.release?.(raw.id)
    if (focused === raw.id) focused = panes.keys().next().value
    onChange()
  }

  const invalidate = (event: unknown): void => {
    if (disposed) return
    if (typeof event !== 'string') {
      recordRefusal(`$.ui.invalidate: the event name must be a string, got ${describeValue(event)}`)
      return
    }
    if (!(INVALIDATABLE_EVENTS as readonly string[]).includes(event)) {
      recordRefusal(
        `$.ui.invalidate: ${JSON.stringify(event)} is not an InvalidatableEventName (claude-code.d.ts:7229 @ 2.1.329)`,
      )
      return
    }
    invalidations.push(event)
    if (event === 'ui.render') {
      const snapshot = [...panes.values()]
      void enqueue(async () => {
        for (const pane of snapshot) {
          if (panes.has(pane.id)) await draw(pane)
        }
      }).then(onChange)
      return
    }
    if (event === 'prompt.section' || event === 'prompt.context') {
      const dropped = options.dropCache?.(event) === true
      if (!dropped) recordRefusal(`$.ui.invalidate: ${event} is refused: the sink owns no cache for this event`)
      onChange()
      return
    }
    // The engine caches the remaining invalidatable events, and this host has
    // no engine: a silent success would claim a cache that does not exist.
    recordRefusal(`$.ui.invalidate: ${event} is refused: the sink owns no cache for this event`)
  }

  const setStatus = (text: unknown): void => {
    if (disposed) return
    if (text === undefined) {
      status = undefined
      onChange()
      return
    }
    if (typeof text !== 'string') {
      recordRefusal(`$.ui.status: the status text must be a string or undefined, got ${describeValue(text)}`)
      return
    }
    status = text
    onChange()
  }

  const log = (text: unknown, rawOptions?: unknown): void => {
    if (disposed) return
    if (typeof text !== 'string') {
      recordRefusal(`$.ui.log: the log text must be a string, got ${describeValue(text)}`)
      return
    }
    let to: 'transcript' | 'debug' = 'transcript'
    if (rawOptions !== undefined) {
      if (!isRecord(rawOptions)) {
        recordRefusal(`$.ui.log: options must be an object, got ${describeValue(rawOptions)}`)
        return
      }
      if (hasOwn(rawOptions, 'to') && !isLogSink(rawOptions.to)) {
        recordRefusal(`$.ui.log: the log sink must be "transcript" or "debug", got ${describeValue(rawOptions.to)}`)
        return
      }
      if (isLogSink(rawOptions.to)) to = rawOptions.to
    }
    logs.push({ text, to })
    onChange()
  }

  const ask = async (): Promise<never> => {
    options.refuse(
      'ERR_MOD_HOST_UI_UNSUPPORTED',
      '$.ui.ask is refused: the pin declares it (claude-code.d.ts:2856 @ 2.1.329), but it answers through a person and this host has no interaction to carry the answer, so the question would land nowhere',
    )
  }

  const resolve = (input: unknown): unknown => {
    if (!isRecord(input)) {
      options.refuse(
        'ERR_MOD_HOST_UI_INPUT',
        `$.ui.resolve: expected a ResolveInput ({ surface, component }), got ${describeValue(input)}`,
      )
    }
    const requestedSurface = input.surface
    if (!isUiSurface(requestedSurface)) {
      options.refuse(
        'ERR_MOD_HOST_UI_INPUT',
        hasOwn(input, 'surface')
          ? `$.ui.resolve: surface ${describeValue(requestedSurface)} is not one of ${UI_SURFACES.join(', ')}`
          : `$.ui.resolve: the argument has no surface; expected one of ${UI_SURFACES.join(', ')}`,
      )
    }
    const component = input.component
    if (!isUiComponent(component)) {
      options.refuse(
        'ERR_MOD_HOST_UI_INPUT',
        hasOwn(input, 'component')
          ? `$.ui.resolve: component ${describeValue(component)} is not one the pin declares for a render site`
          : `$.ui.resolve: the argument has no component; expected one of ${UI_COMPONENTS.join(', ')}`,
      )
    }
    let table: unknown
    try {
      table =
        options.resolve === undefined
          ? elementsForSurface(requestedSurface as UiSurface, plugin)
          : options.resolve({ surface: requestedSurface as UiSurface, component: component as UiComponent })
    } catch (error) {
      options.refuse('ERR_MOD_HOST_UI_INPUT', `$.ui.resolve: the ui.resolve chain threw: ${messageOf(error)}`)
    }
    if (!isRecord(table)) {
      options.refuse(
        'ERR_MOD_HOST_UI_INPUT',
        `$.ui.resolve: the ui.resolve chain answered ${describeValue(table)}; expected the surface's element table`,
      )
    }
    for (const [name, constructor] of Object.entries(table)) {
      if (typeof constructor !== 'function') {
        options.refuse(
          'ERR_MOD_HOST_UI_INPUT',
          `$.ui.resolve: the ui.resolve chain answered ${name} as ${describeValue(constructor)}; expected an element constructor`,
        )
      }
    }
    return table
  }

  const snapshot = (): UiSinkSnapshot => ({
    kind: 'mod-ui-headless',
    plugin,
    surface,
    viewport,
    panes: [...panes.values()].map((pane) => ({
      plugin,
      id: pane.id,
      title: pane.title,
      revision: pane.revision,
      isPlaced: pane.isPlaced,
      isFocused: focused === pane.id,
      placement: pane.placement,
      rows: pane.rows,
      columns: pane.columns,
      ...(pane.tree === undefined ? {} : { tree: pane.tree }),
      ...(pane.refusal === undefined ? {} : { refusal: pane.refusal }),
    })),
    ...(status === undefined ? {} : { status }),
    logs: [...logs],
    invalidations: [...invalidations],
    refusals: [...refusals],
  })

  return {
    open,
    close,
    invalidate,
    status: setStatus,
    log,
    resolve,
    ask,
    snapshot,
    settle: async (): Promise<void> => {
      await queue
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      for (const id of panes.keys()) options.release?.(id)
      panes.clear()
      logs.length = 0
      invalidations.length = 0
      refusals.length = 0
      status = undefined
      focused = undefined
      onChange()
    },
  }
}
