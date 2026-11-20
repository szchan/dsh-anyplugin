// The 64-character tool-name budget, enforced where it is decidable.
//
// Two layers, because the budget binds two different moments:
//  - the *prefix* (`mcp__plugin_<plugin>_<server>__`) is known without
//    connecting, so an over-budget prefix refuses the whole server at plan time;
//  - a single tool's name is only known after `tools/list`, so an over-budget
//    tool is skipped while its siblings still register.
//
// Neither layer renames anything: a truncated name passes a smoke test and
// makes a claim the model cannot use (D11).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { readClaudePlugin, CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { diffInventories } from '../src/inventory.ts'
import { probeWithDsh } from '../src/oracles/dsh.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harness = resolveHarness()
const materializers = {
  skill: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href,
  mcp: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-mcp', 'src', 'index.ts')).href,
}
const budgetDir = join(repoRoot, 'fixtures', 'claude-mcp-budget')
const toolDir = join(repoRoot, 'fixtures', 'claude-mcp-tool-budget')

test('an over-budget prefix refuses the whole server at plan time', () => {
  const ir = readClaudePlugin(budgetDir, { source: 'plugin-dir:fixtures/claude-mcp-budget' })
  assert.deepEqual(validateIr(ir), [])
  assert.equal(ir.mcpServers.length, 0, 'nothing may be emitted for an unusable prefix')

  const refused = ir.unsupported.find((item) => item.surface === 'mcpServers')
  assert.ok(refused, 'the refusal must be recorded, not dropped')
  assert.equal(refused.name, 'a-server-name-that-is-long-enough')
  assert.equal(refused.annotation.fidelity, 'unsupported')
  assert.match(refused.annotation.reason, /\(65 characters\)/)
  assert.match(refused.annotation.reason, /64-character limit/)

  const { entry } = emitPlugin(ir, { materializers })
  assert.ok(!entry, 'a plugin with only a refused server emits nothing')
})

test(
  'an over-budget tool is skipped while its sibling registers',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const ir = readClaudePlugin(toolDir, { source: 'plugin-dir:fixtures/claude-mcp-tool-budget' })
    assert.equal(ir.mcpServers.length, 1, 'the prefix fits, so the server is carried')
    const { entry } = emitPlugin(ir, { materializers, sdkRoot: harness.modulesDir })
    const { inventory, tools } = await probeWithDsh({ harnessDir: harness.harnessDir, entry })

    assert.ok(
      tools.includes('mcp__plugin_claude-mcp-tool-budget_probe__ok'),
      `the fitting tool must register, got ${JSON.stringify(tools)}`,
    )
    assert.ok(
      !tools.some((name) => name.includes('too_long')),
      `the over-budget tool must not be renamed into existence, got ${JSON.stringify(tools)}`,
    )
    for (const name of tools) assert.ok(name.length <= 64, `${name} is over the shared limit`)
    // And the server still counts: one usable tool is a usable server.
    const golden = JSON.parse(
      readFileSync(join(toolDir, '.inventory', `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}.json`), 'utf8'),
    )
    const report = diffInventories(golden, inventory, { allowPinMismatch: true })
    assert.equal(report.rows.find((row) => row.surface === 'mcpServers')?.status, 'match')
  },
)
