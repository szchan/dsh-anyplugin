// The classic arm, end to end: a plugin's PostToolUse hook must actually run
// on this host and its output must reach the model.
//
// The assertion is deliberately behavioural. A hook that is parsed, recorded,
// emitted and then never mounted would still produce a clean inventory — the
// only proof is a call whose result carries the hook's text (D19).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { classify, emptyGrants, gate, grantFor } from '../../dsh-anyplugin-trust/src/index.ts'
import { probeWithDsh } from '../src/oracles/dsh.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harness = resolveHarness()
const materializerUrl = (pkg) => pathToFileURL(join(repoRoot, 'packages', pkg, 'src', 'index.ts')).href
const materializers = {
  skill: materializerUrl('dsh-anyplugin-materialize-skill'),
  mcp: materializerUrl('dsh-anyplugin-materialize-mcp'),
  hooks: materializerUrl('dsh-anyplugin-materialize-hook'),
}
const fixture = join(repoRoot, 'fixtures', 'claude-hooks-mcp')
const lifecycleFixture = join(repoRoot, 'fixtures', 'claude-hooks-lifecycle')
function gateAll(ir) {
  let store = emptyGrants()
  for (const row of classify(ir)) store = grantFor(ir, store, row.target, { scope: 'user' })
  return gate(ir, store)
}

test('a PostToolUse hook is carried as its own child entry', () => {
  const ir = readClaudePlugin(fixture)
  const hook = ir.hooks.find((entry) => entry.event === 'PostToolUse')
  assert.ok(hook, 'the fixture declares a PostToolUse hook')
  assert.equal(hook.annotation.fidelity, 'equivalent')
  assert.match(hook.annotation.reason, /waterfall/)
  assert.match(hook.command, /format\.sh/)

  const gated = gateAll(ir)
  const { entry, emitted, skipped, refused } = emitPlugin(gated.ir, {
    materializers,
    sdkRoot: harness?.modulesDir,
    trusted: gated.decision.allowed,
  })
  assert.ok(emitted.includes('hooks'))
  const child = entry.config.find((item) => item.id === 'hook')
  assert.equal(child.name, materializers.hooks)
  assert.equal(child.config.hooks.length, 1)
  assert.equal(child.config.hooks[0].matcher, 'Write|Edit')
  // The plugin root is absolute at plan time; the hook substitutes it at run time.
  assert.equal(child.config.pluginRoot, fixture)
  assert.deepEqual(skipped, [])
  assert.deepEqual(refused, [])
})

test('the five lifecycle hooks are carried on the five host events', () => {
  const ir = readClaudePlugin(lifecycleFixture)
  assert.deepEqual(
    ir.hooks.map((hook) => hook.event),
    ['SessionStart', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'],
  )
  for (const hook of ir.hooks) {
    assert.equal(hook.annotation.fidelity, 'equivalent', `${hook.event} is annotated at the source`)
    assert.match(hook.annotation.reason, /S9/, `${hook.event} names the seam that carries it`)
  }

  const gated = gateAll(ir)
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-hooks-'))
  try {
    const { entry, emitted, skipped, refused } = emitPlugin(gated.ir, {
      materializers,
      sdkRoot: harness?.modulesDir,
      trusted: gated.decision.allowed,
      dataDir,
    })
    assert.ok(emitted.includes('hooks'))
    const child = entry.config.find((item) => item.id === 'hook')
    assert.equal(child.config.pluginData, dataDir, 'the hook child carries the data directory')
    assert.deepEqual(
      child.config.hooks.map((hook) => hook.event),
      ['SessionStart', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'],
    )
    assert.deepEqual(skipped, [])
    assert.deepEqual(refused, [])
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test(
  'the hook runs on a real call and its context reaches the result',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const ir = readClaudePlugin(fixture, { source: 'plugin-dir:fixtures/claude-hooks-mcp' })
    const gated = gateAll(ir)
    const { entry } = emitPlugin(gated.ir, {
      materializers,
      sdkRoot: harness.modulesDir,
      trusted: gated.decision.allowed,
    })
    const probe = await probeWithDsh({
      harnessDir: harness.harnessDir,
      entry,
      behavior: { tool: 'Write', arguments: { file_path: '/tmp/x.txt', content: 'hi' } },
      timeoutMs: 10_000,
    })

    assert.ok(probe.behavior, 'the probe produced an observation')
    assert.equal(probe.behavior.isError, false, probe.behavior.text)
    assert.match(probe.behavior.text, /anyplugin-hook: PostToolUse fired/)
  },
)
