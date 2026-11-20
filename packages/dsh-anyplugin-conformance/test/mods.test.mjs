// The mod arm, end to end (#39): a loaded mod and a classic hook share one
// real turn's PreToolUse chain, and the mod's rewrite is what the tool receives.
//
// The assertions are behavioural: a mod whose registrations are adapted but
// never seated would still produce a clean kernel-bridge trace; only a real
// agent turn with a real tool call proves the seat. The second root session
// proves the seat is per-agent, and the trace file proves load-before-turn
// ordering because apply settles before the loader reports success.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { hashManifest } from '../../dsh-anyplugin-trust/src/index.ts'
import { probeLifecycleWithDsh } from '../src/oracles/dsh.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harness = resolveHarness()
const materializerUrl = (pkg) => pathToFileURL(join(repoRoot, 'packages', pkg, 'src', 'index.ts')).href
const fixture = join(repoRoot, 'fixtures', 'mods', 'synthetic')
const skip = harness ? false : harnessSkipReason()

const commandHook = {
  event: 'PreToolUse',
  index: 0,
  command: 'cat >> "$CLAUDE_PLUGIN_DATA/classic-pre.jsonl"',
}

const sessionStartHook = {
  event: 'SessionStart',
  index: 0,
  command: 'cat >/dev/null',
}

function pinned(hook) {
  const manifest = {
    mode: 'command',
    invocation: hook.command,
    command: hook.command,
    files: [],
  }
  return {
    ...hook,
    artifactHash: hashManifest(manifest),
    artifactMode: 'command',
    artifact: manifest,
  }
}

function modsEntry(dataDir, traceFile) {
  return {
    id: 'anyplugin.mods-seat',
    name: '@deepseek-ai/cordis-plugin-group',
    group: true,
    config: [
      {
        id: 'hook',
        name: materializerUrl('dsh-anyplugin-materialize-hook'),
        config: {
          pluginRoot: fixture,
          pluginData: dataDir,
          plugin: 'synthetic',
          mods: [{ entry: 'seat.ts' }],
          hooks: [pinned(commandHook), pinned(sessionStartHook)],
          traceFile,
        },
      },
    ],
  }
}

function bashTool(calls) {
  return {
    name: 'Bash',
    description: 'Run a shell command and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async (args) => {
      calls.push(args)
      return 'ran'
    },
  }
}

function readTrace(traceFile) {
  return readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

test('a mod and a classic hook share the turn; the rewrite executes per agent', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      secondAgent: true,
      timeoutMs: 15_000,
    })

    const trace = readTrace(traceFile)
    const starts = trace.filter((record) => record.event === 'session.start')
    assert.equal(starts.length, 1, 'session.start fires once per load')
    assert.deepEqual(starts[0].sources, ['synthetic/seat.ts#0'])
    assert.equal(starts[0].trace.length, 1, 'one registration, one trace step')
    assert.equal(starts[0].trace[0].status, 'ran', JSON.stringify(starts[0]))
    assert.equal(trace.indexOf(starts[0]), 0, 'session.start is the first chain, before any turn')

    // The tool actually ran twice, once per root agent, and each call received
    // the rewrite computed from its own agent's messages.
    assert.deepEqual(calls, [{ command: 'ls-first' }, { command: 'ls-second' }])

    // The classic arm is in the same fan-out chain and therefore receives the
    // mod's rewritten event: its stdin payload carries the same commands.
    const classicPayloads = readFileSync(join(dataDir, 'classic-pre.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      classicPayloads.map((payload) => payload.tool_input.command),
      ['ls-first', 'ls-second'],
    )

    const pre = trace.filter((record) => record.event === 'PreToolUse')
    assert.equal(pre.length, 2, 'one PreToolUse chain per root agent')
    for (const record of pre) {
      assert.deepEqual(record.sources, ['synthetic/seat.ts#1', 'PreToolUse#0'])
      assert.deepEqual(record.trace.map((step) => step.status), ['ran', 'ran'])
    }

    // Classic SessionStart is an agent event, not the loader point: it fires
    // once per root and never for the child, after the load-time session.start.
    const classicStarts = trace.filter((record) => record.event === 'SessionStart')
    assert.equal(classicStarts.length, 2)
    for (const record of classicStarts) assert.deepEqual(record.sources, ['SessionStart#0'])
    assert.ok(trace.indexOf(classicStarts[0]) > trace.indexOf(starts[0]))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a reload runs session.start again with one registration each', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-reload-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      reload: true,
      timeoutMs: 15_000,
    })

    const starts = readTrace(traceFile).filter((record) => record.event === 'session.start')
    assert.equal(starts.length, 2, 'a fresh load fires session.start again')
    for (const record of starts) {
      assert.deepEqual(record.sources, ['synthetic/seat.ts#0'])
      assert.equal(record.trace.length, 1, 'the reload did not double the registration')
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
