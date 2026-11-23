// Shared read layer for the `verify` workflow.
//
// `scripts/ci.mjs` reports on the run for the current branch;
// `scripts/pr-update.mjs` polls the run for a PR head after it pushes. Both
// need the same two things, so they live here instead of in one of the callers:
//
// 1. the run-selection rule. `verify` is produced by the push event alone
//    (D83). A same-repo PR used to put two runs on one commit — the push run
//    (the required `verify`) and a `pull_request` run that skips at the job
//    level; a fork's `pull_request` run executes the fork's own workflow file
//    and can name its job anything. This module returns only a push run, so a
//    skipped check or a contributor-named one can never pass for green.
// 2. whether the head can have a push run at all. A commit that is not
//    reachable from an `origin` branch in this checkout cannot produce one, so
//    `waitForRun` fails fast instead of waiting out the appearance window.
// 3. the gh invocation (bot token, cache directory) and the polling deadlines,
//    so a second caller cannot quietly use a different timeout or a raw `gh`.
//
// The selection and the reachability check take their data (or a `run`
// function) as arguments, so `scripts/ci-runs.test.mjs` pins them without
// GitHub and without a network. The rest is the thin shell.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const WORKFLOW = 'verify.yml'
export const REPO = 'szchan/dsh-anyplugin'
export const POLL_MS = 10_000
export const DEFAULT_APPEAR_TIMEOUT_S = 300
export const DEFAULT_RUN_TIMEOUT_S = 1800

const HEX40 = /^[0-9a-f]{40}$/

/**
 * The push run whose conclusion is the `verify` check for `head`, if any.
 *
 * Only `event === 'push'` is evidence (D83): a `pull_request` run executes the
 * workflow file from the PR's merge commit — for a fork the contributor
 * controls it and can name the job anything — and a skipped job still reports
 * as a passing check of its own context. A skipped push run is never an
 * answer either: the suite did not run.
 *
 * Order: the newest completed, non-skipped push run is the answer — `gh run
 * list` returns runs newest first, and a newer push run that is *still in
 * progress* is not watched once a completed run exists: the completed run is
 * the evidence that exists now. A still-running push run is worth watching only
 * when no completed run exists yet (it will become that answer); otherwise the
 * answer is `undefined`.
 */
export function selectRun(runs, head) {
  const pushes = (runs ?? []).filter((run) => run.headSha === head && run.event === 'push')
  return (
    pushes.find((run) => run.status === 'completed' && run.conclusion !== 'skipped') ??
    pushes.find((run) => run.status !== 'completed') ??
    undefined
  )
}

function gitQuery(run, args) {
  try {
    return {
      status: 0,
      stdout: String(run('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })),
    }
  } catch {
    return { status: 1, stdout: '' }
  }
}

/**
 * Whether `head` is reachable from an `origin` branch in this checkout, or
 * `true` when that cannot be decided from here.
 *
 * `false` is returned only when git positively has the commit, `origin` exists,
 * and at least one `origin/*` remote-tracking ref exists but none contains the
 * commit. In that state no push run for the commit can appear, so `waitForRun`
 * returns immediately with the push hint. Everything unknown answers `true`:
 * a missing commit, no `origin` remote, no git checkout, no remote-tracking
 * refs, or an unreadable ref list must not turn into a false "push it again".
 *
 * `run` is injectable so the state table is tested without a repository.
 */
export function headOnOrigin(head, run = execFileSync) {
  if (!HEX40.test(head ?? '')) return true
  if (gitQuery(run, ['rev-parse', '--git-dir']).status !== 0) return true
  if (gitQuery(run, ['remote', 'get-url', 'origin']).status !== 0) return true
  if (gitQuery(run, ['cat-file', '-e', `${head}^{commit}`]).status !== 0) return true
  const all = gitQuery(run, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
  if (all.status !== 0 || all.stdout.trim() === '') return true
  const containing = gitQuery(run, ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/remotes/origin'])
  if (containing.status !== 0) return true
  return containing.stdout.trim() !== ''
}

export function repoArgs() {
  return ['--repo', REPO]
}

export function gh(args, extraEnv) {
  const env = { ...process.env, ...extraEnv }
  const tokenFile = env.DSH_ANYPLUGIN_BOT_TOKEN_FILE ?? join(homedir(), '.config', 'dsh-anyplugin', 'gh-bot.token')
  if (!env.GH_TOKEN && existsSync(tokenFile)) env.GH_TOKEN = readFileSync(tokenFile, 'utf8').trim()
  // `gh` keeps its own cache under XDG_CACHE_HOME; on this machine the default
  // is root-owned and unusable, and a failed cache write masks the run output.
  // `gh run view --log-failed` writes an HTTP cache here.
  if (!env.XDG_CACHE_HOME) {
    env.XDG_CACHE_HOME = join('/tmp', 'dsh-anyplugin-gh-cache')
    mkdirSync(env.XDG_CACHE_HOME, { recursive: true })
  }
  return execFileSync('gh', args, { env, encoding: 'utf8' })
}

export function ghJson(args, extraEnv) {
  return JSON.parse(gh(args, extraEnv))
}

export function listRuns(head) {
  return ghJson([
    'run', 'list', '--workflow', WORKFLOW, '--commit', head, '--limit', '5',
    '--json', 'databaseId,status,conclusion,createdAt,headSha,event', ...repoArgs(),
  ])
}

export function viewRun(runId) {
  return ghJson(['run', 'view', String(runId), '--json', 'status,conclusion', ...repoArgs()])
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The failed steps of a completed run, as `{ job, step }` pairs. */
export function failedSteps(runId) {
  const jobs = ghJson(['run', 'view', String(runId), '--json', 'jobs', ...repoArgs()])
  const steps = []
  for (const job of jobs.jobs ?? []) {
    for (const step of job.steps ?? []) {
      if (step.conclusion === 'failure') steps.push({ job: job.name, step: step.name })
    }
  }
  return steps
}

export function failedLog(runId) {
  try {
    return gh(['run', 'view', String(runId), '--log-failed', ...repoArgs()])
  } catch (error) {
    return `(could not read the failed log: ${error.message})`
  }
}

/**
 * Wait for the run that will be `head`'s check, or `undefined` when there is
 * none. A head that is not reachable from `origin` (see `headOnOrigin`) returns
 * `undefined` before the first `list` call: no push run can appear, and the
 * caller wants to print the push hint now, not after `appearTimeoutS`.
 *
 * `list`, `isPushed`, `now` and `sleepFn` are injectable so the deadline and
 * fail-fast behaviour are tested without waiting.
 */
export function waitForRun({
  head,
  list = listRuns,
  isPushed = headOnOrigin,
  appearTimeoutS = DEFAULT_APPEAR_TIMEOUT_S,
  pollMs = POLL_MS,
  now = Date.now,
  sleepFn = sleep,
}) {
  if (isPushed(head) === false) return undefined
  const deadline = now() + appearTimeoutS * 1000
  while (true) {
    const run = selectRun(list(head), head)
    if (run) return run
    if (now() > deadline) return undefined
    sleepFn(pollMs)
  }
}

/**
 * Wait for a run to conclude, returning its last observed state. `undefined`
 * is never returned: `status !== 'completed'` means the timeout elapsed.
 */
export function waitForConclusion({
  runId,
  timeoutS = DEFAULT_RUN_TIMEOUT_S,
  pollMs = POLL_MS,
  view = viewRun,
  now = Date.now,
  sleepFn = sleep,
}) {
  const deadline = now() + timeoutS * 1000
  while (true) {
    const current = view(runId)
    if (current.status === 'completed') return current
    if (now() > deadline) return current
    sleepFn(pollMs)
  }
}
