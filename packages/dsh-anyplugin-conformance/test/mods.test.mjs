// The mod arm, end to end (#39): a loaded mod and a classic hook share one
// real turn's PreToolUse chain, and the mod's rewrite is what the tool receives.
//
// The assertions are behavioural: a mod whose registrations are adapted but
// never seated would still produce a clean kernel-bridge trace; only a real
// agent turn with a real tool call proves the seat. The second root session
// proves the seat is per-agent, and the trace file proves load-before-turn
// ordering because apply settles before the loader reports success.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { classicEvent, modRegistrationsToKernel } from '../../dsh-anyplugin-intercept/src/index.ts'
import { apply as applyMaterializer, applyToolInputRewrite } from '../../dsh-anyplugin-materialize-hook/src/index.ts'
import { createModBridge, loadMod } from '../../dsh-anyplugin-mod-host/src/index.ts'
import { DIFF_MOD_PIN } from '../../dsh-anyplugin-mod-host/src/pin.ts'
import { scanModSource } from '../../dsh-anyplugin-mod-scan/src/index.ts'
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

function modsEntry(dataDir, traceFile, overrides = {}) {
  const commands = overrides.commands ?? (harness === undefined
    ? []
    : [{
        id: 'commands',
        name: pathToFileURL(join(harness.harnessDir, 'dsh-commands', 'lib', 'index.js')).href,
      }])
  return {
    id: overrides.id ?? 'anyplugin.mods-seat',
    name: '@deepseek-ai/cordis-plugin-group',
    group: true,
    config: [
      ...commands,
      {
        id: 'hook',
        name: materializerUrl('dsh-anyplugin-materialize-hook'),
        config: {
          pluginRoot: overrides.pluginRoot ?? fixture,
          pluginData: dataDir,
          plugin: overrides.plugin ?? 'synthetic',
          mods: overrides.mods ?? [{ entry: 'seat.ts' }],
          hooks: overrides.hooks ?? [pinned(commandHook), pinned(sessionStartHook)],
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
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
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

function stored(dataDir) {
  return JSON.parse(readFileSync(join(dataDir, '.anyplugin-store.json'), 'utf8'))
}

// The 23 sites in `scanModSource` order. The one-line table is the contract:
// a served site says `ran`; a refusal names the stable code the mod sees.
const SYNTHETIC_LEDGER = [
  'clock.now:ran',
  'clock.after:ran',
  'clock.every:ran',
  'process.run:refused:ERR_MOD_HOST_EXEC_UNSUPPORTED',
  'fs.stat:ran',
  'fs.list:ran',
  'fs.read:ran',
  'store.get:ran',
  'store.set:ran',
  'settings.read:refused:ERR_MOD_HOST_SETTINGS_UNAVAILABLE',
  'env.get:ran',
  'session.messages:ran',
  'ui.invalidate:refused:ERR_MOD_HOST_UI_UNSUPPORTED',
  'ui.status:refused:ERR_MOD_HOST_UI_UNSUPPORTED',
  'ui.log:refused:ERR_MOD_HOST_UI_UNSUPPORTED',
  'ui.open:refused:ERR_MOD_HOST_UI_UNSUPPORTED',
  'ui.close:refused:ERR_MOD_HOST_UI_UNSUPPORTED',
  'command.register:ran',
  'session.id:ran',
  'session.usage:ran',
  'telemetry.mark:ran',
  'telemetry.log:ran',
  'ui.resolve:refused:ERR_MOD_HOST_UI_UNSUPPORTED',
]

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
    const firstChain = trace.findIndex((record) => typeof record.event === 'string')
    assert.equal(trace.indexOf(starts[0]), firstChain, 'session.start is the first chain, before any turn')

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

test('a live root is seated by apply and session.start reports the live cwd', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-live-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  let observed
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      preExistingRoot: true,
      onAgent: async (agent) => {
        agent.ctx.on('tools/pre-execute', async (exec, next) => {
          observed = exec.arguments
          return next()
        })
      },
      timeoutMs: 15_000,
    })

    const trace = readTrace(traceFile)
    const start = trace.find((record) => record.event === 'session.start')
    assert.ok(start, 'session.start fired during the load that found the root')
    assert.deepEqual(start.data, { cwd: dataDir }, 'session.start cwd is the live root cwd, not CLAUDE_PLUGIN_ROOT')
    assert.deepEqual(start.gaps, ['surface', 'isInteractive'])
    assert.equal('surface' in start.data, false)
    assert.equal('isInteractive' in start.data, false)
    const warning = trace.find(
      (record) => typeof record.warning === 'string' && /surface.*isInteractive/.test(record.warning),
    )
    assert.ok(warning, 'session.start reports the two unobserved fields as a warning')

    assert.deepEqual(calls, [{ command: 'ls-first' }])
    assert.deepEqual(observed, { command: 'ls-first' }, 'a later pre-execute listener sees the rewrite')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a reload re-seats a root that stays live', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-live-reload-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      reloadWhileLive: true,
      timeoutMs: 15_000,
    })

    assert.deepEqual(calls, [{ command: 'ls-first' }, { command: 'ls-second' }])
    const trace = readTrace(traceFile)
    assert.equal(trace.filter((record) => record.event === 'session.start').length, 2, 'each load fires session.start')
    const pre = trace.filter((record) => record.event === 'PreToolUse')
    assert.equal(pre.length, 2)
    for (const record of pre) assert.deepEqual(record.sources, ['synthetic/seat.ts#1', 'PreToolUse#0'])
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a classic command hook updatedInput follows the same chain rewrite', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-classic-rewrite-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  const updated = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls-classic' } },
  })
  const rewriteHook = {
    event: 'PreToolUse',
    index: 0,
    command: `cat > "$CLAUDE_PLUGIN_DATA/classic-rewrite.jsonl"; printf '%s\\n' '${updated}'`,
  }
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile, {
        hooks: [pinned(rewriteHook), pinned(sessionStartHook)],
      }),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      timeoutMs: 15_000,
    })

    assert.deepEqual(calls, [{ command: 'ls-classic' }])
    const seen = JSON.parse(readFileSync(join(dataDir, 'classic-rewrite.jsonl'), 'utf8'))
    assert.equal(seen.tool_input.command, 'ls-first', 'the classic arm saw the mod rewrite first')
    const pre = readTrace(traceFile).find((record) => record.event === 'PreToolUse')
    assert.deepEqual(pre.sources, ['synthetic/seat.ts#1', 'PreToolUse#0'])
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the rewrite guard refuses read-only, lossy, and missing tool input', () => {
  const original = classicEvent('PreToolUse', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    tool_input: { command: 'ls' },
  })
  const rewritten = (toolInput) =>
    classicEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_input: toolInput,
    })

  const noRewrite = { arguments: { command: 'ls' } }
  assert.deepEqual(applyToolInputRewrite(noRewrite, original, original), { applied: false })

  const readOnly = {}
  Object.defineProperty(readOnly, 'arguments', {
    value: { command: 'ls' },
    writable: false,
    configurable: true,
  })
  const readOnlyResult = applyToolInputRewrite(readOnly, rewritten({ command: 'ls-first' }), original)
  assert.equal(readOnlyResult.applied, false)
  assert.match(readOnlyResult.reason ?? '', /read-only/)
  assert.deepEqual(readOnly.arguments, { command: 'ls' })

  const lossy = applyToolInputRewrite(
    { arguments: { command: 'ls' } },
    rewritten({ command: 'ls-first', extra: undefined }),
    original,
  )
  assert.equal(lossy.applied, false)
  assert.match(lossy.reason ?? '', /lossless JSON/)

  const missing = applyToolInputRewrite({ arguments: { command: 'ls' } }, rewritten(undefined), original)
  assert.equal(missing.applied, false)
  assert.match(missing.reason ?? '', /no tool_input/)

  const exec = { arguments: { command: 'ls' } }
  const applied = applyToolInputRewrite(exec, rewritten({ command: 'ls-first', env: { A: '1' } }), original)
  assert.equal(applied.applied, true)
  assert.deepEqual(exec.arguments, { command: 'ls-first', env: { A: '1' } })
  assert.notEqual(exec.arguments, rewritten({ command: 'ls-first' }).data.tool_input)
  assert.equal(Object.isFrozen(exec.arguments), true)
  assert.equal(Object.isFrozen(exec.arguments.env), true)
})

test('a rewrite that is not lossless JSON is a typed unsupported', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-bad-rewrite-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile, {
        mods: [{ entry: 'bad-rewrite.ts' }],
        hooks: [pinned(sessionStartHook)],
      }),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      timeoutMs: 15_000,
    })

    assert.deepEqual(calls, [{ command: 'ls' }], 'the original arguments run, not the lossy rewrite')
    const trace = readTrace(traceFile)
    const unsupported = trace.find((record) => record.unsupported !== undefined)
    assert.ok(unsupported, 'the gap is recorded, not silently dropped')
    assert.equal(unsupported.event, 'PreToolUse')
    assert.equal(unsupported.unsupported.field, 'tool_input')
    assert.match(unsupported.unsupported.reason, /lossless JSON/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('two plugins load mods with their own $ and registrations', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-isolation-'))
  const traceA = join(dataDir, 'trace-alpha.jsonl')
  const traceB = join(dataDir, 'trace-beta.jsonl')
  const calls = []
  const entry = {
    id: 'anyplugin.mods-isolation',
    name: '@deepseek-ai/cordis-plugin-group',
    group: true,
    config: [
      {
        id: 'hook',
        name: materializerUrl('dsh-anyplugin-materialize-hook'),
        config: {
          pluginRoot: fixture,
          pluginData: dataDir,
          plugin: 'alpha',
          mods: [{ entry: 'alpha.ts' }],
          hooks: [pinned(sessionStartHook)],
          traceFile: traceA,
        },
      },
      {
        id: 'second',
        name: materializerUrl('dsh-anyplugin-materialize-hook'),
        config: {
          pluginRoot: fixture,
          pluginData: join(dataDir, 'second'),
          plugin: 'beta',
          mods: [{ entry: 'beta.ts' }],
          hooks: [pinned(sessionStartHook)],
          traceFile: traceB,
        },
      },
    ],
  }
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry,
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      timeoutMs: 15_000,
    })

    assert.equal(calls.length, 1)
    assert.ok(['ls-alpha', 'ls-beta'].includes(calls[0].command), JSON.stringify(calls))

    const a = readTrace(traceA)
    const b = readTrace(traceB)
    const preA = a.find((record) => record.event === 'PreToolUse')
    const preB = b.find((record) => record.event === 'PreToolUse')
    assert.deepEqual(preA.sources, ['alpha/alpha.ts#0'])
    assert.deepEqual(preB.sources, ['beta/beta.ts#0'])
    assert.deepEqual(preA.trace.map((step) => step.status), ['ran'])
    assert.deepEqual(preB.trace.map((step) => step.status), ['ran'])
    assert.equal(a.some((record) => JSON.stringify(record).includes('beta/')), false)
    assert.equal(b.some((record) => JSON.stringify(record).includes('alpha/')), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a synthetic mod exercises all 23 $ sites, in scan order, with typed refusals', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-ledger-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    writeFileSync(join(dataDir, 'ledger.txt'), 'ledger\n')
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile, {
        mods: [{ entry: 'bridge-ledger.ts' }, { entry: 'bridge-load.ts' }],
        hooks: [],
      }),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      timeoutMs: 30_000,
    })

    const store = stored(dataDir)
    assert.deepEqual(store['bridge-ledger'], SYNTHETIC_LEDGER)

    // D32 §4: a load-time session.start has no agent, so the view is empty and
    // the id is a typed refusal, not an invented value.
    assert.deepEqual(store['bridge-load'].messages, [])
    assert.deepEqual(store['bridge-load'].usageFirst, {})
    assert.deepEqual(store['bridge-load'].usageSecond, {})
    assert.equal(store['bridge-load'].id.code, 'ERR_MOD_HOST_SESSION_UNAVAILABLE')

    // Missing usage fields are reported once per load even though the fixture
    // asks twice. Scope to the load-time mod: the ledger mod is a separate
    // load with its own report-once set and a live session.
    const warnings = readTrace(traceFile).filter(
      (record) => record.warning !== undefined && record.warning.includes('bridge-load.ts'),
    )
    for (const field of ['startedAt', 'context', 'rateLimits', 'cost']) {
      const matches = warnings.filter((record) => record.warning.includes(`has no ${field} observable`))
      assert.equal(matches.length, 1, `usage.${field} is reported exactly once per load`)
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the session transcript carries the tool-result turn in the pinned shape', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-transcript-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile, {
        mods: [{ entry: 'transcript-seat.ts' }],
        hooks: [],
      }),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_transcript', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      timeoutMs: 30_000,
    })

    const assertTranscript = (label, messages, expectResult) => {
      assert.ok(Array.isArray(messages), `${label} is an array`)
      assert.ok(messages.length >= 2, `${label} is not empty`)
      const assistant = messages.find((message) => message.role === 'assistant' && (message.toolUses ?? []).length > 0)
      assert.ok(assistant, `${label} has the assistant tool call`)
      const use = assistant.toolUses[0]
      assert.equal(use.tool, 'Bash')
      assert.deepEqual(use.input, { command: 'ls' })
      // PostToolUse runs before the host appends the tool/result event (the
      // seat's own ordering), so only Stop can assert the completed result.
      if (!expectResult) return
      assert.equal(use.text, 'ran', 'the tool result text is attached to the tool use')
      const carrier = messages.find(
        (message) => message.role === 'user' &&
          (message.toolResults ?? []).some((result) => result.tool_use_id === use.tool_use_id),
      )
      assert.ok(carrier, `${label} has the user message carrying the tool result`)
      const result = carrier.toolResults.find((entry) => entry.tool_use_id === use.tool_use_id)
      assert.equal(result.text, 'ran')
      assert.equal(result.isError, undefined)
    }


    const store = stored(dataDir)
    assertTranscript('PostToolUse transcript', store['transcript-post'], false)
    assertTranscript('Stop transcript', store['transcript-stop'], true)
    assert.ok(store['transcript-stop'].length >= store['transcript-post'].length)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a load without a commands service refuses command.register instead of waiting', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-nocommands-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    writeFileSync(join(dataDir, 'ledger.txt'), 'ledger\n')
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile, {
        commands: [],
        mods: [{ entry: 'bridge-ledger.ts' }],
        hooks: [],
      }),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      timeoutMs: 30_000,
    })
    const ledger = stored(dataDir)['bridge-ledger']
    assert.ok(
      ledger.includes('command.register:refused:ERR_MOD_HOST_COMMAND_UNAVAILABLE'),
      'the typed refusal is observable, not a silent undefined',
    )

    // The old host slept up to 500 ms for a sibling service. Time the
    // materializer's apply directly: a missing service must refuse now.
    const directDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-nocommands-apply-'))
    const disposers = []
    try {
      const ctx = {
        logger: { warn() {} },
        on: () => () => {},
        effect(fn) { const dispose = fn(); disposers.push(dispose); return () => {} },
        get(name) { return name === 'agents' ? { list: () => [] } : undefined },
      }
      const started = Date.now()
      await applyMaterializer(ctx, {
        pluginRoot: fixture,
        pluginData: directDir,
        plugin: 'nocommands',
        mods: [{ entry: 'bridge-load.ts' }],
        hooks: [],
        traceFile: join(directDir, 'trace.jsonl'),
      })
      const elapsed = Date.now() - started
      assert.ok(elapsed < 200, `the apply took ${elapsed} ms; a missing service must not sleep`)
    } finally {
      for (const dispose of disposers) await dispose?.()
      rmSync(directDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('command.register is live in the DSH registry, disposed on reload, and a duplicate names the mod', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-command-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const calls = []
  try {
    writeFileSync(join(dataDir, 'ledger.txt'), 'ledger\n')
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: modsEntry(dataDir, traceFile, {
        mods: [{ entry: 'bridge-ledger.ts' }, { entry: 'bridge-command-dup.ts' }],
        hooks: [],
      }),
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      reloadWhileLive: true,
      timeoutMs: 30_000,
    })

    // The second load registers the same name again: only the first load's
    // disposer running on unload makes this `ran` instead of a duplicate.
    assert.deepEqual(stored(dataDir)['bridge-ledger'], SYNTHETIC_LEDGER)
    const duplicate = stored(dataDir)['bridge-duplicate']
    assert.equal(duplicate.code, 'ERR_MOD_HOST_COMMAND_DUPLICATE')
    assert.match(duplicate.message, /bridge-command-dup\.ts/)
    assert.match(duplicate.message, /bridge-ledger/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// The fetched upstream `diff` mod as a kernel fixture (D34, D32). Sources are
// fetched at test time and never vendored; CI sets ANYPLUGIN_MOD_TREE.
const diffFixturePath = fileURLToPath(new URL('../../../fixtures/mods/diff/fixture.json', import.meta.url))
const diffFixture = JSON.parse(readFileSync(diffFixturePath, 'utf8'))
const isCI = process.env.CI === 'true' || process.env.CI === '1'
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// The static capability ledger: every site the scanner sees in the pinned
// graph, in source order. `served` means the bridged namespace has the method;
// `refused:<code>` means the call was made and the typed refusal came back.
const DIFF_LEDGER = [
  { site: 'clock.now', result: 'ran', argument: 'session.start fallback', evidence: 'diff session.start' },
  { site: 'clock.after', result: 'ran', argument: '1 ms, cancelled', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'clock.every', result: 'ran', argument: '1 ms, cancelled', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'process.run', result: 'refused:ERR_MOD_HOST_EXEC_UNSUPPORTED', argument: '[]', evidence: 'D25 refusal' },
  { site: 'fs.stat', result: 'ran', argument: 'register.ts in the mod root', evidence: 'method availability; the fetched call reads the git dir HEAD from hook code' },
  { site: 'fs.list', result: 'ran', argument: '.', evidence: 'method availability; the fetched call reads entry kinds from hook code' },
  { site: 'fs.read', result: 'ran', argument: 'register.ts in the mod root', evidence: 'method availability; the fetched call reads registration.ts from hook code' },
  { site: 'store.get', result: 'ran', argument: 'ledger', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'store.set', result: 'ran', argument: 'ledger = {from: diff}', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'settings.read', result: 'refused:ERR_MOD_HOST_SETTINGS_UNAVAILABLE', argument: 'no argument', evidence: 'no merged settings reader on this host; refused rather than served from plugin data' },
  { site: 'env.get', result: 'ran', argument: 'PATH', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'session.messages', result: 'ran', argument: 'no argument', evidence: 'diff session.start openOnRestore' },
  { site: 'ui.invalidate', result: 'refused:ERR_MOD_HOST_UI_UNSUPPORTED', argument: '{}', evidence: 'D32 element runtime' },
  { site: 'ui.status', result: 'refused:ERR_MOD_HOST_UI_UNSUPPORTED', argument: '{}', evidence: 'D32 element runtime' },
  { site: 'ui.log', result: 'refused:ERR_MOD_HOST_UI_UNSUPPORTED', argument: '{}', evidence: 'D32 element runtime' },
  { site: 'ui.open', result: 'refused:ERR_MOD_HOST_UI_UNSUPPORTED', argument: '{}', evidence: 'D32 element runtime' },
  { site: 'ui.close', result: 'refused:ERR_MOD_HOST_UI_UNSUPPORTED', argument: '{}', evidence: 'D32 element runtime' },
  { site: 'command.register', result: 'ran', argument: '{ name: "diff", description }', evidence: 'diff session.start' },
  { site: 'session.id', result: 'ran', argument: 'no argument', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'session.usage', result: 'ran', argument: 'no argument', evidence: 'diff session.start' },
  { site: 'telemetry.mark', result: 'ran', argument: '{ from: "diff-ledger" }', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'telemetry.log', result: 'ran', argument: '{ from: "diff-ledger" }', evidence: 'method availability; the fetched call is in hook code' },
  { site: 'ui.resolve', result: 'refused:ERR_MOD_HOST_UI_UNSUPPORTED', argument: '{}', evidence: 'D32 element runtime' },
]

// What the pinned `session.start` actually does through `$`: bind() asks
// session.usage, falls back to clock.now, registers /diff, then opens the
// restore view with the (empty) message list. None of the other 19 sites is
// reached at load; they remain declared capabilities, not load-time calls.
const DIFF_SESSION_START_RELOAD = [
  'session.usage:ran',
  'command.register:ran',
  'session.messages:ran',
]
const DIFF_SESSION_START = [
  'session.usage:ran',
  'clock.now:ran',
  'command.register:ran',
  'session.messages:ran',
]

/** A `$` that records every method it serves, preserving sync throws. */
function recordingDollar(bridge, calls) {
  const source = bridge.dollar()
  const wrapped = {}
  for (const [namespace, table] of Object.entries(source)) {
    const next = {}
    for (const [method, value] of Object.entries(table)) {
      if (typeof value !== 'function') {
        next[method] = value
        continue
      }
      next[method] = (...args) => {
        const label = `${namespace}.${method}`
        try {
          const result = value(...args)
          if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
            return result.then(
              (resolved) => {
                calls.push(`${label}:ran`)
                return resolved
              },
              (error) => {
                calls.push(`${label}:refused:${error?.code ?? 'UNKNOWN'}`)
                throw error
              },
            )
          }
          calls.push(`${label}:ran`)
          return result
        } catch (error) {
          calls.push(`${label}:refused:${error?.code ?? 'UNKNOWN'}`)
          throw error
        }
      }
    }
    wrapped[namespace] = next
  }
  return wrapped
}

test('fixtures/mods/diff loads, matches the scan, and reaches the kernel', async (t) => {
  const tree = process.env[diffFixture.env]
  if (!tree) {
    const reason = `${diffFixture.env} is unset; run \`${diffFixture.fetch}\` and set it to the printed root`
    if (isCI) {
      assert.fail(`CI must fetch the pinned diff mod before npm test: ${reason}`)
    }
    return t.skip(reason)
  }

  // The fixture declaration and the host pin are the same claim.
  assert.equal(diffFixture.pin.version, DIFF_MOD_PIN.version)
  assert.equal(diffFixture.pin.commit, DIFF_MOD_PIN.commit)
  assert.equal(diffFixture.entry, DIFF_MOD_PIN.entry)

  const root = resolve(tree)
  const entry = join(root, diffFixture.entry)
  const before = sha256(entry)
  assert.equal(sha256(entry), DIFF_MOD_PIN.entrySha256, 'the fetched entry must be the pinned artifact')

  const source = readFileSync(entry, 'utf8')
  const scan = scanModSource(source, { file: 'mods/diff/hooks/register.ts' })
  assert.equal(scan.events.length, diffFixture.scan.events)
  assert.equal(new Set(scan.events.map((event) => event.name)).size, diffFixture.scan.uniqueEvents)
  assert.equal(scan.calls.length, diffFixture.scan.calls)
  assert.equal(scan.dynamic.length, diffFixture.scan.dynamic)

  // A real bridge, not a throwing host: the ledger is what diff's own code
  // asks this $ for, and the registry is a recording stand-in for ctx.commands.
  const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-diff-ledger-'))
  const registered = new Map()
  const commands = {
    register(definition) {
      if (registered.has(definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const warnings = []
  const bridge = createModBridge({
    plugin: 'diff/register.ts',
    dataDir,
    commands,
    session: () => ({ id: 'diff-ledger-session', cwd: root, messages: [], usage: {} }),
    env: process.env,
    warn: (message) => warnings.push(message),
  })
  try {
    // The static ledger: every scanned site is actually invoked, in scan
    // order, through the bridged $. Refusals must carry a stable code; every
    // served site must complete. This is the same ledger shape the synthetic
    // fixture asserts, so the two are directly comparable in the PR body.
    writeFileSync(join(dataDir, 'ledger.txt'), 'diff\n')
    const capability = []
    for (const site of scan.calls) {
      const label = `${site.namespace}.${site.method}`
      const namespace = bridge.dollar()[site.namespace]
      const method = namespace?.[site.method]
      if (typeof method !== 'function') {
        capability.push({ site: label, result: 'missing' })
        continue
      }
      try {
        switch (label) {
          case 'clock.now':
          case 'fs.list':
          case 'settings.read':
          case 'session.messages':
          case 'session.id':
          case 'session.usage':
            await method()
            break
          case 'clock.after':
          case 'clock.every': {
            const timer = method(1, () => {})
            timer.cancel()
            break
          }
          case 'fs.stat':
            await method('register.ts')
            break
          case 'fs.read':
            await method('register.ts')
            break
          case 'store.get':
            await method('ledger')
            break
          case 'store.set':
            await method('ledger', { from: 'diff' })
            break
          case 'env.get':
            await method('PATH')
            break
          case 'command.register':
            await method({ name: 'diff', description: 'diff (ledger)' })
            break
          case 'telemetry.mark':
          case 'telemetry.log':
            await method({ from: 'diff-ledger' })
            break
          default:
            // process.run and the six ui.* sites: the call must refuse.
            await method()
        }
        capability.push({ site: label, result: 'ran' })
      } catch (error) {
        capability.push({ site: label, result: `refused:${error?.code ?? 'UNKNOWN'}` })
      }
    }
    assert.deepEqual(
      capability.map((row) => ({ site: row.site, result: row.result })),
      DIFF_LEDGER.map((row) => ({ site: row.site, result: row.result })),
      'every scanned site ran or refused with a typed code',
    )

    const calls = []
    const load = await loadMod({
      root,
      entry: diffFixture.entry,
      host: { dollar: () => recordingDollar(bridge, calls) },
    })
    const events = load.registrations.map((registration) => registration.event)
    assert.deepEqual(events, diffFixture.registrations, 'the runtime registrations are the authored order')
    assert.deepEqual(
      scan.events.map((event) => event.name),
      events,
      'the scanner and the loaded graph must see the same on() sites',
    )

    // D32: the registrations ride the one kernel. Only session.start has a host
    // route at this pin; the rest are reported as unmapped with a reason, never
    // silently dropped.
    const kernel = modRegistrationsToKernel(load.registrations, {
      plugin: diffFixture.name,
      entry: diffFixture.entry,
    })
    assert.equal(kernel.routes.length, diffFixture.kernel.routed)
    assert.equal(kernel.routes[0].route.modEvent, 'session.start')
    assert.equal(kernel.routes[0].registration.event, 'session.start')
    assert.equal(kernel.unmapped.length, diffFixture.kernel.unmapped)
    for (const unmapped of kernel.unmapped) {
      assert.ok(unmapped.reason.length > 0, `${unmapped.event} has an empty unmapped reason`)
    }
    assert.equal(kernel.routes.length + kernel.unmapped.length, diffFixture.registrations.length)

    // The dynamic half: fire the pinned session.start through the real bridge.
    // It must complete, and the ordered calls are the recorded outcome.
    const sessionStart = load.registrations.find((registration) => registration.event === 'session.start')
    assert.ok(sessionStart !== undefined, 'the pinned graph registers session.start')
    const result = await sessionStart.handler(
      { cwd: root },
      async (event) => ({ decision: 'continue', event }),
    )
    assert.equal(result.decision, 'continue', 'session.start completes its next() chain')
    assert.deepEqual(calls, DIFF_SESSION_START, 'session.start asks $ for exactly these four sites, in order')
    assert.equal(registered.has('diff'), true, 'command.register landed in the DSH-shaped registry')

    bridge.dispose()
    assert.equal(registered.size, 0, 'dispose removes the load-lifetime registration')
    assert.throws(() => bridge.dollar(), (error) => error.code === 'ERR_MOD_HOST_DISPOSED')

    // A reload has a live root: the session view now carries header.createdAt,
    // so session.usage() is observed and the clock.now fallback does not run.
    const reloaded = createModBridge({
      plugin: 'diff/register.ts',
      dataDir,
      commands,
      session: () => ({
        id: 'diff-ledger-session',
        cwd: root,
        messages: [],
        usage: { startedAt: 1_700_000_000_000 },
      }),
      env: process.env,
      warn: () => {},
    })
    const reloadCalls = []
    const second = await loadMod({
      root,
      entry: diffFixture.entry,
      host: { dollar: () => recordingDollar(reloaded, reloadCalls) },
    })
    const secondStart = second.registrations.find((registration) => registration.event === 'session.start')
    const secondResult = await secondStart.handler(
      { cwd: root },
      async (event) => ({ decision: 'continue', event }),
    )
    assert.equal(secondResult.decision, 'continue', 'a reloaded session.start completes')
    assert.deepEqual(
      reloadCalls,
      DIFF_SESSION_START_RELOAD,
      'a reload reads startedAt from the live session and skips clock.now',
    )
    second.dispose()
    reloaded.dispose()
  } finally {
    bridge.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }

  assert.equal(sha256(entry), before, 'the fixture load must not touch the authored bytes')
})
