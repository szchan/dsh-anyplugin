// The derived renderer bridge (issue #281 slice 1), browser half.
//
// What this module is: a small translator that turns a foreign mod's *Pane*
// element tree — as the headless sink validated and recorded it in the
// main-process mod host — into React nodes, mounted in two host seats this
// bundle registers through its own client surface:
//
//   - a keyed `main` pane (the host layout places it; we do not own the seat),
//   - an additive `shell.overlay` line (we add a line; the host still owns focus).
//
// What it deliberately is not: the pin's element runtime. There is no terminal
// grid, no layout model, no host geometry prop, no focus routing, no host
// invalidate pacing and no press dispatch. Every face is `derived` with a
// reason recorded at the source (../renderer-faces.js); the pane renders those
// reasons verbatim so the classification travels with the picture instead of
// living in a report. Basis: spikes/s25-client-surface (PR #287 / ticket/280),
// which measured the primitives at 0.2.2-rc.2 and 0.2.2-rc.5 and named what it
// could not prove. Slice 2 of #281 is the real-browser/Electron transport; the
// rest of the element vocabulary and host-owned behavior stay planned.
//
// Vocabulary is four tags on purpose: Box, Text, Button, Input. A pinned tag
// outside it is drawn as a named placeholder and reported as unsupported; it
// is never translated by guesswork.

import {
  ELEMENT_VOCABULARY,
  ELEMENT_VOCABULARY_NOTE,
  RENDERER_FACE_LINES,
  RENDERER_FACES,
  RENDERER_KIND,
  RENDERER_ROUTE,
  rendererFaces,
} from '../renderer-faces.js'

const MAX_DEPTH = 64
const MAX_NODES = 4096

const SPACE_STEPS = Object.freeze({ xs: 4, sm: 8, md: 12, lg: 16, xl: 24 })

/** The pin's `Text` size vocabulary, mapped to page font sizes (derived). */
const TEXT_SIZES = Object.freeze({ caption: 11, footnote: 12, body: 14, heading: 18, title: 22 })

/** The pin's `Text` weight vocabulary, mapped to CSS weights (derived). */
const TEXT_WEIGHTS = Object.freeze({ regular: 400, medium: 500, semibold: 600, bold: 700 })

/** Pin color names we can hand CSS directly; anything else is reported lost. */
const COLOR_NAMES = Object.freeze({
  black: '#000000',
  blue: '#3b82f6',
  cyan: '#06b6d4',
  gray: '#6b7280',
  green: '#22c55e',
  grey: '#6b7280',
  magenta: '#d946ef',
  red: '#ef4444',
  white: '#f8fafc',
  yellow: '#eab308',
})

/** Enumerated flex/box props: pin prop name -> [React style key, accepted keywords]. */
const FLEX_RULES = Object.freeze({
  flexDirection: ['flexDirection', ['row', 'row-reverse', 'column', 'column-reverse']],
  flexWrap: ['flexWrap', ['nowrap', 'wrap', 'wrap-reverse']],
  alignItems: ['alignItems', ['flex-start', 'flex-end', 'center', 'baseline', 'stretch']],
  alignSelf: ['alignSelf', ['auto', 'flex-start', 'flex-end', 'center', 'baseline', 'stretch']],
  justifyContent: [
    'justifyContent',
    ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  ],
  overflow: ['overflow', ['visible', 'hidden', 'scroll', 'auto']],
  overflowX: ['overflowX', ['visible', 'hidden', 'scroll', 'auto']],
  display: ['display', ['flex', 'none', 'block', 'inline']],
  position: ['position', ['static', 'relative', 'absolute', 'fixed']],
})

/** Space props: pin prop name -> the React style keys it writes. */
const SPACE_RULES = Object.freeze({
  gap: ['gap'],
  rowGap: ['rowGap'],
  columnGap: ['columnGap'],
  padding: ['padding'],
  paddingX: ['paddingLeft', 'paddingRight'],
  paddingY: ['paddingTop', 'paddingBottom'],
  paddingTop: ['paddingTop'],
  paddingBottom: ['paddingBottom'],
  paddingLeft: ['paddingLeft'],
  paddingRight: ['paddingRight'],
  margin: ['margin'],
  marginX: ['marginLeft', 'marginRight'],
  marginY: ['marginTop', 'marginBottom'],
  marginTop: ['marginTop'],
  marginBottom: ['marginBottom'],
  marginLeft: ['marginLeft'],
  marginRight: ['marginRight'],
})

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A pin size/space value (`xs`..`xl`, a number, or a CSS length) -> CSS length. */
export const lengthOf = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`
  if (typeof value !== 'string') return undefined
  const step = SPACE_STEPS[value]
  if (step !== undefined) return `${step}px`
  if (value === 'auto') return value
  if (/^-?\d+(\.\d+)?(px|%|rem|em|vh|vw)$/.test(value)) return value
  return undefined
}

/** A pin color name or hex string -> a CSS color, or undefined (recorded lost). */
export const colorOf = (value) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed
  const named = COLOR_NAMES[trimmed.toLowerCase()]
  if (named !== undefined) return named
  if (/^(rgb|rgba|hsl|hsla)\([^)]*\)$/.test(trimmed)) return trimmed
  return undefined
}

// ---- the translator --------------------------------------------------------

const anchorOf = (depth, index) => `${depth}.${index}`

const marker = (h, text, extra) =>
  h('span', { 'data-anyplugin-invalid': '', ...extra }, text)

/**
 * Translate one validated Pane tree into React nodes.
 *
 * `onLost` receives `{ at, kind, name }` for every pin prop/kind this bridge
 * cannot serve, so "derived" is a measured fact rather than a label: the caller
 * can render the lost list. Unknown tags are rendered as a named placeholder;
 * nothing in the input can make the translator throw.
 */
export function translateTree(tree, h, options = {}) {
  const onLost = typeof options.onLost === 'function' ? options.onLost : () => {}
  const state = { nodes: 0, depth: 0, truncated: false }

  const walk = (node, depth, path) => {
    if (state.nodes >= MAX_NODES || depth > MAX_DEPTH) {
      state.truncated = true
      onLost({ at: path, kind: 'cap', name: depth > MAX_DEPTH ? 'depth' : 'nodes' })
      return marker(h, '…', { 'data-anyplugin-truncated': '' })
    }
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!isRecord(node) || typeof node.type !== 'string') {
      onLost({ at: path, kind: 'invalid', name: typeof node })
      return marker(h, 'invalid element')
    }
    state.nodes += 1
    const props = isRecord(node.props) ? node.props : {}
    const children = Array.isArray(node.children) ? node.children : []
    if (!ELEMENT_VOCABULARY.includes(node.type)) {
      onLost({ at: path, kind: 'tag', name: node.type })
      return marker(h, `${node.type} is outside the derived renderer vocabulary`, {
        'data-anyplugin-unsupported': node.type,
      })
    }
    const lostFor = (name, kind = 'prop') => onLost({ at: path, kind, name })
    const childNodes = children
      .map((child, index) => walk(child, depth + 1, `${path}/${anchorOf(depth + 1, index)}`))
      .filter((child) => child !== null && child !== undefined && child !== '')

    if (node.type === 'Box') {
      const { style, attributes } = boxStyle(h, props, lostFor)
      return h('div', { 'data-anyplugin-face': 'element.box', ...attributes, style }, ...childNodes)
    }
    if (node.type === 'Text') {
      const { style, attributes } = textStyle(props, lostFor)
      return h('span', { 'data-anyplugin-face': 'element.text', ...attributes, style }, ...childNodes)
    }
    if (node.type === 'Button') {
      const label = buttonLabel(props, children, lostFor)
      // The pinned press handle is recorded data; dispatching it is planned, so
      // the member itself is named as not served.
      if (node.press !== undefined) lostFor('press')
      const style = buttonStyle(props)
      return h(
        'button',
        {
          type: 'button',
          'data-anyplugin-face': 'element.button',
          'data-anyplugin-key': typeof props.key === 'string' ? props.key : '',
          'aria-label': label,
          style,
        },
        label,
      )
    }
    // Input: the pin has no children here; the value is the host's record.
    if (node.press !== undefined) lostFor('press')
    const style = inputStyle(props)
    return h('input', {
      'data-anyplugin-face': 'element.input',
      'data-anyplugin-key': typeof props.key === 'string' ? props.key : '',
      type: 'text',
      defaultValue: typeof props.value === 'string' ? props.value : '',
      placeholder: typeof props.placeholder === 'string' ? props.placeholder : '',
      'aria-label': typeof props.label === 'string' ? props.label : '',
      readOnly: true,
      style,
    })
  }

  return { node: walk(tree, 0, '0'), truncated: state.truncated, nodes: state.nodes }
}

const boxStyle = (h, props, lostFor) => {
  const style = {}
  const attributes = {}
  const used = new Set()
  for (const [prop, [css, keywords]] of Object.entries(FLEX_RULES)) {
    if (!(prop in props)) continue
    used.add(prop)
    const value = props[prop]
    if (typeof value === 'string' && keywords.includes(value)) style[css] = value
    else lostFor(prop)
  }
  for (const [prop, targets] of Object.entries(SPACE_RULES)) {
    if (!(prop in props)) continue
    used.add(prop)
    const value = lengthOf(props[prop])
    if (value === undefined) {
      lostFor(prop)
      continue
    }
    for (const target of targets) style[target] = value
  }
  for (const prop of ['top', 'left', 'right', 'bottom', 'width', 'height', 'minWidth', 'minHeight']) {
    if (!(prop in props)) continue
    used.add(prop)
    const value = lengthOf(props[prop])
    if (value === undefined) lostFor(prop)
    else style[prop] = value
  }
  for (const prop of ['flexGrow', 'flexShrink']) {
    if (!(prop in props)) continue
    used.add(prop)
    const value = props[prop]
    if (typeof value === 'number' && Number.isFinite(value)) style[prop] = String(value)
    else lostFor(prop)
  }
  if ('backgroundColor' in props) {
    used.add('backgroundColor')
    const value = colorOf(props.backgroundColor)
    if (value === undefined) lostFor('backgroundColor')
    else style.backgroundColor = value
  }
  if ('borderStyle' in props) {
    used.add('borderStyle')
    // The pin's border vocabulary is terminal glyph styles; the page has one
    // border kind, so every accepted style lands on the same drawn border.
    const value = props.borderStyle
    if (typeof value === 'string' && value !== '' && value !== 'none') {
      style.borderStyle = 'solid'
      style.borderWidth = '1px'
      style.borderColor = colorOf(props.borderColor) ?? 'var(--dsw-alias-border, #d1d5db)'
    } else if (value === 'none') {
      style.borderStyle = 'none'
    } else lostFor('borderStyle')
  }
  if ('borderColor' in props) {
    used.add('borderColor')
    if (!('borderStyle' in props)) lostFor('borderColor')
  }
  if ('borderDimColor' in props) {
    used.add('borderDimColor')
    if (props.borderDimColor === true) style.opacity = '0.6'
  }
  used.add('key')
  for (const prop of Object.keys(props)) if (!used.has(prop)) lostFor(prop)
  return { style, attributes }
}

const textStyle = (props, lostFor) => {
  const style = {}
  const attributes = {}
  const used = new Set()
  if ('color' in props) {
    used.add('color')
    const value = colorOf(props.color)
    if (value === undefined) lostFor('color')
    else style.color = value
  }
  if ('backgroundColor' in props) {
    used.add('backgroundColor')
    const value = colorOf(props.backgroundColor)
    if (value === undefined) lostFor('backgroundColor')
    else style.backgroundColor = value
  }
  if (props.dimColor === true) style.opacity = '0.55'
  used.add('dimColor')
  if ('size' in props) {
    used.add('size')
    const size = TEXT_SIZES[props.size]
    if (size === undefined) lostFor('size')
    else style.fontSize = `${size}px`
  }
  if ('weight' in props) {
    used.add('weight')
    const weight = TEXT_WEIGHTS[props.weight]
    if (weight === undefined) lostFor('weight')
    else style.fontWeight = String(weight)
  }
  if (props.bold === true) {
    style.fontWeight = style.fontWeight ?? '700'
  }
  used.add('bold')
  if (props.mono === true) style.fontFamily = 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
  used.add('mono')
  if (props.italic === true) style.fontStyle = 'italic'
  used.add('italic')
  const decorations = []
  if (props.underline === true) decorations.push('underline')
  if (props.strikethrough === true) decorations.push('line-through')
  if (decorations.length > 0) style.textDecorationLine = decorations.join(' ')
  used.add('underline')
  used.add('strikethrough')
  if (props.inverse === true) style.filter = 'invert(1)'
  used.add('inverse')
  if (props.tabular === true) style.fontVariantNumeric = 'tabular-nums'
  used.add('tabular')
  if (typeof props.dir === 'string') attributes.dir = props.dir
  used.add('dir')
  if (typeof props.wrap === 'string' && props.wrap === 'wrap') style.whiteSpace = 'pre-wrap'
  else if (typeof props.wrap === 'string' && props.wrap === 'truncate') style.whiteSpace = 'nowrap'
  if ('wrap' in props) used.add('wrap')
  if ('maxLines' in props) {
    used.add('maxLines')
    lostFor('maxLines')
  }
  used.add('key')
  for (const prop of Object.keys(props)) if (!used.has(prop)) lostFor(prop)
  return { style, attributes }
}

const buttonLabel = (props, children, lostFor) => {
  const used = new Set(['key', 'label', 'variant'])
  // `variant` is served as drawn emphasis (primary/secondary). Every other pin
  // Button prop stays recorded rather than served, and is reported by name.
  for (const prop of ['hotkey', 'action', 'plain', 'dimColor', 'role', 'autoFocus']) {
    if (!(prop in props)) continue
    used.add(prop)
    lostFor(prop)
  }
  let label = ''
  if (typeof props.label === 'string' && props.label.length > 0) {
    label = props.label
  } else {
    label = children
      .map((child) => (typeof child === 'string' ? child : isRecord(child) && child.type === 'Text' ? flattenText(child) : ''))
      .join(' ')
      .trim()
  }
  for (const prop of Object.keys(props)) if (!used.has(prop)) lostFor(prop)
  return label === '' ? (typeof props.key === 'string' ? props.key : 'button') : label
}

const flattenText = (node) => {
  if (!isRecord(node)) return ''
  const children = Array.isArray(node.children) ? node.children : []
  return children.map((child) => (typeof child === 'string' ? child : flattenText(child))).join('')
}

const buttonStyle = (props) => {
  const base = {
    alignSelf: 'flex-start',
    background: 'var(--dsw-alias-bg-subtle, #f3f4f6)',
    border: '1px solid var(--dsw-alias-border, #d1d5db)',
    borderRadius: '4px',
    color: 'var(--dsw-alias-fg-primary, #111827)',
    cursor: 'pointer',
    font: 'inherit',
    padding: '2px 10px',
  }
  if (props.variant === 'primary') {
    base.background = 'var(--dsw-alias-bg-accent, #2563eb)'
    base.borderColor = 'transparent'
    base.color = 'var(--dsw-alias-fg-on-accent, #ffffff)'
  }
  return base
}

const inputStyle = (props) => ({
  background: 'var(--dsw-alias-bg-base, #ffffff)',
  border: '1px solid var(--dsw-alias-border, #d1d5db)',
  borderRadius: '4px',
  color: 'var(--dsw-alias-fg-primary, #111827)',
  font: 'inherit',
  padding: '2px 6px',
  width: '100%',
})

// ---- pacing, geometry, focus ----------------------------------------------

/**
 * Coalesce redraws to one callback per animation frame. `schedule` keeps the
 * latest work item and requests exactly one frame until it runs; `dispose`
 * cancels that frame, so a pane that unmounted cannot measure a detached node
 * or set state after its tree is gone. This is the page realm's own pacing
 * (S25 primitive 5) — it is *not* the host's invalidate pacing, which has no
 * exposed API.
 */
export function createPacer(requestFrame, cancelFrame) {
  const frame = typeof requestFrame === 'function' ? requestFrame : (run) => run()
  const cancel = typeof cancelFrame === 'function' ? cancelFrame : null
  let queued = null
  let pending = false
  let handle = null
  const flush = () => {
    pending = false
    handle = null
    const run = queued
    queued = null
    if (typeof run === 'function') run()
  }
  return {
    schedule(run) {
      queued = run
      if (pending) return false
      pending = true
      handle = frame(flush)
      return true
    },
    pending: () => pending,
    /** Cancel a queued frame; returns true when there was one. */
    dispose() {
      const had = pending
      if (had && cancel !== null && handle !== null) cancel(handle)
      queued = null
      pending = false
      handle = null
      return had
    },
  }
}

/**
 * Measure our own box through ResizeObserver, but read the rect inside the
 * paced callback: an observation schedules a redraw, the redraw measures. The
 * host keyed seat hands a fixture no geometry (S25 primitive 4), so this is
 * feedback we collect, not a contract.
 */
export function createGeometry({ node, env = {}, pacer, onChange }) {
  const Observer = env.ResizeObserver
  if (typeof Observer !== 'function' || node === null || node === undefined || typeof onChange !== 'function') {
    return { measured: false, dispose: () => {} }
  }
  const measure = () => {
    const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : { width: 0, height: 0 }
    const width = Math.max(0, Math.round(Number(rect.width) || 0))
    const height = Math.max(0, Math.round(Number(rect.height) || 0))
    onChange({ width, height })
    return { width, height }
  }
  const observer = new Observer(() => {
    pacer.schedule(measure)
  })
  observer.observe(node)
  pacer.schedule(measure)
  return {
    measured: true,
    measure,
    dispose() {
      observer.disconnect()
    },
  }
}

/**
 * Keep focus inside this pane's own subtree across rerenders. It records the
 * last focused descendant of our node and restores it after a redraw, falling
 * back to the pane itself. It is not host focus routing: focus events from
 * outside the subtree are ignored, and no page-wide trap is installed.
 */
export function createFocusGuard({ node, document: doc } = {}) {
  let last = null
  const canListen = doc !== null && doc !== undefined && typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function'
  const contains = (target) => {
    if (node === null || node === undefined || target === null || target === undefined) return false
    if (typeof node.contains === 'function') {
      try {
        return node.contains(target)
      } catch {
        return false
      }
    }
    return node === target
  }
  const onFocusIn = (event) => {
    const target = event && event.target
    if (contains(target)) last = target
  }
  if (canListen) doc.addEventListener('focusin', onFocusIn, true)
  return {
    contains,
    restore() {
      if (contains(last) && typeof last.focus === 'function') {
        last.focus()
        return last
      }
      if (node !== null && node !== undefined && typeof node.focus === 'function') {
        node.focus()
        return node
      }
      return null
    },
    dispose() {
      if (canListen) doc.removeEventListener('focusin', onFocusIn, true)
      last = null
    },
  }
}

// ---- the request/response store -------------------------------------------

const describeError = (error) => {
  if (error !== null && error !== undefined && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * The browser half of the round trip: one loopback GET per mount/refresh, one
 * JSON response, one redraw. `roundTrips` and `lastStatus` are rendered, so a
 * stale or failed request is visible in the pane instead of silently keeping an
 * old picture.
 */
export function createRendererStore({ fetchImpl } = {}) {
  let snapshot = {
    loading: true,
    ok: false,
    error: null,
    sources: 0,
    panes: [],
    truncated: false,
    roundTrips: 0,
    lastStatus: null,
    vocabulary: ELEMENT_VOCABULARY,
    faces: rendererFaces(),
  }
  const listeners = new Set()
  const update = (patch) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of Array.from(listeners)) listener(snapshot)
    return snapshot
  }
  const fetchVia = typeof fetchImpl === 'function' ? fetchImpl : (...args) => globalThis.fetch(...args)
  const refresh = async () => {
    const roundTrips = snapshot.roundTrips + 1
    try {
      const response = await fetchVia(RENDERER_ROUTE, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        method: 'GET',
      })
      const body = await response.json()
      const status = typeof response.status === 'number' ? response.status : 0
      if (response.ok !== true || isRecord(body) === false || body.ok !== true) {
        const code = isRecord(body) && typeof body.code === 'string' ? body.code : 'render-failed'
        update({
          loading: false,
          ok: false,
          error: `${code}: ${isRecord(body) && typeof body.reason === 'string' ? body.reason : `HTTP ${status}`}`,
          roundTrips,
          lastStatus: status,
        })
        return snapshot
      }
      update({
        loading: false,
        ok: true,
        error: null,
        sources: Number(body.sources) || 0,
        panes: Array.isArray(body.panes) ? body.panes : [],
        truncated: body.truncated === true,
        vocabulary: Array.isArray(body.vocabulary) ? body.vocabulary : ELEMENT_VOCABULARY,
        faces: Array.isArray(body.faces) ? body.faces : rendererFaces(),
        roundTrips,
        lastStatus: status,
      })
      return snapshot
    } catch (error) {
      update({ loading: false, ok: false, error: `no response: ${describeError(error)}`, roundTrips, lastStatus: null })
      return snapshot
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    kind: RENDERER_KIND,
    route: RENDERER_ROUTE,
  }
}

// ---- the React faces -------------------------------------------------------

const paneStyles = Object.freeze({
  pane: {
    border: '1px solid var(--dsw-alias-border, #e5e7eb)',
    borderRadius: '6px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px',
  },
  body: {
    borderTop: '1px solid var(--dsw-alias-border, #e5e7eb)',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingTop: '6px',
  },
  title: { fontSize: '13px', fontWeight: '600', margin: 0 },
  muted: { color: 'var(--dsw-alias-fg-muted, #6b7280)', margin: 0 },
  overlay: {
    alignSelf: 'flex-start',
    background: 'var(--dsw-alias-bg-subtle, #f3f4f6)',
    border: '1px solid var(--dsw-alias-border, #e5e7eb)',
    borderRadius: '4px',
    color: 'var(--dsw-alias-fg-muted, #6b7280)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
    padding: '1px 8px',
  },
})

const describeSnapshot = (snapshot) => {
  if (snapshot.loading) return 'round trip: requesting a snapshot from our host half…'
  if (snapshot.error !== null) return `round trip: ${snapshot.roundTrips} request(s), last failed — ${snapshot.error}`
  const sources = `${snapshot.sources} producer(s)`
  const panes = `${snapshot.panes.length} pane(s)`
  const status = snapshot.lastStatus === null ? 'no HTTP status' : `HTTP ${snapshot.lastStatus}`
  return `round trip: ${snapshot.roundTrips} request(s), ${status}, ${sources}, ${panes}${snapshot.truncated ? ', truncated' : ''}`
}

const renderPaneBlock = (h, pane) => {
  const record = isRecord(pane) ? pane : {}
  const id = typeof record.id === 'string' ? record.id : 'pane'
  const title = typeof record.title === 'string' && record.title !== '' ? record.title : id
  const revision = Number(record.revision) || 0
  const placed = record.isPlaced === false ? 'unplaced' : 'placed'
  const lost = []
  const translated = translateTree(record.tree, h, { onLost: (entry) => lost.push(entry) })
  return h(
    'section',
    { key: id, 'data-anyplugin-pane': id, style: paneStyles.body },
    h('h3', { style: paneStyles.title }, `${title} · ${id} · revision ${revision} · ${placed}`),
    record.refusal !== undefined
      ? h('p', { style: paneStyles.muted }, `refused: ${typeof record.refusal === 'string' ? record.refusal : JSON.stringify(record.refusal)}`)
      : null,
    record.tree === undefined
      ? h('p', { style: paneStyles.muted }, 'no tree recorded for this pane')
      : h('div', { 'data-anyplugin-tree': '' }, translated.node),
    lost.length === 0
      ? null
      : h('p', { 'data-anyplugin-lost': String(lost.length), style: paneStyles.muted },
          `${lost.length} pin prop(s)/tag(s) are not served by the derived vocabulary (${lost.map((entry) => entry.name).join(', ')})`),
  )
}

/**
 * Build the two React seats and the deferred actions around one store.
 *
 * `react` is the host module table's React (the bundle only ever receives it
 * through `window.__ModuleLoader__`'s require), so there is no second React in
 * the page and no hooks import of our own.
 */
export function createRendererBridge(react, options = {}) {
  const { createElement: h, useEffect, useState } = react
  const store = options.store ?? createRendererStore({ fetchImpl: options.fetchImpl })
  const env = options.env ?? (typeof window === 'object' ? window : globalThis)
  const holder = { node: null, focus: null }

  const focus = () => {
    const guard = holder.focus
    if (guard !== null) return guard.restore()
    const node = holder.node
    if (node !== null && typeof node.focus === 'function') {
      node.focus()
      return node
    }
    return null
  }

  function Pane() {
    const [snapshot, setSnapshot] = useState(store.getSnapshot())
    const [node] = useState(() => ({ current: null }))
    const [geometry, setGeometry] = useState(null)
    const [pacer] = useState(() => createPacer(env.requestAnimationFrame, env.cancelAnimationFrame))
    const [guard] = useState(() => ({ current: null }))

    useEffect(() => {
      let live = true
      const unsubscribe = store.subscribe((next) => {
        if (live) setSnapshot(next)
      })
      store.refresh()
      return () => {
        live = false
        unsubscribe()
      }
    }, [])

    useEffect(() => {
      const element = node.current
      if (element === null || element === undefined) return undefined
      const focusGuard = createFocusGuard({ node: element, document: env.document })
      const tracker = createGeometry({ node: element, env, pacer, onChange: setGeometry })
      holder.node = element
      holder.focus = focusGuard
      guard.current = focusGuard
      return () => {
        holder.node = null
        holder.focus = null
        guard.current = null
        tracker.dispose()
        focusGuard.dispose()
        pacer.dispose()
      }
    }, [])

    useEffect(() => {
      // Restore focus only after a redraw: with no dependency list this effect
      // ran on every render and could pull focus out of whatever the user was
      // doing elsewhere in the page. A new snapshot is the only redraw we own.
      if (guard.current !== null) guard.current.restore()
    }, [snapshot])

    const panes = Array.isArray(snapshot.panes) ? snapshot.panes : []
    return h(
      'section',
      {
        ref: (element) => {
          node.current = element
        },
        tabIndex: -1,
        'data-anyplugin-renderer': '',
        'data-anyplugin-renderer-kind': RENDERER_KIND,
        'data-anyplugin-vocabulary': ELEMENT_VOCABULARY.join(','),
        'data-anyplugin-faces': String(RENDERER_FACES.length),
        'data-anyplugin-geometry': geometry === null ? 'unmeasured' : `${geometry.width}x${geometry.height}`,
        'data-anyplugin-round-trips': String(snapshot.roundTrips),
        style: paneStyles.pane,
      },
      h('header', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
        h('span', { style: paneStyles.title }, 'AnyPlugin renderer'),
        h('span', { style: paneStyles.muted }, 'derived bridge'),
      ),
      h('p', { 'data-anyplugin-roundtrip': snapshot.error !== null ? 'failed' : 'ok', style: paneStyles.muted }, describeSnapshot(snapshot)),
      h('p', { style: paneStyles.muted }, ELEMENT_VOCABULARY_NOTE),
      h('p', { style: paneStyles.muted },
        'layout, host focus routing, host invalidate pacing and 19 of 20 render sites stay planned; every face served here is class derived.',
      ),
      panes.length === 0 ? h('p', { style: paneStyles.muted }, 'No host producer has an open pane.') : null,
      h('div', { 'data-anyplugin-panes': '' }, panes.map((pane) => renderPaneBlock(h, pane))),
      h('details', { 'data-anyplugin-face-lines': '' },
        h('summary', { style: paneStyles.muted }, `derived faces (${RENDERER_FACES.length})`),
        RENDERER_FACE_LINES.map((line, index) => h('div', { key: String(index), style: paneStyles.muted }, line)),
      ),
    )
  }

  function Overlay() {
    return h(
      'button',
      {
        type: 'button',
        'data-anyplugin-overlay': '',
        'data-anyplugin-faces': String(RENDERER_FACES.length),
        style: paneStyles.overlay,
        title: 'derived renderer bridge: request a snapshot and focus the pane',
        onClick: () => {
          focus()
          store.refresh()
        },
      },
      `AnyPlugin renderer · ${RENDERER_FACES.length} derived faces`,
    )
  }

  return { store, Pane, Overlay, focus }
}

// ---- keyboard --------------------------------------------------------------

/**
 * The shortcuts service, if this host context offers it. `shortcuts` is an
 * optional service (the module injects `slots` only): a host without it keeps
 * the panel and its settings seat. The read goes through `ctx.get` first
 * because a bare property probe can throw on a context that did not declare
 * the service, and every probe is guarded — a missing keyboard is a
 * degradation, never a reason for `apply` to throw.
 */
const shortcutsOf = (ctx) => {
  if (ctx === null || ctx === undefined) return undefined
  let declared
  try {
    declared = typeof ctx.get === 'function' ? ctx.get('shortcuts') : undefined
  } catch {
    declared = undefined
  }
  if (declared !== null && declared !== undefined) return declared
  try {
    return ctx.shortcuts
  } catch {
    return undefined
  }
}

/**
 * Register the bridge's one keyboard command through the shortcuts service
 * (S25 primitive 3): declarable, labelled, and handled in `resolve`. The
 * command requests a fresh snapshot and brings focus into the pane's own
 * subtree. There is deliberately no second key path and no host focus claim.
 */
export function registerRendererKeyboard(ctx, options = {}) {
  const shortcuts = shortcutsOf(ctx)
  if (shortcuts === null || shortcuts === undefined || typeof shortcuts.register !== 'function') {
    return () => {}
  }
  const store = options.store
  const focus = typeof options.focus === 'function' ? options.focus : () => null
  const disposable = shortcuts.register({
    id: 'anyplugin.renderer.request',
    label: () => 'AnyPlugin renderer: request a fresh snapshot from the mod host',
    aliases: ['anyplugin.renderer.snapshot'],
    defaults: {
      'web:linux': { code: 'KeyR', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyR', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyR', modifiers: ['primary', 'alt'] },
    },
    regions: ['page'],
    modals: [],
    resolve: () => ({
      status: 'handled',
      run: () => {
        focus()
        if (store !== null && store !== undefined && typeof store.refresh === 'function') store.refresh()
      },
    }),
  })
  return typeof disposable === 'function' ? disposable : () => {}
}

export {
  ELEMENT_VOCABULARY,
  ELEMENT_VOCABULARY_NOTE,
  RENDERER_FACE_LINES,
  RENDERER_FACES,
  RENDERER_KIND,
  RENDERER_ROUTE,
}
