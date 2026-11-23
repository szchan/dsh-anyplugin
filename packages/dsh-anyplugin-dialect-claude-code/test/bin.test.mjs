// `bin/` is a Claude plugin surface whose PATH placement DSH's managed
// environment cannot carry: dsh-shell-env accepts declared DSH_* keys only and
// the model-facing shell tools send only that overlay (S19 measured the exact
// refusals at 0.2.2-rc.5 and 0.2.2-rc.2, spikes/s19-path/run.mjs). The surface
// is still expressible — a `tools/pre-execute` listener can rewrite the bash
// command, as materialize-hook does for `updatedInput` — but that route
// diverges (tool_input, pwsh syntax, ordering), so the dialect marks it
// `planned` and names the divergence instead of claiming a host change is
// imminent. These tests keep the annotation and the IR pending/unsupported
// invariant honest, and guard the surface-reader fix that used to skip these
// rows entirely when `.mcp.json` was absent.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { readClaudePlugin } from '../src/index.ts'

const writePlugin = (root) => {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'probe', version: '0.0.1' }),
  )
  return root
}

test('bin/ is planned with the managed-env refusal and the per-call rewrite divergence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-bin-dialect-'))
  try {
    writePlugin(dir)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'probecmd'), '#!/bin/sh\necho probe\n', { mode: 0o755 })
    const ir = readClaudePlugin(dir)
    const row = ir.pending.find((entry) => entry.surface === 'bin')
    assert.ok(row, 'bin/ must be recorded in pending')
    assert.equal(row.name, 'bin')
    assert.equal(row.sourcePath, 'bin')
    assert.equal(row.annotation.fidelity, 'planned')
    assert.match(row.annotation.reason, /declared invalid key "PATH"/)
    assert.match(row.annotation.reason, /SHELL_ENV_CONTRIBUTION_INVALID/)
    assert.match(row.annotation.reason, /tools\/pre-execute/)
    assert.match(row.annotation.reason, /0\.2\.2-rc\.5/)
    assert.match(row.annotation.reason, /0\.2\.2-rc\.2/)
    assert.match(row.annotation.reason, /diverges/)
    assert.equal(ir.unsupported.some((entry) => entry.surface === 'bin'), false)
    assert.deepEqual(validateIr(ir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a plugin without bin/ gets no bin row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-bin-dialect-'))
  try {
    writePlugin(dir)
    const ir = readClaudePlugin(dir)
    assert.equal(ir.unsupported.some((entry) => entry.surface === 'bin'), false)
    assert.equal(ir.pending.some((entry) => entry.surface === 'bin'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('themes/workflows/monitors/.lsp.json stay planned, before style rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-surfaces-dialect-'))
  try {
    writePlugin(dir)
    mkdirSync(join(dir, 'themes'), { recursive: true })
    mkdirSync(join(dir, 'workflows'), { recursive: true })
    mkdirSync(join(dir, 'monitors'), { recursive: true })
    writeFileSync(join(dir, '.lsp.json'), '{}')
    // A nested output style stays pending, so it also proves the merge order:
    // optional surfaces keep the position they had when they were tail of the
    // MCP reader, ahead of output-style rows.
    mkdirSync(join(dir, 'output-styles', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'output-styles', 'nested', 'inner.md'), '---\nname: inner\n---\nBody.\n')
    const ir = readClaudePlugin(dir)
    const surfaces = ir.pending
      .filter((entry) => ['lspServers', 'themes', 'workflows', 'monitors'].includes(entry.surface))
      .map((entry) => entry.surface)
    assert.deepEqual(surfaces, ['lspServers', 'themes', 'workflows', 'monitors'])
    for (const entry of ir.pending.filter((row) => surfaces.includes(row.surface))) {
      assert.equal(entry.annotation.fidelity, 'planned')
    }
    const theme = ir.pending.find((entry) => entry.surface === 'themes')
    assert.ok(theme, 'themes/ must be carried as a planned row')
    assert.equal(theme.annotation.fidelity, 'planned')
    assert.match(theme.annotation.reason, /2 of Claude's 72/u)
    assert.match(theme.annotation.reason, /70 have no DSH terminal counterpart/u)
    assert.match(theme.annotation.reason, /ANSI 16 are OSC 4\/104-only/u)
    assert.equal(ir.unsupported.some((entry) => entry.surface === 'themes'), false)
    const n = ir.pending.length
    assert.equal(ir.pending[n - 1]?.surface, 'outputStyles')
    assert.deepEqual(validateIr(ir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
