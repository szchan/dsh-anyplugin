// The lifecycle payload is the host event's data, copied field for field; the
// annotation's gap list is only honest if the fields the host does carry are
// really there. These tests drive `apply` with synthetic event values, so they
// pin the exact keys without booting a turn (the real turn is the conformance
// oracle's job) and prove the root/child split without a subagent runtime.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.ts'
import { hashManifest } from '../../dsh-anyplugin-trust/src/index.ts'

/** A pinned command hook whose whole effect is `cat > out`. */
const pinned = (event, command, matcher) => {
  const manifest = { mode: 'text', invocation: command, command: '', files: [] }
  return {
    event,
    index: 0,
    command,
    ...(matcher === undefined ? {} : { matcher }),
    artifactHash: hashManifest(manifest),
    artifactMode: manifest.mode,
    artifact: manifest,
  }
}

function harness() {
  const listeners = new Map()
  const warnings = []
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(register) {
      return register()
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ctx, listeners, warnings }
}

async function fire(listeners, host, value) {
  for (const listener of listeners.get(host) ?? []) await listener(value)
}

const rootAgent = (overrides = {}) => ({
  session: { header: { id: 'session-1', cwd: '/work', ...overrides.header } },
  model: { current: () => ({ provider: 'fake', model: 'fake-1' }) },
  ...overrides.agent,
})

const rootEvent = (source = 'startup', overrides = {}) => ({
  agent: rootAgent(overrides),
  source,
})

test('the SessionStart payload carries the session id, cwd, source and model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const out = join(dir, 'payload.json')
    const { ctx, listeners } = harness()
    apply(ctx, { hooks: [pinned('SessionStart', `cat > ${out}`)] })
    await fire(listeners, 'agent/created', rootEvent('startup'))
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
      hook_event_name: 'SessionStart',
      cwd: '/work',
      session_id: 'session-1',
      source: 'startup',
      model: 'fake-1',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Stop and SessionEnd carry only the fields their events really have', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const stopOut = join(dir, 'stop.json')
    const endOut = join(dir, 'end.json')
    const { ctx, listeners } = harness()
    apply(ctx, {
      hooks: [pinned('Stop', `cat > ${stopOut}`), pinned('SessionEnd', `cat > ${endOut}`)],
    })
    await fire(listeners, 'agent/turn-stopping', { agent: rootAgent(), turn: 1, signal: new AbortController().signal })
    await fire(listeners, 'agent/disposed', { agent: rootAgent() })
    assert.deepEqual(JSON.parse(readFileSync(stopOut, 'utf8')), {
      hook_event_name: 'Stop',
      cwd: '/work',
      session_id: 'session-1',
    })
    assert.deepEqual(JSON.parse(readFileSync(endOut, 'utf8')), {
      hook_event_name: 'SessionEnd',
      cwd: '/work',
      session_id: 'session-1',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the subagent payloads carry the parent session and the child agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const startOut = join(dir, 'start.json')
    const stopOut = join(dir, 'stop.json')
    const { ctx, listeners } = harness()
    apply(ctx, {
      hooks: [pinned('SubagentStart', `cat > ${startOut}`), pinned('SubagentStop', `cat > ${stopOut}`)],
    })
    await fire(listeners, 'subagent/start', { parentSessionId: 'session-1', id: 'child-1', local: true })
    await fire(listeners, 'subagent/end', {
      parentSessionId: 'session-1',
      id: 'child-1',
      lastAssistantMessage: [{ type: 'text', text: 'child done' }],
    })
    assert.deepEqual(JSON.parse(readFileSync(startOut, 'utf8')), {
      hook_event_name: 'SubagentStart',
      cwd: process.cwd(),
      session_id: 'session-1',
      agent_id: 'child-1',
    })
    assert.deepEqual(JSON.parse(readFileSync(stopOut, 'utf8')), {
      hook_event_name: 'SubagentStop',
      cwd: process.cwd(),
      session_id: 'session-1',
      agent_id: 'child-1',
      last_assistant_message: 'child done',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a child creation or turn stop never runs the root lifecycle hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const startOut = join(dir, 'start.json')
    const stopOut = join(dir, 'stop.json')
    const { ctx, listeners } = harness()
    apply(ctx, {
      hooks: [pinned('SessionStart', `cat > ${startOut}`), pinned('Stop', `cat > ${stopOut}`)],
    })
    const child = { agent: { session: { header: { id: 'child-1', parentSession: 'session-1' } } }, source: 'startup' }
    await fire(listeners, 'agent/created', child)
    await fire(listeners, 'agent/turn-stopping', { agent: child.agent, turn: 1, signal: new AbortController().signal })
    assert.equal(existsSync(startOut), false, 'a child creation is SubagentStart, not SessionStart')
    assert.equal(existsSync(stopOut), false, 'a child turn stop is SubagentStop, not Stop')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a matcher on a subjectless lifecycle event warns instead of running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const out = join(dir, 'stop.json')
    const { ctx, listeners, warnings } = harness()
    apply(ctx, { hooks: [pinned('Stop', `cat > ${out}`, '.*')] })
    await fire(listeners, 'agent/turn-stopping', { agent: rootAgent(), turn: 1, signal: new AbortController().signal })
    assert.equal(existsSync(out), false)
    assert.ok(
      warnings.some((line) => line.includes('matcher ".*" has no value in agent/turn-stopping; skipped')),
      `expected a skip warning, saw ${JSON.stringify(warnings)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
