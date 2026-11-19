// Coverage ratchet: how much of each fixture's declared surface survives the
// transplant today.
//
// This test is deliberately *allowed* to be red for a while — it is the visible
// burn-down for "100 % fidelity". Each fixture states its exact row set, so
// closing a gap means editing this file (a reviewable act) and a regression
// fails immediately. The totals are the number the project reports: matched
// components over declared components, never a percentage of "things we tried".

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { diffInventories, emptyInventory } from '../src/inventory.ts'
import { probeWithDsh, dshVersion } from '../src/oracles/dsh.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const installedDir = process.env.DSH_INSTALL_DIR ? join(process.env.DSH_INSTALL_DIR, '..') : undefined
const materializerUrl = pathToFileURL(
  join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts'),
).href

/**
 * What the transplant produces per fixture, as of this commit. Closing a gap
 * must move rows from `missing` to `match` here — in the same commit that makes
 * it true.
 */
const EXPECTED_ROWS = {
  'claude-agents': ['agents:reviewer:missing'],
  'claude-command-nested': [],
  'claude-commands-flat': ['skills:migrate:missing', 'skills:review:missing'],
  'claude-hooks-mcp': ['hooks:PostToolUse:missing', 'mcpServers:probe:missing'],
  'claude-root-skill': ['skills:rooty:match'],
  'claude-skills-only': ['skills:greet:match', 'skills:hello:match'],
}

async function inventoryFor(fixture) {
  const dir = join(repoRoot, 'fixtures', fixture)
  const ir = readClaudePlugin(dir, { source: `plugin-dir:fixtures/${fixture}` })
  const { entry } = emitPlugin(ir, { materializers: { skill: materializerUrl } })
  if (!entry) {
    const inventory = emptyInventory({ name: ir.plugin.name, source: `dsh:${dshVersion(installedDir)}` })
    inventory.pin = { tool: 'dsh', version: dshVersion(installedDir) }
    return inventory
  }
  return (await probeWithDsh({ installedDir, entry })).inventory
}

test(
  'fixture coverage matches the recorded matrix',
  { skip: installedDir ? false : 'DSH_INSTALL_DIR is not set' },
  async () => {
    const totals = { declared: 0, matched: 0, missing: 0 }
    for (const fixture of Object.keys(EXPECTED_ROWS).sort()) {
      assert.ok(existsSync(join(repoRoot, 'fixtures', fixture)), `${fixture} exists`)
      const golden = JSON.parse(
        readFileSync(join(repoRoot, 'fixtures', fixture, '.inventory', 'claude-code@2.1.322.json'), 'utf8'),
      )
      const inventory = await inventoryFor(fixture)
      assert.equal(inventory.pin?.tool, 'dsh', 'the actual side is DSH')
      const report = diffInventories(golden, inventory, { allowPinMismatch: true })
      assert.deepEqual(
        report.rows.map((row) => `${row.surface}:${row.name}:${row.status}`),
        EXPECTED_ROWS[fixture],
        `${fixture}: the transplant result changed`,
      )
      totals.declared += report.summary.expected
      totals.matched += report.summary.match
      totals.missing += report.summary.missing
    }
    assert.deepEqual(totals, { declared: 8, matched: 3, missing: 5 })
  },
)
