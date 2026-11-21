// The guard is the repository's own call-time policy. These tests drive the
// public `apply` mount with a fake context and assert the verdict a call would
// actually get, plus the two composition paths a reviewer runs by hand:
// `guardTable` (the dry-run proof) and `renderBlock`/`applyBlock` (the install
// block). They are deliberately adversarial: every deny case has an allow case
// one flag away, so a rule that fires on the wrong thing fails here.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply, agentCwd, isWorker } from '../src/index.ts'
import {
  BLOCK_START,
  applyBlock,
  composeGuard,
  formatTable,
  guardTable,
  readBlock,
  renderBlock,
  runTable,
} from '../src/composition.ts'
import { currentBranch, isMainRef } from '../src/git.ts'
import { messageText, renderBrief } from '../src/brief.ts'
import { judgeCall, resolvePolicy } from '../src/policy.ts'

const checkout = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/u, '')
const repo = '/work/repo'
const worktree = '/work/wt/ticket-80'
const config = {
  worktrees: [worktree],
  protectedRoots: [repo],
  brief: {
    ratchet: ['25 declared / 24 matched / 0 missing / 1 refused'],
    fixtures: '14 fixtures',
    open: ['mcpServers:a-server-name-that-is-long-enough:refused'],
  },
}

const worker = { id: 'worker-1', cwd: repo, worker: true }
const root = { id: 'root-1', cwd: repo, worker: false }

function verdict(tool, args, agent = worker, branch = 'ticket/80') {
  const checkoutBranch = branch === null ? undefined : branch
  return judgeCall(
    { tool, args, agent, ...(agent.worker ? { worktree } : {}) },
    resolvePolicy(config),
    { branch: () => checkoutBranch },
  )
}

const shell = (command, agent = worker, branch = 'ticket/80') =>
  verdict('bash', { command }, agent, branch)

test('a push to main is denied for every role; the ticket branch is allowed', () => {
  for (const agent of [worker, root]) {
    assert.equal(shell('git push origin main', agent).kind, 'deny')
    assert.equal(shell('git push origin HEAD:main', agent).kind, 'deny')
    assert.equal(shell('git push origin +refs/heads/main:refs/heads/main', agent).kind, 'deny')
    assert.equal(shell('git push --all origin', agent).kind, 'deny')
    assert.equal(shell('git push origin --delete main', agent).kind, 'deny')
    assert.equal(shell('git -C /work/repo push origin master', agent).kind, 'deny')
  }
  assert.equal(shell('git push -u origin ticket/80').kind, 'allow')
  assert.equal(shell('cd /work/wt/ticket-80 && git push origin ticket/80').kind, 'allow')
})

test('a bare push is judged by the current branch, and an unknown branch is refused', () => {
  assert.equal(shell('git push', worker, 'main').kind, 'deny')
  assert.equal(shell('git push', worker, 'ticket/80').kind, 'allow')
  const unknown = shell('git push', worker, null)
  assert.equal(unknown.kind, 'deny')
  assert.match(unknown.reason, /refspec|branch/u)
})

test('a nested shell in bash -c cannot smuggle the push past the guard', () => {
  assert.equal(shell(`bash -c 'git push origin main'`).kind, 'deny')
  assert.equal(shell(`sh -lc "git push origin main"`).kind, 'deny')
  assert.equal(shell('git status --short && git push origin main').kind, 'deny')
  assert.equal(shell('sudo -u root git push origin main').kind, 'deny')
})

test('gh pr merge is denied for a worker and allowed for the root', () => {
  const denied = shell('gh pr merge 82 --squash --delete-branch', worker)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /gh-pr-merge-worker/u)
  assert.equal(shell('gh pr merge 82 --squash', root).kind, 'allow')
  assert.equal(shell('gh pr view 82', worker).kind, 'allow')
})

test('DECISIONS.md is append-only: every writer is denied except the sanctioned update', () => {
  assert.equal(verdict('write', { file_path: `${worktree}/docs/DECISIONS.md`, content: '## D99' }).kind, 'deny')
  assert.equal(verdict('edit', { file_path: `${worktree}/docs/DECISIONS.md`, old_string: 'a', new_string: 'b' }).kind, 'deny')
  assert.equal(shell(`${worktree}/docs/DECISIONS.md`).kind, 'allow')
  assert.equal(shell('printf x >> docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('sed -i s/a/b/ docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('git checkout -- docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('cp /tmp/decisions.md docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('node -e "require(\'fs\').writeFileSync(\'docs/DECISIONS.md\', \'\')"').kind, 'deny')
  assert.equal(shell('node scripts/check-decisions.mjs --update').kind, 'allow')
  assert.equal(shell('npm run check:decisions -- --update').kind, 'allow')
})

test('writes are confined to the recorded worktree, with the main checkout protected', () => {
  assert.equal(verdict('write', { file_path: `${worktree}/src/a.ts`, content: 'x' }).kind, 'allow')
  assert.equal(verdict('write', { file_path: `${repo}/packages/x/src/a.ts`, content: 'x' }).kind, 'deny')
  assert.equal(verdict('write', { file_path: '/tmp/elsewhere/a.ts', content: 'x' }).kind, 'deny')
  assert.equal(verdict('read', { file_path: `${repo}/README.md` }).kind, 'allow', 'reads are not writes')
  assert.equal(shell(`touch ${worktree}/notes.md`).kind, 'allow')
  assert.equal(shell(`touch ${repo}/notes.md`).kind, 'deny')
  const outside = shell('touch /tmp/elsewhere/notes.md')
  assert.equal(outside.kind, 'deny')
  assert.match(outside.reason, /worktree/u)
  assert.equal(verdict('apply_patch', { input: `*** Begin Patch\n*** Update File: ${worktree}/src/a.ts\n*** End Patch` }).kind, 'allow')
  assert.equal(verdict('apply_patch', { input: `*** Begin Patch\n*** Add File: ${repo}/src/b.ts\n*** End Patch` }).kind, 'deny')
})

test('a root agent is not confined, but is still bound by the push and decisions rules', () => {
  assert.equal(verdict('write', { file_path: `${repo}/README.md`, content: 'x' }, root).kind, 'allow')
  assert.equal(shell('git push origin main', root).kind, 'deny')
  assert.equal(verdict('write', { file_path: `${repo}/docs/DECISIONS.md`, content: 'x' }, root).kind, 'deny')
})

test('read-only and build commands stay allowed', () => {
  for (const command of ['npm run verify', 'git status --short', 'git log --oneline -5', 'rg "foo" packages', 'cat README.md']) {
    assert.equal(shell(command).kind, 'allow', command)
  }
})

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

test('the plugin mounts one pre-execute listener and denies before the tool runs', async () => {
  const { ctx, listeners, disposers } = harness()
  await apply(ctx, config)
  assert.equal(listeners.get('tools/pre-execute')?.length, 1)
  assert.equal(listeners.get('agent/pre-step')?.length, 1)
  assert.equal(disposers.length, 2, 'one ctx.effect per seam')

  const exec = (name, args, agent = worker) => ({ callId: 1, name, arguments: args, agent })
  let ran = 0
  const next = async () => {
    ran += 1
    return { kind: 'accept' }
  }
  const denied = await listeners.get('tools/pre-execute')[0](exec('bash', { command: 'git push origin main' }), next)
  assert.equal(denied.kind, 'deny')
  assert.equal(ran, 0, 'the host never executes a denied call')
  assert.equal(
    (await listeners.get('tools/pre-execute')[0](exec('bash', { command: 'npm run verify' }), next)).kind,
    'accept',
  )
  assert.equal(ran, 1)
})

test('the brief is appended to the worker continuation once, and never to the root', async () => {
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const preStep = listeners.get('agent/pre-step')[0]
  const continuation = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'runtime context' }] }],
  })

  const spawned = (id, prompt) => ({
    session: { header: { id, cwd: repo, ...(id === 'worker-1' ? { parentSession: 'root-1' } : {}) } },
    prompt,
  })
  const child = spawned('worker-1', `work in ${worktree}, ticket/80`)
  const first = await preStep({ agent: child, step: 1, messages: [{ role: 'user', content: `work in ${worktree}` }] }, continuation)
  assert.equal(first.messages.length, 2, 'the host continuation is kept and the brief appended')
  assert.equal(first.messages[0].content[0].text, 'runtime context')
  const brief = first.messages[1].content[0].text
  assert.match(brief, /<anyplugin-guard-brief>/u)
  assert.match(brief, new RegExp(worktree.replaceAll('/', '\\/'), 'u'))
  assert.match(brief, /25 declared \/ 24 matched \/ 0 missing \/ 1 refused/u)
  assert.match(brief, /14 fixtures/u)

  const second = await preStep({ agent: child, step: 2, messages: [] }, continuation)
  assert.equal(second.messages.length, 1, 'the brief is delivered at most once')

  const rootAgent = spawned('root-1', 'do the thing')
  const rootStep = await preStep({ agent: rootAgent, step: 1, messages: [] }, continuation)
  assert.equal(rootStep.messages.length, 1)
})

test('the worktree recorded from the spawn prompt is the one a write is confined to', async () => {
  const other = '/work/wt/ticket-81'
  const { ctx, listeners } = harness()
  await apply(ctx, { ...config, worktrees: [worktree, other] })
  const agent = { session: { header: { id: 'worker-2', cwd: repo, parentSession: 'root-1' } } }
  // The prompt names ticket-80, so that worktree is recorded even though two
  // are installed.
  await listeners.get('agent/pre-step')[0](
    { agent, step: 1, messages: [{ role: 'user', content: `work in ${worktree}, ticket/80` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 2, name: 'write', arguments: { file_path: `${other}/src/x.ts`, content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes(worktree), 'the reason names the recorded worktree')
  assert.equal(
    (
      await listeners.get('tools/pre-execute')[0](
        { callId: 3, name: 'write', arguments: { file_path: `${worktree}/src/x.ts`, content: 'x' }, agent },
        async () => ({ kind: 'accept' }),
      )
    ).kind,
    'accept',
  )
})

test('the dry-run table proves every payload against the same judge', () => {
  const cases = guardTable({ worktree, protectedRoot: repo })
  assert.ok(cases.length >= 20)
  const { rows, failures } = runTable(cases, config, { worktree, protectedRoot: repo })
  assert.deepEqual(failures, [], formatTable(rows))
})

test('the install block is marked, idempotent and refused when it would duplicate a plugin id', () => {
  const composition = composeGuard({
    repoRoot: checkout,
    worktrees: [
      { path: checkout, branch: 'main', main: true },
      { path: worktree, branch: 'ticket/80' },
      { path: '/work/wt/verify-x', branch: 'verify/x' },
    ],
  })
  assert.equal(composition.config.protectedRoots[0], checkout)
  assert.deepEqual(composition.config.worktrees, [worktree], 'only ticket worktrees are confinable')
  assert.match(composition.block, new RegExp(`^${BLOCK_START}`, 'u'))
  assert.match(composition.block, /- insert:/u)
  assert.match(composition.block, new RegExp(`id: "anyplugin-guard"`, 'u'))
  assert.match(composition.block, new RegExp(composition.source.replaceAll('/', '\\/'), 'u'))
  assert.match(composition.block, /25 declared \/ 24 matched \/ 0 missing \/ 1 refused/u)

  const fresh = applyBlock('[]\n', composition.block)
  assert.equal(fresh.startsWith(BLOCK_START), true, 'the empty-array marker is replaced, not stacked')
  assert.equal(applyBlock(fresh, composition.block), fresh, 'installing twice is a no-op')
  assert.equal(readBlock(fresh).present, true)

  const removed = applyBlock(fresh, null)
  assert.equal(removed, '', 'an empty patch file is invalid loader input; the script writes the [] marker')

  assert.throws(
    () => applyBlock(`- id: "anyplugin-guard"\n  name: "elsewhere.ts"\n`, composition.block),
    /already appears outside/u,
  )
})

test('renderBrief names the worktree, the ratchet and the rules; message text is flattened', () => {
  const brief = renderBrief({ worktree, cwd: repo, config: config.brief })
  assert.match(brief, /Write only inside that worktree, with absolute paths/u)
  assert.match(brief, /packages\/dsh-anyplugin-conformance\/test\/coverage\.test\.mjs/u)
  assert.match(brief, /mcpServers:a-server-name-that-is-long-enough:refused/u)
  assert.equal(
    messageText([
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: [{ type: 'text', text: 'block' }] },
    ]),
    'plain\nblock',
  )
})

test('currentBranch reads a worktree .git pointer and refuses a detached HEAD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-guard-git-'))
  try {
    const gitdir = join(dir, 'gitdir')
    mkdirSync(gitdir)
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/ticket/80\n')
    writeFileSync(join(dir, '.git'), `gitdir: ${gitdir}\n`)
    assert.equal(currentBranch(dir), 'ticket/80')
    writeFileSync(join(gitdir, 'HEAD'), 'abc123\n')
    assert.equal(currentBranch(dir), undefined)
    assert.equal(isMainRef('refs/heads/main'), true)
    assert.equal(isMainRef('refs/remotes/origin/master'), true)
    assert.equal(isMainRef('refs/heads/ticket/80'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the agent view reads role and cwd from the session header only', () => {
  assert.equal(isWorker({ session: { header: { parentSession: 'root' } } }), true)
  assert.equal(isWorker({ session: { header: {} } }), false)
  assert.equal(agentCwd({ session: { header: { cwd: '/work' } } }), '/work')
  assert.equal(agentCwd({ session: { header: { cwd: '' } } }), undefined)
})
