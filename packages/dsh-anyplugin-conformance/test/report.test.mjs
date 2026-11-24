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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { defaultMaterializers } from '../../dsh-anyplugin-emit/src/index.ts'
import { buildTransplantReport, formatTransplantReport } from '../src/report.ts'
import { classify, emptyGrants, grant, pluginIdentity } from '../../dsh-anyplugin-trust/src/index.ts'
import { loadEffectiveModelMap } from '../../dsh-anyplugin-model-map/src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'claude-commands-flat')
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))

// The same shipped set `rig report` passes, so the library test and the CLI
// test agree on what "skipped" can mean.
const materializers = defaultMaterializers()

function grantsFor(ir) {
  let grants = emptyGrants()
  for (const row of classify(ir)) {
    grants = grant(grants, { plugin: pluginIdentity(ir), ...row }, { scope: 'user' })
  }
  return grants
}

function runRig(args) {
  return spawnSync(process.execPath, [rigPath, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

test('the flat command fixture reports planned components on two D10 faces', () => {
  const report = buildTransplantReport(readClaudePlugin(fixture), { materializers })

  assert.equal(report.ok, true)
  assert.equal(report.plugin, 'commands-flat')
  assert.deepEqual(report.pin, { tool: CLAUDE_CODE_PIN.tool, version: CLAUDE_CODE_PIN.version })
  assert.deepEqual(report.totals, { declared: 2, emitted: 2, refused: 0, skipped: 0 })
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

test('the text report prints each face and the totals aggregated from its rows', () => {
  const text = formatTransplantReport(buildTransplantReport(readClaudePlugin(fixture), { materializers }))

  assert.ok(text.includes(`plugin: commands-flat  pin: ${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`))
  assert.match(text, /^skills\/migrate {2}class=planned {2}carry=emitted$/m)
  assert.match(text, /^skills\/review {2}class=planned {2}carry=emitted$/m)
  assert.match(text, /^ {2}face model=equivalent {2}reason: \S/m)
  assert.match(text, /^ {2}face human=planned {2}reason: \S/m)
  assert.match(text, /^totals: 2 declared, 2 emitted, 0 refused, 0 skipped$/m)
  assert.match(text, /^validation: PASS$/m)
})

test('totals agree with the carry column when no component is a skill', () => {
  // Regression for the number that used to come from `ir.skills.length`: hooks
  // and MCP servers can be carried, so a totals line derived from skills alone
  // contradicted the rows above it.
  const hooksIr = readClaudePlugin(join(repoRoot, 'fixtures', 'claude-hooks-mcp'))
  const report = buildTransplantReport(hooksIr, { materializers, grants: grantsFor(hooksIr) })

  assert.equal(report.ok, true)
  assert.deepEqual(
    report.components.map((component) => [component.surface, component.carried]),
    [
      ['hooks', true],
      ['mcpServers', true],
    ],
  )
  const emitted = report.components.filter((component) => component.carried).length
  assert.equal(report.totals.declared, report.components.length)
  assert.equal(report.totals.emitted, emitted)
  assert.equal(report.totals.skipped, report.components.length - emitted - report.totals.refused)
  assert.deepEqual(report.totals, { declared: 2, emitted: 2, refused: 0, skipped: 0 })
  assert.match(formatTransplantReport(report), /^totals: 2 declared, 2 emitted, 0 refused, 0 skipped$/m)
})

test('rig report prints the compile-side report as JSON', () => {
  const result = runRig(['report', 'fixtures/claude-commands-flat', '--json'])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.pin.version, CLAUDE_CODE_PIN.version)
  // A plugin-directory report annotates and reports in one run, so its map is
  // the map the IR was built against; the `--ir` provenance caveat must not leak
  // into this path.
  assert.equal(typeof report.preview, 'string')
  assert.doesNotMatch(report.preview, /ambient model map/)
  assert.deepEqual(report.totals, { declared: 2, emitted: 2, refused: 0, skipped: 0 })
  assert.deepEqual(
    report.components.map((component) => [component.name, component.class, component.carried]),
    [
      ['migrate', 'planned', true],
      ['review', 'planned', true],
    ],
  )

  // A documented flag must work before the positional too.
  const reordered = runRig(['report', '--json', 'fixtures/claude-commands-flat'])
  assert.equal(reordered.status, 0, reordered.stderr)
  assert.deepEqual(JSON.parse(reordered.stdout).totals, { declared: 2, emitted: 2, refused: 0, skipped: 0 })
})

test('rig report carries the agent fixture through the shipped materializer set', () => {
  // The CLI used to keep its own three-entry literal, so it printed this
  // fixture as `emitted: 0, skipped: 2` while the build could place it. The
  // report now asks emit with DEFAULT_MATERIALIZERS (R11).
  const result = runRig(['report', 'fixtures/claude-agents', '--json'])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.deepEqual(report.totals, { declared: 2, emitted: 1, refused: 0, skipped: 1 })
  assert.deepEqual(
    report.components.map((component) => [component.surface, component.name, component.carried]),
    [
      ['agents', 'reviewer', true],
      ['agents', 'planner', false],
    ],
  )
  assert.deepEqual(
    report.components[0].faces.map((face) => [face.face, face.class]),
    [
      ['catalog', 'exact'],
      ['invocation', 'equivalent'],
      // S16: a frontmatter tool list is declared, not enforced — the child
      // still sees every host tool, so the face is unsupported, not planned.
      ['tools', 'unsupported'],
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
    // The IR carries no model-map provenance, so the CLI has to say that the
    // effectiveMapping it prints is the ambient document, not the map this IR
    // was annotated against (known gap; see report.ts).
    assert.match(result.stdout, /^preview only: .*--ir: effectiveMapping is the ambient model map at report time/m)
    assert.match(result.stdout, /^skills\/migrate {2}class=planned {2}carry=skipped$/m)
    assert.match(result.stdout, /^skills\/review {2}class=planned {2}carry=emitted$/m)
    assert.match(result.stdout, /^totals: 2 declared, 1 emitted, 0 refused, 1 skipped$/m)
    assert.match(result.stdout, /^problems: 1$/m)
    assert.match(result.stdout, /skill "migrate": planned nodes must not sit in the emittable lists/)
    assert.match(result.stdout, /^validation: FAIL$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig report treats a non-IR file as a usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-report-'))
  try {
    const irPath = join(dir, 'not-an-ir.json')
    writeFileSync(irPath, '{}\n', 'utf8')

    const result = runRig(['report', '--ir', irPath])

    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /--ir: expected a ClaudePluginIr/)
    assert.doesNotMatch(result.stderr, /not iterable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bare skills/<name>.md is skipped, not claimed carried', () => {
  // The dialect records this as `unsupported` (surface `skills`) but never puts
  // it in `ir.skills`, so emit never considers it. The report used to mark the
  // row carried because the surface was carried; `considered` closes that gap.
  const dir = mkdtempSync(join(tmpdir(), 'rig-report-'))
  try {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'legacy-skill', version: '0.0.1' }, null, 2)}\n`,
      'utf8',
    )
    mkdirSync(join(dir, 'skills', 'good'), { recursive: true })
    writeFileSync(
      join(dir, 'skills', 'good', 'SKILL.md'),
      '---\nname: good\ndescription: A skill the host loads.\n---\nSay hello.\n',
      'utf8',
    )
    writeFileSync(join(dir, 'skills', 'legacy.md'), '---\ndescription: A bare DSH-style skill.\n---\nBare.\n', 'utf8')

    const result = runRig(['report', dir])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^skills\/good {2}class=equivalent {2}carry=emitted$/m)
    assert.match(result.stdout, /^skills\/legacy {2}class=unsupported {2}carry=skipped$/m)
    assert.match(result.stdout, /^totals: 2 declared, 1 emitted, 0 refused, 1 skipped$/m)
    assert.match(result.stdout, /^validation: PASS$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig report --help names the subcommand', () => {
  const result = runRig(['report', '--help'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /rig report {2}<plugin-dir> \[--json\]/)
})

test('rig report calls itself a preview, in text and in JSON', () => {
  const text = runRig(['report', fixture])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /^preview only: rig report does not read installs\.yml/m)

  const json = runRig(['report', fixture, '--json'])
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout)
  assert.match(
    parsed.preview,
    /^preview only: rig report does not read installs\.yml/,
    'a preview must not be readable as the controller install decision',
  )
})

// D91: every report carries the effective model map, so a user can see which
// route an agent alias resolves to and where that document came from.
test('report carries the effective model map, in JSON shape and as one text line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-report-model-map-'))
  try {
    const env = { ANYPLUGIN_MODEL_MAP: join(dir, 'missing.json') }
    const modelMap = loadEffectiveModelMap({ env, homedir: dir })
    const ir = readClaudePlugin(fixture, { source: 'plugin-dir:test', modelMap })
    const report = buildTransplantReport(ir, { materializers, modelMap })

    assert.deepEqual(report.effectiveMapping.path, join(dir, 'missing.json'))
    assert.equal(report.effectiveMapping.document, null)
    assert.deepEqual(report.effectiveMapping.overrides, [])
    assert.deepEqual(report.effectiveMapping.problems, [])
    assert.deepEqual(
      report.effectiveMapping.entries.map((entry) => entry.alias),
      ['haiku', 'opus', 'sonnet'],
    )
    // The report is JSON-serializable with the section in place.
    assert.match(JSON.stringify(report), /"effectiveMapping"/)

    const text = formatTransplantReport(report)
    assert.match(text, /^model-map: .*missing\.json/m)
    assert.match(text, /opus -> deepseek-account\/deepseek-flash @ max \(default\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('report shows a user override and a malformed document visibly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-report-model-map-user-'))
  try {
    const path = join(dir, 'map.json')
    writeFileSync(path, '{"models":{"sonnet":{"provider":"acme","model":"acme-flash","effort":"low"}}}')
    const modelMap = loadEffectiveModelMap({ env: { ANYPLUGIN_MODEL_MAP: path }, homedir: dir })
    const report = buildTransplantReport(readClaudePlugin(fixture, { modelMap }), { materializers, modelMap })
    assert.deepEqual(report.effectiveMapping.overrides, ['sonnet'])
    assert.match(formatTransplantReport(report), /sonnet -> acme\/acme-flash @ low \(user\)/)

    writeFileSync(path, '{"models":{"sonnet":{"model":"m","effort":"turbo"}}}')
    const malformed = loadEffectiveModelMap({ env: { ANYPLUGIN_MODEL_MAP: path }, homedir: dir })
    const broken = buildTransplantReport(readClaudePlugin(fixture, { modelMap: malformed }), {
      materializers,
      modelMap: malformed,
    })
    assert.equal(broken.effectiveMapping.problems.length, 1)
    assert.match(formatTransplantReport(broken), /problems: .*unknown effort "turbo"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
