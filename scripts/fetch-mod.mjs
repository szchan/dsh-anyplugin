#!/usr/bin/env node
/**
 * Fetch the pinned upstream mods under test into `.mods/<commit>/`.
 *
 * The conformance suite loads real authored mods from Claude Code 2.1.329 at
 * commit f9e4d1e. They are fetched here, explicitly, exactly like the harness
 * and CLI pins (D22, D24): tests never touch the network (AGENTS §6).
 *
 * The checkout is sparse: git fetches one commit and materializes only `mods/`.
 * That keeps the seven mods, their tests, and `mods/types/claude-code.d.ts` (the
 * specification the pin is measured against) together. The script prints
 * `.mods/<commit>`; a mod root is `.mods/<commit>/mods/<name>/hooks`, and the
 * diff test is pointed at `.mods/<commit>/mods/diff/hooks`.
 *
 * The pin is checked in two places: `UPSTREAM_MODS_PIN` in
 * `packages/dsh-anyplugin-mod-host/src/pin.ts` owns the commit, the upstream
 * git tree id, a SHA-256 of the whole materialized tree, and each entry's
 * hash; this script verifies the id, the tree hash, every entry and the diff
 * graph's S13 `.ts`/`.tsx` counts. A partial checkout, a moved commit or an
 * edited tree fails here, loudly, instead of changing what a test measures.
 *
 * Usage:
 *   node scripts/fetch-mod.mjs           # fetch (idempotent), print the mods root
 *   node scripts/fetch-mod.mjs --verify  # check an existing checkout, print it
 *   node scripts/fetch-mod.mjs --refresh # discard and fetch again
 *
 * Prints one absolute path on stdout and nothing else; diagnostics go to stderr.
 * The fetched tree is gitignored (`.mods/`, D14: no upstream source is vendored).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DIFF_MOD_PIN, UPSTREAM_MODS_PIN } from '../packages/dsh-anyplugin-mod-host/src/pin.ts'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const MODS_DIR = join(REPO_ROOT, '.mods')
const ROOT = join(MODS_DIR, UPSTREAM_MODS_PIN.commit)
const TREE = join(ROOT, UPSTREAM_MODS_PIN.directory)
const SCRATCH = join(MODS_DIR, `.scratch-${UPSTREAM_MODS_PIN.commit}`)
const ORIGIN = 'https://github.com/anthropics/claude-code.git'

const USAGE = `usage: node scripts/fetch-mod.mjs [--verify | --refresh]

Fetches ${UPSTREAM_MODS_PIN.directory}/ of claude-code at ${UPSTREAM_MODS_PIN.commit}
into .mods/${UPSTREAM_MODS_PIN.commit}/ and prints that absolute root. The pin
(commit, git tree id, tree sha256, entry hashes, .ts/.tsx counts) is checked in
packages/dsh-anyplugin-mod-host/src/pin.ts.

--verify  checks the existing checkout and prints it; it fetches nothing.
--refresh discards an existing checkout and fetches the pin again.

Idempotent: a valid existing checkout is reused after verification. An existing
checkout from the old diff-only layout (no mods/ directory) is replaced, because
it cannot satisfy the tree pin. The tests only read the tree; this script is the
only step that uses the network.
`

function die(message) {
  process.stderr.write(`fetch-mod: ${message}\n`)
  process.exit(1)
}

function toPosix(path) {
  return path.split(sep).join('/')
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * SHA-256 over a materialized tree: every file, in tree-relative POSIX path
 * order (code-unit, not locale), hashed as `<path>\0<size>\0<bytes>\0`.
 * Exported so the conformance test can recompute the fixture table's tree hash
 * without shelling out.
 */
export function treeSha256(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(root)
  const entries = files.map((file) => ({ file, rel: toPosix(relative(root, file)) }))
  entries.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0))

  const hash = createHash('sha256')
  for (const { file, rel } of entries) {
    const bytes = readFileSync(file)
    hash.update(rel)
    hash.update('\0')
    hash.update(String(bytes.length))
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Count `.ts` and `.tsx` files under `root`, ignoring dot directories. */
function countModules(root) {
  const counts = { ts: 0, tsx: 0 }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        if (entry.name.endsWith('.tsx')) counts.tsx += 1
        else if (entry.name.endsWith('.ts')) counts.ts += 1
      }
    }
  }
  walk(root)
  return counts
}

/**
 * Return why `root` is not the pinned materialized tree, or `null` when it is.
 * Kept non-fatal so a normal run can replace an old-layout checkout instead of
 * failing on it; `--verify` turns the returned reason into an error.
 */
function treeProblem(root) {
  const tree = join(root, UPSTREAM_MODS_PIN.directory)
  if (!existsSync(tree)) {
    return `${root} has no ${UPSTREAM_MODS_PIN.directory}/ directory; not the pinned mods tree`
  }

  // The mod set is part of the pin: a new upstream mod must fail a test, not
  // appear silently beside the table. `types/` is the API spec, not a mod.
  const present = readdirSync(tree, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'types')
    .map((entry) => entry.name)
    .sort()
  const expected = UPSTREAM_MODS_PIN.mods.map((mod) => mod.name).sort()
  if (present.join('\0') !== expected.join('\0')) {
    return (
      `${tree} has mods ${present.join(', ') || '(none)'}; the pin has ` +
      `${expected.join(', ')} — the upstream set changed`
    )
  }

  for (const mod of UPSTREAM_MODS_PIN.mods) {
    const entry = join(tree, mod.name, mod.entry)
    if (!existsSync(entry)) {
      return `${root} is missing ${UPSTREAM_MODS_PIN.directory}/${mod.name}/${mod.entry}`
    }
    const digest = sha256(entry)
    if (digest !== mod.entrySha256) {
      return (
        `${entry} sha256 is ${digest}; the pin is ${mod.entrySha256} — ` +
        `refusing to load a different artifact as the same mod`
      )
    }
  }

  // S13/S14 still measure the diff graph through this same tree.
  const diffRoot = join(tree, 'diff', 'hooks')
  const entry = join(diffRoot, DIFF_MOD_PIN.entry)
  if (!existsSync(entry)) return `${root} is missing ${DIFF_MOD_PIN.directory}/${DIFF_MOD_PIN.entry}`
  const size = statSync(entry).size
  if (size !== DIFF_MOD_PIN.entryBytes) {
    return `${entry} is ${size} bytes; the pin is ${DIFF_MOD_PIN.entryBytes}`
  }
  const counts = countModules(diffRoot)
  if (counts.ts !== DIFF_MOD_PIN.tsFiles || counts.tsx !== DIFF_MOD_PIN.tsxFiles) {
    return (
      `${diffRoot} has ${counts.ts} .ts and ${counts.tsx} .tsx files; ` +
      `S13 measured ${DIFF_MOD_PIN.tsFiles} / ${DIFF_MOD_PIN.tsxFiles} at this pin — the checkout is partial`
    )
  }

  const digest = treeSha256(tree)
  if (digest !== UPSTREAM_MODS_PIN.treeSha256) {
    return (
      `${tree} sha256 is ${digest}; the pin is ${UPSTREAM_MODS_PIN.treeSha256} — ` +
      `the materialized mods tree is not the pinned one`
    )
  }
  return null
}

function gitResult(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Never block on a credential prompt: CI and agents have no tty here.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error !== undefined) {
    die(`cannot run git: ${result.error.message}`)
  }
  return result
}

function git(args, cwd) {
  const result = gitResult(args, cwd)
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr)
    die(`git ${args[0]} exited ${result.status}`)
  }
  return result.stdout
}

/** A clean scratch repository with only `/mods/` in its sparse pattern. */
function initScratch() {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  git(['init', '--quiet'], SCRATCH)
  git(['remote', 'add', 'origin', ORIGIN], SCRATCH)
  // Non-cone sparse patterns: the leading slash anchors at the worktree root.
  writeFileSync(
    join(SCRATCH, '.git', 'info', 'sparse-checkout'),
    `/${UPSTREAM_MODS_PIN.directory}/\n`,
  )
  git(['config', 'core.sparseCheckout', 'true'], SCRATCH)
  // The tree hash is byte-based; never let a host checkout rewrite line endings.
  git(['config', 'core.autocrlf', 'false'], SCRATCH)
}

function fetchMods() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  initScratch()

  try {
    // Partial clone keeps the fetch to the commit's trees and the sparse
    // blobs. Not every server/proxy supports it; fall back to a plain fetch.
    const filtered = [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      '--filter=blob:none',
      'origin',
      UPSTREAM_MODS_PIN.commit,
    ]
    let fetched = gitResult(filtered, SCRATCH)
    if (fetched.status !== 0) {
      process.stderr.write('fetch-mod: blob-filtered fetch unavailable; retrying without a filter\n')
      initScratch()
      fetched = gitResult(
        ['fetch', '--quiet', '--depth', '1', 'origin', UPSTREAM_MODS_PIN.commit],
        SCRATCH,
      )
      if (fetched.status !== 0) {
        if (fetched.stderr) process.stderr.write(fetched.stderr)
        die(`git fetch exited ${fetched.status}`)
      }
    }

    git(['checkout', '--quiet', 'FETCH_HEAD'], SCRATCH)

    const head = git(['rev-parse', 'HEAD'], SCRATCH).trim()
    if (head !== UPSTREAM_MODS_PIN.commit) {
      die(`checked out ${head}; the pin is ${UPSTREAM_MODS_PIN.commit}`)
    }
    const treeId = git(['rev-parse', `HEAD:${UPSTREAM_MODS_PIN.directory}`], SCRATCH).trim()
    if (treeId !== UPSTREAM_MODS_PIN.gitTree) {
      die(
        `${UPSTREAM_MODS_PIN.directory}/ tree is ${treeId}; the pin is ` +
          `${UPSTREAM_MODS_PIN.gitTree} — upstream moved or the checkout is partial`,
      )
    }

    const checkedOut = join(SCRATCH, UPSTREAM_MODS_PIN.directory)
    if (!existsSync(checkedOut)) {
      die(
        `checkout at ${UPSTREAM_MODS_PIN.commit} has no ` +
          `${UPSTREAM_MODS_PIN.directory}/ directory`,
      )
    }
    mkdirSync(ROOT, { recursive: true })
    renameSync(checkedOut, TREE)
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  const problem = treeProblem(ROOT)
  if (problem !== null) die(problem)
  process.stderr.write(
    `fetch-mod: checked out ${UPSTREAM_MODS_PIN.directory} at ` +
      `${UPSTREAM_MODS_PIN.commit.slice(0, 7)} (${UPSTREAM_MODS_PIN.mods.length} mods)\n`,
  )
}

function printRoot() {
  process.stdout.write(`${resolve(ROOT)}\n`)
}

function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(USAGE)
    return
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--verify' && args[0] !== '--refresh')) {
    die(USAGE.trim())
  }

  if (args[0] === '--verify') {
    const problem = treeProblem(ROOT)
    if (problem !== null) die(problem)
    process.stderr.write(`fetch-mod: ${ROOT} is the pinned tree\n`)
    printRoot()
    return
  }

  if (args[0] !== '--refresh' && existsSync(ROOT)) {
    const problem = treeProblem(ROOT)
    if (problem === null) {
      process.stderr.write(`fetch-mod: ${ROOT} already at the pin\n`)
      printRoot()
      return
    }
    process.stderr.write(`fetch-mod: existing ${ROOT} is not the pinned tree (${problem}); refetching\n`)
  }

  fetchMods()
  printRoot()
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) main()
