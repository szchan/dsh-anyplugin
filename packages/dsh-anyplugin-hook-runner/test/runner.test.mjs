// The runner is the part of the classic arm that can be tested without a
// harness: given a payload and a process, what did the hook decide?
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHookPayload,
  judgeHookResult,
  matcherMatches,
  runCommandHook,
} from '../src/index.ts'

const run = (command, payload = { hook_event_name: 'PreToolUse', cwd: '/tmp' }) =>
  runCommandHook({ command }, payload, { timeoutMs: 10_000 })

test('the payload carries only fields this host can honestly supply', () => {
  const payload = buildHookPayload('PreToolUse', {
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    toolUseId: 'call_probe',
    cwd: '/tmp',
  })
  assert.deepEqual(payload, {
    hook_event_name: 'PreToolUse',
    cwd: '/tmp',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'call_probe',
  })
  assert.equal('session_id' in payload, false, 'no invented session id')
  assert.equal('transcript_path' in payload, false)
  assert.equal('permission_mode' in payload, false)
})

test('stdin receives the payload as one JSON line', async () => {
  const result = await run('cat')
  assert.deepEqual(JSON.parse(result.stdout), { hook_event_name: 'PreToolUse', cwd: '/tmp' })
  assert.equal(result.exitCode, 0)
})

test('exit 2 blocks, and the reason is stderr', async () => {
  const verdict = judgeHookResult(await run('echo "not after midnight" >&2; exit 2'), 'PreToolUse')
  assert.equal(verdict.deny, 'not after midnight')
})

test('exit 2 with empty stderr still blocks, with a default reason', async () => {
  const verdict = judgeHookResult(await run('exit 2'), 'PreToolUse')
  assert.equal(verdict.deny, 'blocked by PreToolUse hook')
})

test('a JSON verdict can deny, or add context', async () => {
  const deny = judgeHookResult(
    await run(`printf '%s\\n' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no"}}'`),
    'PreToolUse',
  )
  assert.equal(deny.deny, 'no')

  const context = judgeHookResult(
    await run(`printf '%s\\n' '{"hookSpecificOutput":{"additionalContext":"remember the ticket"}}'`),
    'PostToolUse',
  )
  assert.equal(context.additionalContext, 'remember the ticket')
  assert.equal(context.deny, undefined)
})

test('plain stdout never reaches the model', async () => {
  const verdict = judgeHookResult(await run('echo formatted'), 'PostToolUse')
  assert.equal(verdict.additionalContext, undefined)
  assert.match(verdict.warn ?? '', /transcript only/)
})

test('continue:false is reported, not silently obeyed', async () => {
  const verdict = judgeHookResult(await run(`printf '%s\\n' '{"continue":false,"stopReason":"done"}'`), 'Stop')
  assert.equal(verdict.deny, undefined)
  assert.match(verdict.warn ?? '', /continue:false/)
})

test('a non-zero exit that is not 2 is a warning, not a block', async () => {
  const verdict = judgeHookResult(await run('echo "broken" >&2; exit 3'), 'PreToolUse')
  assert.equal(verdict.deny, undefined)
  assert.match(verdict.warn ?? '', /exited 3: broken/)
})

test('exec form runs without a shell', async () => {
  const result = await runCommandHook({ command: 'node', args: ['-e', 'process.stdout.write("exec-ok")'] }, {}, {})
  assert.equal(result.stdout, 'exec-ok')
})

test('a timeout kills the child instead of hanging the turn', async () => {
  const result = await runCommandHook({ command: 'sleep 5' }, {}, { timeoutMs: 150 })
  assert.equal(result.timedOut, true)
  assert.match(judgeHookResult(result, 'PreToolUse').warn ?? '', /timed out/)
})

test('matchers are regexes over the tool name, and a bad one matches nothing', () => {
  assert.equal(matcherMatches('Write|Edit', 'Edit'), true)
  assert.equal(matcherMatches('Write|Edit', 'Bash'), false)
  assert.equal(matcherMatches(undefined, 'Bash'), true)
  assert.equal(matcherMatches('*', 'Bash'), true)
  assert.equal(matcherMatches('(', 'Bash'), false)
})
