#!/usr/bin/env node
/**
 * integrate — do the integration runner's steps for one pull request (#263).
 *
 * The role is written in `docs/WORKFLOW.md` §The integration runner (D73): for
 * one PR it checks the reviewed head is the PR head, brings `origin/main` into
 * the branch, pushes that one branch, waits for the pushed head's `verify` run,
 * and reports the head to the master with the pinned merge line. By hand that
 * is the twelve-poll cycle F18 measured; this script is the command the runner
 * runs instead.
 *
 * What it will not do: merge, approve, force-push, push `main`, edit code,
 * resolve a conflict or refresh the PR body. A merge conflict is left in the
 * worktree with its conflicted paths printed, for a human: the additive-docs
 * conflict rule in WORKFLOW §The integration runner step 3 is the runner's
 * manual work, not this script's, and nothing here ever runs the merge line it
 * prints (D66, D73).
 *
 * The decisions are exported for `scripts/integrate.test.mjs`; `run` takes its
 * git, gh and CI-wait calls from `deps`, so the tests need no network and no
 * real repository. The preflight review rule and the worktree-list parser are
 * imported from `scripts/pr-update.mjs` rather than copied: the two commands
 * must refuse the same PRs.
 *
 *   npm run integrate <pr-number> [--json]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ghJson, repoArgs, sleep } from './ci-runs.mjs'
import { BASE, DEFAULT_ROOT, parseWorktreeList, reviewPr } from './pr-update.mjs'

const SHA = /^[0-9a-f]{40}$/

export function usage() {
  return `usage: npm run integrate <pr-number> [--json]

Does the integration runner's steps for one PR: preflight, find the worktree
that checks out the PR's head branch, merge origin/main into it and push the
branch when it is behind, wait for the pushed head's verify run, and print the
pinned merge line for the master. It never merges, approves, force-pushes,
pushes main, edits code, resolves a conflict or refreshes the PR body; a merge
conflict is left in the worktree for a human. --json prints the report as one
JSON document instead of the merge line.`
}

/** `[ '263' ]` -> `{ pr: 263, json: false }`; `--help` -> `{ help: true }`; anything else throws. */
export function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  const json = argv.includes('--json')
  const rest = argv.filter((arg) => arg !== '--json')
  const option = rest.find((arg) => arg.startsWith('-'))
  if (option !== undefined) throw new Error(`unknown option: ${option}`)
  if (rest.length !== 1) throw new Error('expected exactly one pull request number')
  if (!/^[1-9]\d*$/.test(rest[0])) throw new Error(`not a pull request number: ${rest[0]}`)
  const pr = Number(rest[0])
  if (!Number.isSafeInteger(pr)) throw new Error(`pull request number is out of range: ${rest[0]}`)
  return { pr, json }
}

/** The `gh pr view` fields the preflight reads; that is exactly the ticket's list. */
export const PREFLIGHT_FIELDS = 'state,isCrossRepository,baseRefName,headRefName,headRefOid'

/** The merge line the master runs, through the bot (D66). This script only prints it. */
export function formatMergeCommand(number, sha) {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`not a pull request number: ${number}`)
  if (!SHA.test(sha ?? '')) throw new Error(`not a 40-hex commit: ${sha}`)
  return `gh-bot pr merge ${number} --squash --match-head-commit ${sha}`
}

/**
 * The exact `git worktree add` line the runner should have been given for
 * `branch`. The runner does not invent a worktree, so this is only printed; the
 * master runs it. The branch is created from `origin/<branch>` when there is no
 * local branch yet, and reused when there is one.
 */
export function formatWorktreeAdd({ branch, root = DEFAULT_ROOT, localBranch = false }) {
  const path = join(root, String(branch).replaceAll('/', '-'))
  return localBranch
    ? `git worktree add ${path} ${branch}`
    : `git worktree add ${path} -b ${branch} origin/${branch}`
}

const short = (sha) => String(sha ?? 'none').slice(0, 12)

/**
 * Why the located worktree is not in the state the runner was dispatched for,
 * or `undefined` when it is. The reviewed head is the commit the reviewer read:
 * the worktree must be there, with no merge in progress and an empty tree.
 * Nothing here is repaired; the reason is the output.
 */
export function worktreeProblem({ worktree, head, run = git }) {
  if (worktree.head !== head) {
    return `the worktree at ${worktree.path} is at ${short(worktree.head)}, not the reviewed head ${short(head)}; re-dispatch from that head`
  }
  const quiet = (args) => run(args, worktree.path, { allowFailure: true })
  if (quiet(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status === 0) {
    return `a merge is already in progress in ${worktree.path}; finish or abort it yourself, this script will not`
  }
  const unmerged = quiet(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter((line) => line !== '')
  if (unmerged.length > 0) {
    return `${worktree.path} has unmerged paths in its index; finish or abort the merge yourself, this script will not`
  }
  if (quiet(['status', '--porcelain']).stdout.trim() !== '') {
    return `the worktree at ${worktree.path} is dirty; commit or stash it before integrating`
  }
  return undefined
}

/**
 * Wait for `npm run ci -- --head <head>` and report its exit status. The run
 * rule (only a push run is the gate, D83) belongs to `scripts/ci.mjs`; this
 * script must not reimplement polling. The child's output is relayed to stderr
 * so stdout stays the report (the merge line, or one JSON document).
 */
export function waitForCi(head, err = process.stderr) {
  const result = spawnSync('npm', ['run', '-s', 'ci', '--', '--head', head], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (output !== '') err.write(output.endsWith('\n') ? output : `${output}\n`)
  const exitCode = typeof result.status === 'number' ? result.status : 1
  return { ok: exitCode === 0, exitCode }
}

/** A stop the runner reports instead of working around: exit 2, one line. */
class Refusal extends Error {}

/** A failed step: exit 1, and the step is named in the report. */
class StepError extends Error {
  constructor(step, message) {
    super(message)
    this.name = 'StepError'
    this.step = step
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
    if (!allowFailure) throw new StepError(args[0], result.stderr.trim() || `git ${args.join(' ')} exited ${result.status}`)
    return result
  }
}

/**
 * The shell layer. `io` and `deps` are injectable so `scripts/integrate.test.mjs`
 * can drive every path with a fake `gh`, a fake `git` and a fake CI wait.
 */
export function run(argv, io = {}, deps = {}) {
  const out = io.out ?? process.stdout
  const err = io.err ?? process.stderr
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    err.write(`integrate: ${error.message}\n${usage()}\n`)
    return 2
  }
  if (parsed.help) {
    out.write(`${usage()}\n`)
    return 0
  }

  const number = parsed.pr
  const runGit = deps.git ?? git
  const runGh = deps.gh ?? ghJson
  const ciWait = deps.waitForCi ?? ((head) => waitForCi(head, err))
  const sleepFn = deps.sleep ?? sleep
  const root = process.env.ANYPLUGIN_WORKTREE_ROOT ?? DEFAULT_ROOT
  const readPr = (fields) => runGh(['pr', 'view', String(number), ...repoArgs(), '--json', fields])
  const readHead = () => {
    try {
      return readPr('headRefOid').headRefOid
    } catch (error) {
      throw new StepError('push', error.message ?? String(error))
    }
  }

  try {
    let pr
    try {
      pr = { ...readPr(PREFLIGHT_FIELDS), number }
    } catch (error) {
      throw new StepError('read', error.message ?? String(error))
    }
    const verdict = reviewPr(pr)
    if (!verdict.ok) throw new Refusal(verdict.reason)
    const branch = pr.headRefName
    const reviewedHead = pr.headRefOid
    err.write(`integrate: PR #${number} ${branch} @ ${reviewedHead} base ${pr.baseRefName}\n`)

    const worktrees = parseWorktreeList(runGit(['worktree', 'list', '--porcelain'], undefined).stdout)
    const worktree = worktrees.find((entry) => entry.branch === `refs/heads/${branch}`)
    if (worktree === undefined) {
      const local = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], undefined, { allowFailure: true })
        .status === 0
      throw new Refusal(
        `no worktree checks out ${branch}; create it with: ${formatWorktreeAdd({ branch, root, localBranch: local })}`,
      )
    }
    err.write(`integrate: worktree ${worktree.path}\n`)

    const problem = worktreeProblem({ worktree, head: reviewedHead, run: runGit })
    if (problem !== undefined) throw new Refusal(problem)

    runGit(['fetch', 'origin'], worktree.path)
    const ancestor = runGit(['merge-base', '--is-ancestor', `origin/${BASE}`, 'HEAD'], worktree.path, {
      allowFailure: true,
    })
    if (ancestor.status !== 0 && ancestor.status !== 1) {
      throw new StepError('merge-base', ancestor.stderr.trim() || `git merge-base --is-ancestor exited ${ancestor.status}`)
    }

    let head = reviewedHead
    let pushed = false
    if (ancestor.status === 1) {
      err.write(`integrate: merging origin/${BASE} into ${branch} in ${worktree.path}\n`)
      const merged = runGit(['merge', `origin/${BASE}`], worktree.path, { allowFailure: true })
      if (merged.status !== 0) {
        const conflicts = runGit(['diff', '--name-only', '--diff-filter=U'], worktree.path, { allowFailure: true })
          .stdout.split('\n')
          .filter((line) => line !== '')
        if (conflicts.length > 0) {
          throw new StepError(
            'merge',
            `conflict in ${conflicts.join(', ')}; the merge is left in ${worktree.path} for a human and nothing was pushed`,
          )
        }
        throw new StepError('merge', merged.stderr.trim() || merged.stdout.trim() || `git merge exited ${merged.status}`)
      }

      head = runGit(['rev-parse', 'HEAD'], worktree.path).stdout.trim()
      if (!SHA.test(head)) throw new StepError('merge', `git rev-parse HEAD did not return a 40-hex commit (${head})`)

      // One refspec, no force: the branch is ours to push and the only commit
      // that moved it is the merge above (the role's one allowed push).
      const push = runGit(['push', 'origin', `HEAD:${branch}`], worktree.path, { allowFailure: true })
      if (push.status !== 0) throw new StepError('push', push.stderr.trim() || push.stdout.trim() || `git push exited ${push.status}`)

      // The PR's head is the branch ref; give the API a moment in case the read
      // lands before it reflects the push.
      let after = readHead()
      for (let attempt = 0; after !== head && attempt < 5; attempt += 1) {
        sleepFn(1000)
        after = readHead()
      }
      if (after !== head) {
        throw new StepError('push', `the PR head is still ${short(after)}, not ${short(head)}; the push did not update this PR`)
      }
      pushed = true
      err.write(`integrate: pushed ${head} to ${branch}\n`)
    } else {
      err.write(`integrate: ${branch} already contains origin/${BASE}; nothing to push\n`)
    }

    err.write(`integrate: waiting for the verify run on ${head}\n`)
    const ci = ciWait(head)
    if (ci === undefined || ci.ok !== true) {
      const exit = ci === undefined ? 'no result' : `exit ${ci.exitCode}`
      throw new StepError('ci', `verify on ${head} did not pass (${exit}); read the failure with npm run ci -- --head ${head} --log-failed`)
    }

    const mergeCommand = formatMergeCommand(number, head)
    if (parsed.json) {
      const report = {
        pr: number,
        branch,
        base: pr.baseRefName,
        worktree: worktree.path,
        previousHead: reviewedHead,
        head,
        pushed,
        ci: { ok: true, exitCode: ci.exitCode ?? 0 },
        mergeCommand,
      }
      out.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      err.write(`integrate: verify passed on ${head}; the merge line is for the master\n`)
      out.write(`${mergeCommand}\n`)
    }
    return 0
  } catch (error) {
    if (error instanceof Refusal) {
      err.write(`integrate: ${error.message}\n`)
      return 2
    }
    if (error instanceof StepError) {
      err.write(`integrate: failed at ${error.step}: ${error.message}\n`)
      return 1
    }
    err.write(`integrate: unexpected: ${error.message ?? String(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2))
}
