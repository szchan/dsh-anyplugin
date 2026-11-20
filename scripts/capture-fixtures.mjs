#!/usr/bin/env node
/**
 * Re-capture every fixture's golden inventory from the installed upstream CLI.
 * Run this when the pin moves, then review the JSON diff like any other code.
 */
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { HAND_AUTHORED_FIXTURES } from './hand-authored-fixtures.mjs'

const root = new URL('..', import.meta.url).pathname
const rig = join(root, 'packages/dsh-anyplugin-conformance/src/rig.ts')

/**
 * `--fixtures-dir <dir>` makes the command hermetically testable (and usable on
 * a fixture tree outside the checkout); positional names narrow the run to
 * specific fixtures. The default is every fixture in this checkout.
 */
const args = process.argv.slice(2)
let fixturesDir = join(root, 'fixtures')
const only = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--fixtures-dir') {
    const value = args[++i]
    if (!value) {
      console.error('capture-fixtures: --fixtures-dir needs a directory')
      process.exit(2)
    }
    fixturesDir = resolve(value)
  } else if (arg.startsWith('-')) {
    console.error(`capture-fixtures: unknown option ${arg}`)
    process.exit(2)
  } else {
    only.push(arg)
  }
}

/**
 * The portable/Codex fixture has no upstream oracle to capture from (there is
 * no offline `codex plugin details`), so its golden is hand-authored and this
 * script must not overwrite it with a Claude probe. This mirrors the rig's
 * dialect detection: a Claude manifest wins, otherwise a root `plugin.json` or
 * the `.codex-plugin/plugin.json` fallback is the Codex dialect. Claude's own
 * goldens stay byte-identical because every `claude-*` fixture is captured
 * exactly as before.
 */
function portableFixture(dir) {
  if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return false
  return existsSync(join(dir, 'plugin.json')) || existsSync(join(dir, '.codex-plugin', 'plugin.json'))
}

/** A fixture directory is a plugin only when it has a component location. */
function pluginLike(dir) {
  return [
    '.claude-plugin/plugin.json',
    'plugin.json',
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'SKILL.md',
    'skills',
    'commands',
    'agents',
    'hooks/hooks.json',
  ].some((path) => existsSync(join(dir, path)))
}

const allEntries = (await readdir(fixturesDir)).sort()
for (const name of only) {
  if (!allEntries.includes(name)) {
    console.error(`capture-fixtures: ${name} is not in ${fixturesDir}`)
    process.exit(2)
  }
}
const entries = only.length === 0 ? allEntries : allEntries.filter((entry) => only.includes(entry))
let failures = 0
for (const entry of entries) {
  const dir = join(fixturesDir, entry)
  if (!(await stat(dir)).isDirectory() || entry.startsWith('.')) continue
  if (HAND_AUTHORED_FIXTURES.has(entry)) {
    console.log(`${entry}: skipped (hand-authored fixture; ${HAND_AUTHORED_FIXTURES.get(entry)})`)
    continue
  }
  if (!pluginLike(dir)) {
    console.log(`${entry}: skipped (not a plugin fixture; no manifest or component location)`)
    continue
  }
  if (portableFixture(dir)) {
    console.log(`${entry}: skipped (portable/Codex fixture; golden is hand-authored, no upstream oracle)`)
    continue
  }
  const result = spawnSync(process.execPath, [rig, 'capture', '--plugin', dir], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures += 1
    console.error(`FAIL ${entry}: ${(result.stderr || result.stdout).trim()}`)
    continue
  }
  console.log(`${entry}: ${result.stdout.trim()}`)
}
process.exitCode = failures === 0 ? 0 : 1
