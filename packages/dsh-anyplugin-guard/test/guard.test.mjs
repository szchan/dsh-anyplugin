// The guard is the repository's own call-time policy. These tests drive the
// public `apply` mount with a fake context and assert the verdict a call would
// actually get, plus the two composition paths a reviewer runs by hand:
// `guardTable` (the dry-run proof) and `renderBlock`/`applyBlock` (the install
// block). They are deliberately adversarial: every deny case has an allow case
// one flag away, so a rule that fires on the wrong thing fails here.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'

import { apply, agentCwd, isWorker } from '../src/index.ts'
import {
  BLOCK_END,
  BLOCK_START,
  applyBlock,
  captureState,
  composeGuard,
  formatTable,
  guardTable,
  readBlock,
  readState,
  renderBlock,
  runTable,
  uninstallText,
} from '../src/composition.ts'
import { currentBranch, isMainRef } from '../src/git.ts'
import { messageText, renderBrief } from '../src/brief.ts'
import { judgeCall, resolvePolicy } from '../src/policy.ts'
import {
  hooksDirectory,
  installPrePushHook,
  prePushStatus,
  readPrePushHook,
  removePrePushHook,
  renderPrePushHook,
} from '../../../scripts/guard-hooks.mjs'

const checkout = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/u, '')
const repo = '/work/repo'
const worktree = '/work/wt/ticket-80'
const config = {
  worktrees: [worktree],
  protectedRoots: [repo],
  brief: {
    ratchet: ['25 declared / 24 matched / 0 missing / 1 refused'],
    fixtures: '11 fixtures',
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

test('a bare push is refused for every role: remote.<r>.push and push.default can retarget it', () => {
  // The two configs a bare push obeys: `remote.origin.push=refs/heads/main`
  // and `push.default=upstream` with `branch.ticket/80.merge=refs/heads/main`.
  // Reading git config is not needed when the ambiguous form is refused.
  for (const branch of ['main', 'ticket/80', null]) {
    const outcome = shell('git push', worker, branch)
    assert.equal(outcome.kind, 'deny')
    assert.equal(outcome.rule, 'git-push-bare')
    assert.match(outcome.reason, /remote.<name>.push|push.default|refspec/u)
  }
  assert.equal(shell('git push origin HEAD:refs/heads/ticket/80').kind, 'allow')
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
  assert.equal(shell(`${worktree}/docs/DECISIONS.md`).kind, 'deny', 'a bare path is not a command the guard can judge')
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

test('an alias, a git config write and an unknown subcommand cannot hide a push', () => {
  for (const command of [
    "git -c alias.p='push --no-verify origin main' p",
    "git config alias.p 'push --no-verify origin main'",
    'git config --global alias.p "push origin main"',
    'git config core.hooksPath /tmp/hooks',
    'git -c core.hooksPath=/tmp/hooks status',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-config-write', command)
  }
  assert.equal(shell('git config --get user.name').kind, 'allow', 'workers may read config')
  assert.equal(shell('git config --get alias.p', root).kind, 'allow', 'the root may read config')
  const unknown = shell('git p')
  assert.equal(unknown.kind, 'deny')
  assert.equal(unknown.rule, 'git-unknown-subcommand')
  assert.match(unknown.reason, /alias/u)
})

test('ordinary work survives: non-exec -c keys, local history verbs, reads and lease pushes', () => {
  for (const command of [
    'git -c user.name=X -c user.email=Y commit -m "x"',
    'git rebase main',
    'git stash',
    'git config --get user.name',
    'git config --list',
    'git push --force-with-lease origin ticket/80',
    'git push --force-if-includes origin ticket/80',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'allow', command)
  }
  for (const command of [
    'git -c core.fsmonitor=touch status',
    'git -c core.sshCommand="sh -c x" pull',
    'git -c core.pager=less log',
    'git -c diff.external=/tmp/x diff',
    'git -c filter.x.clean=/tmp/x status',
    'git -c credential.helper=/tmp/x fetch',
    'git -c gpg.program=/tmp/x log',
    'git config user.name X',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-config-write', command)
  }
  assert.equal(shell('git config user.name X', root).kind, 'allow', 'the root may write a non-exec key')
  const hooks = shell('git config core.hooksPath /tmp/hooks', root)
  assert.equal(hooks.kind, 'deny')
  assert.equal(hooks.rule, 'git-config-write')
})

test('a leading assignment on a worker git segment is refused', () => {
  for (const command of [
    'FOO=1 git push origin main',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=x git status',
    'env GIT_SSH_COMMAND="sh -c x" git fetch',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-env-prefix', command)
  }
  assert.equal(shell('FOO=1 git status', root).kind, 'allow', 'the root may carry an environment prefix')
})

test('wildcard and range refspecs are refused before they can address main', () => {
  for (const command of [
    'git push origin "refs/heads/*:refs/heads/ticket/*"',
    'git push origin "HEAD:refs/heads/*"',
    'git push origin "HEAD:ticket/[a-z]"',
    'git push origin "HEAD:refs/heads/main..tmp"',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-push-shape', command)
  }
})

test('literal process-spawn payloads are refused; a plain one-liner is not', () => {
  for (const command of [
    `node -e "require('child_process').execSync('git push origin main')"`,
    `python3 -c "import subprocess; subprocess.run(['git','push','origin','main'])"`,
    `ruby -e "system('git push origin main')"`,
    `php -r "system('git push origin main');"`,
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'interpreter-exec', command)
  }
  assert.equal(shell(`node -e "require('fs').readFileSync('README.md')"`).kind, 'allow')
})

test('send-pack, update-ref and --no-verify do not get a second route to main', () => {
  assert.equal(shell('git push --no-verify origin main').kind, 'deny')
  const send = shell('git send-pack ../remote.git HEAD:refs/heads/main')
  assert.equal(send.kind, 'deny')
  assert.equal(send.rule, 'git-push-plumbing')
  assert.match(send.reason, /send-pack/u)
  assert.equal(shell('git update-ref refs/heads/main HEAD').kind, 'deny')
})

test('exec config keys and the push shape are refused, not inspected', () => {
  for (const command of [
    "git -c core.fsmonitor='sh -c \"git push origin main\"' status",
    'git --config-env=core.fsmonitor=ENV status',
    "git -c Alias.p='push origin main' p",
    'git -c core.pager=less status',
    'git --config-env=alias.p=PAYLOAD p',
  ]) {
    for (const agent of [worker, root]) {
      const outcome = shell(command, agent)
      assert.equal(outcome.kind, 'deny', command)
      assert.equal(outcome.rule, 'git-config-write', command)
    }
  }
  assert.equal(shell('git -c core.quotepath=false status', root).kind, 'allow', 'a root may set a non-exec key')
  for (const command of [
    "git push --receive-pack='sh -c \"git push origin main\"' origin ticket/80",
    'git push --exec=/tmp/x origin ticket/80',
    'git push -o ci.skip origin main',
    'git push origin ticket/80 ticket/81',
    'git push ../remote.git main',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.ok(['git-push-exec', 'git-push-shape'].includes(outcome.rule), command + ' → ' + outcome.rule)
  }
})

test('here-strings, process substitution and /dev/stdin are refused', () => {
  assert.match(shell("sh -s <<< 'git push origin main'").reason, /here-string/u)
  assert.match(shell('bash <(echo git push origin main)').reason, /process substitution/u)

  for (const command of [
    "sh -s <<< 'git push origin main'",
    "bash <<< 'git push origin main'",
    'bash <(echo git push origin main)',
    "bash /dev/stdin <<< 'git push origin main'",
    "sh -c 'bash <(echo git push origin main)'",
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'shell-unmodelled', command)
  }
})

test('redirections that capture output are not background jobs', () => {
  for (const command of ['npm test 2>&1', 'npm run verify 2>&1 | tail -20', 'npm test 1>&2', `npm test > ${worktree}/out 2>&1`]) {
    assert.equal(shell(command).kind, 'allow', command)
  }
  assert.equal(shell('npm test &').kind, 'deny', 'a real background job is still refused')
})

test('$ is literal in single quotes and at a boundary that cannot start an expansion', () => {
  for (const command of [
    "awk '{print $1}' README.md",
    "echo '$HOME'",
    "sed 's/x$//' notes.md",
    'echo cost$',
    'echo $/path',
  ]) {
    assert.equal(shell(command).kind, 'allow', command)
  }
  for (const command of ['echo "$HOME"', 'echo $1', 'echo ${HOME}', 'echo $((1+2))']) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'shell-unmodelled', command)
  }
})

test('script files are unverified for workers; stdin and here-strings are refused', () => {
  const script = shell('bash scripts/test.sh')
  assert.equal(script.kind, 'deny')
  assert.equal(script.rule, 'shell-script-unverified')
  assert.match(script.reason, /does not read script contents/u)
  assert.equal(shell('bash scripts/test.sh', root).kind, 'allow', 'the root may run a committed script')
  for (const command of ["bash -s <<'EOF'\nrm -rf x\nEOF", "bash <<'EOF'\nrm -rf x\nEOF", "sh -s <<< 'git push origin main'", "bash <(echo git push origin main)", 'bash < /dev/stdin']) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'shell-unmodelled', command)
  }
})

test('ruby and php write payloads are refused like node and python', () => {
  for (const command of [
    `ruby -e 'File.write("/tmp/rx","a")'`,
    `ruby -e 'IO.write("/tmp/rx","a")'`,
    `php -r 'file_put_contents("/tmp/rx","a")'`,
    `php -r 'fopen("/tmp/rx","w")'`,
  ]) {
    assert.equal(shell(command).kind, 'deny', command)
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
  assert.equal(disposers.length, 4, 'two seam mounts plus the created/disposed pair')

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
  assert.match(brief, /11 fixtures/u)
  const message = first.messages[1]
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'the loop reads message.source; the id is a real UUID')
  assert.equal(message.source.kind, 'user', 'runtime-context is the snapshot kind; a queued prompt is user')
  assert.notEqual(message.source.kind, 'runtime-context')

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
  const agent = { session: { header: { id: 'worker-2', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
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

test('a reviewer prompt that names only the branch records no worktree and writes nothing', async () => {
  // The real review prompt shape: the branch under review is in the text, the
  // reviewer's cwd is the master checkout, and no worktree path is given.
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const reviewer = { session: { header: { id: 'reviewer-1', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const text = 'Review PR #89 on branch `ticket/80`. Do not merge. Report findings in a comment.'
  await listeners.get('agent/pre-step')[0](
    { agent: reviewer, step: 1, messages: [{ role: 'user', content: text }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  for (const path of [`${worktree}/src/a.ts`, `${repo}/src/a.ts`, 'notes.md']) {
    const denied = await listeners.get('tools/pre-execute')[0](
      { callId: 9, name: 'write', arguments: { file_path: path, content: 'x' }, agent: reviewer },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(denied.kind, 'deny', path)
    assert.match(denied.reason, /protected checkout|no worktree is recorded/u)
  }
})

test('a symlink inside the worktree does not become a write into the checkout', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-symlink-'))
  try {
    const inside = join(data, 'wt')
    const checkoutDir = join(data, 'repo')
    mkdirSync(inside, { recursive: true })
    mkdirSync(checkoutDir, { recursive: true })
    symlinkSync(checkoutDir, join(inside, 'link'), 'dir')
    assert.equal(
      judgeCall(
        { tool: 'write', args: { file_path: join(inside, 'link', 'x.md'), content: 'x' }, agent: { cwd: inside, worker: true }, worktree: inside },
        resolvePolicy({ worktrees: [inside], protectedRoots: [checkoutDir] }),
        { branch: () => 'ticket/80' },
      ).kind,
      'deny',
    )
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('a worker with no cwd cannot resolve a relative write and is refused', () => {
  const policy = resolvePolicy({ worktrees: [worktree], protectedRoots: [repo] })
  const call = { tool: 'write', args: { file_path: 'x.md', content: 'x' }, agent: { worker: true }, worktree }
  const outcome = judgeCall(call, policy, { branch: () => 'ticket/80' })
  assert.equal(outcome.kind, 'deny')
  assert.match(outcome.reason, /no cwd|absolute/u)
  const relative = judgeCall(
    { tool: 'write', args: { file_path: '../../../etc/x', content: 'x' }, agent: { worker: true, cwd: worktree }, worktree },
    policy,
    { branch: () => 'ticket/80' },
  )
  assert.equal(relative.kind, 'deny')
  assert.equal(relative.rule, 'write-outside-worktree')
})

test('shell bypasses are refused: >|, subshells, git write verbs and launchers', () => {
  assert.equal(shell(`echo x >| ${repo}/x`).kind, 'deny')
  assert.equal(shell(`(cd ${repo} && touch x)`).kind, 'deny')
  assert.equal(shell(`git restore ${repo}/x`).kind, 'allow', 'workspace-local restores are ordinary work')
  assert.equal(shell(`git clean -fd ${repo}`).kind, 'allow', 'workspace-local cleans are ordinary work')
  assert.equal(shell(`env -i git push origin main`).kind, 'deny')
  assert.equal(shell(`timeout 5 git push origin main`).kind, 'deny')
  assert.equal(shell(`nice -n 5 git push origin main`).kind, 'deny')
  assert.equal(shell(`echo $(printf 'git push origin main')`).kind, 'deny')
  assert.equal(shell('if true; then git push origin main; fi').kind, 'deny')
  assert.equal(shell(`tee ${worktree}/x.md < /tmp/in`).kind, 'allow', 'the read source is not a write target')
})

test('the reviewer bypass spellings are refused; ordinary commits are allowed', () => {
  const denied = (command, rule = 'shell-unmodelled') => {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, rule, command)
  }
  denied('git push origin main&')
  denied('{ git push origin main; }')
  denied('! git push origin main')
  denied('( git push origin main )')
  denied("git push origin $'main'")
  denied('find . -exec git push origin main +')
  denied("sh -s <<'EOF'\ngit push origin main\nEOF", 'shell-unmodelled')
  denied('echo "git push origin main" | sh')
  denied('stdbuf -o0 git push origin main')
  denied('. /tmp/evil.sh')
  denied('sudo --preserve-env git push origin main', 'git-push-main')
  assert.equal(shell('git commit -m "fix: a > b"').kind, 'allow', 'quoted commit text is not a redirect')
  assert.equal(shell('git commit -m "fix: a -> b"').kind, 'allow')
  assert.equal(shell('git commit -m "guard: a && b"').kind, 'allow', 'quoted && is text, not a separator')
  assert.equal(shell('git push origin HEAD:refs/heads/ticket/80').kind, 'allow')
  assert.equal(shell('node -e "console.log(1)"').kind, 'allow')
  denied('node -e "require(\'fs\').writeFileSync(\'/tmp/x\', \'y\')"', 'interpreter-write')
  denied('python3 -c "open(\'/tmp/x\', \'w\').write(\'y\')"', 'interpreter-write')
})

test('the installed pre-push hook refuses every spelling git resolves to main', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-hook-'))
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  try {
    const remote = join(data, 'remote.git')
    const local = join(data, 'repo')
    git(['init', '--bare', remote], data)
    git(['init', '-b', 'ticket/80', local], data)
    git(['config', 'user.email', 'guard@example.invalid'], local)
    git(['config', 'user.name', 'guard test'], local)
    writeFileSync(join(local, 'README.md'), 'guard hook test\n')
    git(['add', 'README.md'], local)
    git(['commit', '-m', 'seed'], local)
    git(['branch', 'main'], local)
    git(['remote', 'add', 'origin', remote], local)
    // Seed the remote main before the hook exists, so the delete case has a ref.
    git(['push', 'origin', 'main'], local)
    git(['checkout', 'main'], local)
    writeFileSync(join(local, 'MAIN.md'), 'ahead of the remote\n')
    git(['add', 'MAIN.md'], local)
    git(['commit', '-m', 'main is ahead'], local)
    git(['checkout', 'ticket/80'], local)
    git(['merge', '--ff-only', 'main'], local)
    writeFileSync(join(local, 'TICKET.md'), 'ticket work\n')
    git(['add', 'TICKET.md'], local)
    git(['commit', '-m', 'ticket is ahead'], local)

    const target = join(hooksDirectory(local), 'pre-push')
    assert.equal(prePushStatus(target), 'missing')
    installPrePushHook(target, renderPrePushHook())
    assert.equal(prePushStatus(target), 'current')
    assert.match(readFileSync(target, 'utf8'), /refs\/heads\/main/u)

    const push = (args) => spawnSync('git', ['push', ...args], { cwd: local, encoding: 'utf8' })
    for (const args of [
      ['origin', 'main'],
      ['origin', 'HEAD:main'],
      ['origin', '--all'],
      ['origin', '--mirror'],
      ['origin', ':main'],
    ]) {
      const result = push(args)
      assert.notEqual(result.status, 0, args.join(' '))
      assert.match(result.stderr, /anyplugin-guard/u, args.join(' '))
    }

    // A bare push is the config-dependent spelling: resolve it through the hook.
    git(['config', 'remote.origin.push', 'refs/heads/main'], local)
    assert.notEqual(push(['origin']).status, 0, 'remote.origin.push=refs/heads/main')
    git(['config', '--unset', 'remote.origin.push'], local)
    git(['config', 'push.default', 'upstream'], local)
    git(['config', 'branch.ticket/80.remote', 'origin'], local)
    git(['config', 'branch.ticket/80.merge', 'refs/heads/main'], local)
    assert.notEqual(push(['origin']).status, 0, 'push.default=upstream resolves to main')
    git(['config', '--unset', 'push.default'], local)
    git(['config', '--unset', 'branch.ticket/80.merge'], local)
    git(['config', '--unset', 'branch.ticket/80.remote'], local)

    const allowed = push(['origin', 'HEAD:refs/heads/ticket/80'])
    assert.equal(allowed.status, 0, allowed.stderr)

    removePrePushHook(target)
    assert.equal(prePushStatus(target), 'missing')
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('the tool layer refuses hook bypasses before a remote can move', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-bypass-'))
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  try {
    const remote = join(data, 'remote.git')
    const plumbing = join(data, 'plumbing.git')
    const local = join(data, 'repo')
    git(['init', '--bare', remote], data)
    git(['init', '--bare', plumbing], data)
    git(['init', '-b', 'main', local], data)
    git(['config', 'user.email', 'guard@example.invalid'], local)
    git(['config', 'user.name', 'guard test'], local)
    writeFileSync(join(local, 'README.md'), 'seed\n')
    git(['add', 'README.md'], local)
    git(['commit', '-m', 'seed'], local)
    git(['remote', 'add', 'origin', remote], local)
    git(['push', 'origin', 'main'], local)
    const seeded = git(['ls-remote', remote, 'refs/heads/main'], local).trim()
    assert.notEqual(seeded, '')

    git(['checkout', '-b', 'ticket/80'], local)
    writeFileSync(join(local, 'TICKET.md'), 'ticket\n')
    git(['add', 'TICKET.md'], local)
    git(['commit', '-m', 'ticket'], local)

    const guarded = (args) => {
      const outcome = shell(['git', ...args].join(' '))
      assert.equal(outcome.kind, 'deny', args.join(' '))
      return outcome
    }
    for (const args of [
      ['-c', 'alias.p=push --no-verify origin main', 'p'],
      ['config', 'alias.p', 'push --no-verify origin main'],
      ['-c', 'core.hooksPath=/tmp/hooks', 'push', 'origin', 'main'],
      ['push', '--no-verify', 'origin', 'main'],
      ['send-pack', plumbing, 'HEAD:refs/heads/main'],
    ]) {
      guarded(args)
    }
    assert.equal(git(['ls-remote', remote, 'refs/heads/main'], local).trim(), seeded, 'remote main did not move')
    assert.equal(git(['ls-remote', plumbing, 'refs/heads/main'], local).trim(), '', 'send-pack did not write')
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('a failed profile write rolls the pre-push hook back', () => {
  const profile = mkdtempSync(join(tmpdir(), 'guard-rollback-'))
  const hooks = hooksDirectory(checkout)
  const target = join(hooks, 'pre-push')
  const before = readPrePushHook(target)
  chmodSync(profile, 0o500)
  try {
    const result = spawnSync(process.execPath, ['scripts/guard-install.mjs', '--profile-dir', profile], {
      cwd: checkout,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.equal(readPrePushHook(target), before, 'the hook was restored when the patch could not be written')
  } finally {
    chmodSync(profile, 0o700)
    rmSync(profile, { recursive: true, force: true })
    if (before !== undefined) installPrePushHook(target, before)
    else removePrePushHook(target)
  }
})

test('guard:status refuses a duplicate id outside the block and a lone end marker', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-status-'))
  const patch = join(data, 'cordis.patch.yml')
  const status = () =>
    spawnSync(process.execPath, [join(checkout, 'scripts/guard-status.mjs'), '--profile-dir', data], {
      encoding: 'utf8',
    })
  try {
    writeFileSync(patch, '- id: "anyplugin-guard"\n')
    const duplicate = status()
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stdout, /duplicate - id/u)

    writeFileSync(patch, `${BLOCK_END}\n`)
    const marker = status()
    assert.notEqual(marker.status, 0)
    assert.match(marker.stderr, /end marker without a start marker/u)
    assert.doesNotMatch(marker.stderr, /\n\s+at /u, 'a broken profile is a clean refusal, not a stack')
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
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
  assert.equal(removed, '', 'the script restores the pre-install state rather than writing an empty patch')

  assert.throws(
    () => applyBlock(`- id: "anyplugin-guard"\n  name: "elsewhere.ts"\n`, composition.block),
    /already appears outside/u,
  )
  assert.throws(
    () => applyBlock(`- id: 'anyplugin-guard'\n  name: "single-quoted.ts"\n`, composition.block),
    /already appears outside/u,
    'YAML accepts both quote styles; the duplicate check must too',
  )
  assert.doesNotThrow(
    () => applyBlock('# - id: "anyplugin-guard" is a comment, not an entry\n', composition.block),
    'a comment naming the id is not a conflicting entry',
  )
})

test('uninstall restores an absent, empty, [] or content file exactly', () => {
  const state = (file, trailing = 0) => ({ file, trailing })
  const render = (installState) => renderBlock('guard.ts', { worktrees: [] }, installState)

  const absent = applyBlock('', render(state('absent')))
  assert.deepEqual(uninstallText(absent), { action: 'delete', content: '' })

  const empty = applyBlock('', render(state('empty', 1)))
  assert.deepEqual(uninstallText(empty), { action: 'write', content: '\n' })

  const array = applyBlock('[]\n', render(state('array', 1)))
  assert.deepEqual(uninstallText(array), { action: 'write', content: '[]\n' })

  const arrayBlank = applyBlock('[]\n', render(state('array', 2)))
  assert.deepEqual(uninstallText(arrayBlank), { action: 'write', content: '[]\n\n' }, 'trailing blank lines are restored byte-for-byte')

  const original = '- id: "other"'
  assert.equal(captureState(original).trailing, 0)
  const installed = applyBlock(original, render(captureState(original)))
  assert.deepEqual(uninstallText(installed), { action: 'write', content: original })
  assert.equal(readState(readBlock(installed).block)?.file, 'content')
})

test('a user row inside the managed block, and an unbalanced marker, are refused', () => {
  const composition = composeGuard({ repoRoot: checkout, worktrees: [{ path: checkout, branch: 'main', main: true }] })
  const tampered = [
    BLOCK_START,
    '- insert:',
    '    - id: "anyplugin-guard"',
    '      name: "ours.ts"',
    '- id: "user-entry"',
    BLOCK_END,
    '',
  ].join('\n')
  assert.throws(() => applyBlock(tampered, composition.block), /did not write/u)

  assert.throws(() => readBlock(`${BLOCK_START}\n- insert: []\n`), /start marker without an end marker/u)
  assert.throws(() => uninstallText(`${BLOCK_START}\n- insert: []\n`), /start marker without an end marker/u)
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
