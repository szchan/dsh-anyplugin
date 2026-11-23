// Test-only scaffolding for the CLI-level tests: a real git repository, a bare
// `origin`, and a fake `gh` first on PATH. Nothing here ships; `verify` never
// imports it.
//
// `scripts/ci.test.mjs` and `scripts/pr-update.test.mjs` both need a pushed
// branch and a scriptable `gh`, and both must observe *which* runs were asked
// for, so the fake records every argv. That log is how "fails fast without
// asking GitHub" is asserted.

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A `gh` stand-in; `execFileSync` inside it inherits the calling test's cwd. */
function fakeGhProgram() {
  return [
    "const { execFileSync } = require('node:child_process')",
    "const { appendFileSync, readFileSync } = require('node:fs')",
    "const config = JSON.parse(readFileSync(process.env.GH_FAKE_CONFIG, 'utf8'))",
    'const args = process.argv.slice(2)',
    "appendFileSync(config.log, args.join(' ') + '\\n')",
    "const git = (gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8' }).trim()",
    "if (args[0] === 'pr' && args[1] === 'view') {",
    "  const head = git(['rev-parse', 'HEAD'])",
    '  process.stdout.write(JSON.stringify({',
    "    number: Number(args[2]), state: 'OPEN', isCrossRepository: false,",
    "    baseRefName: 'main', headRefName: 'ticket/225', headRefOid: head, mergeable: 'CLEAN',",
    '    ...(config.pr || {}),',
    '  }))',
    "} else if (args[0] === 'run' && args[1] === 'list') {",
    "  const commit = args[args.indexOf('--commit') + 1]",
    "  const runs = (config.runs || []).map((entry) => ({ ...entry, headSha: entry.headSha === 'HEAD' ? commit : entry.headSha }))",
    '  process.stdout.write(JSON.stringify(runs))',
    "} else if (args[0] === 'run' && args[1] === 'view') {",
    "  if (args.includes('--log-failed')) {",
    "    process.stdout.write('fake failed log\\n')",
    "  } else if (args.includes('jobs')) {",
    "    process.stdout.write(JSON.stringify({ jobs: [] }))",
    '  } else {',
    "    const id = String(args[2])",
    "    process.stdout.write(JSON.stringify((config.views || {})[id] || { status: 'completed', conclusion: 'success' }))",
    '  }',
    '} else {',
    "  process.stdout.write('{}')",
    '}',
    '',
  ].join('\n')
}

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
}

/** `git` that reports a non-zero exit instead of throwing. */
export function gitTry(cwd, args) {
  try {
    return { status: 0, stdout: git(cwd, args), stderr: '' }
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

function write(cwd, name, content) {
  mkdirSync(dirname(join(cwd, name)), { recursive: true })
  writeFileSync(join(cwd, name), content)
}

function commit(cwd, message) {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-q', '-m', message])
}

/**
 * `origin` is a bare repository; the work tree starts on `main` and has
 * `ticket/225` one commit ahead, pushed (so its head is reachable from
 * `origin/ticket/225`). `mainConflict` moves `origin/main` to a conflicting
 * edit of the same file; `mainAhead` moves it to a non-conflicting commit.
 */
export function setupRepo({ mainConflict = false, mainAhead = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'anyplugin-run-'))
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'test'])
  write(repo, 'file.txt', 'base\n')
  commit(repo, 'main: base')
  execFileSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' })
  git(repo, ['remote', 'add', 'origin', origin])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  git(repo, ['checkout', '-q', '-b', 'ticket/225'])
  if (mainConflict) write(repo, 'file.txt', 'ticket\n')
  write(repo, 'ticket.txt', 'work\n')
  commit(repo, 'ticket: work')
  git(repo, ['push', '-q', '-u', 'origin', 'ticket/225'])
  if (mainConflict || mainAhead) {
    git(repo, ['checkout', '-q', 'main'])
    if (mainConflict) write(repo, 'file.txt', 'main\n')
    if (mainAhead) write(repo, 'other.txt', 'other\n')
    commit(repo, 'main: move')
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['checkout', '-q', 'ticket/225'])
    git(repo, ['fetch', '-q', 'origin'])
  }
  return { root, repo, origin }
}

/**
 * Put a fake `gh` first on PATH and point it at `config`:
 * - `runs`: `gh run list` output; `headSha: 'HEAD'` means the `--commit` value;
 * - `views`: `gh run view <id> --json status,conclusion`; default completed/success;
 * - `pr`: fields merged over the default OPEN, same-repo `ticket/225` PR whose
 *   head is the repository's current HEAD.
 *
 * Returns a reader for the argv log.
 */
export function installFakeGh(root, config = {}) {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'fake-gh.cjs'), fakeGhProgram())
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-gh.cjs" "$@"\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const configPath = join(root, 'gh-config.json')
  writeFileSync(configPath, JSON.stringify({ log: join(root, 'gh.log'), runs: [], views: {}, ...config }))
  process.env.GH_FAKE_CONFIG = configPath
  process.env.PATH = `${bin}:${process.env.PATH}`
  return () => {
    try {
      return readFileSync(join(root, 'gh.log'), 'utf8')
    } catch {
      return ''
    }
  }
}

/** stdout/stderr sinks for a `main(argv, io)`/`run(argv, io)` call. */
export function capture() {
  const out = []
  const err = []
  return {
    io: { out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

/** Run `fn` with the process cwd inside `repo`, then restore it. */
export function withRepo(repo, fn) {
  const start = process.cwd()
  process.chdir(repo)
  try {
    return fn()
  } finally {
    process.chdir(start)
  }
}
