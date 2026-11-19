/**
 * Compile-side report: what the transplant would do to a plugin, from a fresh
 * dialect + emit run. The pinned fixture is the load-bearing case — a command
 * has two faces, and D10 says the model face is equivalent while the human face
 * is planned, which makes the component overall planned but still emitted.
 *
 * No installed harness is involved: the dialect reads files and emit is pure
 * data, so this runs anywhere.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { buildTransplantReport, formatTransplantReport } from '../src/report.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'claude-commands-flat')
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))

// The same shipped set `rig report` passes, so the library test and the CLI
// test agree on what "skipped" can mean.
const materializers = {
  skill: new URL('../../dsh-anyplugin-materialize-skill/src/index.ts', import.meta.url).href,
  mcp: new URL('../../dsh-anyplugin-materialize-mcp/src/index.ts', import.meta.url).href,
  hooks: new URL('../../dsh-anyplugin-materialize-hook/src/index.ts', import.meta.url).href,
}

function runRig(args) {
  return spawnSync(process.execPath, [rigPath, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

test('the flat command fixture reports planned components on two D10 faces', () => {
  const report = buildTransplantReport(readClaudePlugin(fixture), { materializers })

  assert.equal(report.ok, true)
  assert.equal(report.plugin, 'commands-flat')
  assert.deepEqual(report.pin, { tool: 'claude-code', version: '2.1.322' })
  assert.deepEqual(report.totals, { declared: 2, emittable: 2, skipped: 0 })
  assert.deepEqual(
    report.components.map((component) => [component.surface, component.name, component.class, component.carried]),
    [
      ['skills', 'migrate', 'planned', true],
      ['skills', 'review', 'planned', true],
    ],
  )
  for (const component of report.components) {
    assert.ok(component.reason.trim().length > 0, `${component.name}: empty reason`)
    assert.deepEqual(
      component.faces.map((face) => [face.face, face.class]),
      [
        ['model', 'equivalent'],
        ['human', 'planned'],
      ],
      `${component.name}: faces`,
    )
    for (const face of component.faces) {
      assert.ok(face.reason.trim().length > 0, `${component.name} ${face.face}: empty reason`)
    }
  }
})

test('the text report prints each face and the summarizeIr totals', () => {
  const text = formatTransplantReport(buildTransplantReport(readClaudePlugin(fixture), { materializers }))

  assert.match(text, /^plugin: commands-flat {2}pin: claude-code@2\.1\.322$/m)
  assert.match(text, /^skills\/migrate {2}class=planned {2}carry=emitted$/m)
  assert.match(text, /^skills\/review {2}class=planned {2}carry=emitted$/m)
  assert.match(text, /^ {2}face model=equivalent {2}reason: \S/m)
  assert.match(text, /^ {2}face human=planned {2}reason: \S/m)
  assert.match(text, /^totals: 2 declared, 2 emittable, 0 skipped$/m)
  assert.match(text, /^result: PASS$/m)
})

test('rig report prints the compile-side report as JSON', () => {
  const result = runRig(['report', 'fixtures/claude-commands-flat', '--json'])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.pin.version, '2.1.322')
  assert.deepEqual(report.totals, { declared: 2, emittable: 2, skipped: 0 })
  assert.deepEqual(
    report.components.map((component) => [component.name, component.class, component.carried]),
    [
      ['migrate', 'planned', true],
      ['review', 'planned', true],
    ],
  )
})

test('rig report fails on an IR that violates the contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-report-'))
  try {
    const ir = readClaudePlugin(fixture)
    // A planned model face in the emittable list is exactly what validateIr
    // refuses; without the `--ir` path the CLI could never reach this branch.
    delete ir.skills[0].faces
    ir.skills[0].annotation = { fidelity: 'planned', reason: 'probe: planned nodes must not sit in the emittable lists' }
    const irPath = join(dir, 'invalid-ir.json')
    writeFileSync(irPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf8')

    const result = runRig(['report', '--ir', irPath])

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /^skills\/migrate {2}class=planned {2}carry=skipped$/m)
    assert.match(result.stdout, /^skills\/review {2}class=planned {2}carry=emitted$/m)
    assert.match(result.stdout, /^problems: 1$/m)
    assert.match(result.stdout, /skill "migrate": planned nodes must not sit in the emittable lists/)
    assert.match(result.stdout, /^result: FAIL$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig report --help names the subcommand', () => {
  const result = runRig(['report', '--help'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /rig report {2}<plugin-dir> \[--json\]/)
})
