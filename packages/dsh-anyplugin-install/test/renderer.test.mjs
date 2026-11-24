// The derived renderer bridge (#281 slice 1): both halves, the four-tag
// vocabulary, and the request/response round trip.
//
// The spike this derives from is spikes/s25-client-surface (PR #287 /
// ticket/280), measured at 0.2.2-rc.2 and 0.2.2-rc.5. S25 proved, in a jsdom
// page with the real Loader/SlotRegistry/AppFrame/shortcuts stack, that a
// client bundle can mount a keyed `main` pane and an additive `shell.overlay`,
// that `ctx.shortcuts` commands are live, and that our own host half can answer
// a loopback request/response. It also recorded what it could *not* prove: no
// focus primitive, no geometry prop on the keyed seat, no host invalidate
// pacing, and the Desktop file:// + IPC transport untouched (slice 2). These
// tests replay S25's proven primitives at the unit level and pin every face to
// class `derived` with a non-empty reason; nothing here claims `equivalent`.
//
// The round trip is the real one: a real `createUiSink` records a real
// validated tree, the registry normalises it, `dispatchPanel` answers
// `GET /anyplugin/render`, and the browser half's store reads that response
// back. No mocks between the two halves — only the transport is in-process.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createModBridge } from '../../dsh-anyplugin-mod-host/src/index.ts'
import {
  ELEMENT_VOCABULARY,
  ELEMENT_VOCABULARY_NOTE,
  RENDERER_FACE_LINES,
  RENDERER_FACES,
  RENDERER_ROUTE,
  rendererFaces,
  rendererFacesAreDerived,
} from '../src/renderer-faces.js'
import { dispatchPanel } from '../src/panel.ts'
import {
  createRendererRegistry,
  MAX_PANE_BYTES,
  MAX_RENDERER_PANES,
  normalizeRendererPane,
  rendererPayloadOf,
} from '../src/renderer.ts'
import {
  createFocusGuard,
  createGeometry,
  createPacer,
  createRendererBridge,
  createRendererStore,
  registerRendererKeyboard,
  translateTree,
} from '../src/client/renderer.js'

// ---- tiny React stand-in ----------------------------------------------------
//
// The browser half only ever receives React through the host's module table,
// so its unit test can hand it this stand-in: same call signature, no renderer.
const h = (type, props, ...children) => ({ type, props: props ?? {}, children })

const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const findAll = (node, predicate, found = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const entry of node) findAll(entry, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

const nodeOf = (tree, options) => translateTree(tree, h, options).node

const hookRuntime = () => {
  const slots = []
  const mounted = new Map()
  let cursor = 0
  let pending = []
  const createElement = h
  const useState = (initial) => {
    const index = cursor
    cursor += 1
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next
    }
    return [slots[index], set]
  }
  const useEffect = (run, deps) => {
    pending.push({ run, deps })
  }
  const render = (component, props = {}) => {
    cursor = 0
    pending = []
    return component(props)
  }
  const changed = (before, after) => {
    if (before === undefined || after === undefined || before === null || after === null) return true
    if (before.length !== after.length) return true
    return before.some((value, index) => !Object.is(value, after[index]))
  }
  const flush = () => {
    const list = pending
    pending = []
    list.forEach((effect, index) => {
      const previous = mounted.get(index)
      if (previous === undefined || changed(previous.deps, effect.deps)) {
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
        const cleanup = effect.run()
        mounted.set(index, { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
      }
    })
  }
  return { createElement, useEffect, useState, render, flush, slots }
}

const fakeNode = ({ width = 320, height = 180, inside = true } = {}) => {
  const focused = []
  let parent = null
  const descendants = []
  const node = {
    getBoundingClientRect: () => ({ width, height }),
    contains: (target) => target === node || (inside && descendants.includes(target)),
    focus: () => focused.push('node'),
    focused,
    descendants,
    setParent: (value) => {
      parent = value
    },
  }
  return { node, focused, addDescendant: (child) => descendants.push(child) }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

// ---- faces and vocabulary ---------------------------------------------------

test('every face is class derived with a reason, and the vocabulary is four tags', () => {
  assert.equal(rendererFacesAreDerived(), true)
  assert.deepEqual([...ELEMENT_VOCABULARY], ['Box', 'Text', 'Button', 'Input'])
  assert.ok(RENDERER_FACES.length >= 8)
  for (const face of RENDERER_FACES) {
    assert.equal(face.class, 'derived', `${face.face} must not claim another class`)
    assert.ok(typeof face.face === 'string' && face.face.length > 0)
    assert.ok(typeof face.reason === 'string' && face.reason.trim().length > 20, `${face.face} needs a real reason`)
  }
  // The reasons travel to the pane verbatim; an empty reason is a bug (AGENTS §3.1).
  assert.equal(RENDERER_FACE_LINES.length, RENDERER_FACES.length)
  assert.ok(RENDERER_FACE_LINES.every((line) => line.includes('derived — ')))
  assert.ok(ELEMENT_VOCABULARY_NOTE.includes('4 of the pin'))
  // The two halves share one table: the payload must carry the same faces.
  const payload = rendererPayloadOf(undefined)
  assert.deepEqual(payload.faces, rendererFaces())
  assert.deepEqual([...payload.vocabulary], [...ELEMENT_VOCABULARY])
})

// ---- the translator ---------------------------------------------------------

test('Box maps its pin flex/space/border props onto the pane box model', () => {
  const tree = {
    type: 'Box',
    props: {
      flexDirection: 'column',
      alignItems: 'center',
      gap: 'md',
      padding: 'sm',
      paddingX: 'lg',
      borderStyle: 'single',
      borderColor: 'green',
      backgroundColor: '#101010',
    },
    children: [{ type: 'Text', children: ['hello'] }],
  }
  const node = nodeOf(tree)
  assert.equal(node.type, 'div')
  assert.equal(node.props['data-anyplugin-face'], 'element.box')
  assert.equal(node.props.style.flexDirection, 'column')
  assert.equal(node.props.style.alignItems, 'center')
  assert.equal(node.props.style.gap, '12px')
  assert.equal(node.props.style.padding, '8px')
  assert.equal(node.props.style.paddingLeft, '16px')
  assert.equal(node.props.style.paddingRight, '16px')
  assert.equal(node.props.style.borderStyle, 'solid')
  assert.equal(node.props.style.borderColor, '#22c55e')
  assert.equal(node.props.style.backgroundColor, '#101010')
  assert.equal(textOf(node), 'hello')
})

test('Text maps size/weight/color/decorations and reports the props it cannot serve', () => {
  const lost = []
  const node = nodeOf(
    {
      type: 'Text',
      props: { color: 'red', size: 'body', weight: 'bold', mono: true, underline: true, maxLines: 2 },
      children: ['body copy'],
    },
    { onLost: (entry) => lost.push(entry.name) },
  )
  assert.equal(node.type, 'span')
  assert.equal(node.props.style.color, '#ef4444')
  assert.equal(node.props.style.fontSize, '14px')
  assert.equal(node.props.style.fontWeight, '700')
  assert.match(node.props.style.fontFamily, /mono/)
  assert.equal(node.props.style.textDecorationLine, 'underline')
  // maxLines is a pin prop this bridge does not serve yet: it is named, not guessed.
  assert.ok(lost.includes('maxLines'))
})

test('Button is a labelled pointer target; its press handle is recorded, not dispatched', () => {
  const lost = []
  const node = nodeOf(
    { type: 'Button', props: { key: 'go', label: 'Go', hotkey: 'g', variant: 'primary' }, press: { plugin: 'fixture', handle: 1 } },
    { onLost: (entry) => lost.push(entry.name) },
  )
  assert.equal(node.type, 'button')
  assert.equal(node.props['data-anyplugin-key'], 'go')
  assert.equal(node.props['data-anyplugin-face'], 'element.button')
  assert.equal(textOf(node), 'Go')
  assert.ok(lost.includes('hotkey'))
  assert.ok(lost.includes('press'), 'the recorded press handle is data this bridge does not dispatch')
  // Variant is served as drawn emphasis, so it is not reported lost.
  assert.equal(lost.includes('variant'), false)
  assert.equal(node.props.style.background, 'var(--dsw-alias-bg-accent, #2563eb)')
  // The launch-handle-shaped `press` member is data; no handler is invented.
  assert.equal(node.props.onClick, undefined)
})

test('Input keeps its recorded value/placeholder/label as local field state', () => {
  const node = nodeOf({ type: 'Input', props: { key: 'query', label: 'Search', placeholder: 'type here', value: 'x' } })
  assert.equal(node.type, 'input')
  assert.equal(node.props['data-anyplugin-key'], 'query')
  assert.equal(node.props.defaultValue, 'x')
  assert.equal(node.props.placeholder, 'type here')
  assert.equal(node.props['aria-label'], 'Search')
  assert.equal(node.props.readOnly, true)
})

test('a pinned tag outside the four-tag vocabulary is refused by name, never guessed', () => {
  const lost = []
  const node = nodeOf({ type: 'Select', props: { key: 'pick', options: [] } }, { onLost: (entry) => lost.push(entry) })
  assert.equal(node.props['data-anyplugin-unsupported'], 'Select')
  assert.equal(node.props['data-anyplugin-face'], undefined)
  assert.ok(lost.some((entry) => entry.kind === 'tag' && entry.name === 'Select'))
})

test('the translator caps depth and cycles without throwing', () => {
  let deep = { type: 'Text', children: ['bottom'] }
  for (let index = 0; index < 80; index += 1) deep = { type: 'Box', children: [deep] }
  const deepResult = translateTree(deep, h)
  assert.equal(deepResult.truncated, true)
  assert.ok(findAll(deepResult.node, (node) => node.props['data-anyplugin-truncated'] !== undefined).length > 0)

  const cyclic = { type: 'Box', children: [] }
  cyclic.children.push(cyclic)
  const cyclicResult = translateTree(cyclic, h)
  assert.equal(cyclicResult.truncated, true)
})

// ---- redraw pacing ----------------------------------------------------------

test('the pacer coalesces a burst to one frame and runs the latest work', () => {
  const frames = []
  const pacer = createPacer((run) => frames.push(run))
  const ran = []
  pacer.schedule(() => ran.push('first'))
  pacer.schedule(() => ran.push('second'))
  pacer.schedule(() => ran.push('third'))
  assert.equal(frames.length, 1, 'a burst must request exactly one frame')
  assert.equal(pacer.pending(), true)
  frames[0]()
  assert.deepEqual(ran, ['third'])
  assert.equal(pacer.pending(), false)
  // A schedule after the flush requests a new frame.
  pacer.schedule(() => ran.push('fourth'))
  assert.equal(frames.length, 2)
  frames[1]()
  assert.deepEqual(ran, ['third', 'fourth'])
})

test('the pacer cancels a queued frame when the pane unmounts', () => {
  const frames = []
  const cancelled = []
  const pacer = createPacer(
    (run) => {
      frames.push(run)
      return frames.length - 1
    },
    (handle) => cancelled.push(handle),
  )
  let ran = 0
  pacer.schedule(() => {
    ran += 1
  })
  assert.equal(pacer.pending(), true)
  assert.equal(pacer.dispose(), true, 'a queued frame is reported as cancelled')
  assert.deepEqual(cancelled, [0])
  assert.equal(pacer.pending(), false)
  // Even if the platform still runs a cancelled frame, nothing is left to do.
  frames[0]()
  assert.equal(ran, 0)
  assert.equal(pacer.dispose(), false, 'disposing with nothing queued is a no-op')
})

// ---- measured geometry ------------------------------------------------------

test('geometry observes with ResizeObserver but measures inside the paced frame', () => {
  const observations = []
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observations.push(this)
    }
    observe() {}
    disconnect() {
      this.disconnected = true
    }
  }
  const frames = []
  const pacer = createPacer((run) => frames.push(run))
  const measured = []
  const { node } = fakeNode({ width: 321.4, height: 180.6 })
  const tracker = createGeometry({
    node,
    env: { ResizeObserver: FakeResizeObserver },
    pacer,
    onChange: (size) => measured.push(size),
  })
  assert.equal(tracker.measured, true)
  assert.equal(observations.length, 1)
  // The initial measure is paced too, not synchronous.
  assert.deepEqual(measured, [])
  observations[0].callback()
  observations[0].callback()
  assert.equal(frames.length, 1, 'two observations in one frame coalesce')
  frames[0]()
  assert.deepEqual(measured, [{ width: 321, height: 181 }])
  tracker.dispose()
  assert.equal(observations[0].disconnected, true)
})

test('geometry is unmeasured, not invented, when the page has no ResizeObserver', () => {
  const frames = []
  const tracker = createGeometry({ node: fakeNode().node, env: {}, pacer: createPacer((run) => frames.push(run)), onChange: () => {} })
  assert.equal(tracker.measured, false)
  assert.equal(frames.length, 0)
})

// ---- focus containment ------------------------------------------------------

test('the focus guard keeps focus inside its own subtree and restores it after a redraw', () => {
  const listeners = new Map()
  const doc = {
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
  }
  const { node, focused, addDescendant } = fakeNode()
  const outside = { focus: () => {} }
  addDescendant(outside)
  const guard = createFocusGuard({ node, document: doc })
  assert.ok(listeners.has('focusin'))
  // A focus event from outside our subtree is ignored, not trapped page-wide.
  listeners.get('focusin')({ target: { tagName: 'BODY' } })
  const inside = { focus: () => focused.push('inside') }
  addDescendant(inside)
  listeners.get('focusin')({ target: inside })
  assert.equal(guard.restore(), inside)
  assert.deepEqual(focused, ['inside'])
  guard.dispose()
  assert.equal(listeners.has('focusin'), false)
})

test('the focus guard falls back to the pane itself when the descendant is gone', () => {
  const { node, focused } = fakeNode()
  const guard = createFocusGuard({ node, document: null })
  assert.equal(guard.restore(), node)
  assert.deepEqual(focused, ['node'])
})

// ---- the browser store: a real round trip -------------------------------

test('the browser store round-trips one GET and records status and pane count', async () => {
  const calls = []
  const store = createRendererStore({
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify({ ok: true, kind: 'anyplugin-renderer', sources: 1, panes: [{ id: 'p1', title: 'One', revision: 1, isPlaced: true }], truncated: false, vocabulary: [...ELEMENT_VOCABULARY], faces: rendererFaces() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  assert.equal(store.getSnapshot().loading, true)
  const snapshot = await store.refresh()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.loading, false)
  assert.equal(snapshot.roundTrips, 1)
  assert.equal(snapshot.lastStatus, 200)
  assert.equal(snapshot.panes.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, RENDERER_ROUTE)
  assert.equal(RENDERER_ROUTE, '/anyplugin/render')

  const second = await store.refresh()
  assert.equal(second.roundTrips, 2)
})

test('a failed round trip keeps the failure visible instead of a stale ok', async () => {
  const store = createRendererStore({
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: false, code: 'render-failed', reason: 'registry exploded' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
  })
  const snapshot = await store.refresh()
  assert.equal(snapshot.ok, false)
  assert.match(snapshot.error, /render-failed: registry exploded/)
  assert.equal(snapshot.lastStatus, 500)

  const throwing = createRendererStore({ fetchImpl: async () => { throw new Error('socket closed') } })
  const failed = await throwing.refresh()
  assert.equal(failed.ok, false)
  assert.match(failed.error, /no response: socket closed/)
})

// ---- the host registry ------------------------------------------------------

test('the registry merges sources, survives a throwing source and caps panes', () => {
  const registry = createRendererRegistry({ paneLimit: 2 })
  assert.equal(registry.snapshot().sources, 0)
  assert.deepEqual(registry.snapshot().panes, [])

  const sourceA = () => ({
    kind: 'mod-ui-headless',
    panes: [
      { plugin: 'a', id: 'p1', title: 'One', revision: 3, isPlaced: true, placement: 'dock', tree: { type: 'Text', children: ['a'] } },
      { id: 'p2', title: 'Two', revision: 1, isPlaced: false, placement: 'inline' },
    ],
    logs: [{ text: 'log a', to: 'transcript' }],
    statuses: ['a: ok'],
  })
  const sourceB = () => ({ panes: [{ id: 'p3', title: 'Three' }] })
  const throwing = () => {
    throw new Error('source broke')
  }
  const offA = registry.register(sourceA)
  registry.register(sourceB)
  registry.register(throwing)
  const snapshot = registry.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.kind, 'anyplugin-renderer')
  assert.equal(snapshot.sources, 3)
  assert.equal(snapshot.panes.length, 2, 'paneLimit caps the merge')
  assert.equal(snapshot.truncated, true)
  assert.ok(snapshot.refusals.some((refusal) => refusal.code === 'source-threw' && /source broke/.test(refusal.reason)))
  assert.ok(snapshot.logs.some((entry) => entry.text === 'log a'))
  assert.ok(snapshot.statuses.includes('a: ok'))
  offA()
  assert.equal(registry.snapshot().sources, 2)
  assert.equal(registry.size(), 2)
})

test('a pane tree above the wire budget becomes a named refusal, not a clipped tree', () => {
  const huge = { type: 'Text', children: ['x'.repeat(MAX_PANE_BYTES + 64)] }
  const pane = { id: 'huge', tree: huge }
  const normalized = normalizeRendererPane(pane)
  assert.equal(normalized.tree, undefined)
  assert.equal(normalized.refusal.code, 'pane-too-large')
  assert.match(normalized.refusal.reason, new RegExp(String(MAX_PANE_BYTES)))

  const registry = createRendererRegistry()
  registry.register(() => ({ panes: [pane] }))
  const snapshot = registry.snapshot()
  assert.equal(snapshot.panes[0].refusal.code, 'pane-too-large')
})

test('the pane budget is a byte budget: multibyte text under the code-unit count is still refused', () => {
  // 40,000 CJK characters are 40,000 UTF-16 code units but 120,000 UTF-8 bytes.
  // A `JSON.stringify(tree).length` measure accepted this under a 98,304-unit
  // budget while the wire carried 120,001+ bytes.
  const multibyte = { type: 'Text', props: { value: '界'.repeat(40000) } }
  const serialised = JSON.stringify(multibyte)
  const utf8Bytes = Buffer.byteLength(serialised, 'utf8')
  assert.ok(serialised.length < MAX_PANE_BYTES, 'the code-unit count is under the cap')
  assert.ok(utf8Bytes > MAX_PANE_BYTES, 'the byte count is over the cap')
  const normalized = normalizeRendererPane({ id: 'wide', tree: multibyte })
  assert.equal(normalized.tree, undefined)
  assert.equal(normalized.refusal.code, 'pane-too-large')
  assert.match(normalized.refusal.reason, new RegExp(`${utf8Bytes} bytes`))
  assert.match(normalized.refusal.reason, new RegExp(`${MAX_PANE_BYTES}-byte wire budget`))

  // The same number of code units in ASCII is accepted, so the test measures
  // bytes and not non-ASCII-ness.
  const ascii = normalizeRendererPane({ id: 'narrow', tree: { type: 'Text', props: { value: 'x'.repeat(serialised.length) } } })
  assert.notEqual(ascii.tree, undefined)
  assert.equal(ascii.refusal, undefined)
})

test('a self-cyclic tree is cut by the seen-set instead of overflowing the stack', () => {
  const cyclic = { type: 'Box', props: {} }
  cyclic.props.self = cyclic
  let normalized
  assert.doesNotThrow(() => {
    normalized = normalizeRendererPane({ id: 'cyclic', tree: cyclic })
  })
  assert.equal(normalized.refusal, undefined, 'the cut tree is small enough for the budget')
  assert.equal(normalized.tree.type, 'Box')
  assert.equal(normalized.tree.props.self, undefined, 'the repeated object is dropped at the cycle')
  assert.ok(JSON.stringify(normalized.tree).length < 200)

  // A DAG is not a cycle: one shared object at two sibling positions survives.
  const shared = { type: 'Text', children: ['shared'] }
  const dag = normalizeRendererPane({ id: 'dag', tree: { type: 'Box', children: [shared, shared] } })
  assert.deepEqual(dag.tree.children, [
    { type: 'Text', children: ['shared'] },
    { type: 'Text', children: ['shared'] },
  ])
})

test('the live JSON depth cap bounds a deep chain instead of recursing forever', () => {
  let deep = { leaf: true }
  for (let index = 0; index < 200; index += 1) deep = { child: deep }
  let normalized
  assert.doesNotThrow(() => {
    normalized = normalizeRendererPane({ id: 'deep', tree: deep })
  })
  assert.equal(normalized.refusal, undefined)
  let level = 0
  let cursor = normalized.tree
  while (cursor !== null && typeof cursor === 'object' && cursor.child !== undefined) {
    level += 1
    cursor = cursor.child
  }
  assert.ok(level <= 64, `a 200-level chain is cut at the live depth cap (got ${level})`)
  assert.doesNotThrow(() => JSON.stringify(normalized.tree))
})

test('a malformed or function-bearing pane is reduced to JSON-safe data', () => {
  const registry = createRendererRegistry()
  registry.register(() => ({
    panes: [
      { id: 'ok', tree: { type: 'Box', props: { onClick: () => {} }, children: [{ type: 'Text', children: ['safe'] }] } },
      { noId: true },
      'not a pane',
    ],
  }))
  const snapshot = registry.snapshot()
  assert.equal(snapshot.panes.length, 1)
  // Dropping a pane that has no usable id is data loss, so the payload says so.
  assert.equal(snapshot.truncated, true)
  assert.equal(JSON.stringify(snapshot.panes[0].tree).includes('onClick'), false)
  assert.doesNotThrow(() => JSON.stringify(snapshot))
})

test('the envelope statuses/logs/refusals are JSON-safe and bounded like the panes', () => {
  const statuses = Array.from({ length: 100 }, (_, index) => `status ${index}`)
  const cyclicLog = { name: 'cyclic' }
  cyclicLog.self = cyclicLog
  const registry = createRendererRegistry({ now: () => 1234 })
  registry.register(() => ({
    panes: [],
    statuses,
    logs: [{ big: 10n, bad: Number.POSITIVE_INFINITY, fn: () => {} }, cyclicLog, new Error('boom')],
    refusals: [{ big: 10n, good: 'kept' }],
  }))
  const payload = registry.snapshot()
  assert.equal(payload.statuses.length, 64, 'statuses are bounded per source')
  assert.equal(payload.statuses[0], 'status 0')
  assert.doesNotThrow(() => JSON.stringify(payload), 'BigInt, cycles and non-finite numbers are normalised away')
  assert.equal(payload.logs.length, 3)
  assert.equal(payload.logs[0].big, undefined)
  assert.equal(payload.logs[0].fn, undefined)
  assert.equal(payload.logs[0].bad, null)
  assert.equal(payload.logs[1].name, 'cyclic')
  assert.equal(payload.logs[1].self, undefined)
  assert.deepEqual(payload.refusals, [{ good: 'kept' }])
  assert.equal(payload.servedAt, 1234, 'servedAt is part of the payload contract')
})

// ---- the loopback read route ----------------------------------------------

const rendererConfig = () => ({
  renderer: () =>
    rendererPayloadOf(
      (() => {
        const registry = createRendererRegistry()
        registry.register(() => ({
          panes: [{ id: 'p1', title: 'Proof', revision: 2, isPlaced: true, tree: { type: 'Text', children: ['from the host half'] } }],
        }))
        return registry
      })(),
    ),
})

test('GET /anyplugin/render answers the normalised snapshot; HEAD is empty; POST is refused', async () => {
  const config = rendererConfig()
  const get = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render', { method: 'GET' }), config)
  assert.equal(get.status, 200)
  assert.equal(get.headers.get('cache-control'), 'no-store')
  const body = await get.json()
  assert.equal(body.ok, true)
  assert.equal(body.kind, 'anyplugin-renderer')
  assert.equal(body.panes.length, 1)
  assert.equal(body.faces.every((face) => face.class === 'derived'), true)

  const head = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render', { method: 'HEAD' }), config)
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')

  const post = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render', { method: 'POST', body: '{}' }), config)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  assert.equal((await post.json()).code, 'method-not-allowed')

  // Same trust boundary as /installs: loopback Host only.
  const rebound = await dispatchPanel(new Request('http://evil.example/anyplugin/render', { method: 'GET' }), config)
  assert.equal(rebound.status, 403)
  assert.equal((await rebound.json()).code, 'host-not-allowed')
})

test('an absent renderer serves sources:0, and a throwing reader is a 500 with its reason', async () => {
  const empty = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render'), {})
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json()
  assert.equal(emptyBody.ok, true)
  assert.equal(emptyBody.sources, 0)
  assert.deepEqual(emptyBody.panes, [])
  assert.deepEqual(emptyBody.faces, rendererFaces())

  const broken = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render'), {
    renderer: () => {
      throw new Error('reader exploded')
    },
  })
  assert.equal(broken.status, 500)
  const brokenBody = await broken.json()
  assert.equal(brokenBody.ok, false)
  assert.equal(brokenBody.code, 'render-failed')
  assert.match(brokenBody.reason, /reader exploded/)
})

test('a cyclic pane is a served pane, not a 500, and does not cost the other panes', async () => {
  const cyclic = { type: 'Box', props: {} }
  cyclic.props.self = cyclic
  const registry = createRendererRegistry()
  registry.register(() => ({
    panes: [
      { id: 'cyclic', title: 'Cyclic', tree: cyclic },
      { id: 'plain', title: 'Plain', tree: { type: 'Text', children: ['plain'] } },
    ],
  }))
  const response = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render'), { renderer: () => rendererPayloadOf(registry) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.panes.map((pane) => pane.id), ['cyclic', 'plain'])
  assert.equal(body.panes[0].tree.props.self, undefined)
  assert.doesNotThrow(() => JSON.stringify(body))
})

test('a pane whose normalisation throws is a recorded refusal while the good panes still serve', async () => {
  const exploding = { id: 'exploding', title: 'Exploding' }
  Object.defineProperty(exploding, 'tree', {
    enumerable: true,
    get() {
      throw new TypeError('tree getter exploded')
    },
  })
  const registry = createRendererRegistry()
  registry.register(() => ({
    panes: [
      { id: 'good', title: 'Good', tree: { type: 'Text', children: ['still served'] } },
      exploding,
    ],
  }))
  const response = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render'), { renderer: () => rendererPayloadOf(registry) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.panes.map((pane) => pane.id), ['good'])
  assert.equal(body.truncated, true, 'the lost pane is declared, not silent')
  const refusal = body.refusals.find((entry) => entry.code === 'pane-normalization-failed')
  assert.ok(refusal, 'the bad pane is recorded, not silently lost')
  assert.match(refusal.reason, /tree getter exploded/)
})

test('a source whose envelope throws is a recorded refusal, not a 500', async () => {
  const registry = createRendererRegistry()
  registry.register(() => ({
    get panes() {
      throw new Error('envelope exploded')
    },
  }))
  registry.register(() => ({ panes: [{ id: 'kept', title: 'Kept' }] }))
  const response = await dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render'), { renderer: () => rendererPayloadOf(registry) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.panes.map((pane) => pane.id), ['kept'])
  assert.ok(body.refusals.some((entry) => entry.code === 'source-malformed' && /envelope exploded/.test(entry.reason)))
})

// ---- both halves together --------------------------------------------------

test('a real sink tree travels host half → route → browser store → React nodes', async () => {
  const bridge = createModBridge({
    plugin: 'fixture/renderer.ts',
    ui: {
      render: (request) => {
        const { Box, Text, Button, Input } = bridge.dollar().ui.resolve(request)
        return Box(
          { flexDirection: 'column', gap: 'md' },
          Text({ size: 'body' }, 'drawn from a validated sink tree'),
          Button({ key: 'go', label: 'Go' }),
          Input({ key: 'query', label: 'Search', placeholder: 'type here' }),
        )
      },
    },
  })
  const registry = createRendererRegistry()
  try {
    await bridge.dollar().ui.open({ id: 'p1', title: 'Proof' })
    // The shipped producer is `readUi` in the materialize-hook; its answer is
    // the sink snapshot's panes, so the sink's own snapshot is the same data.
    registry.register(() => bridge.ui.snapshot())
    const config = { renderer: () => rendererPayloadOf(registry) }

    const store = createRendererStore({
      fetchImpl: () => dispatchPanel(new Request('http://127.0.0.1:4123/anyplugin/render', { method: 'GET' }), config),
    })
    const snapshot = await store.refresh()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.roundTrips, 1)
    assert.equal(snapshot.lastStatus, 200)
    assert.equal(snapshot.panes.length, 1)
    assert.equal(snapshot.panes[0].id, 'p1')

    const nodes = translateTree(snapshot.panes[0].tree, h).node
    assert.equal(nodes.type, 'div')
    assert.equal(nodes.props.style.flexDirection, 'column')
    assert.match(textOf(nodes), /drawn from a validated sink tree/)
    assert.equal(findAll(nodes, (node) => node.type === 'button').length, 1)
    assert.equal(findAll(nodes, (node) => node.type === 'input').length, 1)

    // The round trip is live: closing the pane changes the next response.
    await bridge.dollar().ui.close({ id: 'p1' })
    const afterClose = await store.refresh()
    assert.equal(afterClose.roundTrips, 2)
    assert.equal(afterClose.panes.length, 0)
  } finally {
    bridge.dispose()
  }
})

// ---- the React seats and the keyboard command ------------------------------

test('the main pane draws the snapshot, vocabulary note and all derived faces', async () => {
  const react = hookRuntime()
  const store = createRendererStore({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          kind: 'anyplugin-renderer',
          sources: 1,
          panes: [{ id: 'p1', title: 'One', revision: 4, isPlaced: true, tree: { type: 'Text', children: ['painted'] } }],
          truncated: false,
          vocabulary: [...ELEMENT_VOCABULARY],
          faces: rendererFaces(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  const bridge = createRendererBridge(react, { store })
  let element = react.render(bridge.Pane)
  react.flush()
  await tick()
  element = react.render(bridge.Pane)
  react.flush()
  assert.equal(element.type, 'section')
  assert.equal(element.props['data-anyplugin-renderer'], '')
  assert.equal(element.props['data-anyplugin-vocabulary'], 'Box,Text,Button,Input')
  assert.equal(element.props['data-anyplugin-faces'], String(RENDERER_FACES.length))
  assert.match(textOf(element), /painted/)
  assert.match(textOf(element), /round trip: 1 request\(s\), HTTP 200, 1 producer\(s\), 1 pane\(s\)/)
  assert.equal(element.props['data-anyplugin-round-trips'], '1')
  assert.match(textOf(element), /stay planned/)
  assert.equal(findAll(element, (node) => node.props['data-anyplugin-face-lines'] !== undefined).length, 1)
})

test('the pane measures itself through the page realm and reports the geometry', async () => {
  const frames = []
  const observations = []
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      observations.push(this)
    }
    observe() {}
    disconnect() {}
  }
  const { node } = fakeNode({ width: 640, height: 200 })
  const react = hookRuntime()
  const store = createRendererStore({
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true, kind: 'anyplugin-renderer', sources: 0, panes: [], truncated: false, vocabulary: [...ELEMENT_VOCABULARY], faces: rendererFaces() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })
  const bridge = createRendererBridge(react, {
    store,
    env: { requestAnimationFrame: (run) => frames.push(run), ResizeObserver: FakeResizeObserver, document: null },
  })
  let element = react.render(bridge.Pane)
  element.props.ref(node)
  react.flush()
  // The initial measure is paced, not synchronous.
  assert.equal(frames.length, 1)
  assert.equal(observations.length, 1)
  frames[0]()
  element = react.render(bridge.Pane)
  react.flush()
  assert.equal(element.props['data-anyplugin-geometry'], '640x200')
})

test('the focus restore is pinned to a new snapshot, so a plain render cannot steal focus', async () => {
  const react = hookRuntime()
  let requests = 0
  const store = createRendererStore({
    fetchImpl: async () => {
      requests += 1
      return new Response(JSON.stringify({ ok: true, kind: 'anyplugin-renderer', sources: 0, panes: [], truncated: false, vocabulary: [...ELEMENT_VOCABULARY], faces: rendererFaces(), servedAt: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const bridge = createRendererBridge(react, { store, env: { requestAnimationFrame: (run) => run, document: null } })
  const { node, focused } = fakeNode()
  let element = react.render(bridge.Pane)
  element.props.ref(node)
  react.flush()
  assert.deepEqual(focused, ['node'], 'the mount restores focus into the pane once')

  element = react.render(bridge.Pane)
  react.flush()
  assert.deepEqual(focused, ['node'], 'a later render with the same snapshot must not run the restore again')

  await store.refresh()
  assert.equal(requests >= 1, true)
  element = react.render(bridge.Pane)
  react.flush()
  assert.deepEqual(focused, ['node', 'node'], 'a redraw is the only reason to restore focus')
})

test('the overlay line is an additive click target that requests a fresh snapshot', async () => {
  const react = hookRuntime()
  let requests = 0
  const store = createRendererStore({
    fetchImpl: async () => {
      requests += 1
      return new Response(JSON.stringify({ ok: true, kind: 'anyplugin-renderer', sources: 0, panes: [], truncated: false, vocabulary: [...ELEMENT_VOCABULARY], faces: rendererFaces() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const bridge = createRendererBridge(react, { store })
  const overlay = react.render(bridge.Overlay)
  assert.equal(overlay.type, 'button')
  assert.equal(overlay.props['data-anyplugin-overlay'], '')
  assert.match(textOf(overlay), new RegExp(`${RENDERER_FACES.length} derived faces`))
  overlay.props.onClick()
  await tick()
  assert.equal(requests, 1)
})

test('keyboard registers one declarable command through ctx.shortcuts and hands it the store', async () => {
  const registered = []
  let requests = 0
  const store = {
    refresh: async () => {
      requests += 1
    },
  }
  const focus = []
  const ctx = {
    shortcuts: {
      register: (command) => {
        registered.push(command)
        return () => {}
      },
    },
  }
  const dispose = registerRendererKeyboard(ctx, { store, focus: () => focus.push('pane') })
  assert.equal(registered.length, 1)
  const command = registered[0]
  assert.equal(command.id, 'anyplugin.renderer.request')
  assert.deepEqual(command.aliases, ['anyplugin.renderer.snapshot'])
  assert.deepEqual(command.regions, ['page'])
  assert.deepEqual(command.modals, [])
  assert.equal(typeof command.label, 'function')
  assert.ok(command.label().includes('snapshot'))
  for (const profile of ['web:linux', 'web:macos', 'web:windows']) {
    assert.equal(command.defaults[profile].code, 'KeyR')
    assert.deepEqual(command.defaults[profile].modifiers, ['primary', 'alt'])
  }
  const resolution = command.resolve({ target: null })
  assert.equal(resolution.status, 'handled')
  resolution.run()
  await tick()
  assert.deepEqual(focus, ['pane'])
  assert.equal(requests, 1)
  assert.equal(typeof dispose, 'function')

  // Without the service the bridge is additive: no throw, a no-op disposer.
  const missing = registerRendererKeyboard({}, { store })
  assert.equal(typeof missing, 'function')
  missing()

  // The service is optional and read through ctx.get first: a context that did
  // not inject `shortcuts` throws on the bare property, and neither read may
  // abort apply.
  const viaGet = []
  const getCtx = {
    get: (name) => (name === 'shortcuts' ? { register: (command) => { viaGet.push(command); return () => {} } } : undefined),
    get shortcuts() {
      throw new Error('shortcuts is not injected')
    },
  }
  registerRendererKeyboard(getCtx, { store })
  assert.equal(viaGet.length, 1, 'ctx.get is consulted before the bare property')
  const throwingCtx = {
    get shortcuts() {
      throw new Error('shortcuts is not injected')
    },
  }
  const noop = registerRendererKeyboard(throwingCtx, { store })
  assert.equal(typeof noop, 'function')
  noop()
})
