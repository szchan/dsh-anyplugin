#!/usr/bin/env node
// One deterministic digest for the daily process audit (docs/AUDIT.md).
//
// The auditor's first hour is usually spent re-counting the same things: how
// often the guard fired, which commands agents repeat, how many review rounds a
// PR took, whether the gate is installed at all. That counting is cheap and
// mechanical, so it belongs in a script — the auditor should spend its context
// on *why* the numbers moved and what mechanism removes the cause.
//
// This script only reads. It never runs `verify`, never writes the profile,
// never posts to GitHub without `--github`, and never copies a transcript
// verbatim into its output: sessions are aggregated into counts and at most
// three short samples per bucket, because a transcript can contain credentials
// and external text (docs/TRIAGE.md §1). Raw evidence stays under `.audit/`
// (gitignored); audit reports quote the digest, not the transcript.
//
//   node scripts/audit-evidence.mjs                 # last 7 days, local only
//   node scripts/audit-evidence.mjs --days 14 --github
//   node scripts/audit-evidence.mjs --json > /tmp/e.json
//   node scripts/audit-evidence.mjs --no-sessions   # git/repo only, fast
//
// Exit status is 0 when the digest was produced. Findings are the auditor's
// job, not this script's: it reports state, it does not judge it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mainCheckout } from './audit-checkout.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)

// Sessions are recorded under the *checkout that owns the .git directory*, and a
// ticket worktree is still the same project. The audit usually runs from a
// worktree, so resolve the main checkout rather than using `root`. The helper
// mirrors the guard's resolver (composition.ts) so the denial reader below and
// the guard's writer agree in worktree, submodule and separate-git-dir layouts.
const projectRoot = mainCheckout(root)

// `.audit/` is where this script writes its evidence and where the guard
// appends denials (F16). The override moves both: a test or a per-machine run
// needs one directory, not a log in the checkout and a report somewhere else.
const auditDir = (() => {
  const override = process.env.DSH_ANYPLUGIN_AUDIT_DIR
  // Both sides follow the checkout that owns `.git`, not the directory this
  // script was read from: the audit usually runs from a ticket worktree, and a
  // guard installed there writes the main checkout's log (denials.ts).
  return typeof override === 'string' && override.trim() !== '' ? resolve(override.trim()) : join(projectRoot, '.audit')
})()

function option(name, fallback) {
  const index = argv.indexOf(name)
  if (index === -1) return fallback
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`)
  return value
}
const days = Number(option('--days', '7'))
if (!Number.isFinite(days) || days <= 0) fail('--days must be a positive number')
const asJson = argv.includes('--json')
const withGithub = argv.includes('--github')
const withSessions = !argv.includes('--no-sessions')
const outFile = option('--out', '')
const now = new Date()
const since = new Date(now.getTime() - days * 86_400_000)
const sinceIso = since.toISOString()
const today = now.toISOString().slice(0, 10)

function fail(message) {
  console.error(`audit-evidence: ${message}`)
  process.exit(2)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 20_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

function git(...args) {
  return run('git', args)
}

/** Markdown table cells must not contain a pipe; counts are short anyway. */
const cell = (value) => String(value).replaceAll('|', '\\|')
const pct = (part, whole) => (whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`)
const top = (map, limit) =>
  [...map.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, limit)

// ---------------------------------------------------------------------------
// Repository state and the docs that carry the process contract.

function commitsInWindow() {
  const log = git(
    'log',
    `--since=${sinceIso}`,
    '--pretty=format:%h%x09%aI%x09%s',
    '--no-merges',
  )
  if (!log.ok) return { count: 0, byPrefix: [], subjects: [] }
  const rows = log.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, date, subject] = line.split('\t')
    return { hash, date, subject }
  })
  const byPrefix = new Map()
  for (const row of rows) {
    const match = row.subject.match(/^([a-z][a-z0-9-]*):/u)
    const prefix = match?.[1] ?? '(none)'
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1)
  }
  const merges = git('log', `--since=${sinceIso}`, '--merges', '--pretty=format:%h')
  return {
    count: rows.length,
    merges: merges.ok ? merges.stdout.split('\n').filter(Boolean).length : 0,
    byPrefix: [...byPrefix.entries()].sort((a, b) => b[1] - a[1]).map(([prefix, count]) => ({ prefix, count })),
    subjects: rows.slice(0, 40).map((row) => `${row.hash} ${row.subject}`),
  }
}

function worktreeState() {
  const list = git('worktree', 'list', '--porcelain')
  if (!list.ok) return { available: false, total: 0, ticket: 0, review: 0, prunable: 0 }
  const paths = [...list.stdout.matchAll(/^worktree (.+)$/gmu)].map((match) => match[1])
  return {
    available: true,
    total: paths.length,
    ticket: paths.filter((path) => /\/ticket-/.test(path)).length,
    review: paths.filter((path) => /\/review/.test(path)).length,
    prunable: list.stdout.split('\n').filter((line) => line.startsWith('prunable')).length,
  }
}

function decisionsState() {
  const path = join(root, 'docs', 'DECISIONS.md')
  if (!existsSync(path)) return { entries: 0, last: '', duplicates: [] }
  const ids = [...readFileSync(path, 'utf8').matchAll(/^## (D\d+) — /gmu)].map((match) => match[1])
  const seen = new Set()
  const duplicates = new Set()
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return { entries: ids.length, last: ids.at(-1) ?? '', duplicates: [...duplicates] }
}

function featuresState() {
  const path = join(root, 'docs', 'FEATURES.md')
  if (!existsSync(path)) return { rows: 0, byStatus: [] }
  const text = readFileSync(path, 'utf8')
  // The table's rows are the claims; the header separator and headings are not.
  const rows = text.split('\n').filter((line) => /^\|/u.test(line) && !/^\|\s*-+/u.test(line) && !/^\|\s*(Area|Claim|Capability)\b/iu.test(line))
  const byStatus = new Map()
  for (const row of rows) {
    const status = row.split('|').at(-2)?.trim() ?? ''
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
  }
  return { rows: rows.length, byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]) }
}

function todoState() {
  const path = join(root, 'docs', 'TODO.md')
  if (!existsSync(path)) return { open: 0 }
  const open = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => /^\s*[-*]\s+\[ \]/u.test(line)).length
  return { open }
}

function mechanismState() {
  const scripts = existsSync(join(root, 'scripts')) ? readdirSync(join(root, 'scripts')) : []
  const gate = scripts.filter((name) => /^check-.*\.mjs$/u.test(name) && !/\.test\.mjs$/u.test(name)).sort()
  const tests = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.test\.mjs$/u.test(entry.name)) tests.push(relative(root, path))
    }
  }
  walk(join(root, 'packages'))
  walk(join(root, 'scripts'))
  return { gates: gate, tests: tests.length }
}

// ---------------------------------------------------------------------------
// Session transcripts. This is the only source that shows what agents actually
// did, as opposed to what the workflow says they do. Sessions are streamed:
// one of them is over a megabyte compressed, and `execFileSync` with a buffer
// died on it (`spawnSync zstd ENOBUFS`).

const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')
/** `/home/szchan/Projects/dsh-anyplugin` -> `--home-szchan-Projects-dsh-anyplugin--`. */
function sessionDir(repo) {
  return `--${repo.replaceAll(sep, '-').replace(/^-+/u, '')}--`
}

/** Collapse a command to the workflow it belongs to, not its arguments. */
export function normalizeCommand(command) {
  let text = String(command ?? '').trim().replace(/\s+/gu, ' ')
  if (text === '') return ''
  // Leading `cd <dir> &&` is the single largest source of duplicate text in the
  // transcripts (see the digest's `cd-prefix` line); groups are about the work.
  text = text.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^&;]+?)\s*(?:&&|;)\s*/u, '')
  const tokens = text.split(' ')
  const first = tokens[0]
  if (first === 'npm' || first === 'pnpm') {
    return tokens[1] === 'run' ? `${first} run ${tokens[2] ?? ''}` : `${first} ${tokens[1] ?? ''}`
  }
  if (first === 'node') {
    if (tokens[1] === '-e' || tokens[1] === '--input-type=module' || tokens[1] === '-') return `node ${tokens[1]}`
    const script = tokens.find((token) => /\.(?:mjs|cjs|js|ts)$/u.test(token))
    return script === undefined ? `node ${tokens[1] ?? ''}` : `node ${script.replace(/^\.\//u, '')}`
  }
  if (first === 'git') return `git ${tokens[1] ?? ''}`.trim()
  if (first === 'gh') return `gh ${tokens[1] ?? ''} ${tokens[2] ?? ''}`.trim()
  if (first === 'npx') return `npx ${tokens[1] ?? ''}`
  if (first === 'sudo') return 'sudo'
  return first
}

function toolText(message) {
  const content = message?.content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? part?.content ?? '').join('\n')
  return String(content ?? '')
}

async function analyzeSession(file) {
  const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] })
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  const session = {
    file,
    id: basename(join(file, '..')),
    cwd: '',
    depth: 0,
    preset: '',
    toolCalls: new Map(),
    bash: new Map(),
    cdPrefix: 0,
    workdir: 0,
    guardDenials: new Map(),
    verifyRuns: 0,
    gateRuns: 0,
    toolErrors: 0,
    writeFiles: new Set(),
  }
  const calls = new Map()
  const bashGroupByCall = new Map()
  for await (const line of lines) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'session') {
      session.cwd = event.cwd ?? ''
      session.depth = event.delegationDepth ?? 0
      session.preset = event.agentPreset ?? ''
      continue
    }
    if (event.type === 'tool/call') {
      const name = event.data?.name ?? ''
      session.toolCalls.set(name, (session.toolCalls.get(name) ?? 0) + 1)
      let args = {}
      try {
        args = JSON.parse(event.data?.arguments ?? '{}')
      } catch {
        args = {}
      }
      calls.set(event.data?.callId, name)
      if (name === 'bash') {
        const command = String(args.command ?? '')
        if (args.workdir !== undefined) session.workdir += 1
        if (/^cd\s/u.test(command.trim())) session.cdPrefix += 1
        if (/npm run verify/u.test(command)) session.verifyRuns += 1
        if (/npm run check:/u.test(command)) session.gateRuns += 1
        const group = normalizeCommand(command)
        if (group !== '') {
          const record = session.bash.get(group) ?? { count: 0, failed: 0 }
          record.count += 1
          session.bash.set(group, record)
          bashGroupByCall.set(event.data?.callId, group)
        }
      } else if (name === 'edit' || name === 'write') {
        const path = String(args.file_path ?? args.path ?? '')
        if (path !== '') session.writeFiles.add(path)
      }
      continue
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message
      const text = toolText(message)
      if (message?.isError === true) {
        session.toolErrors += 1
        const group = bashGroupByCall.get(message.toolCallId)
        if (group !== undefined) {
          const record = session.bash.get(group)
          if (record !== undefined) record.failed += 1
        }
      }
      // Only a *denial* counts. The same string appears whenever an agent reads
      // the guard source, and counting that turned 19 real denials into 31
      // "unknown" ones — a mechanism metric that lied in the safe direction.
      // One result can carry many denials (a spike that exercises the guard),
      // so count every line, not one per tool result.
      for (const denial of text.matchAll(/DENY\s*\|?\s*anyplugin-guard:[^\n]*/gu)) {
        const rule = denial[0].match(/\(rule ([a-z0-9-]+)\)/u)?.[1] ?? 'unknown'
        const record = session.guardDenials.get(rule) ?? { count: 0, sample: '' }
        record.count += 1
        if (record.sample === '') record.sample = denial[0].slice(0, 180)
        session.guardDenials.set(rule, record)
      }
    }
  }
  await new Promise((resolveClose) => child.on('close', resolveClose))
  return session
}

async function sessionEvidence() {
  const dir = join(SESSION_ROOT, sessionDir(projectRoot))
  if (!existsSync(dir)) return { available: false, dir, sessions: 0 }
  const files = readdirSync(dir)
    .map((name) => join(dir, name, 'session.v4.jsonl.zstd'))
    .filter((file) => {
      try {
        return statSync(file).isFile() && statSync(file).mtimeMs >= since.getTime()
      } catch {
        return false
      }
    })
    .sort()
  const aggregate = {
    available: true,
    dir,
    sessions: files.length,
    roots: 0,
    children: 0,
    presets: [],
    toolCalls: [],
    bashGroups: [],
    cdPrefix: 0,
    workdir: 0,
    bashCalls: 0,
    toolErrors: 0,
    verifyRuns: 0,
    gateRuns: 0,
    guardDenials: [],
    writeTargets: 0,
    topWritePaths: [],
    largest: [],
  }
  if (!withSessions) return aggregate
  const tools = new Map()
  const bash = new Map()
  const presets = new Map()
  const denials = new Map()
  const largest = []
  const writePaths = new Map()
  for (const file of files) {
    const session = await analyzeSession(file)
    if (session.depth === 0) aggregate.roots += 1
    else aggregate.children += 1
    presets.set(session.preset || '(unknown)', (presets.get(session.preset || '(unknown)') ?? 0) + 1)
    aggregate.cdPrefix += session.cdPrefix
    aggregate.workdir += session.workdir
    aggregate.toolErrors += session.toolErrors
    aggregate.verifyRuns += session.verifyRuns
    aggregate.gateRuns += session.gateRuns
    aggregate.writeTargets += session.writeFiles.size
    for (const path of session.writeFiles) writePaths.set(path, (writePaths.get(path) ?? 0) + 1)
    largest.push({
      id: session.id,
      depth: session.depth,
      cwd: session.cwd,
      tools: [...session.toolCalls.values()].reduce((sum, count) => sum + count, 0),
      bash: [...session.bash.values()].reduce((sum, record) => sum + record.count, 0),
    })
    for (const [name, count] of session.toolCalls) tools.set(name, (tools.get(name) ?? 0) + count)
    for (const [group, record] of session.bash) {
      aggregate.bashCalls += record.count
      const current = bash.get(group) ?? { count: 0, failed: 0, samples: [] }
      current.count += record.count
      current.failed += record.failed
      bash.set(group, current)
    }
    for (const [rule, record] of session.guardDenials) {
      const current = denials.get(rule) ?? { rule, count: 0, sample: record.sample }
      current.count += record.count
      denials.set(rule, current)
    }
  }
  aggregate.presets = [...presets.entries()].sort((a, b) => b[1] - a[1]).map(([preset, count]) => ({ preset, count }))
  aggregate.toolCalls = [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
  aggregate.bashGroups = [...bash.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([group, record]) => ({ group, ...record }))
    .slice(0, 30)
  aggregate.guardDenials = [...denials.values()].sort((a, b) => b.count - a.count)
  aggregate.largest = largest.sort((a, b) => b.tools - a.tools).slice(0, 8)
  aggregate.topWritePaths = [...writePaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([path, count]) => ({ path, count }))
  return aggregate
}

// ---------------------------------------------------------------------------
// Installed mechanisms: the guard and the schedule are process contracts too,
// and both can silently stop being active.

function guardEvidence() {
  const script = join(root, 'scripts', 'guard-status.mjs')
  if (!existsSync(script)) return { available: false }
  const result = run(process.execPath, [script, '--json'], { timeout: 25_000 })
  let report = {}
  try {
    report = JSON.parse(result.stdout)
  } catch {
    report = {}
  }
  return {
    available: true,
    status: report.status ?? (result.ok ? 'current' : 'error'),
    sourceExists: report.sourceExists ?? false,
    worktrees: report.worktrees?.length ?? 0,
    installedWorktrees: report.installedWorktrees?.length ?? 0,
    stalePaths: report.stalePaths ?? [],
    protectedRoots: report.protectedRoots ?? [],
    hooks: (report.hooks ?? []).map((hook) => ({ file: hook.file, status: hook.status })),
    duplicateId: report.duplicateId ?? false,
    note: result.ok ? '' : result.stderr.slice(0, 400),
  }
}

// The guard appends one JSON line per refusal to `.audit/guard-denials.jsonl`
// (F16). The guard's own test matrix points `DSH_ANYPLUGIN_AUDIT_DIR` at a
// scratch directory, so this is the count of real refusals; the transcript
// count below is a sighting, not a count. The file is an observability record:
// missing, unreadable or malformed lines are reported, never fatal — the guard
// does not fail a merge and neither does its log.
function guardDenialEvidence() {
  const file = join(auditDir, 'guard-denials.jsonl')
  const empty = { available: false, path: file, total: 0, outsideWindow: 0, unreadable: 0, byRule: [], byRole: [], recent: [] }
  if (!existsSync(file)) return empty
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ...empty, error: String(error).slice(0, 200) }
  }
  const byRule = new Map()
  const byRole = new Map()
  const recent = []
  let total = 0
  let outsideWindow = 0
  let unreadable = 0
  // A record a few minutes ahead of this process is clock skew, not a denial
  // from next week; beyond that it is not in the window either.
  const futureEdge = now.getTime() + 5 * 60 * 1000
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      unreadable += 1
      continue
    }
    const stamp = typeof record?.ts === 'string' ? Date.parse(record.ts) : Number.NaN
    const role = record?.role
    const rule = record?.rule
    if (!Number.isFinite(stamp) || (role !== 'root' && role !== 'worker') || typeof rule !== 'string' || rule === '') {
      unreadable += 1
      continue
    }
    if (stamp < since.getTime() || stamp > futureEdge) {
      outsideWindow += 1
      continue
    }
    total += 1
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
    byRole.set(role, (byRole.get(role) ?? 0) + 1)
    recent.push({ ts: record.ts, rule, role })
  }
  const rows = (map, key) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ [key]: name, count }))
  return {
    available: true,
    path: file,
    total,
    outsideWindow,
    unreadable,
    byRule: rows(byRule, 'rule'),
    byRole: rows(byRole, 'role'),
    recent: recent.slice(-5),
  }
}

function scheduleEvidence() {
  const path = join(homedir(), '.dsh', 'storages', 'schedule.json')
  if (!existsSync(path)) return { available: false, tasks: [] }
  try {
    const storage = JSON.parse(readFileSync(path, 'utf8'))
    const tasks = Object.values(storage.tables?.tasks ?? {}).map((entry) => ({
      id: entry.record?.id ?? '',
      title: entry.record?.title ?? '',
      status: entry.status ?? '',
      rrule: entry.record?.rrule ?? '',
      next: entry.record?.scheduledAt ?? '',
      target: entry.target?.sessionId ?? entry.target?.kind ?? '',
      lastDelivery: entry.lastDelivery?.deliveredAt ?? '',
    }))
    return {
      available: true,
      active: tasks.filter((task) => task.status === 'active').length,
      tasks: tasks.sort((a, b) => a.title.localeCompare(b.title)),
    }
  } catch (error) {
    return { available: false, error: String(error).slice(0, 200), tasks: [] }
  }
}

// ---------------------------------------------------------------------------
// GitHub is optional because it needs the network and the bot identity. The
// daily audit asks for it; `verify` never does.

function githubEvidence() {
  if (!withGithub) return { available: false, reason: 'pass --github to query the queue' }
  const gh = (args) => run(process.execPath, [join(root, 'scripts', 'gh-bot.mjs'), ...args], { timeout: 45_000 })
  const prs = gh([
    'pr', 'list', '--state', 'all', '--limit', '100',
    '--search', `updated:>=${sinceIso.slice(0, 10)}`,
    '--json', 'number,title,state,isDraft,mergedAt,updatedAt,comments,reviewDecision',
  ])
  const issues = gh(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,labels,updatedAt'])
  const runs = gh(['run', 'list', '--limit', '30', '--json', 'conclusion,status,event,headBranch,createdAt'])
  const parse = (result) => {
    if (!result.ok) return { error: (result.stderr || result.stdout).slice(0, 500) }
    try {
      return { rows: JSON.parse(result.stdout) }
    } catch (error) {
      return { error: `unparseable gh output: ${String(error).slice(0, 200)}` }
    }
  }
  const prRows = parse(prs).rows ?? []
  const issueRows = parse(issues).rows ?? []
  const runRows = parse(runs).rows ?? []
  return {
    available: true,
    prs: {
      error: parse(prs).error ?? '',
      total: prRows.length,
      merged: prRows.filter((pr) => pr.state === 'MERGED').length,
      open: prRows.filter((pr) => pr.state === 'OPEN').length,
      withComments: prRows
        .map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          comments: Array.isArray(pr.comments) ? pr.comments.length : 0,
          reviewDecision: pr.reviewDecision ?? '',
        }))
        .filter((pr) => pr.comments > 0)
        .sort((a, b) => b.comments - a.comments)
        .slice(0, 15),
    },
    issues: {
      error: parse(issues).error ?? '',
      open: issueRows.length,
      labels: issueRows.flatMap((issue) => (issue.labels ?? []).map((label) => label.name ?? '')).reduce((map, name) => {
        map[name] = (map[name] ?? 0) + 1
        return map
      }, {}),
    },
    runs: {
      error: parse(runs).error ?? '',
      total: runRows.length,
      failed: runRows.filter((runRow) => runRow.conclusion === 'failure').length,
      byEvent: runRows.reduce((map, runRow) => {
        map[runRow.event] = (map[runRow.event] ?? 0) + 1
        return map
      }, {}),
    },
  }
}

// ---------------------------------------------------------------------------
// The digest. It is deliberately short: the auditor opens the JSON when a line
// needs a number the digest omitted.

function digest(evidence) {
  const lines = []
  lines.push(`# Process evidence — ${today} (last ${days} days)`)
  lines.push('')
  lines.push(`Repo \`${evidence.repo.root}\` at \`${evidence.repo.head}\` on \`${evidence.repo.branch}\`, ${evidence.repo.dirty ? 'dirty' : 'clean'}.`)
  if (evidence.worktrees.available) lines.push(`Worktrees: ${evidence.worktrees.total} total (${evidence.worktrees.ticket} ticket, ${evidence.worktrees.review} review), ${evidence.worktrees.prunable} prunable.`)
  lines.push('')
  lines.push('## Repository')
  lines.push(`- commits: ${evidence.git.count} non-merge, ${evidence.git.merges} merge; by prefix: ${evidence.git.byPrefix.map((row) => `${row.prefix} ${row.count}`).join(', ') || 'none'}`)
  lines.push(`- decisions: ${evidence.decisions.entries} (last ${evidence.decisions.last}; duplicates: ${evidence.decisions.duplicates.join(', ') || 'none'})`)
  lines.push(`- features rows: ${evidence.features.rows}; TODO open: ${evidence.todo.open}`)
  lines.push(`- gates: ${evidence.mechanisms.gates.join(', ')}; tests: ${evidence.mechanisms.tests}`)
  lines.push('')
  lines.push('## Sessions (agent behaviour)')
  if (!evidence.sessions.available) {
    lines.push(`- unavailable: ${evidence.sessions.dir}`)
  } else {
    const sessions = evidence.sessions
    lines.push(`- ${sessions.sessions} sessions (${sessions.roots} root, ${sessions.children} child); presets: ${sessions.presets.map((row) => `${row.preset} ${row.count}`).join(', ')}`)
    // The window selects *sessions* by transcript mtime; the per-session counts
    // below cover the whole transcript, not just events inside the window. The
    // largest-session total is therefore a lifetime figure, which is exactly the
    // unit the role cap measures. Say so, or a 1-day digest reads as 1-day calls.
    lines.push('- counts below are per included session\'s whole transcript: the window selects sessions by transcript mtime, not calls by time; largest-session totals are lifetime, the role-cap unit')
    lines.push(`- bash ${sessions.bashCalls} calls; leading \`cd\` ${sessions.cdPrefix} (${pct(sessions.cdPrefix, sessions.bashCalls)}); \`workdir\` ${sessions.workdir} (${pct(sessions.workdir, sessions.bashCalls)}); tool errors ${sessions.toolErrors}; verify ${sessions.verifyRuns}, check:* ${sessions.gateRuns}`)
    lines.push(`- tools: ${sessions.toolCalls.slice(0, 12).map((row) => `${row.name} ${row.count}`).join(', ')}`)
    lines.push('- top command groups: ' + sessions.bashGroups.slice(0, 12).map((row) => `\`${row.group}\` ${row.count}${row.failed > 0 ? ` (${row.failed} failed)` : ''}`).join(', '))
    // These are DENY *lines in tool output*, and agents run the guard's own
    // test matrix, so the number is not a denial count; the structured denial
    // log below is. This line only says whether the guard was seen at all.
    lines.push(`- guard DENY lines (self-tests included): ${sessions.guardDenials.length === 0 ? 'none' : sessions.guardDenials.map((row) => `${row.rule} ${row.count}`).join(', ')}`)
    lines.push(`- largest sessions: ${sessions.largest.map((row) => `${row.id.slice(0, 24)} d${row.depth} ${row.tools} tools${row.cwd ? ` @ ${row.cwd.replace(evidence.repo.root, '.')}` : ''}`).join(', ')}`)
    lines.push(`- write targets (top): ${sessions.topWritePaths.slice(0, 10).map((row) => `\`${row.path.replace(evidence.repo.root, '.')}\` ${row.count}`).join(', ') || 'none'}`)
  }
  lines.push('')
  lines.push('## Mechanisms')
  const guard = evidence.guard
  lines.push(guard.available
    ? `- guard: **${guard.status}**; source ${guard.sourceExists ? 'present' : 'missing'}; worktrees ${guard.worktrees} desired / ${guard.installedWorktrees} installed${guard.stalePaths.length === 0 ? '' : ` (stale: ${guard.stalePaths.join(', ')})`}; hooks ${guard.hooks.map((hook) => `${hook.file} ${hook.status}`).join(', ') || 'none'}`
    : '- guard: unavailable (scripts/guard-status.mjs missing)')
  const denials = evidence.guardDenials
  if (!denials.available) {
    lines.push(denials.error
      ? `- guard denials (structured, last ${days} days): log unreadable (${denials.error}) at ${denials.path}`
      : `- guard denials (structured, last ${days} days): no structured log at ${denials.path}`)
  } else {
    const roles = denials.byRole.map((row) => `${row.role} ${row.count}`).join(', ') || 'none'
    const rules = denials.byRule.map((row) => `${row.rule} ${row.count}`).join(', ') || 'none'
    const recent = denials.recent.map((row) => `${row.ts.slice(0, 19)} ${row.rule} ${row.role}`).join(', ') || 'none'
    lines.push(`- guard denials (structured, last ${days} days): ${denials.total} (${roles}); by rule: ${rules}; last: ${recent}${denials.unreadable > 0 ? `; ${denials.unreadable} unreadable line(s)` : ''}${denials.outsideWindow > 0 ? `; ${denials.outsideWindow} outside window` : ''}`)
  }
  const schedules = evidence.schedules
  lines.push(schedules.available
    ? `- schedules: ${schedules.active} active of ${schedules.tasks.length}; ${schedules.tasks.map((task) => `${task.title} [${task.status}] ${task.rrule.split('\n').at(-1) ?? ''} -> ${task.target ? task.target.slice(0, 18) : '?'}${task.lastDelivery ? `; last ${task.lastDelivery}` : ''}`).join('; ')}`
    : '- schedules: unavailable')
  if (evidence.github.available) {
    lines.push('')
    lines.push('## GitHub')
    const github = evidence.github
    if (github.prs.error) lines.push(`- PR query failed: ${github.prs.error}`)
    else lines.push(`- PRs updated in window: ${github.prs.total} (${github.prs.merged} merged, ${github.prs.open} open); comment-heavy: ${github.prs.withComments.slice(0, 8).map((pr) => `#${pr.number} ${pr.comments}`).join(', ') || 'none'}`)
    if (github.issues.error) lines.push(`- issue query failed: ${github.issues.error}`)
    else lines.push(`- open issues: ${github.issues.open}; labels: ${Object.entries(github.issues.labels).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => `${name} ${count}`).join(', ') || 'none'}`)
    if (github.runs.error) lines.push(`- run query failed: ${github.runs.error}`)
    else lines.push(`- CI runs examined: ${github.runs.total}, failed ${github.runs.failed}`)
  } else {
    lines.push('')
    lines.push('GitHub: skipped (pass `--github`).')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

const evidence = {
  generatedAt: now.toISOString(),
  windowDays: days,
  repo: { root, head: git('rev-parse', '--short', 'HEAD').stdout, branch: git('rev-parse', '--abbrev-ref', 'HEAD').stdout, dirty: git('status', '--porcelain').stdout !== '' },
  worktrees: worktreeState(),
  git: commitsInWindow(),
  decisions: decisionsState(),
  features: featuresState(),
  todo: todoState(),
  mechanisms: mechanismState(),
  sessions: await sessionEvidence(),
  guard: guardEvidence(),
  guardDenials: guardDenialEvidence(),
  schedules: scheduleEvidence(),
  github: githubEvidence(),
}

// The evidence directory is created before anything is printed. A digest on
// stdout with no file behind it reads as a data problem, when the real problem
// is that the directory is not writable.
const failWrite = (where, error) => {
  console.error(`audit-evidence: cannot write ${where}: ${error.code ?? error.message}`)
  process.exit(1)
}
try {
  mkdirSync(auditDir, { recursive: true })
} catch (error) {
  failWrite(auditDir, error)
}

if (outFile !== '') {
  const target = isAbsolute(outFile) ? outFile : join(root, outFile)
  try {
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`)
  } catch (error) {
    failWrite(target, error)
  }
}
const evidenceTarget = join(auditDir, `evidence-${today}.json`)
try {
  writeFileSync(evidenceTarget, `${JSON.stringify(evidence, null, 2)}\n`)
} catch (error) {
  failWrite(evidenceTarget, error)
}

if (asJson) console.log(JSON.stringify(evidence, null, 2))
else console.log(digest(evidence))
