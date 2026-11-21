// The headless render sink (#75): the six `ui` members record a validated
// tree instead of refusing. The checked shapes are the pin's — surface element
// tables, prop allowlists, required members and children kinds from
// claude-code.d.ts @ 2.1.329 — while the refusal sentence, the "keep the last
// good tree" fallback and press recording are this host's *derived* reading of
// that pin (it draws the engine's own component where this host draws nothing).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createModBridge,
  createUiSink,
  elementsForSurface,
  uiEventPatternMatches,
  uiRenderMatcherMatches,
  UI_COMPONENTS,
  UI_SURFACES,
  validateUiTree,
} from '../src/index.ts'

const at = (bridge) => bridge.dollar().ui

const typedRefuse = (code, reason) => {
  const error = new Error(reason)
  error.code = code
  throw error
}

test('resolve hands a render hook the pinned element tables per surface', () => {
  const bridge = createModBridge({ plugin: 'unit/ui.ts' })
  try {
    const terminal = at(bridge).resolve({ surface: 'terminal', component: 'Pane' })
    assert.deepEqual(Object.keys(terminal).sort(), [
      'Box',
      'Button',
      'Client',
      'Code',
      'Image',
      'Input',
      'Link',
      'Markdown',
      'Progress',
      'Raster',
      'Select',
      'Text',
    ])
    const desktop = at(bridge).resolve({ surface: 'desktop', component: 'Pane' })
    assert.ok('Svg' in desktop && 'Shader' in desktop)
    assert.ok(!('Raster' in desktop))
    // Synchronous, as the pinned mods read it (easel calls `$.ui.resolve(e)`
    // without awaiting, mods/easel/hooks/with-newest-chart/with-newest-chart.ts:46).
    assert.equal(typeof elementsForSurface('terminal', 'unit/ui.ts').Text, 'function')
  } finally {
    bridge.dispose()
  }
})

test('resolve refuses a non-pinned surface with a typed reason naming the difference', () => {
  const bridge = createModBridge({ plugin: 'unit/ui.ts' })
  try {
    assert.throws(
      () => at(bridge).resolve({ surface: 'printer', component: 'Pane' }),
      (error) =>
        error.code === 'ERR_MOD_HOST_UI_INPUT' &&
        error.message.includes('surface "printer" is not one of terminal, desktop, mobile, vscode'),
    )
    assert.throws(
      () => at(bridge).resolve({ surface: 'terminal', component: 'Sidebar' }),
      (error) =>
        error.code === 'ERR_MOD_HOST_UI_INPUT' &&
        error.message.includes('component "Sidebar" is not one the pin declares'),
    )
  } finally {
    bridge.dispose()
  }
})

test('resolve runs the host chain when one is supplied, and refuses a bad answer', () => {
  const base = elementsForSurface('terminal', 'unit/ui.ts')
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    ui: {
      resolve: (input) =>
        input.surface === 'terminal' && input.component === 'Pane'
          ? { Box: base.Box }
          : elementsForSurface(input.surface, 'unit/ui.ts'),
    },
  })
  try {
    const narrowed = at(bridge).resolve({ surface: 'terminal', component: 'Pane' })
    assert.deepEqual(Object.keys(narrowed), ['Box'])
    const wide = at(bridge).resolve({ surface: 'desktop', component: 'Pane' })
    assert.ok('Shader' in wide)

    const broken = createModBridge({
      plugin: 'unit/ui.ts',
      ui: { resolve: () => 'not a table' },
    })
    try {
      assert.throws(
        () => at(broken).resolve({ surface: 'terminal', component: 'Pane' }),
        (error) => error.code === 'ERR_MOD_HOST_UI_INPUT' && error.message.includes('not a table'),
      )
    } finally {
      broken.dispose()
    }
  } finally {
    bridge.dispose()
  }
})

test('open records the latest validated tree and invalidate re-runs the render hook', async () => {
  let renders = 0
  let text = 'first drawing'
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    ui: {
      render: (request) => {
        renders += 1
        assert.equal(request.surface, 'terminal')
        assert.equal(request.component, 'Pane')
        assert.equal(request.requestId, 'proof')
        const { Box, Text } = at(bridge).resolve(request)
        return Box({ flexDirection: 'column' }, Text({}, text))
      },
    },
  })
  try {
    assert.deepEqual(await at(bridge).open({ id: 'proof', title: 'Proof' }), { isPlaced: true })
    let snapshot = bridge.ui.snapshot()
    assert.equal(snapshot.kind, 'mod-ui-headless')
    assert.equal(snapshot.panes.length, 1)
    const pane = snapshot.panes[0]
    assert.equal(pane.id, 'proof')
    assert.equal(pane.title, 'Proof')
    assert.equal(pane.revision, 1)
    assert.equal(pane.isPlaced, true)
    // `focus` is a request (PaneOpenArgs, d.ts:9343 @ 2.1.329): open does not
    // grab focus on its own.
    assert.equal(pane.isFocused, false)
    assert.deepEqual(pane.tree, {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [{ type: 'Text', children: ['first drawing'] }],
    })
    assert.equal(renders, 1)

    text = 'second drawing'
    at(bridge).invalidate('ui.render')
    await bridge.ui.settle()
    snapshot = bridge.ui.snapshot()
    assert.equal(snapshot.panes[0].revision, 2)
    assert.equal(snapshot.panes[0].tree.children[0].children[0], 'second drawing')
    assert.deepEqual(snapshot.invalidations, ['ui.render'])
    assert.equal(renders, 2)

    assert.deepEqual(await at(bridge).open({ id: 'proof', focus: true }), { isPlaced: true })
    assert.equal(bridge.ui.snapshot().panes[0].isFocused, true)
    await at(bridge).close({ id: 'proof' })
    assert.equal(bridge.ui.snapshot().panes.length, 0)
    await at(bridge).close({ id: 'proof' })
    assert.equal(bridge.ui.snapshot().panes.length, 0)
  } finally {
    bridge.dispose()
  }
})

test('an unknown prop refuses the whole tree with the derived message and never throws', async () => {
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    ui: {
      render: () => {
        const { Text } = elementsForSurface('terminal', 'unit/ui.ts')
        return Text({ x: 1 }, 'nope')
      },
    },
  })
  try {
    const result = await at(bridge).open({ id: 'refused' })
    assert.equal(result.isPlaced, false)
    assert.equal(result.reason, 'a tree Pane refuses: Text prop "x" is not allowed')
    assert.equal(bridge.ui.snapshot().panes[0].tree, undefined)
    assert.equal(bridge.ui.snapshot().panes[0].refusal, 'a tree Pane refuses: Text prop "x" is not allowed')
    assert.equal(bridge.ui.snapshot().refusals.length, 1)
  } finally {
    bridge.dispose()
  }
})

test('an invalid redraw keeps the last good tree and its revision', async () => {
  let bad = false
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    ui: {
      render: () => {
        if (bad) return { type: 'Text', props: { shadow: true }, children: ['x'] }
        const { Text } = elementsForSurface('terminal', 'unit/ui.ts')
        return Text({}, 'good')
      },
    },
  })
  try {
    await at(bridge).open({ id: 'steady' })
    const good = bridge.ui.snapshot().panes[0].tree
    bad = true
    at(bridge).invalidate('ui.render')
    await bridge.ui.settle()
    const pane = bridge.ui.snapshot().panes[0]
    assert.deepEqual(pane.tree, good)
    assert.equal(pane.revision, 1)
    assert.equal(pane.isPlaced, true)
    assert.equal(pane.refusal, 'a tree Pane refuses: Text prop "shadow" is not allowed')
  } finally {
    bridge.dispose()
  }
})

test('a render hook that throws is recorded, not rethrown into the mod', async () => {
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    ui: {
      render: () => {
        throw new Error('the drawing broke')
      },
    },
  })
  try {
    const result = await at(bridge).open({ id: 'broken' })
    assert.equal(result.isPlaced, false)
    assert.match(result.reason, /a tree Pane refuses: the render hook threw: the drawing broke/)
    assert.equal(bridge.ui.snapshot().refusals.length, 1)
  } finally {
    bridge.dispose()
  }
})

test('status and log record the pinned values; a bad sink is a recorded refusal', () => {
  const bridge = createModBridge({ plugin: 'unit/ui.ts' })
  try {
    at(bridge).status('watching 3 files')
    at(bridge).log('debug line', { to: 'debug' })
    at(bridge).log('plain line')
    const snapshot = bridge.ui.snapshot()
    assert.equal(snapshot.status, 'watching 3 files')
    assert.deepEqual(snapshot.logs, [
      { text: 'debug line', to: 'debug' },
      { text: 'plain line', to: 'transcript' },
    ])
    at(bridge).status(undefined)
    assert.equal(bridge.ui.snapshot().status, undefined)
    at(bridge).log('x', { to: 'file' })
    assert.match(bridge.ui.snapshot().refusals.at(-1), /log sink must be "transcript" or "debug"/)
  } finally {
    bridge.dispose()
  }
})

test('ask stays a typed refusal; it names the pin line it cannot serve', async () => {
  const bridge = createModBridge({ plugin: 'unit/ui.ts' })
  try {
    await assert.rejects(at(bridge).ask(), (error) => {
      assert.equal(error.code, 'ERR_MOD_HOST_UI_UNSUPPORTED')
      assert.match(error.message, /claude-code\.d\.ts:2856 @ 2\.1\.329/)
      return true
    })
  } finally {
    bridge.dispose()
  }
})

test('open checks the pin names: malformed id, control-character title, ignored placement', async () => {
  const bridge = createModBridge({ plugin: 'unit/ui.ts' })
  try {
    await assert.doesNotReject(at(bridge).close({ id: 'never-opened' }))
    const long = await at(bridge).open({ id: 'x'.repeat(65) })
    assert.equal(long.isPlaced, false)
    assert.match(long.reason, /pane id must be 1-64 characters/)
    const control = await at(bridge).open({ id: 'title', title: 'ok\u0007' })
    assert.equal(control.isPlaced, false)
    assert.match(control.reason, /control character/)
    // A placement other than 'widget' is ignored, not refused (d.ts:9435-9441).
    assert.deepEqual(await at(bridge).open({ id: 'dock', placement: 'inline' }), { isPlaced: true })
    assert.equal(bridge.ui.snapshot().panes[0].placement, 'dock')
    assert.deepEqual(await at(bridge).open({ id: 'widget', placement: 'widget' }), { isPlaced: true })
    assert.equal(bridge.ui.snapshot().panes.find((pane) => pane.id === 'widget').placement, 'widget')
  } finally {
    bridge.dispose()
  }
})

test('two sinks cannot own the same pane id; a close releases the claim', async () => {
  const owners = new Map()
  const make = (plugin) =>
    createUiSink({
      plugin,
      ownerOf: (id) => owners.get(id),
      claim: (id) => owners.set(id, plugin),
      release: (id) => {
        if (owners.get(id) === plugin) owners.delete(id)
      },
      refuse: typedRefuse,
    })
  const first = make('one')
  const second = make('two')
  try {
    await first.open({ id: 'shared' })
    const refused = await second.open({ id: 'shared' })
    assert.equal(refused.isPlaced, false)
    assert.match(refused.reason, /already held by one/)
    await first.close({ id: 'shared' })
    assert.deepEqual(await second.open({ id: 'shared' }), { isPlaced: true })
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('without a renderer a pane holds the engine default, as an all-declining chain does', async () => {
  const bridge = createModBridge({ plugin: 'unit/ui.ts' })
  try {
    assert.deepEqual(await at(bridge).open({ id: 'engine' }), { isPlaced: true })
    assert.deepEqual(bridge.ui.snapshot().panes[0].tree, { type: 'engine', ref: 0 })
  } finally {
    bridge.dispose()
  }
})

test('the render matcher is the pin grammar: partial objects, regexps and arrays', () => {
  const request = {
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proof',
    plugin: 'unit/ui.ts',
    viewport: { columns: 80, rows: 24 },
    props: { title: 'UI proof', placement: 'dock' },
  }
  assert.equal(uiRenderMatcherMatches(undefined, request), true)
  assert.equal(uiRenderMatcherMatches({ component: 'Pane' }, request), true)
  assert.equal(uiRenderMatcherMatches({ component: 'PromptHint' }, request), false)
  assert.equal(uiRenderMatcherMatches({ props: { title: 'UI proof' } }, request), true)
  assert.equal(uiRenderMatcherMatches({ props: { title: 'other' } }, request), false)
  assert.equal(uiRenderMatcherMatches({ props: { title: /^UI/ } }, request), true)
  assert.equal(uiRenderMatcherMatches({ requestId: ['proof', 'other'] }, request), true)
  assert.equal(uiRenderMatcherMatches({ surface: 'desktop' }, request), false)
  // A field the pin does not let a matcher narrow is not silently accepted.
  assert.equal(uiRenderMatcherMatches({ nope: 1 }, request), false)
})

test('on("ui.*") reaches a ui.render dispatch through the pin pattern grammar', () => {
  assert.equal(uiEventPatternMatches('ui.*', 'ui.render'), true)
  assert.equal(uiEventPatternMatches('ui.*', 'ui.resolve'), true)
  assert.equal(uiEventPatternMatches('*', 'ui.render'), true)
  assert.equal(uiEventPatternMatches('ui.render', 'ui.render'), true)
  assert.equal(uiEventPatternMatches('ui.render', 'ui.resolve'), false)
  assert.equal(uiEventPatternMatches(['tool.*', 'ui.render'], 'ui.render'), true)
  assert.equal(uiEventPatternMatches('!ui.render', 'ui.render'), false)
  assert.equal(uiEventPatternMatches('!ui.render', 'ui.resolve'), true)
})

test('the validator is the pin table, not our constructors: required members per tag', () => {
  const on = (tree, surface = 'terminal') => validateUiTree(tree, 'Pane', surface)

  assert.match(on({ type: 'Button', props: { key: 'k' }, press: { plugin: 'p', handle: 1 } }).refusal, /prop "label" is required/)
  assert.match(on({ type: 'Button', props: { key: 'k', label: 'l' } }).refusal, /press is required/)
  assert.match(on({ type: 'Input', props: { key: 'k' } }).refusal, /press is required/)
  assert.match(on({ type: 'Select', props: { key: 'k' }, press: { plugin: 'p', handle: 1 } }).refusal, /prop "options" is required/)
  assert.match(on({ type: 'Link', props: {} }).refusal, /prop "href" is required/)
  assert.match(on({ type: 'Code', props: {} }).refusal, /prop "source" is required/)
  assert.equal(on({ type: 'Markdown', props: { text: 'x' } }).ok, true)
  assert.match(on({ type: 'Client', props: { key: 'k', module: 'm' } }).refusal, /client stamp is required/)
  assert.equal(on({ type: 'Client', props: { key: 'k', module: 'm' }, client: { plugin: 'p' } }).ok, true)
  assert.match(on({ type: 'Raster', props: { key: 'k', columns: 1, rows: 1, cells: 'x' } }).refusal, /raster stamp is required/)
  assert.match(on({ type: 'Image', props: { source: 's', columns: 1, rows: 1 } }).refusal, /image stamp is required/)
  assert.match(
    on({ type: 'Image', props: { source: 's', columns: 1, rows: 1 }, image: { plugin: 'p' } }).refusal,
    /prop "alt" is required/,
  )
  assert.match(on({ type: 'Svg', props: { source: 's', alt: 'a' } }).refusal, /not declared on the terminal surface/)
  assert.equal(on({ type: 'Svg', props: { source: 's', alt: 'a' } }, 'desktop').ok, true)
  assert.match(on({ type: 'Raster', props: { key: 'k', columns: 1, rows: 1, cells: 'x' }, raster: { plugin: 'p' } }, 'desktop').refusal, /not declared/)

  // Text has no `key` at this pin (TextProps, d.ts:16722 @ 2.1.329).
  assert.equal(on({ type: 'Text', props: { key: 'x' }, children: ['t'] }).ok, false)
  // Code is a leaf, Button children are strings and Text, Link children inline.
  assert.equal(on({ type: 'Code', props: { source: 'x' }, children: ['y'] }).ok, false)
  assert.equal(on({ type: 'Button', props: { key: 'k', label: 'l' }, press: { plugin: 'p', handle: 1 }, children: ['ok'] }).ok, true)
  assert.equal(
    on({
      type: 'Button',
      props: { key: 'k', label: 'l' },
      press: { plugin: 'p', handle: 1 },
      children: [{ type: 'Box', children: ['nope'] }],
    }).ok,
    false,
  )
  assert.equal(on({ type: 'Link', props: { href: 'https://e' }, children: ['label'] }).ok, true)
  assert.equal(on({ type: 'Text', children: [{ type: 'engine', ref: 0 }] }).ok, false)
  assert.match(on({ type: 'engine', ref: -1 }).refusal, /engine ref must be a non-negative/)
  assert.equal(on({ type: 'engine', ref: 0 }).ok, true)
  assert.equal(on({ type: 'Text', props: { shadow: true }, children: ['x'] }).ok, false)
  assert.equal(on({ type: 'Box', children: 'x' }).ok, false)
})

test("constructors stamp the members the runtime owns", () => {
  const { Button, Client, Raster, Image, Select } = elementsForSurface('terminal', 'unit/ui.ts')
  assert.equal(
    validateUiTree(Button({ label: 'apply' }, 'apply'), 'Pane').ok,
    true,
    'Button takes key from label / the one string child',
  )
  const client = Client({ key: 'k', module: 'm' })
  assert.deepEqual(client.client, { plugin: 'unit/ui.ts' })
  assert.equal(validateUiTree(client, 'Pane').ok, true, 'Client carries the client stamp')
  const raster = Raster({ key: 'k', columns: 1, rows: 1, cells: 'x' })
  assert.deepEqual(raster.raster, { plugin: 'unit/ui.ts' })
  assert.equal(validateUiTree(raster, 'Pane').ok, true)
  const image = Image({ source: 's', columns: 1, rows: 1, alt: 'a' })
  assert.deepEqual(image.image, { plugin: 'unit/ui.ts' })
  assert.equal(validateUiTree(image, 'Pane').ok, true)
  assert.equal(
    validateUiTree(Select({ key: 'k', options: [{ value: 'a' }] }), 'Pane').ok,
    true,
    'Select carries a stamped press',
  )
})

test('invalidate maps the pin union: redraw, cache drop, or a typed refusal', async () => {
  const dropped = []
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    ui: {
      render: () => undefined,
      dropCache: (event) => {
        dropped.push(event)
        return event === 'prompt.context'
      },
    },
  })
  try {
    at(bridge).invalidate('prompt.context')
    assert.deepEqual(dropped, ['prompt.context'])
    at(bridge).invalidate('prompt.section')
    assert.deepEqual(dropped, ['prompt.context', 'prompt.section'])
    assert.match(bridge.ui.snapshot().refusals.at(-1), /the sink owns no cache for this event/)
    for (const event of ['prompt.attachment', 'tool.describe', 'tool.list', 'command.describe', 'config.describe']) {
      at(bridge).invalidate(event)
      assert.match(bridge.ui.snapshot().refusals.at(-1), new RegExp(`\\$\\.ui\\.invalidate: ${event} is refused`))
    }
    at(bridge).invalidate('not-an-event')
    assert.match(bridge.ui.snapshot().refusals.at(-1), /not an InvalidatableEventName/)
    assert.deepEqual(bridge.ui.snapshot().invalidations, [
      'prompt.context',
      'prompt.section',
      'prompt.attachment',
      'tool.describe',
      'tool.list',
      'command.describe',
      'config.describe',
    ])
  } finally {
    bridge.dispose()
  }
})

test('dispose clears the reader and releases every pane claim', async () => {
  const released = []
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    ui: { render: () => undefined },
  })
  const sink = createUiSink({
    plugin: 'unit/release',
    release: (id) => released.push(id),
    refuse: typedRefuse,
  })
  try {
    await at(bridge).open({ id: 'p' })
    at(bridge).status('here')
    at(bridge).log('line')
    bridge.dispose()
    const snapshot = bridge.ui.snapshot()
    assert.deepEqual(snapshot.panes, [])
    assert.deepEqual(snapshot.logs, [])
    assert.deepEqual(snapshot.invalidations, [])
    assert.equal(snapshot.status, undefined)
    assert.equal((await bridge.ui.open({ id: 'after' })).isPlaced, false)
    assert.throws(() => at(bridge), (error) => error.code === 'ERR_MOD_HOST_DISPOSED')

    await sink.open({ id: 'claimed' })
    sink.dispose()
    assert.deepEqual(released, ['claimed'])
    assert.deepEqual(sink.snapshot().panes, [])
  } finally {
    bridge.dispose()
    sink.dispose()
  }
})

test("the pinned surface and component lists are the pin's", () => {
  assert.deepEqual([...UI_SURFACES], ['terminal', 'desktop', 'mobile', 'vscode'])
  assert.equal(UI_COMPONENTS.length, 20)
  assert.ok(UI_COMPONENTS.includes('Pane') && UI_COMPONENTS.includes('Backdrop'))
})
