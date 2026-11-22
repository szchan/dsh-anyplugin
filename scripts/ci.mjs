#!/usr/bin/env node
// Watch the verify run for the current branch and report what failed.
//
// An agent does not run the suite locally any more (#175): it pushes, then asks
// this script what CI said. The script exists because the two steps an agent
// gets wrong by hand are (a) reading a run from the *previous* head, and (b)
// `gh run view --log-failed` failing on a root-owned cache directory.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WORKFLOW = 'verify.yml'
const POLL_MS = 10_000
const DEFAULT_APPEAR_TIMEOUT_S = 300
const DEFAULT_RUN_TIMEOUT_S = 1800

function usage() {
  return `usage: node scripts/ci.mjs [--branch <name>] [--log-failed] [--timeout <seconds>]

Waits for the verify run on the current branch's head, then prints its
conclusion. On failure, prints the failed steps and their log tail.
Exit 0 only when the run concluded success.`
}

function arg(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

function gh(args, extraEnv) {
  const env = { ...process.env, ...extraEnv }
  const tokenFile = env.DSH_ANYPLUGIN_BOT_TOKEN_FILE ?? join(homedir(), '.config', 'dsh-anyplugin', 'gh-bot.token')
  if (!env.GH_TOKEN && existsSync(tokenFile)) env.GH_TOKEN = readFileSync(tokenFile, 'utf8').trim()
  // `gh` keeps its own cache under XDG_CACHE_HOME; on this machine the default
  // is root-owned and unusable, and a failed cache write masks the run output.
  // `gh run view --log-failed` writes an HTTP cache here; the default cache on
  // this machine is root-owned, and a cache failure masks the log we asked for.
  if (!env.XDG_CACHE_HOME) {
    env.XDG_CACHE_HOME = join('/tmp', 'dsh-anyplugin-gh-cache')
    mkdirSync(env.XDG_CACHE_HOME, { recursive: true })
  }
  return execFileSync('gh', args, { env, encoding: 'utf8' })
}

function repoArgs() {
  return ['--repo', 'szchan/dsh-anyplugin']
}

function gitBranch() {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
}

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function runsFor(sha) {
  const out = gh([
    'run', 'list', '--workflow', WORKFLOW, '--commit', sha, '--limit', '5',
    '--json', 'databaseId,status,conclusion,createdAt,headSha,event', ...repoArgs(),
  ])
  return JSON.parse(out)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function failedLog(runId) {
  try {
    return gh(['run', 'view', String(runId), '--log-failed', ...repoArgs()])
  } catch (error) {
    return `(could not read the failed log: ${error.message})`
  }
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return 0
  }
  const branch = arg(argv, '--branch') ?? gitBranch()
  const head = arg(argv, '--head') ?? gitHead()
  const timeoutS = Number(arg(argv, '--timeout') ?? DEFAULT_RUN_TIMEOUT_S)
  const logFailedOnly = argv.includes('--log-failed')

  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    console.error('ci: --timeout must be a positive number of seconds')
    return 2
  }

  const appearDeadline = Date.now() + DEFAULT_APPEAR_TIMEOUT_S * 1000
  let run
  while (true) {
    const runs = runsFor(head)
    // One commit can carry two runs: the push run (the required `verify`) and,
    // for a same-repo PR, a skipped pull_request run. The push run is the one
    // whose conclusion means anything; a skipped/superseded run is not an answer.
    run = runs.find((candidate) => candidate.headSha === head && candidate.event === 'push' && candidate.status === 'completed' && candidate.conclusion !== 'skipped')
      ?? runs.find((candidate) => candidate.headSha === head && candidate.event === 'push')
      ?? runs.find((candidate) => candidate.headSha === head && candidate.conclusion !== 'skipped')
    if (run) break
    if (Date.now() > appearDeadline) {
      console.error(`ci: no ${WORKFLOW} run appeared for ${head.slice(0, 8)} on ${branch} within ${DEFAULT_APPEAR_TIMEOUT_S}s`)
      console.error('ci: a bot-opened PR can miss the push event; push an empty commit to re-trigger, then run this again')
      return 1
    }
    sleep(POLL_MS)
  }

  if (logFailedOnly) {
    if (run.conclusion === 'success') {
      console.log(`ci: ${run.databaseId} succeeded; nothing failed`)
      return 0
    }
    console.log(failedLog(run.databaseId))
    return run.conclusion === 'failure' ? 1 : 1
  }

  console.log(`ci: watching ${run.databaseId} (${run.status}${run.conclusion ? `/${run.conclusion}` : ''}) for ${head.slice(0, 8)} (${branch})`)
  const deadline = Date.now() + timeoutS * 1000
  let final = run
  while (Date.now() < deadline) {
    const current = JSON.parse(gh(['run', 'view', String(run.databaseId), '--json', 'status,conclusion', ...repoArgs()]))
    if (current.status === 'completed') {
      final = { ...run, ...current }
      break
    }
    sleep(POLL_MS)
  }
  if (final.status !== 'completed') {
    console.error(`ci: run ${run.databaseId} did not finish within ${timeoutS}s`)
    return 1
  }

  console.log(`ci: ${run.databaseId} ${final.conclusion}`)
  if (final.conclusion === 'success') return 0

  console.log('--- failed steps ---')
  try {
    const jobs = JSON.parse(gh(['run', 'view', String(run.databaseId), '--json', 'jobs', ...repoArgs()]))
    for (const job of jobs.jobs ?? []) {
      for (const step of job.steps ?? []) {
        if (step.conclusion === 'failure') console.log(`  ${job.name} :: ${step.name}`)
      }
    }
  } catch {
    // The log below is the real payload; the step list is a convenience.
  }
  console.log('--- log (failed) ---')
  console.log(failedLog(run.databaseId))
  return 1
}

process.exitCode = main(process.argv.slice(2))
