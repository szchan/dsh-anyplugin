// The real-loader half of the reconcile proof: group entries and their children
// are created, kept and disposed against a pinned cordis 4.1.0 /
// cordis-plugin-loader 1.1.0 tree, not the fake. The shared resolver decides
// which tree (D22); locally a missing harness skips with a reason, while CI
// fails rather than skipping a fidelity test.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { harnessSkipReason, resolveHarness } from '../../dsh-anyplugin-conformance/src/harness.ts'
import { CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { AGENT_PLUGINS_PIN } from '../../dsh-anyplugin-dialect-codex/src/index.ts'
import { compileEntries, reconcile } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harness = resolveHarness()
const installedDir = harness?.harnessDir
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
      pin: `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`,
    },
  ],
}
const enablements = {
  user: { plugins: { 'claude-code:skills-only': { enabled: true, grants: [] } } },
}
const desired = compileEntries(installs, { materializers: { skill: materializerUrl }, enablements })
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

function loaderBaseUrl(harnessDir) {
  const product = join(harnessDir, 'dsh')
  const anchor = existsSync(join(product, 'package.json')) ? product : join(harnessDir, '..', '..')
  return pathToFileURL(anchor + '/').href
}

async function withLoader(run) {
  const load = (specifier) => import(pathToFileURL(join(installedDir, specifier)).href)
  const { Context } = await load('cordis/lib/index.js')
  const Loader = (await load('cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await load('dsh-skill/lib/index.js')).default

  const ctx = new Context()
  const loaderFiber = ctx.plugin(Loader, { baseUrl: loaderBaseUrl(installedDir) })
  ctx.plugin(SkillRegistry, {})
  await until(() => Boolean(ctx.loader) && Boolean(ctx.skills), 'loader and skills services')
  try {
    await run(ctx)
  } finally {
    loaderFiber.dispose()
  }
}

const gate = installedDir ? false : harnessSkipReason()
const when = { skip: gate }

test(
  'reconcile creates, keeps, and only reports removed after the subtree settles disposed',
  when,
  () => withLoader(async (ctx) => {
    const first = await reconcile(ctx.loader, desired)
    assert.deepEqual(first, { created: [GROUP_ID], updated: [], removed: [], kept: [], failed: [], refused: [] })
    assert.equal(ctx.loader.resolve(GROUP_ID).fiber.state, 2, 'group is active')
    assert.equal(ctx.loader.resolve(CHILD_ID).fiber.state, 2, 'skill materializer applied')

    const second = await reconcile(ctx.loader, desired)
    assert.deepEqual(second, { created: [], updated: [], removed: [], kept: [GROUP_ID], failed: [], refused: [] })

    const groupFiber = ctx.loader.resolve(GROUP_ID).fiber
    const childFiber = ctx.loader.resolve(CHILD_ID).fiber
    let unloading
    const realRemove = ctx.loader.remove.bind(ctx.loader)
    ctx.loader.remove = (id) => {
      realRemove(id)
      unloading = groupFiber.state
    }

    const third = await reconcile(ctx.loader, [])
    assert.deepEqual(third, { created: [], updated: [], removed: [GROUP_ID], kept: [], failed: [], refused: [] })
    assert.equal(unloading, 5, 'teardown observed at fiber.state === 5 (unloading)')
    assert.equal(groupFiber.state, 4, 'group settled disposed')
    assert.equal(childFiber.state, 4, 'child settled disposed')
    assert.throws(() => ctx.loader.resolve(GROUP_ID), 'group is gone from the store')
    assert.throws(() => ctx.loader.resolve(CHILD_ID), 'child is gone from the store')
  }),
)

test(
  'a throwing child is caught by the loader and reported as failed, not created',
  when,
  () => withLoader(async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'anyplugin-throw-'))
    const throwing = join(dir, 'throwing-materializer.mjs')
    writeFileSync(
      throwing,
      [
        "export const name = 'anyplugin-throwing-materializer'",
        "export const inject = ['skills']",
        'export function apply() {',
        "  throw new Error('materializer exploded')",
        '}',
        '',
      ].join('\n'),
    )
    const wanted = compileEntries(installs, {
      materializers: { skill: pathToFileURL(throwing).href },
      enablements,
    })

    const result = await reconcile(ctx.loader, wanted)

    assert.deepEqual(result.created, [], 'the group is not reported applied')
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].id, GROUP_ID)
    assert.equal(result.failed[0].child, CHILD_ID)
    assert.match(result.failed[0].reason, /expected active \(2\)/)
    assert.equal(ctx.loader.resolve(GROUP_ID).fiber.state, 2, 'the group itself is active')
    assert.notEqual(ctx.loader.resolve(CHILD_ID).fiber.state, 2, 'the throwing child is not active')
  }),
)

// A child materializer whose disposer takes a controllable amount of time. It
// exercises the two paths `loader.await()` cannot see: a child dropped by an
// update, and a disposer slower than the reconcile deadline.
function disposerMaterializer({ delay = 150 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-disposer-'))
  const file = join(dir, 'disposer-materializer.mjs')
  writeFileSync(
    file,
    [
      "export const name = 'anyplugin-test-disposer'",
      'export function apply(ctx, config) {',
      '  ctx.effect(() => () => new Promise((resolve) => setTimeout(resolve, config.delay ?? 0)))',
      '}',
      '',
    ].join('\n'),
  )
  return { url: pathToFileURL(file).href, delay }
}

test(
  'an update waits for a dropped child to finish disposing (real loader)',
  when,
  () => withLoader(async (ctx) => {
    const materializer = disposerMaterializer({ delay: 150 })
    const group = (children) => ({
      id: 'anyplugin.dispose.group',
      name: '@deepseek-ai/cordis-plugin-group',
      group: true,
      config: children,
    })
    const child = (surface) => ({
      id: `anyplugin.dispose.${surface}`,
      name: materializer.url,
      config: { delay: materializer.delay },
    })
    await reconcile(ctx.loader, [group([child('a'), child('b')])])
    const dropped = ctx.loader.resolve('anyplugin.dispose.b').fiber
    assert.equal(dropped.state, 2)

    const started = performance.now()
    const result = await reconcile(ctx.loader, [group([child('a')])], { disposeTimeoutMs: 1000 })
    const elapsed = performance.now() - started

    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.updated, ['anyplugin.dispose.group'])
    assert.equal(dropped.state, 4, 'the dropped fiber settled before reconcile returned')
    assert.ok(elapsed >= 120, `reconcile waited for the 150ms disposer (took ${elapsed.toFixed(1)}ms)`)
  }),
)

test(
  'a disposer slower than the deadline is reported, then settles (real loader)',
  when,
  () => withLoader(async (ctx) => {
    const materializer = disposerMaterializer({ delay: 300 })
    const id = 'anyplugin.slow-dispose.group'
    const childId = 'anyplugin.slow-dispose.child'
    await reconcile(ctx.loader, [
      {
        id,
        name: '@deepseek-ai/cordis-plugin-group',
        group: true,
        config: [{ id: childId, name: materializer.url, config: { delay: materializer.delay } }],
      },
    ])
    const childFiber = ctx.loader.resolve(childId).fiber

    const started = performance.now()
    const result = await reconcile(ctx.loader, [], { disposeTimeoutMs: 50 })
    const elapsed = performance.now() - started

    assert.deepEqual(result.removed, [])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].id, id)
    assert.match(result.failed[0].reason, /dispose did not settle/)
    assert.equal(childFiber.state, 5, 'still unloading when the deadline expired')
    assert.ok(elapsed >= 45, `reconcile bounded the wait (took ${elapsed.toFixed(1)}ms)`)

    await sleep(350)
    assert.equal(childFiber.state, 4, 'the disposer did finish after reconcile reported the timeout')
  }),
)

// A codex record goes through the same lock → compile → loader path: the group
// id is dialect-qualified, the children are the emitter's, and the second
// reconcile is a no-op. This is the install half of issue #101; the DSH oracle
// half lives in the conformance rig.
const codexInstalls = {
  schema: 'dsh-anyplugin/installs@1',
  plugins: [
    {
      dialect: 'codex',
      name: 'codex-portable',
      version: '1.0.0',
      root: join(repoRoot, 'fixtures', 'codex-portable'),
      dataDir: join(workspace, 'data', 'codex-portable'),
      pin: `${AGENT_PLUGINS_PIN.tool}@${AGENT_PLUGINS_PIN.version}`,
    },
  ],
}
const codexEnablements = {
  user: { plugins: { 'codex:codex-portable': { enabled: true, grants: [] } } },
}
const codexDesired = compileEntries(codexInstalls, { materializers: { skill: materializerUrl }, enablements: codexEnablements })
const CODEX_GROUP_ID = codexDesired[0].id
const CODEX_CHILD_ID = codexDesired[0].config[0].id

test(
  'a codex record reconciles once, then reports zero changes',
  when,
  () => withLoader(async (ctx) => {
    assert.equal(CODEX_GROUP_ID, 'anyplugin.codex~3acodex-portable')
    assert.equal(codexDesired.length, 1)
    assert.equal(codexDesired[0].config.length, 1, 'one skill child carries both codex skills')
    assert.match(CODEX_CHILD_ID, /#skill$/)

    const first = await reconcile(ctx.loader, codexDesired)
    assert.deepEqual(first, { created: [CODEX_GROUP_ID], updated: [], removed: [], kept: [], failed: [], refused: [] })
    assert.equal(ctx.loader.resolve(CODEX_GROUP_ID).fiber.state, 2, 'codex group is active')
    assert.equal(ctx.loader.resolve(CODEX_CHILD_ID).fiber.state, 2, 'codex skill child is active')

    const second = await reconcile(ctx.loader, codexDesired)
    assert.deepEqual(second, { created: [], updated: [], removed: [], kept: [CODEX_GROUP_ID], failed: [], refused: [] })
  }),
)
