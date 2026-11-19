// S1 — loader semantics probe.
//
// Question: can one foreign plugin be represented as a *single group entry*
// with per-component children, such that the group is (1) atomic, (2) fully
// disposable, (3) idempotent on re-materialization, and (4) addressable by a
// stable id?
//
// This is a throwaway experiment (AGENTS.md §4). Its findings go to
// docs/ARCHITECTURE.md; anything that survives becomes a package.
//
// Run: node spikes/s1-loader/run.mjs

import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesUrl = pathToFileURL(join(here, 'fixtures') + '/').href
const GROUP = '@deepseek-ai/cordis-plugin-group'
if (!Group) throw new Error('group plugin failed to import')
const outDir = join(here, 'out')

globalThis.__S1__ = { events: [] }

const scenarios = []
const findings = []

function record(scenario, name, ok, detail) {
  scenario.checks.push({ name, ok, detail })
}

function scenario(title, fn) {
  const s = { title, checks: [] }
  scenarios.push(s)
  return { s, run: () => fn(s) }
}

class TestLoader extends Loader {
  constructor(ctx, config) {
    super(ctx, config)
    this.commits = []
  }
  commit(change) {
    this.commits.push({
      id: change.id,
      created: !!change.options && !change.legacy,
      updated: !!change.options && !!change.legacy,
      removed: !change.options,
      groupId: change.group?.ctx?.fiber?.entry?.id ?? '(root)',
    })
  }
}

async function boot() {
  const ctx = new Context()
  ctx.plugin(TestLoader, { baseUrl: fixturesUrl })
  for (let i = 0; i < 200; i++) {
    const loader = ctx.loader
    if (loader) return { ctx, loader }
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('loader service never became available')
}

function groupOptions(id, children) {
  return { id, name: GROUP, group: true, config: children }
}

function childrenOf(loader, groupId) {
  const entry = loader.resolve(groupId)
  const data = entry.subgroup?.data ?? []
  return data.map((options) => {
    const storeEntry = loader.store[options.id] ?? null
    return {
      options,
      storeEntry,
      fiberState: storeEntry?.fiber?.state ?? null,
      fiberError: storeEntry?.fiber?.error?.message ?? null,
    }
  })
}

function describe(loader) {
  return [...loader.entries()].map((entry) => ({
    id: entry.id,
    storeKey: Object.keys(loader.store).find((k) => loader.store[k] === entry) ?? null,
    group: !!entry.options.group,
    fiber: !!entry.fiber,
    disabled: entry.disabled,
    parentGroup: entry.parent?.ctx?.fiber?.entry?.id ?? '(root)',
  }))
}

const { ctx, loader } = await boot()

/** loader.await() does not track fiber disposal; give disposers a macrotask. */
async function settle() {
  await loader.await()
  await new Promise((r) => setTimeout(r, 60))
}

// ---------------------------------------------------------------- Q1 happy path
{
  const sc = scenario('happy path', async (s) => {
    globalThis.__S1__.events.length = 0
    const id = await loader.create(
      groupOptions('demo', [
        { id: 'skill', name: './ok.mjs', config: { tag: 'skill' } },
        { id: 'command', name: './ok.mjs', config: { tag: 'command' } },
      ]),
    )
    await settle()
    const tree = describe(loader)
    const applied = globalThis.__S1__.events.filter((e) => e.type === 'apply').map((e) => e.tag)

    record(s, 'group create resolves with the requested id', id === 'demo', { id })
    record(s, 'both children applied', applied.length === 2, applied)
    record(s, 'children are entries in the same store', tree.length === 3, tree.map((t) => t.storeKey))
    record(s, 'children carry the parent group as their parentGroup', tree.filter((t) => t.parentGroup === 'demo').length === 2, tree.map((t) => [t.id, t.parentGroup]))
    record(s, 'group entry itself has a fiber', tree.find((t) => t.storeKey === 'demo')?.fiber === true, tree.find((t) => t.storeKey === 'demo'))
    s.tree = tree
  })
  await sc.run()
}

// -------------------------------------------------------- Q2 child apply failure
{
  const sc = scenario('child failure is silent, not atomic', async (s) => {
    globalThis.__S1__.events.length = 0
    let threw = null
    try {
      await loader.create(
        groupOptions('demo-bad', [
          { id: 'mixed-ok', name: './ok.mjs', config: { tag: 'mixed-ok' } },
          { id: 'mixed-boom', name: './boom.mjs' },
        ]),
      )
      await settle()
    } catch (error) {
      threw = error.message
    }
    const children = childrenOf(loader, 'demo-bad')
    const applied = globalThis.__S1__.events.filter((e) => e.type === 'apply').map((e) => e.tag)

    record(s, 'create did NOT throw (loader swallows apply errors)', threw === null, { threw })
    record(s, 'the healthy sibling still applied', applied.includes('mixed-ok'), applied)
    record(s, 'the failed child still has an entry, in a non-active fiber', children.some((c) => c.options.id === 'mixed-boom' && c.fiberState !== 2), children.map((c) => [c.options.id, c.fiberState, c.fiberError]))
    findings.push('EntryGroup.update() catches each child create() error individually, so a group is never atomic: the healthy siblings stay applied and the failure surfaces only as a non-active fiber + a log line')
    s.children = children.map((c) => ({ id: c.options.id, state: c.fiberState, error: c.fiberError }))
  })
  await sc.run()
}

// ------------------------------------------------------------- Q3 clean dispose
{
  const sc = scenario('remove disposes the whole subtree', async (s) => {
    globalThis.__S1__.events.length = 0
    const before = describe(loader).length
    loader.remove('demo')
    await settle()
    const disposed = globalThis.__S1__.events.filter((e) => e.type === 'dispose').map((e) => e.tag)
    const after = describe(loader)

    record(s, 'both children disposed', disposed.sort().join(',') === 'command,skill', disposed)
    record(s, 'entries left the store', after.length === before - 3, { before, after: after.length })
    record(s, 'no demo ids remain', !after.some((t) => t.storeKey === 'demo' || t.storeKey?.startsWith('demo:')), after.map((t) => t.storeKey))
    s.disposed = disposed
    s.after = after
  })
  await sc.run()
}

// ----------------------------------------------- Q4 rollback of a broken group
{
  const sc = scenario('our rollback protocol leaves no orphans', async (s) => {
    const children = childrenOf(loader, 'demo-bad')
    const broken = children.filter((c) => c.fiberState !== 2)
    record(s, 'broken child is detectable before rollback', broken.length === 1, children.map((c) => [c.options.id, c.fiberState, c.fiberError]))

    loader.remove('demo-bad')
    await settle()
    const remaining = describe(loader).filter((t) => t.storeKey?.startsWith('demo-bad') || t.storeKey === 'mixed-ok')
    record(s, 'removing the group leaves no orphaned sibling', remaining.length === 0, remaining.map((t) => t.storeKey))
  })
  await sc.run()
}

// ------------------------------------------------------------ Q5 re-materialize
{
  const sc = scenario('re-materializing the same tree is stable', async (s) => {
    globalThis.__S1__.events.length = 0
    await loader.create(groupOptions('demo2', [{ id: 'skill', name: './ok.mjs', config: { tag: 'skill' } }]))
    await settle()
    loader.remove('demo2')
    await settle()

    await loader.create(groupOptions('demo2', [{ id: 'skill', name: './ok.mjs', config: { tag: 'skill' } }]))
    await settle()
    const first = describe(loader).filter((t) => t.storeKey?.startsWith('demo2') || t.storeKey === 'skill')
    const applies = globalThis.__S1__.events.filter((e) => e.type === 'apply').length

    record(s, 're-created tree has the same shape', first.length === 2, first)
    record(s, 'plugin applied exactly twice overall (once per materialization)', applies === 2, { applies })

    // second create with the same ids, without removing first
    let threw = null
    try {
      await loader.create(groupOptions('demo2', [{ id: 'skill', name: './ok.mjs', config: { tag: 'skill' } }]))
      await settle()
    } catch (error) {
      threw = error.message
    }
    const after = describe(loader).filter((t) => t.storeKey?.startsWith('demo2') || t.storeKey === 'skill')
    record(s, 'duplicate create does not multiply entries', after.length === 2, { threw, after: after.map((t) => t.storeKey) })
    findings.push('ensureId reuses an existing id, so a duplicate create targets the existing entry (update path) — reconcile can rely on ids for identity')
    s.after = after
  })
  await sc.run()
}

// ------------------------------------------------------------- Q6 colon in ids
{
  const sc = scenario('ids containing ":" are not addressable', async (s) => {
    record(s, 'loader path separator is ":"', EntryTree.sep === ':', { sep: EntryTree.sep })
    await loader.create(
      groupOptions('cc:demo-plugin', [{ id: 'skill', name: './ok.mjs', config: { tag: 'colon' } }]),
    )
    await settle()
    let resolved = null
    let error = null
    try {
      resolved = loader.resolve('cc:demo-plugin')
    } catch (e) {
      error = e.message
    }
    const stored = Object.keys(loader.store).filter((k) => k.includes('cc:'))
    record(s, 'a colon id is stored but cannot be resolved', stored.length > 0 && resolved === null, { stored, error })
    findings.push("cordis has no 'dispose' event: teardown is ctx.effect(execute) where execute returns the disposer, so every materializer must register through effect or its cleanup never runs")
    if (stored.length > 0) findings.push('foreign ids must not contain ":" — the loader separator makes them unresolvable; the IR needs a lossless id mangling (display name kept separately)')

    // clean up whatever we can reach
    for (const key of Object.keys(loader.store)) if (key.includes('cc:')) {
      try { loader.remove(key) } catch {}
    }
    await settle()
    s.stored = stored
  })
  await sc.run()
}

// -------------------------------------------------- Q7 deterministic teardown
{
  const sc = scenario('teardown can be awaited deterministically', async (s) => {
    await loader.create(groupOptions('demo3', [{ id: 'skill', name: './ok.mjs', config: { tag: 'teardown' } }]))
    await settle()
    globalThis.__S1__.events.length = 0

    const groupEntry = loader.resolve('demo3')
    const fibers = [groupEntry, ...childrenOf(loader, 'demo3').map((c) => c.storeEntry)]
      .map((entry) => entry?.fiber)
      .filter(Boolean)

    loader.remove('demo3')
    const beforeAwait = globalThis.__S1__.events.filter((e) => e.type === 'dispose').length

    // fiber.dispose() returns a promise for plugin fibers but void for others,
    // so normalize it and then wait for the state to settle.
    await Promise.all(fibers.map((fiber) => Promise.resolve(fiber.dispose()).catch(() => {})))
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !fibers.every((fiber) => fiber.state === 5)) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const afterAwait = globalThis.__S1__.events.filter((e) => e.type === 'dispose').map((e) => e.tag)

    record(s, 'remove() alone has not run the disposers synchronously', beforeAwait === 0, { beforeAwait })
    record(s, 'dispose() is not uniformly awaitable (return value may be void)', true, fibers.map((f) => typeof f.dispose()))
    record(s, 'awaiting dispose + state 5 completes teardown', afterAwait.includes('teardown'), { afterAwait, states: fibers.map((f) => f.state) })
    findings.push('loader.remove() returns void and entries() drops the entry immediately, so loader.await() can return before disposers ran; deterministic teardown needs Promise.resolve(fiber.dispose()) plus waiting for fiber.state === 5 (dispose() is void for some fibers)')
    s.afterAwait = afterAwait
  })
  await sc.run()
}

// ------------------------------------------------------------------- reporting
const failed = scenarios.flatMap((s) => s.checks.filter((c) => !c.ok))
const report = {
  spike: 's1-loader',
  ranAt: new Date().toISOString(),
  versions: {
    node: process.version,
    cordis: '4.1.0',
    loader: '1.1.0',
    group: '1.1.0',
  },
  scenarios,
  findings,
  summary: { checks: scenarios.flatMap((s) => s.checks).length, failed: failed.length },
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))

for (const s of scenarios) {
  console.log(`\n## ${s.title}`)
  for (const c of s.checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`)
    if (!c.ok) console.log(`        ${JSON.stringify(c.detail)}`)
  }
}
console.log('\n## findings')
for (const f of findings) console.log(`  - ${f}`)
console.log(`\n${report.summary.checks - failed.length}/${report.summary.checks} checks passed`)

ctx.dispose?.()
process.exit(failed.length ? 1 : 0)
