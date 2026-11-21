// The headless render sink (#75): the six `ui` members record a validated
// tree instead of refusing, and the pinned element schema is the contract.
// The shapes below are the pin's: a render chain's innermost `next()` is
// `{ type: 'engine', ref: 0 }` (claude-code.d.ts:12513 @ 2.1.329), and a bad
// prop refuses the whole tree with the wording the ticket names.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createModBridge,
  elementsForSurface,
  uiRenderChain,
  validateUiTree,
  UI_COMPONENTS,
  UI_SURFACES,
} from '../src/index.ts'

const at = (bridge) => bridge.dollar().ui

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

test('open records the latest validated tree and invalidate re-runs the render hook', async () => {
  let renders = 0
  let text = 'first drawing'
  const bridge = createModBridge({
    plugin: 'unit/ui.ts',
    dataDir: mkdtempSync(join(tmpdir(), 'anyplugin-ui-unit-')),
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
    assert.equal(pane.isFocused, true)
    assert.deepEqual(pane.tree, {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [{ type: 'Text', children: ['first drawing'] }],
    })
    assert.equal(renders, 1)

    text = 'second drawing'
    const window = bridge.dollar()
    at(bridge).invalidate('ui.render')
    await bridge.ui.settle()
    snapshot = bridge.ui.snapshot()
    assert.equal(snapshot.panes[0].revision, 2)
    assert.equal(snapshot.panes[0].tree.children[0].children[0], 'second drawing')
    assert.deepEqual(snapshot.invalidations, ['ui.render'])
    assert.equal(renders, 2)

    // The pane is load state: a second `$` serves the same sink.
    assert.equal(typeof window.ui.open, 'function')
    await at(bridge).close({ id: 'proof' })
    assert.equal(bridge.ui.snapshot().panes.length, 0)
    await at(bridge).close({ id: 'proof' })
    assert.equal(bridge.ui.snapshot().panes.length, 0)
  } finally {
    bridge.dispose()
  }
})

test('an unknown prop refuses the whole tree with the upstream-shaped message and never throws', async () => {
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

test('a close is a no-op for an unknown pane and open refuses a malformed id', async () => {
  const bridge = createModBridge({ plugin: 'unit/ui.ts' })
  try {
    await assert.doesNotReject(at(bridge).close({ id: 'never-opened' }))
    const result = await at(bridge).open({ id: 'x'.repeat(65) })
    assert.equal(result.isPlaced, false)
    assert.match(result.reason, /pane id must be 1-64 characters/)
  } finally {
    bridge.dispose()
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

test('the render chain runs matching hooks in order and next(e) rewrites the tree', () => {
  const seen = []
  const registrations = [
    {
      event: 'ui.render',
      matcher: { component: 'Pane' },
      handler: (event, next) => {
        seen.push('outer')
        return next(event)
      },
    },
    {
      event: 'ui.render',
      matcher: { component: 'Pane', requestId: 'other' },
      handler: () => 'not this pane',
    },
    {
      event: 'ui.render',
      matcher: { component: 'Pane' },
      handler: () => 'inner drawing',
    },
  ]
  const tree = uiRenderChain(registrations, {
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mine',
    plugin: 'unit/ui.ts',
    viewport: { columns: 80, rows: 24 },
    props: {},
  })
  assert.equal(tree, 'inner drawing')
  assert.deepEqual(seen, ['outer'])
})

test('the validator accepts the pinned union and refuses a tree the pin rejects', () => {
  const { Box, Text, Button, Select, Code, Markdown, Link, Progress } = elementsForSurface(
    'terminal',
    'unit/ui.ts',
  )
  const ok = Box(
    { flexDirection: 'column', paddingX: 1 },
    Text({ color: 'red', bold: true }, 'diff head'),
    Button({ label: 'apply' }, 'apply'),
    Select({ options: [{ value: 'a', label: 'A' }], value: 'a' }),
    Code({ source: '+1', format: 'diff' }),
    Markdown({ text: '# heading' }),
    Link({ href: 'https://example.com', label: 'site' }),
    Progress({ label: 'reading', value: 1, max: 4 }),
  )
  assert.equal(validateUiTree(ok, 'Pane').ok, true)

  const stale = { type: 'Text', props: { shadow: true }, children: ['x'] }
  assert.deepEqual(validateUiTree(stale, 'Pane'), {
    ok: false,
    refusal: 'a tree Pane refuses: Text prop "shadow" is not allowed',
  })
  assert.equal(validateUiTree({ type: 'Engine', ref: 0 }, 'Pane').ok, false)
  assert.match(validateUiTree({ type: 'engine', ref: -1 }, 'Pane').refusal, /engine ref must be a non-negative/)
  assert.equal(validateUiTree({ type: 'Text', children: [{ type: 'engine', ref: 0 }] }, 'Pane').ok, false)
  assert.equal(validateUiTree({ type: 'Box', props: { flexDirection: 'column' }, children: 'x' }, 'Pane').ok, false)
})

test("the pinned surface and component lists are the pin's", () => {
  assert.deepEqual([...UI_SURFACES], ['terminal', 'desktop', 'mobile', 'vscode'])
  assert.equal(UI_COMPONENTS.length, 20)
  assert.ok(UI_COMPONENTS.includes('Pane') && UI_COMPONENTS.includes('Backdrop'))
})
