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
import { startHttpServer } from '../../../fixtures/claude-mcp-http/http-server.mjs'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { diffInventories, emptyInventory } from '../src/inventory.ts'
import { probeWithDsh, dshVersion } from '../src/oracles/dsh.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const installedDir = process.env.DSH_INSTALL_DIR ? join(process.env.DSH_INSTALL_DIR, '..') : undefined
const materializerUrl = (pkg) => pathToFileURL(join(repoRoot, 'packages', pkg, 'src', 'index.ts')).href
const materializers = {
  skill: materializerUrl('dsh-anyplugin-materialize-skill'),
  mcp: materializerUrl('dsh-anyplugin-materialize-mcp'),
  hooks: materializerUrl('dsh-anyplugin-materialize-hook'),
}

/**
 * What the transplant produces per fixture, as of this commit. Closing a gap
 * must move rows from `missing` to `match` here — in the same commit that makes
 * it true.
 */
const EXPECTED_ROWS = {
  'claude-agents': ['agents:reviewer:missing'],
  'claude-command-nested': [],
  'claude-commands-flat': ['skills:migrate:match', 'skills:review:match'],
  'claude-hooks-mcp': ['hooks:PostToolUse:match', 'mcpServers:probe:match'],
  'claude-mcp-budget': ['mcpServers:a-server-name-that-is-long-enough:refused'],
  'claude-mcp-http': ['mcpServers:http-probe:match'],
  'claude-mcp-tool-budget': ['mcpServers:probe:match'],
  'claude-root-skill': ['skills:rooty:match'],
  'claude-skills-only': ['skills:greet:match', 'skills:hello:match'],
}

/**
 * Hooks are the one surface whose presence is not readable from a registry:
 * a hook that is mounted and one that is not both leave no trace. So the
 * fixture with a hook gets one real call through the pipeline, and its row is
 * reported as matched only when the hook's own text came back on the result.
 */
const HOOK_PROBES = {
  'claude-hooks-mcp': { tool: 'Write', marker: 'anyplugin-hook: PostToolUse fired', component: 'hooks:PostToolUse' },
}

/**
 * Fixtures that cannot answer without a live process. Keeping them in the same
 * ratchet matters: "declared" is what the golden says, and excluding the HTTP
 * arm would quietly shrink the denominator.
 */
const PREPARE = {
  async 'claude-mcp-http'() {
    const server = await startHttpServer()
    const previous = process.env.ANYPLUGIN_MCP_URL
    process.env.ANYPLUGIN_MCP_URL = server.url
    return () => {
      if (previous === undefined) delete process.env.ANYPLUGIN_MCP_URL
      else process.env.ANYPLUGIN_MCP_URL = previous
      return server.close()
    }
  },
}

async function inventoryFor(fixture) {
  const dir = join(repoRoot, 'fixtures', fixture)
  const ir = readClaudePlugin(dir, { source: `plugin-dir:fixtures/${fixture}` })
  const { entry } = emitPlugin(ir, { materializers, sdkRoot: installedDir ? join(installedDir, '..') : undefined })
  const refused = new Set((ir.unsupported ?? []).map((item) => `${item.surface}:${item.name}`))
  if (!entry) {
    const inventory = emptyInventory({ name: ir.plugin.name, source: `dsh:${dshVersion(installedDir)}` })
    inventory.pin = { tool: 'dsh', version: dshVersion(installedDir) }
    return { inventory, refused }
  }
  const hookProbe = HOOK_PROBES[fixture]
  const probe = await probeWithDsh({
    installedDir,
    entry,
    ...(hookProbe === undefined ? {} : { behavior: { tool: hookProbe.tool }, timeoutMs: 10_000 }),
  })
  const inventory = probe.inventory
  if (hookProbe !== undefined && (probe.behavior?.text ?? '').includes(hookProbe.marker)) {
    const [, name] = hookProbe.component.split(':')
    inventory.components.push({ surface: 'hooks', name })
  }
  return { inventory, refused }
}

test(
  'fixture coverage matches the recorded matrix',
  { skip: installedDir ? false : 'DSH_INSTALL_DIR is not set' },
  async () => {
    const totals = { declared: 0, matched: 0, missing: 0, refused: 0 }
    for (const fixture of Object.keys(EXPECTED_ROWS).sort()) {
      assert.ok(existsSync(join(repoRoot, 'fixtures', fixture)), `${fixture} exists`)
      const golden = JSON.parse(
        readFileSync(join(repoRoot, 'fixtures', fixture, '.inventory', 'claude-code@2.1.322.json'), 'utf8'),
      )
      const cleanup = await PREPARE[fixture]?.()
      try {
        const { inventory, refused } = await inventoryFor(fixture)
        assert.equal(inventory.pin?.tool, 'dsh', 'the actual side is DSH')
        const report = diffInventories(golden, inventory, { allowPinMismatch: true })
        // A declared component we refuse on purpose is not a gap: D11 says we
        // report the budget instead of renaming a tool into existence.
        const statusOf = (row) =>
          row.status === 'missing' && refused.has(`${row.surface}:${row.name}`) ? 'refused' : row.status
        assert.deepEqual(
          report.rows.map((row) => `${row.surface}:${row.name}:${statusOf(row)}`),
          EXPECTED_ROWS[fixture],
          `${fixture}: the transplant result changed`,
        )
        for (const row of report.rows) {
          totals.declared += 1
          if (statusOf(row) === 'match') totals.matched += 1
          else if (statusOf(row) === 'refused') totals.refused += 1
          else totals.missing += 1
        }
      } finally {
        await cleanup?.()
      }
    }
    assert.deepEqual(totals, { declared: 11, matched: 9, missing: 1, refused: 1 })
  },
)

// The inventory counts *components*, and a command matches there because its
// model face is emitted. Recording that as a bare 5/8 would read as progress on
// the human face too, which is exactly the lie D10 exists to prevent — so the
// missing face is asserted right next to the count it improves.
test('command components match on the model face only; the human face stays planned', () => {
  const ir = readClaudePlugin(join(repoRoot, 'fixtures', 'claude-commands-flat'), {
    source: 'plugin-dir:fixtures/claude-commands-flat',
  })
  const commands = ir.skills.filter((skill) => skill.origin === 'commands-dir')
  assert.equal(commands.length, 2)
  for (const command of commands) {
    assert.equal(command.annotation.fidelity, 'planned', `${command.name}: overall fidelity is the weakest face`)
    assert.equal(command.faces?.model.fidelity, 'equivalent')
    assert.equal(command.faces?.human.fidelity, 'planned')
    assert.match(command.faces.human.reason, /D10/)
  }
})
