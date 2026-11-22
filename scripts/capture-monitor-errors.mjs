#!/usr/bin/env node
/**
 * Capture the pinned client's own error text for the monitor-declaration
 * shapes the dialect validates.
 *
 * Each shape is a throwaway plugin directory handed to
 * `claude --plugin-dir <dir> plugin list`; no model call is made. The client
 * prints one of two lines:
 *
 *   - a file-shaped violation:  `Error: monitors load failed from <plugin>: …`
 *   - a manifest-shaped one:    `❯ inline[0]: ✘ Failed to load plugin: …`
 *
 * We keep that line, scrub the temporary plugin path to `<plugin>`, and write
 * it to `fixtures/claude-monitors-errors/observed/<shape>.txt`. The dialect's
 * `MONITOR_CLIENT_TEXT` table quotes those captured strings, so a pin bump
 * shows up as a reviewable diff here instead of as invented text in a reason.
 *
 * The raw plugin trees live under `fixtures/claude-monitors-errors/captured/`
 * (gitignored, AGENTS.md §8). Review the observed diff and commit it.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const fixtureRoot = join(root, 'fixtures', 'claude-monitors-errors')
const rawRoot = join(fixtureRoot, 'captured')
const observedRoot = join(fixtureRoot, 'observed')

const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim()
if (!CLAUDE_BIN) {
  console.error('capture-monitor-errors: CLAUDE_BIN must name the pinned claude executable')
  process.exit(2)
}

const VALID = {
  name: 'beat',
  command: 'node monitor.mjs',
  description: 'Emit a heartbeat.',
}

const json = (value) => JSON.stringify(value)
const file = (monitors) => ({ 'monitors/monitors.json': json(monitors) })

/**
 * Every shape in one place: file-shaped violations (plugin loads with an
 * error) and manifest-shaped ones (plugin never loads). `dirs` are created
 * after the files, so a directory can stand where a declaration file is
 * expected; `chmod` makes an existing file unreadable.
 */
const SHAPES = [
  { name: 'file-unknown-key', files: file([{ ...VALID, trigger: 'always' }]) },
  { name: 'file-when-enum', files: file([{ ...VALID, when: 'sometimes' }]) },
  { name: 'file-when-short', files: file([{ ...VALID, when: 'on-skill-invoke:' }]) },
  { name: 'file-when-number', files: file([{ ...VALID, when: 3 }]) },
  { name: 'file-top-object', files: { 'monitors/monitors.json': '{}' } },
  { name: 'file-top-null', files: { 'monitors/monitors.json': 'null' } },
  { name: 'file-null-entry', files: file([null]) },
  { name: 'file-invalid-json', files: { 'monitors/monitors.json': '[{' } },
  { name: 'file-duplicate', files: file([VALID, { ...VALID, description: 'second' }]) },
  { name: 'file-empty-name', files: file([{ ...VALID, name: '' }]) },
  { name: 'file-missing-description', files: file([{ name: 'beat', command: 'node monitor.mjs' }]) },
  { name: 'file-is-directory', dirs: ['monitors/monitors.json'] },
  {
    name: 'file-unreadable',
    files: file([VALID]),
    chmod: ['monitors/monitors.json'],
  },
  {
    name: 'path-missing',
    manifest: { monitors: './monitors/gone.json' },
  },
  {
    name: 'path-is-directory',
    manifest: { monitors: './monitors/target.json' },
    dirs: ['monitors/target.json'],
  },
  {
    name: 'path-unreadable',
    manifest: { monitors: './monitors/locked.json' },
    files: { 'monitors/locked.json': json([VALID]) },
    chmod: ['monitors/locked.json'],
  },
  {
    name: 'path-bad-content',
    manifest: { monitors: './monitors/custom.json' },
    files: { 'monitors/custom.json': json([{ ...VALID, trigger: 'always' }]) },
  },
  {
    name: 'path-duplicate',
    manifest: { monitors: './monitors/custom.json' },
    files: { 'monitors/custom.json': json([VALID, { ...VALID, description: 'second' }]) },
  },
  { name: 'manifest-unknown-key', manifest: { monitors: [{ ...VALID, trigger: 'always' }] } },
  { name: 'manifest-when-enum', manifest: { monitors: [{ ...VALID, when: 'sometimes' }] } },
  { name: 'manifest-when-number', manifest: { monitors: [{ ...VALID, when: 3 }] } },
  {
    name: 'manifest-missing-description',
    manifest: { monitors: [{ name: 'beat', command: 'node monitor.mjs' }] },
  },
  { name: 'manifest-nonstring-name', manifest: { monitors: [{ ...VALID, name: 7 }] } },
  { name: 'manifest-empty-command', manifest: { monitors: [{ ...VALID, command: '' }] } },
  { name: 'manifest-null-entry', manifest: { monitors: [null] } },
  {
    name: 'manifest-duplicate',
    manifest: { monitors: [VALID, { ...VALID, description: 'second' }] },
  },
  { name: 'manifest-path-not-relative', manifest: { monitors: 'monitors/monitors.json' } },
  { name: 'manifest-value-number', manifest: { monitors: 3 } },
  { name: 'manifest-value-null', manifest: { monitors: null } },
]

rmSync(rawRoot, { recursive: true, force: true })
mkdirSync(observedRoot, { recursive: true })
mkdirSync(join(rawRoot, 'home', '.claude'), { recursive: true })

const env = {
  ...process.env,
  HOME: join(rawRoot, 'home'),
  CLAUDE_CONFIG_DIR: join(rawRoot, 'home', '.claude'),
}

let failures = 0
for (const shape of SHAPES) {
  const dir = join(rawRoot, shape.name)
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: shape.name, version: '0.0.1', ...shape.manifest }),
  )
  for (const [path, text] of Object.entries(shape.files ?? {})) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  for (const path of shape.dirs ?? []) mkdirSync(join(dir, path), { recursive: true })
  for (const path of shape.chmod ?? []) chmodSync(join(dir, path), 0o000)

  const run = spawnSync(CLAUDE_BIN, ['--plugin-dir', dir, 'plugin', 'list'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const output = `${run.stdout}${run.stderr}`
  const lines = output.split('\n').map((candidate) => candidate.trim())
  // `./"` path-shaped declarations are still file-shaped: the plugin loads
  // with an error even though the value lives in the manifest. Classify by
  // the line the client printed, not by where the declaration lives.
  const line =
    lines.find((candidate) => candidate.startsWith('Error: monitors load failed')) ??
    lines.find((candidate) => candidate.includes('Failed to load plugin'))
  if (!line) {
    failures += 1
    console.error(`no client error line for ${shape.name} (exit ${run.status})`)
    console.error(output)
    continue
  }
  const scrubbed = line.split(dir).join('<plugin>')
  writeFileSync(join(observedRoot, `${shape.name}.txt`), `${scrubbed}\n`)
  console.log(`${shape.name}: ${scrubbed}`)
}

if (failures > 0) {
  console.error(`capture-monitor-errors: ${failures} shape(s) produced no error line`)
  process.exit(1)
}
