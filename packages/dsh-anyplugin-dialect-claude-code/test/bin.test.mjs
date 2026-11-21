// `bin/` is a Claude plugin surface with no DSH seam at the pin: Claude appends
// `<plugin>/bin` to the PATH of the shell its model calls, while DSH's managed
// environment (dsh-shell-env) accepts declared DSH_* keys only and the
// model-facing shell tools expose no env parameter. S19 measured that at
// 0.2.2-rc.5 (spikes/s19-path/run.mjs), so the dialect records the surface as
// `unsupported` with the refusal as its reason — never as `planned`, which
// would claim a host change is only a matter of time. This test keeps the
// annotation and the IR's own pending/unsupported invariant honest.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { readClaudePlugin } from '../src/index.ts'

const writePlugin = (root) => {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'probe', version: '0.0.1' }),
  )
  writeFileSync(join(root, 'bin', 'probecmd'), '#!/bin/sh\necho probe\n', { mode: 0o755 })
  return root
}

test('bin/ is unsupported with the measured PATH refusal, not a pending promise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-bin-dialect-'))
  try {
    const ir = readClaudePlugin(writePlugin(dir))
    const row = ir.unsupported.find((entry) => entry.surface === 'bin')
    assert.ok(row, 'bin/ must be recorded in unsupported')
    assert.equal(row.name, 'bin')
    assert.equal(row.sourcePath, 'bin')
    assert.equal(row.annotation.fidelity, 'unsupported')
    assert.match(row.annotation.reason, /dsh-shell-env accepts DSH_\* keys only/)
    assert.match(row.annotation.reason, /exit 127/)
    assert.equal(ir.pending.some((entry) => entry.surface === 'bin'), false)
    assert.deepEqual(validateIr(ir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a plugin without bin/ gets no bin row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-bin-dialect-'))
  try {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'probe', version: '0.0.1' }))
    const ir = readClaudePlugin(dir)
    assert.equal(ir.unsupported.some((entry) => entry.surface === 'bin'), false)
    assert.equal(ir.pending.some((entry) => entry.surface === 'bin'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
