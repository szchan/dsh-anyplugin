#!/usr/bin/env node
// What is installed, and is it still what the tree would write?
//
// `guard:status` is a read: it never writes the profile. It compares the
// managed block with a freshly composed one and exits 1 when the guard is
// absent, stale, lists a worktree that no longer exists, or points at a source
// file that no longer exists — the ways an install silently stops guarding.
//
// It always composes the main checkout, even when run from a linked worktree:
// the block names the main checkout (issue #166), so that is what it must be
// compared with.
//
//   npm run guard:status [-- --profile-dir <dir>] [--json]

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PATCH_FILE,
  composeGuard,
  defaultProfileDir,
  duplicateGuardId,
  mainCheckout,
  readBlock,
  readGitWorktrees,
  readWorktrees,
} from '../packages/dsh-anyplugin-guard/src/composition.ts'
import { isWorktreeGlob } from '../packages/dsh-anyplugin-guard/src/policy.ts'
import { configuredHooksPath, hookTargets, prePushStatus } from './guard-hooks.mjs'

const scriptRoot = fileURLToPath(new URL('..', import.meta.url))
const root = mainCheckout(scriptRoot) ?? resolve(scriptRoot)
const argv = process.argv.slice(2)
const json = argv.includes('--json')

function usage(message) {
  if (message !== undefined) console.error(`guard:status: ${message}`)
  else console.log('usage: guard:status [--profile-dir <dir>] [--worktree <path>] [--json]')
  process.exit(message === undefined ? 0 : 2)
}

let profileDir
const extraWorktrees = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--help' || arg === '-h') usage()
  else if (arg === '--json') continue
  else if (arg === '--profile-dir') {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usage('--profile-dir needs a value')
    profileDir = resolve(value)
    index += 1
  } else if (arg === '--worktree') {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usage('--worktree needs a value')
    extraWorktrees.push({ path: resolve(value), branch: 'ticket/manual', main: false })
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

const gitWorktrees = readGitWorktrees(root)
const known = new Set(gitWorktrees.map((entry) => resolve(entry.path)))
const worktrees = [...gitWorktrees, ...extraWorktrees.filter((entry) => !known.has(resolve(entry.path)))]
const fileExists = existsSync(patchFile)
const text = fileExists ? readFileSync(patchFile, 'utf8') : ''
let installed
try {
  installed = readBlock(text)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message.startsWith('guard:') ? message : `guard:status: ${message}`)
  process.exit(1)
}
// A pattern in the block is the policy's matcher, not a discovered path:
// reusing it keeps the block current as ticket worktrees come and go. A
// literal path that is gone, by contrast, is invisible in a diff — the live
// list no longer contains it — so it is reported by name instead.
const listedWorktrees = installed.present ? readWorktrees(installed.block) : []
const listedGlob = listedWorktrees.find((entry) => isWorktreeGlob(entry))
const stalePaths = listedWorktrees.filter((entry) => !isWorktreeGlob(entry) && !existsSync(entry))
let composition
try {
  composition = composeGuard({
    repoRoot: root,
    worktrees,
    ...(extraWorktrees[0] === undefined ? {} : { preferredWorktree: extraWorktrees[0].path }),
    ...(listedGlob === undefined ? {} : { worktreeGlob: listedGlob }),
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const reason = message.startsWith('guard:') ? message : `guard:status: ${message}`
  if (json) {
    console.log(JSON.stringify({ profileDir, patchFile, status: 'refused', reason }, null, 2))
  } else {
    console.log(`guard: profile ${profileDir}`)
    console.log(`guard: patch   ${patchFile}${fileExists ? '' : ' (missing)'}`)
    console.log('guard: status  refused')
    console.error(reason)
  }
  process.exit(1)
}
const sourceExists = existsSync(composition.source)
// The state line records what the file looked like before install; it is not
// part of what the tree composes, so it is ignored when comparing.
const comparable = (block) => block.split('\n').filter((line) => !line.startsWith('# dsh-anyplugin guard state:')).join('\n')
const difference = installed.present ? firstDifference(comparable(installed.block), composition.block) : undefined
// A duplicate `- id:` outside the block is a second entry, not a stale one.
const outside = installed.present ? text.replace(installed.block, '') : text
const duplicate = duplicateGuardId(outside)
// The hook lives in the repository hooks directory, shared by every worktree;
// check it even when no ticket worktree was composed, so an empty list cannot
// pass vacuously.
const hooks = hookTargets(gitWorktrees.map((worktree) => worktree.path))
const hookStates = hooks.map((entry) => ({ file: entry.file, status: prePushStatus(entry.file) }))
const hooksCurrent = hookStates.length > 0 && hookStates.every((entry) => entry.status === 'current')
const hooksPath = configuredHooksPath(root)
const hookLocation = hookStates[0]?.file ?? 'no repository'
const hookNote =
  hooksPath !== undefined
    ? `core.hooksPath=${hooksPath} moves the hook outside the checkout; git looks there, and deleting that config orphans it`
    : (composition.config.worktrees ?? []).length === 0
      ? `no ticket worktrees configured; hook ${prePushStatus(hookLocation) === 'missing' ? 'expected' : 'installed'} at ${hookLocation}`
      : undefined
const current = installed.present && difference === undefined && !duplicate
const status = !installed.present
  ? 'not-installed'
  : stalePaths.length > 0
    ? 'installed-with-stale-paths'
    : current && hooksCurrent
      ? 'current'
      : 'stale'

const report = {
  profileDir,
  patchFile,
  status,
  source: composition.source,
  sourceExists,
  worktrees: composition.config.worktrees ?? [],
  installedWorktrees: listedWorktrees,
  stalePaths,
  protectedRoots: composition.config.protectedRoots ?? [],
  duplicateId: duplicate,
  hooks: hookStates,
  ...(hooksPath === undefined ? {} : { hooksPath }),
  ...(hookNote === undefined ? {} : { hookNote }),
  ...(difference === undefined ? {} : { difference }),
}

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`guard: profile ${profileDir}`)
  console.log(`guard: patch   ${patchFile}${fileExists ? '' : ' (missing)'}`)
  console.log(`guard: status  ${status}`)
  console.log(`guard: source  ${composition.source}${sourceExists ? '' : ' (missing)'}`)
  console.log(`guard: worktrees ${report.worktrees.length === 0 ? 'none' : report.worktrees.join(', ')} (desired)`)
  console.log(`guard: installed worktrees ${listedWorktrees.length === 0 ? 'none' : listedWorktrees.join(', ')}`)
  for (const path of stalePaths) {
    console.log(`guard: stale worktree ${path} (listed in the block, no longer exists)`)
  }
  console.log(`guard: protected ${report.protectedRoots.length === 0 ? 'none' : report.protectedRoots.join(', ')}`)
  for (const hook of hookStates) console.log(`guard: hook ${hook.file} ${hook.status}`)
  if (hookNote !== undefined) console.log(`guard: ${hookNote}`)
  if (duplicate) console.log('guard: duplicate - id: "anyplugin-guard" outside the managed block; remove it first')
  if (difference !== undefined) {
    console.log(`guard: first difference at line ${difference.line}`)
    console.log(`  installed: ${difference.installed}`)
    console.log(`  current:   ${difference.current}`)
    console.log('guard: run `npm run guard:install` to rewrite the block')
  }
  if (status === 'installed-with-stale-paths') {
    console.log('guard: run `npm run guard:install` to drop the stale paths and rewrite the block')
  }
  if (status === 'current') console.log('guard: the block is what this tree would write; the host applies it when the profile recomposes')
}

process.exit(status === 'current' && sourceExists && hooksCurrent && !duplicate ? 0 : 1)
