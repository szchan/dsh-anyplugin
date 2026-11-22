// arch-check: cli
// One gate run at a time on this machine.
//
// Three agents share this host. `npm test` spawns one worker per core, so three
// concurrent suites saturate every core and make each other slow enough to look
// like flakes. This wrapper takes a lock, waits for the current holder, then
// runs the command it was given.
//
// The lock is advisory and lives outside the repository: a repository-local
// path would show up in `git status` and would be deleted by a worktree prune.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const HELD = 'ANYPLUGIN_GATE_HELD'
const STALE_AFTER_MS = 60 * 60 * 1000
const WAIT_MS = Number(process.env.ANYPLUGIN_GATE_WAIT_MS ?? 30 * 60 * 1000)

export function slotDir(root = process.cwd()) {
  if (process.env.ANYPLUGIN_GATE_DIR) return process.env.ANYPLUGIN_GATE_DIR
  const stamp = createHash('sha256').update(root).digest('hex').slice(0, 12)
  return join(tmpdir(), `dsh-anyplugin-gate-${stamp}`)
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function holderPid(dir) {
  try {
    return Number.parseInt(readFileSync(join(dir, 'pid'), 'utf8').trim(), 10)
  } catch {
    return undefined
  }
}

function stale(dir) {
  const pid = holderPid(dir)
  if (pid !== undefined && !alive(pid)) return `holder ${pid} is gone`
  try {
    if (Date.now() - statSync(join(dir, 'pid')).mtimeMs > STALE_AFTER_MS) return 'lock is older than an hour'
  } catch {
    return 'lock has no pid file'
  }
  return undefined
}

/**
 * Acquire the slot, or return undefined once the wait expires. A stale lock
 * (dead holder, or an hour old) is reclaimed with a printed reason rather than
 * silently ignored.
 */
export async function acquire(dir = slotDir(), waitMs = WAIT_MS) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'pid'), `${process.pid}\n`)
      return dir
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const why = stale(dir)
    if (why) {
      console.error(`gate slot: reclaiming (${why})`)
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    if (Date.now() >= deadline) return undefined
    if (!existsSync(dir)) continue
    await sleep(1000)
  }
}

export function release(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true })
}

function main(argv) {
  const at = argv.indexOf('--')
  const command = at === -1 ? [] : argv.slice(at + 1)
  if (command.length === 0) {
    console.error('usage: node scripts/gate-slot.mjs -- <command> [args...]')
    return 2
  }

  // Re-entrant: `npm run verify` calls `npm test`, and the outer run already
  // holds the slot. A nested wrapper must not deadlock on its own parent.
  if (process.env[HELD] === '1') return run(command)

  const dir = slotDir()
  return acquire(dir).then((held) => {
    if (!held) {
      console.error(`gate slot: still held after ${Math.round(WAIT_MS / 60000)} min; not starting a second run`)
      return 75
    }
    const pid = holderPid(dir)
    if (pid !== undefined && pid !== process.pid) console.error(`gate slot: took over from ${pid}`)
    const release_ = () => release(dir)
    process.once('exit', release_)
    process.once('SIGINT', () => {
      release_
      process.exit(130)
    })
    process.once('SIGTERM', () => {
      release_
      process.exit(143)
    })
    return run(command)
  })
}

function run(command) {
  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [HELD]: '1' },
  })
  if (result.error) {
    console.error(`gate slot: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)))
}
