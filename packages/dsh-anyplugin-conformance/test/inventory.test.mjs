import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INVENTORY_SCHEMA,
  diffInventories,
  emptyInventory,
  normalizeInventory,
} from '../src/inventory.ts'

const pin = { tool: 'claude-code', version: '2.1.322' }

function inventory(components, extra = {}) {
  return { ...emptyInventory({ name: 'demo' }), components, pin: { ...pin }, ...extra }
}

test('normalize sorts, dedupes and is idempotent', () => {
  const input = inventory([
    { surface: 'skills', name: ' zeta ' },
    { surface: 'agents', name: 'reviewer' },
    { surface: 'skills', name: 'alpha' },
    { surface: 'skills', name: 'alpha' },
    { surface: 'not-a-surface', name: 'stray' },
  ])
  const once = normalizeInventory(input)
  const twice = normalizeInventory(once)
  assert.deepEqual(twice, once)
  assert.deepEqual(
    once.components.map((component) => `${component.surface}:${component.name}`),
    ['agents:reviewer', 'other:stray', 'skills:alpha', 'skills:zeta'],
  )
})

test('normalize keeps details and sorts their keys', () => {
  const normalized = normalizeInventory(
    inventory([{ surface: 'hooks', name: 'PostToolUse', details: { b: 2, a: 'x' } }]),
  )
  assert.deepEqual(Object.keys(normalized.components[0].details), ['a', 'b'])
})

test('identical inventories pass', () => {
  const one = inventory([{ surface: 'skills', name: 'hello' }])
  const report = diffInventories(one, one)
  assert.equal(report.ok, true)
  assert.equal(report.summary.match, 1)
})

test('a missing component fails and is attributed to its surface', () => {
  const expected = inventory([
    { surface: 'skills', name: 'hello' },
    { surface: 'skills', name: 'greet' },
  ])
  const actual = inventory([{ surface: 'skills', name: 'hello' }])
  const report = diffInventories(expected, actual)
  assert.equal(report.ok, false)
  assert.deepEqual(
    report.rows.filter((row) => row.status !== 'match').map((row) => `${row.status}:${row.name}`),
    ['missing:greet'],
  )
  assert.equal(report.summary.bySurface.skills.missing, 1)
})

test('an extra component fails', () => {
  const report = diffInventories(inventory([]), inventory([{ surface: 'agents', name: 'ghost' }]))
  assert.equal(report.ok, false)
  assert.equal(report.rows[0].status, 'extra')
})

test('changed details fail even when the name matches', () => {
  const expected = inventory([{ surface: 'hooks', name: 'PostToolUse', details: { occurrences: 1 } }])
  const actual = inventory([{ surface: 'hooks', name: 'PostToolUse', details: { occurrences: 2 } }])
  const report = diffInventories(expected, actual)
  assert.equal(report.ok, false)
  assert.equal(report.rows[0].status, 'changed')
})

test('a pin mismatch fails on its own and can be waived explicitly', () => {
  const expected = inventory([{ surface: 'skills', name: 'hello' }])
  const actual = inventory([{ surface: 'skills', name: 'hello' }], { pin: { tool: 'claude-code', version: '9.9.9' } })
  assert.equal(diffInventories(expected, actual).ok, false)
  assert.equal(diffInventories(expected, actual).pin.mismatch, true)
  assert.equal(diffInventories(expected, actual, { allowPinMismatch: true }).ok, true)
})

test('an unpinned inventory does not silently pass as pinned', () => {
  const expected = { ...emptyInventory({ name: 'demo' }), components: [] }
  const actual = inventory([])
  const report = diffInventories(expected, actual)
  assert.equal(report.pin.mismatch, false)
  assert.equal(report.ok, true)
  assert.equal(normalizeInventory(expected).pin, undefined)
  assert.equal(normalizeInventory(expected).$schema, INVENTORY_SCHEMA)
})
