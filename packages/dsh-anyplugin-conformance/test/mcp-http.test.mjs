// MCP over Streamable HTTP: the same materializer, a different transport.
//
// The server is started by the test on an ephemeral port and its URL reaches
// the plugin through `${ANYPLUGIN_MCP_URL}` — the fixture must not pin a port,
// and the env expansion is the same one an author would use.
//
// The golden only says the server is declared. The DSH side counts a server
// when it contributes a tool (D12), which is the stricter claim.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { startHttpServer } from '../../../fixtures/claude-mcp-http/http-server.mjs'
import { readClaudePlugin, CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { expandEnv } from '../../dsh-anyplugin-materialize-mcp/src/index.ts'
import { diffInventories } from '../src/inventory.ts'
import { probeWithDsh } from '../src/oracles/dsh.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = join(repoRoot, 'fixtures', 'claude-mcp-http')
const harness = resolveHarness()
const materializers = {
  skill: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href,
  mcp: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-mcp', 'src', 'index.ts')).href,
}
const golden = JSON.parse(
  readFileSync(join(fixtureDir, '.inventory', `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}.json`), 'utf8'),
)

test('the dialect keeps a ${VAR} url for the materializer to resolve', () => {
  const ir = readClaudePlugin(fixtureDir, { source: 'plugin-dir:fixtures/claude-mcp-http' })
  assert.deepEqual(validateIr(ir), [])
  const [server] = ir.mcpServers
  assert.equal(server.name, 'http-probe')
  assert.equal(server.transport, 'http')
  // A plain env variable is not a session-scoped one: the dialect must not
  // downgrade it to "unresolved" the way it does for ${CLAUDE_PROJECT_DIR}.
  assert.equal(server.annotation.fidelity, 'equivalent')
  assert.equal(server.url, '${ANYPLUGIN_MCP_URL}')
  assert.equal(expandEnv(server.url, { ANYPLUGIN_MCP_URL: 'http://127.0.0.1:1/mcp' }), 'http://127.0.0.1:1/mcp')
  assert.equal(expandEnv('${MISSING:-fallback}'), 'fallback')
})

test(
  'DSH connects over HTTP and registers the exact tool name',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const server = await startHttpServer()
    const previous = process.env.ANYPLUGIN_MCP_URL
    process.env.ANYPLUGIN_MCP_URL = server.url
    try {
      const ir = readClaudePlugin(fixtureDir)
      const { entry } = emitPlugin(ir, { materializers, sdkRoot: harness.modulesDir })
      const child = entry.config.find((item) => item.id === 'mcp')
      assert.equal(child.config.servers[0].transport, 'http')

      const { inventory, tools } = await probeWithDsh({ harnessDir: harness.harnessDir, entry })
      assert.ok(
        tools.includes('mcp__plugin_claude-mcp-http_http-probe__echo'),
        `expected Claude's exact tool name, got ${JSON.stringify(tools)}`,
      )
      for (const name of tools) assert.doesNotMatch(name, /_[0-9a-f]{12}$/)

      const report = diffInventories(golden, inventory, { allowPinMismatch: true })
      const row = report.rows.find((entry) => entry.surface === 'mcpServers')
      assert.equal(row?.status, 'match', JSON.stringify(report.rows))
    } finally {
      if (previous === undefined) delete process.env.ANYPLUGIN_MCP_URL
      else process.env.ANYPLUGIN_MCP_URL = previous
      await server.close()
    }
  },
)
