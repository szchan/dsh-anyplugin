/**
 * The installable composition: what `npm run guard:install` writes into the
 * profile's `cordis.patch.yml`, and what `guard:status` compares against.
 *
 * Two decisions make this reviewable:
 *
 * - The entry is an `insert` list. A patch that only names an `id` *overrides*
 *   an existing entry; `insert` is the only way DSH's loader adds a root
 *   entry. Getting that wrong would produce a patch that silently does
 *   nothing.
 * - The block is delimited by markers and rendered by one writer, so status
 *   can compare the installed text with a freshly composed one and call it
 *   stale when the repo moved (a new worktree, a new ratchet total). There is
 *   no second writer and no runtime write to the profile: this script is the
 *   writer, the loader is the reader.
 *
 * The block is YAML in the JSON subset DSH's profile patch parser accepts.
 * Every scalar is JSON-quoted, so a path with a space or a `#` cannot change
 * the shape, and `guard:status` can read the exact text it wrote.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DEFAULT_SHELL_TOOLS,
  DEFAULT_WRITE_TOOLS,
  isWorktreeGlob,
  judgeCall,
  matchWorktree,
  resolvePolicy,
  type GuardConfig,
  type JudgeContext,
  type ResolvedPolicy,
  type Verdict,
} from './policy.ts'

export const PLUGIN_ID = 'anyplugin-guard'
export const PATCH_FILE = 'cordis.patch.yml'
export const BLOCK_START = '# >>> dsh-anyplugin guard'
export const BLOCK_END = '# <<< dsh-anyplugin guard'

/** A full sha for the dry-run table; not a repository commit. */
const REVIEWED_HEAD = '0123456789abcdef0123456789abcdef01234567'

export interface Ratchet {
  /** `32 declared / 31 matched / 0 missing / 1 refused`, verbatim from docs/FEATURES.md. */
  totals: string
  /** `13 fixtures`: the fixture directories `EXPECTED_ROWS` owns, derived from the test. */
  fixtures?: string
  /** Rows the coverage test declares as missing or refused. */
  open: string[]
}

export interface Worktree {
  path: string
  branch?: string
  /** True for the checkout that owns `.git`; the one root a worker may not write in. */
  main?: boolean
}

export interface Composition {
  pluginId: string
  source: string
  config: GuardConfig
  ratchet: Ratchet
  /** All worktrees `git worktree list` reported, main checkout first. */
  worktrees: Worktree[]
  block: string
}

/** The profile directory `dsh` would use, with the same environment precedence. */
export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_PROFILE_DIR !== undefined && env.DSH_PROFILE_DIR.length > 0) return resolve(env.DSH_PROFILE_DIR)
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'profiles', env.DSH_PROFILE ?? 'desktop')
}

/** Read the ratchet the brief quotes, from the documents that own it. */
export function readRatchet(repoRoot: string): Ratchet {
  const features = readFileSync(join(repoRoot, 'docs', 'FEATURES.md'), 'utf8')
  // The sentence is hard-wrapped in the document; read it as text, not lines.
  const totals = features.match(
    /\*\*(\d+\s+declared\s*\/\s*\d+\s+matched\s*\/\s*\d+\s+missing\s*\/\s*\d+\s+refused)\*\*/u,
  )
  if (totals === null) throw new Error('docs/FEATURES.md has no "N declared / N matched / N missing / N refused" snapshot')
  const coverage = readFileSync(join(repoRoot, 'packages', 'dsh-anyplugin-conformance', 'test', 'coverage.test.mjs'), 'utf8')
  // The fixture count the brief quotes is the one the ratchet owns: the keys
  // of `EXPECTED_ROWS` are the fixture directories the coverage test iterates.
  const rowBlock = coverage.match(/const EXPECTED_ROWS = \{([\s\S]*?)\n\}/u)
  const ownedFixtures = rowBlock === null ? [] : [...rowBlock[1].matchAll(/^\s*'([^']+)':/gmu)].map((match) => match[1])
  const open = [...coverage.matchAll(/'([^'\n]+:(?:missing|refused))'/gu)].map((match) => match[1])
  return {
    totals: totals[1].replace(/\s+/gu, ' '),
    ...(ownedFixtures.length === 0 ? {} : { fixtures: `${ownedFixtures.length} fixtures` }),
    open,
  }
}

function gitValue(start: string, args: string[]): string | undefined {
  try {
    const output = execFileSync('git', ['-C', start, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return output.length === 0 ? undefined : output
  } catch {
    return undefined
  }
}

/**
 * The checkout that owns the repository's `.git`, from any worktree of it.
 *
 * The derivation is the mod host's (`vcs.detect`, bridge.ts): when the git dir
 * and the common dir are the same path, the checkout owns itself — that covers
 * the ordinary main checkout, a submodule (its git dir is the superproject's
 * `.git/modules/<name>`) and `git init --separate-git-dir` (both point at the
 * external dir). Only when they differ is the checkout a linked worktree: its
 * common dir is `<main>/.git`, whose parent survives deleting any single
 * worktree. Anything else is not a layout we can name safely, and the caller
 * falls back to the invocation root.
 *
 * Uses `--path-format=absolute`, which needs git ≥ 2.31 (the guard hook and
 * audit scripts made the same requirement first).
 */
export function mainCheckout(start: string): string | undefined {
  const gitDir = gitValue(start, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const commonDir = gitValue(start, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (gitDir === undefined || commonDir === undefined) return undefined
  if (gitDir === commonDir) return gitValue(start, ['rev-parse', '--show-toplevel'])
  if (basename(commonDir) === '.git') return dirname(commonDir)
  return undefined
}

/** `git worktree list --porcelain`, with the checkout that owns `.git` marked. */
export function readGitWorktrees(repoRoot: string): Worktree[] {
  const output = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  const worktrees: Worktree[] = []
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) worktrees.push({ path: resolve(line.slice('worktree '.length).trim()) })
    else if (line.startsWith('branch ') && worktrees.length > 0) {
      worktrees[worktrees.length - 1].branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//u, '')
    }
  }
  // Porcelain order is lexical, not "main first"; the owning checkout is the
  // only reliable answer. It is not always `dirname(commonDir)`: a submodule
  // and a `--separate-git-dir` checkout point both dirs at themselves, so the
  // shared derivation in `mainCheckout` is what marks the main entry.
  const owner = mainCheckout(repoRoot)
  if (owner !== undefined) {
    // Git reports the git directory itself as the main "worktree" in a
    // submodule and in a `--separate-git-dir` checkout. The working tree is
    // the owner, and that is the path a worker can be confined to.
    const gitDir = gitValue(repoRoot, ['rev-parse', '--path-format=absolute', '--git-dir'])
    const commonDir = gitValue(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    for (const entry of worktrees) {
      if (entry.path === gitDir || entry.path === commonDir) entry.path = owner
    }
  }
  for (const entry of worktrees) entry.main = owner !== undefined && entry.path === owner
  return worktrees
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function emitList(lines: string[], indent: number, key: string, values: string[]): void {
  const pad = ' '.repeat(indent)
  if (values.length === 0) {
    lines.push(`${pad}${key}: []`)
    return
  }
  lines.push(`${pad}${key}:`)
  for (const value of values) lines.push(`${pad}  - ${quote(value)}`)
}

/**
 * The `worktrees` entries a managed block lists, exactly as written.
 *
 * `guard:status` reads them back to answer a question a diff cannot: a literal
 * path that is gone no longer appears in the freshly discovered list, so the
 * composed block would look current while the policy still trusts it. The
 * pattern entries are returned too; they are never stale.
 */
export function readWorktrees(block: string): string[] {
  const lines = block.split('\n')
  const start = lines.findIndex((line) => line.trim().startsWith('worktrees:'))
  if (start < 0) return []
  const inline = lines[start].trim().slice('worktrees:'.length).trim()
  if (inline.length > 0) return []
  const values: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('          - ')) break
    try {
      const value: unknown = JSON.parse(line.trim().slice(2))
      if (typeof value !== 'string') break
      values.push(value)
    } catch {
      break
    }
  }
  return values
}

/**
 * Refuse a worktree path that contains `*`.
 *
 * The block's grammar reads a trailing `*` as the one-directory wildcard. A
 * literal `*` in a checkout path would therefore be written as a pattern whose
 * parent also contains `*`, and `matchWorktree` would confine a sibling such as
 * `.../starX/wt/ticket-1` — one the plan never named. Plain quoting cannot tell
 * the two apart on the way back in, so the install fails closed with the path
 * in the message instead of writing an ambiguous entry.
 */
function assertRepresentableWorktrees(paths: string[]): void {
  for (const path of paths) {
    if (!path.includes('*')) continue
    throw new Error(
      `guard: the worktree path ${path} contains "*", and the managed block reserves "*" for one trailing directory-name wildcard; ` +
        'a literal "*" would be read back as a pattern and confine a sibling the plan never named. Rename the checkout path to remove "*".',
    )
  }
}

/**
 * The `*` pattern that covers a set of ticket worktrees, or undefined.
 *
 * The install used to write the list it discovered: a worktree created after
 * the install was refused until someone reinstalled, and a removed path stayed
 * trusted. A pattern derived from the discovered names — one parent, a shared
 * name stem cut at the last `-` — admits the next worktree without a reinstall
 * while staying narrower than the parent: `/tmp/anyplugin-wt/ticket-*`, not
 * `/tmp/anyplugin-wt/*`. A list with no shared stem keeps the exact entries.
 */
export function deriveWorktreeGlob(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined
  assertRepresentableWorktrees(paths)
  const resolved = paths.map((path) => resolve(path))
  const parent = dirname(resolved[0])
  if (!resolved.every((path) => dirname(path) === parent)) return undefined
  let prefix = basename(resolved[0])
  for (const path of resolved.slice(1)) {
    const name = basename(path)
    while (prefix.length > 0 && !name.startsWith(prefix)) prefix = prefix.slice(0, -1)
    if (prefix.length === 0) return undefined
  }
  const stem = prefix.slice(0, prefix.lastIndexOf('-') + 1)
  if (stem.length === 0) return undefined
  const glob = `${parent}/${stem}*`
  // The pattern replaces the list, so it must still match every entry it replaces.
  return resolved.every((path) => matchWorktree(glob, path) === path) ? glob : undefined
}

/**
 * What the patch file looked like before the block was written. Recorded inside
 * the managed block so `--uninstall` can restore an absent file as absent and
 * an empty file as empty instead of leaving the empty-array marker behind.
 */
export interface InstallState {
  file: 'absent' | 'empty' | 'array' | 'content'
  /** Exact number of trailing newlines the pre-install file had. */
  trailing: number
}

function trailingNewlines(text: string): number {
  const match = text.match(/\n*$/u)
  return match === null ? 0 : match[0].length
}

export function captureState(existing: string | undefined): InstallState {
  if (existing === undefined) return { file: 'absent', trailing: 0 }
  const trailing = trailingNewlines(existing)
  if (existing.trim() === '') return { file: 'empty', trailing }
  if (existing.trim() === '[]') return { file: 'array', trailing }
  return { file: 'content', trailing }
}

const STATE_LINE = '# dsh-anyplugin guard state:'

export function readState(block: string): InstallState | undefined {
  const line = block.split('\n').find((entry) => entry.startsWith(STATE_LINE))
  if (line === undefined) return undefined
  const match = line.match(/file=(absent|empty|array|content); (?:trailing=(\d+)|newline=(yes|no))/u)
  if (match === null) return undefined
  return {
    file: match[1] as InstallState['file'],
    trailing: match[2] === undefined ? (match[3] === 'yes' ? 1 : 0) : Number(match[2]),
  }
}

/** Render the one entry this guard installs. Deterministic: status compares strings. */
export function renderBlock(source: string, config: GuardConfig, state?: InstallState): string {
  const lines: string[] = [
    `${BLOCK_START} — managed by \`npm run guard:install\`; \`npm run guard:status\` reads this block and nothing else.`,
    ...(state === undefined
      ? []
      : [`${STATE_LINE} file=${state.file}; trailing=${state.trailing}`]),
    '- insert:',
    `    - id: ${quote(PLUGIN_ID)}`,
    `      name: ${quote(source)}`,
    '      config:',
  ]
  emitList(lines, 8, 'shellTools', config.shellTools ?? DEFAULT_SHELL_TOOLS)
  emitList(lines, 8, 'writeTools', config.writeTools ?? DEFAULT_WRITE_TOOLS)
  emitList(lines, 8, 'worktrees', config.worktrees ?? [])
  emitList(lines, 8, 'protectedRoots', config.protectedRoots ?? [])
  emitList(lines, 8, 'gitDirectories', config.gitDirectories ?? [])
  const brief = config.brief === undefined || config.brief === false ? undefined : config.brief
  if (brief === undefined) {
    lines.push('        brief: false')
  } else {
    lines.push('        brief:')
    emitList(lines, 10, 'ratchet', brief.ratchet)
    if (brief.fixtures !== undefined) lines.push(`          fixtures: ${quote(brief.fixtures)}`)
    emitList(lines, 10, 'open', brief.open)
  }
  lines.push(BLOCK_END)
  return `${lines.join('\n')}\n`
}

const GUARD_ID_ROW = /^\s*-\s+id:\s*(?:"anyplugin-guard"|'anyplugin-guard'|anyplugin-guard)\s*(?:#.*)?$/mu

/** True when the file has an `anyplugin-guard` entry outside the managed block. */
export function duplicateGuardId(text: string): boolean {
  return GUARD_ID_ROW.test(text)
}

/** Extract the managed block, if present. */
export function readBlock(text: string): { present: boolean; block: string } {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith(BLOCK_START))
  const end = lines.findIndex((line) => line.startsWith(BLOCK_END))
  if (start < 0) {
    if (end >= 0) throw new Error('guard: the managed block has an end marker without a start marker; fix cordis.patch.yml first')
    return { present: false, block: '' }
  }
  const close = lines.findIndex((line, index) => index > start && line.startsWith(BLOCK_END))
  if (close < 0) {
    throw new Error('guard: the managed block has a start marker without an end marker; fix cordis.patch.yml first')
  }
  return { present: true, block: `${lines.slice(start, close + 1).join('\n')}\n` }
}

/**
 * Replace (or append, or remove) the managed block. Idempotent, and it refuses
 * to leave a second `anyplugin-guard` entry in the file: two entries with one
 * id would be a patch that only looks installed.
 */
export function applyBlock(existing: string, block: string | null): string {
  const lines = existing.split('\n')
  const start = lines.findIndex((line) => line.startsWith(BLOCK_START))
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.startsWith(BLOCK_END))
  if (start < 0 && end >= 0) throw new Error('guard: the managed block has an end marker without a start marker; fix cordis.patch.yml first')
  if (start >= 0 && end < 0) throw new Error('guard: the managed block has a start marker without an end marker; fix cordis.patch.yml first')
  const before = start >= 0 ? lines.slice(0, start) : lines.slice()
  const after = start >= 0 ? lines.slice(end + 1) : []
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
  while (after.length > 0 && after[0].trim() === '') after.shift()
  const outside = `${before.join('\n')}\n${after.join('\n')}`
  if (duplicateGuardId(outside)) {
    throw new Error(`guard: ${quote(PLUGIN_ID)} already appears outside the managed block; remove that entry first`)
  }
  if (start >= 0) {
    // The block is ours. A top-level row inside it that we did not write is a
    // user edit; replacing the block would delete it without saying so.
    const managed = lines.slice(start, end + 1).filter((line) => /^-\s/u.test(line))
    if (managed.length > 1 || (managed.length === 1 && managed[0].trim() !== '- insert:')) {
      throw new Error('guard: the managed block contains rows this tool did not write; move them out of the block first')
    }
  }
  const blockLines = block === null ? [] : block.replace(/\n+$/u, '').split('\n')
  // A fresh profile may hold the empty-array marker. Two root collections in
  // one YAML document is invalid, so the marker yields to the first entry.
  const keepLine = (line: string): boolean => block === null || line.trim() !== '[]'
  const keptBefore = before.filter(keepLine)
  const keptAfter = after.filter(keepLine)
  const parts = [...keptBefore, ...blockLines]
  if (keptBefore.length > 0 && keptAfter.length > 0 && blockLines.length > 0) parts.push('')
  parts.push(...keptAfter)
  const next = parts.join('\n').replace(/\n{3,}$/u, '').replace(/^\n+/u, '')
  if (next.length === 0) return ''
  return `${next.replace(/\n+$/u, '')}\n`
}

/**
 * What `--uninstall` should leave behind. The managed block records the
 * pre-install state, so absent stays absent, empty stays empty, `[]` stays
 * `[]`, and a file without a trailing newline does not silently gain one.
 */
export function uninstallText(existing: string): { action: 'delete' | 'write'; content: string } {
  const installed = readBlock(existing)
  if (!installed.present) throw new Error('guard: not installed (no managed block); nothing to remove')
  const state = readState(installed.block)
  let next = applyBlock(existing, null)
  if (state === undefined) {
    // An older block did not record its state; the canonical empty patch is
    // `[]`, which the loader accepts and an empty file does not.
    return next.trim() === '' ? { action: 'write', content: '[]\n' } : { action: 'write', content: next }
  }
  if (state.file === 'absent') return { action: 'delete', content: '' }
  const endings = '\n'.repeat(state.trailing)
  if (state.file === 'empty') return { action: 'write', content: endings }
  if (state.file === 'array') return { action: 'write', content: `[]${endings}` }
  next = next.replace(/\n+$/u, '')
  return { action: 'write', content: `${next}${endings}` }
}

/** Compose the current installable entry from the tree. */
export function composeGuard(options: {
  repoRoot: string
  worktrees: Worktree[]
  /** Put this worktree first, so the printed table and the brief are deterministic. */
  preferredWorktree?: string
  /** Reuse the pattern a managed block already lists instead of deriving one. */
  worktreeGlob?: string
}): Composition {
  const repoRoot = resolve(options.repoRoot)
  const source = join(repoRoot, 'packages', 'dsh-anyplugin-guard', 'src', 'index.ts')
  const ratchet = readRatchet(repoRoot)
  const worktrees = options.worktrees.map((entry) => ({ ...entry, path: resolve(entry.path) }))
  const main = worktrees.find((entry) => entry.main === true) ?? worktrees[0]
  // Only ticket branches are worktrees this guard hands out. Review and
  // verify worktrees belong to other agents; a guard that allowed writes there
  // would be worse than no guard.
  const preferred = options.preferredWorktree === undefined ? undefined : resolve(options.preferredWorktree)
  const ticketWorktrees = worktrees
    .filter((entry) => entry.main !== true && entry.branch?.startsWith('ticket/') === true)
    .sort((left, right) => (left.path === preferred ? -1 : right.path === preferred ? 1 : 0))
  const ticketPaths = ticketWorktrees.map((entry) => entry.path)
  // Also checked here, not only in the derivation: status composes with the
  // pattern already in the block, so a live worktree with a literal `*` must
  // fail before it can be appended as an exact entry.
  assertRepresentableWorktrees(ticketPaths)
  const glob = options.worktreeGlob === undefined ? deriveWorktreeGlob(ticketPaths) : resolve(options.worktreeGlob)
  const configured =
    glob === undefined ? ticketPaths : [glob, ...ticketPaths.filter((path) => matchWorktree(glob, path) !== path)]
  // The git dir is not always named `.git` (a submodule keeps it under the
  // superproject, `--separate-git-dir` puts it anywhere), and the derived
  // pattern can match it — `sep-*` matches `sep-gitdir` next to `sep-work`.
  // Protect it as a root, and hand the policy the resolved path so the
  // git-dir rule recognises it by identity rather than by name. The common
  // dir contains every linked worktree's `<common>/worktrees/<name>` dir, so
  // new worktrees stay covered without re-listing them.
  const commonDir = gitValue(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const gitDirectories = commonDir === undefined ? [] : [resolve(commonDir)]
  const protectedRoots =
    main === undefined
      ? []
      : [main.path, ...(commonDir !== undefined && resolve(commonDir) !== main.path ? [resolve(commonDir)] : [])]
  const config: GuardConfig = {
    shellTools: [...DEFAULT_SHELL_TOOLS],
    writeTools: [...DEFAULT_WRITE_TOOLS],
    worktrees: configured,
    protectedRoots,
    gitDirectories,
    brief: {
      ratchet: [ratchet.totals],
      ...(ratchet.fixtures === undefined ? {} : { fixtures: ratchet.fixtures }),
      open: ratchet.open,
    },
  }
  return { pluginId: PLUGIN_ID, source, config, ratchet, worktrees, block: renderBlock(source, config) }
}

export interface TableCase {
  tool: string
  payload: string
  role: 'root' | 'worker'
  expect: 'allow' | 'deny'
  rule: string
  /** Branch read for a bare `git push`. */
  branch?: string
  /** The checkout is detached, so a bare push has no branch to name. */
  unknownBranch?: boolean
  note: string
}

/** The payload → verdict table, built from the same paths the install writes. */
export function guardTable(options: { worktree: string; protectedRoot: string }): TableCase[] {
  const { worktree, protectedRoot } = options
  return [
    { tool: 'bash', payload: 'git push origin main', role: 'worker', expect: 'deny', rule: 'git-push-main', note: 'refspec names main' },
    { tool: 'bash', payload: 'git push -u origin ticket/80', role: 'worker', expect: 'allow', rule: 'allow', note: 'ticket branch' },
    { tool: 'bash', payload: 'git push origin HEAD:main', role: 'worker', expect: 'deny', rule: 'git-push-main', note: 'destination ref is main' },
    { tool: 'bash', payload: 'git push --all origin', role: 'worker', expect: 'deny', rule: 'git-push-main', note: '--all pushes main too' },
    { tool: 'bash', payload: 'git push origin --delete main', role: 'worker', expect: 'deny', rule: 'git-push-shape', note: 'a delete flag is not the one refspec shape' },
    { tool: 'bash', payload: 'git push', role: 'worker', expect: 'deny', rule: 'git-push-bare', branch: 'main', note: 'bare push on main' },
    { tool: 'bash', payload: 'git push', role: 'worker', expect: 'deny', rule: 'git-push-bare', branch: 'ticket/80', note: 'bare push is refused even on the ticket branch: remote.origin.push/push.default can retarget it' },
    { tool: 'bash', payload: 'git push', role: 'worker', expect: 'deny', rule: 'git-push-bare', unknownBranch: true, note: 'bare push, branch unknown' },
    { tool: 'bash', payload: 'git push origin HEAD:refs/heads/ticket/80', role: 'worker', expect: 'allow', rule: 'allow', note: 'explicit destination refspec' },
    { tool: 'bash', payload: "bash -c 'git push origin main'", role: 'worker', expect: 'deny', rule: 'git-push-main', note: 'nested bash -c' },
    { tool: 'bash', payload: 'env -i git push origin main', role: 'worker', expect: 'deny', rule: 'git-push-main', note: 'launcher stripped' },
    { tool: 'bash', payload: 'echo "git push origin main"', role: 'worker', expect: 'allow', rule: 'allow', note: 'quoted text is not a command' },
    { tool: 'bash', payload: 'git push origin main&', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'background & hides the failure' },
    { tool: 'bash', payload: '{ git push origin main; }', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'brace group' },
    { tool: 'bash', payload: '! git push origin main', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'negated pipeline' },
    { tool: 'bash', payload: '( git push origin main )', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'subshell' },
    { tool: 'bash', payload: `git push origin $'main'`, role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'ANSI-C quoting' },
    { tool: 'bash', payload: 'find . -exec git push origin main +', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'find -exec' },
    { tool: 'bash', payload: `sh -s <<'EOF'\ngit push origin main\nEOF`, role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'shell reading stdin' },
    { tool: 'bash', payload: 'echo "git push origin main" | sh', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'shell stage' },
    { tool: 'bash', payload: 'stdbuf -o0 git push origin main', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'unknown launcher' },
    { tool: 'bash', payload: '. /tmp/evil.sh', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'dot source' },
    { tool: 'bash', payload: 'gh pr merge 82 --squash', role: 'worker', expect: 'deny', rule: 'gh-pr-merge-worker', note: 'worker merge, pinned or not' },
    { tool: 'bash', payload: `gh pr merge 82 --squash --match-head-commit ${REVIEWED_HEAD}`, role: 'worker', expect: 'deny', rule: 'gh-pr-merge-worker', note: 'a pin does not let a worker merge' },
    { tool: 'bash', payload: 'gh pr merge 82 --squash', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'master merge omits the pin' },
    { tool: 'bash', payload: 'gh pr merge 82 --auto', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: '--auto still needs the pin' },
    { tool: 'bash', payload: 'gh pr merge 82 --match-head-commit 0123456', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'a short sha is not a pin' },
    { tool: 'bash', payload: `gh pr merge 82 --body --match-head-commit=${REVIEWED_HEAD}`, role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'body text is not the pin' },
    { tool: 'bash', payload: 'gh pr merge 82 --help', role: 'root', expect: 'allow', rule: 'allow', note: 'help does not merge' },
    { tool: 'bash', payload: 'gh pr merge 82 --disable-auto', role: 'root', expect: 'allow', rule: 'allow', note: 'disabling auto-merge performs no merge' },
    { tool: 'bash', payload: 'gh pr merge 82 --disable-auto=false', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'false does not disable; it merges' },
    { tool: 'bash', payload: 'gh pr list --search pr merge', role: 'root', expect: 'allow', rule: 'allow', note: 'only the command position counts' },
    { tool: 'bash', payload: 'gh pr -R szchan/dsh-anyplugin merge 82', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'the repo flag does not hide the merge' },
    { tool: 'bash', payload: `gh pr merge 82 --squash --match-head-commit ${REVIEWED_HEAD}`, role: 'root', expect: 'allow', rule: 'allow', note: 'master merge with the reviewed head' },
    { tool: 'bash', payload: `gh pr merge 82 --auto --match-head-commit ${REVIEWED_HEAD}`, role: 'root', expect: 'allow', rule: 'allow', note: 'auto-merge with the reviewed head' },
    { tool: 'bash', payload: 'gh api -X PUT repos/szchan/dsh-anyplugin/pulls/82/merge', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'raw API merge cannot carry the pin' },
    { tool: 'bash', payload: 'gh api -X PUT repos/szchan/dsh-anyplugin/pulls/82/merge#frag', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'a fragment is still the merge route' },
    { tool: 'bash', payload: 'gh api -f merge_method=squash repos/szchan/dsh-anyplugin/pulls/82/merge', role: 'root', expect: 'deny', rule: 'gh-pr-merge-pin', note: 'method does not make the route safe' },
    { tool: 'bash', payload: 'node scripts/check-decisions.mjs --update', role: 'worker', expect: 'allow', rule: 'allow', note: 'sanctioned writer' },
    { tool: 'bash', payload: 'printf x >> docs/DECISIONS.md', role: 'worker', expect: 'deny', rule: 'decisions-append-only', note: 'redirect edit' },
    { tool: 'bash', payload: 'git checkout -- docs/DECISIONS.md', role: 'worker', expect: 'deny', rule: 'decisions-append-only', note: 'restores the file' },
    { tool: 'bash', payload: `git commit -m "fix: a > b"`, role: 'worker', expect: 'allow', rule: 'allow', note: 'a quoted message is not a redirect' },
    { tool: 'bash', payload: `git commit -m "fix: a -> b"`, role: 'worker', expect: 'allow', rule: 'allow', note: 'quoted arrow' },
    { tool: 'bash', payload: `node -e "fs.writeFileSync('build/x','y')"`, role: 'worker', expect: 'deny', rule: 'interpreter-write', note: 'interpreter write' },
    { tool: 'bash', payload: `node -e "process.stdout.write('1')"`, role: 'worker', expect: 'allow', rule: 'allow', note: 'interpreter without a write' },
    { tool: 'bash', payload: `cd ${worktree} && touch notes.md`, role: 'worker', expect: 'allow', rule: 'allow', note: 'cd into the worktree first' },
    { tool: 'bash', payload: `touch ${protectedRoot}/notes.md`, role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'absolute master path' },
    { tool: 'bash', payload: `echo x >| ${protectedRoot}/x`, role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'clobber redirect' },
    { tool: 'bash', payload: `(cd ${protectedRoot} && touch x)`, role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'shell grouping is refused, not modelled' },
    { tool: 'bash', payload: `git restore ${protectedRoot}/x`, role: 'worker', expect: 'allow', rule: 'allow', note: 'workspace-local git work is ordinary' },
    { tool: 'bash', payload: `tee ${worktree}/x.md < /tmp/in`, role: 'worker', expect: 'allow', rule: 'allow', note: 'read source is not a write target' },
    { tool: 'bash', payload: 'npm run verify', role: 'worker', expect: 'allow', rule: 'allow', note: 'no write target' },
    { tool: 'write', payload: `${worktree}/notes.md`, role: 'worker', expect: 'allow', rule: 'allow', note: 'inside the worktree' },
    { tool: 'write', payload: `${protectedRoot}/notes.md`, role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'master checkout' },
    { tool: 'write', payload: 'docs/notes.md', role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'relative path resolves to cwd' },
    { tool: 'write', payload: 'docs/DECISIONS.md', role: 'worker', expect: 'deny', rule: 'decisions-append-only', note: 'hand edit' },
    { tool: 'edit', payload: `${worktree}/docs/DECISIONS.md`, role: 'worker', expect: 'deny', rule: 'decisions-append-only', note: 'hand edit, absolute' },
    { tool: 'apply_patch', payload: `*** Begin Patch\n*** Update File: ${worktree}/a.md\n*** End Patch`, role: 'worker', expect: 'allow', rule: 'allow', note: 'patch inside' },
    { tool: 'apply_patch', payload: `*** Begin Patch\n*** Add File: ${protectedRoot}/b.md\n*** End Patch`, role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'patch outside' },
    { tool: 'bash', payload: 'npm test 2>&1', role: 'worker', expect: 'allow', rule: 'allow', note: 'capturing stderr is a redirection, not a background job' },
    { tool: 'bash', payload: 'npm run verify 2>&1 | tail', role: 'worker', expect: 'allow', rule: 'allow', note: 'fd duplication inside a pipeline' },
    { tool: 'bash', payload: 'npm test 1>&2', role: 'worker', expect: 'allow', rule: 'allow', note: 'stream swap' },
    { tool: 'bash', payload: "awk '{print $1}' README.md", role: 'worker', expect: 'allow', rule: 'allow', note: 'a literal $ inside single quotes' },
    { tool: 'bash', payload: "echo '$HOME'", role: 'worker', expect: 'allow', rule: 'allow', note: 'single quotes make $ literal' },
    { tool: 'bash', payload: "sed 's/x$//' notes.md", role: 'worker', expect: 'allow', rule: 'allow', note: 'trailing $ inside single quotes' },
    { tool: 'bash', payload: 'echo "$HOME"', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'double quotes still expand' },
    { tool: 'bash', payload: 'echo $1', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'positional expansion outside quotes' },
    { tool: 'bash', payload: 'bash scripts/test.sh', role: 'worker', expect: 'deny', rule: 'shell-script-unverified', note: 'a writable script could be rewritten before it runs' },
    { tool: 'bash', payload: "ruby -e 'File.write(\"/repo/rx\",\"a\")'", role: 'worker', expect: 'deny', rule: 'interpreter-write', note: 'ruby write payload' },
    { tool: 'bash', payload: "php -r 'file_put_contents(\"/repo/rx\",\"a\")'", role: 'worker', expect: 'deny', rule: 'interpreter-write', note: 'php write payload' },
    { tool: 'bash', payload: "git -c alias.p='push --no-verify origin main' p", role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'an alias hides a push' },
    { tool: 'bash', payload: "git config alias.p 'push --no-verify origin main'", role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'writing an alias' },
    { tool: 'bash', payload: 'git -c core.hooksPath=/tmp status', role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'hooksPath redirects the hook' },
    { tool: 'bash', payload: 'git p', role: 'worker', expect: 'deny', rule: 'git-unknown-subcommand', note: 'a short name the reader does not know' },
    { tool: 'bash', payload: 'git push --no-verify origin main', role: 'worker', expect: 'deny', rule: 'git-push-shape', note: '--no-verify is not in the push shape' },
    { tool: 'bash', payload: 'git send-pack ../remote.git HEAD:refs/heads/main', role: 'worker', expect: 'deny', rule: 'git-push-plumbing', note: 'plumbing skips pre-push' },
    { tool: 'bash', payload: "sh -s <<< 'git push --no-verify origin main'", role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'a here-string is stdin the guard cannot read' },
    { tool: 'bash', payload: 'bash <(echo git push origin main)', role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'process substitution hides a command list' },
    { tool: 'bash', payload: "bash /dev/stdin <<< 'git push origin main'", role: 'worker', expect: 'deny', rule: 'shell-unmodelled', note: 'stdin plus a here-string' },
    { tool: 'bash', payload: "git -c core.fsmonitor='sh -c \"git push origin main\"' status", role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'an exec key runs a program' },
    { tool: 'bash', payload: 'git --config-env=core.fsmonitor=ENV status', role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'config-env names the same exec key' },
    { tool: 'bash', payload: "git -c Alias.p='push origin main' p", role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'keys are case-insensitive' },
    { tool: 'bash', payload: "git push --receive-pack='sh -c \"git push origin main\"' origin ticket/80", role: 'worker', expect: 'deny', rule: 'git-push-exec', note: 'receive-pack runs a program from the push' },
    { tool: 'bash', payload: 'git update-ref refs/heads/main HEAD', role: 'worker', expect: 'deny', rule: 'git-write-verb', note: 'local ref rewrite' },
    { tool: 'bash', payload: 'git -c user.name=X -c user.email=Y commit -m "x"', role: 'worker', expect: 'allow', rule: 'allow', note: 'non-exec -c keys are ordinary work' },
    { tool: 'bash', payload: 'git rebase main', role: 'worker', expect: 'allow', rule: 'allow', note: 'workspace-local history work' },
    { tool: 'bash', payload: 'git stash', role: 'worker', expect: 'allow', rule: 'allow', note: 'workspace-local' },
    { tool: 'bash', payload: 'git config --get user.name', role: 'worker', expect: 'allow', rule: 'allow', note: 'reading config is ordinary work' },
    { tool: 'bash', payload: 'git config --list', role: 'worker', expect: 'allow', rule: 'allow', note: 'listing config is ordinary work' },
    { tool: 'bash', payload: 'git push --force-with-lease origin ticket/80', role: 'worker', expect: 'allow', rule: 'allow', note: 'a rebased ticket branch must be re-pushed' },
    { tool: 'bash', payload: 'FOO=1 git push origin main', role: 'worker', expect: 'deny', rule: 'git-env-prefix', note: 'any leading assignment can redirect git' },
    { tool: 'bash', payload: 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=x git status', role: 'worker', expect: 'deny', rule: 'git-env-prefix', note: 'config injection without -c' },
    { tool: 'bash', payload: 'git push origin "refs/heads/*:refs/heads/ticket/*"', role: 'worker', expect: 'deny', rule: 'git-push-shape', note: 'a wildcard can address main' },
    { tool: 'bash', payload: 'git push origin "HEAD:refs/heads/*"', role: 'worker', expect: 'deny', rule: 'git-push-shape', note: 'wildcard destination' },
    { tool: 'bash', payload: 'git push origin "HEAD:refs/heads/main..tmp"', role: 'worker', expect: 'deny', rule: 'git-push-shape', note: 'a range in a refspec' },
    { tool: 'bash', payload: 'node -e "import(\'child_process\').then(m => m.execSync(\'git push origin main\'))"', role: 'worker', expect: 'deny', rule: 'interpreter-exec', note: 'literal process spawn' },
    { tool: 'bash', payload: 'ruby -e "system(\'git push origin main\')"', role: 'worker', expect: 'deny', rule: 'interpreter-exec', note: 'ruby spawn spelling' },
    { tool: 'bash', payload: 'git config user.name X', role: 'root', expect: 'allow', rule: 'allow', note: 'root may write a non-exec key' },
    { tool: 'bash', payload: 'git config core.hooksPath /tmp/hooks', role: 'root', expect: 'deny', rule: 'git-config-write', note: 'root may not redirect hooks' },
    { tool: 'bash', payload: 'git -c diff.foo.command=\'sh -c "git push --no-verify origin HEAD:main"\' diff --ext-diff', role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'diff.<driver>.command runs a program' },
    { tool: 'bash', payload: 'git --config-env=diff.foo.command=ENV diff --ext-diff', role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'config-env names the same driver key' },
    { tool: 'bash', payload: 'git -c color.ui=false status', role: 'worker', expect: 'allow', rule: 'allow', note: 'color.* is inert' },
    { tool: 'bash', payload: 'printf \'[diff "foo"]\\n  command = sh -c "git push origin HEAD:main"\\n\' >> .git/config', role: 'worker', expect: 'deny', rule: 'git-dir-write', note: 'planting a driver in .git/config' },
    { tool: 'bash', payload: 'sudo git push origin main', role: 'worker', expect: 'deny', rule: 'sudo-refused', note: 'sudo is not modelled' },
    { tool: 'bash', payload: 'git config foo.bar x', role: 'root', expect: 'deny', rule: 'git-config-write', note: 'root uses the same inert allowlist' },
    { tool: 'bash', payload: 'git -c user.name=X -c user.email=Y commit -m "x"', role: 'root', expect: 'allow', rule: 'allow', note: 'root -c uses the same inert allowlist' },
    { tool: 'bash', payload: 'ruby -e \'exec("git","push","--no-verify","origin","HEAD:main")\'' , role: 'worker', expect: 'deny', rule: 'interpreter-exec', note: 'exec is a spawn spelling' },
    { tool: 'bash', payload: 'python3 -c \'import os; os.popen("git push --no-verify origin HEAD:main")\'' , role: 'worker', expect: 'deny', rule: 'interpreter-exec', note: 'popen is a spawn spelling' },
    { tool: 'bash', payload: `node -e 'import("node:fs").then(fs => fs.renameSync("${worktree}/evil", ".git/config"))'`, role: 'worker', expect: 'deny', rule: 'interpreter-write', note: 'renameSync is a mutation verb' },
    { tool: 'bash', payload: `tar -xf ${protectedRoot}/evil.tar -C .git`, role: 'worker', expect: 'deny', rule: 'git-dir-write', note: 'extracting into .git writes a config' },
    { tool: 'bash', payload: `tar -xf ${protectedRoot}/evil.tar -C.git`, role: 'worker', expect: 'deny', rule: 'git-dir-write', note: 'GNU tar attaches the -C directory: -C.git' },
    { tool: 'bash', payload: `tar -xf ${protectedRoot}/evil.tar -C/tmp/tarout7`, role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'attached -Cdir outside the worktree' },
    { tool: 'bash', payload: 'exec sudo git status', role: 'worker', expect: 'deny', rule: 'sudo-refused', note: 'exec is a launcher, sudo is still the command' },
    { tool: 'bash', payload: 'nice sudo git status', role: 'worker', expect: 'deny', rule: 'sudo-refused', note: 'nice is a launcher' },
    { tool: 'bash', payload: 'timeout 5 sudo git status', role: 'worker', expect: 'deny', rule: 'sudo-refused', note: 'timeout duration comes before the command' },
    { tool: 'bash', payload: 'xargs sudo true', role: 'worker', expect: 'deny', rule: 'sudo-refused', note: 'xargs runs sudo' },
    { tool: 'bash', payload: `node -e 'process.stdout.write("exec(")'`, role: 'worker', expect: 'allow', rule: 'allow', note: 'exec( inside a string literal is data, not a spawn' },
    { tool: 'bash', payload: `python3 -c 'print("exec(")'`, role: 'worker', expect: 'allow', rule: 'allow', note: 'the same string data in python' },
    { tool: 'bash', payload: 'git commit -m sudo', role: 'worker', expect: 'allow', rule: 'allow', note: 'sudo in a message is not a command' },
    { tool: 'bash', payload: 'grep sudo README.md', role: 'worker', expect: 'allow', rule: 'allow', note: 'sudo as an operand is not a command' },
    { tool: 'bash', payload: 'echo sudo', role: 'worker', expect: 'allow', rule: 'allow', note: 'sudo as text is not a command' },
    { tool: 'bash', payload: 'env -i -u X sudo git status', role: 'worker', expect: 'deny', rule: 'sudo-refused', note: 'sudo after env options is still the command' },
    { tool: 'bash', payload: 'git config user.name X', role: 'worker', expect: 'deny', rule: 'git-config-write', note: 'workers do not write config' },
  ]
}

export interface TableRow extends TableCase {
  actual: 'allow' | 'deny'
  actualRule: string
  reason?: string
  ok: boolean
}

/** Run the table through the real judge. Nothing here touches the filesystem. */
export function runTable(
  cases: TableCase[],
  config: GuardConfig,
  options: { worktree: string; protectedRoot: string; fallbackBranch?: string },
): { rows: TableRow[]; failures: TableRow[] } {
  const fallbackBranch = options.fallbackBranch ?? 'ticket/80'
  const policy: ResolvedPolicy = resolvePolicy(config)
  const rows: TableRow[] = []
  for (const testCase of cases) {
    const branch = testCase.unknownBranch === true ? undefined : (testCase.branch ?? fallbackBranch)
    const context: JudgeContext = { branch: () => branch }
    const args =
      testCase.tool === 'bash'
        ? { command: testCase.payload }
        : testCase.tool === 'apply_patch'
          ? { input: testCase.payload }
          : { file_path: testCase.payload }
    const worker = testCase.role === 'worker'
    const verdict: Verdict = judgeCall(
      {
        tool: testCase.tool,
        args,
        agent: { id: worker ? 'worker-1' : 'root-1', cwd: options.protectedRoot, worker },
        ...(worker ? { worktree: options.worktree } : {}),
      },
      policy,
      context,
    )
    rows.push({
      ...testCase,
      actual: verdict.kind,
      actualRule: verdict.rule,
      ...(verdict.kind === 'deny' ? { reason: verdict.reason } : {}),
      ok: verdict.kind === testCase.expect && verdict.rule === testCase.rule,
    })
  }
  return { rows, failures: rows.filter((row) => !row.ok) }
}

/** Aligned table for the terminal; `why` is the rule the run produced. */
export function formatTable(rows: TableRow[]): string {
  const header = ['tool', 'payload', 'role', 'expect', 'actual', 'rule', 'why']
  const cells = rows.map((row) => [
    row.tool,
    row.payload.replace(/\n/gu, ' '),
    row.role,
    row.expect,
    row.actual,
    row.actualRule,
    row.note,
  ])
  const widths = header.map((title, index) => Math.max(title.length, ...cells.map((row) => row[index].length)))
  const line = (values: string[]): string => values.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd()
  return [line(header), ...cells.map((row) => line(row))].join('\n')
}
