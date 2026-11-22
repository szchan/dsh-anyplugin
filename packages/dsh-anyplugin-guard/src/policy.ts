/**
 * The guard's judgement, as a pure function of a call and a policy.
 *
 * Every rule is stated over *the call the model is about to make*, because
 * that is the only place a decision can still change behavior. The plugin in
 * `index.ts` runs this exact function, and so does
 * `npm run guard:install -- --dry-run`, so the table in the install output
 * cannot drift from what the running plugin does.
 *
 * Rules, in order:
 *
 * 1. `decisions-append-only` — `docs/DECISIONS.md` is a ratified, hashed log;
 *    the only writer is `node scripts/check-decisions.mjs --update`, which
 *    accepts new entries and refuses edits to old ones.
 * 2. `git-push-main` / `git-push-shape` / `git-push-bare` — the only modelled
 *    push is `git push [-u] origin <one refspec that is not main>`. Bare
 *    pushes, extra refspecs or flags, other remotes, `--receive-pack`,
 *    `--exec`, `send-pack` and `update-ref` are refused by name. A push is
 *    never inferred from configuration.
 * 3. `gh-pr-merge-worker` / `gh-pr-merge-pin` — a worker may open a PR, never
 *    merge one; every merge that is allowed must carry
 *    `--match-head-commit <40-hex>`. The pin prevents the merge from omitting
 *    the head; it does not prove that the head was reviewed.
 * 4. `write-outside-worktree` — a worker writes inside the worktree it was
 *    given and nowhere else; with no recorded worktree, writes fail closed.
 * 5. `shell-unmodelled` / `shell-script-unverified` — the shell reader refuses
 *    what it cannot see: grouping, a background `&`, command substitution,
 *    backticks, here-strings, process substitution, stdin shells, `find
 *    -exec`, unquoted `$` expansion, unknown commands, and (for workers)
 *    running a script file whose bytes it did not verify.
 * 6. `git-config-write` / `git-unknown-subcommand` — a worker runs no
 *    `-c`/`--config-env` and no `git config`; the root may not set keys that
 *    execute a program (`alias.*`, `filter.*`, `core.pager`, `core.fsmonitor`,
 *    hooks path, ssh command, …). Unknown git subcommands are refused for
 *    workers because an alias can hide a push behind one.
 *
 * The tool layer is what sees a tool call. The managed `pre-push` hook is
 * defence in depth for a push that reaches git without going through
 * `tools/pre-execute`; it runs after refs are discovered and before objects
 * are sent, and a caller who passes `--no-verify` skips it by design. Neither
 * layer is containment: branch protection, the DSH sandbox and CI are the
 * boundary. The shell policy is a convention checker for honest mistakes; its
 * residual holes are a root-run script (unverified bytes), a host that later
 * executes a config key the root wrote, a git feature outside the modelled
 * subcommand list reached by another path, and `--no-verify` inside a command
 * the reader did not model. They are named here rather than papered over.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isMainRef } from './git.ts'
import { baseCommand, expansionHazard, leadingAssignments, parseSegments, shellScriptFile, shellStdinHazard, stripPrefix, unquotedText, type ShellSegment } from './shell.ts'

/** The brief the guard injects into a spawned worker (see `brief.ts`). */
export interface BriefConfig {
  /** Ratchet totals, verbatim, e.g. `25 declared / 24 matched / 0 missing / 1 refused`. */
  ratchet: string[]
  /** Fixture count sentence, e.g. `11 fixtures`: the directories the ratchet owns. */
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

/**
 * A path inside a git directory. A worker that appends a diff driver, a
 * filter, a hook or an ssh command to `.git/config` plants a program the key
 * allowlist on the command line cannot see; the guard refuses the write
 * instead of trying to read what the file will mean later.
 */
export function insideGitDirectory(target: string): boolean {
  return normalized(realTarget(target)).split('/').includes('.git')
}

/**
 * The real path of `target`. A file tool follows symlinks, so a lexical check
 * is not enough: a symlink placed inside the worktree that points into the
 * main checkout would otherwise pass. Missing tails are resolved against the
 * nearest existing ancestor, so a not-yet-created file is still judged by the
 * directory it would land in.
 */
export function realTarget(target: string): string {
  let current = resolve(target)
  const tail: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return resolve(realpathSync.native(current), ...tail.slice().reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(target)
      tail.push(basename(current))
      current = parent
    }
  }
  return resolve(target)
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

/**
 * The worktree the confinement check uses. Only a recorded worktree counts:
 * inferring one from configuration (or worse, from a branch name in the
 * prompt) lets a reviewer write into the branch under review.
 */
export function effectiveWorktree(call: GuardCall, _policy: ResolvedPolicy): string | undefined {
  return call.worktree === undefined ? undefined : resolve(call.worktree)
}

function confinement(target: string, worktree: string | undefined, policy: ResolvedPolicy): Verdict | undefined {
  const real = realTarget(target)
  for (const root of policy.protectedRoots) {
    if (isInside(realTarget(root), real)) {
      return deny(
        'write-outside-worktree',
        `refusing to write ${target}: it is (or resolves through a symlink) inside the protected checkout ${root}; a worker writes only inside its own worktree`,
      )
    }
  }
  if (worktree === undefined) {
    return deny(
      'write-outside-worktree',
      `refusing to write ${target}: no worktree is recorded for this agent; use an explicit absolute path under your own worktree, and ask the master to include the path in the spawn prompt if it was omitted`,
    )
  }
  if (!isInside(realTarget(worktree), real)) {
    return deny(
      'write-outside-worktree',
      `refusing to write ${target}: a worker writes only inside its worktree ${worktree}; pass an absolute path under it`,
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
    if ((target !== undefined && isDecisionsTarget(target, policy)) || (target === undefined && isDecisionsTarget(raw, policy))) {
      return deny('decisions-append-only', DECISIONS_REASON)
    }
  }
  if (!call.agent.worker) return ALLOW
  for (const raw of targets) {
    const target = resolveTarget(raw, call.agent.cwd)
    if (target === undefined) {
      return deny(
        'write-outside-worktree',
        `refusing to write ${raw}: the session has no cwd, so a relative path cannot be resolved; use an absolute path under your worktree`,
      )
    }
    if (insideGitDirectory(target)) {
      return deny(
        'git-dir-write',
        `refusing to write ${target}: a worker does not write inside .git; a config or hook planted there runs as the next git command`,
      )
    }
    const violation = confinement(target, effectiveWorktree(call, policy), policy)
    if (violation !== undefined) return violation
  }
  return ALLOW
}

interface GitPush {
  dir?: string
  args: string[]
}

const GIT_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '-c', '--config-env', '--exec-path'])

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
  const spec = refspec
    .replace(/^\+/u, '')
    .replace(/^\$/u, '')
    .replace(/^['"`]+|['"`]+$/gu, '')
    .replace(/[&;)}\]]+$/u, '')
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

const PUSH_EXEC_FLAGS = new Set(['--receive-pack', '--exec'])
const PUSH_ALLOWED_FLAGS = new Set(['-u', '--set-upstream', '--force-with-lease', '--force-if-includes'])

function pushExecFlag(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (PUSH_EXEC_FLAGS.has(token)) return token
    if (token.startsWith('--receive-pack=') || token.startsWith('--exec=')) return token.slice(0, token.indexOf('='))
  }
  return undefined
}

/**
 * The push whitelist. A worker needs one shape:
 * `git push [-u] origin <one refspec that is not main>`.
 * Everything else is refused by name rather than parsed for a hidden push.
 */
function judgePush(push: GitPush, branch: string | undefined, raw: string): Verdict | undefined {
  const exec = pushExecFlag(push.args)
  if (exec !== undefined) {
    return deny(
      'git-push-exec',
      `refusing "${excerpt(raw)}": ${exec} runs a program from the push itself; push with an explicit origin and ticket refspec`,
    )
  }
  const { positionals, all } = pushArguments(push.args)
  if (all) {
    return deny(
      'git-push-main',
      `refusing "${excerpt(raw)}": --all/--mirror/--branches pushes main too; push the ticket branch by name`,
    )
  }
  const flags = push.args.filter((token) => token.startsWith('-'))
  const unexpected = flags.find((token) => !PUSH_ALLOWED_FLAGS.has(token))
  if (unexpected !== undefined) {
    return deny(
      'git-push-shape',
      `refusing "${excerpt(raw)}": only \`git push [-u] origin <ticket-refspec>\` is modelled; ${unexpected} is not part of it`,
    )
  }
  const refspecs = positionals.slice(1)
  if (positionals.length < 2 || refspecs.length === 0) {
    // A bare push does not mean "the current branch": `remote.<r>.push` and
    // `push.default=upstream` can redirect it to main. The guard refuses the
    // ambiguous form instead of guessing.
    return deny(
      'git-push-bare',
      `refusing "${excerpt(raw)}": a bare git push can write main through remote.<name>.push or push.default; name the destination explicitly (e.g. \`git push origin HEAD:refs/heads/ticket/80\`)`,
    )
  }
  if (positionals[0] !== 'origin') {
    return deny(
      'git-push-shape',
      `refusing "${excerpt(raw)}": only the origin remote is modelled; got ${positionals[0]}`,
    )
  }
  if (refspecs.length !== 1) {
    return deny(
      'git-push-shape',
      `refusing "${excerpt(raw)}": push one refspec at a time, so the guard can name every destination`,
    )
  }
  if (/[*?[]/u.test(refspecs[0]) || refspecs[0].includes('..')) {
    return deny(
      'git-push-shape',
      `refusing "${excerpt(raw)}": a wildcard or range refspec can address main through a pattern; name the one destination`,
    )
  }
  const destination = destinationRef(refspecs[0], branch)
  if (destination !== undefined && isMainRef(destination)) {
    return deny(
      'git-push-main',
      `refusing "${excerpt(raw)}": it writes ${destination}; agents never push to main, they open a PR`,
    )
  }
  return undefined
}

type MergePath = 'pr' | 'api'

const MERGE_PIN_FLAG = '--match-head-commit'
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/iu
const MERGE_API_PATH = /(?:^|\/)pulls\/[^/]+\/merge(?:\?.*)?$/u

/** The position of `pr merge` in `gh`'s arguments, or -1. */
function mergeSubcommandAt(head: string[]): number {
  return head.findIndex((token, index) => index > 0 && token === 'pr' && head[index + 1] === 'merge')
}

/** `gh api repos/o/r/pulls/<n>/merge` with an explicit PUT/POST. */
function apiMerge(tokens: string[]): boolean {
  if (!tokens.some((token) => MERGE_API_PATH.test(token))) return false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '-X' || token === '--method') {
      if (/^(?:PUT|POST)$/iu.test(tokens[index + 1] ?? '')) return true
      continue
    }
    if (/^--method=(?:PUT|POST)$/iu.test(token)) return true
    if (/^-X=?(?:PUT|POST)$/iu.test(token)) return true
  }
  return false
}

/** Which modelled `gh` merge path the segment is, if any. */
function ghMergePath(tokens: string[]): MergePath | undefined {
  const head = stripPrefix(tokens)
  if (head.length === 0 || baseCommand(head[0]) !== 'gh') return undefined
  if (mergeSubcommandAt(head) > 0) return 'pr'
  if (head.includes('api') && apiMerge(head)) return 'api'
  return undefined
}

/** Why the effective `--match-head-commit` on a `gh pr merge` is unusable, if it is. */
function mergePinProblem(tokens: string[]): string | undefined {
  const head = stripPrefix(tokens)
  const pr = mergeSubcommandAt(head)
  if (pr < 0) return `no ${MERGE_PIN_FLAG} is present`
  let seen = false
  let value: string | undefined
  let missing = false
  // pflag reads flags until `--` and lets the last repeated flag win, so the
  // last occurrence is the one GitHub will receive.
  for (let index = pr + 2; index < head.length; index += 1) {
    const token = head[index]
    if (token === '--') break
    if (token === MERGE_PIN_FLAG) {
      seen = true
      value = head[index + 1]
      missing = value === undefined
      index += 1
    } else if (token.startsWith(`${MERGE_PIN_FLAG}=`)) {
      seen = true
      value = token.slice(MERGE_PIN_FLAG.length + 1)
      missing = false
    }
  }
  if (!seen) return `no ${MERGE_PIN_FLAG} is present`
  if (missing) return `${MERGE_PIN_FLAG} has no value`
  if (value === undefined || !FULL_COMMIT_SHA.test(value)) {
    return `"${value ?? ''}" is not a full 40-hex commit sha`
  }
  return undefined
}

function mergePinReason(raw: string, problem: string): string {
  return `refusing "${excerpt(raw)}": ${problem}; the guard cannot know which commit was reviewed, so the pin is how the merge becomes falsifiable. Use \`gh pr merge <number> [--squash|--merge|--rebase] --match-head-commit <40-hex reviewed head>\`.`
}

/** `gh pr merge …`, including `gh -R owner/repo pr merge` and `gh api …/merge -X PUT`. */
export function ghPrMerge(tokens: string[]): boolean {
  return ghMergePath(tokens) !== undefined
}

const DECISIONS_PATH = /docs\/DECISIONS\.md|decisions\.lock\.json/u
const COPY_VERBS = new Set(['cp', 'mv', 'install', 'ln', 'rsync'])
const ANY_ARG_WRITE_VERBS = new Set(['rm', 'tee', 'truncate', 'patch'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'php'])
const GIT_DECISIONS_WRITE_SUBCOMMANDS = new Set([
  'checkout',
  'restore',
  'reset',
  'apply',
  'rm',
  'mv',
  'stash',
  'pull',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'clean',
  // Plumbing that writes the remote without running `pre-push`, or moves a
  // local ref without a worktree write. A worker never needs either.
  'send-pack',
  'update-ref',
])

/**
 * The only git verbs that rewrite history or a ref outside the workspace.
 * Workspace-local verbs (`rebase`, `stash`, `merge`, `checkout`, `reset`,
 * `clean`, …) are ordinary work and stay allowed; they are still listed in
 * `GIT_DECISIONS_WRITE_SUBCOMMANDS` so a decision-log write is caught.
 */
const GIT_PLUMBING_WRITE_SUBCOMMANDS = new Set(['send-pack', 'update-ref'])

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select'])

/**
 * The git subcommand after its global options, for the write verbs a worker
 * may not use: `git checkout -- <main>/x`, `git restore`, `git clean -fd`
 * write files without a redirect the shell rules could see.
 */
export function gitWriteVerb(tokens: string[]): string | undefined {
  const head = stripPrefix(tokens)
  if (head.length === 0 || baseCommand(head[0]) !== 'git') return undefined
  let index = 1
  while (index < head.length) {
    const token = head[index]
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 2
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  const subcommand = head[index]
  return subcommand !== undefined && GIT_PLUMBING_WRITE_SUBCOMMANDS.has(subcommand) ? subcommand : undefined
}

interface GitInvocation {
  dir?: string
  configs: string[]
  name?: string
  args: string[]
}

/** `git [options] <subcommand> …`, with the `-c` values kept for the alias check. */
export function gitInvocation(tokens: string[]): GitInvocation | undefined {
  const head = stripPrefix(tokens)
  if (head.length === 0 || baseCommand(head[0]) !== 'git') return undefined
  let index = 1
  let dir: string | undefined
  const configs: string[] = []
  while (index < head.length) {
    const token = head[index]
    if (token === '-C') {
      dir = head[index + 1]
      index += 2
      continue
    }
    if (token === '-c' || token === '--config-env') {
      if (head[index + 1] !== undefined) configs.push(head[index + 1])
      index += 2
      continue
    }
    if (token.startsWith('--config-env=')) {
      configs.push(token.slice('--config-env='.length))
      index += 1
      continue
    }
    if (GIT_VALUE_FLAGS.has(token)) {
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
  return { dir, configs, name: head[index], args: head.slice(index + 1) }
}

const CONFIG_WRITE_FLAGS = new Set([
  '--add',
  '--replace-all',
  '--unset',
  '--unset-all',
  '--rename-section',
  '--remove-section',
  '--edit',
  '-e',
])
const CONFIG_READ_FLAGS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--list',
  '-l',
  '--show-origin',
  '--show-scope',
  '--name-only',
])

/**
 * The closed set of git config keys a worker (or the root) may pass with
 * `-c`/`--config-env`, and the root may write with `git config`. It is an
 * allowlist because "does this key run a program" is not decidable by name:
 * `diff.<driver>.command`, `diff.<driver>.textconv`, `merge.<driver>.driver`,
 * `credential.<url>.helper` and `remote.<name>.uploadpack` all run a
 * program, and git keeps adding drivers. Anything outside this set is
 * refused for both roles.
 */
const INERT_CONFIG_KEYS = new Set([
  'user.name',
  'user.email',
  'user.signingkey',
  'core.quotepath',
  'core.autocrlf',
  'core.filemode',
  'core.symlinks',
  'core.ignorecase',
  'diff.noprefix',
  'diff.mnemonicprefix',
  'diff.renames',
  'diff.context',
  'diff.algorithm',
  'diff.wserrorhighlight',
  'i18n.commitencoding',
])

function configKey(config: string): string {
  const equals = config.indexOf('=')
  return (equals >= 0 ? config.slice(0, equals) : config).toLowerCase()
}

function inertConfigKey(key: string): boolean {
  return key.startsWith('color.') || INERT_CONFIG_KEYS.has(key)
}

/**
 * `git -c`/`--config-env` and `git config` can define an alias, move
 * `core.hooksPath`, or name a program in a key such as `core.fsmonitor` — all
 * of which hide a push from the reader. The set that cannot execute a program
 * is not knowable by name, so both roles use the same closed allowlist: a
 * worker may pass `-c` for inert keys and may read config but never write it;
 * the root may also write inert keys. Everything else is a refusal.
 */
export function gitConfigViolation(tokens: string[], worker: boolean): Verdict | undefined {
  const invocation = gitInvocation(tokens)
  if (invocation === undefined) return undefined
  const raw = tokens.join(' ')
  for (const config of invocation.configs) {
    const key = configKey(config)
    if (!inertConfigKey(key)) {
      return deny(
        'git-config-write',
        `refusing "${excerpt(raw)}": ${key} is outside the inert allowlist; a config key we do not know can name a program git will execute (a diff driver, a helper, a remote command)`,
      )
    }
  }
  if (invocation.name !== 'config') return undefined
  const args = invocation.args
  const writes = args.some((token) => CONFIG_WRITE_FLAGS.has(token))
  const reads = args.some((token) => CONFIG_READ_FLAGS.has(token))
  const positional = args.filter((token) => !token.startsWith('-'))
  const key = positional[0]?.toLowerCase()
  const write = writes || (!reads && positional.length >= 2)
  if (!write) return undefined
  if (worker) {
    return deny(
      'git-config-write',
      `refusing "${excerpt(raw)}": workers read git config but do not write it; pass -c for one command with an inert key if a value is really needed`,
    )
  }
  if (key !== undefined && !inertConfigKey(key)) {
    return deny(
      'git-config-write',
      `refusing "${excerpt(raw)}": ${key} is outside the inert allowlist; the root may only set keys that cannot run a program, and that is only knowable as a closed list`,
    )
  }
  return undefined
}

const SEND_PACK_VALUE_FLAGS = new Set(['--receive-pack', '--exec', '--push-option'])

/** `git send-pack [options] <repository> [<ref>…]`: plumbing that skips pre-push. */
export function parseSendPack(tokens: string[]): { dir?: string; args: string[] } | undefined {
  const invocation = gitInvocation(tokens)
  if (invocation === undefined || invocation.name !== 'send-pack') return undefined
  return { dir: invocation.dir, args: invocation.args }
}

function sendPackPositionals(args: string[]): string[] {
  const positionals: string[] = []
  let index = 0
  while (index < args.length) {
    const token = args[index]
    if (SEND_PACK_VALUE_FLAGS.has(token)) {
      index += 2
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    positionals.push(token)
    index += 1
  }
  return positionals
}

function judgeSendPack(raw: string): Verdict {
  return deny(
    'git-push-plumbing',
    `refusing "${excerpt(raw)}": git send-pack addresses the remote directly and skips pre-push; use \`git push origin <ticket-refspec>\``,
  )
}

const GIT_KNOWN_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'archive',
  'bisect',
  'blame',
  'branch',
  'cat-file',
  'check-ignore',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'describe',
  'diff',
  'fetch',
  'for-each-ref',
  'grep',
  'init',
  'log',
  'ls-files',
  'ls-tree',
  'merge',
  'merge-base',
  'mv',
  'name-rev',
  'pull',
  'push',
  'rebase',
  'reflog',
  'remote',
  'reset',
  'restore',
  'revert',
  'rev-parse',
  'rm',
  'send-pack',
  'shortlog',
  'show',
  'show-ref',
  'stash',
  'status',
  'switch',
  'tag',
  'update-ref',
  'worktree',
])

/**
 * A worker's git command must be one the reader knows: an alias such as
 * `git p` is a push the reader never saw. `git config` is handled first, so a
 * read (`git config --get`) is still allowed.
 */
export function unknownGitSubcommand(tokens: string[]): string | undefined {
  const invocation = gitInvocation(tokens)
  if (invocation === undefined) return undefined
  if (invocation.name === undefined) return ''
  return GIT_KNOWN_SUBCOMMANDS.has(invocation.name) ? undefined : invocation.name
}

/**
 * Commands the parser models well enough to judge. An unknown command is
 * refused: a default-allow reader is exactly how `stdbuf -o0 git push …` or
 * `{ git push …; }` slips past a list of known-bad spellings. The allowlist is
 * deliberately broad enough for ordinary repository work.
 */
const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'bun', 'deno',
  'git', 'gh', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find',
  'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'tee', 'echo', 'printf', 'test',
  'true', 'false', 'pwd', 'cd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch',
  'chmod', 'chown', 'ln', 'truncate', 'patch', 'dd', 'diff', 'date', 'which',
  'printenv', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'file',
  'du', 'df', 'sleep', 'kill', 'ps', 'uname', 'id', 'whoami', 'hostname',
  'jq', 'curl', 'wget', 'tar', 'unzip', 'zip', 'gzip', 'gunzip',
  'python', 'python3', 'ruby', 'php', 'go', 'cargo', 'make', 'tsc', 'eslint',
  'prettier', 'vitest', 'jest', 'sha256sum', 'shasum', 'base64', 'xxd', 'od',
  'nl', 'comm', 'join', 'split', 'seq',
])

const SHELL_BASES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell'])
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const WRITE_PAYLOAD =
  /writeFileSync|appendFileSync|createWriteStream|writeFile\s*\(|fs\.write|open\s*\([^)]*['"][wa]|shutil\.|os\.(?:remove|rename|unlink|mkdir)|write_text\s*\(|File\.(?:write|open|delete|rename|unlink)|IO\.write|FileUtils\.|file_put_contents|fopen\s*\(|fwrite\s*\(|unlink\s*\(|rename(?:Sync)?\s*\(|copyFile(?:Sync)?\s*\(|cpSync\s*\(|link(?:Sync)?\s*\(|symlink(?:Sync)?\s*\(|truncate(?:Sync)?\s*\(/u

/**
 * A single unquoted `&` backgrounds a command; the guard models only `&&`.
 * `&>file`, `2>&1`, `1>&2` and `>&-` are redirections (a following `>` or a
 * preceding `>`), not backgrounds, and are common enough that denying them
 * would make the guard unusable.
 */
function hasSingleAmpersand(command: string): boolean {
  const text = unquotedText(command)
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '&') continue
    if (text[index + 1] === '&') {
      index += 1
      continue
    }
    if (text[index + 1] === '>') {
      index += 1
      if (text[index + 1] === '>') index += 1
      continue
    }
    if (text[index - 1] === '>') continue
    return true
  }
  return false
}

/**
 * The interpreter cargo-cult: `node -e` and `python3 -c` can write anywhere
 * without a shell redirect, so a worker's payload is refused when it carries a
 * write call. This is the documented limit of shell-level confinement; a
 * committed script can still write, and the sandbox is the boundary.
 */
function maskedCode(payload: string): string {
  // A quoted sentence that merely contains a token is data, not a call. Mask
  // the quoted spans (keeping byte positions) and require a match to start in
  // code, so a real `open(…, 'w')` still counts while `"open("` as text does not.
  return payload.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gu, (match) => ' '.repeat(match.length))
}

function payloadMatches(payload: string, pattern: RegExp): boolean {
  const masked = maskedCode(payload)
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  for (const match of payload.matchAll(new RegExp(pattern.source, flags))) {
    if (match.index === undefined) continue
    if (masked.slice(match.index, match.index + match[0].length).trim().length > 0) return true
  }
  return false
}

function interpreterWrite(tokens: string[]): boolean {
  const head = stripPrefix(tokens)
  if (head.length === 0 || !INTERPRETERS.has(baseCommand(head[0]))) return false
  const payload = head.slice(1).find((token) => !token.startsWith('-'))
  return payload !== undefined && payloadMatches(payload, WRITE_PAYLOAD)
}

/**
 * Literal spawn spellings in an interpreter payload. This closes the class the
 * reviewer reproduced; it cannot close the class itself — `globalThis['pro'+'cess']`
 * and a downloaded script remain possible, and the docs say so.
 */
const SPAWN_PAYLOAD =
  /child_process|\bexec[A-Za-z]*\s*\(|\bpopen\b|\bspawn[A-Za-z]*\s*\(|Kernel\.exec|os\.exec|os\.system|subprocess|system\(/u

function interpreterExec(tokens: string[]): boolean {
  const head = stripPrefix(tokens)
  if (head.length === 0 || !INTERPRETERS.has(baseCommand(head[0]))) return false
  const payload = head.slice(1).find((token) => !token.startsWith('-'))
  return payload !== undefined && payloadMatches(payload, SPAWN_PAYLOAD)
}

/** Constructs whose effects the segment parser cannot see. Refused, not guessed. */
function shellHazard(command: string, segments: ShellSegment[]): Verdict | undefined {
  const expansion = expansionHazard(command)
  if (expansion !== undefined) {
    return deny('shell-unmodelled', `refusing "${excerpt(command)}": ${expansion}; write the value literally or quote it with single quotes`)
  }
  const stdin = shellStdinHazard(command)
  if (stdin !== undefined) {
    return deny('shell-unmodelled', `refusing "${excerpt(command)}": ${stdin}`)
  }
  if (hasSingleAmpersand(command)) {
    return deny(
      'shell-unmodelled',
      `refusing "${excerpt(command)}": a single & backgrounds a command the guard cannot follow; use && or a separate call`,
    )
  }
  for (const segment of flatten(segments)) {
    const head = stripPrefix(segment.tokens)
    if (head.length === 0) continue
    const name = baseCommand(head[0])
    if (name === 'eval' || name === 'source' || name === '.') {
      return deny('shell-unmodelled', `refusing "${excerpt(segment.raw)}": ${name} executes text the guard cannot judge`)
    }
    if (SHELL_KEYWORDS.has(name)) {
      return deny('shell-unmodelled', `refusing "${excerpt(segment.raw)}": the shell keyword ${name} hides a command list; use a plain sequence`)
    }
    if (name === '!' || /[(){}]/u.test(head[0])) {
      return deny(
        'shell-unmodelled',
        `refusing "${excerpt(segment.raw)}": shell grouping (parentheses, braces, !) is not modelled; run the commands as plain segments`,
      )
    }
    if (!ALLOWED_COMMANDS.has(name) && !SHELL_BASES.has(name)) {
      return deny(
        'shell-unmodelled',
        `refusing "${excerpt(segment.raw)}": the guard does not model ${name === '' ? 'this command' : name}; use a plain, known command`,
      )
    }
    if (SHELL_BASES.has(name)) {
      const flag = head.findIndex((token, index) => index > 0 && (token === '-c' || /^-[A-Za-z]*c$/u.test(token)))
      if (flag > 0 && head[flag + 1] !== undefined) {
        // `bash -c '<command>'`: the body is parsed as child segments.
      } else if (shellScriptFile(head) === undefined) {
        return deny(
          'shell-unmodelled',
          `refusing "${excerpt(segment.raw)}": a shell reading stdin, a here-string or a heredoc is not modelled; pass the command with sh -c '<command>' or run a committed script`,
        )
      }
    }
    if (name === 'find' && head.some((token) => FIND_EXEC_FLAGS.has(token))) {
      return deny('shell-unmodelled', `refusing "${excerpt(segment.raw)}": find -exec runs an unmodelled command`)
    }
  }
  return undefined
}

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

/**
 * Redirect targets, scanned outside quotes only. `git commit -m "fix: a > b"`
 * is a message, not a write; `git commit -m x > out` is a redirect. The
 * earlier regex read the quoted text too and denied ordinary commits.
 */
function redirectTargets(raw: string): string[] {
  const targets: string[] = []
  let quote: string | null = null
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"') index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '&' && raw[index + 1] === '>') {
      index += 1
      if (raw[index + 1] === '>') index += 1
    } else if (char === '>') {
      if (raw[index + 1] === '|' || raw[index + 1] === '>') index += 1
    } else {
      continue
    }
    let cursor = index + 1
    while (cursor < raw.length && /\s/u.test(raw[cursor])) cursor += 1
    if (cursor >= raw.length) break
    let value = ''
    if (raw[cursor] === '"' || raw[cursor] === "'") {
      const opened = raw[cursor]
      cursor += 1
      while (cursor < raw.length && raw[cursor] !== opened) {
        if (raw[cursor] === '\\' && opened === '"' && cursor + 1 < raw.length) cursor += 1
        value += raw[cursor]
        cursor += 1
      }
    } else {
      while (cursor < raw.length && !/[\s;|&)]/u.test(raw[cursor])) {
        value += raw[cursor]
        cursor += 1
      }
    }
    if (value.length > 0 && value !== '/dev/null' && value !== '-' && !value.startsWith('&')) targets.push(value)
    index = cursor - 1
  }
  return targets
}

/** The paths a single segment writes, as written. */
function segmentWriteTargets(segment: ShellSegment): string[] {
  const targets = redirectTargets(segment.raw)
  const head = stripPrefix(segment.tokens)
  const command = baseCommand(head[0])
  const args = head.slice(1)
  if (command === 'tar' && args.some((token) => token === '--extract' || token === '--get' || /^-[A-Za-z]*x/u.test(token))) {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '-C' || args[index] === '--directory') {
        const value = args[index + 1]
        if (value !== undefined) targets.push(value)
      } else if (args[index].startsWith('--directory=')) {
        targets.push(args[index].slice('--directory='.length))
      } else if (args[index].startsWith('-C') && args[index].length > 2) {
        // GNU tar accepts the directory attached: `-C.git`, `-C/tmp/out`.
        targets.push(args[index].slice(2))
      }
    }
  }
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
  if (command === 'tee') {
    // `tee out.md < /tmp/in` reads `/tmp/in`; only the operands are written.
    const operands: string[] = []
    for (let index = 1; index < head.length; index += 1) {
      const token = head[index]
      if (token === '<' || token === '<<' || token === '<<<') {
        index += 1
        continue
      }
      if (token.startsWith('<')) continue
      if (token.startsWith('>') || token === '&>' || token === '&>>') {
        index += 1
        continue
      }
      if (token.startsWith('-')) continue
      operands.push(token)
    }
    targets.push(...operands)
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
  } else if (command === 'git' && GIT_DECISIONS_WRITE_SUBCOMMANDS.has(head[1] ?? '')) {
    written.push(...args)
  } else if (command === 'sed' || command === 'perl') {
    if (args.some((token) => /^-[A-Za-z]*i/u.test(token) || token === '--in-place')) {
      written.push(...args.filter((token) => !token.startsWith('-')))
    }
  } else if (
    INTERPRETERS.has(command) &&
    args.some((token) => token === '-e' || token === '-c' || token === '-r' || token.startsWith('--eval'))
  ) {
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

/**
 * True when the command that actually runs is `sudo`, after launchers such as
 * `env`, `command`, `exec`, `nice`, `timeout` and `xargs`. Matching the first
 * four tokens instead would refuse `git commit -m sudo` and `grep sudo
 * README.md`, which are ordinary work.
 */
function sudoAtCommandPosition(tokens: string[]): boolean {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1
      continue
    }
    if (token === 'env' || token === 'command') {
      index += 1
      while (index < tokens.length) {
        const argument = tokens[index]
        if (argument === '-u' || argument === '--unset') {
          index += 2
          continue
        }
        if (argument.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
          index += 1
          continue
        }
        break
      }
      continue
    }
    if (token === 'exec') {
      index += 1
      if (tokens[index] === '-a') index += 2
      continue
    }
    if (token === 'nice') {
      index += 1
      while (index < tokens.length && tokens[index].startsWith('-')) {
        index += tokens[index] === '-n' || tokens[index] === '--adjustment' ? 2 : 1
      }
      continue
    }
    if (token === 'timeout') {
      index += 1
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const flag = tokens[index]
        index += flag === '-s' || flag === '--signal' || flag === '-k' || flag === '--kill-after' ? 2 : 1
      }
      index += 1 // the duration
      continue
    }
    if (token === 'xargs') {
      index += 1
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const flag = tokens[index]
        const takesValue = ['-I', '--replace', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '-L', '--max-lines', '-d', '--delimiter', '-E', '-a', '--arg-file']
        index += takesValue.includes(flag) && !flag.includes('=') ? 2 : 1
      }
      continue
    }
    return token === 'sudo'
  }
  return false
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

  const hazard = shellHazard(command, segments)
  if (hazard !== undefined) return hazard

  if (agent.worker) {
    for (const segment of flat) {
      if (sudoAtCommandPosition(segment.tokens)) {
        return deny(
          'sudo-refused',
          `refusing "${excerpt(segment.raw)}": a worker has no use for sudo; run the command with the directory permissions you were given`,
        )
      }
    }
  }

  for (const segment of flat) {
    const violation = decisionsViolation(segment)
    if (violation !== undefined) return violation
  }

  if (agent.worker) {
    for (const segment of flat) {
      const assignments = leadingAssignments(segment.tokens)
      const head = stripPrefix(segment.tokens)
      if (assignments.length > 0 && baseCommand(head[0]) === 'git') {
        return deny(
          'git-env-prefix',
          `refusing "${excerpt(segment.raw)}": a leading ${assignments[0].split('=')[0]} can redirect git config, ssh, exec-path or pager; run git with no environment prefix`,
        )
      }
    }
  }

  for (const segment of flat) {
    const violation = gitConfigViolation(segment.tokens, agent.worker)
    if (violation !== undefined) return violation
  }

  for (const segment of flat) {
    const sendPack = parseSendPack(segment.tokens)
    if (sendPack === undefined) continue
    const sendCwd = sendPack.dir === undefined ? cwd : (resolveTarget(sendPack.dir, cwd) ?? cwd)
    const violation = judgeSendPack(segment.raw)
    if (violation !== undefined) return violation
  }

  for (const segment of flat) {
    const push = parseGitPush(segment.tokens)
    if (push === undefined) continue
    const pushCwd = push.dir === undefined ? cwd : (resolveTarget(push.dir, cwd) ?? cwd)
    const violation = judgePush(push, context.branch(pushCwd), segment.raw)
    if (violation !== undefined) return violation
  }

  // Workers are refused outright below; this is the check for the root, the
  // only role that can reach a merge. It runs before the role shortcut so the
  // merge path never falls through to an unconditional allow.
  for (const segment of flat) {
    const merge = ghMergePath(segment.tokens)
    if (merge === undefined || agent.worker) continue
    const problem =
      merge === 'api'
        ? `a raw \`gh api\` merge cannot carry ${MERGE_PIN_FLAG}`
        : mergePinProblem(segment.tokens)
    if (problem !== undefined) return deny('gh-pr-merge-pin', mergePinReason(segment.raw, problem))
  }

  if (!agent.worker) return ALLOW

  for (const segment of flat) {
    const unknown = unknownGitSubcommand(segment.tokens)
    if (unknown !== undefined) {
      return deny(
        'git-unknown-subcommand',
        `refusing "${excerpt(segment.raw)}": git ${unknown === '' ? '(no subcommand)' : unknown} is not a subcommand the guard models; an alias can hide a push behind a short name, so run the underlying command`,
      )
    }
  }

  for (const segment of flat) {
    const script = shellScriptFile(segment.tokens)
    if (script !== undefined) {
      return deny(
        'shell-script-unverified',
        `refusing "${excerpt(segment.raw)}": the guard does not read script contents, so a writable ${script} could be rewritten to push main; run the commands directly`,
      )
    }
    if (interpreterExec(segment.tokens)) {
      return deny(
        'interpreter-exec',
        `refusing "${excerpt(segment.raw)}": an interpreter payload that literally spawns a process can push from inside it; put the logic in a committed command`,
      )
    }
    if (interpreterWrite(segment.tokens)) {
      return deny(
        'interpreter-write',
        `refusing "${excerpt(segment.raw)}": an interpreter one-liner can write outside its worktree; put the code in a committed file and run it with a plain command`,
      )
    }
    if (ghPrMerge(segment.tokens)) {
      return deny(
        'gh-pr-merge-worker',
        `refusing "${excerpt(segment.raw)}": a worker may open a PR but never merge one; the master merges after review`,
      )
    }
  }

  for (const segment of flat) {
    const verb = gitWriteVerb(segment.tokens)
    if (verb !== undefined) {
      return deny(
        'git-write-verb',
        `refusing "${excerpt(segment.raw)}": a worker does not rewrite the tree or history with git ${verb}; edit the file inside the worktree instead`,
      )
    }
  }

  for (const write of collectShellWrites(segments, cwd)) {
    const target = resolveTarget(write.raw, write.cwd)
    if (target === undefined) {
      return deny(
        'write-outside-worktree',
        `refusing to write ${write.raw}: the running directory is unknown, so the path cannot be confined; use an absolute path under your worktree`,
      )
    }
    if (insideGitDirectory(target)) {
      return deny(
        'git-dir-write',
        `refusing to write ${target}: a worker does not write inside .git; a config or hook planted there runs as the next git command`,
      )
    }
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
