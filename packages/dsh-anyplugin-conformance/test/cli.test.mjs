// Ticket #146: the published `dsh-anyplugin` command.
//
// The bin adds exactly one thing to the rig: a front door. `--help` is a
// command there (exit 0, no DSH installation), no argument is a usage error,
// and every option stays closed per D49 — `--dry-run=true` is still unknown,
// because the parser that says so is the rig's own. The install cases run the
// source entry with no DSH pointer in the environment; the packed artifact is
// exercised in `packed-cli.test.mjs`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'claude-skills-only')

function scratch() {
  return mkdtempSync(join(tmpdir(), 'anyplugin-cli-'))
}

/**
 * The environment a user has on a machine with no DSH install: no
 * `DSH_HARNESS_DIR`, no `DSH_INSTALL_DIR`, no `CLAUDE_BIN`, no `ANYPLUGIN_*`.
 * Only the variables the command is given are set.
 */
function envFor(home, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, ...extra }
}

function run(args, home, extra = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: envFor(home, extra),
  })
}

test('published bin: --help exits 0 with no DSH environment', () => {
  const home = scratch()
  try {
    const result = run(['--help'], home)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /^dsh-anyplugin — install foreign agent plugins into DeepSeek Harness\./)
    // The published name is the door; the commands under it are the rig's own.
    assert.match(result.stdout, /dsh-anyplugin install <plugin-dir>/)
    assert.match(result.stdout, /dsh-anyplugin marketplace install <entry>/)
    assert.match(result.stdout, /dsh-anyplugin report {2}<plugin-dir>/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('published bin: the program name comes from the invoked entry', () => {
  const home = scratch()
  try {
    const published = spawnSync(process.execPath, [cliPath, 'report', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: envFor(home),
    })
    assert.equal(published.status, 0, published.stderr)
    assert.match(published.stdout, /^ {2}dsh-anyplugin report {2}<plugin-dir>/m)
    assert.doesNotMatch(published.stdout, /^ {2}rig report/m)

    // `npm run rig --` must keep reading like the rig it is.
    const checkout = spawnSync(process.execPath, [rigPath, 'report', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: envFor(home),
    })
    assert.equal(checkout.status, 0, checkout.stderr)
    assert.match(checkout.stdout, /^ {2}rig report {2}<plugin-dir>/m)
    assert.doesNotMatch(checkout.stdout, /^ {2}dsh-anyplugin report/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('published bin: help takes its documented aliases', () => {
  const home = scratch()
  try {
    for (const token of ['help', '-h']) {
      const result = run([token], home)
      assert.equal(result.status, 0, `${token}: ${result.stderr}`)
      assert.match(result.stdout, /dsh-anyplugin install <plugin-dir>/, token)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('published bin: no arguments is a usage error, not a silent success', () => {
  const home = scratch()
  try {
    const result = run([], home)

    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^dsh-anyplugin — install foreign agent plugins/)
    assert.match(result.stderr, /dsh-anyplugin install <plugin-dir>/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('published bin: options stay closed per D49', () => {
  const home = scratch()
  try {
    // D49: `--flag=value` is an unknown flag, not a parsed form.
    const inline = run(['install', fixture, '--dry-run=true'], home)
    assert.equal(inline.status, 2)
    assert.match(inline.stderr, /unknown option --dry-run=true for install/)

    const unknown = run(['install', fixture, '--bogus'], home)
    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /unknown option --bogus for install/)

    const command = run(['frobnicate'], home)
    assert.equal(command.status, 2)
    assert.match(command.stderr, /unknown command "frobnicate"/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('published bin: install <dir> --dry-run prints the plan and writes nothing', () => {
  const home = scratch()
  try {
    const result = run(['install', fixture, '--dry-run'], home, { DSH_HOME: home })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^install claude-code:skills-only: added \(dry run — nothing written\)$/m)
    assert.match(result.stdout, /\+     name: "skills-only"/)
    assert.equal(result.stderr, '')
    // Only DSH_HOME was provided; no harness, no oracle, no writes.
    assert.deepEqual(readdirSync(home), [])
    assert.equal(existsSync(join(home, 'anyplugin', 'installs.yml')), false)
    assert.equal(existsSync(join(home, 'anyplugin', 'enabled.yml')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('published bin: per-command --help still comes from the rig', () => {
  const home = scratch()
  try {
    const result = run(['install', '--help'], home)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /dsh-anyplugin install <plugin-dir> \[--scope <s>\]/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
