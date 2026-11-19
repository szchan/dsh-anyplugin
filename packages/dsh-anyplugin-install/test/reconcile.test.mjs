// Reconcile is the only code that mutates the loader on behalf of a workspace.
// The fake loader below reproduces the substrate behavior that matters:
// `create`/`update` start fibers, `remove` drops entries synchronously while
// fibers unload asynchronously (5 → 4), and a group can be left with a
// non-active child because `EntryGroup.update` catches per child.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { compileEntries, reconcile, waitForDisposal } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const workspace = mkdtempSync(join(tmpdir(), 'anyplugin-reconcile-'))
const materializer = (variant = '') =>
  `${pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href}${variant === '' ? '' : `#${variant}`}`
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
const enablements = {
  user: { plugins: { 'claude-code:skills-only': { enabled: true, grants: [] } } },
}
const desiredEntries = (skill = materializer()) =>
  compileEntries(installs, { materializers: { skill }, enablements })
const GROUP_ID = desiredEntries()[0].id
const CHILD_ID = desiredEntries()[0].config[0].id

class FakeFiber {
  constructor() {
    this.state = 2
  }
  dispose() {
    if (this.state === 4) return
    this.state = 5
    setTimeout(() => {
      this.state = 4
    }, 2)
  }
}

class FakeLoader {
  constructor(options = {}) {
    this.root = {}
    this.store = new Map()
    this.quietChild = options.quietChild ?? false
    this.calls = []
  }
  entries() {
    return [...this.store.values()]
  }
  resolve(id) {
    const entry = this.store.get(id)
    if (!entry) throw new Error(`no entry ${id}`)
    return entry
  }
  async await() {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  async create(options) {
    this.calls.push(['create', options.id])
    const entry = { options, fiber: new FakeFiber(), parent: this.root }
    this.store.set(options.id, entry)
    this.applyChildren(options, entry)
    return options.id
  }
  async update(id, options) {
    this.calls.push(['update', id])
    const entry = this.resolve(id)
    for (const child of entry.options.config ?? []) this.store.delete(child.id)
    entry.options = options
    this.applyChildren(options, entry)
  }
  applyChildren(options, parent) {
    for (const child of options.config ?? []) {
      const fiber = new FakeFiber()
      if (this.quietChild) fiber.state = 0
      this.store.set(child.id, { options: child, fiber, parent })
    }
  }
  remove(id) {
    this.calls.push(['remove', id])
    const entry = this.resolve(id)
    for (const child of entry.options.config ?? []) {
      this.store.get(child.id)?.fiber.dispose()
      this.store.delete(child.id)
    }
    this.store.delete(id)
    entry.fiber.dispose()
  }
}

test('the first reconcile creates, the second keeps and writes nothing', async () => {
  const loader = new FakeLoader()
  const desired = desiredEntries()
  const first = await reconcile(loader, desired)
  assert.deepEqual(first, { created: [GROUP_ID], updated: [], removed: [], kept: [], failed: [] })

  const second = await reconcile(loader, desired)
  // "all-empty" means no change happened: created/updated/removed are empty and
  // the entries are accounted for as kept. The loader got exactly one write.
  assert.deepEqual(second, { created: [], updated: [], removed: [], kept: [GROUP_ID], failed: [] })
  assert.deepEqual(loader.calls, [['create', GROUP_ID]])
})

test('a changed desired config updates the entry in place', async () => {
  const loader = new FakeLoader()
  await reconcile(loader, desiredEntries(materializer('one')))
  const result = await reconcile(loader, desiredEntries(materializer('two')))
  assert.deepEqual(result, { created: [], updated: [GROUP_ID], removed: [], kept: [], failed: [] })
  assert.deepEqual(loader.calls, [['create', GROUP_ID], ['update', GROUP_ID]])
  assert.equal(loader.resolve(GROUP_ID).options.config[0].name, materializer('two'))
})

test('removal waits for the subtree to settle disposed, and leaves foreign entries alone', async () => {
  const loader = new FakeLoader()
  await reconcile(loader, desiredEntries())
  const groupFiber = loader.resolve(GROUP_ID).fiber
  const childFiber = loader.resolve(CHILD_ID).fiber
  loader.store.set('someone-else', { options: { id: 'someone-else', name: 'other' }, fiber: new FakeFiber(), parent: loader.root })

  let unloading
  const realRemove = loader.remove.bind(loader)
  loader.remove = (id) => {
    realRemove(id)
    unloading = [groupFiber.state, childFiber.state]
  }
  const result = await reconcile(loader, [])

  assert.deepEqual(result, { created: [], updated: [], removed: [GROUP_ID], kept: [], failed: [] })
  assert.deepEqual(unloading, [5, 5], 'teardown was observed at state 5 (unloading)')
  assert.equal(groupFiber.state, 4, 'group settled disposed')
  assert.equal(childFiber.state, 4, 'child settled disposed')
  assert.throws(() => loader.resolve(GROUP_ID))
  assert.throws(() => loader.resolve(CHILD_ID))
  assert.ok(loader.store.has('someone-else'))
  assert.deepEqual(loader.calls.at(-1), ['remove', GROUP_ID])
})

test('a half-applied group is reported as failed, not created', async () => {
  const loader = new FakeLoader({ quietChild: true })
  const result = await reconcile(loader, desiredEntries())
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.kept, [])
  assert.deepEqual(result.failed, [
    { id: GROUP_ID, child: CHILD_ID, reason: 'child fiber is 0, expected active (2)' },
  ])
  const again = await reconcile(loader, desiredEntries())
  assert.deepEqual(again.created, [])
  assert.deepEqual(again.failed, result.failed, 'the failure is stable, not silently repaired')
})

test('waitForDisposal distinguishes unloading (5) from settled (4)', async () => {
  const a = { state: 5 }
  setTimeout(() => {
    a.state = 4
  }, 10)
  const b = { state: 2 }
  setTimeout(() => {
    b.state = 5
    setTimeout(() => {
      b.state = 4
    }, 25)
  }, 5)

  const observation = await waitForDisposal([a, b], 500)
  assert.deepEqual(observation, { settled: true, sawUnloading: true, states: [4, 4] })
})

test('waitForDisposal reports a fiber that never disposes', async () => {
  const stuck = { state: 2 }
  const observation = await waitForDisposal([stuck], 20)
  assert.deepEqual(observation, { settled: false, sawUnloading: false, states: [2] })
})

test('reconcile refuses ids outside its namespace and duplicates', async () => {
  const loader = new FakeLoader()
  await assert.rejects(() => reconcile(loader, [{ id: 'someone-else', name: 'x' }]), /outside the managed namespace/)
  await assert.rejects(
    () => reconcile(loader, [{ id: `${GROUP_ID}`, name: 'x' }, { id: `${GROUP_ID}`, name: 'y' }]),
    /duplicate desired id/,
  )
})
