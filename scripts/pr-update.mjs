#!/usr/bin/env node
/**
 * pr:update — bring a pull request's branch up to date with `main`, push it,
 * wait for the new head's `verify` run, and print the pinned merge command.
 *
 * Why a script: "my PR is stale, merge main into it" is four git steps, one
 * push and a CI wait, and the parts a human gets wrong by hand are the run
 * selection (only a push run is the gate, D83) and the merge state of the
 * worktree. This reuses `scripts/ci-runs.mjs`, which owns the run rule.
 *
 * What it will not do: merge, approve, force-push, or touch `main`. It refuses
 * a fork PR (the head branch is not ours to push), a PR whose base is not
 * `main`, and a PR whose head is `main`. Before it merges it refuses a
 * worktree with a merge already in progress, an index with unmerged paths, or
 * uncommitted changes: a conflict this script did not create is never aborted.
 * On success stdout is exactly the
 * `gh pr merge <n> --squash --match-head-commit <40-hex>` line (D66); progress
 * and failures go to stderr.
 *
 * The decisions are exported for `scripts/pr-update.test.mjs`. The git and gh
 * calls are a thin layer in `run` and the helpers below it; nothing here
 * decides anything a test cannot call.
 *
 *   npm run pr:update <n>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_APPEAR_TIMEOUT_S,
  DEFAULT_RUN_TIMEOUT_S,
  failedLog,
  failedSteps,
  ghJson,
  repoArgs,
  sleep,
  waitForConclusion,
  waitForRun,
} from './ci-runs.mjs'

export const DEFAULT_ROOT = '/tmp/anyplugin-wt'
export const BASE = 'main'
const SHA = /^[0-9a-f]{40}$/

export function usage() {
  return `usage: npm run pr:update <pr-number>

Merges origin/main into the PR's head branch, pushes it, waits for verify on
the new head, and prints the pinned \`gh pr merge\` command. It never merges,
approves, force-pushes or touches main. A fork PR, a PR based on something
other than main, and a PR whose head is main are refused.`
}

/** `[ '225' ]` -> `{ pr: 225 }`; `--help` -> `{ help: true }`; anything else throws. */
export function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv.length !== 1) throw new Error('expected exactly one pull request number')
  if (!/^[1-9]\d*$/.test(argv[0])) throw new Error(`not a pull request number: ${argv[0]}`)
  const pr = Number(argv[0])
  if (!Number.isSafeInteger(pr)) throw new Error(`pull request number is out of range: ${argv[0]}`)
  return { pr }
}

/** The `gh pr view` fields this script reads. */
export const PR_FIELDS = 'state,isCrossRepository,baseRefName,headRefName,headRefOid,mergeable'

/** Whether this PR is one this script may update. The reasons are the output. */
export function reviewPr(pr) {
  const number = pr.number === undefined ? 'the PR' : `PR #${pr.number}`
  if (pr.state !== 'OPEN') return { ok: false, reason: `${number} is ${String(pr.state).toLowerCase()}, not open` }
  if (pr.isCrossRepository) return { ok: false, reason: `${number} comes from a fork; its head branch is not ours to push` }
  if (pr.headRefName === BASE) return { ok: false, reason: `the head of ${number} is ${BASE}; refusing to touch ${BASE}` }
  if (pr.baseRefName !== BASE) return { ok: false, reason: `${number} targets ${pr.baseRefName}, not ${BASE}` }
  if (typeof pr.headRefName !== 'string' || pr.headRefName === '') return { ok: false, reason: `${number} has no head branch` }
  if (!SHA.test(pr.headRefOid ?? '')) return { ok: false, reason: `${number} did not resolve to a 40-hex head (${pr.headRefOid ?? 'none'})` }
  return { ok: true }
}

/** `git worktree list --porcelain` -> `[{ path, head, branch }]`. */
export function parseWorktreeList(text) {
  const worktrees = []
  let current
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = { path: line.slice('worktree '.length), head: undefined, branch: undefined }
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length)
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

/**
 * Where to do the merge.
 *
 * - the branch already has a worktree: use it, but only if it is at the PR head
 *   (a stale local branch is not a substitute for the PR's commit);
 * - no worktree: a temporary detached one at `<root>/pr-<n>`, started from
 *   whichever of `origin/<branch>` or the local branch is the PR head;
 * - a pre-existing path that is not that branch's worktree: refuse, because
 *   `git worktree add` would fail halfway through.
 */
export function planWorktree({ worktrees, branch, number, root = DEFAULT_ROOT, localHead, remoteHead, prHead, pathExists = false }) {
  const existing = (worktrees ?? []).find((worktree) => worktree.branch === `refs/heads/${branch}`)
  if (existing) {
    if (existing.head !== prHead) {
      return {
        action: 'blocked',
        path: existing.path,
        reason: `the worktree at ${existing.path} is at ${String(existing.head).slice(0, 12)}, not the PR head ${prHead.slice(0, 12)}`,
      }
    }
    return { action: 'existing', path: existing.path }
  }

  const path = join(root, `pr-${number}`)
  if (pathExists) return { action: 'blocked', path, reason: `${path} already exists and is not a worktree for ${branch}` }
  if (remoteHead === prHead) return { action: 'create', path, start: `origin/${branch}` }
  if (localHead === prHead) return { action: 'create', path, start: branch }
  return {
    action: 'blocked',
    path,
    reason: `neither origin/${branch} nor the local ${branch} is the PR head ${prHead.slice(0, 12)}; run git fetch origin and try again`,
  }
}

/**
 * What to do after `git merge origin/main`.
 *
 * A non-zero status with unresolved paths is a conflict: abort and report. A
 * non-zero status with no unresolved path is a merge that never started (dirty
 * tree, no such ref); there is nothing to abort, but it must not be treated as
 * success.
 */
export function worktreeState({ worktree, run = git }) {
  const mergeHead = run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], worktree, { allowFailure: true })
  const unmerged = run(['diff', '--name-only', '--diff-filter=U'], worktree, { allowFailure: true })
    .stdout.split('\n').filter((line) => line !== '')
  const dirty = run(['status', '--porcelain'], worktree, { allowFailure: true }).stdout.trim() !== ''
  if (mergeHead.status === 0) {
    return { action: 'refuse', reason: `a merge is already in progress in ${worktree}; finish or abort it yourself, this script will not` }
  }
  if (unmerged.length > 0) {
    return { action: 'refuse', reason: `${worktree} has unmerged paths in its index; finish or abort the operation yourself, this script will not` }
  }
  if (dirty) return { action: 'refuse', reason: `${worktree} has uncommitted changes; commit or stash them before pr:update` }
  return { action: 'merge' }
}

export function decideMerge({ status, conflicts = [] }) {
  if (status === 0) return { action: 'keep' }
  if (conflicts.length > 0) return { action: 'abort', conflicts }
  return { action: 'fail' }
}

/** The D66-pinned merge line: exact 40-hex head, squash, nothing else. */
export function formatMergeCommand(number, sha) {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`not a pull request number: ${number}`)
  if (!SHA.test(sha ?? '')) throw new Error(`not a 40-hex commit: ${sha}`)
  return `gh pr merge ${number} --squash --match-head-commit ${sha}`
}

/** The failure report: the failed step, its sub-steps, and the log command. */
export function formatFailure({ step, detail, head, steps = [] }) {
  const lines = [`pr:update: failed at ${step}${detail === undefined ? '' : `: ${detail}`}`]
  for (const item of steps) lines.push(`pr:update:   failed step: ${item.job} :: ${item.step}`)
  if (SHA.test(head ?? '')) lines.push(`pr:update: log: npm run ci -- --head ${head} --log-failed`)
  return lines
}

class StepError extends Error {
  constructor(step, message, { steps = [] } = {}) {
    super(message)
    this.name = 'StepError'
    this.step = step
    this.steps = steps
  }
}

function git(args, cwd, { allowFailure = false } = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      stderr: '',
    }
  } catch (error) {
    const result = {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
    }
    if (!allowFailure) throw new StepError(args[0], (result.stderr.trim() || `git ${args.join(' ')} exited ${result.status}`))
    return result
  }
}

function refHead(ref) {
  const result = git(['rev-parse', '--verify', '--quiet', ref], undefined, { allowFailure: true })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function worktreeRoot() {
  return process.env.ANYPLUGIN_WORKTREE_ROOT ?? DEFAULT_ROOT
}

function readPr(number, fields = PR_FIELDS) {
  return ghJson(['pr', 'view', String(number), ...repoArgs(), '--json', fields])
}

/**
 * The shell layer. `io` is injectable only so the failure formatting can be
 * exercised end to end without GitHub; the decisions above are what the tests
 * pin.
 */
export function run(argv, io = { out: process.stdout, err: process.stderr }) {
  const { out, err } = io
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    err.write(`pr:update: ${error.message}\n${usage()}\n`)
    return 2
  }
  if (parsed.help) {
    out.write(`${usage()}\n`)
    return 0
  }

  const number = parsed.pr
  let temporary
  let head
  let ciHead
  try {
    let pr
    try {
      pr = { ...readPr(number), number }
    } catch (error) {
      throw new StepError('read', error.message ?? String(error))
    }
    const verdict = reviewPr(pr)
    if (!verdict.ok) throw new StepError('review', verdict.reason)

    const branch = pr.headRefName
    head = pr.headRefOid
    ciHead = head
    err.write(`pr:update: PR #${number} ${branch} @ ${head.slice(0, 8)} (mergeable ${pr.mergeable ?? 'unknown'})\n`)

    git(['fetch', 'origin'])
    const root = worktreeRoot()
    const plan = planWorktree({
      worktrees: parseWorktreeList(git(['worktree', 'list', '--porcelain']).stdout),
      branch,
      number,
      root,
      localHead: refHead(`refs/heads/${branch}`),
      remoteHead: refHead(`refs/remotes/origin/${branch}`),
      prHead: head,
      pathExists: existsSync(join(root, `pr-${number}`)),
    })
    if (plan.action === 'blocked') throw new StepError('worktree', plan.reason)

    if (plan.action === 'create') {
      mkdirSync(root, { recursive: true })
      const added = git(['worktree', 'add', '--detach', plan.path, plan.start], undefined, { allowFailure: true })
      if (added.status !== 0) throw new StepError('worktree', added.stderr.trim() || `git worktree add exited ${added.status}`)
      temporary = plan.path
    }
    const worktree = plan.path

    const state = worktreeState({ worktree })
    if (state.action === 'refuse') throw new StepError('worktree', state.reason)
    err.write(`pr:update: merging origin/${BASE} in ${worktree}\n`)

    const merged = git(['merge', `origin/${BASE}`], worktree, { allowFailure: true })
    if (merged.status !== 0) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'], worktree, { allowFailure: true })
        .stdout.split('\n')
        .filter((line) => line !== '')
      const decision = decideMerge({ status: merged.status, conflicts })
      if (decision.action === 'abort') {
        const aborted = git(['merge', '--abort'], worktree, { allowFailure: true })
        const midMerge =
          git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], worktree, { allowFailure: true }).status === 0
        if (aborted.status !== 0 || midMerge) {
          throw new StepError(
            'merge',
            `conflict in ${decision.conflicts.join(', ')}; the abort did not leave a clean worktree (git merge --abort exited ${aborted.status}), so the merge may still be in progress — nothing was pushed`,
          )
        }
        throw new StepError('merge', `conflict in ${decision.conflicts.join(', ')}; the merge was aborted and nothing was pushed`)
      }
      throw new StepError('merge', merged.stderr.trim() || merged.stdout.trim() || `git merge exited ${merged.status}`)
    }

    const mergedHead = git(['rev-parse', 'HEAD'], worktree).stdout.trim()
    ciHead = mergedHead
    if (mergedHead === head) {
      err.write(`pr:update: ${branch} already contains origin/${BASE}; nothing to push\n`)
    } else {
      const pushed = git(['push', 'origin', `HEAD:${branch}`], worktree, { allowFailure: true })
      if (pushed.status !== 0) throw new StepError('push', pushed.stderr.trim() || pushed.stdout.trim() || `git push exited ${pushed.status}`)
      // The PR's head is the branch ref; give the API a moment in case the read
      // lands before it reflects the push.
      let after = readPr(number, 'headRefOid')
      for (let attempt = 0; after.headRefOid !== mergedHead && attempt < 5; attempt += 1) {
        sleep(1000)
        after = readPr(number, 'headRefOid')
      }
      if (after.headRefOid !== mergedHead) {
        throw new StepError('push', `the PR head is still ${String(after.headRefOid).slice(0, 12)}, not ${mergedHead.slice(0, 12)}; the push did not update this PR`)
      }
      err.write(`pr:update: pushed ${mergedHead.slice(0, 12)} to ${branch}\n`)
    }

    err.write(`pr:update: waiting for the verify run on ${mergedHead.slice(0, 8)}\n`)
    const run = waitForRun({ head: mergedHead })
    if (run === undefined) throw new StepError('ci', `no verify run appeared for ${mergedHead.slice(0, 8)} within ${DEFAULT_APPEAR_TIMEOUT_S}s`)
    const final = waitForConclusion({ runId: run.databaseId })
    if (final.status !== 'completed') throw new StepError('ci', `run ${run.databaseId} did not finish within ${DEFAULT_RUN_TIMEOUT_S}s`)
    if (final.conclusion !== 'success') {
      let steps = []
      try {
        steps = failedSteps(run.databaseId)
      } catch {
        // The log command below is the payload; the step list is a convenience.
      }
      err.write(failedLog(run.databaseId))
      throw new StepError('ci', `run ${run.databaseId} concluded ${final.conclusion}`, { steps })
    }

    out.write(`${formatMergeCommand(number, mergedHead)}\n`)
    return 0
  } catch (error) {
    const failure =
      error instanceof StepError
        ? formatFailure({ step: error.step, detail: error.message, head: ciHead, steps: error.steps })
        : formatFailure({ step: 'unexpected', detail: error.message ?? String(error), head: ciHead })
    for (const line of failure) err.write(`${line}\n`)
    return 1
  } finally {
    if (temporary !== undefined) {
      const removed = git(['worktree', 'remove', '--force', temporary], undefined, { allowFailure: true })
      if (removed.status !== 0) {
        err.write(`pr:update: could not remove the temporary worktree ${temporary}; remove it with git worktree remove --force ${temporary}\n`)
      }
    }
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2))
}
