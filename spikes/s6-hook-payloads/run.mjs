#!/usr/bin/env node
// Spike S6: what does Claude Code 2.1.322 actually put on a hook's stdin?
// The answer becomes fixtures/hooks/payloads/*.json (see docs/TODO.md).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NODE = process.execPath
const root = mkdtempSync(join(tmpdir(), 'anyplugin-s6-'))
const plugin = join(root, 'probe-plugin')
const capture = join(root, 'capture')
const isolated = process.argv.includes('--isolated')
if (isolated) { mkdirSync(join(root, 'home', '.claude'), { recursive: true }) }
mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
mkdirSync(join(plugin, 'hooks'), { recursive: true })
mkdirSync(capture, { recursive: true })

writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 'hook-probe',
  description: 'records hook stdin (spike S6)',
  version: '0.0.0',
}, null, 2))

const hook = (label, matcher) => {
  const entry = { type: 'command', command: `"${NODE}" "${join(plugin, 'echo-hook.mjs')}" ${label}` }
  return matcher ? { matcher, hooks: [entry] } : { hooks: [entry] }
}

writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({
  hooks: {
    SessionStart: [hook('SessionStart')],
    UserPromptSubmit: [hook('UserPromptSubmit')],
    PreToolUse: [hook('PreToolUse', 'Bash')],
    PostToolUse: [hook('PostToolUse', 'Bash')],
    Stop: [hook('Stop')],
    SessionEnd: [hook('SessionEnd')],
  },
}, null, 2))
writeFileSync(join(plugin, 'echo-hook.mjs'), readFileSync(new URL('./echo-hook.mjs', import.meta.url)))

const prompt = 'Run this exact bash command and nothing else: echo hook-probe'
const args = ['--plugin-dir', plugin, '-p', prompt, '--allowedTools', 'Bash', '--output-format', 'json']

console.log('temp root:', root)
console.log('running: claude', args.join(' '))

const child = spawn('claude', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ANYPLUGIN_CAPTURE_DIR: capture, ...(isolated ? { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'home', '.claude') } : {}) },
})
let out = ''
let err = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { err += d })
const timer = setTimeout(() => { console.error('timeout: killing claude'); child.kill('SIGKILL') }, 180_000)

child.on('close', (code, signal) => {
  clearTimeout(timer)
  console.log(`\nexit=${code} signal=${signal ?? '-'}`)
  if (err.trim()) console.log('\n--- stderr ---\n' + err.trim().slice(0, 2000))
  console.log('\n--- stdout ---\n' + out.trim().slice(0, 2000))

  const files = existsSync(capture) ? readdirSync(capture) : []
  console.log('\ncaptured:', files.length ? files.join(', ') : '(none)')
  for (const file of files) {
    const lines = readFileSync(join(capture, file), 'utf8').trim().split('\n').filter(Boolean)
    console.log(`\n===== ${file} (${lines.length}) =====`)
    for (const line of lines) console.log(JSON.stringify(JSON.parse(line).payload, null, 2))
  }
  writeFileSync(new URL('./out/last-run.json', import.meta.url), JSON.stringify({ root, code, out, err, files }, null, 2))
})
