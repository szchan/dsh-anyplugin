// The materializer must not own tier order, matcher evaluation or
// first-decision-wins; those belong to the intercept kernel (D13). These tests
// drive the public mount with two handlers and read the kernel trace through
// `onTrace`, so they fail if the mount bypasses `runChain` even when the
// hand-rolled path happens to preserve the visible verdict.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.ts'
import { hashManifest } from '../../dsh-anyplugin-trust/src/index.ts'

/** A pinned command hook whose whole effect is the shell command. */
const pinned = (event, command, { matcher, index = 0 } = {}) => {
  const manifest = { mode: 'text', invocation: command, command: '', files: [] }
  return {
    event,
    index,
    command,
    ...(matcher === undefined ? {} : { matcher }),
    artifactHash: hashManifest(manifest),
    artifactMode: manifest.mode,
    artifact: manifest,
  }
}

function harness() {
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const traces = []
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
      }
    },
    effect(register) {
      disposers.push(register())
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return {
    ctx,
    listeners,
    disposers,
    warnings,
    traces,
    config: (hooks) => ({
      hooks,
      onTrace: (event, result) => traces.push({ event, decision: result.decision, trace: result.trace }),
    }),
  }
}

const pre = () => ({ callId: 1, name: 'Write', arguments: { file_path: '/work/a.txt' } })

test('PreToolUse handlers run through the kernel: the first denial stops the second', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-kernel-'))
  try {
    const marker = join(dir, 'second-ran')
    const { ctx, listeners, warnings, traces, config } = harness()
    apply(ctx, config([
      pinned('PreToolUse', 'printf refused >&2; exit 2', { matcher: 'Write', index: 0 }),
      pinned('PreToolUse', `printf second > ${marker}`, { matcher: 'Write', index: 1 }),
    ]))

    let nextCalls = 0
    const result = await listeners.get('tools/pre-execute')[0](pre(), async () => {
      nextCalls += 1
      return { kind: 'accept' }
    })

    assert.deepEqual(result, { kind: 'deny', reason: 'refused' })
    assert.equal(nextCalls, 0, 'a denial is returned to the host, not continued')
    assert.equal(existsSync(marker), false, 'the second matching handler never ran')
    assert.deepEqual(warnings, [])
    assert.equal(traces.length, 1, 'the kernel trace observer saw exactly one chain run')
    assert.equal(traces[0].event, 'PreToolUse')
    assert.deepEqual(traces[0].trace, [
      { source: 'PreToolUse#0', tier: 'user', index: 0, status: 'ran', decision: 'deny' },
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an invalid matcher is skipped by the kernel instead of failing the turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-kernel-'))
  try {
    const bad = join(dir, 'bad-ran')
    const good = join(dir, 'good-ran')
    const { ctx, listeners, warnings, traces, config } = harness()
    apply(ctx, config([
      pinned('PreToolUse', `printf bad > ${bad}`, { matcher: 'Write(', index: 0 }),
      pinned('PreToolUse', `printf good > ${good}`, { matcher: 'Write', index: 1 }),
    ]))

    const result = await listeners.get('tools/pre-execute')[0](pre(), async () => ({ kind: 'accept' }))

    assert.deepEqual(result, { kind: 'accept' })
    assert.equal(existsSync(bad), false, 'an invalid pattern matches nothing (D20)')
    assert.equal(existsSync(good), true, 'the following valid handler still runs')
    assert.deepEqual(warnings, [], 'an invalid matcher was silent before the kernel too')
    // `of()` sorts by matcher text before registration, so the valid `Write`
    // group runs first and the malformed `Write(` group is skipped second.
    assert.deepEqual(traces[0].trace.map((step) => step.status), ['ran', 'skipped-matcher'])
    assert.equal(traces[0].trace.find((step) => step.status === 'skipped-matcher').source, 'PreToolUse#0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disposing the effect removes every subscription the materializer made', () => {
  const { ctx, listeners, disposers, config } = harness()
  apply(ctx, config([
    pinned('PreToolUse', 'true'),
    pinned('PostToolUse', 'true'),
    pinned('Stop', 'true'),
    pinned('SessionStart', 'true'),
  ]))

  for (const host of ['tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping', 'agent/created']) {
    assert.equal(listeners.get(host).length, 1, `${host} has one listener before disposal`)
  }
  for (const dispose of disposers) dispose()
  for (const host of ['tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping', 'agent/created']) {
    assert.equal(listeners.get(host).length, 0, `${host} has no listener after disposal`)
  }
})

test('the trace observer cannot break the turn', async () => {
  const { ctx, listeners, warnings, config } = harness()
  const options = config([pinned('PreToolUse', 'true')])
  options.onTrace = () => {
    throw new Error('observer failed')
  }
  apply(ctx, options)

  const result = await listeners.get('tools/pre-execute')[0](pre(), async () => ({ kind: 'accept' }))

  assert.deepEqual(result, { kind: 'accept' })
  assert.ok(
    warnings.some((line) => line.includes('trace observer failed (observer failed)')),
    `expected a trace-observer warning, saw ${JSON.stringify(warnings)}`,
  )
})

test('a hook that times out is skipped by the kernel and the chain continues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-kernel-'))
  try {
    const marker = join(dir, 'after-timeout')
    const { ctx, listeners, warnings, traces, config } = harness()
    apply(ctx, config([
      // One-second command timeout: the runner kills the child, the kernel
      // budget has 5s of headroom, so the verdict is the runner's warning.
      { ...pinned('PreToolUse', 'sleep 5', { matcher: 'Write', index: 0 }), timeout: 1 },
      pinned('PreToolUse', `printf after > ${marker}`, { matcher: 'Write', index: 1 }),
    ]))

    const result = await listeners.get('tools/pre-execute')[0](pre(), async () => ({ kind: 'accept' }))

    assert.deepEqual(result, { kind: 'accept' })
    assert.equal(existsSync(marker), true, 'the next handler still runs after a timed-out hook')
    assert.ok(warnings.some((line) => line.includes('hook timed out after 60s')), JSON.stringify(warnings))
    assert.deepEqual(traces[0].trace.map((step) => step.status), ['ran', 'ran'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the payload keys are the runner payload, unchanged by the kernel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-kernel-'))
  try {
    const out = join(dir, 'payload.json')
    const { ctx, listeners, config } = harness()
    apply(ctx, config([pinned('PreToolUse', `cat > ${out}`, { matcher: 'Write' })]))

    await listeners.get('tools/pre-execute')[0](pre(), async () => ({ kind: 'accept' }))

    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
      hook_event_name: 'PreToolUse',
      cwd: process.cwd(),
      tool_name: 'Write',
      tool_input: { file_path: '/work/a.txt' },
      tool_use_id: '1',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
