// Output styles are F1: the body is prompt text the model reads at agent start.
// S11 proved the pinned harness has a per-agent prompt seam (`invocation.agent` /
// `setup(agentCtx)` / `agent/created` / `dsh-persona` / an agent preset), but the
// carry still waits on activation (D10's command alias) and three fidelity gaps.
// The dialect therefore carries each body byte for byte and still annotates the
// row `planned`, with a reason that names the reachable seam and every gap. This
// test is the annotation contract; the fresh-fixture body hash is in
// `output-styles-carry.test.mjs` and the spike is the evidence.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { isCarried, validateIr } from '../../dsh-anyplugin-ir/src/index.ts'

function pluginDir(files, manifest = { name: 'styles-probe', version: '0.0.1' }) {
  const root = mkdtempSync(join(tmpdir(), 'anyplugin-output-style-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  return root
}

const TERSE = [
  '---',
  'name: terse',
  'description: Answer in terse bullet points.',
  '---',
  '',
  'Answer in terse bullet points. Never explain the obvious.',
  '',
].join('\n')

test('an output style is planned and names the reachable seam and its gaps', (t) => {
  const root = pluginDir({ 'output-styles/terse.md': TERSE })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const ir = readClaudePlugin(root)
  const rows = ir.outputStyles ?? []
  assert.equal(rows.length, 1, 'one row per style file, not one row per directory')
  const [style] = rows
  assert.equal(style.name, 'terse', 'frontmatter name is the identity Claude registers')
  assert.equal(style.sourcePath, 'output-styles/terse.md')
  assert.equal(style.body, '\nAnswer in terse bullet points. Never explain the obvious.\n', 'the body is carried, not just the identity')
  assert.equal(style.annotation.fidelity, 'planned')
  assert.equal(isCarried(style.annotation), false)
  assert.match(style.annotation.reason, /body is carried byte for byte/)
  assert.match(style.annotation.reason, /applying it is planned/)
  assert.match(style.annotation.reason, /invocation\.agent\.ctx/)
  assert.match(style.annotation.reason, /complete: true/)
  assert.match(style.annotation.reason, /S11/)
  assert.match(style.annotation.reason, /agent\/created/, 'the provenance gap is named')
  assert.match(style.annotation.reason, /command-alias/, 'the D10 activation gap is named')
  assert.match(style.annotation.reason, /plugin details/, 'the oracle gap is named')
  assert.match(style.annotation.reason, /keep-coding-instructions/, 'the composition gap is named')
  assert.match(style.annotation.reason, /terse bullet points/, 'the style description is recorded, not dropped')
  assert.equal(
    ir.unsupported.some((row) => row.surface === 'outputStyles'),
    false,
    'a planned style is not refused',
  )
  assert.deepEqual(validateIr(ir), [], 'the planned row is a valid annotation, not a validation error')
})

test('a style without a frontmatter name falls back to its filename', (t) => {
  const root = pluginDir({
    'output-styles/plain.md': '---\ndescription: Say only what is needed.\n---\n\nBe brief.\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const [style] = readClaudePlugin(root).outputStyles ?? []
  assert.equal(style.name, 'plain')
  assert.equal(style.body, '\nBe brief.\n')
  assert.equal(style.annotation.fidelity, 'planned')
  assert.match(style.annotation.reason, /invocation\.agent\.ctx/)
})

test('a manifest outputStyles declaration is planned explicitly', (t) => {
  const root = pluginDir({}, { name: 'styles-probe', version: '0.0.1', outputStyles: ['./styles'] })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const ir = readClaudePlugin(root)
  const rows = ir.pending.filter((row) => row.surface === 'outputStyles')
  const manifest = rows.find((row) => row.name === 'manifest:outputStyles')
  assert.ok(manifest, 'a directory the dialect does not read must not be silent')
  assert.deepEqual(ir.outputStyles, [], 'a declared directory is not a carried style')
  assert.equal(manifest.sourcePath, '.claude-plugin/plugin.json')
  assert.equal(manifest.annotation.fidelity, 'planned')
  assert.match(manifest.annotation.reason, /custom output-style directories/)
  assert.match(manifest.annotation.reason, /invocation\.agent\.ctx/)
})

test('a plugin without output-styles declares no style rows', (t) => {
  const root = pluginDir({ 'skills/greet/SKILL.md': '---\nname: greet\n---\n\nHi.\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const ir = readClaudePlugin(root)
  assert.equal(ir.unsupported.some((row) => row.surface === 'outputStyles'), false)
  assert.equal(ir.pending.some((row) => row.surface === 'outputStyles'), false)
  assert.deepEqual(ir.outputStyles, [])
})

test('a nested style file is visible as planned, not silently dropped', (t) => {
  const root = pluginDir({ 'output-styles/nested/deep.md': '---\nname: deep\n---\n\nBody.\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const ir = readClaudePlugin(root)
  const [style] = ir.pending.filter((row) => row.surface === 'outputStyles')
  assert.equal(style.name, 'deep')
  assert.equal(style.sourcePath, 'output-styles/nested/deep.md')
  assert.equal(style.annotation.fidelity, 'planned')
  assert.equal(ir.outputStyles.length, 0, 'outside the flat surface means no body claim')
  assert.match(style.annotation.reason, /outside the flat/)
  assert.match(style.annotation.reason, /invocation\.agent\.ctx/)
})
