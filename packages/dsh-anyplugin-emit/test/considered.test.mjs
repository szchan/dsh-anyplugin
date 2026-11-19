// `considered` is the report's only evidence that emit looked at an IR entry.
// It must name refused entries (they also appear in `skipped`) and must name
// every surface emit can place (agents included since S10) while staying silent
// about surfaces with no materializer (output-styles, …), or the report cannot
// tell "refused" apart from "never seen".

import assert from 'node:assert/strict'
import test from 'node:test'

import { emitPlugin } from '../src/index.ts'
import { buildTransplantReport, formatTransplantReport } from '../../dsh-anyplugin-conformance/src/report.ts'
import { classify, emptyGrants, gate, grant, pluginIdentity } from '../../dsh-anyplugin-trust/src/index.ts'

const annotation = (fidelity, reason) => ({ fidelity, reason })

function buildIr() {
  return {
    plugin: { name: 'considered-fixture', root: '/tmp/considered-fixture' },
    pin: { tool: 'claude-code', version: '2.1.322' },
    skills: [
      {
        name: 'good',
        description: 'A skill emit can place.',
        content: 'Say hello.',
        invocation: 'auto',
        annotation: annotation('equivalent', 'Body and envelope are carried.'),
        origin: 'skills-dir',
      },
      {
        name: 'refused',
        description: 'A skill emit refuses.',
        content: 'Say no.',
        invocation: 'auto',
        annotation: annotation('planned', 'No seam yet.'),
        origin: 'skills-dir',
      },
    ],
    agents: [
      {
        name: 'reviewer',
        description: 'Not an emit surface.',
        annotation: annotation('planned', 'Body and description are not carried on a planned face.'),
      },
    ],
    mcpServers: [
      {
        name: 'probe',
        transport: { type: 'stdio' },
        annotation: annotation('equivalent', 'Registered byte for byte.'),
      },
      {
        name: 'off',
        transport: { type: 'stdio' },
        annotation: annotation('planned', 'No seam yet.'),
      },
    ],
    hooks: [
      {
        event: 'PostToolUse',
        index: 0,
        command: 'echo ok',
        annotation: annotation('equivalent', 'Rides the tool waterfall.'),
      },
      {
        event: 'Stop',
        index: 1,
        command: 'echo no',
        annotation: annotation('planned', 'No seam yet.'),
      },
    ],
    pending: [
      {
        surface: 'output-styles',
        name: 'terse',
        sourcePath: 'output-styles/terse.md',
        annotation: annotation('planned', 'No seam yet.'),
      },
    ],
    unsupported: [
      {
        surface: 'agents',
        name: 'legacy-agent',
        sourcePath: 'agents/legacy-agent.md',
        annotation: annotation('unsupported', 'Not loaded by the host.'),
      },
    ],
  }
}

function gateAll(ir) {
  let grants = emptyGrants()
  for (const row of classify(ir)) {
    grants = grant(grants, { plugin: pluginIdentity(ir), ...row }, { scope: 'user' })
  }
  return gate(ir, grants)
}

test('considered names the refused entries too', () => {
  const gated = gateAll(buildIr())
  const result = emitPlugin(gated.ir, {
    materializers: { skill: 'skill-materializer', mcp: 'mcp-materializer', hooks: 'hook-materializer' },
    trusted: gated.decision.allowed,
  })

  assert.deepEqual(result.considered, [
    'skills/good',
    'skills/refused',
    'agents/reviewer',
    'mcpServers/probe',
    'mcpServers/off',
    'hooks/PostToolUse#0',
    'hooks/Stop#1',
  ])
  assert.deepEqual(result.skipped, ['skills/refused', 'agents/reviewer', 'mcpServers/off', 'hooks/Stop#1'])
  assert.deepEqual(result.emitted, ['skills', 'mcpServers', 'hooks'])
  assert.deepEqual(result.refused, [])
})

test('exec is default-off: an authorized seam still refuses an untrusted hook', () => {
  const gated = gateAll(buildIr())
  const result = emitPlugin(gated.ir, {
    materializers: { skill: 'skill-materializer', mcp: 'mcp-materializer', hooks: 'hook-materializer' },
  })

  assert.deepEqual(result.emitted, ['skills', 'mcpServers'])
  assert.deepEqual(result.refused, ['hooks/PostToolUse#0'])
  assert.deepEqual(result.skipped, ['skills/refused', 'agents/reviewer', 'mcpServers/off', 'hooks/Stop#1'])
  assert.ok(result.entry)
  assert.ok(!result.entry.config.some((child) => child.id === 'hook'))
})

test('considered names every placeable surface and no materializer-less one', () => {
  const result = emitPlugin(buildIr(), { materializers: { skill: 'skill-materializer' } })

  assert.deepEqual(result.considered, [
    'skills/good',
    'skills/refused',
    'agents/reviewer',
    'mcpServers/probe',
    'mcpServers/off',
    'hooks/PostToolUse#0',
    'hooks/Stop#1',
  ])
  assert.ok(result.considered.includes('agents/reviewer'))
  assert.ok(!result.considered.some((entry) => entry.startsWith('output-styles/')))
})

test('a missing materializer refuses every considered entry on its surface', () => {
  const materializers = { skill: 'skill-materializer' }
  const ir = {
    ir: 'dsh-anyplugin/ir@1',
    plugin: { name: 'missing-hooks', root: '/tmp/missing-hooks' },
    pin: { tool: 'claude-code', version: '2.1.322' },
    skills: [
      {
        name: 'good',
        description: 'A skill emit can place.',
        content: 'Say hello.',
        invocation: 'auto',
        annotation: annotation('equivalent', 'Body and envelope are carried.'),
        origin: 'skills-dir',
      },
    ],
    agents: [],
    mcpServers: [],
    hooks: [
      {
        event: 'PostToolUse',
        index: 0,
        command: 'echo ok',
        annotation: annotation('equivalent', 'Rides the tool waterfall.'),
      },
      {
        event: 'Stop',
        index: 1,
        command: 'echo no',
        annotation: annotation('planned', 'No seam yet.'),
      },
    ],
    pending: [],
    unsupported: [],
  }

  const result = emitPlugin(ir, { materializers })

  assert.deepEqual(result.considered, ['skills/good', 'hooks/PostToolUse#0', 'hooks/Stop#1'])
  assert.deepEqual(result.skipped, ['hooks/PostToolUse#0', 'hooks/Stop#1'])
  assert.deepEqual(result.emitted, ['skills'])
  assert.ok(result.entry)
  assert.deepEqual(result.entry.config.map((child) => child.id), ['skill'])

  // The report must not call a hook carried when no hook child was generated.
  // Grant the hook first: here the question is materializer absence, not trust.
  let grants = emptyGrants()
  for (const row of classify(ir)) {
    grants = grant(grants, { plugin: pluginIdentity(ir), ...row }, { scope: 'user' })
  }
  const report = buildTransplantReport(ir, { materializers, grants })
  assert.deepEqual(
    report.components.map((component) => [component.surface, component.name, component.carried]),
    [
      ['skills', 'good', true],
      ['hooks', 'PostToolUse#0', false],
      ['hooks', 'Stop#1', false],
    ],
  )
  assert.deepEqual(report.totals, { declared: 3, emitted: 1, refused: 0, skipped: 2 })
  const text = formatTransplantReport(report)
  assert.match(text, /^hooks\/PostToolUse#0 {2}class=equivalent {2}carry=skipped$/m)
  assert.match(text, /^hooks\/Stop#1 {2}class=planned {2}carry=skipped$/m)
  assert.match(text, /^validation: PASS$/m)
})
