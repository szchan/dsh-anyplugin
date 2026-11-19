// The kernel's contract. The skeleton ships with no consumers, so these tests
// are the whole specification of ordering, matching and decision protocol until
// the classic-hook front-end (v0.2) starts depending on them.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTINUE,
  TIER_ORDER,
  compileMatcher,
  describeTrace,
  resolveOrder,
  runChain,
} from '../src/index.ts'

const handler = (registration) => ({ event: 'PreToolUse', ...registration })

const event = (subject, extra = {}) => ({ name: 'PreToolUse', data: { subject, ...extra } })

test('the same registrations always resolve to the same order', () => {
  const registrations = [
    handler({ tier: 'builtin', source: 'a', run: () => {} }),
    handler({ tier: 'prepend', source: 'b', run: () => {} }),
    handler({ tier: 'append', source: 'c', run: () => {} }),
    handler({ tier: 'user', source: 'd', run: () => {} }),
    handler({ tier: 'user', source: 'e', run: () => {} }),
  ]
  const first = resolveOrder(registrations).map((entry) => entry.registration.source)
  const again = resolveOrder(registrations).map((entry) => entry.registration.source)
  // Same input, same order — every time.
  assert.deepEqual(first, ['b', 'd', 'e', 'c', 'a'])
  assert.deepEqual(again, first)
  // The tiers are the table's, not the install order's. Registration order only
  // breaks ties *inside* a tier, which is why reversing flips d and e.
  const tiers = resolveOrder([...registrations].reverse()).map((entry) => entry.registration.tier)
  assert.deepEqual(tiers, ['prepend', 'user', 'user', 'append', 'builtin'])
  assert.deepEqual([...TIER_ORDER], ['prepend', 'user', 'append', 'builtin'])
})

test('the matcher is a regex over the subject, compiled at registration', () => {
  assert.equal(compileMatcher(undefined).test('anything'), true)
  assert.equal(compileMatcher('*').test('anything'), true)
  assert.equal(compileMatcher('Write|Edit').test('Edit'), true)
  assert.equal(compileMatcher('Write|Edit').test('Bash'), false)
  assert.equal(compileMatcher('^Notebook').test('NotebookEdit'), true)
  assert.throws(() => compileMatcher('Write('), /not a valid regular expression/)
})

test('a matcher that does not match skips the handler and keeps the chain', async () => {
  const seen = []
  const result = await runChain(event('Bash'), [
    handler({ tier: 'prepend', matcher: 'Write|Edit', source: 'formatter', run: () => { seen.push('formatter') } }),
    handler({ tier: 'user', source: 'audit', run: (ctx, current) => { seen.push('audit'); assert.equal(current.data.subject, 'Bash') } }),
  ])
  assert.deepEqual(seen, ['audit'])
  assert.deepEqual(result.trace.map((step) => step.status), ['skipped-matcher', 'ran'])
  assert.deepEqual(result.decision, CONTINUE)
})

test('the first decision ends the chain', async () => {
  const seen = []
  const result = await runChain(event('Bash'), [
    handler({ tier: 'prepend', source: 'guard', run: () => ({ kind: 'deny', reason: 'not allowed' }) }),
    handler({ tier: 'builtin', source: 'runner', run: () => { seen.push('runner') } }),
  ])
  assert.deepEqual(result.decision, { kind: 'deny', reason: 'not allowed' })
  assert.deepEqual(seen, [])
  assert.deepEqual(result.trace.map((step) => step.source), ['guard'])
})

test('a rewrite is visible downstream and in the result', async () => {
  const result = await runChain(event('Bash', { command: 'ls' }), [
    handler({
      tier: 'prepend',
      source: 'rewriter',
      run: (ctx, current, next) => next({ ...current, data: { ...current.data, command: 'ls -la' } }),
    }),
    handler({
      tier: 'builtin',
      source: 'runner',
      run: (ctx, current) => ({ kind: 'result', result: current.data.command }),
    }),
  ])
  assert.deepEqual(result.decision, { kind: 'result', result: 'ls -la' })
  assert.equal(result.event.data.command, 'ls -la')
})

test('next.to(tier) jumps forward and never loops backwards', async () => {
  const seen = []
  const run = (tier) => handler({
    tier: 'prepend',
    source: 'skipper',
    run: (ctx, current, next) => { seen.push('skipper'); return next(undefined, tier) },
  })
  const middle = handler({ tier: 'user', source: 'user-hook', run: (ctx, current, next) => { seen.push('user-hook'); return next() } })
  const last = handler({ tier: 'builtin', source: 'builtin', run: () => { seen.push('builtin'); return { kind: 'approve' } } })

  await runChain(event('Bash'), [run('builtin'), middle, last])
  assert.deepEqual(seen, ['skipper', 'builtin'])

  // A tier that already ran resumes at the next handler rather than restarting.
  seen.length = 0
  await runChain(event('Bash'), [run('prepend'), middle, last])
  assert.deepEqual(seen, ['skipper', 'user-hook', 'builtin'])
})

test('a throwing handler is skipped and recorded, never propagated', async () => {
  const result = await runChain(event('Bash'), [
    handler({ tier: 'prepend', source: 'broken', run: () => { throw new Error('boom') } }),
    handler({ tier: 'builtin', source: 'runner', run: () => ({ kind: 'result', result: 'ran' }) }),
  ])
  assert.deepEqual(result.decision, { kind: 'result', result: 'ran' })
  assert.deepEqual(result.trace[0], {
    source: 'broken',
    tier: 'prepend',
    index: 0,
    status: 'error',
    detail: 'boom',
  })
})

test('a handler that exceeds its budget is aborted and skipped', async () => {
  const result = await runChain(event('Bash'), [
    handler({ tier: 'prepend', source: 'slow', timeoutMs: 25, run: () => new Promise(() => {}) }),
    handler({ tier: 'builtin', source: 'runner', run: () => ({ kind: 'text', text: 'ok' }) }),
  ])
  assert.deepEqual(result.decision, { kind: 'text', text: 'ok' })
  assert.equal(result.trace[0].status, 'timeout')
  assert.match(result.trace[0].detail, /exceeded 25ms/)
})

test('the trace is deterministic and readable', async () => {
  const registrations = [
    handler({ tier: 'user', matcher: 'Write', source: 'b', run: () => {} }),
    handler({ tier: 'prepend', source: 'a', run: () => {} }),
  ]
  const first = await runChain(event('Bash'), registrations)
  const second = await runChain(event('Bash'), registrations)
  assert.deepEqual(first.trace, second.trace)
  assert.deepEqual(describeTrace(first.trace), ['0 prepend/a: ran', '1 user/b: skipped-matcher'])
})

test('a wrapper that declines to continue ends the chain and says so', async () => {
  const seen = []
  const result = await runChain(event('Bash'), [
    handler({ tier: 'user', mode: 'wrap', source: 'guarded', run: () => { seen.push('guarded') } }),
    handler({ tier: 'append', source: 'after', run: () => { seen.push('after') } }),
  ])
  assert.deepEqual(seen, ['guarded'])
  assert.deepEqual(describeTrace(result.trace), ['0 user/guarded: not-called'])
  assert.deepEqual(result.decision, CONTINUE)
})
