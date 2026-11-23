// CLI-level tests for `scripts/integrate.mjs` (#263).
//
// The pure decisions are tested directly. `run` is then driven once with a fake
// git and a fake gh that record the command sequence — that is the dry
// end-to-end check the ticket asks for — and against real repositories with the
// fake `gh` from `test-support.mjs` for the behind, up-to-date and conflict
// paths, so the actual `git merge`/`git push` are exercised. What is asserted
// throughout is the promise the role makes: one refspec, no force, no push to
// main, no merge, no code edit, and a merge line that is only ever printed.

import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import test from 'node:test'

import {
  PREFLIGHT_FIELDS,
  formatMergeCommand,
  formatWorktreeAdd,
  parseArgs,
  run,
  usage,
  worktreeProblem,
} from './integrate.mjs'
import { capture, git, gitTry, installFakeGh, setupRepo, withRepo } from './test-support.mjs'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const NEW = 'fedcba9876543210fedcba9876543210fedcba98'
const OTHER = '89abcdef0123456789abcdef0123456789abcdef'
const WORKTREE = '/tmp/anyplugin-wt/ticket-225'
const ROOT = process.env.ANYPLUGIN_WORKTREE_ROOT ?? '/tmp/anyplugin-wt'

function pull(overrides = {}) {
  return {
    number: 225,
    state: 'OPEN',
    isCrossRepository: false,
    baseRefName: 'main',
    headRefName: 'ticket/225',
    headRefOid: HEAD,
    ...overrides,
  }
}

function porcelain({ path = WORKTREE, head = HEAD, branch = 'ticket/225' } = {}) {
  return `worktree ${path}\nHEAD ${head}\nbranch refs/heads/${branch}\n`
}

/** A git stand-in: records every call; an unregistered command is a test bug. */
function fakeGit(responders) {
  const calls = []
  const runGit = (args, cwd, options = {}) => {
    calls.push({ args: [...args], cwd })
    const responder = responders[args.join(' ')]
    if (responder === undefined) throw new Error(`unexpected git call: ${args.join(' ')}`)
    const result = { status: 0, stdout: '', stderr: '', ...(typeof responder === 'function' ? responder() : responder) }
    if (result.status !== 0 && options.allowFailure !== true) {
      const error = new Error(`git ${args.join(' ')} exited ${result.status}`)
      error.status = result.status
      throw error
    }
    return result
  }
  return { calls, runGit }
}

/** A gh stand-in; `headAfterPush` is what the post-push `headRefOid` read returns. */
function fakeGh(pr, { headAfterPush = pr.headRefOid } = {}) {
  const calls = []
  const gh = (args) => {
    calls.push([...args])
    const fields = args.includes('--json') ? args[args.indexOf('--json') + 1] : ''
    if (fields === 'headRefOid') return { headRefOid: headAfterPush }
    return { ...pr }
  }
  return { calls, gh }
}

/** The branch is one commit behind origin/main; the merge creates NEW. */
function behindGit({ push = { status: 0 } } = {}) {
  return fakeGit({
    'worktree list --porcelain': { stdout: porcelain() },
    'rev-parse --verify --quiet MERGE_HEAD': { status: 1 },
    'diff --name-only --diff-filter=U': { stdout: '' },
    'status --porcelain': { stdout: '' },
    'fetch origin': { status: 0 },
    'merge-base --is-ancestor origin/main HEAD': { status: 1 },
    'merge origin/main': { status: 0 },
    'rev-parse HEAD': { stdout: `${NEW}\n` },
    'push origin HEAD:ticket/225': push,
  })
}

function upToDateGit() {
  return fakeGit({
    'worktree list --porcelain': { stdout: porcelain() },
    'rev-parse --verify --quiet MERGE_HEAD': { status: 1 },
    'diff --name-only --diff-filter=U': { stdout: '' },
    'status --porcelain': { stdout: '' },
    'fetch origin': { status: 0 },
    'merge-base --is-ancestor origin/main HEAD': { status: 0 },
  })
}

// ---------------------------------------------------------------------------
// The pure decisions.

test('usage names the command, --json, and what the script still will not do', () => {
  assert.match(usage(), /usage: npm run integrate <pr-number> \[--json\]/)
  assert.match(usage(), /never merges, approves, force-pushes/)
  assert.match(usage(), /conflict is left in the worktree for a human/)
})

test('PREFLIGHT_FIELDS is exactly the preflight field list', () => {
  assert.equal(PREFLIGHT_FIELDS, 'state,isCrossRepository,baseRefName,headRefName,headRefOid')
})

test('parseArgs takes one PR number and an optional --json', () => {
  assert.deepEqual(parseArgs(['225']), { pr: 225, json: false })
  assert.deepEqual(parseArgs(['225', '--json']), { pr: 225, json: true })
  assert.deepEqual(parseArgs(['--json', '225']), { pr: 225, json: true })
})

test('parseArgs returns help', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true })
  assert.deepEqual(parseArgs(['-h']), { help: true })
})

test('parseArgs refuses anything that is not one PR number', () => {
  assert.throws(() => parseArgs([]), /expected exactly one pull request number/)
  assert.throws(() => parseArgs(['1', '2']), /expected exactly one pull request number/)
  assert.throws(() => parseArgs(['--nope']), /unknown option: --nope/)
  assert.throws(() => parseArgs(['0']), /not a pull request number: 0/)
  assert.throws(() => parseArgs(['ticket']), /not a pull request number: ticket/)
})

test('formatMergeCommand prints the pinned line with the full 40-hex head', () => {
  assert.equal(formatMergeCommand(225, HEAD), `gh-bot pr merge 225 --squash --match-head-commit ${HEAD}`)
  assert.throws(() => formatMergeCommand(225, 'abc123'), /not a 40-hex commit: abc123/)
  assert.throws(() => formatMergeCommand(225, `${HEAD}0`), /not a 40-hex commit/)
  assert.throws(() => formatMergeCommand(0, HEAD), /not a pull request number: 0/)
})

test('formatWorktreeAdd prints the line the runner should have been given', () => {
  assert.equal(
    formatWorktreeAdd({ branch: 'ticket/225', root: ROOT }),
    `git worktree add ${ROOT}/ticket-225 -b ticket/225 origin/ticket/225`,
  )
  assert.equal(
    formatWorktreeAdd({ branch: 'ticket/225', root: '/tmp/anyplugin-wt', localBranch: true }),
    'git worktree add /tmp/anyplugin-wt/ticket-225 ticket/225',
  )
})

test('worktreeProblem refuses a worktree at a head other than the reviewed one', () => {
  const records = fakeGit({})
  const problem = worktreeProblem({ worktree: { path: WORKTREE, head: OTHER }, head: HEAD, run: records.runGit })
  assert.match(problem, /is at 89abcdef0123, not the reviewed head 0123456789ab; re-dispatch from that head/)
})

test('worktreeProblem refuses a merge that is already in progress', () => {
  const records = fakeGit({ 'rev-parse --verify --quiet MERGE_HEAD': { status: 0 } })
  const problem = worktreeProblem({ worktree: { path: WORKTREE, head: HEAD }, head: HEAD, run: records.runGit })
  assert.match(problem, /a merge is already in progress in .*; finish or abort it yourself, this script will not/)
})

test('worktreeProblem refuses an index with unmerged paths', () => {
  const records = fakeGit({
    'rev-parse --verify --quiet MERGE_HEAD': { status: 1 },
    'diff --name-only --diff-filter=U': { stdout: 'file.txt\n' },
  })
  const problem = worktreeProblem({ worktree: { path: WORKTREE, head: HEAD }, head: HEAD, run: records.runGit })
  assert.match(problem, /has unmerged paths in its index; finish or abort the merge yourself, this script will not/)
})

test('worktreeProblem refuses a dirty worktree', () => {
  const records = fakeGit({
    'rev-parse --verify --quiet MERGE_HEAD': { status: 1 },
    'diff --name-only --diff-filter=U': { stdout: '' },
    'status --porcelain': { stdout: ' M file.txt\n' },
  })
  const problem = worktreeProblem({ worktree: { path: WORKTREE, head: HEAD }, head: HEAD, run: records.runGit })
  assert.match(problem, /is dirty; commit or stash it before integrating/)
})

test('worktreeProblem allows the reviewed head in a clean worktree', () => {
  const records = fakeGit({
    'rev-parse --verify --quiet MERGE_HEAD': { status: 1 },
    'diff --name-only --diff-filter=U': { stdout: '' },
    'status --porcelain': { stdout: '' },
  })
  assert.equal(worktreeProblem({ worktree: { path: WORKTREE, head: HEAD }, head: HEAD, run: records.runGit }), undefined)
})

// ---------------------------------------------------------------------------
// The preflight stops: exit 2, stdout empty, one actionable line, no git.

test('run --help prints the usage on stdout and asks nothing', () => {
  const cap = capture()
  const calls = []
  const code = run(['--help'], cap.io, {
    gh: () => calls.push('gh'),
    git: () => calls.push('git'),
    waitForCi: () => calls.push('ci'),
  })
  assert.equal(code, 0)
  assert.match(cap.stdout(), /^usage: npm run integrate <pr-number> \[--json\]\n/)
  assert.equal(cap.stderr(), '')
  assert.deepEqual(calls, [])
})

test('run refuses unusable arguments with exit 2 and the usage', () => {
  const cap = capture()
  const code = run(['--nope'], cap.io, {})
  assert.equal(code, 2)
  assert.equal(cap.stdout(), '')
  assert.match(cap.stderr(), /integrate: unknown option: --nope/)
  assert.match(cap.stderr(), /usage: npm run integrate <pr-number> \[--json\]/)
})

const STOPS = [
  ['a closed PR', { state: 'CLOSED' }, /^integrate: PR #225 is closed, not open$/],
  ['a fork PR', { isCrossRepository: true }, /comes from a fork; its head branch is not ours to push$/],
  ['a PR targeting another base', { baseRefName: 'release' }, /^integrate: PR #225 targets release, not main$/],
  ['a head that is not 40-hex', { headRefOid: 'abc123' }, /did not resolve to a 40-hex head \(abc123\)$/],
]

for (const [name, overrides, pattern] of STOPS) {
  test(`run stops with exit 2 and one line for ${name}`, () => {
    const cap = capture()
    const calls = []
    const code = run(['225'], cap.io, {
      gh: () => ({ ...pull(), ...overrides }),
      git: () => calls.push('git'),
      waitForCi: () => calls.push('ci'),
    })
    assert.equal(code, 2)
    assert.equal(cap.stdout(), '')
    const lines = cap.stderr().trim().split('\n')
    assert.equal(lines.length, 1, `expected one actionable line, got: ${cap.stderr()}`)
    assert.match(lines[0], pattern)
    assert.deepEqual(calls, [])
  })
}

test('run reports a PR read failure as a failed step', () => {
  const cap = capture()
  const code = run(['225'], cap.io, { gh: () => { throw new Error('gh: HTTP 502') } })
  assert.equal(code, 1)
  assert.match(cap.stderr(), /^integrate: failed at read: gh: HTTP 502$/m)
  assert.equal(cap.stdout(), '')
})

// ---------------------------------------------------------------------------
// Worktree discovery and the state the runner was dispatched for.

test('run stops and prints the exact git worktree add line when no worktree has the branch', () => {
  const cap = capture()
  const records = fakeGit({
    'worktree list --porcelain': { stdout: porcelain({ branch: 'other' }) },
    'rev-parse --verify --quiet refs/heads/ticket/225': { status: 1 },
  })
  const code = run(['225'], cap.io, {
    gh: () => pull(),
    git: records.runGit,
    waitForCi: () => assert.fail('must not wait for CI'),
  })
  assert.equal(code, 2)
  assert.equal(cap.stdout(), '')
  const lines = cap.stderr().trim().split('\n')
  assert.equal(lines.length, 2, `expected the preflight line and one stop line, got: ${cap.stderr()}`)
  assert.equal(
    lines[1],
    `integrate: no worktree checks out ticket/225; create it with: git worktree add ${ROOT}/ticket-225 -b ticket/225 origin/ticket/225`,
  )
})

test('run stops when the worktree is not at the reviewed head', () => {
  const cap = capture()
  const records = fakeGit({ 'worktree list --porcelain': { stdout: porcelain({ head: OTHER }) } })
  const code = run(['225'], cap.io, {
    gh: () => pull(),
    git: records.runGit,
    waitForCi: () => assert.fail('must not wait for CI'),
  })
  assert.equal(code, 2)
  assert.equal(cap.stdout(), '')
  assert.match(
    cap.stderr().trim().split('\n').at(-1),
    /^integrate: the worktree at .* is at 89abcdef0123, not the reviewed head 0123456789ab; re-dispatch from that head$/,
  )
  // The fetch is not reached: the state check comes first.
  assert.deepEqual(records.calls.map((call) => call.args.join(' ')), ['worktree list --porcelain'])
})

// ---------------------------------------------------------------------------
// The dry end-to-end: fake git and fake gh record the whole command sequence.

test('run behind: fetch, merge, one push, wait on the pushed head, print the line', () => {
  const cap = capture()
  const records = behindGit()
  const gh = fakeGh(pull(), { headAfterPush: NEW })
  const waits = []
  const code = run(['225'], cap.io, {
    git: records.runGit,
    gh: gh.gh,
    waitForCi: (head) => {
      waits.push(head)
      return { ok: true, exitCode: 0 }
    },
  })
  assert.equal(code, 0)
  assert.equal(cap.stdout(), `gh-bot pr merge 225 --squash --match-head-commit ${NEW}\n`)
  assert.deepEqual(waits, [NEW])
  assert.match(cap.stderr(), /^integrate: PR #225 ticket\/225 @ 0123456789abcdef0123456789abcdef01234567 base main$/m)
  assert.match(cap.stderr(), new RegExp(`^integrate: pushed ${NEW} to ticket/225$`, 'm'))
  assert.match(cap.stderr(), new RegExp(`^integrate: verify passed on ${NEW}; the merge line is for the master$`, 'm'))

  const sequence = [
    'fetch origin',
    'merge-base --is-ancestor origin/main HEAD',
    'merge origin/main',
    'rev-parse HEAD',
    'push origin HEAD:ticket/225',
  ].map((key) => records.calls.findIndex((call) => call.args.join(' ') === key))
  assert.ok(sequence.every((index) => index >= 0), `missing git call: ${records.calls.map((call) => call.args.join(' ')).join(' | ')}`)
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), 'git steps ran out of order')

  const pushes = records.calls.filter((call) => call.args[0] === 'push')
  assert.equal(pushes.length, 1, 'exactly one push')
  assert.deepEqual(pushes[0].args, ['push', 'origin', 'HEAD:ticket/225'])
  assert.equal(pushes[0].cwd, WORKTREE)

  // One refspec, never forced, never main.
  for (const call of records.calls) {
    for (const arg of call.args) {
      assert.ok(!['--force', '-f', '--force-with-lease', '--delete', 'main'].includes(arg), `unexpected git argument: ${arg}`)
      assert.ok(!arg.startsWith('+'), `refspec must not be forced: ${arg}`)
    }
  }

  // No code edit: the only working-tree change is the merge commit itself.
  const writers = ['commit', 'checkout', 'reset', 'add', 'apply', 'clean', 'rm', 'mv', 'restore', 'update-index', 'write-tree']
  assert.deepEqual(records.calls.filter((call) => writers.includes(call.args[0])), [])

  // gh was only asked to read the PR, and never to merge it.
  assert.equal(gh.calls.length, 2)
  for (const call of gh.calls) {
    assert.deepEqual(call.slice(0, 2), ['pr', 'view'])
    assert.ok(!call.includes('merge'), `gh must never merge: ${call.join(' ')}`)
  }
})

test('run up to date: nothing is merged or pushed, and CI is waited for the PR head', () => {
  const cap = capture()
  const records = upToDateGit()
  const gh = fakeGh(pull())
  const waits = []
  const code = run(['225'], cap.io, {
    git: records.runGit,
    gh: gh.gh,
    waitForCi: (head) => {
      waits.push(head)
      return { ok: true, exitCode: 0 }
    },
  })
  assert.equal(code, 0)
  assert.equal(cap.stdout(), `gh-bot pr merge 225 --squash --match-head-commit ${HEAD}\n`)
  assert.deepEqual(waits, [HEAD])
  assert.match(cap.stderr(), /^integrate: ticket\/225 already contains origin\/main; nothing to push$/m)
  assert.deepEqual(records.calls.filter((call) => call.args[0] === 'push'), [])
  assert.deepEqual(records.calls.filter((call) => call.args.join(' ') === 'merge origin/main'), [])
  assert.deepEqual(gh.calls.filter((call) => call.includes('headRefOid')), [], 'no head re-read without a push')
})

test('run refuses to report a push the PR head does not show, retrying five times', () => {
  const cap = capture()
  const records = behindGit()
  const gh = fakeGh(pull(), { headAfterPush: HEAD })
  const sleeps = []
  const code = run(['225'], cap.io, {
    git: records.runGit,
    gh: gh.gh,
    waitForCi: () => assert.fail('must not wait for CI'),
    sleep: (ms) => sleeps.push(ms),
  })
  assert.equal(code, 1)
  assert.equal(cap.stdout(), '')
  assert.match(cap.stderr(), /^integrate: failed at push: the PR head is still 0123456789ab, not fedcba987654; the push did not update this PR$/m)
  assert.deepEqual(sleeps, [1000, 1000, 1000, 1000, 1000])
  assert.equal(gh.calls.length, 7)
})

test('run reports a rejected push as a failed step', () => {
  const cap = capture()
  const records = behindGit({ push: { status: 1, stderr: '! [rejected] ticket/225 -> ticket/225 (fetch first)\n' } })
  const gh = fakeGh(pull(), { headAfterPush: NEW })
  const code = run(['225'], cap.io, {
    git: records.runGit,
    gh: gh.gh,
    waitForCi: () => assert.fail('must not wait for CI'),
  })
  assert.equal(code, 1)
  assert.equal(cap.stdout(), '')
  assert.match(cap.stderr(), /^integrate: failed at push: ! \[rejected\]/m)
})

test('run reports a red verify as a failed step with the read command', () => {
  const cap = capture()
  const records = behindGit()
  const gh = fakeGh(pull(), { headAfterPush: NEW })
  const code = run(['225'], cap.io, { git: records.runGit, gh: gh.gh, waitForCi: () => ({ ok: false, exitCode: 1 }) })
  assert.equal(code, 1)
  assert.equal(cap.stdout(), '')
  assert.match(
    cap.stderr(),
    new RegExp(`^integrate: failed at ci: verify on ${NEW} did not pass \\(exit 1\\); read the failure with npm run ci -- --head ${NEW} --log-failed$`, 'm'),
  )
})

test('run --json prints the report instead of the merge line', () => {
  const cap = capture()
  const records = behindGit()
  const gh = fakeGh(pull(), { headAfterPush: NEW })
  const code = run(['225', '--json'], cap.io, {
    git: records.runGit,
    gh: gh.gh,
    waitForCi: () => ({ ok: true, exitCode: 0 }),
  })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(cap.stdout()), {
    pr: 225,
    branch: 'ticket/225',
    base: 'main',
    worktree: WORKTREE,
    previousHead: HEAD,
    head: NEW,
    pushed: true,
    ci: { ok: true, exitCode: 0 },
    mergeCommand: `gh-bot pr merge 225 --squash --match-head-commit ${NEW}`,
  })
  assert.ok(!cap.stderr().includes('gh-bot pr merge'), 'the merge line is a report field, not progress output')
})

test('the script has no gh merge call site', () => {
  const source = readFileSync(new URL('./integrate.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /'pr',\s*'merge'/)
  assert.doesNotMatch(source, /execFileSync\('gh',\s*\[[^\]]*merge/s)
  // The only merge-line construction is the string the master runs.
  assert.match(source, /gh-bot pr merge \$\{number\} --squash --match-head-commit \$\{sha\}/)
})

// ---------------------------------------------------------------------------
// The same paths against real repositories (fake gh on PATH, CI wait injected).

test('end to end: a behind branch is merged, pushed once, and the exact line printed', () => {
  const { root, repo, origin } = setupRepo({ mainAhead: true })
  try {
    const readGhLog = installFakeGh(root)
    const cap = capture()
    const waits = []
    const reviewed = git(repo, ['rev-parse', 'HEAD']).trim()
    const code = withRepo(repo, () =>
      run(['225'], cap.io, {
        waitForCi: (head) => {
          waits.push(head)
          return { ok: true, exitCode: 0 }
        },
      }),
    )
    assert.equal(code, 0)
    const merged = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.notEqual(merged, reviewed)
    assert.equal(git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 3, 'a merge commit')
    assert.equal(git(origin, ['rev-parse', 'refs/heads/ticket/225']).trim(), merged)
    assert.equal(git(repo, ['status', '--porcelain']), '')
    assert.deepEqual(waits, [merged])
    assert.equal(cap.stdout(), `gh-bot pr merge 225 --squash --match-head-commit ${merged}\n`)
    // No code was edited: the merge brought in only origin/main's new file.
    assert.equal(git(repo, ['diff', '--name-only', 'HEAD^1', 'HEAD']), 'other.txt\n')
    const ghLog = readGhLog().trim().split('\n')
    assert.equal(ghLog.length, 2, 'the preflight read and the post-push read')
    assert.ok(ghLog.every((line) => line.startsWith('pr view 225 ')))
    assert.ok(!readGhLog().includes('pr merge'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('end to end: an up-to-date branch is not merged or pushed', () => {
  const { root, repo, origin } = setupRepo()
  try {
    const readGhLog = installFakeGh(root)
    const cap = capture()
    const waits = []
    const reviewed = git(repo, ['rev-parse', 'HEAD']).trim()
    const remoteBefore = git(origin, ['rev-parse', 'refs/heads/ticket/225']).trim()
    const code = withRepo(repo, () =>
      run(['225'], cap.io, {
        waitForCi: (head) => {
          waits.push(head)
          return { ok: true, exitCode: 0 }
        },
      }),
    )
    assert.equal(code, 0)
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), reviewed)
    assert.equal(git(origin, ['rev-parse', 'refs/heads/ticket/225']).trim(), remoteBefore)
    assert.equal(git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 2, 'no merge commit')
    assert.deepEqual(waits, [reviewed])
    assert.equal(cap.stdout(), `gh-bot pr merge 225 --squash --match-head-commit ${reviewed}\n`)
    assert.match(cap.stderr(), /nothing to push/)
    assert.equal(readGhLog().trim().split('\n').length, 1, 'one PR read, no head re-read')
    assert.ok(!readGhLog().includes('pr merge'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('end to end: a conflict stops, prints the paths, leaves the tree and pushes nothing', () => {
  const { root, repo, origin } = setupRepo({ mainConflict: true })
  try {
    const readGhLog = installFakeGh(root)
    const cap = capture()
    const before = git(repo, ['rev-parse', 'HEAD']).trim()
    const remoteBefore = git(origin, ['rev-parse', 'refs/heads/ticket/225']).trim()
    let waited = false
    const code = withRepo(repo, () =>
      run(['225'], cap.io, {
        waitForCi: () => {
          waited = true
          return { ok: true, exitCode: 0 }
        },
      }),
    )
    assert.equal(code, 1)
    assert.equal(cap.stdout(), '')
    assert.match(
      cap.stderr(),
      /^integrate: failed at merge: conflict in file\.txt; the merge is left in .+ for a human and nothing was pushed$/m,
    )
    assert.ok(cap.stderr().includes(repo), 'the stop line names the worktree')
    assert.equal(waited, false)
    // The tree is left exactly as the conflict made it, for a human.
    assert.equal(gitTry(repo, ['rev-parse', '--verify', 'MERGE_HEAD']).status, 0)
    assert.equal(gitTry(repo, ['diff', '--name-only', '--diff-filter=U']).stdout, 'file.txt\n')
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), before)
    assert.equal(git(origin, ['rev-parse', 'refs/heads/ticket/225']).trim(), remoteBefore)
    assert.ok(!readGhLog().includes('pr merge'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
