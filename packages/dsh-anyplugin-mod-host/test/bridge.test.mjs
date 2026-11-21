// The mod-host bridge's two different path contracts (#46): `fs` is the
// invocation's working directory (relative or absolute, like the pin's own
// process), while `store` is the plugin-scoped durable directory. The cases
// below are the ones the 23-site fixture does not reach: an absolute path, a
// path through an intermediate link, a store link that leaves the data dir,
// and a settings read with no merged host snapshot.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { createModBridge } from '../src/index.ts'

const outsideCode = (error) => error.code === 'ERR_MOD_HOST_PATH_OUTSIDE'

test('bridge roots fs at the working directory and keeps store in the data dir', async () => {
  const base = mkdtempSync(join(tmpdir(), 'anyplugin-bridge-unit-'))
  const dataDir = join(base, 'data')
  const work = join(base, 'work')
  const outside = join(base, 'outside')
  mkdirSync(dataDir)
  mkdirSync(work)
  mkdirSync(outside)
  writeFileSync(join(work, 'ok.txt'), 'ok')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(outside, join(work, 'link-dir'), 'dir')

  const bridge = createModBridge({
    plugin: 'unit/mod.ts',
    dataDir,
    cwd: work,
    env: { ANYPLUGIN_TOKEN: 'visible' },
    settings: () => ({ fileCheckpointingEnabled: false }),
  })
  try {
    const $ = bridge.dollar()
    assert.equal(await $.fs.read('ok.txt'), 'ok')
    assert.equal(await $.fs.read('ok.txt', { as: 'bytes' }).then((value) => value.base64), Buffer.from('ok').toString('base64'))
    assert.equal((await $.fs.stat('ok.txt', { resolve: true })).realPath, join(work, 'ok.txt'))

    // The pin's fs rule: absolute paths are as written, and a path through an
    // intermediate symlink is followed. A plugin-data confinement would have
    // refused both, which is exactly the fetched diff's git probe.
    assert.equal(await $.fs.read(join(outside, 'secret.txt')), 'secret')
    assert.equal(await $.fs.read('../outside/secret.txt'), 'secret')
    assert.equal(await $.fs.read('link-dir/secret.txt'), 'secret')
    const stat = await $.fs.stat('link-dir/secret.txt', { resolve: true })
    assert.equal(stat.kind, 'file')
    assert.equal(stat.isLink, false)
    assert.equal(stat.realPath, join(outside, 'secret.txt'))

    const listed = await $.fs.list()
    assert.deepEqual(
      listed.map((entry) => ({ name: entry.name, kind: entry.kind, isLink: entry.isLink })),
      [{ name: 'link-dir', kind: 'other', isLink: true }, { name: 'ok.txt', kind: 'file', isLink: false }],
    )

    assert.equal(await $.env.get('ANYPLUGIN_TOKEN'), 'visible')
    assert.equal(await $.env.get('NOT_SET'), undefined)
    assert.deepEqual(await $.settings.read(), { fileCheckpointingEnabled: false })
    await assert.rejects($.settings.read({ source: 'user' }), (error) => error.code === 'ERR_MOD_HOST_SETTINGS_SOURCE')

    await $.store.set('durable', { value: 1 })
    assert.deepEqual(await $.store.get('durable'), { value: 1 })
  } finally {
    bridge.dispose()
  }

  // A new load on the same data dir is the reload case: the store is the
  // durable channel, not process memory.
  const reloaded = createModBridge({ plugin: 'unit/mod.ts', dataDir, cwd: work })
  try {
    assert.deepEqual(await reloaded.dollar().store.get('durable'), { value: 1 })
  } finally {
    reloaded.dispose()
  }

  // A store link that leaves the data directory is a stable OUTSIDE refusal,
  // not the generic FS error a caught refusal used to become.
  writeFileSync(join(outside, 'store.json'), '{}')
  rmSync(join(dataDir, '.anyplugin-store.json'))
  symlinkSync(join(outside, 'store.json'), join(dataDir, '.anyplugin-store.json'))
  const linked = createModBridge({ plugin: 'unit/mod.ts', dataDir })
  try {
    await assert.rejects(linked.dollar().store.get('durable'), outsideCode)
  } finally {
    linked.dispose()
    rmSync(base, { recursive: true, force: true })
  }
})

test('bridge omissions, freshness, timers, dispose and refusals are observable', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-bridge-refuse-'))
  const warnings = []
  let disposed = 0
  const registered = new Map()
  const bridge = createModBridge({
    plugin: 'unit/mod.ts',
    dataDir,
    now: () => 7,
    warn: (message) => warnings.push(message),
    commands: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`)
        registered.set(definition.name, 'live')
        return () => {
          disposed += 1
          registered.delete(definition.name)
        }
      },
    },
  })
  try {
    const first = bridge.dollar()
    const second = bridge.dollar()
    assert.notEqual(first.fs, second.fs)
    assert.notEqual(first.session, second.session)
    assert.equal(await first.clock.now(), 7)
    assert.deepEqual(await first.session.usage(), {})
    assert.equal(warnings.filter((line) => line.includes('has no startedAt')).length, 1)
    assert.equal(warnings.filter((line) => line.includes('has no context')).length, 1)

    let fired = 0
    const timer = first.clock.after(10, () => {
      fired += 1
    })
    timer.cancel()
    timer.cancel()
    const repeating = first.clock.every(10, () => {
      fired += 1
    })
    assert.equal(typeof repeating.cancel, 'function')

    assert.deepEqual(await first.command.register({ name: 'unit', description: 'unit command' }), { command: 'unit' })
    const foreign = createModBridge({ plugin: 'unit/foreign.ts', dataDir, commands: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`)
        registered.set(definition.name, 'foreign')
        return () => registered.delete(definition.name)
      },
    } })
    try {
      await assert.rejects(
        foreign.dollar().command.register({ name: 'unit', description: 'collision' }),
        (error) => error.code === 'ERR_MOD_HOST_COMMAND_DUPLICATE' && error.message.includes('unit/foreign.ts'),
      )
      // This bridge owns the name, so its own re-registration replaces it
      // rather than colliding.
      assert.deepEqual(await first.command.register({ name: 'unit', description: 'again' }), { command: 'unit' })
    } finally {
      foreign.dispose()
    }
    await assert.rejects(
      first.command.register({ name: 'Unit Name', description: 'bad' }),
      (error) => error.code === 'ERR_MOD_HOST_COMMAND_INVALID',
    )
    assert.equal(registered.get('unit'), 'live')

    // #75: the six ui members are served headless; ask is the one typed
    // refusal left in the namespace (the pin asks a person, and this host has
    // no interaction to carry the answer).
    first.ui.invalidate('ui.render')
    first.ui.status('unit')
    first.ui.log('unit')
    assert.deepEqual(await first.ui.open({ id: 'unit' }), { isPlaced: true })
    assert.equal(bridge.ui.snapshot().panes.length, 1)
    await first.ui.close({ id: 'unit' })
    assert.equal(bridge.ui.snapshot().panes.length, 0)
    assert.equal(typeof first.ui.resolve({ surface: 'terminal', component: 'Pane' }), 'object')
    await assert.rejects(first.ui.ask(), (error) => error.code === 'ERR_MOD_HOST_UI_UNSUPPORTED')
    await assert.rejects(first.process.run(['true']), (error) => error.code === 'ERR_MOD_HOST_EXEC_UNSUPPORTED')

    bridge.dispose()
    bridge.dispose()
    assert.equal(disposed, 2)
    assert.equal(registered.has('unit'), false)
    await delay(25)
    assert.equal(fired, 0)
    assert.throws(() => bridge.dollar(), (error) => error.code === 'ERR_MOD_HOST_DISPOSED')
  } finally {
    bridge.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }

  const noSettings = createModBridge({ plugin: 'unit/mod.ts', dataDir: mkdtempSync(join(tmpdir(), 'anyplugin-bridge-settings-')) })
  try {
    await assert.rejects(
      noSettings.dollar().settings.read(),
      (error) => error.code === 'ERR_MOD_HOST_SETTINGS_UNAVAILABLE',
    )
  } finally {
    noSettings.dispose()
  }

  // The "reported once" set is per load: a fresh bridge reports the omission
  // again instead of inheriting the previous load's silence.
  const freshWarnings = []
  const fresh = createModBridge({
    plugin: 'unit/mod.ts',
    dataDir: mkdtempSync(join(tmpdir(), 'anyplugin-bridge-fresh-')),
    warn: (message) => freshWarnings.push(message),
  })
  try {
    await fresh.dollar().session.usage()
    assert.equal(freshWarnings.filter((line) => line.includes('has no startedAt')).length, 1)
  } finally {
    fresh.dispose()
  }
})
