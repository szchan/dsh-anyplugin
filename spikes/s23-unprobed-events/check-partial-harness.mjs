#!/usr/bin/env node
// S23 incomplete-harness check. A tree the operator named must be validated as
// the only tree (D24): no silent fallback to DSH_INSTALL_DIR, every missing
// package named, exit 2 for both the required-package and probe-package shapes.
// The child runs with a matching DSH_INSTALL_DIR so a fallback would show up as
// the green 22/22 exit 0 instead of the expected failure.
//
// Usage:
//   DSH_HARNESS_DIR=/path/to/.harness/0.2.2-rc.5 \
//     node spikes/s23-unprobed-events/check-partial-harness.mjs
//
// Exit 0 when both shapes fail correctly; 1 otherwise.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPIKE = join(HERE, 'run.mjs')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'
const REQUIRED_CASE = 'dsh-session'
const EXTRA_CASE = 'dsh-subagent-fork-in-process'

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

function makePartial(except) {
  const partial = mkdtempSync(join(tmpdir(), 's23-partial-'))
  const target = join(partial, 'node_modules', '@deepseek-ai')
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(packages)) {
    if (entry === except) continue
    symlinkSync(join(packages, entry), join(target, entry), 'dir')
  }
  return partial
}

function run(partial) {
  return spawnSync(process.execPath, [SPIKE], {
    cwd: resolve(HERE, '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HARNESS_DIR: partial,
      DSH_HARNESS_VERSION: VERSION,
      // A matching full tree: if the spike falls back, it exits 0 with 22/22.
      DSH_INSTALL_DIR: source,
    },
  })
}

let failed = false
function report(label, result, wanted) {
  const ok = result.status === 2
    && wanted.every((needle) => result.stderr.includes(needle))
    && !result.stdout.includes('checks passed')
  if (ok) {
    console.log(`PASS  ${label} exits 2 and names the missing package(s)`)
    for (const line of result.stderr.trim().split('\n')) console.log(`      stderr: ${line}`)
  } else {
    failed = true
    console.error(`FAIL  ${label} did not fail as an incomplete harness`)
    console.error(`      exit=${result.status} (wanted 2)`)
    console.error(`      stderr=${JSON.stringify(result.stderr)}`)
    console.error(`      stdout tail=${JSON.stringify(result.stdout.split('\n').slice(-4).join('\n'))}`)
  }
}

const requiredTree = makePartial(REQUIRED_CASE)
const requiredResult = run(requiredTree)
rmSync(requiredTree, { recursive: true, force: true })
report(`named tree missing ${REQUIRED_CASE}`, requiredResult, ['no usable harness', REQUIRED_CASE, 'never replaced by DSH_INSTALL_DIR'])

const extraTree = makePartial(EXTRA_CASE)
const extraResult = run(extraTree)
rmSync(extraTree, { recursive: true, force: true })
report(`named tree missing ${EXTRA_CASE}`, extraResult, ['harness incomplete', EXTRA_CASE])

process.exit(failed ? 1 : 0)
