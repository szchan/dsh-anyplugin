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
  pauseWhilePending,
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

// ---- Issue #68: the pinned `Next` surface ---------------------------------
// `next` is the kernel's own continuation with the pinned members around it.
// These tests assert semantics, not presence: a guard that calls `to` must
// really pass over the links above the tier it names, and every member must
// report what the host knows rather than what the mod wrote.

const observeAt = (tier, run, source = `${tier}#0`) => ({
  event: 'PreToolUse',
  tier,
  mode: 'observe',
  continuation: 'fan-out',
  source,
  run,
})

test('next.to(e, "append") from prepend skips a user classic hook, runs append, and traces the skip', async (t) => {
  const ran = []
  let seenBeneath
  const guard = mod('classic.PreToolUse', async (event, next) => {
    const resolved = await next.to(event, 'append')
    // The link it passed over has already settled; the trace sees it, nearest
    // first, with the pinned reason.
    seenBeneath = next.trace
    return resolved
  })
  const { registrations } = adapt([guard], { tier: 'prepend' })
  const user = classicHookRegistration({
    event: 'PreToolUse',
    matcher: 'Bash',
    source: 'user#0',
    run: () => {
      ran.push('user')
    },
  })
  const append = observeAt('append', () => {
    ran.push('append')
  })
  const result = await runChain(
    classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_guard', tool_input: { command: 'ls' } }),
    [registrations[0], user, append],
  )
  t.diagnostic(describeTrace(result.trace).join('\n'))

  assert.deepEqual(ran, ['append'])
  const skipped = result.trace.find((entry) => entry.source === 'user#0')
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.detail, 'bypassed by synthetic')
  // The projection is the pinned subset: index, plugin, tier, event, outcome, reason.
  assert.deepEqual(seenBeneath, [
    {
      index: 1,
      plugin: 'user#0',
      tier: 'user',
      event: 'classic.PreToolUse',
      outcome: 'skipped',
      reason: 'bypassed by synthetic',
    },
  ])
  assert.equal(Object.isFrozen(seenBeneath), true)
  assert.equal(Object.isFrozen(seenBeneath[0]), true)
  // The append link is recorded after the prepend hook unsets, so the mod's own
  // view is short of it — nothing it never saw leaves, nothing it never ran joins.
  assert.deepEqual(result.trace.map((entry) => [entry.index, entry.status]), [[1, 'skipped'], [0, 'ran'], [2, 'ran']])
  assert.equal(result.decision.kind, 'continue')
})

test('next.to only moves forward and never re-enters a tier', async () => {
  const ran = []
  const guard = mod('classic.PreToolUse', async (event, next) => {
    // `prepend` is not a legal target at the pin; asking for a tier above
    // resumes at the next link rather than looping back (kernel rule).
    await assert.rejects(next.to(event, 'user'), /takes "append" or "builtin"/)
    return next(event)
  })
  const { registrations } = adapt([guard], { tier: 'prepend' })
  const user = classicHookRegistration({ event: 'PreToolUse', source: 'user#0', run: () => ran.push('user') })
  await runChain(
    classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {} }),
    [registrations[0], user],
  )
  assert.deepEqual(ran, ['user'])
})

test('next.signal aborts while the hook is still running', async () => {
  const controller = new AbortController()
  let sawAbort = false
  let resolveSawAbort
  const saw = new Promise((resolve) => {
    resolveSawAbort = resolve
  })
  const guard = mod('classic.PreToolUse', async (event, next) => {
    assert.equal(next.signal.aborted, false)
    next.signal.addEventListener(
      'abort',
      () => {
        sawAbort = true
        resolveSawAbort()
      },
      { once: true },
    )
    // Hold the hook open across the abort so this is "mid-hook", not "before".
    await saw
    return next(event)
  })
  const { registrations } = adapt([guard])
  const pending = runChain(
    classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_abort', tool_input: {} }),
    registrations,
    { signal: controller.signal },
  )
  controller.abort()
  await saw
  assert.equal(sawAbort, true)
  assert.equal((await pending).decision.kind, 'continue')
})

test('is, event, origin and budget are what the host knows, not what the mod writes', async () => {
  let view
  const guard = mod('classic.PreToolUse', async (event, next) => {
    view = {
      event: next.event,
      isAllClassic: next.is('classic.*', event),
      isOther: next.is('classic.PostToolUse', event),
      origin: next.origin,
      to: typeof next.to,
      signalIsAbortSignal: next.signal instanceof AbortSignal,
      traceBeforeNext: next.trace,
      budgetBefore: { ms: next.budget.ms, remainingMs: next.budget.remainingMs },
    }
    await new Promise((resolve) => setTimeout(resolve, 15))
    view.budgetAfter = { ms: next.budget.ms, remainingMs: next.budget.remainingMs }
    // A write from the mod reaches the event it passes on, never the origin.
    const resolved = await next({ ...event, origin: { plugin: 'forged', tier: 'prepend' } })
    view.originAfter = next.origin
    return resolved
  })
  const { registrations } = adapt([guard])
  const result = await runChain(
    classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_view', tool_input: {} }),
    registrations,
  )

  assert.equal(view.event, 'classic.PreToolUse')
  assert.equal(view.isAllClassic, true)
  assert.equal(view.isOther, false)
  assert.deepEqual(view.origin, { plugin: 'engine', tier: 'core' })
  assert.equal(Object.isFrozen(view.origin), true)
  assert.equal(view.to, 'function')
  assert.equal(view.signalIsAbortSignal, true)
  assert.deepEqual(view.traceBeforeNext, [])
  assert.equal(view.budgetBefore.ms, 10_000)
  assert.ok(view.budgetBefore.remainingMs <= 10_000 && view.budgetBefore.remainingMs > 0)
  assert.ok(view.budgetAfter.remainingMs < view.budgetBefore.remainingMs)
  assert.equal(view.budgetAfter.ms, view.budgetBefore.ms)
  assert.deepEqual(view.originAfter, { plugin: 'engine', tier: 'core' })
  assert.equal(Object.isFrozen(result.event), false)
  // The forged origin did not reach the kernel's event copy either: the adapter
  // rebuilds the mod-shaped payload, so `origin` is not a field it can carry.
  assert.equal('origin' in result.event.data, false)
})

test('next.to refuses the tiers TargetTier excludes and the core tier this chain cannot serve', async () => {
  const failures = []
  const guard = mod('classic.PreToolUse', async (event, next) => {
    for (const tier of ['user', 'prepend', 'core', 'nonsense']) {
      try {
        await next.to(event, tier)
      } catch (error) {
        failures.push({ tier, name: error.name, message: error.message })
      }
    }
    return next(event)
  })
  const { registrations } = adapt([guard])
  await runChain(classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_tier', tool_input: {} }), registrations)

  assert.equal(failures.length, 4)
  for (const tier of ['user', 'prepend', 'nonsense']) {
    assert.equal(failures.find((failure) => failure.tier === tier).name, 'TypeError')
    assert.match(failures.find((failure) => failure.tier === tier).message, /takes "append" or "builtin"/)
  }
  const core = failures.find((failure) => failure.tier === 'core')
  assert.equal(core.name, 'TypeError')
  assert.match(core.message, /not served/)
  assert.match(core.message, /9938/)
})

// ---- Review rulings M1–M5 / S-a–S-c --------------------------------------
// The seven members are only worth serving if the kernel's continuation rules
// hold beneath them. These pin the rulings from the PR #70 review.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One adapter registration, so each test can choose its own tier and budget. */
const at = (tier, entry, options = {}) =>
  modRegistrationsToKernel([entry], { plugin: 'synthetic', entry: 'kernel.ts', tier, ...options }).registrations[0]

const guardedCall = () =>
  classicEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_review', tool_input: { command: 'ls' } })

test('first-decision: next runs the remainder once, not once per sibling', async () => {
  const ran = []
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('prepend')
      const resolved = await next(event)
      ran.push('prepend:after')
      return resolved
    }),
  )
  const user = at(
    'user',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('user')
      return next(event)
    }),
  )
  const append = at(
    'append',
    mod('classic.PreToolUse', () => {
      ran.push('append')
      return { deny: 'stop' }
    }),
  )
  const result = await runChain(guardedCall(), [prepend, user, append])
  assert.deepEqual(ran, ['prepend', 'user', 'append', 'prepend:after'])
  assert.deepEqual(result.decision, { kind: 'deny', reason: 'stop' })
  assert.deepEqual(result.trace.map((entry) => entry.status), ['ran', 'ran', 'ran'])
})

test('first-decision: next.to runs the named tier once and traces the pass-over', async () => {
  const ran = []
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      const resolved = await next.to(event, 'append')
      ran.push('prepend:after')
      return resolved
    }),
  )
  const user = at(
    'user',
    mod('classic.PreToolUse', () => {
      ran.push('user')
    }),
  )
  const append = at(
    'append',
    mod('classic.PreToolUse', () => {
      ran.push('append')
      return { deny: 'stop' }
    }),
  )
  const result = await runChain(guardedCall(), [prepend, user, append])
  assert.deepEqual(ran, ['append', 'prepend:after'])
  const skipped = result.trace.find((entry) => entry.tier === 'user')
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.detail, 'bypassed by synthetic')
  assert.deepEqual(result.decision, { kind: 'deny', reason: 'stop' })
})

test('fan-out: next.to passes over the tiers beneath the caller, not a same-tier sibling', async () => {
  const ran = []
  const first = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next.to(event, 'append')
      ran.push('first')
    }),
  )
  const second = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('second')
      return next(event)
    }),
  )
  const user = classicHookRegistration({
    event: 'PreToolUse',
    source: 'user#0',
    run: () => {
      ran.push('user')
    },
  })
  const append = at(
    'append',
    mod('classic.PreToolUse', () => {
      ran.push('append')
    }),
  )
  const result = await runChain(guardedCall(), [first, second, user, append], { continuation: 'fan-out' })
  assert.deepEqual(ran, ['first', 'second', 'append'])
  const skipped = result.trace.find((entry) => entry.source === 'user#0')
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.detail, 'bypassed by synthetic')
  // A same-tier sibling is not "beneath this tier": it ran, and it is not labelled.
  const prependTrace = result.trace.filter((entry) => entry.tier === 'prepend')
  assert.deepEqual(prependTrace.map((entry) => entry.status), ['ran', 'ran'])
})

test('next.trace omits a link the matcher skipped: it never ran', async () => {
  let beneath
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next(event)
      beneath = next.trace
    }),
  )
  const user = at(
    'user',
    mod('classic.PreToolUse', () => {
      throw new Error('a matcher-skipped link must not run')
    }, 'Write'),
  )
  const append = at(
    'append',
    mod('classic.PreToolUse', (event, next) => next(event)),
  )
  const result = await runChain(guardedCall(), [prepend, user, append])
  assert.deepEqual(
    beneath.map((entry) => [entry.tier, entry.outcome]),
    [['append', 'passed']],
  )
  // The kernel still reports the matcher skip; it is a diagnostic, not a link.
  assert.equal(result.trace.find((entry) => entry.tier === 'user').status, 'skipped-matcher')
})

test('next.trace reports a throwing link as rejected with the throw as its reason', async () => {
  let beneath
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next(event)
      beneath = next.trace
    }),
  )
  const user = at(
    'user',
    mod('classic.PreToolUse', () => {
      throw new Error('boom')
    }),
  )
  const append = at(
    'append',
    mod('classic.PreToolUse', (event, next) => next(event)),
  )
  const result = await runChain(guardedCall(), [prepend, user, append])
  const rejected = beneath.find((entry) => entry.tier === 'user')
  assert.equal(rejected.outcome, 'rejected')
  assert.equal(rejected.reason, 'boom')
  assert.equal(result.trace.find((entry) => entry.tier === 'user').status, 'error')
})

test('the budget clock stands still while next is in flight', async () => {
  let callerRan = false
  let downstreamRuns = 0
  const caller = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      const resolved = await next(event)
      callerRan = true
      return resolved
    }),
    { timeoutMs: 50 },
  )
  const downstream = at(
    'user',
    mod('classic.PreToolUse', async (event, next) => {
      await sleep(150)
      downstreamRuns += 1
      return next(event)
    }),
    { timeoutMs: 1_000 },
  )
  const result = await runChain(guardedCall(), [caller, downstream], { deadlineMs: 5_000 })
  assert.equal(callerRan, true)
  assert.equal(downstreamRuns, 1)
  assert.deepEqual(
    result.trace.map((entry) => [entry.tier, entry.status]).sort(),
    [['prepend', 'ran'], ['user', 'ran']].sort(),
  )
})

test('pauseWhilePending holds the same meter across a slow $ call', async () => {
  const paused = await runChain(guardedCall(), [
    at(
      'prepend',
      mod('classic.PreToolUse', async (event, next) => {
        await pauseWhilePending(() => sleep(120))
        return next(event)
      }),
      { timeoutMs: 40 },
    ),
  ])
  assert.equal(paused.trace[0].status, 'ran')

  // Contrast: the same wait outside a `$` call is the hook's own work and
  // exceeds the budget.
  const unpaused = await runChain(guardedCall(), [
    at(
      'prepend',
      mod('classic.PreToolUse', async () => {
        await sleep(120)
      }),
      { timeoutMs: 40 },
    ),
  ])
  assert.equal(unpaused.trace[0].status, 'timeout')
})

test('a classic hook keeps its budget snapshot; a mod sees the live clock', async () => {
  let classicSame
  let modDecreased
  const user = classicHookRegistration({
    event: 'PreToolUse',
    source: 'user#0',
    run: async (context) => {
      const before = context.budget.remainingMs
      await sleep(20)
      classicSame = context.budget.remainingMs === before
      return CONTINUE
    },
  })
  const append = at(
    'append',
    mod('classic.PreToolUse', async (event, next) => {
      const before = next.budget.remainingMs
      await sleep(20)
      modDecreased = next.budget.remainingMs < before
      assert.equal(next.budget.ms, 10_000)
      return next(event)
    }),
  )
  await runChain(guardedCall(), [user, append])
  assert.equal(classicSame, true)
  assert.equal(modDecreased, true)
})

test('a timed-out handler sees its own signal aborted', async () => {
  let resolveSaw
  const saw = new Promise((resolve) => {
    resolveSaw = resolve
  })
  const guard = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      next.signal.addEventListener('abort', () => resolveSaw(next.signal.aborted), { once: true })
      await Promise.race([saw, sleep(500)])
      return next(event)
    }),
    { timeoutMs: 30 },
  )
  const result = await runChain(guardedCall(), [guard])
  assert.equal(result.trace[0].status, 'timeout')
  assert.equal(await saw, true)
})

test('fan-out: next.trace is empty while the kernel owns the remainder', async () => {
  let beneath
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next(event)
      beneath = next.trace
    }),
  )
  const user = classicHookRegistration({
    event: 'PreToolUse',
    source: 'user#0',
    run: () => {},
  })
  const result = await runChain(guardedCall(), [prepend, user])
  // In fan-out the kernel, not the hook, runs the links beneath: nothing has
  // settled when `next` resolves, so the projection is empty. Pinned so the
  // documented subset cannot silently start inventing steps.
  assert.deepEqual(beneath, [])
  assert.equal(Object.isFrozen(beneath), true)
  assert.deepEqual(result.trace.map((entry) => entry.status), ['ran', 'ran'])
})

// Round-3 review (M1): a deferred jump must land ON the named target, and a
// named tier with no link must not drop the rest of the chain. `tierStart`
// used to return `at + 1` for a direct target and `ordered.length` for a
// missing tier, so the target and everything after it never ran.
test('first-decision: next.to reaches a direct target with no intermediate link', async () => {
  const ran = []
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('prepend')
      return next.to(event, 'append')
    }),
  )
  const append = at(
    'append',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('append')
      return next(event)
    }),
  )
  const result = await runChain(guardedCall(), [prepend, append])
  assert.deepEqual(ran, ['prepend', 'append'])
  assert.deepEqual(result.trace.map((entry) => entry.status), ['ran', 'ran'])
})

test('first-decision: next.to reaches builtin from append with no intermediate link', async () => {
  const ran = []
  const append = at(
    'append',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('append')
      return next.to(event, 'builtin')
    }),
  )
  const builtin = at(
    'builtin',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('builtin')
      return next(event)
    }),
  )
  const result = await runChain(guardedCall(), [append, builtin])
  assert.deepEqual(ran, ['append', 'builtin'])
  assert.deepEqual(result.trace.map((entry) => entry.status), ['ran', 'ran'])
})

test('next.to falls forward when the named tier has no link left', async () => {
  const ran = []
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('prepend')
      return next.to(event, 'append')
    }),
  )
  const builtin = at(
    'builtin',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('builtin')
      return next(event)
    }),
  )
  const result = await runChain(guardedCall(), [prepend, builtin])
  assert.deepEqual(ran, ['prepend', 'builtin'])
  assert.deepEqual(result.decision, { kind: 'continue' })
})

test('fan-out: next.to reaches the direct target and falls forward too', async () => {
  for (const entries of [
    ['append'],
    ['builtin'],
  ]) {
    const ran = []
    const prepend = at(
      'prepend',
      mod('classic.PreToolUse', async (event, next) => {
        ran.push('prepend')
        await next.to(event, entries[0])
      }),
    )
    const target = at(
      entries[0],
      mod('classic.PreToolUse', async (event, next) => {
        ran.push(entries[0])
        return next(event)
      }),
    )
    await runChain(guardedCall(), [prepend, target], { continuation: 'fan-out' })
    assert.deepEqual(ran, ['prepend', entries[0]], `direct ${entries[0]}`)
  }
})

test('fan-out: next.to skips only strictly beneath tiers, never a direct same-tier sibling', async () => {
  const ran = []
  const guard = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next.to(event, 'append')
      ran.push('guard')
    }),
  )
  const sibling = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('sibling')
      return next(event)
    }),
  )
  const append = at(
    'append',
    mod('classic.PreToolUse', async (event, next) => {
      ran.push('append')
      return next(event)
    }),
  )
  const result = await runChain(guardedCall(), [guard, sibling, append], { continuation: 'fan-out' })
  assert.deepEqual(ran, ['guard', 'sibling', 'append'])
  assert.deepEqual(result.trace.filter((entry) => entry.tier === 'prepend').map((entry) => entry.status), ['ran', 'ran'])
})

test('a second next call is refused by name instead of silently reusing the first', async () => {
  const seen = []
  let secondCall
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next({ ...event, command: 'First' })
      try {
        await next({ ...event, command: 'Second' })
      } catch (error) {
        secondCall = error
      }
    }),
  )
  const user = at(
    'user',
    mod('classic.PreToolUse', (event, next) => {
      seen.push(event.command)
      return next(event)
    }),
  )
  await runChain(guardedCall(), [prepend, user])
  assert.equal(seen.length, 1, 'the chain ran once, not twice')
  assert.deepEqual(seen, ['First'], 'the first call is the one that ran')
  assert.match(secondCall.message, /called twice/)
  assert.match(secondCall.message, /5325-5338/)
})

test('budget accounts for own work and stands still across next', async () => {
  let before
  let after
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await sleep(100)
      before = next.budget.remainingMs
      await next(event)
      after = next.budget.remainingMs
    }),
    { timeoutMs: 500 },
  )
  const downstream = at(
    'append',
    mod('classic.PreToolUse', async (event, next) => {
      await sleep(200)
      return next(event)
    }),
    { timeoutMs: 1_000 },
  )
  await runChain(guardedCall(), [prepend, downstream], { deadlineMs: 5_000 })
  // Own work counts: ~400 ms left, not the full 500. `next` does not count:
  // the value after it is the same reading, not the entry snapshot.
  assert.ok(before <= 450 && before >= 300, `before ${before}`)
  assert.ok(after <= before && before - after <= 25, `after ${after}, before ${before}`)
})

test('next.to refuses a target tier that already ran, naming the direction and pin', async () => {
  let backwards
  const builtin = at(
    'builtin',
    mod('classic.PreToolUse', async (event, next) => {
      try {
        await next.to(event, 'append')
      } catch (error) {
        backwards = error
      }
      return next(event)
    }),
  )
  await runChain(guardedCall(), [
    at('append', mod('classic.PreToolUse', (event, next) => next(event))),
    builtin,
  ])
  assert.match(backwards.message, /would move backwards/)
  assert.match(backwards.message, /5281-5289/)

  let sameTier
  await runChain(
    guardedCall(),
    [
      at(
        'append',
        mod('classic.PreToolUse', async (event, next) => {
          try {
            await next.to(event, 'append')
          } catch (error) {
            sameTier = error
          }
          return next(event)
        }),
      ),
    ],
  )
  assert.match(sameTier.message, /would move backwards/)
})
