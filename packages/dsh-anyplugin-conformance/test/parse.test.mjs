import assert from 'node:assert/strict'
import test from 'node:test'
import { parseClaudeDetails } from '../src/oracles/claude.ts'
import { normalizeInventory } from '../src/inventory.ts'

const SAMPLE = `probe 0.0.1
  Description: S3 probe
  Source: probe@inline

Component inventory
  Skills (2)  hello, migrate
  Agents (1)  reviewer
  Hooks (1)  PostToolUse  (harness-only — no model context cost)
  MCP servers (1)  probe  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~17 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  hello           < 20       < 20
  migrate         ~4          < 20

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
`

test('parses the details report into a normalized inventory', () => {
  const { inventory } = parseClaudeDetails(SAMPLE, 'fallback')
  const normalized = normalizeInventory(inventory)
  assert.equal(normalized.plugin.name, 'probe')
  assert.equal(normalized.plugin.version, '0.0.1')
  assert.deepEqual(
    normalized.components.map((component) => `${component.surface}:${component.name}`),
    ['agents:reviewer', 'hooks:PostToolUse', 'mcpServers:probe', 'skills:hello', 'skills:migrate'],
  )
  assert.equal(normalized.components.find((c) => c.name === 'PostToolUse').details.note, 'harness-only — no model context cost')
  assert.deepEqual(normalized.tokens.alwaysOn, { value: 17 })
  assert.deepEqual(normalized.tokens.perComponent.hello, { value: 20, atMost: true })
  assert.deepEqual(normalized.tokens.perComponent.migrate, { value: 4 })
})

test('duplicate entries on one line are aggregated with an occurrence count', () => {
  const { inventory } = parseClaudeDetails(
    SAMPLE.replace('Hooks (1)  PostToolUse  (harness-only — no model context cost)', 'Hooks (2)  PostToolUse, PostToolUse'),
    'probe',
  )
  const hooks = normalizeInventory(inventory).components.find((c) => c.surface === 'hooks')
  assert.equal(hooks.name, 'PostToolUse')
  assert.equal(hooks.details.occurrences, 2)
})

test('an unknown section label is recorded, never dropped', () => {
  const { inventory } = parseClaudeDetails(
    SAMPLE.replace('LSP servers (0)', 'LSP servers (0)\n  Widgets (1)  sparkle'),
    'probe',
  )
  const normalized = normalizeInventory(inventory)
  assert.ok(normalized.components.some((c) => c.surface === 'other' && c.name === 'Widgets'))
  assert.ok(normalized.notes.some((note) => note.includes('Widgets')))
})

test('a count that disagrees with the listed names is reported as a note', () => {
  const { inventory } = parseClaudeDetails(SAMPLE.replace('Skills (2)  hello, migrate', 'Skills (3)  hello, migrate'), 'probe')
  assert.ok(normalizeInventory(inventory).notes.some((note) => note.includes('reported 3 but listed 2')))
})

test('a plugin with no manifest still yields the directory name', () => {
  const { inventory } = parseClaudeDetails(
    'rootdir\n  Description: Plugin from rootdir@inline\n  Source: rootdir@inline\n\nComponent inventory\n  Skills (1)  rooty\n  Agents (0)\n  Hooks (0)\n  MCP servers (0)\n  LSP servers (0)\n',
    'rootdir',
  )
  assert.equal(inventory.plugin.name, 'rootdir')
  assert.equal(inventory.plugin.version, undefined)
  assert.equal(inventory.components.length, 1)
})
