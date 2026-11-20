// The mod-host bridge's confinement contract (#46): every fs path is resolved
// to a real path under the plugin data dir before it is read, and the store is
// durable in that same dir across a load. These are the cases the 23-site
// fixture does not exercise: `..`, an absolute path, and a symlink out.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createModBridge } from '../src/index.ts'

const outsideCode = (error) => error.code === 'ERR_MOD_HOST_PATH_OUTSIDE'

test('bridge roots fs and the durable store in the plugin data dir', async () => {
  const base = mkdtempSync(join(tmpdir(), 'anyplugin-bridge-unit-'))
  const dataDir = join(base, 'data')
  const outside = join(base, 'outside')
  mkdirSync(dataDir)
  mkdirSync(outside)
  writeFileSync(join(dataDir, 'ok.txt'), 'ok')
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ fileCheckpointingEnabled: false }))
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(outside, join(dataDir, 'link'), 'dir')

  const bridge = createModBridge({
    plugin: 'unit/mod.ts',
    dataDir,
    env: { ANYPLUGIN_TOKEN: 'visible' },
  })
  try {
    const $ = bridge.dollar()
    assert.equal(await $.fs.read('ok.txt'), 'ok')
    assert.equal(await $.fs.read('ok.txt', { as: 'bytes' }).then((value) => value.base64), Buffer.from('ok').toString('base64'))
    assert.equal((await $.fs.stat('ok.txt', { resolve: true })).realPath, join(dataDir, 'ok.txt'))
    const listed = await $.fs.list()
    assert.deepEqual(
      listed.map((entry) => ({ name: entry.name, kind: entry.kind, isLink: entry.isLink })),
      [
        { name: 'link', kind: 'other', isLink: true },
        { name: 'ok.txt', kind: 'file', isLink: false },
        { name: 'settings.json', kind: 'file', isLink: false },
      ],
    )

    await assert.rejects($.fs.read('../outside/secret.txt'), outsideCode)
    await assert.rejects($.fs.read(join(outside, 'secret.txt')), outsideCode)
    await assert.rejects($.fs.read('link/secret.txt'), outsideCode)

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
  const reloaded = createModBridge({ plugin: 'unit/mod.ts', dataDir })
  try {
    assert.deepEqual(await reloaded.dollar().store.get('durable'), { value: 1 })
  } finally {
    reloaded.dispose()
    rmSync(base, { recursive: true, force: true })
  }
})

test('bridge refusals are typed and do not return undefined', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-bridge-refuse-'))
  const bridge = createModBridge({ plugin: 'unit/mod.ts', dataDir })
  try {
    const $ = bridge.dollar()
    for (const method of ['invalidate', 'status', 'log', 'open', 'close', 'resolve']) {
      await assert.rejects(async () => {
        await $.ui[method]({})
      }, (error) => error.code === 'ERR_MOD_HOST_UI_UNSUPPORTED', `ui.${method}`)
    }
    await assert.rejects($.process.run(['true']), (error) => error.code === 'ERR_MOD_HOST_EXEC_UNSUPPORTED')
  } finally {
    bridge.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
