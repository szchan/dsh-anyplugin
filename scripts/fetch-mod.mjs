#!/usr/bin/env node
/**
 * Fetch the pinned upstream mod under test into `.mods/<commit>/`.
 *
 * The differential test (`packages/dsh-anyplugin-mod-host/test/diff-mod.test.mjs`)
 * needs one real authored mod: the `diff` mod from Claude Code 2.1.322, at
 * commit 6e1e44f. That tree is fetched here, explicitly, exactly like the
 * harness and CLI pins (D22, D24): tests never touch the network.
 *
 * The checkout is sparse: git fetches one commit, with blob filtering, and
 * materializes only `mods/diff/hooks/`. The fetched root holds `register.ts`
 * directly, so `.mods/<commit>` is what `loadMod({ root, entry })` receives —
 * no `mods/diff/hooks` nesting leaks into the test.
 *
 * The pin is checked in two places: `packages/dsh-anyplugin-mod-host/src/pin.ts`
 * carries the commit, size, sha256 and S13's .ts/.tsx counts; this script
 * verifies the fetched entry bytes and the two counts. A partial checkout or a
 * moved commit therefore fails here, loudly, instead of shrinking the graph the
 * diff test exercises.
 *
 * Usage:
 *   node scripts/fetch-mod.mjs           # fetch (idempotent), print the mod root
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
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DIFF_MOD_PIN } from '../packages/dsh-anyplugin-mod-host/src/pin.ts'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const MODS_DIR = join(REPO_ROOT, '.mods')
const ROOT = join(MODS_DIR, DIFF_MOD_PIN.commit)
const SCRATCH = join(MODS_DIR, `.scratch-${DIFF_MOD_PIN.commit}`)
const ORIGIN = 'https://github.com/anthropics/claude-code.git'

const USAGE = `usage: node scripts/fetch-mod.mjs [--verify | --refresh]

Fetches ${DIFF_MOD_PIN.directory}/ of claude-code at ${DIFF_MOD_PIN.commit} into
.mods/${DIFF_MOD_PIN.commit}/ and prints the absolute mod root. The pin (entry
size, sha256, .ts/.tsx counts) is checked in
packages/dsh-anyplugin-mod-host/src/pin.ts.

--verify  checks the existing checkout and prints it; it fetches nothing.
--refresh discards an existing checkout and fetches the pin again.

Idempotent: a valid existing checkout is reused after verification. The tests
only read the tree; this script is the only step that uses the network.
`

function die(message) {
  process.stderr.write(`fetch-mod: ${message}\n`)
  process.exit(1)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
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

/** Assert the fetched tree is exactly the pinned artifact, not a pruned copy. */
function verifyTree(root) {
  const entry = join(root, DIFF_MOD_PIN.entry)
  if (!existsSync(entry)) {
    die(`${root} is missing ${DIFF_MOD_PIN.entry}; not the pinned mod tree`)
  }
  const size = statSync(entry).size
  if (size !== DIFF_MOD_PIN.entryBytes) {
    die(
      `${entry} is ${size} bytes; the pin is ${DIFF_MOD_PIN.entryBytes} — ` +
        `this checkout is not ${DIFF_MOD_PIN.version}@${DIFF_MOD_PIN.commit.slice(0, 7)}`,
    )
  }
  const digest = sha256(entry)
  if (digest !== DIFF_MOD_PIN.entrySha256) {
    die(
      `${entry} sha256 is ${digest}; the pin is ${DIFF_MOD_PIN.entrySha256} — ` +
        `refusing to load a different artifact as the same mod`,
    )
  }
  const counts = countModules(root)
  if (counts.ts !== DIFF_MOD_PIN.tsFiles || counts.tsx !== DIFF_MOD_PIN.tsxFiles) {
    die(
      `${root} has ${counts.ts} .ts and ${counts.tsx} .tsx files; ` +
        `S13 measured ${DIFF_MOD_PIN.tsFiles} / ${DIFF_MOD_PIN.tsxFiles} at this pin — the checkout is partial`,
    )
  }
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Never block on a credential prompt: CI and agents have no tty here.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error !== undefined) {
    die(`cannot run git: ${result.error.message}`)
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr)
    die(`git ${args[0]} exited ${result.status}`)
  }
}

function fetchMod() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })

  try {
    git(['init', '--quiet'], SCRATCH)
    git(['remote', 'add', 'origin', ORIGIN], SCRATCH)
    // Non-cone sparse patterns: the leading slash anchors at the worktree root.
    writeFileSync(join(SCRATCH, '.git', 'info', 'sparse-checkout'), `/${DIFF_MOD_PIN.directory}/\n`)
    git(['config', 'core.sparseCheckout', 'true'], SCRATCH)
    git(['fetch', '--quiet', '--depth', '1', 'origin', DIFF_MOD_PIN.commit], SCRATCH)
    git(['checkout', '--quiet', 'FETCH_HEAD'], SCRATCH)

    const fetched = join(SCRATCH, DIFF_MOD_PIN.directory)
    if (!existsSync(fetched)) {
      die(`checkout at ${DIFF_MOD_PIN.commit} has no ${DIFF_MOD_PIN.directory}/ directory`)
    }
    mkdirSync(MODS_DIR, { recursive: true })
    renameSync(fetched, ROOT)
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  verifyTree(ROOT)
  process.stderr.write(
    `fetch-mod: checked out ${DIFF_MOD_PIN.directory} at ${DIFF_MOD_PIN.commit.slice(0, 7)}\n`,
  )
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
    verifyTree(ROOT)
    process.stderr.write(`fetch-mod: ${ROOT} is the pinned tree\n`)
    process.stdout.write(`${resolve(ROOT)}\n`)
    return
  }

  if (args[0] !== '--refresh' && existsSync(ROOT)) {
    verifyTree(ROOT)
    process.stderr.write(`fetch-mod: ${ROOT} already at the pin\n`)
    process.stdout.write(`${resolve(ROOT)}\n`)
    return
  }

  fetchMod()
  process.stdout.write(`${resolve(ROOT)}\n`)
}

main()
