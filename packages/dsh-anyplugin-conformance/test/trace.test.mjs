// Trace oracle: a recorded host turn must normalize into a diffable event
// sequence, and normalization must erase exactly the things that are not
// behavior (paths, ids, timestamps) and nothing else.
//
// The recorded file is the standard answer for D16: on Claude Code 2.1.322,
// "use a skill" is a Skill tool call with {skill, args}, a "Launching skill"
// tool result, then one user message with the base directory and the
// already-substituted body.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  diffTraces,
  normalizeTrace,
  readTraceFile,
} from '../src/trace.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const tracePath = join(repoRoot, 'fixtures', 'traces', 'claude-code-2.1.322', 'skills-only-greet.jsonl')
const options = { root: '/tmp/evalprobe' }

const recorded = readTraceFile(tracePath)
const events = normalizeTrace(recorded, options)

test('a recorded turn normalizes to the documented skill delivery', () => {
  assert.deepEqual(events, [
    { kind: 'init', tools: ['Glob', 'Grep', 'Read', 'Skill', 'Task', 'TaskStop', 'ToolSearch'] },
    { kind: 'tool-call', name: 'Skill', input: { skill: 'skills-only:greet', args: 'Ada' } },
    { kind: 'tool-result', text: 'Launching skill: skills-only:greet' },
    {
      kind: 'user-text',
      text: 'Base directory for this skill: <plugin>/skills/greet\n\nGreet Ada.\n',
    },
    { kind: 'assistant-text', text: 'Hello, Ada!' },
  ])
})

test('a trace compared with itself has zero differences', () => {
  const diff = diffTraces(events, events)
  assert.equal(diff.summary.differing, 0)
  assert.equal(diff.summary.onlyLeft, 0)
  assert.equal(diff.summary.onlyRight, 0)
  assert.equal(diff.summary.matched, events.length)
})

test('one changed delivery row is exactly one difference', () => {
  const mutated = events.map((event, index) =>
    index === 3 ? { kind: 'user-text', text: 'Base directory for this skill: <plugin>/skills/greet\n\nGreet Bob.\n' } : event,
  )
  const diff = diffTraces(events, mutated)
  assert.equal(diff.summary.differing, 1)
  assert.equal(diff.rows.filter((row) => row.status === 'differ').length, 1)
  const [row] = diff.rows.filter((entry) => entry.status === 'differ')
  assert.equal(row.index, 3)
  assert.equal(row.status, 'differ')
})

test('ids and paths are scrubbed, so a rerun on another machine still matches', () => {
  const rerun = recorded.map((record) => {
    const json = JSON.stringify(record)
    return JSON.parse(
      json
        .split('call_00_ET_2bcfKnnskBTKVF3M2N2Z4856').join('call_00_ZZZZZZZZZZZZZZZZZZZZZZZZ')
        .split('d30da0be-502b-44a4-b2b7-1a851dc48ee7').join('11111111-2222-3333-4444-555555555555')
        .split('/tmp/evalprobe').join('/home/someone/.claude/plugins/cache/market/plugin/2.1.322')
        .split('2026-11-19T08:01:31.755Z').join('2030-01-01T00:00:00.000Z'),
    )
  })
  const diff = diffTraces(
    events,
    normalizeTrace(rerun, { root: '/home/someone/.claude/plugins/cache/market/plugin/2.1.322' }),
  )
  assert.equal(diff.summary.differing, 0)
  assert.equal(diff.summary.onlyLeft, 0)
  assert.equal(diff.summary.onlyRight, 0)
})

test('an extra event reads as only-right rather than shifting the rest', () => {
  const longer = [...events, { kind: 'tool-result', text: 'extra' }]
  const diff = diffTraces(events, longer)
  assert.equal(diff.summary.differing, 0)
  assert.equal(diff.summary.onlyRight, 1)
  assert.equal(diff.summary.matched, events.length)
})

test('a malformed line names the file and line, not the whole trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'))
  const file = join(dir, 'bad.jsonl')
  writeFileSync(file, '{"type":"system"}\n{oops}\n', 'utf8')
  assert.throws(() => readTraceFile(file), /bad\.jsonl:2: /u)
  rmSync(dir, { recursive: true, force: true })
})
