import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { acquire, release } from './gate-slot.mjs'

const scratch = () => mkdtempSync(join(tmpdir(), 'gate-slot-'))

test('a free slot is taken and recorded with this process', async () => {
  const dir = join(scratch(), 'slot')
  const held = await acquire(dir, 1000)
  assert.equal(held, dir)
  assert.equal(readFileSync(join(dir, 'pid'), 'utf8').trim(), String(process.pid))
  release(dir)
  assert.equal(existsSync(dir), false)
})

test('a held slot is waited on and then given up, not stolen', async () => {
  const dir = join(scratch(), 'slot')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pid'), `${process.pid}\n`)
  const started = Date.now()
  const held = await acquire(dir, 300)
  assert.equal(held, undefined)
  assert.ok(Date.now() - started >= 290, 'it must actually wait')
  assert.equal(existsSync(dir), true, 'the other holder still owns it')
  release(dir)
})

test('a dead holder is reclaimed with a printed reason', async () => {
  const dir = join(scratch(), 'slot')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pid'), '999999999\n')
  const held = await acquire(dir, 1000)
  assert.equal(held, dir)
  release(dir)
})

test('an hour-old lock is reclaimed even when its pid was recycled', async () => {
  const dir = join(scratch(), 'slot')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pid'), '1\n')
  const old = Date.now() - 61 * 60 * 1000
  utimesSync(join(dir, 'pid'), old / 1000, old / 1000)
  const held = await acquire(dir, 1000)
  assert.equal(held, dir)
  release(dir)
})

test('a nested run does not deadlock on its own parent', () => {
  const dir = join(scratch(), 'slot')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pid'), `${process.pid}\n`)
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/gate-slot.mjs', '--', process.execPath, '-e', 'process.exit(0)'],
      { env: { ...process.env, ANYPLUGIN_GATE_HELD: '1', ANYPLUGIN_GATE_DIR: dir }, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(dir, 'pid'), 'utf8').trim(), String(process.pid), 'the parent keeps the slot')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
