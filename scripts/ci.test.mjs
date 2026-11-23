// Run-level tests for `npm run ci`: the real CLI, a real git repository, and a
// fake `gh` first on PATH. These pin the behaviour `scripts/ci-runs.test.mjs`
// can only pin in parts:
//
// - only the push run is watched (D83). A same-repo PR carries a skipped
//   `pull_request` run on the same sha next to the required push run; a fork's
//   `pull_request` run can even report green — neither is the check.
// - a head that was never pushed fails fast with the push hint instead of
//   waiting out the 300 s appearance window, and asks GitHub nothing.
//
// The fake `gh` logs every argv it sees, which is how "fail fast" is observed
// without sleeping: the unpushed case must not call `gh run list` at all.
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { main } from './ci.mjs'
import { capture, git, installFakeGh, setupRepo, withRepo } from './test-support.mjs'

test('two runs on one sha: the push run is watched and the skipped pull_request run is not', () => {
  const { root, repo } = setupRepo()
  try {
    const head = git(repo, ['rev-parse', 'HEAD']).trim()
    installFakeGh(root, {
      // gh lists newest first, and a naive "first run for this sha" picks the
      // skipped one.
      runs: [
        { databaseId: 12, event: 'pull_request', status: 'completed', conclusion: 'skipped', headSha: 'HEAD' },
        { databaseId: 34, event: 'push', status: 'completed', conclusion: 'success', headSha: 'HEAD' },
      ],
    })
    const cap = capture()
    const code = withRepo(repo, () => main([], cap.io, { appearTimeoutS: 1, pollMs: 20 }))
    assert.equal(code, 0)
    assert.match(cap.stdout(), new RegExp(`ci: watching 34 .* for ${head.slice(0, 8)} \\(ticket/225\\)`))
    assert.match(cap.stdout(), /ci: 34 success/)
    assert.doesNotMatch(cap.stdout(), /watching 12/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a fork PR: a green pull_request run is not the check, even on a pushed sha', () => {
  const { root, repo } = setupRepo()
  try {
    installFakeGh(root, {
      // A fork's pull_request run executes the fork's workflow file; it can be
      // green without running our suite. The required push run does not exist.
      runs: [{ databaseId: 41, event: 'pull_request', status: 'completed', conclusion: 'success', headSha: 'HEAD' }],
    })
    const cap = capture()
    const code = withRepo(repo, () => main([], cap.io, { appearTimeoutS: 0.2, pollMs: 10 }))
    assert.equal(code, 1)
    assert.match(cap.stderr(), /no verify push run appeared/)
    assert.match(cap.stderr(), /a pull_request run is never the gate/)
    assert.doesNotMatch(cap.stdout(), /watching 41/)
    assert.doesNotMatch(cap.stdout(), /41 success/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a head that was never pushed fails fast with the push hint and asks GitHub nothing', () => {
  const { root, repo } = setupRepo()
  try {
    writeFileSync(join(repo, 'local.txt'), 'not pushed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'local: unpushed'])
    const ghLog = installFakeGh(root)
    const cap = capture()
    const code = withRepo(repo, () => main([], cap.io, { appearTimeoutS: 300, pollMs: 10 }))
    assert.equal(code, 1)
    assert.match(cap.stderr(), /is not on any origin branch/)
    assert.match(cap.stderr(), /push the branch first/)
    assert.doesNotMatch(cap.stderr(), /no verify push run appeared/)
    assert.doesNotMatch(cap.stdout(), /watching/)
    assert.equal(ghLog(), '', 'the fail-fast path must not poll gh')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cancelled run is named as cancelled, never as a failure with failed steps (#278)', () => {
  const { root, repo } = setupRepo()
  try {
    const head = git(repo, ['rev-parse', 'HEAD']).trim()
    const newer = 'b'.repeat(40)
    const ghLog = installFakeGh(root, {
      // The completed push run for this head was superseded: nothing failed,
      // and there is no failed log to read.
      runs: [{ databaseId: 55, event: 'push', status: 'completed', conclusion: 'cancelled', headSha: 'HEAD' }],
      views: { 55: { status: 'completed', conclusion: 'cancelled' } },
      branchRuns: [
        { databaseId: 56, event: 'push', status: 'completed', conclusion: 'success', headSha: newer },
        { databaseId: 55, event: 'push', status: 'completed', conclusion: 'cancelled', headSha: head },
      ],
    })
    const cap = capture()
    const code = withRepo(repo, () => main([], cap.io, { appearTimeoutS: 1, pollMs: 20 }))
    assert.equal(code, 1)
    assert.match(cap.stdout(), /ci: run 55 was cancelled/)
    assert.match(cap.stdout(), /a newer push run 56 exists/)
    assert.doesNotMatch(cap.stdout(), /failed steps/)
    assert.doesNotMatch(cap.stdout(), /failed\) log/)
    assert.doesNotMatch(ghLog(), /--log-failed/, 'a cancelled run has no failed log to fetch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cancelled run with no newer push run says how to ask for a verdict (#278)', () => {
  const { root, repo } = setupRepo()
  try {
    installFakeGh(root, {
      runs: [{ databaseId: 57, event: 'push', status: 'completed', conclusion: 'cancelled', headSha: 'HEAD' }],
      views: { 57: { status: 'completed', conclusion: 'cancelled' } },
      branchRuns: [],
    })
    const cap = capture()
    const code = withRepo(repo, () => main([], cap.io, { appearTimeoutS: 1, pollMs: 20 }))
    assert.equal(code, 1)
    assert.match(cap.stdout(), /ci: run 57 was cancelled/)
    assert.match(cap.stdout(), /push a new head/)
    assert.doesNotMatch(cap.stdout(), /newer push run/)
    assert.doesNotMatch(cap.stdout(), /failed steps/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
