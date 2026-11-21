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
 * every tree member and prop must be on the pinned allowlist
 * (`BoxProps` 1280, `TextProps` 16722 and the per-element interfaces in
 * `RenderElement`, 12513-12884), and the members the pin marks required must
 * be present. The refusal sentence (`a tree Pane refuses: Text prop "x" is
 * not allowed`) follows the shape the ticket asks for; the exact wording is
 * *derived*, because the pin's validator is compiled into the runtime and its
 * strings are not part of the declaration file.
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

interface ElementRule {
  /** Members of the tree node itself. */
  readonly keys: readonly string[]
  /** Members of `props`; the tree's own allowlist for this tag. */
  readonly props: readonly string[]
  /** What `children` may hold, when anything. */
  readonly children: 'nodes' | 'inline' | 'button' | 'none'
  /** `props` members the pinned declaration marks required. */
  readonly required?: readonly string[]
  /** Required string `props` members (a subset of `required`). */
  readonly requiredStrings?: readonly string[]
  /** Required array `props` members. */
  readonly requiredArrays?: readonly string[]
  /** Required whole-number `props` members. */
  readonly requiredNumbers?: readonly string[]
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
    requiredStrings: ['key', 'label'],
    press: 'required',
    hover: 'text',
  },
  Input: {
    keys: ['type', 'props', 'press'],
    props: ['key', 'label', 'placeholder', 'value', 'submitLabel', 'rows', 'autoFocus'],
    children: 'none',
    required: ['key'],
    requiredStrings: ['key'],
    press: 'required',
  },
  Select: {
    keys: ['type', 'props', 'press'],
    props: ['key', 'label', 'options', 'value', 'autoFocus'],
    children: 'none',
    required: ['key', 'options'],
    requiredStrings: ['key'],
    requiredArrays: ['options'],
    press: 'required',
  },
  Link: {
    keys: ['type', 'props', 'children'],
    props: ['href', 'label'],
    children: 'inline',
    required: ['href'],
    requiredStrings: ['href'],
  },
  Code: {
    keys: ['type', 'props'],
    props: ['source', 'language', 'path', 'startLine', 'format', 'wrap'],
    children: 'none',
    required: ['source'],
    requiredStrings: ['source'],
  },
  Markdown: {
    keys: ['type', 'props', 'part', 'press'],
    props: ['key', 'text', 'dimColor', 'pressableLinks'],
    children: 'none',
    required: ['text'],
    requiredStrings: ['text'],
    press: 'optional',
  },
  Client: {
    keys: ['type', 'props', 'client'],
    props: ['key', 'module', 'props', 'width', 'height', 'flexGrow'],
    children: 'none',
    required: ['key', 'module'],
    requiredStrings: ['key', 'module'],
    requiredStamps: ['client'],
  },
  Svg: {
    keys: ['type', 'props'],
    props: ['source', 'alt', 'width', 'height', 'isInteractive'],
    children: 'none',
    required: ['source', 'alt'],
    requiredStrings: ['source', 'alt'],
  },
  Shader: {
    keys: ['type', 'props', 'shader', 'children'],
    props: ['module', 'values'],
    children: 'nodes',
    required: ['module'],
    requiredStrings: ['module'],
  },
  Progress: {
    keys: ['type', 'props'],
    props: ['label', 'value', 'max', 'valueText', 'color'],
    children: 'none',
    required: ['label'],
    requiredStrings: ['label'],
  },
  Raster: {
    keys: ['type', 'props', 'raster'],
    props: ['key', 'columns', 'rows', 'cells'],
    children: 'none',
    required: ['key', 'columns', 'rows', 'cells'],
    requiredStrings: ['key', 'cells'],
    requiredNumbers: ['columns', 'rows'],
    requiredStamps: ['raster'],
  },
  Image: {
    keys: ['type', 'props', 'image'],
    props: ['key', 'source', 'columns', 'rows', 'alt'],
    children: 'none',
    required: ['source', 'columns', 'rows', 'alt'],
    requiredStrings: ['source', 'alt'],
    requiredNumbers: ['columns', 'rows'],
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
      for (const key of Object.keys(hover)) {
        if (!(allowed as readonly string[]).includes(key)) return `${type} hover ${JSON.stringify(key)} is not allowed`
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
        for (const key of rule.requiredStrings ?? []) {
          if (typeof props[key] !== 'string') return `${type} prop ${JSON.stringify(key)} must be a string`
        }
        for (const key of rule.requiredArrays ?? []) {
          if (!Array.isArray(props[key])) return `${type} prop ${JSON.stringify(key)} must be an array`
        }
        for (const key of rule.requiredNumbers ?? []) {
          if (!isPositive(props[key])) return `${type} prop ${JSON.stringify(key)} must be a positive whole number`
        }
        if (type === 'Box' || type === 'Text') {
          for (const [key, value] of Object.entries(props)) {
            const primitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            if (!primitive) return `${type} prop ${JSON.stringify(key)} must be a string, number or boolean`
          }
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
const RENDER_MATCHER_FIELDS = new Set(['component', 'requestId', 'surface', 'plugin', 'props'])

/**
 * One pinned matcher leaf: equality, a RegExp against a string, an array of
 * alternatives, or a partial object (d.ts:7460-7545 @ 2.1.329).
 */
const matcherValueMatches = (rule: unknown, value: unknown): boolean => {
  if (rule instanceof RegExp) return typeof value === 'string' ? rule.test(value) : false
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
