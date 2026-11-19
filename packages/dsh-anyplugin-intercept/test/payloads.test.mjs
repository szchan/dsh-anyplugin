// Calibrate the kernel against upstream payload shapes, not against our reading
// of the docs. Every fixture under fixtures/hooks/ is run through runChain:
// the event table must cover it, the matcher must narrow on the right field,
// and a rewrite must survive to the deepest handler.
//
// Fixtures are the authority for shape (see fixtures/hooks/PROVENANCE.md); this
// file is the authority for what the kernel does with that shape.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CLASSIC_HOOK_EVENTS,
  CLASSIC_SUBJECT_FIELD,
  classicSubject,
  CONTINUE,
  runChain,
} from '../src/index.ts'

const root = new URL('../../../fixtures/hooks/', import.meta.url)
const readAll = (kind) => readdirSync(new URL(`${kind}/`, root))
  .filter((name) => name.endsWith('.json'))
  .map((name) => {
    const record = JSON.parse(readFileSync(new URL(`${kind}/${name}`, root), 'utf8'))
    return { file: name.slice(0, -'.json'.length), ...record }
  })

const documented = readAll('payloads')
const captured = readAll('captured')

test('every fixture event is in the pinned event table, and vice versa', () => {
  const fixtures = [...new Set([...documented, ...captured].map((f) => f.payload.hook_event_name))].sort()
  assert.deepEqual(fixtures, [...CLASSIC_HOOK_EVENTS].sort(),
    'fixtures/hooks/*/ and CLASSIC_HOOK_EVENTS must name the same events')
})

test('each fixture is titled by its own hook_event_name', () => {
  for (const fixture of [...documented, ...captured]) {
    assert.equal(fixture.payload.hook_event_name, fixture.file,
      `${fixture.file}: hook_event_name disagrees with the file name`)
    assert.ok(fixture.__provenance?.source, `${fixture.file}: missing provenance`)
  }
})

test('a subject is derived only from a field the payload actually carries', () => {
  for (const fixture of [...documented, ...captured]) {
    const field = CLASSIC_SUBJECT_FIELD[fixture.file]
    const subject = classicSubject({ name: fixture.file, data: fixture.payload })
    if (field === undefined) {
      assert.equal(subject, '', `${fixture.file}: unlisted event must not invent a subject`)
      continue
    }
    const value = fixture.payload[field]
    assert.equal(subject, typeof value === 'string' ? value : '',
      `${fixture.file}: subject must come from ${field}`)
  }
})

test('matchers narrow tool events on tool_name', async () => {
  const pre = documented.find((f) => f.file === 'PreToolUse')
  const write = documented.find((f) => f.file === 'PostToolUse')
  const run = (payload, matcher) => runChain(
    { name: payload.hook_event_name, data: payload },
    [{
      event: payload.hook_event_name,
      tier: 'user',
      matcher,
      source: `probe:${matcher}`,
      run: () => CONTINUE,
    }],
  )

  const hit = await run(pre.payload, '^Bash$')
  assert.deepEqual(hit.trace.map((s) => s.status), ['ran'])
  assert.equal(classicSubject({ name: 'PreToolUse', data: pre.payload }), 'Bash')

  const miss = await run(write.payload, '^Bash$')
  assert.deepEqual(miss.trace.map((s) => s.status), ['skipped-matcher'])

  const tool = await run(write.payload, 'Write')
  assert.deepEqual(tool.trace.map((s) => s.status), ['ran'])
})

test('a rewrite reaches the deepest handler intact', async () => {
  const pre = documented.find((f) => f.file === 'PreToolUse')
  let seen
  const result = await runChain(
    { name: pre.payload.hook_event_name, data: pre.payload },
    [{
      event: 'PreToolUse',
      tier: 'user',
      source: 'probe:rewriter',
      run: (_context, event, next) => next({
        ...event,
        data: { ...event.data, tool_input: { ...event.data.tool_input, command: 'echo rewritten' } },
      }),
    }, {
      event: 'PreToolUse',
      tier: 'user',
      source: 'probe:observer',
      run: (_context, event) => {
        seen = event.data.tool_input.command
        return { kind: 'deny', reason: 'stop here' }
      },
    }],
  )
  assert.equal(seen, 'echo rewritten')
  assert.deepEqual(result.decision, { kind: 'deny', reason: 'stop here' })
})

test('captured variants may carry fields the docs do not show', () => {
  // Direction matters: a doc example that omits a field is not evidence the
  // field is absent. prompt_id is the known case.
  const submit = captured.find((f) => f.file === 'UserPromptSubmit')
  assert.ok(Object.hasOwn(submit.payload, 'prompt_id'),
    'the capture is the record that prompt_id is sent')
  const documentedKeys = new Set(Object.keys(documented.find((f) => f.file === 'UserPromptSubmit').payload))
  for (const key of documentedKeys) {
    assert.ok(Object.hasOwn(submit.payload, key),
      `capture lost a documented field: ${key}`)
  }
})
