import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { capture, git, gitTry, installFakeGh, setupRepo, withRepo } from './test-support.mjs'

import {
  BASE,
  DEFAULT_ROOT,
  PR_FIELDS,
  decideMerge,
  formatFailure,
  formatMergeCommand,
  parseArgs,
  parseWorktreeList,
  planWorktree,
  reviewPr,
  run,
  worktreeState,
  usage,
} from './pr-update.mjs'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'

function pull(overrides = {}) {
  return {
    number: 225,
    state: 'OPEN',
    isCrossRepository: false,
    baseRefName: 'main',
    headRefName: 'ticket/225',
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
    ...overrides,
  }
}

function collect() {
  const out = []
  const err = []
  return {
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

test('parseArgs reads the one pull request number', () => {
  assert.deepEqual(parseArgs(['225']), { pr: 225 })
  assert.deepEqual(parseArgs(['1']), { pr: 1 })
})

test('parseArgs answers --help without asking for a number', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true })
  assert.deepEqual(parseArgs(['-h']), { help: true })
})

test('parseArgs rejects everything else', () => {
  assert.throws(() => parseArgs([]), /exactly one pull request number/)
  assert.throws(() => parseArgs(['1', '2']), /exactly one pull request number/)
  assert.throws(() => parseArgs(['0']), /not a pull request number/)
  assert.throws(() => parseArgs(['-1']), /not a pull request number/)
  assert.throws(() => parseArgs(['1.5']), /not a pull request number/)
  assert.throws(() => parseArgs(['ticket/225']), /not a pull request number/)
  assert.throws(() => parseArgs(['9007199254740993']), /out of range/)
})

test('reviewPr accepts an open same-repo PR based on main', () => {
  assert.deepEqual(reviewPr(pull()), { ok: true })
})

test('reviewPr refuses a PR it must not update, and says why', () => {
  assert.match(reviewPr(pull({ number: 7, state: 'CLOSED' })).reason, /PR #7 is closed, not open/)
  assert.match(reviewPr(pull({ isCrossRepository: true })).reason, /comes from a fork/)
  assert.match(reviewPr(pull({ headRefName: BASE })).reason, /refusing to touch main/)
  assert.match(reviewPr(pull({ baseRefName: 'develop' })).reason, /targets develop, not main/)
  assert.match(reviewPr(pull({ headRefName: '' })).reason, /has no head branch/)
  assert.match(reviewPr(pull({ headRefOid: 'abc123' })).reason, /did not resolve to a 40-hex head/)
  assert.match(reviewPr(pull({ headRefOid: undefined })).reason, /did not resolve to a 40-hex head \(none\)/)
})

test('PR_FIELDS asks gh for the head and mergeable state the script decides on', () => {
  assert.match(PR_FIELDS, /headRefName/)
  assert.match(PR_FIELDS, /headRefOid/)
  assert.match(PR_FIELDS, /mergeable/)
  assert.match(PR_FIELDS, /baseRefName/)
  assert.match(PR_FIELDS, /isCrossRepository/)
})

test('parseWorktreeList keeps path, HEAD and branch, including detached worktrees', () => {
  const porcelain = [
    `worktree /tmp/anyplugin-wt/ticket-225`,
    `HEAD ${HEAD}`,
    `branch refs/heads/ticket/225`,
    '',
    `worktree /tmp/anyplugin-wt/review-220`,
    `HEAD ${OTHER}`,
    'detached',
    '',
    `worktree /home/szchan/Projects/dsh-anyplugin`,
    `HEAD ${OTHER}`,
    `branch refs/heads/main`,
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(porcelain), [
    { path: '/tmp/anyplugin-wt/ticket-225', head: HEAD, branch: 'refs/heads/ticket/225' },
    { path: '/tmp/anyplugin-wt/review-220', head: OTHER, branch: undefined },
    { path: '/home/szchan/Projects/dsh-anyplugin', head: OTHER, branch: 'refs/heads/main' },
  ])
  assert.deepEqual(parseWorktreeList(''), [])
})

test('planWorktree reuses the branch worktree when it is at the PR head', () => {
  const plan = planWorktree({
    worktrees: [{ path: '/tmp/anyplugin-wt/ticket-225', head: HEAD, branch: 'refs/heads/ticket/225' }],
    branch: 'ticket/225',
    number: 225,
    prHead: HEAD,
  })
  assert.deepEqual(plan, { action: 'existing', path: '/tmp/anyplugin-wt/ticket-225' })
})

test('planWorktree refuses a branch worktree that sits at a different commit', () => {
  const plan = planWorktree({
    worktrees: [{ path: '/tmp/anyplugin-wt/ticket-225', head: OTHER, branch: 'refs/heads/ticket/225' }],
    branch: 'ticket/225',
    number: 225,
    prHead: HEAD,
  })
  assert.equal(plan.action, 'blocked')
  assert.equal(plan.path, '/tmp/anyplugin-wt/ticket-225')
  assert.match(plan.reason, /not the PR head/)
})

test('planWorktree creates a temporary worktree from origin when origin is the PR head', () => {
  const plan = planWorktree({
    worktrees: [],
    branch: 'ticket/225',
    number: 225,
    prHead: HEAD,
    localHead: OTHER,
    remoteHead: HEAD,
  })
  assert.deepEqual(plan, {
    action: 'create',
    path: join(DEFAULT_ROOT, 'pr-225'),
    start: 'origin/ticket/225',
  })
})

test('planWorktree falls back to the local branch when it is the PR head', () => {
  const plan = planWorktree({
    worktrees: [],
    branch: 'ticket/225',
    number: 225,
    prHead: HEAD,
    localHead: HEAD,
    remoteHead: OTHER,
  })
  assert.deepEqual(plan, {
    action: 'create',
    path: join(DEFAULT_ROOT, 'pr-225'),
    start: 'ticket/225',
  })
})

test('planWorktree refuses to invent a commit when neither ref is the PR head', () => {
  const plan = planWorktree({
    worktrees: [],
    branch: 'ticket/225',
    number: 225,
    prHead: HEAD,
    localHead: OTHER,
    remoteHead: OTHER,
  })
  assert.equal(plan.action, 'blocked')
  assert.match(plan.reason, /run git fetch origin/)
})

test('planWorktree does not reuse a path it did not create', () => {
  const plan = planWorktree({
    worktrees: [],
    branch: 'ticket/225',
    number: 225,
    prHead: HEAD,
    remoteHead: HEAD,
    pathExists: true,
  })
  assert.equal(plan.action, 'blocked')
  assert.match(plan.reason, /already exists/)
})

test('planWorktree ignores a worktree for a different branch and honours the root', () => {
  const plan = planWorktree({
    worktrees: [{ path: '/somewhere/else', head: OTHER, branch: 'refs/heads/review/1' }],
    branch: 'review/2',
    number: 226,
    root: '/var/tmp/wt',
    prHead: HEAD,
    remoteHead: HEAD,
  })
  assert.deepEqual(plan, {
    action: 'create',
    path: '/var/tmp/wt/pr-226',
    start: 'origin/review/2',
  })
})

test('decideMerge keeps a clean merge, aborts a conflict, fails otherwise', () => {
  assert.deepEqual(decideMerge({ status: 0 }), { action: 'keep' })
  assert.deepEqual(decideMerge({ status: 0, conflicts: [] }), { action: 'keep' })

  const abort = decideMerge({ status: 1, conflicts: ['docs/WORKFLOW.md', 'scripts/ci.mjs'] })
  assert.equal(abort.action, 'abort')
  assert.deepEqual(abort.conflicts, ['docs/WORKFLOW.md', 'scripts/ci.mjs'])

  assert.deepEqual(decideMerge({ status: 1, conflicts: [] }), { action: 'fail' })
  assert.deepEqual(decideMerge({ status: 128 }), { action: 'fail' })
})

test('formatMergeCommand is the exact pinned line', () => {
  assert.equal(formatMergeCommand(225, HEAD), `gh pr merge 225 --squash --match-head-commit ${HEAD}`)
  assert.throws(() => formatMergeCommand(225, HEAD.slice(0, 8)), /not a 40-hex commit/)
  assert.throws(() => formatMergeCommand(225, HEAD.toUpperCase()), /not a 40-hex commit/)
  assert.throws(() => formatMergeCommand(0, HEAD), /not a pull request number/)
})

test('formatFailure names the step, the failed CI steps, and the log hint', () => {
  assert.deepEqual(
    formatFailure({
      step: 'ci',
      detail: 'run 42 concluded failure',
      head: HEAD,
      steps: [{ job: 'verify', step: 'Run npm run verify (rc.5)' }],
    }),
    [
      'pr:update: failed at ci: run 42 concluded failure',
      'pr:update:   failed step: verify :: Run npm run verify (rc.5)',
      `pr:update: log: npm run ci -- --head ${HEAD} --log-failed`,
    ],
  )
})

test('formatFailure leaves out the hint when there is no head to read a log for', () => {
  assert.deepEqual(formatFailure({ step: 'review', detail: 'PR #7 is closed' }), [
    'pr:update: failed at review: PR #7 is closed',
  ])
})

test('usage names the command and the boundaries', () => {
  const text = usage()
  assert.match(text, /usage: npm run pr:update <pr-number>/)
  assert.match(text, /never merges/)
  assert.match(text, /fork PR/)
})

test('run with no argument is a usage error, not a gh call', () => {
  const io = collect()
  assert.equal(run([], io), 2)
  assert.equal(io.stdout(), '')
  assert.match(io.stderr(), /usage: npm run pr:update <pr-number>/)
})

test('run --help prints the usage and exits 0', () => {
  const io = collect()
  assert.equal(run(['--help'], io), 0)
  assert.match(io.stdout(), /usage: npm run pr:update <pr-number>/)
  assert.equal(io.stderr(), '')
})

test('BASE is main, and it is the only base the script will merge into', () => {
  assert.equal(BASE, 'main')
})

test('a worktree with a merge already in progress is refused, never aborted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-update-state-'))
  writeFileSync(join(dir, 'f.txt'), 'base\n')
  const run = (args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc\n', stderr: '' }
    if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const state = worktreeState({ worktree: dir, run })
  assert.equal(state.action, 'refuse')
  assert.match(state.reason, /a merge is already in progress/)
  assert.match(state.reason, /will not/)
})

test('an unmerged index is refused as well', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-update-state-'))
  const run = (args) => {
    if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' }
    if (args[0] === 'diff') return { status: 0, stdout: 'f.txt\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const state = worktreeState({ worktree: dir, run })
  assert.equal(state.action, 'refuse')
  assert.match(state.reason, /unmerged paths in its index/)
  assert.match(state.reason, /will not/)
})

test('a dirty worktree is refused and a clean one is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-update-state-'))
  const clean = (args) => (args[0] === 'diff' ? { status: 0, stdout: '', stderr: '' } : { status: args[0] === 'rev-parse' ? 1 : 0, stdout: '', stderr: '' })
  assert.equal(worktreeState({ worktree: dir, run: clean }).action, 'merge')
  const dirty = (args) => {
    if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' }
    if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: ' M f.txt\n', stderr: '' }
  }
  assert.equal(worktreeState({ worktree: dir, run: dirty }).action, 'refuse')
  assert.match(worktreeState({ worktree: dir, run: dirty }).reason, /uncommitted changes/)
})

// --- run() against a real repository and a fake `gh` -----------------------
//
// These are the mutation guard for the preflight. If the `worktreeState` call
// in `run` is deleted, `git merge origin/main` starts inside the caller's
// merge, the conflict list it finds is mistaken for its own, and
// `git merge --abort` wipes the caller's state — the MERGE_HEAD and unmerged
// path assertions below then fail, so deleting the call cannot pass the suite.

test('run() refuses a worktree with a merge already in progress and leaves it alone', () => {
  const { root, repo } = setupRepo({ mainConflict: true })
  try {
    const merge = gitTry(repo, ['merge', 'origin/main'])
    assert.notEqual(merge.status, 0, 'setup must leave a real conflict')
    assert.equal(gitTry(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status, 0)
    const unmergedBefore = gitTry(repo, ['diff', '--name-only', '--diff-filter=U']).stdout
    assert.match(unmergedBefore, /file\.txt/)
    const remoteBefore = git(repo, ['rev-parse', 'refs/remotes/origin/ticket/225']).trim()

    installFakeGh(root)
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 1)
    assert.match(cap.stderr(), /failed at worktree: a merge is already in progress/)
    assert.doesNotMatch(cap.stderr(), /merging origin\/main/)
    // The caller's merge is intact: never aborted, never pushed.
    assert.equal(gitTry(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status, 0)
    assert.equal(gitTry(repo, ['diff', '--name-only', '--diff-filter=U']).stdout, unmergedBefore)
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/ticket/225']).trim(), remoteBefore)
    assert.equal(git(repo, ['show', 'HEAD:file.txt']).trim(), 'ticket')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run() refuses an unmerged index even when MERGE_HEAD is gone', () => {
  const { root, repo } = setupRepo({ mainConflict: true })
  try {
    assert.notEqual(gitTry(repo, ['merge', 'origin/main']).status, 0, 'setup must leave a real conflict')
    rmSync(join(repo, '.git', 'MERGE_HEAD'))
    const unmergedBefore = gitTry(repo, ['diff', '--name-only', '--diff-filter=U']).stdout
    assert.match(unmergedBefore, /file\.txt/)

    installFakeGh(root)
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 1)
    assert.match(cap.stderr(), /unmerged paths in its index/)
    assert.equal(gitTry(repo, ['diff', '--name-only', '--diff-filter=U']).stdout, unmergedBefore)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run() refuses a dirty worktree before merging', () => {
  const { root, repo } = setupRepo()
  try {
    writeFileSync(join(repo, 'file.txt'), 'dirty\n')
    installFakeGh(root)
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 1)
    assert.match(cap.stderr(), /uncommitted changes/)
    assert.doesNotMatch(cap.stderr(), /merging origin\/main/)
    assert.match(gitTry(repo, ['status', '--porcelain']).stdout, /file\.txt/)
    assert.equal(gitTry(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run() refuses a fork PR before reading the worktree', () => {
  const { root, repo } = setupRepo()
  try {
    installFakeGh(root, { pr: { isCrossRepository: true } })
    const before = git(repo, ['rev-parse', 'HEAD']).trim()
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 1)
    assert.match(cap.stderr(), /comes from a fork; its head branch is not ours to push/)
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run() merges origin/main, pushes, watches the push run, and prints the pinned merge line', () => {
  const { root, repo } = setupRepo({ mainAhead: true })
  try {
    const before = git(repo, ['rev-parse', 'HEAD']).trim()
    installFakeGh(root, {
      runs: [{ databaseId: 7, event: 'push', status: 'completed', conclusion: 'success', headSha: 'HEAD' }],
    })
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 0)
    const merged = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.notEqual(merged, before)
    assert.equal(git(repo, ['rev-list', '--parents', '-n', '1', merged]).trim().split(' ').length, 3, 'a merge commit, not a fast-forward')
    assert.equal(cap.stdout(), `gh pr merge 225 --squash --match-head-commit ${merged}\n`)
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/ticket/225']).trim(), merged)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The own-conflict abort is the one `run` path that writes and then undoes the
// worktree. If `git merge --abort` is deleted, the conflict this test's own
// merge left stays behind: MERGE_HEAD and the unmerged paths remain and the
// worktree is dirty, so the assertions below fail. The stderr lines are pinned
// exactly because the message claims a state ("the merge was aborted and
// nothing was pushed") that the following assertions verify.

test('run() aborts its own conflict, says so exactly, and leaves no merge state', () => {
  const { root, repo } = setupRepo({ mainConflict: true })
  try {
    const headBefore = git(repo, ['rev-parse', 'HEAD']).trim()
    const remoteBefore = git(repo, ['rev-parse', 'refs/remotes/origin/ticket/225']).trim()
    installFakeGh(root)
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 1)
    const stderr = cap.stderr()
    assert.match(stderr, /^pr:update: PR #225 ticket\/225 @ [0-9a-f]{8} \(mergeable CLEAN\)$/m)
    assert.match(stderr, /^pr:update: merging origin\/main in .+$/m)
    assert.match(
      stderr,
      /^pr:update: failed at merge: conflict in file\.txt; the merge was aborted and nothing was pushed$/m,
    )
    assert.equal(cap.stdout(), '')
    assert.equal(gitTry(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status, 1, 'the abort ran: no merge in progress')
    assert.equal(gitTry(repo, ['diff', '--name-only', '--diff-filter=U']).stdout, '', 'no unmerged paths left behind')
    assert.equal(gitTry(repo, ['status', '--porcelain']).stdout, '', 'the worktree is clean again')
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore)
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/ticket/225']).trim(), remoteBefore)
    assert.equal(git(repo, ['show', 'HEAD:file.txt']).trim(), 'ticket')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run() fails when the push does not update the PR head, and names both shas', () => {
  const { root, repo } = setupRepo({ mainAhead: true })
  try {
    const prHead = git(repo, ['rev-parse', 'HEAD']).trim()
    // The fake `gh` keeps reporting the pre-push head, as a stale PR API would.
    const readLog = installFakeGh(root, { pr: { headRefOid: prHead } })
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 1)
    const merged = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.notEqual(merged, prHead)
    assert.equal(cap.stdout(), '')
    assert.match(
      cap.stderr(),
      new RegExp(
        `^pr:update: failed at push: the PR head is still ${prHead.slice(0, 12)}, not ${merged.slice(0, 12)}; the push did not update this PR$`,
        'm',
      ),
    )
    // The push happened; only the PR's reported head is stale.
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/ticket/225']).trim(), merged)
    // One initial read, then the read after the push plus five re-reads.
    assert.equal(readLog().trim().split('\n').filter((line) => line.startsWith('pr view')).length, 7)
    assert.doesNotMatch(readLog(), /run list/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run() fails at fetch before the worktree is planned or touched', () => {
  const { root, repo } = setupRepo()
  try {
    git(repo, ['remote', 'set-url', 'origin', join(root, 'missing.git')])
    const headBefore = git(repo, ['rev-parse', 'HEAD']).trim()
    const readLog = installFakeGh(root)
    const cap = capture()
    const code = withRepo(repo, () => run(['225'], cap.io))

    assert.equal(code, 1)
    assert.match(cap.stderr(), /^pr:update: failed at fetch: /m)
    assert.doesNotMatch(cap.stderr(), /merging origin\/main/)
    assert.doesNotMatch(cap.stderr(), /waiting for the verify run/)
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore)
    assert.equal(gitTry(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status, 1)
    assert.equal(gitTry(repo, ['status', '--porcelain']).stdout, '')
    // Only the `gh pr view` that resolves the PR; no run was looked up.
    assert.deepEqual(readLog().trim().split('\n'), [`pr view 225 --repo szchan/dsh-anyplugin --json ${PR_FIELDS}`])
    // `origin` still serves the branch, so nothing was pushed by the failure.
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/ticket/225']).trim(), headBefore)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
