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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { classicEvent, modRegistrationsToKernel } from '../../dsh-anyplugin-intercept/src/index.ts'
import { applyToolInputRewrite } from '../../dsh-anyplugin-materialize-hook/src/index.ts'
import { loadMod } from '../../dsh-anyplugin-mod-host/src/index.ts'
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
  return {
    id: overrides.id ?? 'anyplugin.mods-seat',
    name: '@deepseek-ai/cordis-plugin-group',
    group: true,
    config: [
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

// The fetched upstream `diff` mod as a kernel fixture (D34, D32). Sources are
// fetched at test time and never vendored; CI sets ANYPLUGIN_MOD_TREE.
const diffFixturePath = fileURLToPath(new URL('../../../fixtures/mods/diff/fixture.json', import.meta.url))
const diffFixture = JSON.parse(readFileSync(diffFixturePath, 'utf8'))
const isCI = process.env.CI === 'true' || process.env.CI === '1'
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

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

  // Loading proves the .tsx path: without the classic transform the graph is
  // refused at views/pane-view.tsx (the pre-#45 nail).
  const load = await loadMod({
    root,
    entry: diffFixture.entry,
    host: {
      dollar: () => {
        throw new Error('$ must not be built while loading: register() declares only')
      },
    },
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

  assert.equal(sha256(entry), before, 'the fixture load must not touch the authored bytes')
})
