// Transplant test: a Claude Code plugin directory must produce the same
// inventory in DSH as it does in Claude Code itself.
//
// Expected side: the golden captured from `claude --plugin-dir … plugin details`
// (pin 2.1.329). Actual side: our dialect → IR → emit → the *installed* DSH
// registry. A pass means the observable component list transplants byte for
// byte; pins differ by design and are asserted explicitly instead of waived.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { readClaudePlugin, CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { summarizeIr, validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { diffInventories } from '../src/inventory.ts'
import { probeWithDsh, dshVersion } from '../src/oracles/dsh.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = join(repoRoot, 'fixtures', 'claude-skills-only')
const harness = resolveHarness()
const materializerUrl = pathToFileURL(
  join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts'),
).href
const golden = JSON.parse(
  readFileSync(join(fixtureDir, '.inventory', `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}.json`), 'utf8'),
)

test('the dialect reads the fixture the way the host reports it', () => {
  const ir = readClaudePlugin(fixtureDir, { source: 'plugin-dir:fixtures/claude-skills-only' })
  assert.deepEqual(validateIr(ir), [])
  assert.equal(ir.plugin.name, 'skills-only')
  assert.equal(ir.pin.version, CLAUDE_CODE_PIN.version)
  assert.deepEqual(
    ir.skills.map((skill) => skill.name).sort(),
    ['greet', 'hello'],
  )
  for (const skill of ir.skills) {
    assert.equal(skill.annotation.fidelity, 'equivalent', `${skill.name} keeps its body but not its envelope`)
    if (skill.name === 'greet') {
      assert.deepEqual(skill.argumentNames, ['name'], 'greet declares arguments: [name]')
    }
    assert.equal(skill.origin, 'skills-dir')
  }
  const report = summarizeIr(ir)
  assert.equal(report.totals.declared, 2)
  assert.equal(report.totals.emittable, 2)
})

test('the emitter produces one group entry with a stable, addressable id', () => {
  const ir = readClaudePlugin(fixtureDir)
  const { entry, emitted, skipped } = emitPlugin(ir, { materializers: { skill: materializerUrl } })
  assert.ok(entry, 'entry expected')
  assert.equal(entry.id, 'anyplugin.skills-only')
  assert.equal(entry.name, '@deepseek-ai/cordis-plugin-group')
  assert.equal(entry.group, true)
  assert.deepEqual(emitted, ['skills'])
  assert.deepEqual(skipped, [])
  const children = entry.config
  assert.equal(children.length, 1)
  assert.equal(children[0].id, 'skill')
  assert.equal(children[0].name, materializerUrl)
})

test(
  'DSH reports the same skills as Claude Code (transplant, 0 diff)',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const ir = readClaudePlugin(fixtureDir)
    const { entry } = emitPlugin(ir, { materializers: { skill: materializerUrl } })
    const { inventory } = await probeWithDsh({ harnessDir: harness.harnessDir, entry })

    assert.equal(inventory.pin?.tool, 'dsh')
    assert.equal(dshVersion(harness.harnessDir), harness.version, 'the comparison is claimed against the harness under test')
    assert.equal(inventory.pin?.version, harness.version, 'the inventory names the version it actually booted')

    const report = diffInventories(golden, inventory, { allowPinMismatch: true })
    assert.deepEqual(
      report.rows.map((row) => `${row.surface}:${row.name}:${row.status}`),
      ['skills:greet:match', 'skills:hello:match'],
    )
    assert.equal(report.summary.missing, 0)
    assert.equal(report.summary.extra, 0)
    assert.equal(report.summary.changed, 0)
    assert.ok(report.ok)
  },
)
