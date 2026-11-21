// Issue #101 end to end: a codex lock row goes through the install compiler
// (dialect registry → IR → emitPlugin) and the result runs in the pinned DSH
// oracle. The expected side is hand-authored: there is no offline
// `codex plugin details` equivalent, so the Agent Plugins 1.0.0 spec is the
// oracle (D33) and nothing in this path shells out to `claude`.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  AGENT_PLUGINS_PIN,
  PORTABLE_MCP_SCHEMA,
  PORTABLE_PLUGIN_SCHEMA,
  readCodexPlugin,
} from '../../dsh-anyplugin-dialect-codex/src/index.ts'
import { compileEntries, compileReport } from '../../dsh-anyplugin-install/src/index.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'
import { diffInventories } from '../src/inventory.ts'
import { lifecycleDataDir, probeWithDsh } from '../src/oracles/dsh.ts'
import { buildTransplantReport, formatTransplantReport } from '../src/report.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = join(repoRoot, 'fixtures', 'codex-portable')
const harness = resolveHarness()
const workspace = mkdtempSync(join(tmpdir(), 'anyplugin-codex-e2e-'))
const home = join(workspace, 'home')
mkdirSync(home, { recursive: true })
const materializers = {
  skill: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href,
  mcp: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-mcp', 'src', 'index.ts')).href,
}
const CODEX_PIN = `${AGENT_PLUGINS_PIN.tool}@${AGENT_PLUGINS_PIN.version}`
const goldenPath = join(fixtureDir, '.inventory', `codex@${AGENT_PLUGINS_PIN.version}.json`)

const installs = {
  schema: 'dsh-anyplugin/installs@1',
  plugins: [
    {
      dialect: 'codex',
      name: 'codex-portable',
      version: '1.0.0',
      root: fixtureDir,
      dataDir: join(workspace, 'data', 'codex-portable'),
      pin: CODEX_PIN,
    },
  ],
}
const enablements = {
  user: { plugins: { 'codex:codex-portable': { enabled: true, grants: [] } } },
}
const installed = (plugins) => ({ schema: 'dsh-anyplugin/installs@1', plugins })

// Nothing on the codex path may invoke the Claude CLI: the codex expected side
// is hand-authored, not borrowed from `claude plugin details`. Point CLAUDE_BIN
// at a decoy that fails loudly for this file. A regression that shells out
// through the documented resolver throws here instead of quietly passing.
const decoyDir = mkdtempSync(join(tmpdir(), 'anyplugin-codex-e2e-decoy-'))
const decoy = join(decoyDir, 'claude')
writeFileSync(decoy, '#!/bin/sh\necho "the codex path invoked claude" >&2\nexit 3\n')
chmodSync(decoy, 0o755)
const previousClaudeBin = process.env.CLAUDE_BIN
process.env.CLAUDE_BIN = decoy

test.after(() => {
  if (previousClaudeBin === undefined) delete process.env.CLAUDE_BIN
  else process.env.CLAUDE_BIN = previousClaudeBin
  rmSync(decoyDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
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

// A stdio MCP server whose two tools sit exactly on either side of the shared
// 64-character limit once the Codex prefix is composed.
const BUDGET_SERVER = String.raw`import { createInterface } from 'node:readline'
const TOOLS = [
  { name: 'ok', description: 'fits', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'long', description: 'over budget', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'budget', version: '1.0.0' } } })
  } else if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } })
  }
})
`

test('the codex report prints its own pin and classes, not the Claude pin', () => {
  const report = buildTransplantReport(readCodexPlugin(fixtureDir), { materializers })
  const text = formatTransplantReport(report)
  assert.equal(text.split('\n')[0], 'plugin: codex-portable  pin: agent-plugins@1.0.0')
  for (const row of [
    'skills/codex-root  class=equivalent  carry=emitted',
    'skills/portable-skill  class=equivalent  carry=emitted',
    'mcpServers/probe  class=equivalent  carry=emitted',
  ]) {
    assert.ok(text.includes(row), `missing report row: ${row}`)
  }
  assert.doesNotMatch(text, /claude-code@/, 'the codex report must not borrow the Claude pin')
  assert.match(text, /totals: 13 declared, 3 emitted, 2 refused, 8 skipped/)
  assert.match(text, /validation: PASS/)
})

test('the lifecycle probe finds the hook child by install-qualified id', () => {
  const dataDir = join(workspace, 'data', 'hook')
  const qualified = { id: 'anyplugin.codex~3acodex-portable', config: [{ id: 'anyplugin.codex~3acodex-portable#hook', config: { pluginData: dataDir } }] }
  assert.equal(lifecycleDataDir(qualified), dataDir)
  // Bare ids stay valid: the oracle also boots hand-built entries.
  assert.equal(lifecycleDataDir({ id: 'anyplugin.x', config: [{ id: 'hook', config: { pluginData: dataDir } }] }), dataDir)
  assert.throws(
    () => lifecycleDataDir({ id: 'anyplugin.x', config: [{ id: 'anyplugin.x#hook', config: {} }] }),
    /the hook child carries no pluginData directory/,
  )
})

test(
  'a codex lock record installs and runs in the pinned DSH oracle',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const entries = compileEntries(installs, {
      materializers,
      sdkRoot: harness.modulesDir,
      home,
      enablements,
    })
    assert.equal(entries.length, 1, 'one group per installed plugin')
    assert.equal(entries[0].id, 'anyplugin.codex~3acodex-portable')
    assert.deepEqual(entries[0].config.map((child) => child.id), [
      'anyplugin.codex~3acodex-portable#skill',
      'anyplugin.codex~3acodex-portable#mcp',
    ])

    const { inventory, tools } = await probeWithDsh({ harnessDir: harness.harnessDir, entry: entries[0] })

    assert.ok(
      tools.includes('mcp__probe__create_issue'),
      `expected Codex's mcp__<server>__<tool> name, got ${JSON.stringify(tools)}`,
    )
    assert.ok(!tools.some((name) => name.startsWith('mcp__plugin_')), 'no plugin_ segment on the codex path')
    for (const name of tools) assert.doesNotMatch(name, /_[0-9a-f]{12}$/)
    assert.deepEqual(
      inventory.components.filter((component) => component.surface === 'skills').map((component) => component.name),
      ['codex-root', 'portable-skill'],
    )

    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
    assert.equal(golden.plugin.source, 'hand-authored: the portable spec is the oracle (D33)')
    assert.deepEqual(golden.pin, { tool: AGENT_PLUGINS_PIN.tool, version: AGENT_PLUGINS_PIN.version })
    assert.ok(golden.notes.some((note) => /^Hand-authored, not observed/.test(note)))
    for (const component of golden.components) {
      assert.match(component.details?.note ?? '', /^hand-authored: /, `${component.surface}:${component.name} provenance`)
    }

    const report = diffInventories(golden, inventory, { allowPinMismatch: true })
    assert.deepEqual(
      report.rows.map((row) => `${row.surface}:${row.name}:${row.status}`),
      ['mcpServers:probe:match', 'skills:codex-root:match', 'skills:portable-skill:match'],
      JSON.stringify(report.rows),
    )
    assert.equal(report.summary.missing, 0, JSON.stringify(report.rows))
    assert.equal(report.summary.extra, 0, JSON.stringify(report.rows))
    assert.equal(report.summary.changed, 0, JSON.stringify(report.rows))
  },
)

test('an over-budget Codex MCP server is refused with arithmetic, not truncated into the entry', () => {
  const dir = tempPlugin('anyplugin-codex-e2e-budget-')
  const name = 's'.repeat(57)
  try {
    writePortableManifest(dir, { name: 'codex-budget' })
    mkdirSync(join(dir, 'skills', 'one'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: one skill\n---\nbody\n')
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: PORTABLE_MCP_SCHEMA,
        mcpServers: { [name]: { type: 'stdio', command: 'node', args: ['./server.mjs'] } },
      }),
    )

    const ir = readCodexPlugin(dir)
    assert.equal(ir.mcpServers.length, 0, 'a refused server is not carried')
    const refusal = ir.unsupported.find((entry) => entry.surface === 'mcpServers')
    assert.equal(refusal?.name, name)
    assert.match(refusal?.annotation.reason ?? '', /65 characters/)
    assert.match(refusal?.annotation.reason ?? '', /refused rather than truncated/)

    const entries = compileEntries(
      installed([
        {
          dialect: 'codex',
          name: 'codex-budget',
          version: '1.0.0',
          root: dir,
          dataDir: join(workspace, 'data', 'codex-budget'),
          pin: CODEX_PIN,
        },
      ]),
      { materializers, home, enablements: { user: { plugins: { 'codex:codex-budget': { enabled: true, grants: [] } } } } },
    )
    assert.deepEqual(entries[0].config.map((child) => child.id), ['anyplugin.codex~3acodex-budget#skill'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'a Codex tool over the shared budget is skipped, while its server row survives',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const dir = tempPlugin('anyplugin-codex-e2e-tool-budget-')
    const serverName = 's'.repeat(55)
    const prefix = `mcp__${serverName}__`
    try {
      writePortableManifest(dir, { name: 'codex-tool-budget' })
      writeFileSync(join(dir, 'tool-server.mjs'), BUDGET_SERVER)
      writeFileSync(
        join(dir, 'mcp.json'),
        JSON.stringify({
          $schema: PORTABLE_MCP_SCHEMA,
          mcpServers: {
            [serverName]: { type: 'stdio', command: 'node', args: [join(dir, 'tool-server.mjs')] },
          },
        }),
      )

      // The arithmetic the test is pinning: 5 (`mcp__`) + 55 + 2 (`__`) = 62,
      // so `ok` is exactly 64 and `long` is 66.
      assert.equal(prefix.length, 62)
      assert.equal(`${prefix}ok`.length, 64)
      assert.equal(`${prefix}long`.length, 66)

      const entries = compileEntries(
        installed([
          {
            dialect: 'codex',
            name: 'codex-tool-budget',
            version: '1.0.0',
            root: dir,
            dataDir: join(workspace, 'data', 'codex-tool-budget'),
            pin: CODEX_PIN,
          },
        ]),
        {
          materializers,
          sdkRoot: harness.modulesDir,
          home,
          enablements: { user: { plugins: { 'codex:codex-tool-budget': { enabled: true, grants: [] } } } },
        },
      )
      assert.deepEqual(entries[0].config.map((child) => child.id), ['anyplugin.codex~3acodex-tool-budget#mcp'])

      const { inventory, tools } = await probeWithDsh({ harnessDir: harness.harnessDir, entry: entries[0] })
      assert.ok(tools.includes(`${prefix}ok`), `the 64-character tool registers, got ${JSON.stringify(tools)}`)
      assert.ok(!tools.includes(`${prefix}long`), 'the 66-character tool is skipped, not renamed')
      assert.deepEqual(
        tools.filter((name) => name.startsWith('mcp__')).sort(),
        [`${prefix}ok`],
        'no truncation, rename or hash suffix on the over-budget tool',
      )
      assert.ok(
        inventory.components.some((component) => component.surface === 'mcpServers' && component.name === serverName),
        'the server row survives even though one of its tools could not be presented',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('a codex manifest that declares another name is a typed compile problem', () => {
  const dir = tempPlugin('anyplugin-codex-e2e-name-')
  try {
    writePortableManifest(dir, { name: 'declared-other' })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: root\ndescription: root skill\n---\nbody\n')

    const report = compileReport(
      installed([
        {
          dialect: 'codex',
          name: 'codex-bad-manifest',
          version: '1.0.0',
          root: dir,
          dataDir: join(workspace, 'data', 'codex-bad-manifest'),
          pin: CODEX_PIN,
        },
      ]),
      {
        materializers,
        home,
        enablements: { user: { plugins: { 'codex:codex-bad-manifest': { enabled: true, grants: [] } } } },
      },
    )
    assert.deepEqual(report.entries, [])
    assert.equal(report.problems.length, 1)
    assert.match(
      report.problems[0].reason,
      /plugin "codex:codex-bad-manifest" claims name "codex-bad-manifest" but .* declares "declared-other"/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
