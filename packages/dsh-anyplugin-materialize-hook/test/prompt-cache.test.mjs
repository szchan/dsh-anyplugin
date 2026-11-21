// SHOULD-4 from review-88b: the prompt-context cache lives in the seat, not in
// the sink. The sink tests stub `dropCache`, so without this test a regression
// in `resetPrompt` / `promptResets` (the only path that drops the seat's cache
// when a mod invalidates `prompt.context`) would stay green.
//
// The proof is the reviewer's: assemble once (`assembly 1`), assemble again with
// the cache warm (still `assembly 1`), invalidate `prompt.context` from a
// classic.Stop hook, then assemble (must be `assembly 2`).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.ts'

const harness = () => {
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const traces = []

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
  }
  return {
    ctx,
    listeners,
    disposers,
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

const fixture = [
  'let assembly = 0',
  'export function register(on: On): void {',
  '  on("prompt.context", ($: Dollar, event: any) => {',
  '    assembly += 1',
  '    const blocks = Array.isArray(event.blocks) ? event.blocks : []',
  '    return { blocks: [...blocks, { name: "proof", text: "assembly " + assembly }] }',
  '  })',
  '  on("classic.Stop", ($: Dollar) => {',
  '    $.ui.invalidate("prompt.context")',
  '  })',
  '}',
  '',
].join('\n')

test('invalidating prompt.context drops the seat cache and re-runs the mod', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-prompt-cache-'))
  writeFileSync(join(dir, 'prompt-cache.ts'), fixture)
  const { ctx, listeners, disposers, warnings } = harness()
  try {
    await apply(ctx, {
      hooks: [],
      mods: [{ entry: 'prompt-cache.ts' }],
      plugin: 'mod',
      pluginRoot: dir,
    })
    assert.deepEqual(warnings, [])

    const seat = seatCtx()
    const agent = { session: { header: { id: 's1', cwd: dir } }, ctx: seat.ctx }
    for (const listener of listeners.get('agent/created') ?? []) await listener({ agent })

    const assemble = seat.listeners.get('system-prompt/assemble')?.[0]
    assert.ok(assemble !== undefined, 'the seat mounts system-prompt/assemble')
    const context = { contexts: [{ name: 'claudeMd', text: 'baseline' }] }
    const run = async () => {
      const assembled = await assemble({}, undefined, async () => context)
      return JSON.stringify(assembled.contexts)
    }

    assert.match(await run(), /assembly 1/)
    assert.doesNotMatch(await run(), /assembly 2/, 'the cache is warm, so the mod did not run again')

    for (const listener of seat.listeners.get('agent/turn-stopping') ?? []) {
      await listener({ agent: { session: { header: { id: 's1' } } } })
    }

    assert.match(await run(), /assembly 2/, 'invalidate dropped the cache and the mod ran again')
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
