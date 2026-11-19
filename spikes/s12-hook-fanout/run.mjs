#!/usr/bin/env node
// S12: do classic hooks fan out?
//
// Reviewer-27 probed Claude Code 2.1.322 by hand: two PreToolUse hooks, the
// first exits 2 (deny), the second appends a marker. The marker appeared, so a
// decision does not skip a sibling. This spike reproduces that probe as a
// repeatable check and adds the other mounted events:
//
//   run A (deny)  — two PreToolUse hooks, first denies, both must log.
//   run B (allow) — two hooks on SessionStart, PreToolUse, PostToolUse, Stop and
//                   SessionEnd; the PostToolUse first hook reports a denial and
//                   must still not skip the second. The Stop first hook denies
//                   once (exit 2) and must not skip the second.
//
// The pinned client dispatches the matching hooks concurrently, so arrival order
// in the log is not stable. The checks assert presence, not order.
//
// A real model turn is required: the hooks are dispatched by Claude Code around
// a Bash call, not invoked by this script. The turn is routed to DeepSeek's
// Anthropic-compatible endpoint (the same backend S6 uses). The key is read from
// `DEEPSEEK_API_KEY` or `~/.config/dsh-anyplugin/deepseek.key`, never printed.
// Without a key the spike records a named skip and exits 0; every other failure
// exits non-zero, and a run with zero checks is a failure.
//
// This spike is local-only: it needs a live model turn and a key, so CI never
// invokes it. The named skip is for local runs, not a green CI step — a CI step
// that always skips would be worse than no step.
//
// Run:
//   DSH_HARNESS_VERSION=0.2.2-rc.5 node spikes/s12-hook-fanout/run.mjs
//
// Report: spikes/s12-hook-fanout/out/report.json (gitignored).
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
mkdirSync(OUT, { recursive: true })

const CLAUDE_PIN = '2.1.322'
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const skip = (why) => {
  console.log(`SKIP  S12 hook fan-out — ${why}`)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ skipped: why, checks }, null, 2))
  process.exit(0)
}

function key() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const file = join(homedir(), '.config', 'dsh-anyplugin', 'deepseek.key')
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim()
    if (value !== '') return value
  }
  return undefined
}
const apiKey = key()
if (apiKey === undefined) skip('no DEEPSEEK_API_KEY and no ~/.config/dsh-anyplugin/deepseek.key')

const claudeBinary = process.env.CLAUDE_BIN?.trim() || 'claude'
const claudeVersion = await new Promise((resolveVersion) => {
  const child = spawn(claudeBinary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.on('error', () => resolveVersion(''))
  child.on('close', () => resolveVersion(out.trim()))
})
if (claudeVersion === '') skip(`no claude binary at ${claudeBinary}`)
if (!claudeVersion.startsWith(CLAUDE_PIN)) skip(`claude is ${claudeVersion}, spike claims ${CLAUDE_PIN}`)

const root = join(OUT, 'run')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'home', '.claude'), { recursive: true })
const plugin = join(root, 'plugin')
mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
mkdirSync(join(plugin, 'hooks'), { recursive: true })

const hookScript = join(plugin, 'hook.mjs')
writeFileSync(hookScript, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const [label, behaviour] = process.argv.slice(2)
const log = process.env.S12_FANOUT_LOG
appendFileSync(log, label + '\\n')
if (behaviour === 'deny-pre' && process.env.S12_DENY_PRE === '1') {
  process.stderr.write(label + ' denied this call\\n')
  process.exit(2)
}
if (behaviour === 'deny-once') {
  const flag = log + '.' + label
  if (!existsSync(flag)) {
    writeFileSync(flag, '')
    process.stderr.write(label + ' denied this call once\\n')
    process.exit(2)
  }
}
process.stdout.write('{}\\n')
`)
chmodSync(hookScript, 0o755)

const command = (label, behaviour) =>
  `"${process.execPath}" "${hookScript}" ${JSON.stringify(label)} ${JSON.stringify(behaviour)}`
const group = (matcher, entries) => (matcher === undefined ? { hooks: entries } : { matcher, hooks: entries })
const hookEntry = (label, behaviour) => ({ type: 'command', command: command(label, behaviour) })

writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 's12-hook-fanout',
  description: 'S12: two hooks per event; observe whether the second still runs',
  version: '0.0.0',
}, null, 2))
writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({
  hooks: {
    SessionStart: [group(undefined, [hookEntry('SessionStart:first', 'ok'), hookEntry('SessionStart:second', 'ok')])],
    PreToolUse: [group('Bash', [hookEntry('PreToolUse:first', 'deny-pre'), hookEntry('PreToolUse:second', 'ok')])],
    PostToolUse: [group('Bash', [hookEntry('PostToolUse:first', 'deny-once'), hookEntry('PostToolUse:second', 'ok')])],
    Stop: [group(undefined, [hookEntry('Stop:first', 'deny-once'), hookEntry('Stop:second', 'ok')])],
    SessionEnd: [group(undefined, [hookEntry('SessionEnd:first', 'ok'), hookEntry('SessionEnd:second', 'ok')])],
  },
}, null, 2))

// PostToolUse's first hook must run and then report a denial; it is not a
// blocking event, so the second hook still has to run. Reuse deny-once so a
// single tool call cannot make it loop.
// (Handled above by the `deny-once` behaviour; it is intentionally not called
// `deny` because PostToolUse reads exit 2 as feedback, not a block.)

const backend = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: apiKey,
  ANTHROPIC_MODEL: 'deepseek-flash',
  ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-flash',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
}

const prompt = 'Use the Bash tool to run exactly this command: echo s12-fanout. Do not use any other tool.'
const runs = [
  { id: 'deny', denyPre: '1' },
  { id: 'allow', denyPre: '0' },
]
const summaries = []

for (const run of runs) {
  const log = join(OUT, `${run.id}.log`)
  rmSync(log, { force: true })
  const args = [
    '--plugin-dir', plugin,
    '-p', prompt,
    '--allowedTools', 'Bash',
    '--output-format', 'json',
  ]
  console.log(`\n[run ${run.id}] claude ${args.join(' ')}`)
  const child = spawn(claudeBinary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...backend,
      HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'),
      S12_FANOUT_LOG: log,
      S12_DENY_PRE: run.denyPre,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  const exit = await new Promise((resolveExit) => {
    child.on('error', (error) => resolveExit({ code: -1, error: error.message }))
    child.on('close', (code, signal) => resolveExit({ code, signal }))
  })
  clearTimeout(timer)
  const lines = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '')
    : []
  summaries.push({ run: run.id, exit, lines, stdoutTail: stdout.trim().slice(-500), stderrTail: stderr.trim().slice(-500) })
  console.log(`[run ${run.id}] exit=${exit.code} signal=${exit.signal ?? '-'} lines=${JSON.stringify(lines)}`)
  if (stderr.trim() !== '') console.log(`[run ${run.id}] stderr: ${stderr.trim().slice(-800)}`)

  if (run.id === 'deny') {
    check('a denied PreToolUse does not skip its sibling',
      lines.includes('PreToolUse:first') && lines.includes('PreToolUse:second'), JSON.stringify(lines))
    check('a denied PreToolUse really blocks the tool call (no PostToolUse fired)',
      !lines.some((line) => line.startsWith('PostToolUse:')), JSON.stringify(lines))
  } else {
    check('both SessionStart hooks run', lines.includes('SessionStart:first') && lines.includes('SessionStart:second'), JSON.stringify(lines))
    check('both PreToolUse hooks run when the first allows', lines.includes('PreToolUse:first') && lines.includes('PreToolUse:second'), JSON.stringify(lines))
    check('a PostToolUse denial is feedback, not a skip',
      lines.includes('PostToolUse:first') && lines.includes('PostToolUse:second'), JSON.stringify(lines))
    check('both Stop hooks run after the first denies once',
      lines.includes('Stop:first') && lines.includes('Stop:second'), JSON.stringify(lines))
    check('both SessionEnd hooks run', lines.includes('SessionEnd:first') && lines.includes('SessionEnd:second'), JSON.stringify(lines))
  }
}

if (checks.length === 0) {
  console.error('S12: no checks ran')
  process.exit(1)
}
const report = {
  pin: { claude: CLAUDE_PIN, backend: 'deepseek/anthropic', harness: process.env.DSH_HARNESS_VERSION ?? null },
  checks,
  runs: summaries,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exit(1)
