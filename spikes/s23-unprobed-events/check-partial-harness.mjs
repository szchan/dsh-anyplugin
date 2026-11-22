#!/usr/bin/env node
// S23 partial-harness check: a tree that is missing one required package must
// fail as an incomplete harness (exit 2, missing package named), not as an
// ordinary red run. This is the mutation the round-3 review asked to keep:
// symlink every package from the pinned tree except `dsh-subagent-fork-in-process`
// and run the spike against the partial tree.
//
// Usage:
//   DSH_HARNESS_DIR=/path/to/.harness/0.2.2-rc.5 \
//     node spikes/s23-unprobed-events/check-partial-harness.mjs
//
// Exit 0 when the spike exits 2 and names the missing package; 1 otherwise.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPIKE = join(HERE, 'run.mjs')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'
const MISSING = 'dsh-subagent-fork-in-process'

function harnessRoot() {
  const named = process.env.DSH_HARNESS_DIR?.trim()
  if (named !== undefined) return resolve(named)
  return resolve(HERE, '..', '..', '.harness', VERSION)
}

const source = harnessRoot()
const packages = join(source, 'node_modules', '@deepseek-ai')
if (!existsSync(packages)) {
  console.error(`check-partial: no @deepseek-ai tree under ${source}`)
  process.exit(2)
}
if (!existsSync(join(packages, MISSING, 'package.json'))) {
  console.error(`check-partial: the source tree already lacks ${MISSING}; cannot build the partial tree`)
  process.exit(2)
}

const partial = mkdtempSync(join(tmpdir(), 's23-partial-'))
const target = join(partial, 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })
for (const entry of readdirSync(packages)) {
  if (entry === MISSING) continue
  symlinkSync(join(packages, entry), join(target, entry), 'dir')
}

const result = spawnSync(process.execPath, [SPIKE], {
  cwd: resolve(HERE, '..', '..'),
  encoding: 'utf8',
  env: { ...process.env, DSH_HARNESS_DIR: partial, DSH_HARNESS_VERSION: VERSION },
})
rmSync(partial, { recursive: true, force: true })

const message = `s23: harness incomplete: missing ${MISSING}`
const ok = result.status === 2 && result.stderr.includes(message) && result.stdout.includes('0 checks ran')
if (ok) {
  console.log(`PASS  partial harness exits 2 and names ${MISSING}`)
  console.log(`      stderr: ${message}`)
  process.exit(0)
}
console.error('FAIL  partial harness did not fail as an incomplete harness')
console.error(`      exit=${result.status} (wanted 2)`)
console.error(`      stderr=${JSON.stringify(result.stderr)}`)
console.error(`      stdout tail=${JSON.stringify(result.stdout.split('\n').slice(-4).join('\n'))}`)
process.exit(1)
