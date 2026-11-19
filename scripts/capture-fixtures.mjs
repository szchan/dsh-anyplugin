#!/usr/bin/env node
/**
 * Re-capture every fixture's golden inventory from the installed upstream CLI.
 * Run this when the pin moves, then review the JSON diff like any other code.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const fixturesDir = join(root, 'fixtures')
const rig = join(root, 'packages/dsh-anyplugin-conformance/src/rig.ts')

const entries = await readdir(fixturesDir)
let failures = 0
for (const entry of entries.sort()) {
  const dir = join(fixturesDir, entry)
  if (!(await stat(dir)).isDirectory() || entry.startsWith('.')) continue
  const result = spawnSync(process.execPath, [rig, 'capture', '--plugin', dir], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures += 1
    console.error(`FAIL ${entry}: ${(result.stderr || result.stdout).trim()}`)
    continue
  }
  console.log(`${entry}: ${result.stdout.trim()}`)
}
process.exitCode = failures === 0 ? 0 : 1
