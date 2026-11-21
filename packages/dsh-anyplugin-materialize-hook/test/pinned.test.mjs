// A mod row that reaches the materializer must carry the emitter's tree pin
// over the *whole plugin tree* (D51). A hand-written row is refused before
// `loadMod`; a tree that gained, lost or changed a file since the grant is
// refused with the reason; a row with no root cannot be re-read at all. Every
// refusal is an exec-class refusal: a warning and a trace, never an evaluation.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { treeArtifact } from '../../dsh-anyplugin-trust/src/index.ts'
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
  const events = []
  const ctx = {
    on(event) {
      events.push(event)
      return () => {}
    },
    effect(register) {
      return register()
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  }
  return { ctx, warnings, events }
}

test('a hand-written mod row without the grant pin is refused before evaluation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-'))
  try {
    writeFileSync(join(dir, 'register.ts'), entry('hand'))
    const { ctx, warnings, events } = harness()
    await apply(ctx, { hooks: [], mods: [{ entry: 'register.ts' }], plugin: 'probe', pluginRoot: dir })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /refused mod register\.ts: no hash-pinned grant was carried/)
    assert.match(warnings[0], /load refused/)
    assert.ok(!events.includes('session.start'), 'a refused mod must not seat a registration')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pinned row with no pluginRoot cannot be re-read and is refused, not loaded from cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-'))
  try {
    writeFileSync(join(dir, 'register.ts'), entry('noroot'))
    const pinned = pinnedMod(dir, 'register.ts')
    const { ctx, warnings, events } = harness()
    await apply(ctx, { hooks: [], mods: [pinned], plugin: 'probe' })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /no pluginRoot was carried/)
    assert.ok(!events.includes('session.start'), 'a refused mod must not seat a registration')
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
    const { ctx, warnings, events } = harness()
    await apply(ctx, { hooks: [], mods: [pinned], plugin: 'probe', pluginRoot: dir })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /artifact changed since the grant/)
    assert.match(warnings[0], new RegExp(pinned.artifactHash))
    assert.match(warnings[0], /sha256:[0-9a-f]{64}/)
    assert.ok(!events.includes('session.start'), 'a refused mod must not seat a registration')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file added to the tree after the grant is caught by the re-list, before evaluation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-'))
  try {
    writeFileSync(join(dir, 'register.ts'), entry('added'))
    const pinned = pinnedMod(dir, 'register.ts')
    writeFileSync(join(dir, 'extra.ts'), 'export {}\n')
    const { ctx, warnings, events } = harness()
    await apply(ctx, { hooks: [], mods: [pinned], plugin: 'probe', pluginRoot: dir })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /the file set changed since the grant/)
    assert.match(warnings[0], /added: extra\.ts/)
    assert.ok(!events.includes('session.start'), 'a refused mod must not seat a registration')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mod that imports outside hooks/ is pinned with it, and a change there refuses the load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-'))
  try {
    writeFileSync(join(dir, 'register.ts'), [
      "import { note } from './support/shared.js'",
      'export function register(on: On): void {',
      '  on("session.start", async () => { const _ = note })',
      '}',
      '',
    ].join('\n'))
    mkdirSync(join(dir, 'support'), { recursive: true })
    writeFileSync(join(dir, 'support', 'shared.ts'), 'export const note = "before"\n')
    const pinned = pinnedMod(dir, 'register.ts')
    const first = harness()
    await apply(first.ctx, { hooks: [], mods: [pinned], plugin: 'probe', pluginRoot: dir })
    assert.equal(first.warnings.filter((message) => message.includes("load refused")).length, 0)
    assert.deepEqual(first.events, ['agent/created', 'agent/disposed'])

    writeFileSync(join(dir, 'support', 'shared.ts'), 'export const note = "after"\n')
    const second = harness()
    await apply(second.ctx, { hooks: [], mods: [pinned], plugin: 'probe', pluginRoot: dir })
    assert.equal(second.warnings.length, 1)
    assert.match(second.warnings[0], /artifact changed since the grant/)
    assert.ok(!second.events.includes('session.start'), 'a refused mod must not seat a registration')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory symlink that leaves the plugin root cannot be pinned', () => {
  const outside = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-outside-'))
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-pinned-'))
  try {
    writeFileSync(join(outside, 'evil.ts'), 'export const evil = 1\n')
    writeFileSync(join(dir, 'register.ts'), entry('symlink'))
    // A directory symlink is a typed refusal, not a skipped entry: following
    // it would load bytes the manifest cannot name.
    const { symlinkSync } = process.getBuiltinModule('node:fs')
    symlinkSync(outside, join(dir, 'lib'))
    const tree = treeArtifact(dir, 'register.ts')
    assert.equal(tree.ok, false)
    assert.match(tree.refusal.reason, /symlink .*(outside the plugin root|directory symlink)/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
