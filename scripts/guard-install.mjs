#!/usr/bin/env node
// Write the guard composition into a DSH profile's `cordis.patch.yml`.
//
// The profile's patch file is DSH's, not ours (D23): we do not write it at
// runtime, and the loader stays the only reader. This script is the one
// writer, it prints every byte it would write, and `--dry-run` proves the
// payload → verdict table without touching the file.
//
// The entry is an `insert` list because a patch that only names an `id`
// overrides an existing entry; only `insert` adds one.
//
//   npm run guard:install                 # write the block into $DSH_PROFILE_DIR
//   npm run guard:install -- --dry-run    # print the block + verdict table
//   npm run guard:install -- --uninstall  # remove the block
//   npm run guard:install -- --profile-dir <dir> --worktree <path>
//
// `--profile-dir` defaults to DSH_PROFILE_DIR, then $DSH_HOME/profiles/$DSH_PROFILE.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BLOCK_END,
  BLOCK_START,
  PATCH_FILE,
  applyBlock,
  captureState,
  composeGuard,
  defaultProfileDir,
  formatTable,
  guardTable,
  readBlock,
  readGitWorktrees,
  readState,
  renderBlock,
  runTable,
  uninstallText,
} from '../packages/dsh-anyplugin-guard/src/composition.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)

function usage(message) {
  if (message !== undefined) console.error(`guard:install: ${message}`)
  else console.log('usage: guard:install [--dry-run] [--uninstall] [--profile-dir <dir>] [--worktree <path>]')
  process.exit(message === undefined ? 0 : 2)
}

const options = { dryRun: false, uninstall: false, profileDir: undefined, worktrees: [] }
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--help' || arg === '-h') usage()
  else if (arg === '--dry-run') options.dryRun = true
  else if (arg === '--uninstall') options.uninstall = true
  else if (arg === '--profile-dir' || arg === '--worktree') {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`)
    if (arg === '--profile-dir') options.profileDir = resolve(value)
    else options.worktrees.push({ path: resolve(value), branch: 'ticket/manual', main: false })
    index += 1
  } else usage(`unknown argument ${arg}`)
}
if (options.dryRun && options.uninstall) usage('--dry-run and --uninstall are different questions')

const profileDir = options.profileDir ?? resolve(defaultProfileDir())
const patchFile = join(profileDir, PATCH_FILE)

function printError(error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message.startsWith('guard:') ? message : `guard: ${message}`)
}

function writeAtomically(file, content) {
  const temporary = `${file}.guard.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, file)
}

console.log(`guard: profile ${profileDir}`)
console.log(`guard: patch   ${patchFile}`)

if (options.uninstall) {
  if (!existsSync(patchFile)) {
    console.log('guard: not installed (no patch file); nothing to remove')
    process.exit(0)
  }
  const existing = readFileSync(patchFile, 'utf8')
  let outcome
  try {
    outcome = uninstallText(existing)
  } catch (error) {
    printError(error)
    process.exit(1)
  }
  if (outcome.action === 'delete') {
    unlinkSync(patchFile)
    console.log('guard: removed the managed block and the patch file it created; the profile is as it was before install')
    process.exit(0)
  }
  writeAtomically(patchFile, outcome.content)
  console.log(
    `guard: removed the managed block (${existing.length - outcome.content.length} bytes); ` +
      'the rest of the file is byte-for-byte what the block found',
  )
  process.exit(0)
}

const worktrees = [...readGitWorktrees(root), ...options.worktrees]
const composition = composeGuard({ repoRoot: root, worktrees })
const ticketWorktrees = composition.config.worktrees ?? []
if (ticketWorktrees.length === 0) {
  console.error('guard: no ticket worktree found (branch ticket/*); create one with `git worktree add`, or pass --worktree <path>')
  process.exit(1)
}
if (!existsSync(composition.source)) {
  console.error(`guard: source ${composition.source} does not exist; install the guard from a complete checkout`)
  process.exit(1)
}
const protectedRoot = composition.config.protectedRoots?.[0] ?? root
const tableWorktree = ticketWorktrees.includes(resolve(root)) ? resolve(root) : ticketWorktrees[0]

console.log(`guard: worktrees ${ticketWorktrees.length} ticket worktree(s); protected root ${protectedRoot}`)
const existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : undefined
let installedState
let compositionBlock
try {
  const current = existing === undefined ? { present: false, block: '' } : readBlock(existing)
  installedState = current.present ? (readState(current.block) ?? captureState(existing)) : captureState(existing)
  compositionBlock = renderBlock(composition.source, composition.config, installedState)
} catch (error) {
  printError(error)
  process.exit(1)
}
console.log(`guard: composition (${composition.source})`)
process.stdout.write(compositionBlock)
console.log('guard: end composition')

const cases = guardTable({ worktree: tableWorktree, protectedRoot })
const { rows, failures } = runTable(cases, composition.config, { worktree: tableWorktree, protectedRoot })
console.log(`guard: verdict table (${rows.length} payloads, judged by the same policy the plugin runs)`)
console.log(formatTable(rows))
for (const failure of failures) {
  console.error(`guard: MISMATCH ${failure.tool} ${failure.payload}`)
  console.error(`  expected ${failure.expect} ${failure.rule}; got ${failure.actual} ${failure.actualRule}`)
  if (failure.reason !== undefined) console.error(`  ${failure.reason}`)
}
console.log(`guard: ${rows.length - failures.length}/${rows.length} payloads match`)

if (failures.length > 0) {
  console.error('guard: the policy and the table disagree; nothing written')
  process.exit(1)
}

if (options.dryRun) {
  console.log('guard: dry run; the profile was not touched')
  process.exit(0)
}
if (!existsSync(profileDir)) {
  console.error(`guard: profile directory ${profileDir} does not exist; pass --profile-dir`)
  process.exit(1)
}
const before = existing ?? ''
let next
try {
  next = applyBlock(before, compositionBlock)
} catch (error) {
  printError(error)
  process.exit(1)
}
if (next === before && existing !== undefined) {
  console.log(`guard: already installed and current in ${patchFile}`)
  process.exit(0)
}
writeAtomically(patchFile, next)
console.log(`guard: wrote ${patchFile} (${next.length} bytes, one ${BLOCK_START} … ${BLOCK_END} block)`)
console.log('guard: the profile applies the block when it next recomposes; `npm run guard:status` compares it with the tree')
