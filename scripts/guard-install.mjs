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

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BLOCK_END,
  BLOCK_START,
  PATCH_FILE,
  applyBlock,
  composeGuard,
  defaultProfileDir,
  formatTable,
  guardTable,
  readGitWorktrees,
  runTable,
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
  const next = applyBlock(existing, null)
  if (next === existing) {
    console.log(`guard: not installed (no ${BLOCK_START} block); nothing to remove`)
    process.exit(0)
  }
  // An empty patch file is not a valid loader input; the marker for "no
  // entries" is the empty array, which is also what a fresh profile holds.
  const content = next.trim() === '' ? '[]\n' : next
  writeAtomically(patchFile, content)
  console.log(`guard: removed the managed block (${existing.length - content.length} bytes); the rest of the file is untouched`)
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
console.log(`guard: composition (${composition.source})`)
process.stdout.write(composition.block)
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
const existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
const next = applyBlock(existing, composition.block)
if (next === existing) {
  console.log(`guard: already installed and current in ${patchFile}`)
  process.exit(0)
}
writeAtomically(patchFile, next)
console.log(`guard: wrote ${patchFile} (${next.length} bytes, one ${BLOCK_START} … ${BLOCK_END} block)`)
console.log('guard: the profile applies the block when it next recomposes; `npm run guard:status` compares it with the tree')
