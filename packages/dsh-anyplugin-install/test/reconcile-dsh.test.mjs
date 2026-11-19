// The real-loader half of the reconcile proof: a group entry with a child
// materializer is created, kept and disposed against the *installed* cordis
// 4.1.0 / cordis-plugin-loader 1.1.0, not the fake. Skipped when no harness is
// present (CI without DSH); the fake-loader test covers the same contract there.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { compileEntries, reconcile } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const installedDir = process.env.DSH_INSTALL_DIR ? join(process.env.DSH_INSTALL_DIR, '..') : undefined
const workspace = mkdtempSync(join(tmpdir(), 'anyplugin-dsh-'))
const materializerUrl = pathToFileURL(
  join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts'),
).href

const installs = {
  schema: 'dsh-anyplugin/installs@1',
  plugins: [
    {
      dialect: 'claude-code',
      name: 'skills-only',
      version: '0.0.1',
      root: join(repoRoot, 'fixtures', 'claude-skills-only'),
      dataDir: join(workspace, 'data', 'skills-only'),
      pin: 'claude-code@2.1.322',
    },
  ],
}
const desired = compileEntries(installs, {
  materializers: { skill: materializerUrl },
  enablements: { user: { plugins: { 'claude-code:skills-only': { enabled: true, grants: [] } } } },
})
const GROUP_ID = desired[0].id
const CHILD_ID = desired[0].config[0].id

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test(
  'reconcile creates, keeps, and only reports removed after the subtree settles disposed',
  { skip: installedDir ? false : 'DSH_INSTALL_DIR is not set' },
  async () => {
    const load = (specifier) => import(pathToFileURL(join(installedDir, specifier)).href)
    const { Context } = await load('cordis/lib/index.js')
    const Loader = (await load('cordis-plugin-loader/lib/index.js')).default
    const SkillRegistry = (await load('dsh-skill/lib/index.js')).default

    const ctx = new Context()
    const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(join(installedDir, 'dsh') + '/').href })
    ctx.plugin(SkillRegistry, {})
    await until(() => Boolean(ctx.loader) && Boolean(ctx.skills), 'loader and skills services')

    try {
      const first = await reconcile(ctx.loader, desired)
      assert.deepEqual(first, { created: [GROUP_ID], updated: [], removed: [], kept: [], failed: [] })
      assert.equal(ctx.loader.resolve(GROUP_ID).fiber.state, 2, 'group is active')
      assert.equal(ctx.loader.resolve(CHILD_ID).fiber.state, 2, 'skill materializer applied')

      const second = await reconcile(ctx.loader, desired)
      assert.deepEqual(second, { created: [], updated: [], removed: [], kept: [GROUP_ID], failed: [] })

      const groupFiber = ctx.loader.resolve(GROUP_ID).fiber
      const childFiber = ctx.loader.resolve(CHILD_ID).fiber
      let unloading
      const realRemove = ctx.loader.remove.bind(ctx.loader)
      ctx.loader.remove = (id) => {
        realRemove(id)
        unloading = groupFiber.state
      }

      const third = await reconcile(ctx.loader, [])
      assert.deepEqual(third, { created: [], updated: [], removed: [GROUP_ID], kept: [], failed: [] })
      assert.equal(unloading, 5, 'teardown observed at fiber.state === 5 (unloading)')
      assert.equal(groupFiber.state, 4, 'group settled disposed')
      assert.equal(childFiber.state, 4, 'child settled disposed')
      assert.throws(() => ctx.loader.resolve(GROUP_ID), 'group is gone from the store')
      assert.throws(() => ctx.loader.resolve(CHILD_ID), 'child is gone from the store')
    } finally {
      loaderFiber.dispose()
    }
  },
)
