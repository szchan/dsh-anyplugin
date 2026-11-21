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
 * reason. It is a convention checker for honest mistakes, not a containment
 * boundary: the real boundary is branch protection, DSH's own sandbox and CI.
 * A command can hide its intent from any reader, so this reader refuses
 * constructs it does not model (`shell-unmodelled`) instead of judging a
 * partial parse. The `pre-push` hook installed with the composition is the
 * authoritative push check, because git resolves the refspec itself.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isMainRef } from './git.ts'
import { baseCommand, parseSegments, stripPrefix, unquotedText, type ShellSegment } from './shell.ts'

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
    // A bare push does not mean "the current branch": `remote.<r>.push` and
    // `push.default=upstream` can redirect it to main. The guard refuses the
    // ambiguous form instead of guessing.
    return deny(
      'git-push-bare',
      `refusing "${excerpt(raw)}": a bare git push can write main through remote.<name>.push or push.default; name the destination explicitly (e.g. \`git push origin HEAD:refs/heads/ticket/80\`)`,
    )
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
const GIT_WRITE_SUBCOMMANDS = new Set([
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
])

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
  return subcommand !== undefined && GIT_WRITE_SUBCOMMANDS.has(subcommand) ? subcommand : undefined
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
  /writeFileSync|appendFileSync|createWriteStream|writeFile\s*\(|fs\.write|open\s*\([^)]*['"][wa]|shutil\.|os\.(?:remove|rename|unlink|mkdir)|write_text\s*\(/u

/** A single unquoted `&` backgrounds a command; the guard models only `&&`. */
function hasSingleAmpersand(command: string): boolean {
  const text = unquotedText(command).replace(/&&/gu, ' ').replace(/&>>?/gu, ' ')
  return text.includes('&')
}

/**
 * The interpreter cargo-cult: `node -e` and `python3 -c` can write anywhere
 * without a shell redirect, so a worker's payload is refused when it carries a
 * write call. This is the documented limit of shell-level confinement; a
 * committed script can still write, and the sandbox is the boundary.
 */
function interpreterWrite(tokens: string[]): boolean {
  const head = stripPrefix(tokens)
  if (head.length === 0 || !INTERPRETERS.has(baseCommand(head[0]))) return false
  const payload = head.slice(1).find((token) => !token.startsWith('-'))
  return payload !== undefined && WRITE_PAYLOAD.test(payload)
}

/** Constructs whose effects the segment parser cannot see. Refused, not guessed. */
function shellHazard(command: string, segments: ShellSegment[]): Verdict | undefined {
  if (/\$\(|`/u.test(command)) {
    return deny(
      'shell-unmodelled',
      `refusing "${excerpt(command)}": command substitution hides what will run; write the command out literally`,
    )
  }
  if (/\$'/u.test(command)) {
    return deny(
      'shell-unmodelled',
      `refusing "${excerpt(command)}": ANSI-C quoting ($'…') can change the words the shell sees; quote the value plainly`,
    )
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
      if (flag < 0 || head[flag + 1] === undefined) {
        return deny(
          'shell-unmodelled',
          `refusing "${excerpt(segment.raw)}": a shell reading stdin/heredoc is not modelled; pass the command with sh -c '<command>'`,
        )
      }
    }
    if (name === 'find' && head.some((token) => FIND_EXEC_FLAGS.has(token))) {
      return deny('shell-unmodelled', `refusing "${excerpt(segment.raw)}": find -exec runs an unmodelled command`)
    }
    if (head.some((token) => token.includes('$'))) {
      return deny('shell-unmodelled', `refusing "${excerpt(segment.raw)}": shell expansion is not modelled; write the literal value`)
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
    if (value.length > 0 && value !== '/dev/null' && !value.startsWith('&')) targets.push(value)
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

  const hazard = shellHazard(command, segments)
  if (hazard !== undefined) return hazard

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
