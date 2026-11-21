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

import { computeCoverage, diffLedger, ledgerPath, ledgerText } from '../../../scripts/mod-coverage.mjs'
import { createModBridge } from '../../dsh-anyplugin-mod-host/src/bridge.ts'

const committedText = readFileSync(ledgerPath, 'utf8')
const committed = JSON.parse(committedText)

test('the committed ledger matches the pinned declaration and the runtime $ table', () => {
  const live = computeCoverage()
  const drift = diffLedger(committed, live)
  assert.deepEqual(drift, [], `fixtures/mods/coverage.json is stale:\n${drift.join('\n')}`)
})

test('the committed ledger is canonical JSON, so two runs are byte-identical', () => {
  assert.equal(committedText, ledgerText(committed))
  assert.equal(ledgerText(computeCoverage()), ledgerText(computeCoverage()))
})

test('removing a served method from the runtime surface is reported as drift', () => {
  const live = computeCoverage()
  assert.ok(live.served.methods.length > 0, 'the runtime $ table served no methods; the probe is wrong')
  const mutated = structuredClone(live)
  const removed = mutated.served.methods.pop()
  const drift = diffLedger(live, mutated)
  assert.ok(
    drift.some((line) => line.startsWith('served.methods:') && line.includes(removed)),
    `removing ${removed} from served.methods was not reported:\n${drift.join('\n')}`,
  )
})

test('the ledger served set is the runtime $ table, not a copy of it', () => {
  const bridge = createModBridge({ plugin: 'mod-api-ledger-test', dataDir: '', warn: () => {} })
  try {
    const table = bridge.dollar()
    const methods = []
    const properties = []
    for (const [namespace, members] of Object.entries(table)) {
      for (const [name, value] of Object.entries(members)) {
        const qualified = `${namespace}.${name}`
        if (typeof value === 'function') methods.push(qualified)
        else properties.push(qualified)
      }
    }
    methods.sort()
    properties.sort()
    const live = computeCoverage()
    assert.deepEqual(live.served.methods, methods)
    assert.deepEqual(live.served.properties, properties)
  } finally {
    bridge.dispose()
  }
})
