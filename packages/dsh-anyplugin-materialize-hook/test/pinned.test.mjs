// A mod row that reaches the materializer without the emitter's tree pin (a
// hand-written config) is refused before `loadMod`; one whose pinned bytes
// changed since the grant is refused with the reason. Both are exec-class
// refusals, so the refusals are warnings and traces, not loads.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.ts'
import { pinnedMod } from './pinned.mjs'

const entry = (file) => [
  'export function register(on: On): void {',
  `  on('session.start', async () => { const _ = ${JSON.stringify(file)} })`,
  '}',
  '',
].join('\n')

const harness = () => {
  const warnings = []
  const ctx = {
    on() {
      return () => {}
    },
    effect(register) {
      return register()
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  }
  return { ctx, warnings }
}

test('a hand-written mod row without the grant pin is refused before evaluation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-'))
  try {
    writeFileSync(join(dir, 'register.ts'), entry('hand'))
    const { ctx, warnings } = harness()
    await apply(ctx, { hooks: [], mods: [{ entry: 'register.ts' }], plugin: 'probe', pluginRoot: dir })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /refused mod register\.ts: no hash-pinned grant was carried/)
    assert.match(warnings[0], /load refused/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('changing a pinned module byte refuses the load and names both hashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-'))
  try {
    writeFileSync(join(dir, 'register.ts'), entry('before'))
    const pinned = pinnedMod(dir, 'register.ts')
    writeFileSync(join(dir, 'register.ts'), entry('after'))
    const { ctx, warnings } = harness()
    await apply(ctx, { hooks: [], mods: [pinned], plugin: 'probe', pluginRoot: dir })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /artifact changed since the grant/)
    assert.match(warnings[0], new RegExp(pinned.artifactHash))
    assert.match(warnings[0], /sha256:[0-9a-f]{64}/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
