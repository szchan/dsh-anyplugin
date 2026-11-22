// The mod API ledger (#130): declared by the pinned declaration, served by the
// runtime `$` table, absent between them. The ledger is a denominator; this
// test proves it is the live one, not a hand-written list.
//
// The test does not skip when the fetched tree is missing. A skip here would
// report "0 skipped" while measuring nothing, and CI treats a skip as a failed
// job (D22/D24). `computeCoverage` throws with the fetch instruction instead.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildLedger,
  computeCoverage,
  diffLedger,
  inspectRuntime,
  ledgerPath,
  ledgerText,
  readDeclaration,
} from '../../../scripts/mod-coverage.mjs'
import { createModBridge } from '../../dsh-anyplugin-mod-host/src/bridge.ts'

const committedText = readFileSync(ledgerPath, 'utf8')
const committed = JSON.parse(committedText)

const assertPartition = (ledger) => {
  const { totals } = ledger
  for (const category of ['methods', 'properties']) {
    const row = totals[category]
    assert.equal(
      row.served + row.refused + row.absent + row.wrongShape,
      row.declared,
      `${category} is not a partition: ${JSON.stringify(row)}`,
    )
  }
  for (const category of ['events', 'elements', 'renderSites']) {
    const row = totals[category]
    assert.equal(row.served + row.absent, row.declared, `${category} is not a partition: ${JSON.stringify(row)}`)
  }
  assert.equal(
    totals.namespaces.served + totals.namespaces.refusedOnly + totals.namespaces.absent,
    totals.namespaces.declared,
    `namespaces is not a partition: ${JSON.stringify(totals.namespaces)}`,
  )
}

test('the committed ledger matches the pinned declaration and the runtime $ table', async () => {
  const live = await computeCoverage()
  const drift = diffLedger(committed, live)
  assert.deepEqual(drift, [], `fixtures/mods/coverage.json is stale:\n${drift.join('\n')}`)
})

test('the committed ledger is canonical JSON, so two runs are byte-identical', async () => {
  assert.equal(committedText, ledgerText(committed))
  const first = await computeCoverage()
  const second = await computeCoverage()
  assert.equal(ledgerText(first), ledgerText(second))
})

test('the corrected totals partition declared/served/refused/absent/wrong-shape', async () => {
  const live = await computeCoverage()
  assertPartition(live)

  assert.deepEqual(live.totals.methods, { declared: 100, served: 26, refused: 7, absent: 67, wrongShape: 0 })
  assert.deepEqual(live.totals.properties, { declared: 2, served: 0, refused: 0, absent: 2, wrongShape: 0 })
  assert.deepEqual(live.totals.namespaces, { declared: 24, served: 9, refusedOnly: 2, absent: 13 })
  assert.deepEqual(live.totals.events, { declared: 167, served: 24, absent: 143 })
  assert.deepEqual(live.totals.elements, { declared: 45, served: 45, absent: 0, unique: 14 })
  assert.deepEqual(live.totals.renderSites, { declared: 20, served: 1, absent: 19 })

  assert.deepEqual(live.served.properties, [])
  assert.deepEqual(live.absent.properties, ['plugin.name', 'plugin.root'])
  assert.deepEqual(live.served.renderSites, ['Pane'])
  assert.equal(live.absent.renderSites.length, 19)
  assert.equal(live.absent.renderSites.includes('Pane'), false)
})

test('the refused methods are a typed-refusal set with reason codes, excluded from served', async () => {
  const live = await computeCoverage()
  const refused = live.refused.methods
  assert.deepEqual(
    refused.map((entry) => entry.name),
    ['process.run', 'settings.read', 'ui.ask', 'vcs.isolate', 'vcs.list', 'vcs.release', 'vcs.status'],
  )
  const expected = new Map([
    ['process.run', 'ERR_MOD_HOST_EXEC_UNSUPPORTED'],
    ['settings.read', 'ERR_MOD_HOST_SETTINGS_UNAVAILABLE'],
    ['ui.ask', 'ERR_MOD_HOST_UI_UNSUPPORTED'],
    ['vcs.isolate', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
    ['vcs.list', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
    ['vcs.release', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
    ['vcs.status', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
  ])
  for (const entry of refused) {
    assert.equal(entry.code, expected.get(entry.name), `${entry.name} has the wrong refusal code`)
    assert.equal(live.served.methods.includes(entry.name), false, `${entry.name} is both served and refused`)
  }
})

test('namespace rows count service, not presence: refused-only namespaces have zero served members', async () => {
  const live = await computeCoverage()
  const servedNamespace = (name) => name.slice(0, name.indexOf('.'))
  const servedNamespaces = new Set(
    [...live.served.methods, ...live.served.properties].map((name) => servedNamespace(name)),
  )
  const refusedNamespaces = new Set(live.refused.methods.map((entry) => servedNamespace(entry.name)))

  assert.deepEqual(live.refused.namespaces, ['process', 'settings'])
  for (const name of live.served.namespaces) {
    assert.equal(servedNamespaces.has(name), true, `served namespace ${name} has no served member`)
  }
  for (const name of live.refused.namespaces) {
    assert.equal(servedNamespaces.has(name), false, `refused-only namespace ${name} has a served member`)
    assert.equal(refusedNamespaces.has(name), true, `refused-only namespace ${name} has no refused member`)
  }
  assert.equal(live.served.namespaces.includes('process'), false)
  assert.equal(live.served.namespaces.includes('settings'), false)
})

test('session.cwd is served as the pinned method, never a wrong-shape extra (#134)', async () => {
  const live = await computeCoverage()
  assert.deepEqual(live.wrongShape, [])
  assert.deepEqual(live.shapeMismatches, [])
  assert.equal(live.served.methods.includes('session.cwd'), true)
  assert.equal(live.served.properties.includes('session.cwd'), false)
  assert.equal(live.absent.methods.includes('session.cwd'), false)
})

// The wrong-shape classification still has to be exercised: forge a runtime
// property where the pin declares a method and prove it stays out of both
// served and absent while the partition holds.
test('a runtime property where the pin declares a method is wrong shape, not served or absent', async () => {
  await computeCoverage()
  const runtime = await inspectRuntime()
  const forged = {
    ...runtime,
    entries: runtime.entries.map((entry) =>
      entry.namespace === 'session' && entry.name === 'id'
        ? { ...entry, kind: 'property', valueType: 'string', code: undefined }
        : entry,
    ),
  }
  const distorted = buildLedger(readDeclaration(), forged)
  assert.deepEqual(distorted.wrongShape, [
    { name: 'session.id', declared: 'method', runtime: 'property', valueType: 'string' },
  ])
  assert.deepEqual(distorted.shapeMismatches, [{ name: 'session.id', declared: 'method', served: 'property' }])
  assert.equal(distorted.served.methods.includes('session.id'), false)
  assert.equal(distorted.absent.methods.includes('session.id'), false)
  assertPartition(distorted)
})

test('elements are surface-qualified, so dropping one surface entry is visible', async () => {
  await computeCoverage()
  const runtime = await inspectRuntime()
  const forged = {
    ...runtime,
    elements: { ...runtime.elements, vscode: runtime.elements.vscode.filter((name) => name !== 'Svg') },
  }
  const distorted = buildLedger(readDeclaration(), forged)
  assert.deepEqual(distorted.absent.elements, ['vscode:Svg'])
  assert.equal(distorted.totals.elements.served, 44)
  assert.equal(distorted.totals.elements.absent, 1)
  assertPartition(distorted)
})

test('buildLedger (and therefore --update) rejects a runtime member the pin does not declare', async () => {
  await computeCoverage()
  const runtime = await inspectRuntime()
  const forged = {
    ...runtime,
    entries: [
      ...runtime.entries,
      { namespace: 'ui', name: 'debug', kind: 'method', valueType: 'function', code: undefined },
    ],
  }
  assert.throws(
    () => buildLedger(readDeclaration(), forged),
    /serves members the pinned declaration does not declare: ui\.debug/,
  )
})

test('every runtime $ member is classified exactly once', async () => {
  const live = await computeCoverage()
  const bridge = createModBridge({
    plugin: 'mod-api-ledger-test',
    dataDir: '',
    session: () => ({ id: 'mod-api-ledger-test', cwd: process.cwd(), messages: [], usage: {} }),
    commands: { register: () => () => {} },
    env: {},
    warn: () => {},
  })
  try {
    const table = bridge.dollar()
    const keys = []
    for (const [namespace, members] of Object.entries(table)) {
      for (const name of Object.keys(members)) keys.push(`${namespace}.${name}`)
    }
    const classified = [
      ...live.served.methods,
      ...live.served.properties,
      ...live.refused.methods.map((entry) => entry.name),
      ...live.wrongShape.map((entry) => entry.name),
    ]
    assert.deepEqual(classified.sort(), keys.sort())
  } finally {
    bridge.dispose()
  }
})

// This is a builder/diff test: it removes a member from a computed ledger copy,
// not from the bridge source. The bridge-source mutation (deleting `usage` from
// `dollar()`) is performed manually and recorded in the PR; a test cannot edit
// the module under test without changing what every other test imports.
test('diffLedger reports a served-method removal from a computed ledger', async () => {
  const live = await computeCoverage()
  assert.ok(live.served.methods.length > 0, 'the runtime $ table served no methods; the probe is wrong')
  const mutated = structuredClone(live)
  const removed = mutated.served.methods.pop()
  const drift = diffLedger(live, mutated)
  assert.ok(
    drift.some((line) => line.startsWith('served.methods:') && line.includes(removed)),
    `removing ${removed} from served.methods was not reported:\n${drift.join('\n')}`,
  )
})
