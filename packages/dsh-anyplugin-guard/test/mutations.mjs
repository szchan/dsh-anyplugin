#!/usr/bin/env node
/**
 * The guard's mutations, as a runnable audit rather than a claim in a PR.
 *
 * Each entry breaks exactly one property the tests assert, runs the one test
 * that names that property, and requires the run to fail on that test. A
 * mutation that stays green means the test is not proving the property.
 *
 *   node packages/dsh-anyplugin-guard/test/mutations.mjs
 *
 * Deliberately not `*.test.mjs`: it mutates the working tree, so it must not
 * run inside `npm test`. Every file is restored in `finally`.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TEST = join(REPO, 'packages/dsh-anyplugin-guard/test/guard.test.mjs')

function replaceOnce(text, find, replacement) {
  const index = text.indexOf(find)
  if (index === -1) throw new Error(`mutation anchor not found: ${find.slice(0, 60)}`)
  if (text.indexOf(find, index + 1) !== -1) throw new Error(`mutation anchor is not unique: ${find.slice(0, 60)}`)
  return text.slice(0, index) + replacement + text.slice(index + find.length)
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const MUTANTS = [
  {
    name: 'compose from the worktree the install ran in',
    file: 'scripts/guard-install.mjs',
    find: 'const root = mainCheckout(invocationRoot) ?? invocationRoot',
    replacement: 'const root = invocationRoot',
    test: 'a dry run from a linked worktree composes from the main checkout, not from itself',
  },
  {
    name: 'cut the pattern at the common prefix instead of the last dash',
    file: 'packages/dsh-anyplugin-guard/src/composition.ts',
    find: "const stem = prefix.slice(0, prefix.lastIndexOf('-') + 1)",
    replacement: 'const stem = prefix',
    test: 'a worktree created after install writes without a reinstall, and the pattern stops at its parent',
  },
  {
    name: 'record the pattern as the worktree instead of the root it matched',
    file: 'packages/dsh-anyplugin-guard/src/brief.ts',
    find: 'const root = matchWorktree(entry, path)',
    replacement: "const root = entry.includes('*') ? entry : matchWorktree(entry, path)",
    test: 'a worktree created after install writes without a reinstall, and the pattern stops at its parent',
  },
  {
    name: 'never report a listed worktree as gone',
    file: 'scripts/guard-status.mjs',
    find: 'const stalePaths = listedWorktrees.filter((entry) => !isWorktreeGlob(entry) && !existsSync(entry))',
    replacement: 'const stalePaths = []',
    test: 'guard:status separates not-installed from a block that lists a worktree which is gone',
  },
]

let survived = 0
for (const mutant of MUTANTS) {
  const file = join(REPO, mutant.file)
  const original = readFileSync(file, 'utf8')
  try {
    writeFileSync(file, replaceOnce(original, mutant.find, mutant.replacement))
    const run = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern', escapePattern(mutant.test), TEST],
      { encoding: 'utf8' },
    )
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    const reddened = new RegExp(`not ok \\d+ - ${escapePattern(mutant.test)}`, 'u').test(output)
    if (run.status !== 0 && reddened) {
      console.log(`ok  ${mutant.name} -> reddened "${mutant.test}"`)
    } else {
      console.error(`SURVIVED  ${mutant.name} -> "${mutant.test}" ${run.status === 0 ? 'stayed green' : 'did not report a failure'}`)
      survived += 1
    }
  } finally {
    writeFileSync(file, original)
  }
}

if (survived > 0) {
  console.error(`${survived} mutation(s) survived; the named test is not proving the property`)
  process.exit(1)
}
console.log(`all ${MUTANTS.length} mutations reddened their named test`)
