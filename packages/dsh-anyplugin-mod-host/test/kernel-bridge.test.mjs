// The mod host through the kernel (#36): real mods loaded by loadMod, adapted
// with modRegistrationsToKernel, and run through runChain — not a second path.

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  classicEvent,
  classicHookRegistration,
  describeTrace,
  modRegistrationsToKernel,
  runChain,
} from '../../dsh-anyplugin-intercept/src/index.ts'
import { loadMod } from '../src/index.ts'

const ROOT = fileURLToPath(new URL('../../../fixtures/mods/synthetic/', import.meta.url))

function recorder() {
  const calls = []
  let built = 0
  const makeDollar = () => {
    built += 1
    return {
      session: {
        usage: async () => ({ startedAt: 1700000000000 }),
        messages: async () => {
          calls.push('session.messages')
          return []
        },
      },
      clock: {
        now: async () => {
          calls.push('clock.now')
          return 1700000000001
        },
      },
      command: {
        register: async () => {
          calls.push('command.register')
        },
      },
    }
  }
  return { calls, built: () => built, host: { dollar: makeDollar } }
}

const load = (entry, host) => loadMod({ root: ROOT, entry, host })

test('one runChain trace: a loaded mod (prepend/wrap) and a classic hook (user/observe/fan-out)', async (t) => {
  const recorderHost = recorder()
  const loaded = await load('kernel.ts', recorderHost.host)
  const adapted = modRegistrationsToKernel(loaded.registrations, {
    plugin: 'synthetic',
    entry: 'kernel.ts',
    tier: 'prepend',
  })
  assert.equal(adapted.unmapped.length, 0)
  assert.deepEqual(adapted.registrations.map((registration) => registration.event), ['PreToolUse', 'PostToolUse'])
  assert.deepEqual(adapted.registrations.map((registration) => registration.mode), ['wrap', 'wrap'])
  assert.deepEqual(adapted.registrations.map((registration) => registration.continuation), [undefined, undefined])
  assert.equal(recorderHost.built(), 0, 'load and adaptation must not build a $')

  const classicPre = classicHookRegistration({
    event: 'PreToolUse',
    matcher: 'Bash',
    source: 'hook#0',
    run: (context, event) => {
      assert.equal(context.tier, 'user')
      assert.equal(event.subject, 'Bash')
      assert.equal(event.data.tool_name, 'Bash')
      assert.equal(event.data.tool_use_id, 'toolu_1')
      assert.equal(event.data.tool_input.command, 'ls -la')
      return { kind: 'text', text: 'hook-allowed' }
    },
  })
  const pre = adapted.registrations.filter((registration) => registration.event === 'PreToolUse')
  const result = await runChain(
    classicEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_input: { command: 'ls' },
    }),
    [classicPre, ...pre],
    { continuation: 'fan-out' },
  )
  t.diagnostic(describeTrace(result.trace).join('\n'))
  assert.deepEqual(
    result.trace.map((entry) => [entry.index, entry.tier, entry.source, entry.status]),
    [
      [0, 'prepend', 'synthetic/kernel.ts#0', 'ran'],
      [1, 'user', 'hook#0', 'ran'],
    ],
  )
  assert.deepEqual(result.decision, { kind: 'text', text: 'hook-allowed' })
  assert.equal(recorderHost.built(), 1, 'the mod handler received exactly one $')
  assert.deepEqual(recorderHost.calls, ['clock.now'])

  // The same adapted registration opens a fresh $ on its next invocation.
  const classicPost = classicHookRegistration({
    event: 'PostToolUse',
    source: 'hook#1',
    run: (context, event) => {
      assert.equal(context.tier, 'user')
      assert.equal(event.data.mod_marker, 'seen')
      return undefined
    },
  })
  const post = adapted.registrations.filter((registration) => registration.event === 'PostToolUse')
  const second = await runChain(
    classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls -la' } }),
    [classicPost, ...post],
    { continuation: 'fan-out' },
  )
  t.diagnostic(describeTrace(second.trace).join('\n'))
  assert.deepEqual(second.trace.map((entry) => entry.tier), ['prepend', 'user'])
  assert.equal(recorderHost.built(), 2)
  assert.deepEqual(recorderHost.calls, ['clock.now', 'session.messages'])
})

test('$ is per invocation through the adapter: two kernel runs build two namespaces', async () => {
  const recorderHost = recorder()
  const loaded = await load('register.ts', recorderHost.host)
  const adapted = modRegistrationsToKernel(loaded.registrations, { plugin: 'synthetic', entry: 'register.ts' })
  const registration = adapted.registrations[0]
  assert.equal(registration.event, 'session.start')
  assert.equal(recorderHost.built(), 0)
  for (let run = 1; run <= 2; run += 1) {
    const result = await runChain({ name: 'session.start', data: { cwd: '/tmp/project' } }, [registration])
    assert.deepEqual(
      result.trace.map((entry) => entry.status),
      ['ran'],
      `run ${run}: ${describeTrace(result.trace).join('; ')}`,
    )
    assert.equal(recorderHost.built(), run, `run ${run} must ask the host for a fresh $`)
  }
  assert.deepEqual(recorderHost.calls, [
    'command.register',
    'session.messages',
    'command.register',
    'session.messages',
  ])
})

test('a disposed mod is recorded as a kernel step error, not a crash or a silent skip', async () => {
  const recorderHost = recorder()
  const loaded = await load('register.ts', recorderHost.host)
  const adapted = modRegistrationsToKernel(loaded.registrations, { plugin: 'synthetic', entry: 'register.ts' })
  loaded.dispose()
  const result = await runChain({ name: 'session.start', data: { cwd: '/' } }, [adapted.registrations[0]])
  assert.equal(result.trace.length, 1)
  assert.equal(result.trace[0].status, 'error')
  assert.match(result.trace[0].detail, /the mod was disposed/)
  assert.equal(recorderHost.built(), 0)
})

test('a real mod with unprefixed event names is reported, not silently dropped', async () => {
  const recorderHost = recorder()
  const loaded = await load('order.ts', recorderHost.host)
  const adapted = modRegistrationsToKernel(loaded.registrations, { plugin: 'synthetic', entry: 'order.ts' })
  assert.equal(adapted.registrations.length, 0)
  assert.deepEqual(adapted.unmapped.map((entry) => entry.event), ['first', 'second'])
  for (const entry of adapted.unmapped) {
    assert.match(entry.reason, /not a Pattern/)
  }
})
