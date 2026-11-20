#!/usr/bin/env node
/**
 * Re-capture every fixture's golden inventory from the installed upstream CLI.
 * Run this when the pin moves, then review the JSON diff like any other code.
 */
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const fixturesDir = join(root, 'fixtures')
const rig = join(root, 'packages/dsh-anyplugin-conformance/src/rig.ts')

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

const entries = await readdir(fixturesDir)
let failures = 0
for (const entry of entries.sort()) {
  const dir = join(fixturesDir, entry)
  if (!(await stat(dir)).isDirectory() || entry.startsWith('.')) continue
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
