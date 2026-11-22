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
  MOD_OP_EVENTS,
  MOD_PINNED_EVENTS,
  MOD_UNMAPPED_CATEGORIES,
  MOD_UNMAPPED_REASONS,
  classicEvent,
  classicHookRegistration,
  describeTrace,
  modRegistrationsToKernel,
  modUnmappedCategory,
  pauseWhilePending,
  runChain,
} from '../src/index.ts'

const mod = (event, handler, matcher = undefined) => ({ event, matcher, handler })

const adapt = (registrations, options = {}) =>
  modRegistrationsToKernel(registrations, { plugin: 'synthetic', entry: 'kernel.ts', ...options })

const ENGINE_AT_2_1_329 = [
  'tool.call',
  'tool.check',
  'tool.judge',
  'tool.run',
  'ui.render',
  'ui.resolve',
  'ui.press',
  'ui.input',
  'ui.select',
  'ui.message',
  'ui.fault',
  'ui.pointer',
  'ui.scroll',
  'ui.focus',
  'agent.offer',
  'agent.spawn',
  'agent.report',
  'prompt.submit',
  'prompt.fill',
  'prompt.suggest',
  'prompt.edit',
  'prompt.change',
  'prompt.autocomplete',
  'prompt.section',
  'prompt.context',
  'prompt.compose',
  'prompt.attachment',
  'prompt.mention',
  'tool.describe',
  'tool.offer',
  'command.run',
  'command.describe',
  'config.set',
  'config.describe',
  'telemetry.log',
  'telemetry.mark',
  'skill.prompt',
  'attribution.text',
  'vcs.detect',
  'vcs.diff',
  'vcs.isolate',
  'vcs.list',
  'vcs.status',
  'vcs.release',
  'session.start',
  'session.receive',
  'session.append',
  'session.send',
  'session.compact',
  'session.attach',
  'session.detach',
  'session.measure',
  'session.stop',
  'session.end',
  'plugin.register',
  'turn.start',
  'turn.step',
  'turn.complete',
  'engine.create',
]

test('every pinned mod event is routed or unmapped with a reason', () => {
  assert.equal(MOD_CLASSIC_EVENTS.length, 33)
  assert.deepEqual(MOD_ENGINE_EVENTS, ENGINE_AT_2_1_329)
  assert.equal(MOD_EVENT_ROUTES.length, 24)
  assert.equal(Object.keys(MOD_UNMAPPED_REASONS).length, 143)

  const routed = new Set(MOD_EVENT_ROUTES.map((route) => route.modEvent))
  for (const event of MOD_CLASSIC_EVENTS) {
    const name = `classic.${event}`
    assert.ok(routed.has(name) || MOD_UNMAPPED_REASONS[name] !== undefined, `${name} is missing from the mapping`)
    assert.ok(!(routed.has(name) && MOD_UNMAPPED_REASONS[name] !== undefined), `${name} is both routed and unmapped`)
  }
  for (const event of MOD_PINNED_EVENTS) {
    assert.ok(routed.has(event) || MOD_UNMAPPED_REASONS[event] !== undefined, `${event} is missing from the mapping`)
    assert.ok(!(routed.has(event) && MOD_UNMAPPED_REASONS[event] !== undefined), `${event} is both routed and unmapped`)
  }
  assert.equal(MOD_OP_EVENTS.length, 75)
  for (const route of MOD_EVENT_ROUTES) {
    assert.ok(route.kernelEvent.length > 0, route.modEvent)
    assert.ok(route.hostSeam.length > 0, route.modEvent)
    assert.ok(route.evidence.length > 0, route.modEvent)
    if (route.modEvent.startsWith('classic.')) {
      assert.ok(CLASSIC_HOOK_EVENTS.includes(route.kernelEvent), `${route.modEvent} has no shared classic point`)
    }
  }
  // 21 live classic routes plus session.start, tool.call and prompt.context.
  assert.equal(MOD_EVENT_ROUTES.filter((route) => route.status === 'live').length, 24)
  const start = MOD_EVENT_ROUTES.find((route) => route.modEvent === 'session.start')
  assert.equal(start.kernelEvent, 'session.start')
  assert.equal(start.hostSeam, 'mod-host/load')
  assert.equal(start.status, 'live')
  assert.equal(start.reason, undefined)
  assert.equal(MOD_PINNED_EVENTS.length, 167)
  assert.equal(new Set(MOD_PINNED_EVENTS).size, 167)
  // The two partial classic payloads record the S9 caveat.
  const permissionRequest = MOD_EVENT_ROUTES.find((route) => route.kernelEvent === 'PermissionRequest')
  const permissionDenied = MOD_EVENT_ROUTES.find((route) => route.kernelEvent === 'PermissionDenied')
  assert.match(permissionRequest.caveat, /no tool_input/)
  assert.match(permissionDenied.caveat, /no tool name/)
  // #69 routes tool.call and prompt.context; tool.check stays a measured
  // refusal because it is the engine's later permission verdict, not the
  // pre-execution gate.
  const toolCall = MOD_EVENT_ROUTES.find((route) => route.modEvent === 'tool.call')
  assert.equal(toolCall.kernelEvent, 'PreToolUse')
  assert.equal(toolCall.hostSeam, 'tools/pre-execute')
  assert.equal(toolCall.payload, 'tool-call-envelope')
  const promptContext = MOD_EVENT_ROUTES.find((route) => route.modEvent === 'prompt.context')
  assert.equal(promptContext.kernelEvent, 'PromptContext')
  assert.equal(promptContext.hostSeam, 'system-prompt/assemble')
  assert.equal(promptContext.payload, 'prompt-context')
  assert.equal(MOD_UNMAPPED_REASONS['tool.call'], undefined)
  assert.equal(MOD_UNMAPPED_REASONS['prompt.context'], undefined)
  assert.match(MOD_UNMAPPED_REASONS['tool.check'], /permission verdict/)
  assert.match(MOD_UNMAPPED_REASONS['tool.check'], /next\.origin/)
})

test('the 19 engine events added at 2.1.329 carry an explicit category', () => {
  const added = {
    'tool.judge': 'no host event',
    'tool.run': 'no host event',
    'ui.fault': 'no host event',
    'ui.pointer': 'no host event',
    'agent.report': 'no host event',
    'prompt.change': 'no host event',
    'prompt.autocomplete': 'no host event',
    'prompt.mention': 'no host event',
    'tool.offer': 'no host event',
    'telemetry.log': 'no host event',
    'telemetry.mark': 'no host event',
    'vcs.detect': 'no host event',
    'vcs.diff': 'no host event',
    'vcs.isolate': 'no host event',
    'vcs.list': 'no host event',
    'vcs.status': 'no host event',
    'vcs.release': 'no host event',
    'session.send': 'no host event',
    'session.stop': 'no host event',
  }
  assert.equal(Object.keys(added).length, 19)
  for (const [event, category] of Object.entries(added)) {
    assert.equal(modUnmappedCategory(event), category, event)
    assert.ok(MOD_UNMAPPED_REASONS[event], `${event} has no reason`)
    assert.doesNotMatch(MOD_UNMAPPED_REASONS[event], /not an event/, `${event} must name a host gap, not "not in spec"`)
  }
  for (const event of ['vcs.detect', 'vcs.diff', 'vcs.isolate', 'vcs.list', 'vcs.status', 'vcs.release']) {
    assert.match(MOD_UNMAPPED_REASONS[event], /no vcs event/)
    assert.match(MOD_UNMAPPED_REASONS[event], /ERR_MOD_HOST_VCS_UNSUPPORTED/)
  }
  for (const event of MOD_OP_EVENTS) {
    assert.equal(modUnmappedCategory(event), 'no host event', event)
    assert.match(MOD_UNMAPPED_REASONS[event], /OpEventOf/)
  }
  // Every pinned-but-unmapped name is classified; only names outside the pin
  // are `not in spec`, so a typo in a mod does not read like a host gap.
  for (const event of Object.keys(MOD_UNMAPPED_REASONS)) {
    assert.notEqual(modUnmappedCategory(event), 'not in spec', event)
  }
  assert.equal(Object.keys(MOD_UNMAPPED_CATEGORIES).length, 143)
  assert.equal(modUnmappedCategory('made.up'), 'not in spec')
  assert.equal(modUnmappedCategory('post.tool.use'), 'not in spec')
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
  // Default seating is where a person's plugins sit, never core (d.ts:9899 at the 2.1.329 pin).
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
  assert.match(result.unmapped[1].reason, /not an event in EngineEventOf\/ClassicEventOf at the 2\.1\.329 pin/)
  assert.equal(result.unmapped[1].category, 'not in spec')
  assert.equal(result.unmapped[0].category, 'no host event')
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
      // `next` runs the remainder: the classic link settles inside the mod's
      // call and is recorded before the caller's own step.
      [1, 'user', 'hook#0', 'ran'],
      [0, 'prepend', 'synthetic/kernel.ts#0', 'ran'],
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

test('tool.call hands the mod a ToolCallEnvelope and turns { deny } into a kernel deny', async () => {
  let payload
  const { registrations, unmapped } = adapt([
    mod('tool.call', async (event) => {
      payload = event
      return { deny: 'the mod says no' }
    }, { tool: 'Bash' }),
  ])
  assert.equal(unmapped.length, 0)
  assert.equal(registrations.length, 1)
  const event = {
    name: 'PreToolUse',
    subject: 'Bash',
    data: { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'ls' }, cwd: '/work' },
  }
  const result = await runChain(event, registrations)
  assert.deepEqual(payload, { command: 'ls', tool: 'Bash', tool_use_id: 'toolu_1' })
  assert.deepEqual(result.decision, { kind: 'deny', reason: 'the mod says no' })
  assert.deepEqual(result.trace.map((entry) => entry.decision), ['deny'])
})

test('tool.call { result } is a typed hard unsupported, never a silent kernel result', async () => {
  const { registrations } = adapt([mod('tool.call', async () => ({ result: { stdout: 'replaced' } }))])
  const result = await runChain(
    { name: 'PreToolUse', subject: 'Bash', data: { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'ls' } } },
    registrations,
  )
  assert.equal(result.decision.kind, 'unsupported')
  assert.equal(result.decision.field, 'result')
  assert.equal(result.decision.hard, true)
  assert.match(result.decision.reason, /tools\/pre-execute/)
})

test('tool.call refuses the classic { allow } projection as a named non-pin field', async () => {
  const { registrations } = adapt([mod('tool.call', async () => ({ allow: true }))])
  const result = await runChain(
    { name: 'PreToolUse', subject: 'Bash', data: { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'ls' } } },
    registrations,
  )
  assert.equal(result.decision.kind, 'unsupported')
  assert.equal(result.decision.field, 'allow')
  assert.equal(result.decision.hard, true)
  assert.match(result.decision.reason, /not a ToolCallResult field/)
})

test('tool.check is refused as the engine permission verdict, not the pre-execute gate', () => {
  const { registrations, unmapped } = adapt([mod('tool.check', () => ({ decision: 'deny' }))])
  assert.equal(registrations.length, 0)
  assert.equal(unmapped.length, 1)
  assert.equal(unmapped[0].event, 'tool.check')
  assert.equal(unmapped[0].category, 'no host event')
  assert.match(unmapped[0].reason, /permission verdict/)
  assert.match(unmapped[0].reason, /next\.origin/)
  assert.match(unmapped[0].reason, /tools\/pre-execute/)
})

test('prompt.context hands the mod { blocks, instructionFiles } and carries an appended block back', async () => {
  let payload
  let resolved
  const { registrations, unmapped } = adapt([
    mod('prompt.context', async (event, next) => {
      payload = event
      resolved = await next(event)
      return { blocks: [...payload.blocks, { name: 'fixture-context', text: 'PROMPT-CONTEXT-FIXTURE' }] }
    }, { instructionFiles: { kind: 'project' } }),
  ])
  assert.equal(unmapped.length, 0)
  const event = {
    name: 'PromptContext',
    subject: null,
    data: {
      blocks: [{ name: 'claudeMd', text: 'baseline' }],
      instructionFiles: [{ path: '/work/AGENTS.md', kind: 'project', content: 'rules' }],
    },
  }
  const result = await runChain(event, registrations)
  assert.deepEqual(payload, event.data)
  assert.deepEqual(resolved, event.data)
  assert.equal(result.decision.kind, 'result')
  assert.deepEqual(result.decision.result.blocks, [
    { name: 'claudeMd', text: 'baseline' },
    { name: 'fixture-context', text: 'PROMPT-CONTEXT-FIXTURE' },
  ])
})

test('a classic.* pattern expands to the 21 live classic routes and reports the other 12', () => {
  const { registrations, routes, unmapped } = adapt([mod('classic.*', () => undefined)])
  assert.equal(registrations.length, 21)
  assert.equal(routes.length, 21)
  assert.equal(unmapped.length, 12)
  assert.ok(registrations.every((registration) => CLASSIC_HOOK_EVENTS.includes(registration.event)))
  assert.ok(unmapped.every((entry) => entry.event.startsWith('classic.')))
  assert.match(unmapped.find((entry) => entry.event === 'classic.Notification').reason, /S9 refuted/)
  assert.match(registrations[0].source, /\[classic\./)
  // The loader point is not part of the classic namespace.
  assert.ok(!registrations.some((registration) => registration.event === 'session.start'))
})

test('a * pattern expands to every routed name and reports the 143 without a route', () => {
  const { registrations, unmapped } = adapt([mod('*', () => undefined)])
  assert.equal(registrations.length, 24)
  assert.equal(unmapped.length, 143)
  assert.ok(registrations.some((registration) => registration.event === 'session.start'))
  assert.ok(unmapped.some((entry) => entry.event === 'ui.render'))
})

test('tool.* reaches the routed tool.call and reports the seven other tool events', () => {
  const { registrations, unmapped } = adapt([mod('tool.*', () => undefined)])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].event, 'PreToolUse')
  assert.deepEqual(unmapped.map((entry) => entry.event), [
    'tool.check',
    'tool.judge',
    'tool.run',
    'tool.describe',
    'tool.offer',
    'tool.list',
    'tool.register',
  ])
  assert.ok(unmapped.every((entry) => entry.reason.length > 0))
})

test('a negation selects the complement: !tool.* excludes every tool route', () => {
  const { registrations, unmapped } = adapt([mod('!tool.*', () => undefined)])
  assert.equal(registrations.length, 23)
  assert.equal(unmapped.length, 136)
  assert.ok(registrations.every((registration) => !registration.event.startsWith('tool.')))
  assert.ok(!unmapped.some((entry) => entry.event.startsWith('tool.')))
  const engineOnly = adapt([mod('!classic.*', () => undefined)])
  assert.equal(engineOnly.registrations.length, 3)
  assert.deepEqual(engineOnly.registrations.map((registration) => registration.event).sort(), ['PreToolUse', 'PromptContext', 'session.start'])
  assert.equal(engineOnly.unmapped.length, 131)
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
  // In fan-out next(e) runs the remainder eagerly, but it still resolves the
  // kernel's continue, not ClassicResultOf: the mod does not re-decide the
  // classic arm's decision (D32 §6).
  assert.equal(fanOutNext, undefined)
  assert.deepEqual(order, ['mod-first', 'classic', 'mod-last'])
  assert.deepEqual(
    result.trace.map((entry) => [entry.source, entry.status]),
    [['hook#0', 'ran'], ['synthetic/kernel.ts#1', 'ran'], ['synthetic/kernel.ts#0', 'ran']],
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
    {
      index: 2,
      plugin: 'append#0',
      tier: 'append',
      event: 'classic.PreToolUse',
      outcome: 'passed',
    },
  ])
  assert.equal(Object.isFrozen(seenBeneath), true)
  assert.equal(Object.isFrozen(seenBeneath[0]), true)
  // The append link ran inside the mod's next call, so it is recorded before
  // the prepend hook's own step; nothing it never saw leaves.
  assert.deepEqual(result.trace.map((entry) => [entry.index, entry.status]), [[1, 'skipped'], [2, 'ran'], [0, 'ran']])
  assert.equal(result.decision.kind, 'continue')
})

test('next.to only moves forward and never re-enters a tier', async () => {
  const ran = []
  const guard = mod('classic.PreToolUse', async (event, next) => {
    // `prepend` is not a legal target at the pin. `user` is legal for a
    // prepend hook and lands on the next tier; a tier at or above the caller
    // would re-enter the chain and is refused.
    await assert.rejects(next.to(event, 'prepend'), /takes "user", "append" or "builtin"/)
    return next.to(event, 'user')
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

test('next.to refuses prepend, the core tier this chain cannot serve, and nonsense', async () => {
  const failures = []
  const guard = mod('classic.PreToolUse', async (event, next) => {
    for (const tier of ['prepend', 'core', 'nonsense']) {
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

  assert.equal(failures.length, 3)
  for (const tier of ['prepend', 'nonsense']) {
    assert.equal(failures.find((failure) => failure.tier === tier).name, 'TypeError')
    assert.match(failures.find((failure) => failure.tier === tier).message, /takes "user", "append" or "builtin"/)
  }
  const core = failures.find((failure) => failure.tier === 'core')
  assert.equal(core.name, 'TypeError')
  assert.match(core.message, /not served/)
  assert.match(core.message, /16473/)
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
  // The caller's `next.to` runs the sibling and the append trip inside the
  // call, so the caller pushes its marker last.
  assert.deepEqual(ran, ['second', 'append', 'first'])
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

test('fan-out: next.trace reports the trip the call just ran', async () => {
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
  // The call ran the remainder eagerly, so the classic link beneath it has
  // settled and is reported; the caller's own step is recorded after it returns.
  assert.deepEqual(beneath.map((entry) => [entry.tier, entry.outcome]), [['user', 'passed']])
  assert.equal(Object.isFrozen(beneath), true)
  assert.deepEqual(result.trace.map((entry) => [entry.source, entry.status]), [['user#0', 'ran'], ['synthetic/kernel.ts#0', 'ran']])
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
  // The guard's eager jump runs the sibling and append inside the call.
  assert.deepEqual(ran, ['sibling', 'append', 'guard'])
  assert.deepEqual(result.trace.filter((entry) => entry.tier === 'prepend').map((entry) => entry.status), ['ran', 'ran'])
})

test('a second next call starts a second trip; the latest trip is the one it sees', async () => {
  const seen = []
  let beneath
  const prepend = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next({ ...event, command: 'First' })
      await next({ ...event, command: 'Second' })
      beneath = next.trace
    }),
  )
  const user = at(
    'user',
    mod('classic.PreToolUse', (event, next) => {
      seen.push(event.command)
      return next(event)
    }),
  )
  const result = await runChain(guardedCall(), [prepend, user])
  assert.deepEqual(seen, ['First', 'Second'], 'each call runs the remainder')
  // The kernel trace keeps both trips; the mod projection describes the latest
  // one only, as the pin says (`trace` is "its latest next() call").
  assert.deepEqual(result.trace.map((entry) => [entry.tier, entry.status]), [
    ['user', 'ran'],
    ['user', 'ran'],
    ['prepend', 'ran'],
  ])
  assert.deepEqual(beneath.map((entry) => [entry.index, entry.tier]), [[1, 'user']])
})

test('fan-out: a second next call also runs the remainder a second time', async () => {
  const seen = []
  const caller = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      await next({ ...event, command: 'First' })
      await next({ ...event, command: 'Second' })
    }),
  )
  const user = at(
    'user',
    mod('classic.PreToolUse', (event, next) => {
      seen.push(event.command)
      return next(event)
    }),
  )
  const result = await runChain(guardedCall(), [caller, user], { continuation: 'fan-out' })
  assert.deepEqual(seen, ['First', 'Second'])
  assert.deepEqual(result.trace.map((entry) => [entry.tier, entry.status]), [
    ['user', 'ran'],
    ['user', 'ran'],
    ['prepend', 'ran'],
  ])
})

test('two same-tier handlers that both jump: each to owns its own trip', async () => {
  for (const continuation of ['first-decision', 'fan-out']) {
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
        // The sibling's own target belongs to the trip it starts; it is not
        // attributed to the guard's call above it.
        await next.to(event, 'append')
      }),
    )
    const append = at(
      'append',
      mod('classic.PreToolUse', async (event, next) => {
        ran.push('append')
        return next(event)
      }),
    )
    const builtin = at(
      'builtin',
      mod('classic.PreToolUse', async (event, next) => {
        ran.push('builtin')
        return next(event)
      }),
    )
    const result = await runChain(guardedCall(), [guard, sibling, append, builtin], { continuation })
    assert.deepEqual(ran, ['sibling', 'append', 'builtin', 'guard'], continuation)
    assert.equal(result.decision.kind, 'continue')
    // append ran once, builtin ran once: the guard's jump did not drop them.
    assert.equal(result.trace.filter((entry) => entry.tier === 'append').length, 1)
    assert.equal(result.trace.filter((entry) => entry.tier === 'builtin').length, 1)
  }
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
  assert.match(backwards.message, /8289-8367/)

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

test('fan-out: an unawaited next runs the remainder exactly once', async () => {
  for (const continuation of ['first-decision', 'fan-out']) {
    const seen = []
    const guard = at(
      'prepend',
      mod('classic.PreToolUse', (event, next) => {
        // Deliberately not awaited: the host must still join the trip once.
        void next(event)
      }),
    )
    const user = classicHookRegistration({
      event: 'PreToolUse',
      source: 'user#0',
      run: () => {
        seen.push('user')
      },
    })
    const append = observeAt('append', () => {
      seen.push('append')
    })
    const result = await runChain(guardedCall(), [guard, user, append], { continuation })
    assert.deepEqual(seen, ['user', 'append'], continuation)
    assert.equal(result.decision.kind, 'continue')

    // The same join covers an unawaited item.to: the pass-over runs once.
    const jumped = []
    const jumper = at(
      'prepend',
      mod('classic.PreToolUse', (event, next) => {
        void next.to(event, 'append')
      }),
    )
    const passOver = observeAt('user', () => {
      jumped.push('user')
    })
    const target = observeAt('append', () => {
      jumped.push('append')
    })
    const second = await runChain(guardedCall(), [jumper, passOver, target], { continuation })
    assert.deepEqual(jumped, ['append'], continuation)
    assert.equal(second.decision.kind, 'continue')
  }
})

test('mixed unawaited then awaited: the second next.trace is only its own trip', async () => {
  for (const continuation of ['first-decision', 'fan-out']) {
    const order = []
    let beneath
    const guard = at(
      'prepend',
      mod('classic.PreToolUse', async (event, next) => {
        void next(event)
        await next(event)
        beneath = next.trace
      }),
    )
    const user = observeAt('user', () => {
      order.push('user')
    })
    const append = observeAt('append', () => {
      order.push('append')
    })
    const result = await runChain(guardedCall(), [guard, user, append], { continuation })
    // The unawaited first call settles before the second trip starts, so each
    // link runs once per trip, in order.
    assert.equal(beneath.length, 2, continuation)
    assert.deepEqual(order, ['user', 'append', 'user', 'append'], continuation)
    assert.deepEqual(
      beneath.map((entry) => [entry.index, entry.tier, entry.outcome]),
      [
        [1, 'user', 'passed'],
        [2, 'append', 'passed'],
      ],
      continuation,
    )
    assert.equal(result.decision.kind, 'continue')
  }
})

test('a second trip can name a different target tier', async () => {
  for (const continuation of ['first-decision', 'fan-out']) {
    const runs = { append: 0, builtin: 0 }
    const caller = at(
      'prepend',
      mod('classic.PreToolUse', async (event, next) => {
        await next.to(event, 'append')
        await next.to(event, 'builtin')
      }),
    )
    const append = at(
      'append',
      mod('classic.PreToolUse', (event, next) => {
        runs.append += 1
        return next(event)
      }),
    )
    const builtin = at(
      'builtin',
      mod('classic.PreToolUse', (event, next) => {
        runs.builtin += 1
        return next(event)
      }),
    )
    const result = await runChain(guardedCall(), [caller, append, builtin], { continuation })
    assert.deepEqual(runs, { append: 1, builtin: 2 }, continuation)
    assert.equal(result.decision.kind, 'continue')
  }
})

test('fan-out: next resolves continue while a classic deny/text stays the host decision', async () => {
  for (const classicDecision of [
    { kind: 'deny', reason: 'no' },
    { kind: 'text', text: 'note' },
  ]) {
    let seen = 'unset'
    const caller = at(
      'prepend',
      mod('classic.PreToolUse', async (event, next) => {
        seen = await next(event)
      }),
    )
    const classic = classicHookRegistration({
      event: 'PreToolUse',
      source: 'user#0',
      run: () => classicDecision,
    })
    const result = await runChain(guardedCall(), [caller, classic], { continuation: 'fan-out' })
    // D32 §6: a fan-out mod's next() resolves the kernel's continue, not the
    // classic arm's result; the host still keeps the classic decision.
    assert.equal(seen, undefined)
    assert.deepEqual(result.decision, classicDecision)
  }
})

test('budget: the caller meter stands still across two trips', async () => {
  const readings = []
  const caller = at(
    'prepend',
    mod('classic.PreToolUse', async (event, next) => {
      readings.push(next.budget.remainingMs)
      await next(event)
      readings.push(next.budget.remainingMs)
      await next(event)
      readings.push(next.budget.remainingMs)
    }),
    { timeoutMs: 500 },
  )
  const downstream = at(
    'user',
    mod('classic.PreToolUse', async (event, next) => {
      await sleep(50)
      return next(event)
    }),
    { timeoutMs: 1_000 },
  )
  await runChain(guardedCall(), [caller, downstream], { deadlineMs: 5_000 })
  const [first, second, third] = readings
  assert.ok(
    Math.abs(first - second) <= 30 && Math.abs(second - third) <= 30,
    `readings ${readings.join(', ')}`,
  )
})

test('same-tier named jumps: the nested target wins over the outer one', async () => {
  for (const continuation of ['first-decision', 'fan-out']) {
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
        // The innermost named target decides where the remainder continues;
        // the outer target is never reached and must not run it as well.
        await next.to(event, 'builtin')
      }),
    )
    const append = at(
      'append',
      mod('classic.PreToolUse', (event, next) => {
        ran.push('append')
        return next(event)
      }),
    )
    const builtin = at(
      'builtin',
      mod('classic.PreToolUse', (event, next) => {
        ran.push('builtin')
        return next(event)
      }),
    )
    const result = await runChain(guardedCall(), [guard, sibling, append, builtin], { continuation })
    assert.deepEqual(ran, ['sibling', 'builtin', 'guard'], continuation)
    assert.equal(result.decision.kind, 'continue')
    assert.equal(
      result.trace.some((entry) => entry.tier === 'append' && entry.status === 'skipped'),
      true,
      continuation,
    )
  }
})
