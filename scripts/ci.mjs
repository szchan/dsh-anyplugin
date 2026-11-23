#!/usr/bin/env node
// Watch the verify push run for the current branch and report what failed.
//
// An agent does not run the suite locally any more (#175): it pushes, then asks
// this script what CI said. The steps an agent gets wrong by hand are (a)
// reading a run from the *previous* head, (b) watching a run that is not the
// required check — a skipped `pull_request` run of a same-repo PR, or a fork's
// contributor-controlled run (D83) — and (c) `gh run view --log-failed` failing
// on a root-owned cache directory.
//
// Only a push run is evidence (D83), and a head that is not on an `origin`
// branch cannot have one: then the script prints the push hint instead of
// waiting out the 300 s appearance window.
//
// The run-selection rule, the reachability check and the gh/polling layer are
// shared with `scripts/pr-update.mjs` and live in `scripts/ci-runs.mjs`.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_APPEAR_TIMEOUT_S,
  DEFAULT_RUN_TIMEOUT_S,
  failedLog,
  failedSteps,
  headOnOrigin,
  listBranchRuns,
  newerPushRun,
  POLL_MS,
  waitForConclusion,
  waitForRun,
} from './ci-runs.mjs'

export function usage() {
  return `usage: node scripts/ci.mjs [--branch <name>] [--head <sha>] [--log-failed] [--timeout <seconds>]

Waits for the verify push run on the current branch's head, then prints its
conclusion. On failure, prints the failed steps and their log tail. A
cancelled run (a newer push superseded the head) is reported as no verdict: no
failed log is fetched, and the newer push run is named when one is visible.
Exit 0 only when the run concluded success.`
}

function arg(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

function gitBranch() {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
}

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/**
 * `io` is injectable so tests can capture stdout/stderr; `deps` carries the
 * appearance timeout and the reachability check so `scripts/ci.test.mjs` can
 * prove the fail-fast path without a 300 s wait. Production uses the defaults.
 */
export function main(argv, io = {}, deps = {}) {
  const out = io.out ?? process.stdout
  const err = io.err ?? process.stderr
  const say = (line) => out.write(`${line}\n`)
  const warn = (line) => err.write(`${line}\n`)

  if (argv.includes('--help') || argv.includes('-h')) {
    say(usage())
    return 0
  }
  const branch = arg(argv, '--branch') ?? gitBranch()
  const head = arg(argv, '--head') ?? gitHead()
  const timeoutS = Number(arg(argv, '--timeout') ?? DEFAULT_RUN_TIMEOUT_S)
  const logFailedOnly = argv.includes('--log-failed')
  const appearTimeoutS = deps.appearTimeoutS ?? DEFAULT_APPEAR_TIMEOUT_S
  const pollMs = deps.pollMs ?? POLL_MS
  const isPushed = deps.isPushed ?? headOnOrigin

  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    warn('ci: --timeout must be a positive number of seconds')
    return 2
  }

  const run = waitForRun({ head, appearTimeoutS, pollMs, isPushed })
  if (run === undefined) {
    if (isPushed(head) === false) {
      warn(`ci: ${head.slice(0, 8)} is not on any origin branch in this checkout`)
      warn('ci: push the branch first: the verify run produced by that push is the only gate (D83)')
      warn('ci: if it is already pushed, run git fetch origin and try again')
    } else {
      warn(`ci: no verify push run appeared for ${head.slice(0, 8)} on ${branch} within ${appearTimeoutS}s`)
      warn('ci: a pull_request run is never the gate (D83); push a new head to fire the push event')
    }
    return 1
  }

  if (logFailedOnly) {
    if (run.conclusion === 'success') {
      say(`ci: ${run.databaseId} succeeded; nothing failed`)
      return 0
    }
    say(failedLog(run.databaseId))
    return 1
  }

  say(
    `ci: watching ${run.databaseId} (${run.status}${run.conclusion ? `/${run.conclusion}` : ''}) for ${head.slice(0, 8)} (${branch})`,
  )
  const final = waitForConclusion({ runId: run.databaseId, timeoutS, pollMs })
  if (final.status !== 'completed') {
    warn(`ci: run ${run.databaseId} did not finish within ${timeoutS}s`)
    return 1
  }

  say(`ci: ${run.databaseId} ${final.conclusion}`)
  if (final.conclusion === 'success') return 0

  // A cancelled run is not a verdict: no step failed, there is no failed log,
  // and the head is simply no longer the gate. Say that, and name the newer
  // push run that superseded it when one is visible (a branch update does this
  // on every pr:update). The exit stays non-zero: D83 wants a push run for the
  // head, and cancelled is not green.
  if (final.conclusion === 'cancelled') {
    say(`ci: run ${run.databaseId} was cancelled for ${head.slice(0, 8)} — no verdict for this head`)
    let newer
    try {
      newer = newerPushRun((deps.branchRuns ?? listBranchRuns)(branch), head)
    } catch {
      newer = undefined
    }
    if (newer === undefined) {
      say('ci: push a new head (or run npm run pr:update <n> when the branch moved) so the push event can produce a verdict')
    } else {
      say(`ci: a newer push run ${newer.databaseId} exists for ${branch} at ${String(newer.headSha).slice(0, 8)}; watch that head (npm run ci -- --head ${newer.headSha}) or update the branch first`)
    }
    return 1
  }

  say('--- failed steps ---')
  try {
    for (const step of failedSteps(run.databaseId)) say(`  ${step.job} :: ${step.step}`)
  } catch {
    // The log below is the real payload; the step list is a convenience.
  }
  say('--- log (failed) ---')
  say(failedLog(run.databaseId))
  return 1
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
