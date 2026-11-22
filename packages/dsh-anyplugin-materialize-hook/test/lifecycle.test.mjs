// The lifecycle payload is the host event's data, copied field for field; the
// annotation's gap list is only honest if the fields the host does carry are
// really there. These tests drive `apply` with synthetic event values, so they
// pin the exact keys without booting a turn (the real turn is the conformance
// oracle's job) and prove the root/child split without a subagent runtime.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.ts'
import { hashManifest } from '../../dsh-anyplugin-trust/src/index.ts'
import { pinnedMod } from './pinned.mjs'

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

/** The host invokes each emit listener without awaiting its return value. */
const listenerFor = (listeners, host) => {
  const [listener] = listeners.get(host) ?? []
  assert.equal(typeof listener, 'function', `no listener for ${host}`)
  return listener
}

const waitFor = async (predicate, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
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

test('the SubagentStop chain waits for the child SubagentStart chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  const started = join(dir, 'started')
  const release = join(dir, 'release')
  const log = join(dir, 'order.log')
  let starting
  let stopping
  let order
  try {
    const { ctx, listeners } = harness()
    await apply(ctx, {
      hooks: [
        pinned(
          'SubagentStart',
          `touch ${started}; while [ ! -e ${release} ]; do sleep 0.01; done; printf 'start\\n' >> ${log}`,
        ),
        pinned('SubagentStop', `printf 'stop\\n' >> ${log}`),
      ],
    })
    // The host dispatches start and end without awaiting either listener, so
    // invoke start without awaiting it before firing the matching end.
    starting = listenerFor(listeners, 'subagent/start')({ parentSessionId: 'session-1', id: 'child-1' })
    await waitFor(() => existsSync(started), 5000, 'the start hook to begin')
    stopping = listenerFor(listeners, 'subagent/end')({ parentSessionId: 'session-1', id: 'child-1' })
    const settledEarly = await Promise.race([
      Promise.resolve(stopping).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ])
    assert.equal(settledEarly, false, 'SubagentStop completed while the blocked SubagentStart was still running')
  } finally {
    // Release a start hook that is still parked, so a failing assertion leaves
    // no `sh` process behind, then read the order once both chains settled.
    writeFileSync(release, '')
    await Promise.allSettled([starting, stopping].filter((item) => item !== undefined))
    order = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(order, ['start', 'stop'])
})

test('the seat stop chain waits for the seat start chain too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  const started = join(dir, 'started')
  const release = join(dir, 'release')
  const log = join(dir, 'order.log')
  let starting
  let stopping
  let order
  try {
    writeFileSync(join(dir, 'noop.ts'), 'export function register(_on: On): void {}\n')
    const { ctx, listeners } = harness()
    await apply(ctx, {
      hooks: [
        pinned(
          'SubagentStart',
          `touch ${started}; while [ ! -e ${release} ]; do sleep 0.01; done; printf 'start\\n' >> ${log}`,
        ),
        pinned('SubagentStop', `printf 'stop\\n' >> ${log}`),
      ],
      mods: [pinnedMod(dir, 'noop.ts')],
      pluginRoot: dir,
    })
    // A mod presence moves the chains onto the root agent's seat (D32), so
    // the gate must be wired there as well, not only on the classic mount.
    const seatListeners = new Map()
    const seat = {
      on(event, listener) {
        const list = seatListeners.get(event) ?? []
        list.push(listener)
        seatListeners.set(event, list)
        return () => {}
      },
      effect: (register) => register(),
      logger: { warn: () => {} },
    }
    const agent = {
      session: { header: { id: 'session-seat', cwd: '/work' } },
      model: { current: () => ({ provider: 'fake', model: 'fake-1' }) },
      ctx: seat,
    }
    for (const listener of listeners.get('agent/created') ?? []) await listener({ agent })
    starting = listenerFor(seatListeners, 'subagent/start')({
      parentSessionId: 'session-seat',
      id: 'child-seat',
      local: true,
    })
    await waitFor(() => existsSync(started), 5000, 'the seat start hook to begin')
    stopping = listenerFor(seatListeners, 'subagent/end')({ parentSessionId: 'session-seat', id: 'child-seat' })
    const settledEarly = await Promise.race([
      Promise.resolve(stopping).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ])
    assert.equal(settledEarly, false, 'the seat SubagentStop chain ran while its SubagentStart chain was blocked')
  } finally {
    writeFileSync(release, '')
    await Promise.allSettled([starting, stopping].filter((item) => item !== undefined))
    order = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(order, ['start', 'stop'])
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

test('WorktreeRemove runs once per removal, not once per cleanup record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const out = join(dir, 'runs')
    const { ctx, listeners } = harness()
    apply(ctx, { hooks: [pinned('WorktreeRemove', `printf x >> ${out}`)] })
    const settled = { sessionId: 'session-1', path: '/work/.agents/worktrees/a', cleanup: { revision: 1, status: 'removed' } }
    await fire(listeners, 'worktree/cleanup', { ...settled, cleanup: { revision: 1, status: 'scheduled' } })
    assert.equal(existsSync(out), false, 'the scheduled record is an intent, not a removal')
    await fire(listeners, 'worktree/cleanup', settled)
    assert.equal(readFileSync(out, 'utf8'), 'x')
    await fire(listeners, 'worktree/cleanup', settled)
    assert.equal(readFileSync(out, 'utf8'), 'x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StopFailure runs once for the turn, whichever failure record arrives first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const out = join(dir, 'runs')
    const { ctx, listeners } = harness()
    apply(ctx, { hooks: [pinned('StopFailure', `printf x >> ${out}`)] })
    const session = { header: { id: 'session-1', cwd: '/work' } }
    const error = { message: 'model failed', code: 'FAIL' }
    await fire(listeners, 'agent/error', {
      turn: 1,
      step: 1,
      error,
      agent: { session },
    })
    for (const listener of listeners.get('session/event') ?? []) {
      await listener(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error } } })
    }
    assert.equal(readFileSync(out, 'utf8'), 'x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WorktreeRemove reports the host cwd as a gap, never the removed path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const payloadPath = join(dir, 'payload.json')
    const { ctx, listeners, warnings } = harness()
    apply(ctx, { hooks: [pinned('WorktreeRemove', `cat > ${payloadPath}`)] })
    const settled = { sessionId: 'session-1', path: '/work/.agents/worktrees/a', cleanup: { revision: 1, status: 'removed' } }
    await fire(listeners, 'worktree/cleanup', settled)
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
    assert.equal(payload.worktree_path, settled.path)
    assert.equal(payload.cwd, process.cwd())
    assert.notEqual(payload.cwd, payload.worktree_path, 'cwd is the session directory, not the removed checkout')
    assert.ok(
      warnings.some((line) => line.includes('anyplugin WorktreeRemove: unsupported cwd')),
      `expected the cwd gap warning, saw ${JSON.stringify(warnings)}`,
    )
    assert.ok(
      warnings.some((line) => line.includes('anyplugin WorktreeRemove: unsupported transcript_path')),
      'the classic transcript_path is a reported gap',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StopFailure ignores a child session on both failure records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const out = join(dir, 'runs')
    const { ctx, listeners } = harness()
    apply(ctx, { hooks: [pinned('StopFailure', `printf x >> ${out}`)] })
    const session = { header: { id: 'child-1', parentSession: 'session-1' } }
    const error = { failure: { code: 'FAIL', message: 'child failed' }, message: 'child failed' }
    await fire(listeners, 'agent/error', { turn: 1, step: 1, error, agent: { session } })
    for (const listener of listeners.get('session/event') ?? []) {
      await listener(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error } } })
    }
    assert.equal(existsSync(out), false, 'a child failure belongs to SubagentStop, not StopFailure')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StopFailure keys each failure by session and turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const out = join(dir, 'runs')
    const { ctx, listeners } = harness()
    apply(ctx, { hooks: [pinned('StopFailure', `printf x >> ${out}`)] })
    const session = { header: { id: 'session-1', cwd: '/work' } }
    const error = { failure: { code: 'FAIL', message: 'model failed' }, message: 'model failed' }
    const fail = async (turn) => {
      await fire(listeners, 'agent/error', { turn, step: 1, error, agent: { session } })
      for (const listener of listeners.get('session/event') ?? []) {
        await listener(session, { type: 'turn/end', data: { turn, reason: { kind: 'error', error } } })
      }
    }
    await fail(1)
    assert.equal(readFileSync(out, 'utf8'), 'x')
    await fail(2)
    assert.equal(readFileSync(out, 'utf8'), 'xx', 'a second failing turn is a second occurrence')
    await fail(1)
    assert.equal(readFileSync(out, 'utf8'), 'xx', 'replaying turn 1 is not a new occurrence')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WorktreeRemove keys each removal by cleanup revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const out = join(dir, 'runs')
    const { ctx, listeners } = harness()
    apply(ctx, { hooks: [pinned('WorktreeRemove', `printf x >> ${out}`)] })
    const settled = (revision) => ({
      sessionId: 'session-1',
      path: '/work/.agents/worktrees/a',
      cleanup: { revision, status: 'removed' },
    })
    await fire(listeners, 'worktree/cleanup', settled(1))
    assert.equal(readFileSync(out, 'utf8'), 'x')
    await fire(listeners, 'worktree/cleanup', settled(2))
    assert.equal(readFileSync(out, 'utf8'), 'xx', 'a later attempt on the same path is a new removal')
    await fire(listeners, 'worktree/cleanup', settled(1))
    assert.equal(readFileSync(out, 'utf8'), 'xx', 'replaying revision 1 is not a new occurrence')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StopFailure reports every classic field the record cannot supply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const { ctx, listeners, warnings } = harness()
    apply(ctx, { hooks: [pinned('StopFailure', 'true')] })
    const session = { header: { id: 'session-1', cwd: '/work' } }
    await fire(listeners, 'agent/error', {
      turn: 1,
      step: 1,
      error: { failure: { code: 'FAIL' } },
      agent: { session },
    })
    for (const field of ['error', 'last_assistant_message', 'error_details', 'transcript_path']) {
      assert.ok(
        warnings.some((line) => line.includes(`anyplugin StopFailure: unsupported ${field}`)),
        `expected the ${field} gap, saw ${JSON.stringify(warnings)}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WorktreeCreate maps the branch and reports the absent transcript path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const payloadPath = join(dir, 'payload.json')
    const { ctx, listeners, warnings } = harness()
    apply(ctx, { hooks: [pinned('WorktreeCreate', `cat > ${payloadPath}`)] })
    const session = { header: { id: 'session-1', cwd: '/work' } }
    for (const listener of listeners.get('session/event') ?? []) {
      await listener(session, {
        type: 'plugin:worktree/created',
        data: { path: '/work/.agents/worktrees/a', branch: 'seams-a', baseCommit: 'abc', repositoryRoot: '/work' },
      })
    }
    assert.deepEqual(JSON.parse(readFileSync(payloadPath, 'utf8')), {
      hook_event_name: 'WorktreeCreate',
      cwd: '/work',
      session_id: 'session-1',
      name: 'seams-a',
    })
    assert.ok(
      warnings.some((line) => line.includes('anyplugin WorktreeCreate: unsupported transcript_path')),
      'the classic transcript_path is a reported gap',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a deny from a notification-only record is a warning, not a veto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const { ctx, listeners, warnings } = harness()
    apply(ctx, { hooks: [pinned('WorktreeRemove', `printf '{"decision":"block","reason":"no"}'`)] })
    const settled = { sessionId: 'session-1', path: '/work/.agents/worktrees/a', cleanup: { revision: 1, status: 'removed' } }
    await fire(listeners, 'worktree/cleanup', settled)
    assert.ok(
      warnings.some((line) => line.includes('cannot be enforced through worktree/cleanup; reported, not obeyed')),
      `expected the unsupported warning, saw ${JSON.stringify(warnings)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the task records fire on their own revisions, and absent classic fields are reported gaps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-lifecycle-'))
  try {
    const created = join(dir, 'created.json')
    const completed = join(dir, 'completed.json')
    const { ctx, listeners, warnings } = harness()
    apply(ctx, {
      hooks: [pinned('TaskCreated', `cat > ${created}`), pinned('TaskCompleted', `cat > ${completed}`)],
    })
    const session = { header: { id: 'session-1', cwd: '/work' } }
    const task = { id: 'task-1', revision: 1, subject: 'subject', description: 'description', status: 'pending' }
    for (const listener of listeners.get('session/event') ?? []) {
      await listener(session, { type: 'team/task', data: { version: 2, teamId: 'session-1', task } })
    }
    assert.deepEqual(JSON.parse(readFileSync(created, 'utf8')), {
      hook_event_name: 'TaskCreated',
      cwd: '/work',
      session_id: 'session-1',
      task_id: 'task-1',
      task_subject: 'subject',
      task_description: 'description',
    })
    for (const listener of listeners.get('session/event') ?? []) {
      await listener(session, {
        type: 'team/task',
        data: { version: 2, teamId: 'session-1', task: { ...task, revision: 3, status: 'completed', ownerName: 'lead' } },
      })
    }
    assert.deepEqual(JSON.parse(readFileSync(completed, 'utf8')), {
      hook_event_name: 'TaskCompleted',
      cwd: '/work',
      session_id: 'session-1',
      task_id: 'task-1',
      task_subject: 'subject',
      task_description: 'description',
      teammate_name: 'lead',
    })
    assert.ok(warnings.some((line) => line.includes('anyplugin TaskCreated: unsupported team_name')), 'team_name is a gap')
    assert.ok(
      warnings.some((line) => line.includes('anyplugin TaskCreated: unsupported teammate_name')),
      'an unowned TaskCreated has no teammate_name',
    )
    assert.ok(warnings.some((line) => line.includes('anyplugin TaskCompleted: unsupported team_name')), 'team_name is a gap')
    assert.ok(
      warnings.some((line) => line.includes('anyplugin TaskCreated: unsupported transcript_path')),
      'the classic transcript_path is a gap on TaskCreated',
    )
    assert.ok(
      warnings.some((line) => line.includes('anyplugin TaskCompleted: unsupported transcript_path')),
      'the classic transcript_path is a gap on TaskCompleted',
    )
    assert.ok(
      warnings.some((line) => line.includes('anyplugin TaskCompleted: unsupported permission_mode')),
      'permission_mode is a reported gap on TaskCompleted',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
