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

import { CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
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
      pin: `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`,
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
  constructor({ delay = 2, stuck = false, skipUnloading = false } = {}) {
    this.state = 2
    this.delay = delay
    this.stuck = stuck
    this.skipUnloading = skipUnloading
  }
  dispose() {
    if (this.state === 4) return
    if (!this.skipUnloading) this.state = 5
    if (this.stuck) return
    setTimeout(() => {
      this.state = 4
    }, this.delay)
  }
}

class FakeLoader {
  constructor(options = {}) {
    this.root = {}
    this.store = new Map()
    this.quietChild = options.quietChild ?? false
    this.childFiber = options.childFiber ?? {}
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
    const entry = { options, fiber: new FakeFiber(), parent: this.root, subgroup: {} }
    this.store.set(options.id, entry)
    this.applyChildren(options, entry)
    return options.id
  }
  async update(id, options) {
    this.calls.push(['update', id])
    const entry = this.resolve(id)
    for (const child of entry.options.config ?? []) {
      const childEntry = this.store.get(child.id)
      if (!childEntry) continue
      childEntry.fiber.dispose()
      this.store.delete(child.id)
    }
    entry.options = options
    entry.subgroup = {}
    this.applyChildren(options, entry)
  }
  applyChildren(options, entry) {
    for (const child of options.config ?? []) {
      const fiber = new FakeFiber(this.childFiber)
      if (this.quietChild) fiber.state = 0
      this.store.set(child.id, { options: child, fiber, parent: entry.subgroup })
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
  assert.deepEqual(first, { created: [GROUP_ID], updated: [], removed: [], kept: [], failed: [], refused: [] })

  const second = await reconcile(loader, desired)
  // "all-empty" means no change happened: created/updated/removed are empty and
  // the entries are accounted for as kept. The loader got exactly one write.
  assert.deepEqual(second, { created: [], updated: [], removed: [], kept: [GROUP_ID], failed: [], refused: [] })
  assert.deepEqual(loader.calls, [['create', GROUP_ID]])
})

test('settle: false skips the loader-wide await but still writes and verifies', async () => {
  const loader = new FakeLoader()
  let awaits = 0
  const realAwait = loader.await.bind(loader)
  loader.await = () => {
    awaits += 1
    return realAwait()
  }

  const created = await reconcile(loader, desiredEntries(), { settle: false })
  assert.deepEqual(created.created, [GROUP_ID])
  assert.equal(awaits, 0, 'no loader-wide wait while an apply is in flight')

  const removed = await reconcile(loader, [], { settle: false })
  assert.deepEqual(removed.removed, [GROUP_ID])
  assert.equal(awaits, 0, 'removal still waits for its own subtree, not the loader')

  await reconcile(loader, desiredEntries())
  assert.equal(awaits, 2, 'the default waits after writes and after removals')
})

test('a changed desired config updates the entry in place', async () => {
  const loader = new FakeLoader()
  await reconcile(loader, desiredEntries(materializer('one')))
  const result = await reconcile(loader, desiredEntries(materializer('two')))
  assert.deepEqual(result, { created: [], updated: [GROUP_ID], removed: [], kept: [], failed: [], refused: [] })
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

  assert.deepEqual(result, { created: [], updated: [], removed: [GROUP_ID], kept: [], failed: [], refused: [] })
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

test('a child id owned by a foreign entry is refused, not adopted', async () => {
  const loader = new FakeLoader()
  const foreignFiber = new FakeFiber()
  loader.store.set(CHILD_ID, {
    options: { id: CHILD_ID, name: 'foreign-plugin-child' },
    fiber: foreignFiber,
    parent: loader.root,
  })

  const result = await reconcile(loader, desiredEntries())

  assert.deepEqual(result.created, [])
  assert.deepEqual(result.failed, [
    { id: GROUP_ID, child: CHILD_ID, reason: 'child id is already owned by another entry' },
  ])
  assert.equal(foreignFiber.state, 2, 'the foreign fiber was not disposed or reparented')
  assert.equal(loader.store.get(CHILD_ID).options.name, 'foreign-plugin-child')
  assert.deepEqual(loader.calls, [], 'nothing was written before the collision was found')
})

test('an update waits for children it drops, even with a slow disposer', async () => {
  const loader = new FakeLoader({ childFiber: { delay: 120 } })
  const group = (children) => ({ id: 'anyplugin.slow', name: 'group', group: true, config: children })
  const one = { id: 'anyplugin.slow.one', name: 'child', config: { tag: 'one' } }
  const two = { id: 'anyplugin.slow.two', name: 'child', config: { tag: 'two' } }
  await reconcile(loader, [group([one, two])])
  const droppedFiber = loader.resolve(two.id).fiber

  const started = performance.now()
  const result = await reconcile(loader, [group([one])], { disposeTimeoutMs: 1000 })
  const elapsed = performance.now() - started

  assert.deepEqual(result, {
    created: [],
    updated: ['anyplugin.slow'],
    removed: [],
    kept: [],
    failed: [], refused: [],
  })
  assert.equal(droppedFiber.state, 4, 'the dropped child settled before reconcile returned')
  assert.ok(elapsed >= 100, `waited for the 120ms disposer (took ${elapsed.toFixed(1)}ms)`)
})

test('a stuck disposer is reported as failed, not removed', async () => {
  const loader = new FakeLoader({ childFiber: { stuck: true } })
  await reconcile(loader, desiredEntries())
  const childFiber = loader.resolve(CHILD_ID).fiber

  const result = await reconcile(loader, [], { disposeTimeoutMs: 30 })

  assert.deepEqual(result.removed, [])
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, GROUP_ID)
  assert.match(result.failed[0].reason, /dispose did not settle/)
  assert.equal(childFiber.state, 5, 'the stuck fiber never reached the settled state')
})

test('a group id owned by a foreign entry is refused, not adopted', async () => {
  const loader = new FakeLoader()
  const foreignFiber = new FakeFiber()
  loader.store.set(GROUP_ID, {
    options: { id: GROUP_ID, name: 'foreign-plugin' },
    fiber: foreignFiber,
    parent: loader.root,
  })

  const result = await reconcile(loader, desiredEntries())

  assert.deepEqual(result.created, [])
  assert.deepEqual(result.failed, [{ id: GROUP_ID, reason: 'group id is already owned by another entry' }])
  assert.equal(loader.store.get(GROUP_ID).options.name, 'foreign-plugin')
  assert.equal(foreignFiber.state, 2)
  assert.deepEqual(loader.calls, [])
})

test('a child id parented under another group is refused, not adopted', async () => {
  const loader = new FakeLoader()
  const otherGroup = { id: 'anyplugin.other', name: 'group', group: true, config: [] }
  const otherEntry = { options: otherGroup, fiber: new FakeFiber(), parent: loader.root, subgroup: {} }
  loader.store.set(otherGroup.id, otherEntry)
  const foreignFiber = new FakeFiber()
  loader.store.set(CHILD_ID, {
    options: { id: CHILD_ID, name: 'other-plugins-child' },
    fiber: foreignFiber,
    parent: otherEntry.subgroup,
  })

  const result = await reconcile(loader, desiredEntries())

  assert.deepEqual(result.failed, [
    { id: GROUP_ID, child: CHILD_ID, reason: 'child id is already owned by another entry' },
  ])
  assert.equal(loader.store.get(CHILD_ID).options.name, 'other-plugins-child')
  assert.equal(loader.store.get(CHILD_ID).parent, otherEntry.subgroup)
  assert.equal(foreignFiber.state, 2)
})

test('the ownership check also runs before a group is kept', async () => {
  const loader = new FakeLoader()
  const shared = 'anyplugin.shared.child'
  const g = { id: 'anyplugin.g', name: 'group', group: true, config: [{ id: shared, name: 'child' }] }
  const h = { id: 'anyplugin.h', name: 'group', group: true, config: [{ id: shared, name: 'child' }] }
  await loader.create(g)
  await loader.create(h) // the second create adopts the shared child, as EntryGroup.create would

  const result = await reconcile(loader, [g, h])

  assert.deepEqual(result.kept, [h.id], 'h still owns the child')
  assert.deepEqual(result.failed, [
    { id: g.id, child: shared, reason: 'child id is already owned by another entry' },
  ])
  assert.equal(loader.store.get(shared).parent, loader.store.get(h.id).subgroup)
  assert.deepEqual(loader.calls, [['create', g.id], ['create', h.id]], 'the guard fired before any write')
})

test('a dropped child that settles without passing 5 does not wait for the timeout', async () => {
  const loader = new FakeLoader({ childFiber: { delay: 10, skipUnloading: true } })
  const group = (children) => ({ id: 'anyplugin.direct', name: 'group', group: true, config: children })
  const one = { id: 'anyplugin.direct.one', name: 'child' }
  const two = { id: 'anyplugin.direct.two', name: 'child' }
  await reconcile(loader, [group([one, two])])
  const droppedFiber = loader.resolve(two.id).fiber

  const started = performance.now()
  const result = await reconcile(loader, [group([one])], { disposeTimeoutMs: 1000 })
  const elapsed = performance.now() - started

  assert.deepEqual(result.failed, [])
  assert.equal(droppedFiber.state, 4)
  assert.ok(elapsed < 500, `settled without unloading instead of timing out (took ${elapsed.toFixed(1)}ms)`)
})
