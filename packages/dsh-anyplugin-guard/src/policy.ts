/**
 * The guard's judgement, as a pure function of a call and a policy.
 *
 * Every rule is stated over *the call the model is about to make*, because
 * that is the only place a decision can still change behavior. The plugin in
 * `index.ts` runs this exact function, and so does
 * `npm run guard:install -- --dry-run`, so the table in the install output
 * cannot drift from what the running plugin does.
 *
 * Four rules, in this order:
 *
 * 1. `decisions-append-only` — `docs/DECISIONS.md` is a ratified, hashed log;
 *    the only writer is `node scripts/check-decisions.mjs --update`, which
 *    accepts new entries and refuses edits to old ones. A hand edit, a
 *    truncate, a redirect or an interpreter one-liner that writes it is denied
 *    for every agent, root or worker.
 * 2. `git-push-main` — no agent pushes to `main`/`master`, whether named in
 *    the refspec, implied by `--all`/`--mirror`, or implied by a bare push
 *    from a main checkout. The worktree is where the ticket lives; the PR is
 *    how it lands.
 * 3. `gh-pr-merge-worker` — a worker may open a PR, never merge one. The root
 *    (the master) is the only merger, and only after review.
 * 4. `write-outside-worktree` — a worker writes inside the worktree it was
 *    given and nowhere else. The main checkout is a protected root even when
 *    no worktree was recorded, so a broken brief fails closed.
 *
 * The guard is a policy check on top of the host: it reads the same
 * `tools/pre-execute` payload the host dispatches and returns `deny` with a
 * reason. It is not a sandbox. A command can hide its intent from any reader
 * (`eval "$(printf …)"`), and the guard says so instead of pretending
 * otherwise; DSH's own file sandbox remains the enforced boundary.
 */
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isMainRef } from './git.ts'
import { baseCommand, parseSegments, stripPrefix, type ShellSegment } from './shell.ts'

/** The brief the guard injects into a spawned worker (see `brief.ts`). */
export interface BriefConfig {
  /** Ratchet totals, verbatim, e.g. `25 declared / 24 matched / 0 missing / 1 refused`. */
  ratchet: string[]
  /** Fixture count sentence, e.g. `14 fixtures`. */
  fixtures?: string
  /** Rows the ratchet is still red on, e.g. `mcpServers:…:refused`. */
  open: string[]
}

/** What the plugin is configured with, and what the installer writes. */
export interface GuardConfig {
  shellTools?: string[]
  writeTools?: string[]
  /** Absolute worktree paths workers may write under. */
  worktrees?: string[]
  /** Absolute roots no worker may write under (the main checkout). */
  protectedRoots?: string[]
  /** Paths (relative to a repository root or absolute) that only `--update` may write. */
  decisions?: string[]
  brief?: BriefConfig | false
}

/** `GuardConfig` with defaults applied and the sets built once per apply. */
export interface ResolvedPolicy {
  shellTools: Set<string>
  writeTools: Set<string>
  worktrees: string[]
  protectedRoots: string[]
  decisions: string[]
  brief: BriefConfig | false
}

/** The agent as the host's `ExecView` exposes it (session header only). */
export interface GuardAgentView {
  id?: string
  cwd?: string
  /** True when `session.header.parentSession` is set: a subagent. */
  worker: boolean
}

/** One `tools/pre-execute` call, reduced to what the rules read. */
export interface GuardCall {
  tool: string
  args: Record<string, unknown>
  agent: GuardAgentView
  /** The worktree recorded for this agent by the brief, when known. */
  worktree?: string
}

/** The filesystem facts the pure rules cannot read for themselves. */
export interface JudgeContext {
  branch(cwd: string | undefined): string | undefined
}

export type Verdict = { kind: 'allow'; rule: 'allow' } | { kind: 'deny'; rule: string; reason: string }

export const DEFAULT_SHELL_TOOLS = ['bash', 'sh', 'zsh', 'shell', 'pwsh', 'powershell', 'exec', 'terminal']
export const DEFAULT_WRITE_TOOLS = ['write', 'edit', 'apply_patch']
export const DEFAULT_DECISIONS = ['docs/DECISIONS.md', 'docs/decisions.lock.json']

const ALLOW: Verdict = { kind: 'allow', rule: 'allow' }

/** Apply defaults; the installer always writes them explicitly, tests may omit them. */
export function resolvePolicy(config: GuardConfig = {}): ResolvedPolicy {
  return {
    shellTools: new Set(config.shellTools ?? DEFAULT_SHELL_TOOLS),
    writeTools: new Set(config.writeTools ?? DEFAULT_WRITE_TOOLS),
    worktrees: (config.worktrees ?? []).map((path) => resolve(path)),
    protectedRoots: (config.protectedRoots ?? []).map((path) => resolve(path)),
    decisions: config.decisions ?? DEFAULT_DECISIONS,
    brief: config.brief ?? false,
  }
}

function deny(rule: string, reason: string): Verdict {
  return { kind: 'deny', rule, reason: `anyplugin-guard: ${reason} (rule ${rule})` }
}

function excerpt(value: string, limit = 140): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Resolve a path the way the shell and the file tools do: absolute stays, relative joins cwd. */
export function resolveTarget(raw: string, cwd: string | undefined): string | undefined {
  const value = raw.trim()
  if (value.length === 0) return undefined
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value
  if (isAbsolute(expanded)) return resolve(expanded)
  return cwd === undefined ? undefined : resolve(cwd, expanded)
}

/** True when `target` is `root` or below it; `..` and absolute relatives do not escape. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function normalized(path: string): string {
  return path.replaceAll('\\', '/')
}

function isDecisionsTarget(target: string, policy: ResolvedPolicy): boolean {
  const path = normalized(target)
  return policy.decisions.some((suffix) => {
    const clean = normalized(suffix).replace(/^\.\//u, '').replace(/^\//u, '')
    return path === clean || path.endsWith(`/${clean}`)
  })
}

function mentionsDecisions(value: string): boolean {
  return /(?:^|[^A-Za-z0-9_.-])(?:docs\/)?DECISIONS\.md(?:[^A-Za-z0-9_.-]|$)|decisions\.lock\.json/u.test(value)
}

/** The write tools carry their targets in different fields; this is the whole list. */
export function writeTargets(tool: string, args: Record<string, unknown>): string[] {
  if (tool === 'apply_patch') {
    const input = typeof args.input === 'string' ? args.input : ''
    return patchTargets(input)
  }
  const value = args.file_path ?? args.path
  return typeof value === 'string' ? [value] : []
}

/** `*** Add File: x`, `*** Update File: x`, `*** Delete File: x`, `*** Move to: x`. */
export function patchTargets(input: string): string[] {
  const targets: string[] = []
  for (const match of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
    targets.push(match[1].trim())
  }
  for (const match of input.matchAll(/^\*\*\* Move to: (.+)$/gmu)) {
    targets.push(match[1].trim())
  }
  return targets
}

/** The worktree the confinement check uses: the brief's record, or the only configured one. */
export function effectiveWorktree(call: GuardCall, policy: ResolvedPolicy): string | undefined {
  if (call.worktree !== undefined) return resolve(call.worktree)
  return policy.worktrees.length === 1 ? policy.worktrees[0] : undefined
}

function confinement(target: string, worktree: string | undefined, policy: ResolvedPolicy): Verdict | undefined {
  for (const root of policy.protectedRoots) {
    if (isInside(root, target)) {
      return deny(
        'write-outside-worktree',
        `refusing to write ${target}: it is inside the protected checkout ${root}; a worker writes only inside its own worktree`,
      )
    }
  }
  if (worktree !== undefined) {
    if (!isInside(worktree, target)) {
      return deny(
        'write-outside-worktree',
        `refusing to write ${target}: a worker writes only inside its worktree ${worktree}; pass an absolute path under it`,
      )
    }
    return undefined
  }
  if (policy.worktrees.length > 0 && !policy.worktrees.some((root) => isInside(root, target))) {
    return deny(
      'write-outside-worktree',
      `refusing to write ${target}: this agent has no recorded worktree and the path is not inside a configured worktree (${policy.worktrees.join(', ')})`,
    )
  }
  return undefined
}

const DECISIONS_REASON =
  'refusing to edit docs/DECISIONS.md by hand: it is append-only through `node scripts/check-decisions.mjs --update`; put the proposed entry text in the PR body'

function judgeWrite(call: GuardCall, policy: ResolvedPolicy): Verdict {
  const targets = writeTargets(call.tool, call.args)
  for (const raw of targets) {
    const target = resolveTarget(raw, call.agent.cwd)
    if (target !== undefined && isDecisionsTarget(target, policy)) {
      return deny('decisions-append-only', DECISIONS_REASON)
    }
  }
  if (!call.agent.worker) return ALLOW
  for (const raw of targets) {
    const target = resolveTarget(raw, call.agent.cwd)
    if (target === undefined) continue
    const violation = confinement(target, effectiveWorktree(call, policy), policy)
    if (violation !== undefined) return violation
  }
  return ALLOW
}

interface GitPush {
  dir?: string
  args: string[]
}

const GIT_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '-c', '--exec-path'])

/** `git [options] push <args>` → the push arguments, or undefined. */
export function parseGitPush(tokens: string[]): GitPush | undefined {
  const head = stripPrefix(tokens)
  if (head.length === 0 || baseCommand(head[0]) !== 'git') return undefined
  let index = 1
  let dir: string | undefined
  while (index < head.length) {
    const token = head[index]
    if (GIT_VALUE_FLAGS.has(token)) {
      if (token === '-C') dir = head[index + 1]
      index += 2
      continue
    }
    if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=') || token.startsWith('--namespace=')) {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  if (head[index] !== 'push') return undefined
  return { dir, args: head.slice(index + 1) }
}

const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

/** Split push arguments into flags and positionals (`[remote, ...refspecs]`). */
export function pushArguments(args: string[]): { positionals: string[]; all: boolean } {
  const positionals: string[] = []
  let all = false
  let index = 0
  while (index < args.length) {
    const token = args[index]
    if (token === '--all' || token === '--mirror' || token === '--branches') {
      all = true
      index += 1
      continue
    }
    if (PUSH_VALUE_FLAGS.has(token)) {
      index += 2
      continue
    }
    if (token.startsWith('--push-option=') || token.startsWith('--repo=') || token.startsWith('--receive-pack=')) {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    positionals.push(token)
    index += 1
  }
  return { positionals, all }
}

/** The remote ref a push refspec writes: `+HEAD:refs/heads/main` → `main`. */
export function destinationRef(refspec: string, branch: string | undefined): string | undefined {
  const spec = refspec.replace(/^\+/u, '')
  const colon = spec.lastIndexOf(':')
  if (colon >= 0) {
    const destination = spec.slice(colon + 1)
    if (destination.length > 0) return destination.replace(/^refs\/heads\//u, '')
    const source = spec.slice(0, colon)
    return source.length > 0 ? source.replace(/^refs\/heads\//u, '') : undefined
  }
  if (spec === 'HEAD') return branch
  return spec.replace(/^refs\/heads\//u, '')
}

function judgePush(push: GitPush, branch: string | undefined, raw: string): Verdict | undefined {
  const { positionals, all } = pushArguments(push.args)
  if (all) {
    return deny(
      'git-push-main',
      `refusing "${excerpt(raw)}": --all/--mirror/--branches pushes main too; push the ticket branch by name`,
    )
  }
  const refspecs = positionals.slice(1)
  if (refspecs.length === 0) {
    if (branch === undefined) {
      return deny(
        'git-push-main',
        `refusing "${excerpt(raw)}": the guard cannot tell which branch a bare push would write; name the destination (e.g. \`git push origin ticket/80\`)`,
      )
    }
    if (isMainRef(branch)) {
      return deny(
        'git-push-main',
        `refusing "${excerpt(raw)}": the checked-out branch is ${branch}; push the ticket branch and open a PR`,
      )
    }
    return undefined
  }
  for (const refspec of refspecs) {
    const destination = destinationRef(refspec, branch)
    if (destination !== undefined && isMainRef(destination)) {
      return deny(
        'git-push-main',
        `refusing "${excerpt(raw)}": it writes ${destination}; agents never push to main, they open a PR`,
      )
    }
  }
  return undefined
}

/** `gh pr merge …`, including `gh -R owner/repo pr merge` and `gh api …/merge -X PUT`. */
export function ghPrMerge(tokens: string[]): boolean {
  const head = stripPrefix(tokens)
  if (head.length === 0 || baseCommand(head[0]) !== 'gh') return false
  const pr = head.indexOf('pr')
  if (pr > 0 && head[pr + 1] === 'merge') return true
  if (head.includes('api')) {
    const text = head.join(' ')
    return /\/merge(?:\s|$)/u.test(text) && /(?:-X|--method)\s+(?:PUT|POST)/iu.test(text)
  }
  return false
}

const DECISIONS_PATH = /docs\/DECISIONS\.md|decisions\.lock\.json/u
const COPY_VERBS = new Set(['cp', 'mv', 'install', 'ln', 'rsync'])
const ANY_ARG_WRITE_VERBS = new Set(['rm', 'tee', 'truncate', 'patch'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'php'])
const GIT_WRITE_SUBCOMMANDS = new Set(['checkout', 'restore', 'reset', 'apply', 'rm', 'mv', 'stash'])

function nonFlagArguments(tokens: string[]): string[] {
  return tokens.slice(1).filter((token) => !token.startsWith('-'))
}

/** Is this the one sanctioned writer of the decisions log? */
export function isSanctionedUpdate(tokens: string[]): boolean {
  const head = stripPrefix(tokens)
  const nodeDirect =
    head.length === 3 && baseCommand(head[0]) === 'node' && /(?:^|\/)scripts\/check-decisions\.mjs$/u.test(head[1]) && head[2] === '--update'
  const npmRun =
    head.length === 5 &&
    (baseCommand(head[0]) === 'npm' || baseCommand(head[0]) === 'pnpm') &&
    head[1] === 'run' &&
    head[2] === 'check:decisions' &&
    head[3] === '--' &&
    head[4] === '--update'
  return nodeDirect || npmRun
}

function redirectTargets(raw: string): string[] {
  const targets: string[] = []
  for (const match of raw.matchAll(/(?:^|\s)(?:\d?>>?|&>)\s*("([^"]*)"|'([^']*)'|([^\s;|&]+))/gu)) {
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (value.length > 0 && value !== '/dev/null' && !value.startsWith('&')) targets.push(value)
  }
  return targets
}

/** The paths a single segment writes, as written. */
function segmentWriteTargets(segment: ShellSegment): string[] {
  const targets = redirectTargets(segment.raw)
  const head = stripPrefix(segment.tokens)
  const command = baseCommand(head[0])
  const args = head.slice(1)
  if (COPY_VERBS.has(command)) {
    const directory = args.indexOf('-t')
    if (directory >= 0 && args[directory + 1] !== undefined) {
      targets.push(args[directory + 1])
    } else {
      const positional = args.filter((token) => !token.startsWith('-'))
      if (positional.length > 0) targets.push(positional[positional.length - 1])
    }
    return targets
  }
  if (ANY_ARG_WRITE_VERBS.has(command)) {
    targets.push(...nonFlagArguments(head))
    return targets
  }
  if (command === 'mkdir' || command === 'rmdir' || command === 'touch' || command === 'chmod' || command === 'chown') {
    targets.push(...nonFlagArguments(head).filter((token) => token.length > 0 && !/^\d+$/u.test(token)))
    return targets
  }
  if (command === 'dd') {
    for (const token of args) {
      if (token.startsWith('of=')) targets.push(token.slice(3))
    }
    return targets
  }
  if (command === 'sed' || command === 'perl') {
    const inline = args.some((token) => /^-[A-Za-z]*i/u.test(token) || token === '--in-place')
    if (!inline) return targets
    const scripted = args.some((token) => token === '-e' || token === '--expression')
    const files: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]
      if (token === '-e' || token === '--expression') {
        index += 1
        continue
      }
      if (token.startsWith('-')) continue
      files.push(token)
    }
    if (!scripted) files.shift()
    targets.push(...files)
  }
  return targets
}

function decisionsViolation(segment: ShellSegment): Verdict | undefined {
  if (!mentionsDecisions(segment.raw)) return undefined
  if (isSanctionedUpdate(segment.tokens)) return undefined
  const head = stripPrefix(segment.tokens)
  const command = baseCommand(head[0])
  const args = head.slice(1)
  const written: string[] = redirectTargets(segment.raw)
  if (COPY_VERBS.has(command)) {
    const positional = args.filter((token) => !token.startsWith('-'))
    if (positional.length > 0) written.push(positional[positional.length - 1])
  } else if (ANY_ARG_WRITE_VERBS.has(command)) {
    written.push(...nonFlagArguments(head))
  } else if (command === 'dd') {
    for (const token of args) if (token.startsWith('of=')) written.push(token.slice(3))
  } else if (command === 'git' && GIT_WRITE_SUBCOMMANDS.has(head[1] ?? '')) {
    written.push(...args)
  } else if (command === 'sed' || command === 'perl') {
    if (args.some((token) => /^-[A-Za-z]*i/u.test(token) || token === '--in-place')) {
      written.push(...args.filter((token) => !token.startsWith('-')))
    }
  } else if (INTERPRETERS.has(command) && args.some((token) => token === '-e' || token === '-c' || token.startsWith('--eval'))) {
    written.push(...args)
  }
  if (written.some((value) => DECISIONS_PATH.test(value))) {
    return deny('decisions-append-only', `${DECISIONS_REASON} (command: "${excerpt(segment.raw)}")`)
  }
  return undefined
}

function flatten(segments: ShellSegment[], out: ShellSegment[] = []): ShellSegment[] {
  for (const segment of segments) {
    out.push(segment)
    flatten(segment.children, out)
  }
  return out
}

function collectShellWrites(segments: ShellSegment[], cwd: string | undefined): Array<{ raw: string; cwd: string | undefined }> {
  const writes: Array<{ raw: string; cwd: string | undefined }> = []
  const walk = (list: ShellSegment[], start: string | undefined): void => {
    let current = start
    for (const segment of list) {
      for (const raw of segmentWriteTargets(segment)) writes.push({ raw, cwd: current })
      if (segment.children.length > 0) walk(segment.children, current)
      const head = stripPrefix(segment.tokens)
      if (baseCommand(head[0]) === 'cd' && head[1] !== undefined) {
        const target = resolveTarget(head[1], current)
        if (target !== undefined) current = target
      }
    }
  }
  walk(segments, cwd)
  return writes
}

function judgeCommand(
  command: string,
  cwd: string | undefined,
  agent: GuardAgentView,
  worktree: string | undefined,
  policy: ResolvedPolicy,
  context: JudgeContext,
): Verdict {
  const segments = parseSegments(command)
  const flat = flatten(segments)
  if (flat.length === 1 && flat[0].children.length === 0 && isSanctionedUpdate(flat[0].tokens)) return ALLOW

  for (const segment of flat) {
    const violation = decisionsViolation(segment)
    if (violation !== undefined) return violation
  }

  for (const segment of flat) {
    const push = parseGitPush(segment.tokens)
    if (push === undefined) continue
    const pushCwd = push.dir === undefined ? cwd : (resolveTarget(push.dir, cwd) ?? cwd)
    const violation = judgePush(push, context.branch(pushCwd), segment.raw)
    if (violation !== undefined) return violation
  }

  if (!agent.worker) return ALLOW

  for (const segment of flat) {
    if (ghPrMerge(segment.tokens)) {
      return deny(
        'gh-pr-merge-worker',
        `refusing "${excerpt(segment.raw)}": a worker may open a PR but never merge one; the master merges after review`,
      )
    }
  }

  for (const write of collectShellWrites(segments, cwd)) {
    const target = resolveTarget(write.raw, write.cwd)
    if (target === undefined) continue
    const violation = confinement(target, worktree, policy)
    if (violation !== undefined) return violation
  }
  return ALLOW
}

/**
 * Judge one call. `context.branch` is the only filesystem dependency: the
 * policy reads it for a bare `git push` and nowhere else.
 */
export function judgeCall(call: GuardCall, policy: ResolvedPolicy, context: JudgeContext): Verdict {
  const args = call.args ?? {}
  if (policy.shellTools.has(call.tool)) {
    const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : undefined
    if (command === undefined) return ALLOW
    const workdir = typeof args.workdir === 'string' ? resolveTarget(args.workdir, call.agent.cwd) : undefined
    const cwd = workdir ?? call.agent.cwd
    return judgeCommand(command, cwd, call.agent, effectiveWorktree(call, policy), policy, context)
  }
  if (policy.writeTools.has(call.tool)) return judgeWrite(call, policy)
  return ALLOW
}
