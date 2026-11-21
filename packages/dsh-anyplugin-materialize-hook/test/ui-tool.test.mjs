// #75: the `mod_ui` reader. One tool, registered only while a loaded mod has
// an open pane, returning the sink's latest validated tree. These tests drive
// the real materializer over a fake host ctx with a `tools` service, so the
// lifetime rules (open → tool, last pane closed → no tool, unload → no tool)
// are the ones a pinned harness would see.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.ts'

const harness = () => {
  const listeners = new Map()
  const disposers = []
  const tools = new Map()
  const warnings = []
  const traces = []

  const toolService = {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
    schemas() {
      return [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description }))
    },
    get(name) {
      return tools.get(name)
    },
    async execute({ calls }) {
      const results = []
      for (const call of calls) {
        const tool = tools.get(call.name)
        assert.ok(tool !== undefined, `tool ${call.name} is registered`)
        const value = await tool.execute(JSON.parse(call.arguments ?? '{}'))
        results.push({ callId: call.id, result: { isError: false, content: [], value } })
      }
      return { results, additionalContexts: [], concluded: false }
    },
  }

  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
      }
    },
    effect(register) {
      const dispose = register()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    logger: { warn: (message) => warnings.push(String(message)) },
    tools: toolService,
  }
  return {
    ctx,
    listeners,
    disposers,
    tools,
    warnings,
    traces,
    config: (extra) => ({
      hooks: [],
      onTrace: (event, result) => traces.push({ event, decision: result.decision, trace: result.trace }),
      ...extra,
    }),
  }
}

const seatCtx = () => {
  const listeners = new Map()
  return {
    listeners,
    ctx: {
      on(event, listener) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return () => {}
      },
      effect(register) {
        return register()
      },
      logger: { warn: () => {} },
    },
  }
}

const panesFixture = [
  'export function register(on: On): void {',
  '  on("session.start", async ($: Dollar, event: unknown, next: Next) => {',
  '    $.ui.status("tool proof");',
  '    $.ui.log("tool proof");',
  '    await $.ui.open({ id: "p1", title: "One" });',
  '    await $.ui.open({ id: "p2" });',
  '    return next(event);',
  '  });',
  '  on("ui.render", { component: "Pane" }, ($: Dollar, event: any) => {',
  '    const { Box, Text } = $.ui.resolve(event);',
  '    return Box({ flexDirection: "column" }, Text({}, "pane " + event.requestId));',
  '  });',
  '  on("classic.PreToolUse", async ($: Dollar, event: unknown, next: Next) => {',
  '    await $.ui.close({ id: "p1" });',
  '    return next(event);',
  '  });',
  '  on("classic.Stop", async ($: Dollar, event: unknown, next: Next) => {',
  '    await $.ui.close({ id: "p2" });',
  '    return next(event);',
  '  });',
  '}',
  '',
].join('\n')

test('mod_ui appears with the first pane, returns the validated tree, and leaves with the last pane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-ui-tool-'))
  try {
    writeFileSync(join(dir, 'panes.ts'), panesFixture)
    const { ctx, listeners, tools, warnings, config } = harness()
    await apply(ctx, { ...config({}), mods: [{ entry: 'panes.ts' }], pluginRoot: dir })

    assert.ok(tools.has('mod_ui'), 'a pane is open, so the reader exists')
    assert.deepEqual(tools.get('mod_ui').parameters.additionalProperties, false)
    assert.equal(tools.get('mod_ui').output.render().length, 0)

    const value = await tools.get('mod_ui').execute({})
    assert.equal(value.kind, 'mod-ui-headless')
    assert.deepEqual(
      value.panes.map((pane) => pane.id),
      ['p1', 'p2'],
    )
    const first = value.panes[0]
    assert.equal(first.title, 'One')
    assert.equal(first.revision, 1)
    assert.equal(first.isPlaced, true)
    assert.deepEqual(first.tree, {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [{ type: 'Text', children: ['pane p1'] }],
    })
    assert.equal(value.status, 'mod/panes.ts: tool proof')
    assert.deepEqual(value.logs, [{ plugin: 'mod/panes.ts', text: 'tool proof', to: 'transcript' }])

    const filtered = await tools.get('mod_ui').execute({ pane: 'p2' })
    assert.deepEqual(
      filtered.panes.map((pane) => pane.id),
      ['p2'],
    )

    // A seat fires the pin's PreToolUse and Stop hooks; each closes a pane
    // through the same sink, and the reader follows the pane count.
    const seat = seatCtx()
    const agent = {
      session: { header: { id: 'session-ui-tool', cwd: '/work' } },
      model: { current: () => ({ provider: 'fake', model: 'fake-1' }) },
      ctx: seat.ctx,
    }
    for (const listener of listeners.get('agent/created') ?? []) await listener({ agent })
    await seat.listeners.get('tools/pre-execute')[0]({ name: 'Read', arguments: {}, callId: 1 }, async () => ({
      kind: 'accept',
    }))
    assert.deepEqual(
      (await tools.get('mod_ui').execute({})).panes.map((pane) => pane.id),
      ['p2'],
    )
    await seat.listeners.get('agent/turn-stopping')[0]({ agent, lastAssistantMessage: 'done' })
    assert.equal(tools.has('mod_ui'), false, 'the last pane closed, so the reader is gone')
    assert.deepEqual(
      warnings.filter((warning) => warning.includes('ui.render')),
      ['anyplugin mod mod/panes.ts#1: ui.render is sink-dispatched, kernel-ordered (not a host event)'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unloading a mod with an open pane removes the reader and clears the sink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-ui-tool-'))
  try {
    writeFileSync(
      join(dir, 'open-only.ts'),
      [
        'export function register(on: On): void {',
        '  on("session.start", async ($: Dollar, event: unknown, next: Next) => {',
        '    await $.ui.open({ id: "held" });',
        '    return next(event);',
        '  });',
        '  on("ui.render", { component: "Pane" }, ($: Dollar) => {',
        '    const { Text } = $.ui.resolve({ surface: "terminal", component: "Pane" });',
        '    return Text({}, "held");',
        '  });',
        '}',
        '',
      ].join('\n'),
    )
    const { ctx, disposers, tools, config } = harness()
    await apply(ctx, { ...config({}), mods: [{ entry: 'open-only.ts' }], pluginRoot: dir })
    assert.ok(tools.has('mod_ui'))
    for (const dispose of disposers.splice(0)) dispose()
    assert.equal(tools.has('mod_ui'), false, 'unload removed the reader')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ui.resolve hooks run at load, once per surface and component the matcher selects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-ui-tool-'))
  try {
    writeFileSync(
      join(dir, 'resolve-hooks.ts'),
      [
        'export function register(on: On): void {',
        '  on("session.start", async ($: Dollar, event: unknown, next: Next) => {',
        '    await $.ui.open({ id: "resolved" });',
        '    return next(event);',
        '  });',
        '  on("ui.resolve", { component: "Pane" }, async ($: Dollar, event: any, next: Next) => {',
        '    $.ui.log("resolve " + event.surface + ":" + event.component);',
        '    return next(event);',
        '  });',
        '  on("ui.render", { component: "Pane" }, ($: Dollar, event: any) => {',
        '    const { Text } = $.ui.resolve(event);',
        '    return Text({}, "resolved");',
        '  });',
        '}',
        '',
      ].join('\n'),
    )
    const { ctx, tools, config } = harness()
    await apply(ctx, { ...config({}), mods: [{ entry: 'resolve-hooks.ts' }], pluginRoot: dir })
    const value = await tools.get('mod_ui').execute({})
    const resolveLogs = value.logs.filter((entry) => entry.text.startsWith('resolve '))
    assert.deepEqual(
      resolveLogs.map((entry) => entry.text).sort(),
      ['resolve desktop:Pane', 'resolve mobile:Pane', 'resolve terminal:Pane', 'resolve vscode:Pane'],
      'the pin fires ui.resolve at load, per surface and component (not per draw)',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two mods cannot hold the same pane id: the second open is refused in the tool payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-ui-tool-'))
  try {
    writeFileSync(
      join(dir, 'holder.ts'),
      [
        'export function register(on: On): void {',
        '  on("session.start", async ($: Dollar, event: unknown, next: Next) => {',
        '    await $.ui.open({ id: "clash", title: "first" });',
        '    return next(event);',
        '  });',
        '  on("ui.render", { component: "Pane" }, () => undefined);',
        '}',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(dir, 'contender.ts'),
      [
        'export function register(on: On): void {',
        '  on("session.start", async ($: Dollar, event: unknown, next: Next) => {',
        '    const opened = await $.ui.open({ id: "clash", title: "second" });',
        '    $.ui.log("contender " + JSON.stringify(opened));',
        '    return next(event);',
        '  });',
        '  on("ui.render", { component: "Pane" }, () => undefined);',
        '}',
        '',
      ].join('\n'),
    )
    const { ctx, tools, config } = harness()
    await apply(ctx, {
      ...config({}),
      mods: [{ entry: 'holder.ts' }, { entry: 'contender.ts' }],
      pluginRoot: dir,
    })
    const value = await tools.get('mod_ui').execute({})
    assert.equal(value.panes.length, 1, 'one pane id, one pane')
    assert.equal(value.panes[0].title, 'first')
    const contender = value.logs.find((entry) => entry.text.startsWith('contender '))
    assert.match(contender.text, /"isPlaced":false/)
    assert.match(contender.text, /already held by mod\/holder\.ts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
