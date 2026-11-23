import assert from 'node:assert/strict'
import test from 'node:test'

import { headOnOrigin, selectRun, waitForConclusion, waitForRun } from './ci-runs.mjs'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'

function run(overrides) {
  return {
    databaseId: 1,
    headSha: HEAD,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

function clock(start = 0) {
  let time = start
  const sleeps = []
  return {
    now: () => time,
    sleepFn: (ms) => {
      sleeps.push(ms)
      time += ms
    },
    sleeps,
  }
}

const pushed = () => true

test('selectRun prefers the completed push run over the skipped PR run on the same commit', () => {
  const push = run({ databaseId: 11 })
  const skipped = run({ databaseId: 12, event: 'pull_request', conclusion: 'skipped' })
  // gh returns newest first; the skipped PR run is the one a naive read picks.
  assert.equal(selectRun([skipped, push], HEAD), push)
})

test('selectRun watches an unfinished push run over a completed PR run', () => {
  const push = run({ databaseId: 21, status: 'in_progress', conclusion: undefined })
  const pr = run({ databaseId: 22, event: 'pull_request' })
  assert.equal(selectRun([push, pr], HEAD), push)
})

test('selectRun prefers a completed push run over an unfinished one', () => {
  const running = run({ databaseId: 31, status: 'in_progress', conclusion: undefined })
  const done = run({ databaseId: 32, conclusion: 'failure' })
  assert.equal(selectRun([running, done], HEAD), done)
})

test('selectRun never accepts a pull_request run, even as the only run (D83)', () => {
  // A fork's pull_request run executes the fork's workflow file; its job can be
  // named `verify` and can report green without running our suite. It is not
  // the required check and must never be watched.
  const pr = run({ databaseId: 41, event: 'pull_request' })
  assert.equal(selectRun([pr], HEAD), undefined)
  const green = run({ databaseId: 42, event: 'pull_request_target' })
  assert.equal(selectRun([green], HEAD), undefined)
})

test('selectRun never returns a skipped run as the answer', () => {
  const skipped = run({ databaseId: 51, event: 'pull_request', conclusion: 'skipped' })
  assert.equal(selectRun([skipped], HEAD), undefined)
  assert.equal(selectRun([run({ databaseId: 52, conclusion: 'skipped' })], HEAD), undefined)
  assert.equal(selectRun([], HEAD), undefined)
  assert.equal(selectRun(undefined, HEAD), undefined)
})

test('selectRun ignores runs for a different commit', () => {
  const elsewhere = run({ databaseId: 61, headSha: OTHER })
  const mine = run({ databaseId: 62, conclusion: 'failure' })
  assert.equal(selectRun([elsewhere, mine], HEAD), mine)
})

test('waitForRun returns the run as soon as it appears', () => {
  const { now, sleepFn, sleeps } = clock()
  const found = run({ databaseId: 71 })
  let calls = 0
  const list = () => {
    calls += 1
    return calls === 1 ? [] : [found]
  }
  assert.equal(waitForRun({ head: HEAD, list, isPushed: pushed, appearTimeoutS: 30, pollMs: 1000, now, sleepFn }), found)
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [1000])
})

test('waitForRun gives up at the deadline instead of polling forever', () => {
  const { now, sleepFn, sleeps } = clock()
  const result = waitForRun({
    head: HEAD,
    list: () => [run({ event: 'pull_request', conclusion: 'skipped' })],
    isPushed: pushed,
    appearTimeoutS: 2,
    pollMs: 1000,
    now,
    sleepFn,
  })
  assert.equal(result, undefined)
  assert.equal(sleeps.length, 3)
})

test('waitForRun fails fast when the head was never pushed', () => {
  const { now, sleepFn, sleeps } = clock()
  let listed = 0
  const result = waitForRun({
    head: HEAD,
    list: () => {
      listed += 1
      return []
    },
    isPushed: () => false,
    appearTimeoutS: 300,
    pollMs: 1000,
    now,
    sleepFn,
  })
  assert.equal(result, undefined)
  assert.equal(listed, 0, 'no gh call when no push run can exist')
  assert.deepEqual(sleeps, [])
})

test('waitForConclusion returns the completed state', () => {
  const { now, sleepFn } = clock()
  const states = [
    { status: 'in_progress', conclusion: null },
    { status: 'completed', conclusion: 'success' },
  ]
  let calls = 0
  const view = () => states[Math.min(calls++, states.length - 1)]
  assert.deepEqual(waitForConclusion({ runId: 1, timeoutS: 60, pollMs: 1000, view, now, sleepFn }), {
    status: 'completed',
    conclusion: 'success',
  })
})

test('waitForConclusion reports the last observed state on timeout', () => {
  const { now, sleepFn } = clock()
  const view = () => ({ status: 'in_progress', conclusion: null })
  assert.deepEqual(waitForConclusion({ runId: 1, timeoutS: 2, pollMs: 1000, view, now, sleepFn }), {
    status: 'in_progress',
    conclusion: null,
  })
})

/** A fake `git` runner for the headOnOrigin state table; `gitQuery` calls it. */
function fakeGit({ insideRepo = true, origin = true, commit = true, originRefs = ['refs/remotes/origin/ticket/225'], containing = [] } = {}) {
  return (command, args) => {
    assert.equal(command, 'git')
    const key = args.join(' ')
    if (key === 'rev-parse --git-dir') {
      if (!insideRepo) throw new Error('fatal: not a git repository')
      return '.git\n'
    }
    if (key === 'remote get-url origin') {
      if (!origin) throw new Error('error: No such remote \'origin\'')
      return 'git@example.invalid:repo.git\n'
    }
    if (key.startsWith('cat-file -e ')) {
      if (!commit) throw new Error('fatal: Not a valid object name')
      return ''
    }
    if (key === 'for-each-ref --format=%(refname) refs/remotes/origin') {
      return originRefs.length === 0 ? '' : `${originRefs.join('\n')}\n`
    }
    if (key.startsWith('for-each-ref --contains ')) {
      return containing.length === 0 ? '' : `${containing.join('\n')}\n`
    }
    throw new Error(`unexpected git invocation: ${key}`)
  }
}

test('headOnOrigin is true when an origin branch contains the commit', () => {
  assert.equal(headOnOrigin(HEAD, fakeGit({ containing: ['refs/remotes/origin/ticket/225'] })), true)
})

test('headOnOrigin is false only when origin refs exist and none contains the commit', () => {
  assert.equal(headOnOrigin(HEAD, fakeGit({ containing: [] })), false)
})

test('headOnOrigin does not guess when it cannot see origin', () => {
  // Every unknown answers true: a false "push it again" is worse than waiting.
  assert.equal(headOnOrigin(HEAD, fakeGit({ insideRepo: false })), true)
  assert.equal(headOnOrigin(HEAD, fakeGit({ origin: false })), true)
  assert.equal(headOnOrigin(HEAD, fakeGit({ commit: false })), true)
  assert.equal(headOnOrigin(HEAD, fakeGit({ originRefs: [] })), true)
})

test('headOnOrigin does not run git for a non-sha or on an unreadable ref list', () => {
  const never = () => {
    throw new Error('git must not run')
  }
  assert.equal(headOnOrigin('HEAD', never), true)
  assert.equal(headOnOrigin(undefined, never), true)
  const unreadable = fakeGit()
  assert.equal(
    headOnOrigin(HEAD, (command, args) => {
      if (args.join(' ') === 'for-each-ref --format=%(refname) refs/remotes/origin') throw new Error('ref list unreadable')
      return unreadable(command, args)
    }),
    true,
  )
})
