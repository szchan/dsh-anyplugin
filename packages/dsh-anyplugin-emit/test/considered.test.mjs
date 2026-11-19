// `considered` is the report's only evidence that emit looked at an IR entry.
// It must name refused entries (they also appear in `skipped`) and must not name
// surfaces emit never places (agents, output-styles, …), or the report cannot
// tell "refused" apart from "never seen".

import assert from 'node:assert/strict'
import test from 'node:test'

import { emitPlugin } from '../src/index.ts'

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
        annotation: annotation('planned', 'No catalog seam.'),
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

test('considered names the refused entries too', () => {
  const result = emitPlugin(buildIr(), {
    materializers: { skill: 'skill-materializer', mcp: 'mcp-materializer', hooks: 'hook-materializer' },
  })

  assert.deepEqual(result.considered, [
    'skills/good',
    'skills/refused',
    'mcpServers/probe',
    'mcpServers/off',
    'hooks/PostToolUse#0',
    'hooks/Stop#1',
  ])
  assert.deepEqual(result.skipped, ['skills/refused', 'mcpServers/off', 'hooks/Stop#1'])
  assert.deepEqual(result.emitted, ['skills', 'mcpServers', 'hooks'])
})

test('considered does not name surfaces emit never places', () => {
  const result = emitPlugin(buildIr(), { materializers: { skill: 'skill-materializer' } })

  assert.deepEqual(result.considered, [
    'skills/good',
    'skills/refused',
    'mcpServers/probe',
    'mcpServers/off',
    'hooks/PostToolUse#0',
    'hooks/Stop#1',
  ])
  assert.ok(!result.considered.some((entry) => entry.startsWith('agents/')))
  assert.ok(!result.considered.some((entry) => entry.startsWith('output-styles/')))
})
