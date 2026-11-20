// Codex / Agent Plugins dialect: the second dialect is only real if a portable
// plugin reaches DSH's own loader. This test reads the hand-authored fixture
// with `readCodexPlugin`, emits it as data, boots the fetched harness, and
// diffs the observed inventory against a golden that was *not* observed from
// an upstream CLI (there is no offline `codex plugin details`).
//
// The golden is therefore a declaration derived from the 1.0.0 schemas; the
// DSH side is the observation. The test says which side is which so a future
// reader cannot mistake the golden for a capture.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { PORTABLE_MCP_SCHEMA, PORTABLE_PLUGIN_SCHEMA, readCodexPlugin } from '../../dsh-anyplugin-dialect-codex/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { summarizeIr, validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { diffInventories } from '../src/inventory.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'
import { probeWithDsh } from '../src/oracles/dsh.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = join(repoRoot, 'fixtures', 'codex-portable')
const harness = resolveHarness()
const materializers = {
  skill: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href,
  mcp: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-mcp', 'src', 'index.ts')).href,
}
const golden = JSON.parse(readFileSync(join(fixtureDir, '.inventory', `dsh-${harness.version}.json`), 'utf8'))

test('the dialect reads portable skills without inventing an envelope', () => {
  const ir = readCodexPlugin(fixtureDir, { source: 'plugin-dir:fixtures/codex-portable' })
  assert.deepEqual(validateIr(ir), [])
  assert.equal(ir.plugin.name, 'codex-portable')
  assert.deepEqual(ir.pin, { tool: 'agent-plugins', version: '1.0.0' })
  assert.deepEqual(
    ir.skills.map((skill) => [skill.name, skill.origin]),
    [
      ['codex-root', 'root-skill'],
      ['portable-skill', 'skills-dir'],
    ],
  )
  assert.ok(ir.skills.every((skill) => skill.annotation.fidelity === 'equivalent'))
  assert.ok(ir.skills.every((skill) => /no offline oracle/.test(skill.annotation.reason)))
})

test('portable mcp.json is read with its currency: mcpServers and a typed server', () => {
  const ir = readCodexPlugin(fixtureDir)
  assert.equal(ir.mcpServers.length, 1)
  const [server] = ir.mcpServers
  assert.equal(server.name, 'probe')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.command, 'node')
  assert.equal(server.toolNamePrefix, 'mcp__probe__')
  assert.equal(server.args?.[0], `${fixtureDir}/probe-server.mjs`)
  assert.ok(!server.args?.some((arg) => arg.includes('${')), 'no unexpanded variable may reach the materializer')
  assert.equal(server.cwd, fixtureDir)
  assert.equal(server.annotation.fidelity, 'equivalent')
})

test('a Codex server whose shortest tool would exceed 64 characters is refused with the arithmetic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-codex-budget-'))
  const name = 's'.repeat(57)
  try {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'codex-budget',
        version: '1.0.0',
      }),
    )
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { [name]: { type: 'stdio', command: 'node', args: ['./server.mjs'] } },
      }),
    )
    const ir = readCodexPlugin(dir)
    assert.equal(ir.mcpServers.length, 0)
    const row = ir.unsupported.find((entry) => entry.surface === 'mcpServers')
    assert.equal(row?.name, name)
    assert.match(row?.annotation.reason ?? '', /65 characters/)
    assert.match(row?.annotation.reason ?? '', /64-character limit/)
    assert.match(row?.annotation.reason ?? '', /refused rather than truncated/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempPlugin(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writePortableManifest(dir, manifest = {}) {
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      $schema: PORTABLE_PLUGIN_SCHEMA,
      name: 'codex-test',
      version: '1.0.0',
      ...manifest,
    }),
  )
}

function writePortableMcp(dir, servers, file = 'mcp.json') {
  writeFileSync(
    join(dir, file),
    JSON.stringify({
      $schema: PORTABLE_MCP_SCHEMA,
      mcpServers: servers,
    }),
  )
}

test('every equivalent hook event states its own decision-channel limit', () => {
  const dir = tempPlugin('anyplugin-codex-hook-reasons-')
  const events = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop']
  try {
    writePortableManifest(dir, { extensions: { 'com.openai': { hooks: './events.json' } } })
    writeFileSync(
      join(dir, 'events.json'),
      JSON.stringify({
        hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: 'command', command: './hook.sh' }] }]])),
      }),
    )
    const ir = readCodexPlugin(dir)
    assert.equal(ir.hooks.length, 7)
    const byEvent = new Map(ir.hooks.map((hook) => [hook.event, hook]))
    assert.match(byEvent.get('PreToolUse')?.annotation.reason ?? '', /continue:false/)
    assert.match(byEvent.get('PostToolUse')?.annotation.reason ?? '', /cannot undo the call/)
    assert.match(byEvent.get('SessionStart')?.annotation.reason ?? '', /additionalContext.*reported with a warning, not delivered/)
    assert.match(byEvent.get('Stop')?.annotation.reason ?? '', /cannot continue a turn/)
    assert.match(byEvent.get('SessionEnd')?.annotation.reason ?? '', /advisory/)
    assert.match(byEvent.get('SubagentStart')?.annotation.reason ?? '', /cannot stop the child/)
    assert.match(byEvent.get('SubagentStop')?.annotation.reason ?? '', /cannot continue a child/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stdio command that escapes the root is refused, not spawned', () => {
  const dir = tempPlugin('anyplugin-codex-command-escape-')
  try {
    writePortableManifest(dir)
    writePortableMcp(dir, { bad: { type: 'stdio', command: '../bin/server' } })
    const ir = readCodexPlugin(dir)
    assert.equal(ir.mcpServers.length, 0)
    const row = ir.unsupported.find((entry) => entry.name === 'bad')
    assert.match(row?.annotation.reason ?? '', /bare executable token|inside the plugin root/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cwd that escapes after PLUGIN_ROOT expansion is refused', () => {
  const dir = tempPlugin('anyplugin-codex-cwd-root-')
  try {
    writePortableManifest(dir)
    writePortableMcp(dir, { bad: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/..' } })
    const ir = readCodexPlugin(dir)
    assert.equal(ir.mcpServers.length, 0)
    assert.match(ir.unsupported.find((entry) => entry.name === 'bad')?.annotation.reason ?? '', /must stay inside/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a ./.. cwd that escapes the root is refused', () => {
  const dir = tempPlugin('anyplugin-codex-cwd-dotdot-')
  try {
    writePortableManifest(dir)
    writePortableMcp(dir, { bad: { type: 'stdio', command: 'node', cwd: './../..' } })
    const ir = readCodexPlugin(dir)
    assert.equal(ir.mcpServers.length, 0)
    assert.match(ir.unsupported.find((entry) => entry.name === 'bad')?.annotation.reason ?? '', /must stay inside/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('portable http is schema-invalid; only .mcp.json may use it', () => {
  const portableDir = tempPlugin('anyplugin-codex-http-portable-')
  const compatDir = tempPlugin('anyplugin-codex-http-compat-')
  try {
    writePortableManifest(portableDir)
    writePortableMcp(portableDir, { remote: { type: 'http', url: 'https://example.com/mcp' } })
    const portable = readCodexPlugin(portableDir)
    assert.equal(portable.mcpServers.length, 0)
    assert.match(
      portable.unsupported.find((entry) => entry.name === 'remote')?.annotation.reason ?? '',
      /accepted only from \`.mcp.json\`/,
    )

    writePortableManifest(compatDir)
    writePortableMcp(compatDir, { remote: { type: 'http', url: 'https://example.com/mcp' } }, '.mcp.json')
    const compat = readCodexPlugin(compatDir)
    assert.equal(compat.mcpServers[0]?.transport, 'http')
    assert.match(compat.mcpServers[0]?.annotation.reason ?? '', /compatibility spelling/)
  } finally {
    rmSync(portableDir, { recursive: true, force: true })
    rmSync(compatDir, { recursive: true, force: true })
  }
})

test('the documented auth extension is recorded and not carried', () => {
  const dir = tempPlugin('anyplugin-codex-auth-')
  try {
    writePortableManifest(dir)
    writePortableMcp(dir, {
      probe: {
        type: 'stdio',
        command: 'node',
        extensions: { 'com.openai': { auth: { clientId: 'fixture' } } },
      },
    })
    const ir = readCodexPlugin(dir)
    assert.equal(ir.mcpServers.length, 1)
    assert.equal('extensions' in ir.mcpServers[0], false)
    assert.match(
      ir.unsupported.find((entry) => entry.name === 'probe.extensions.com.openai.auth')?.annotation.reason ?? '',
      /OAuth/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown server field gets its own unsupported row', () => {
  const dir = tempPlugin('anyplugin-codex-unknown-server-')
  try {
    writePortableManifest(dir)
    writePortableMcp(dir, { probe: { type: 'stdio', command: 'node', mystery: true } })
    const ir = readCodexPlugin(dir)
    assert.equal(ir.mcpServers.length, 1)
    assert.match(
      ir.unsupported.find((entry) => entry.name === 'probe.mystery')?.annotation.reason ?? '',
      /not part of the closed 1\.0\.0/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown extensions.com.openai keys get a row each', () => {
  const dir = tempPlugin('anyplugin-codex-extension-unknown-')
  try {
    writePortableManifest(dir, { extensions: { 'com.openai': { mystery: true, another: 'value' } } })
    const ir = readCodexPlugin(dir)
    assert.ok(ir.pending.some((entry) => entry.name === 'com.openai.mystery'))
    assert.ok(ir.pending.some((entry) => entry.name === 'com.openai.another'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed extensions.com.openai is recorded and does not resurrect the overlay', () => {
  const dir = tempPlugin('anyplugin-codex-extension-malformed-')
  try {
    writePortableManifest(dir, { extensions: { 'com.openai': 'not-an-object' } })
    mkdirSync(join(dir, '.codex-plugin'), { recursive: true })
    writeFileSync(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ hooks: './overlay-hooks.json' }))
    writeFileSync(
      join(dir, 'overlay-hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: './hook.sh' }] }] } }),
    )
    const ir = readCodexPlugin(dir)
    assert.equal(ir.hooks.length, 0)
    assert.ok(ir.unsupported.some((entry) => entry.name === 'extensions.com.openai'))
    assert.ok(ir.unsupported.some((entry) => entry.name === '.codex-plugin/plugin.json#hooks'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit hook path without ./ is refused', () => {
  const dir = tempPlugin('anyplugin-codex-hook-path-')
  try {
    writePortableManifest(dir, { extensions: { 'com.openai': { hooks: 'events.json' } } })
    writeFileSync(join(dir, 'events.json'), JSON.stringify({ hooks: {} }))
    const ir = readCodexPlugin(dir)
    assert.equal(ir.hooks.length, 0)
    assert.match(ir.unsupported.find((entry) => entry.name === 'events.json')?.annotation.reason ?? '', /must start with/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing schema and invalid name are recorded as fatal-but-diagnostic', () => {
  const dir = tempPlugin('anyplugin-codex-manifest-invalid-')
  try {
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'Bad_Name', version: '1.0.0' }))
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: still-read
description: diagnostic skill
---
body
`,
    )
    const ir = readCodexPlugin(dir)
    assert.ok(ir.skills.some((skill) => skill.name === 'still-read'))
    assert.match(ir.unsupported.find((entry) => entry.name === '$schema')?.annotation.reason ?? '', /fatal/)
    assert.match(ir.unsupported.find((entry) => entry.name === 'name')?.annotation.reason ?? '', /fatal/)
    assert.match(ir.plugin.source, /^codex:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the manifest value replaces default hook discovery and overlay settings', () => {
  const ir = readCodexPlugin(fixtureDir)
  // Only the explicit codex-hooks.json events; hooks/hooks.json declares Stop
  // and must not appear.
  assert.deepEqual(ir.hooks.map((hook) => hook.event), ['PreToolUse', 'SessionStart', 'Interrupt'])
  assert.ok(!ir.hooks.some((hook) => hook.event === 'Stop'))
  const pre = ir.hooks.find((hook) => hook.event === 'PreToolUse')
  assert.equal(pre?.annotation.fidelity, 'equivalent')
  assert.equal(pre?.command, '${CLAUDE_PLUGIN_ROOT}/scripts/guard.sh')
  assert.equal(pre?.timeout, 5)
  assert.match(pre?.annotation.reason ?? '', /tools\/pre-execute/)
  assert.match(pre?.annotation.reason ?? '', /CLAUDE_PLUGIN_ROOT/)
  const start = ir.hooks.find((hook) => hook.event === 'SessionStart')
  assert.equal(start?.timeout, 600, 'Codex defaults an undeclared timeout to 600s, not DSH 60s')
  assert.match(start?.annotation.reason ?? '', /600s default/)
  const interrupt = ir.hooks.find((hook) => hook.event === 'Interrupt')
  assert.equal(interrupt?.annotation.fidelity, 'planned')
  assert.match(interrupt?.annotation.reason ?? '', /`Interrupt`/)
  assert.equal(interrupt?.matcher, undefined, 'Codex ignores matcher on Interrupt; it must not become a filter')
  assert.equal(interrupt?.timeout, 1)
  // The shadowed default and the shadowed overlay keys are visible, not silent.
  assert.ok(ir.unsupported.some((row) => row.name === 'hooks/hooks.json'))
  assert.ok(ir.unsupported.some((row) => row.name === '.codex-plugin/plugin.json#hooks'))
  assert.ok(ir.unsupported.some((row) => row.name === '.codex-plugin/plugin.json#interface'))
  // Extension-only surfaces are recorded with a reason, never guessed at.
  assert.ok(ir.pending.some((row) => row.surface === 'apps'))
  assert.ok(ir.pending.some((row) => row.surface === 'onboardingSkill'))
  assert.ok(ir.unsupported.some((row) => row.surface === 'interface'))
  assert.ok(ir.unsupported.some((row) => row.surface === 'assets'))
})

test('the report accounts for every declared surface with a reason', () => {
  const ir = readCodexPlugin(fixtureDir)
  const report = summarizeIr(ir)
  assert.equal(report.counts.unsupported, 5)
  assert.equal(report.counts.planned, 3)
  assert.ok(report.entries.every((entry) => entry.reason.trim().length > 0))
  assert.equal(report.totals.declared, 13)
})

test('a hook command that needs PLUGIN_DATA is planned, not promised', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-codex-data-'))
  try {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'codex-data-hook',
        version: '1.0.0',
        extensions: { 'com.openai': { hooks: './codex-hooks.json' } },
      }),
    )
    writeFileSync(
      join(dir, 'codex-hooks.json'),
      JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: '${PLUGIN_DATA}/cleanup.sh' }] }] },
      }),
    )
    const ir = readCodexPlugin(dir)
    const hook = ir.hooks.find((entry) => entry.event === 'SessionEnd')
    assert.equal(hook?.annotation.fidelity, 'planned')
    assert.match(hook?.annotation.reason ?? '', /PLUGIN_DATA/)
    assert.equal(hook?.timeout, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the emitter carries Codex tool names as data, not as a materializer guess', () => {
  const ir = readCodexPlugin(fixtureDir)
  const { entry, emitted } = emitPlugin(ir, { materializers, sdkRoot: harness?.modulesDir })
  assert.ok(entry)
  assert.ok(emitted.includes('skills'))
  assert.ok(emitted.includes('mcpServers'))
  const mcp = entry.config.find((item) => item.id === 'mcp')
  assert.ok(mcp, 'mcp child expected')
  assert.equal(mcp.config.servers[0].toolNamePrefix, 'mcp__probe__')
})

test(
  'DSH materializes the portable skills and the Codex-named MCP tool with 0 rows differing',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const ir = readCodexPlugin(fixtureDir)
    const { entry } = emitPlugin(ir, { materializers, sdkRoot: harness.modulesDir })
    assert.ok(entry)
    const { inventory, tools } = await probeWithDsh({ harnessDir: harness.harnessDir, entry })

    assert.ok(
      tools.includes('mcp__probe__create_issue'),
      `expected Codex's ` + '`mcp__<server>__<tool>`' + ` name, got ${JSON.stringify(tools)}`,
    )
    assert.ok(!tools.some((name) => name.startsWith('mcp__plugin_')), 'the Codex dialect must not inherit the plugin_ prefix')
    for (const name of tools) assert.doesNotMatch(name, /_[0-9a-f]{12}$/)

    const report = diffInventories(golden, inventory, { allowPinMismatch: true })
    assert.equal(report.summary.missing, 0, JSON.stringify(report.rows))
    assert.equal(report.summary.extra, 0, JSON.stringify(report.rows))
    assert.equal(report.summary.changed, 0, JSON.stringify(report.rows))
    assert.equal(report.summary.match, 3, JSON.stringify(report.rows))
    assert.deepEqual(
      report.rows.map((row) => `${row.surface}:${row.name}:${row.status}`),
      ['mcpServers:probe:match', 'skills:codex-root:match', 'skills:portable-skill:match'],
    )
  },
)
