/**
 * End-to-end: re-probe every fixture with the installed upstream CLI and diff
 * against its committed golden. This is the test that turns "100 %" into a
 * number: it fails when the pin moves and behavior changes.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeInventory } from '../src/inventory.ts'
import { probeWithClaude } from '../src/oracles/claude.ts'
import { readInventoryFile } from '../src/oracles/file.ts'
import { diffInventories } from '../src/inventory.ts'

const root = new URL('..', import.meta.url).pathname
const fixturesDir = join(root, '../../fixtures')

function claudeAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const available = claudeAvailable()

async function fixtureDirs() {
  const entries = await readdir(fixturesDir)
  const dirs = []
  for (const entry of entries.sort()) {
    if (!entry.startsWith('claude-')) continue
    const dir = join(fixturesDir, entry)
    if ((await stat(dir)).isDirectory()) dirs.push({ name: entry, dir })
  }
  return dirs
}

test('every fixture matches its golden inventory', { skip: available ? false : 'claude CLI not installed' }, async (t) => {
  for (const fixture of await fixtureDirs()) {
    const goldensDir = join(fixture.dir, '.inventory')
    const goldens = (await readdir(goldensDir)).filter((file) => file.endsWith('.json'))
    assert.ok(goldens.length > 0, `${fixture.name} has no golden inventory`)
    for (const golden of goldens) {
      await t.test(`${fixture.name} @ ${golden}`, async () => {
        const expected = await readInventoryFile(join(goldensDir, golden))
        const probe = await probeWithClaude({ pluginDir: fixture.dir })
        const actual = normalizeInventory({ ...probe.inventory, pin: probe.pin })
        const report = diffInventories(expected, actual)
        assert.ok(report.ok, JSON.stringify(report.rows.filter((row) => row.status !== 'match'), null, 2))
      })
    }
  }
})
