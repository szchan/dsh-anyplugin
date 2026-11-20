// The mod front-end of the kernel (#36). These tests pin the mapping table and
// the translation, and prove that a mod handler and a classic hook handler on
// one host event run in ONE `runChain` trace, tier-ordered.

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import {
  CLASSIC_HOOK_EVENTS,
  MOD_CLASSIC_EVENTS,
  MOD_ENGINE_EVENTS,
  MOD_EVENT_ROUTES,
  MOD_NONEXISTENT_GUESSES,
  MOD_PINNED_EVENTS,
  MOD_UNMAPPED_REASONS,
  classicEvent,
  classicHookRegistration,
  describeTrace,
  modRegistrationsToKernel,
  runChain,
} from '../src/index.ts'

const mod = (event, handler, matcher = undefined) => ({ event, matcher, handler })

const adapt = (registrations, options = {}) =>
  modRegistrationsToKernel(registrations, { plugin: 'synthetic', entry: 'kernel.ts', ...options })

test('every pinned mod event is routed or unmapped with a reason', () => {
  assert.equal(MOD_CLASSIC_EVENTS.length, 33)
  assert.equal(MOD_ENGINE_EVENTS.length, 40)
  assert.equal(MOD_EVENT_ROUTES.length, 17)
  assert.equal(Object.keys(MOD_UNMAPPED_REASONS).length, 56)

  const routed = new Set(MOD_EVENT_ROUTES.map((route) => route.modEvent))
  for (const event of MOD_CLASSIC_EVENTS) {
    const name = `classic.${event}`
    assert.ok(routed.has(name) || MOD_UNMAPPED_REASONS[name] !== undefined, `${name} is missing from the mapping`)
    assert.ok(!(routed.has(name) && MOD_UNMAPPED_REASONS[name] !== undefined), `${name} is both routed and unmapped`)
  }
  for (const event of MOD_ENGINE_EVENTS) {
    assert.ok(routed.has(event) || MOD_UNMAPPED_REASONS[event] !== undefined, `${event} is missing from the mapping`)
    assert.ok(!(routed.has(event) && MOD_UNMAPPED_REASONS[event] !== undefined), `${event} is both routed and unmapped`)
  }
  for (const route of MOD_EVENT_ROUTES) {
    assert.ok(route.kernelEvent.length > 0, route.modEvent)
    assert.ok(route.hostSeam.length > 0, route.modEvent)
    assert.ok(route.evidence.length > 0, route.modEvent)
    if (route.modEvent.startsWith('classic.')) {
      assert.ok(CLASSIC_HOOK_EVENTS.includes(route.kernelEvent), `${route.modEvent} has no shared classic point`)
    }
  }
  // 16 live classic routes plus the live session.start loader event.
  assert.equal(MOD_EVENT_ROUTES.filter((route) => route.status === 'live').length, 17)
  const start = MOD_EVENT_ROUTES.find((route) => route.modEvent === 'session.start')
  assert.equal(start.kernelEvent, 'session.start')
  assert.equal(start.hostSeam, 'mod-host/load')
  assert.equal(start.status, 'live')
  assert.equal(start.reason, undefined)
  assert.equal(MOD_PINNED_EVENTS.length, 73)
  assert.equal(new Set(MOD_PINNED_EVENTS).size, 73)
  // The two partial classic payloads record the S9 caveat.
  const permissionRequest = MOD_EVENT_ROUTES.find((route) => route.kernelEvent === 'PermissionRequest')
  const permissionDenied = MOD_EVENT_ROUTES.find((route) => route.kernelEvent === 'PermissionDenied')
  assert.match(permissionRequest.caveat, /no tool_input/)
  assert.match(permissionDenied.caveat, /no tool name/)
  // MF5: tool.call's reason is a protocol mismatch, not a double-fire.
  assert.match(MOD_UNMAPPED_REASONS['tool.call'], /Protocol mismatch/)
  assert.doesNotMatch(MOD_UNMAPPED_REASONS['tool.call'], /double-fire/)
})

test('the ticket prose names are reported as absent, pointing at the pin', () => {
  const expected = {
    'post.tool.use': 'classic.PostToolUse',
    'pre.tool.use': 'classic.PreToolUse',
    'turn.stop': 'classic.Stop',
    'subagent.start': 'classic.SubagentStart',
    'subagent.stop': 'classic.SubagentStop',
    'tool.use.failure': 'classic.PostToolUseFailure',
  }
  assert.deepEqual(Object.keys(MOD_NONEXISTENT_GUESSES).sort(), Object.keys(expected).sort())
  for (const [guess, real] of Object.entries(expected)) {
    const result = adapt([mod(guess, () => {})])
    assert.equal(result.registrations.length, 0)
    assert.equal(result.unmapped.length, 1)
    assert.equal(result.unmapped[0].event, guess)
    assert.match(result.unmapped[0].reason, /not an event at the pin/)
    assert.ok(result.unmapped[0].reason.includes(real), `${guess} must point at ${real}`)
  }
})

test('registration conversion: wrap, host tier, source order, one source each', () => {
  const result = adapt(
    [
      mod('classic.PreToolUse', () => {}),
      mod('session.start', () => {}),
      mod('classic.PostToolUse', () => {}, 'Bash|Edit'),
    ],
    { tier: 'prepend' },
  )
  assert.equal(result.unmapped.length, 0)
  assert.deepEqual(result.registrations.map((registration) => registration.event), ['PreToolUse', 'session.start', 'PostToolUse'])
  assert.deepEqual(result.registrations.map((registration) => registration.mode), ['wrap', 'wrap', 'wrap'])
  assert.deepEqual(result.registrations.map((registration) => registration.continuation), [undefined, undefined, undefined])
  assert.deepEqual(result.registrations.map((registration) => registration.tier), ['prepend', 'prepend', 'prepend'])
  assert.deepEqual(
    result.registrations.map((registration) => registration.source),
    ['synthetic/kernel.ts#0', 'synthetic/kernel.ts#1', 'synthetic/kernel.ts#2'],
  )
  assert.equal(result.registrations[2].compiledMatcher.test('Edit'), true)
  assert.equal(result.registrations[2].compiledMatcher.test('Write'), false)
  assert.deepEqual(result.routes.map((entry) => entry.route.hostSeam), [
    'tools/pre-execute',
    'mod-host/load',
    'tools/post-execute',
  ])
  // Default seating is where a person's plugins sit, never core (d.ts:6253-6265).
  assert.equal(adapt([mod('session.start', () => {})]).registrations[0].tier, 'user')
  assert.throws(() => adapt([], { tier: 'core' }), /unknown tier core/)
  assert.throws(() => modRegistrationsToKernel([], { plugin: '' }), /plugin must be a non-empty string/)
})

test('an unmapped event and an unbridgeable matcher are reported, never dropped', () => {
  const result = adapt([
    mod('ui.render', () => {}),
    mod('made.up', () => {}),
    mod('classic.PostToolUse', () => {}, { tool: 'Bash' }),
    mod('classic.PostToolUse', () => {}, vm.runInNewContext('/Bash/i')),
    mod('classic.PostToolUse', () => {}, null),
  ])
  assert.equal(result.registrations.length, 0)
  assert.deepEqual(result.unmapped.map((entry) => entry.event), [
    'ui.render',
    'made.up',
    'classic.PostToolUse',
    'classic.PostToolUse',
    'classic.PostToolUse',
  ])
  assert.match(result.unmapped[0].reason, /UI lifecycle/)
  assert.match(result.unmapped[1].reason, /not an event in the pinned claude-code\.d\.ts/)
  assert.match(result.unmapped[2].reason, /structural matcher/)
  assert.match(result.unmapped[3].reason, /RegExp flags/)
  assert.match(result.unmapped[4].reason, /null/)
  for (const entry of result.unmapped) {
    assert.ok(entry.reason.length > 0)
    assert.equal(entry.source, `synthetic/kernel.ts#${entry.index}`)
  }
  // A malformed mod regex fails at adaptation, like a malformed classic matcher
  // fails when it is installed. It does not become a matcher that never matches.
  assert.throws(() => adapt([mod('classic.PostToolUse', () => {}, 'Bash(')]), /not a valid regular expression/)
})

test('a cross-realm flagless RegExp is adapted to its source and matches the subject', async () => {
  let seen = 0
  const result = adapt([mod('classic.PostToolUse', () => { seen += 1 }, vm.runInNewContext('/^Bash$/'))])
  assert.equal(result.unmapped.length, 0)
  assert.equal(result.registrations.length, 1)
  await runChain(classicEvent('PostToolUse', { tool_name: 'Bash' }), result.registrations)
  await runChain(classicEvent('PostToolUse', { tool_name: 'Edit' }), result.registrations)
  assert.equal(seen, 1)
})

test('one chain: a mod (prepend/wrap) and a classic hook (user/observe/fan-out) share one trace', async (t) => {
  // The mod sees the mod shape, rewrites Bash's command, and returns next(e).
  const modPre = mod('classic.PreToolUse', async (event, next) => {
    assert.deepEqual(event, { command: 'ls', tool: 'Bash', tool_use_id: 'toolu_1' })
    return next({ ...event, command: 'ls -la' })
  })
  // A classic hook on the same host point sees the classic payload, after the
  // mod's rewrite, and can decide for itself.
  const classicPre = classicHookRegistration({
    event: 'PreToolUse',
    matcher: 'Bash',
    source: 'hook#0',
    run: (context, event) => {
      assert.equal(event.data.tool_input.command, 'ls -la')
      assert.equal(context.tier, 'user')
      return undefined
    },
  })
  const { registrations, unmapped } = adapt([modPre], { tier: 'prepend' })
  assert.equal(unmapped.length, 0)
  const result = await runChain(
    classicEvent('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_input: { command: 'ls' },
      hook_event_name: 'PreToolUse',
    }),
    [classicPre, ...registrations],
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
  assert.deepEqual(result.decisions, [])
  assert.deepEqual(result.decision, { kind: 'continue' })
  // The classic arm is observe/fan-out; the mod arm is wrap with no continuation
  // declaration, so the channel's fan-out rule wins without a per-mod table.
  assert.equal(result.trace.length, 2)
  assert.equal(classicPre.mode, 'observe')
  assert.equal(classicPre.continuation, 'fan-out')
  assert.equal(registrations[0].mode, 'wrap')
  assert.equal(registrations[0].continuation, undefined)
})

test('a mod rewrite reaches a downstream classic handler; a classic decision survives', async (t) => {
  const modPost = mod('classic.PostToolUse', async (event, next) => next({ ...event, mod_marker: 'seen' }))
  const classicPost = classicHookRegistration({
    event: 'PostToolUse',
    source: 'hook#1',
    run: (context, event) => {
      assert.equal(event.data.mod_marker, 'seen')
      return { kind: 'text', text: 'classic saw the mod' }
    },
  })
  const { registrations } = adapt([modPost])
  const result = await runChain(classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: {} }), [
    ...registrations,
    classicPost,
  ], { continuation: 'fan-out' })
  t.diagnostic(describeTrace(result.trace).join('\n'))
  assert.deepEqual(result.trace.map((entry) => entry.tier), ['user', 'user'])
  assert.deepEqual(result.decision, { kind: 'text', text: 'classic saw the mod' })
  assert.deepEqual(result.decisions, [{ kind: 'text', text: 'classic saw the mod' }])
})

test('a mod-only chain stays first-decision and wrap: not calling next ends it', async () => {
  let secondRan = false
  let denied
  const { registrations } = adapt([
    mod('classic.Stop', () => undefined),
    mod('classic.Stop', () => { secondRan = true }),
    mod('classic.Stop', () => { denied = true; return { deny: 'handled' } }),
  ])
  const wrapped = registrations[2]
  const result = await runChain(classicEvent('Stop', {}), registrations.slice(0, 2))
  assert.equal(secondRan, false)
  assert.deepEqual(result.trace.map((entry) => [entry.tier, entry.status]), [['user', 'not-called']])
  assert.deepEqual(result.decision, { kind: 'continue' })
  const deniedResult = await runChain(classicEvent('Stop', {}), [wrapped])
  assert.equal(denied, true)
  assert.deepEqual(deniedResult.trace.map((entry) => [entry.tier, entry.status]), [['user', 'ran']])
  assert.deepEqual(deniedResult.decision, { kind: 'deny', reason: 'handled' })
})

test('the session.start route hands the mod the engine payload and next(e) is { cwd }', async () => {
  let payload
  let nextValue
  const { registrations, unmapped } = adapt([mod('session.start', async (event, next) => {
    payload = event
    nextValue = await next(event)
    return nextValue
  })])
  assert.equal(unmapped.length, 0)
  const result = await runChain({ name: 'session.start', data: { cwd: '/tmp/project' } }, registrations)
  assert.deepEqual(payload, { cwd: '/tmp/project' })
  assert.deepEqual(nextValue, { cwd: '/tmp/project' })
  assert.deepEqual(result.trace.map((entry) => [entry.source, entry.status]), [['synthetic/kernel.ts#0', 'ran']])
  assert.deepEqual(result.decision, { kind: 'continue' })
})

test('a classic.* pattern expands to the 16 live classic routes and reports the other 17', () => {
  const { registrations, routes, unmapped } = adapt([mod('classic.*', () => undefined)])
  assert.equal(registrations.length, 16)
  assert.equal(routes.length, 16)
  assert.equal(unmapped.length, 17)
  assert.ok(registrations.every((registration) => CLASSIC_HOOK_EVENTS.includes(registration.event)))
  assert.ok(unmapped.every((entry) => entry.event.startsWith('classic.')))
  assert.match(unmapped.find((entry) => entry.event === 'classic.Notification').reason, /S9 refuted/)
  assert.match(registrations[0].source, /\[classic\./)
  // The loader point is not part of the classic namespace.
  assert.ok(!registrations.some((registration) => registration.event === 'session.start'))
})

test('a * pattern expands to every routed name and reports the 56 without a route', () => {
  const { registrations, unmapped } = adapt([mod('*', () => undefined)])
  assert.equal(registrations.length, 17)
  assert.equal(unmapped.length, 56)
  assert.ok(registrations.some((registration) => registration.event === 'session.start'))
  assert.ok(unmapped.some((entry) => entry.event === 'ui.render'))
})

test('tool.* reaches the three engine tool events, each with its pinned reason', () => {
  const { registrations, unmapped } = adapt([mod('tool.*', () => undefined)])
  assert.equal(registrations.length, 0)
  assert.deepEqual(unmapped.map((entry) => entry.event), ['tool.call', 'tool.check', 'tool.describe'])
  assert.ok(unmapped.every((entry) => entry.reason.length > 0))
})

test('a negation selects the complement: !tool.* excludes every tool route', () => {
  const { registrations, unmapped } = adapt([mod('!tool.*', () => undefined)])
  assert.equal(registrations.length, 17)
  assert.equal(unmapped.length, 53)
  assert.ok(registrations.every((registration) => !registration.event.startsWith('tool.')))
  assert.ok(!unmapped.some((entry) => entry.event.startsWith('tool.')))
  const engineOnly = adapt([mod('!classic.*', () => undefined)])
  assert.equal(engineOnly.registrations.length, 1)
  assert.equal(engineOnly.registrations[0].event, 'session.start')
  assert.equal(engineOnly.unmapped.length, 39)
})

test('a pattern that cannot be expanded gets its own reason, not "not an event"', () => {
  for (const pattern of ['tools', '!*', '!']) {
    const { registrations, unmapped } = adapt([mod(pattern, () => undefined)])
    assert.equal(registrations.length, 0, pattern)
    assert.equal(unmapped.length, 1, pattern)
    assert.equal(unmapped[0].event, pattern)
    assert.match(unmapped[0].reason, /not a Pattern/, pattern)
  }
})

test('without an explicit continuation a [mod, classic, mod] chain takes fan-out', async (t) => {
  const order = []
  let fanOutNext
  const first = mod('classic.PostToolUse', async (event, next) => {
    order.push('mod-first')
    assert.equal(event.mod_marker, undefined)
    fanOutNext = await next({ ...event, mod_marker: 'first' })
    return fanOutNext
  })
  const classic = classicHookRegistration({
    event: 'PostToolUse',
    source: 'hook#0',
    run: (context, event) => {
      order.push('classic')
      assert.equal(event.data.mod_marker, 'first')
      return { kind: 'text', text: 'classic decision' }
    },
  })
  const last = mod('classic.PostToolUse', async (event, next) => {
    order.push('mod-last')
    assert.equal(event.mod_marker, 'first')
    return next(event)
  })
  const { registrations } = adapt([first, last])
  const result = await runChain(
    classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: {} }),
    [registrations[0], classic, registrations[1]],
  )
  t.diagnostic(describeTrace(result.trace).join('\n'))
  // In fan-out, next(e) only rewrites for later registrations; it does not
  // run the classic arm and resolves the kernel's continue, not ClassicResultOf.
  assert.equal(fanOutNext, undefined)
  assert.deepEqual(order, ['mod-first', 'classic', 'mod-last'])
  assert.deepEqual(
    result.trace.map((entry) => [entry.source, entry.status]),
    [['synthetic/kernel.ts#0', 'ran'], ['hook#0', 'ran'], ['synthetic/kernel.ts#1', 'ran']],
  )
  assert.deepEqual(result.decisions, [{ kind: 'text', text: 'classic decision' }])
  assert.deepEqual(result.decision, { kind: 'text', text: 'classic decision' })
})

test('a mod-only chain resolves next(e) as ClassicResultOf, not an engine verb', async () => {
  let resolved
  const first = mod('classic.PostToolUse', async (event, next) => {
    resolved = await next(event)
    return resolved
  })
  const second = mod('classic.PostToolUse', () => ({ additionalContext: ['from second'] }))
  const { registrations } = adapt([first, second])
  const result = await runChain(classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: {} }), registrations)
  assert.deepEqual(resolved, { additionalContext: ['from second'] })
  assert.deepEqual(result.decision, { kind: 'text', text: 'from second' })
  assert.deepEqual(result.trace.map((entry) => entry.status), ['ran', 'ran'])
})

test('classic ask is reported as typed unsupported, never silently continued', async () => {
  const { registrations } = adapt([mod('classic.PreToolUse', () => ({ ask: 'approve this?' }))])
  const result = await runChain(classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {} }), registrations)
  assert.equal(result.decision.kind, 'unsupported')
  assert.equal(result.decision.field, 'ask')
  assert.match(result.decision.reason, /approval/)
  assert.deepEqual(result.trace.map((entry) => entry.decision), ['unsupported'])
})

test('classic additionalContext becomes kernel text', async () => {
  const { registrations } = adapt([mod('classic.PostToolUse', () => ({ additionalContext: ['one', 'two'] }))])
  const result = await runChain(classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: {} }), registrations)
  assert.deepEqual(result.decision, { kind: 'text', text: 'one\ntwo' })
})

test('classic updatedInput rewrites the PreToolUse envelope for the classic arm', async () => {
  let seen
  const modPre = mod('classic.PreToolUse', () => ({ updatedInput: { command: 'rm -rf build' } }))
  const classic = classicHookRegistration({
    event: 'PreToolUse',
    source: 'hook#1',
    run: (context, event) => { seen = event.data.tool_input.command },
  })
  const { registrations } = adapt([modPre])
  const result = await runChain(
    classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'rm -rf /' } }),
    [...registrations, classic],
  )
  assert.equal(seen, 'rm -rf build')
  assert.equal(result.trace.length, 2)
  assert.deepEqual(result.decision, { kind: 'continue' })
})

test('a classic field the kernel cannot carry is typed unsupported with a reason', async () => {
  const output = adapt([mod('classic.PostToolUse', () => ({ updatedToolOutput: { ok: true } }))])
  const result = await runChain(classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: {} }), output.registrations)
  assert.deepEqual([result.decision.kind, result.decision.field], ['unsupported', 'updatedToolOutput'])
  assert.match(result.decision.reason, /no carrier/)
  const stop = adapt([mod('classic.Stop', () => ({ preventContinuation: true, stopReason: 'done' }))])
  const stopped = await runChain(classicEvent('Stop', {}), stop.registrations)
  assert.deepEqual([stopped.decision.kind, stopped.decision.field], ['unsupported', 'preventContinuation'])
})

test('updatedInput and additionalContext on one PreToolUse result both survive', async () => {
  let seen
  const modPre = mod('classic.PreToolUse', () => ({
    updatedInput: { command: 'echo rewritten' },
    additionalContext: ['note'],
  }))
  const classic = classicHookRegistration({
    event: 'PreToolUse',
    source: 'hook#2',
    run: (context, event) => { seen = event.data.tool_input.command },
  })
  const { registrations } = adapt([modPre])
  const result = await runChain(
    classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'echo original' } }),
    [...registrations, classic],
  )
  assert.equal(seen, 'echo rewritten')
  assert.deepEqual(result.decision, { kind: 'text', text: 'note' })
})

test('the engine verbs stay available to a mod on any event', async () => {
  const result = await runChain(
    classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: {} }),
    adapt([mod('classic.PostToolUse', () => ({ result: { replaced: true } }))]).registrations,
  )
  assert.deepEqual(result.decision, { kind: 'result', result: { replaced: true } })
  const text = await runChain(
    classicEvent('PostToolUse', { tool_name: 'Bash', tool_input: {} }),
    adapt([mod('classic.PostToolUse', () => ({ text: 'engine text' }))]).registrations,
  )
  assert.deepEqual(text.decision, { kind: 'text', text: 'engine text' })
  const dropped = await runChain(
    classicEvent('Stop', {}),
    adapt([mod('classic.Stop', () => ({ drop: 'stop here' }))]).registrations,
  )
  assert.deepEqual(dropped.decision, { kind: 'block', reason: 'stop here' })
})
