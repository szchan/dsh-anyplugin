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
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_SHELL_TOOLS,
  DEFAULT_WRITE_TOOLS,
  judgeCall,
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

export interface Ratchet {
  /** `25 declared / 24 matched / 0 missing / 1 refused`, verbatim from docs/FEATURES.md. */
  totals: string
  /** `11 fixtures`: the fixture directories `EXPECTED_ROWS` owns, derived from the test. */
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
  // Porcelain order is lexical, not "main first"; the common dir is the only
  // reliable answer, and it also tells a linked worktree from the checkout the
  // repository owns.
  try {
    const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim()
    const owner = dirname(common)
    for (const entry of worktrees) entry.main = entry.path === owner
  } catch {
    // A layout without a common dir is not a worktree checkout; leave `main` unset.
  }
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
  const config: GuardConfig = {
    shellTools: [...DEFAULT_SHELL_TOOLS],
    writeTools: [...DEFAULT_WRITE_TOOLS],
    worktrees: ticketWorktrees.map((entry) => entry.path),
    protectedRoots: main === undefined ? [] : [main.path],
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
    { tool: 'bash', payload: 'git push origin --delete main', role: 'worker', expect: 'deny', rule: 'git-push-main', note: 'deletes main' },
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
    { tool: 'bash', payload: 'gh pr merge 82 --squash', role: 'worker', expect: 'deny', rule: 'gh-pr-merge-worker', note: 'worker merge' },
    { tool: 'bash', payload: 'gh pr merge 82 --squash', role: 'root', expect: 'allow', rule: 'allow', note: 'master merge' },
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
    { tool: 'bash', payload: `git restore ${protectedRoot}/x`, role: 'worker', expect: 'deny', rule: 'git-write-verb', note: 'git write verb' },
    { tool: 'bash', payload: `tee ${worktree}/x.md < /tmp/in`, role: 'worker', expect: 'allow', rule: 'allow', note: 'read source is not a write target' },
    { tool: 'bash', payload: 'npm run verify', role: 'worker', expect: 'allow', rule: 'allow', note: 'no write target' },
    { tool: 'write', payload: `${worktree}/notes.md`, role: 'worker', expect: 'allow', rule: 'allow', note: 'inside the worktree' },
    { tool: 'write', payload: `${protectedRoot}/notes.md`, role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'master checkout' },
    { tool: 'write', payload: 'docs/notes.md', role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'relative path resolves to cwd' },
    { tool: 'write', payload: 'docs/DECISIONS.md', role: 'worker', expect: 'deny', rule: 'decisions-append-only', note: 'hand edit' },
    { tool: 'edit', payload: `${worktree}/docs/DECISIONS.md`, role: 'worker', expect: 'deny', rule: 'decisions-append-only', note: 'hand edit, absolute' },
    { tool: 'apply_patch', payload: `*** Begin Patch\n*** Update File: ${worktree}/a.md\n*** End Patch`, role: 'worker', expect: 'allow', rule: 'allow', note: 'patch inside' },
    { tool: 'apply_patch', payload: `*** Begin Patch\n*** Add File: ${protectedRoot}/b.md\n*** End Patch`, role: 'worker', expect: 'deny', rule: 'write-outside-worktree', note: 'patch outside' },
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
