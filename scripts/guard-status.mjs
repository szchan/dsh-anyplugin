#!/usr/bin/env node
// What is installed, and is it still what the tree would write?
//
// `guard:status` is a read: it never writes the profile. It compares the
// managed block with a freshly composed one and exits 1 when the guard is
// absent, stale, or points at a source file that no longer exists — the three
// ways an install silently stops guarding.
//
//   npm run guard:status [-- --profile-dir <dir>] [--json]

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PATCH_FILE,
  composeGuard,
  defaultProfileDir,
  readBlock,
  readGitWorktrees,
} from '../packages/dsh-anyplugin-guard/src/composition.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const json = argv.includes('--json')

function usage(message) {
  if (message !== undefined) console.error(`guard:status: ${message}`)
  else console.log('usage: guard:status [--profile-dir <dir>] [--json]')
  process.exit(message === undefined ? 0 : 2)
}

let profileDir
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--help' || arg === '-h') usage()
  else if (arg === '--json') continue
  else if (arg === '--profile-dir') {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usage('--profile-dir needs a value')
    profileDir = resolve(value)
    index += 1
  } else usage(`unknown argument ${arg}`)
}
profileDir = profileDir ?? resolve(defaultProfileDir())
const patchFile = join(profileDir, PATCH_FILE)

/** The first line that differs, for a status that says *what* moved. */
function firstDifference(installed, current) {
  const left = installed.split('\n')
  const right = current.split('\n')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return { line: index + 1, installed: left[index] ?? '<end of file>', current: right[index] ?? '<end of file>'}
    }
  }
  return undefined
}

const composition = composeGuard({ repoRoot: root, worktrees: readGitWorktrees(root) })
const sourceExists = existsSync(composition.source)
const fileExists = existsSync(patchFile)
const text = fileExists ? readFileSync(patchFile, 'utf8') : ''
const installed = readBlock(text)
const difference = installed.present ? firstDifference(installed.block, composition.block) : undefined
const current = installed.present && difference === undefined
const status = !installed.present ? 'not-installed' : current ? 'current' : 'stale'

const report = {
  profileDir,
  patchFile,
  status,
  source: composition.source,
  sourceExists,
  worktrees: composition.config.worktrees ?? [],
  protectedRoots: composition.config.protectedRoots ?? [],
  ...(difference === undefined ? {} : { difference }),
}

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`guard: profile ${profileDir}`)
  console.log(`guard: patch   ${patchFile}${fileExists ? '' : ' (missing)'}`)
  console.log(`guard: status  ${status}`)
  console.log(`guard: source  ${composition.source}${sourceExists ? '' : ' (missing)'}`)
  console.log(`guard: worktrees ${report.worktrees.length === 0 ? 'none' : report.worktrees.join(', ')}`)
  console.log(`guard: protected ${report.protectedRoots.length === 0 ? 'none' : report.protectedRoots.join(', ')}`)
  if (difference !== undefined) {
    console.log(`guard: first difference at line ${difference.line}`)
    console.log(`  installed: ${difference.installed}`)
    console.log(`  current:   ${difference.current}`)
    console.log('guard: run `npm run guard:install` to rewrite the block')
  }
  if (status === 'current') console.log('guard: the block is what this tree would write; the host applies it when the profile recomposes')
}

process.exit(status === 'current' && sourceExists ? 0 : 1)
