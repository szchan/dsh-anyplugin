import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.ts'
import { resolvePolicy } from '../src/policy.ts'
import { inTerritory, territoryRoots } from '../src/scope.ts'

const repo = '/work/repo'
const worktree = '/work/wt/ticket-80'
const config = {
  worktrees: ['/tmp/anyplugin-wt/ticket-*', worktree],
  protectedRoots: [repo, `${repo}/.git`],
}
const policy = resolvePolicy(config)
const accept = async () => ({ kind: 'accept' })

function harness() {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(listener), 1)
    },
    effect(register) {
      disposers.push(register())
    },
  }
  return { ctx, listeners, disposers }
}

test('the territory is the checkout and its ticket worktrees, nothing else', () => {
  assert.deepEqual(territoryRoots(policy), [repo], 'the .git entry is a write target, not a session cwd')
  assert.equal(inTerritory(repo, policy), true)
  assert.equal(inTerritory(`${repo}/packages/dsh-anyplugin-guard`, policy), true)
  assert.equal(inTerritory('/work/repository', policy), false, 'a bare prefix is not below the root')
  assert.equal(inTerritory('/work/wt/ticket-80/src', policy), true)
  assert.equal(inTerritory('/tmp/anyplugin-wt/ticket-225', policy), true)
  assert.equal(inTerritory('/tmp/anyplugin-wt/ticket-225/packages/x', policy), true)
  assert.equal(inTerritory('/tmp/anyplugin-wt/notes', policy), false, 'the star matches one segment, not a path')
  assert.equal(inTerritory(undefined, policy), false, 'a configured territory never guesses')
})

test('an unconfigured policy keeps the old global behaviour', () => {
  const empty = resolvePolicy({})
  assert.equal(inTerritory('/anywhere/at/all', empty), true)
})

test('outside the territory the guard does not judge, brief or record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-scope-'))
  process.env.DSH_ANYPLUGIN_AUDIT_DIR = dir
  const { ctx, listeners } = harness()
  await apply(ctx, config)

  const stranger = { session: { header: { id: 'stranger-1', cwd: '/home/someone/other-project' } } }
  let ran = 0
  const next = async () => {
    ran += 1
    return { kind: 'accept' }
  }
  const outcome = await listeners.get('tools/pre-execute')[0](
    { callId: 1, name: 'bash', arguments: { command: 'git push origin main' }, agent: stranger },
    next,
  )
  assert.deepEqual(outcome, { kind: 'accept' }, 'the call is not judged outside the territory')
  assert.equal(ran, 1)
  assert.equal(existsSync(join(dir, 'guard-denials.jsonl')), false, 'an inert guard writes no evidence')

  const step = await listeners.get('agent/pre-step')[0](
    { agent: { session: { header: { id: 'w', cwd: '/home/someone/other-project', origin: 'subagent' } } } },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
  )
  assert.equal(step.messages.length, 1, 'no brief outside the territory')
})

test('a session inside a ticket worktree is still governed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-scope-'))
  process.env.DSH_ANYPLUGIN_AUDIT_DIR = dir
  // The push rule reads the branch of the cwd, so the worktree has to exist.
  const checkout = mkdtempSync(join(tmpdir(), 'guard-scope-wt-'))
  execFileSync('git', ['init', '-q', '-b', 'ticket/225', checkout])
  const { ctx, listeners } = harness()
  await apply(ctx, { ...config, worktrees: [checkout], protectedRoots: [repo] })

  const agent = { session: { header: { id: 'worker-9', cwd: checkout, origin: 'subagent' } } }
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 2, name: 'bash', arguments: { command: 'git push origin main' }, agent },
    accept,
  )
  assert.equal(denied.kind, 'deny')
  const rows = readFileSync(join(dir, 'guard-denials.jsonl'), 'utf8').trim().split('\n')
  assert.equal(rows.length, 1)
  assert.equal(JSON.parse(rows[0]).cwd, checkout)
})
