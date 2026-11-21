// A Claude mod is declared by `modules` in hooks/hooks.json, as a path
// relative to hooks/ (the pinned claude-code.d.ts shape at 2.1.329). The
// dialect carries it as an IrMod: the entry, the tree root it was declared
// under, and an annotation that says either "the host can load this as
// authored" or why it cannot.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readClaudePlugin } from '../src/index.ts'

const fixture = join(import.meta.dirname, 'fixtures', 'claude-mods')

const writePlugin = (root, modules) => {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'probe', version: '0.0.1' }),
  )
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules }))
  return root
}

test('hooks.json modules become an equivalent IrMod under hooks/', () => {
  const ir = readClaudePlugin(fixture)
  assert.deepEqual(ir.mods.map((mod) => ({
    entry: mod.entry,
    rootRelative: mod.rootRelative,
    sourcePath: mod.sourcePath,
    fidelity: mod.annotation.fidelity,
  })), [{
    entry: 'hooks/register.ts',
    rootRelative: 'hooks',
    sourcePath: 'hooks/hooks.json',
    fidelity: 'equivalent',
  }])
  assert.match(ir.mods[0].annotation.reason, /as authored/)
  assert.equal(ir.pending.some((row) => row.surface === 'mods'), false)
})

test('a module the host cannot load is unsupported in the IR, with the reason kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-mods-dialect-'))
  try {
    writePlugin(join(dir, 'a'), ['missing.ts'])
    writePlugin(join(dir, 'b'), ['./data.txt'])
    writeFileSync(join(dir, 'b', 'hooks', 'data.txt'), 'x')
    writePlugin(join(dir, 'c'), ['/etc/passwd'])
    const missing = readClaudePlugin(join(dir, 'a'))
    const extension = readClaudePlugin(join(dir, 'b'))
    const absolute = readClaudePlugin(join(dir, 'c'))
    assert.equal(missing.mods[0].annotation.fidelity, 'unsupported')
    assert.match(missing.mods[0].annotation.reason, /ERR_MOD_HOST_MISSING/)
    assert.equal(extension.mods[0].annotation.fidelity, 'unsupported')
    assert.match(extension.mods[0].annotation.reason, /ERR_MOD_HOST_UNSUPPORTED_EXT/)
    assert.equal(absolute.mods[0].annotation.fidelity, 'unsupported')
    assert.match(absolute.mods[0].annotation.reason, /absolute/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
