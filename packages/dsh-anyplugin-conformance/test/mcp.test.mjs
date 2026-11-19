// MCP transplant test: the `probe` server in the hooks fixture must be
// connected by the materializer and expose Claude's exact tool name.
//
// The golden side says only that the server is *declared* ("tool schemas
// resolved at runtime; not counted"). The DSH side is stricter on purpose: a
// server counts when it contributes a tool, because that is what the model can
// call. That difference is what this test pins.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { diffInventories } from '../src/inventory.ts'
import { probeWithDsh } from '../src/oracles/dsh.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = join(repoRoot, 'fixtures', 'claude-hooks-mcp')
const installedDir = process.env.DSH_INSTALL_DIR ? join(process.env.DSH_INSTALL_DIR, '..') : undefined
const materializers = {
  skill: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href,
  mcp: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-mcp', 'src', 'index.ts')).href,
}
const golden = JSON.parse(
  readFileSync(join(fixtureDir, '.inventory', 'claude-code@2.1.322.json'), 'utf8'),
)

test('the dialect resolves ${CLAUDE_PLUGIN_ROOT} into a runnable stdio server', () => {
  const ir = readClaudePlugin(fixtureDir, { source: 'plugin-dir:fixtures/claude-hooks-mcp' })
  assert.deepEqual(validateIr(ir), [])
  assert.equal(ir.mcpServers.length, 1)
  const [server] = ir.mcpServers
  assert.equal(server.name, 'probe')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.command, 'node')
  assert.equal(server.annotation.fidelity, 'equivalent')
  assert.match(server.annotation.reason, /Server instructions are not injected/)
  // The variable must be gone, and the path must exist as authored.
  assert.deepEqual(server.args, [`${fixtureDir}/probe-server.mjs`])
  assert.ok(!server.args[0].includes('${'), 'no unexpanded variable may reach the materializer')
})

test('the emitter carries the server as data under the mcp child', () => {
  const ir = readClaudePlugin(fixtureDir)
  // The hook is carried as a *declaration* (planned), not emitted: there is no
  // PostToolUse intercept point in the harness yet (ARCHITECTURE §9).
  assert.equal(ir.hooks[0]?.annotation.fidelity, 'planned')
  const { entry, emitted, skipped } = emitPlugin(ir, {
    materializers,
    sdkRoot: installedDir ? dirname(installedDir) : undefined,
  })
  assert.ok(entry)
  assert.ok(emitted.includes('mcpServers'))
  const child = entry.config.find((item) => item.id === 'mcp')
  assert.ok(child, 'mcp child expected')
  assert.equal(child.name, materializers.mcp)
  assert.equal(child.config.plugin, 'hooks-mcp')
  assert.deepEqual(child.config.servers.map((server) => server.name), ['probe'])
  // Everything declared-and-emittable is emitted; nothing is dropped silently.
  assert.deepEqual(skipped, [])
})

test(
  'DSH connects the server and registers the exact tool name',
  { skip: installedDir ? false : 'DSH_INSTALL_DIR is not set' },
  async () => {
    const ir = readClaudePlugin(fixtureDir)
    const { entry } = emitPlugin(ir, { materializers, sdkRoot: dirname(installedDir) })
    const { inventory, tools } = await probeWithDsh({ installedDir, entry })

    assert.ok(
      tools.includes('mcp__plugin_hooks-mcp_probe__create_issue'),
      `expected Claude's exact tool name, got ${JSON.stringify(tools)}`,
    )
    // The budget is enforced by us because the runtime does not (D11): a
    // truncated or hashed name would show up here as a suffix.
    for (const name of tools) assert.doesNotMatch(name, /_[0-9a-f]{12}$/)

    const report = diffInventories(golden, inventory, { allowPinMismatch: true })
    const mcpRow = report.rows.find((row) => row.surface === 'mcpServers')
    assert.equal(mcpRow?.status, 'match', JSON.stringify(report.rows))
  },
)
