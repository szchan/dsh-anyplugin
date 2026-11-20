/**
 * The F1 fixture: an output style is prompt text, and the pinned host cannot
 * observe it — `claude plugin details` at the 2.1.322 pin prints no output-style line
 * (D29), so there is no golden to diff. What can be asserted is the carry
 * itself: each `output-styles/*.md` body reaches the IR byte for byte and the
 * report still calls the row `planned` with every activation gap named.
 *
 * The body hash is not ceremony. A `planned` row says "not applied yet", not
 * "may drift": if the dialect normalizes a newline here, the eventual
 * materializer would apply different prompt text than the author wrote.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { isCarried, validateIr } from '../../dsh-anyplugin-ir/src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'claude-output-styles')
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Extract the body with a line splitter rather than the dialect's frontmatter
 * regex. The point of the comparison is that two independent readers agree on
 * the same bytes.
 */
function bodyOf(raw) {
  const lines = raw.split('\n')
  const text = (line) => line.replace(/\r$/, '')
  assert.equal(text(lines[0]), '---', 'the fixture opens with frontmatter')
  const close = lines.findIndex((line, index) => index > 0 && text(line) === '---')
  assert.ok(close > 0, 'the fixture closes its frontmatter')
  return lines.slice(close + 1).join('\n')
}

function runRig(args) {
  return spawnSync(process.execPath, [rigPath, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

function assertNamesEveryGap(reason) {
  assert.match(reason, /invocation\.agent\.ctx/, 'the reachable seam is named')
  assert.match(reason, /complete: true/, 'the seam form that replaces the prompt is named')
  assert.match(reason, /S11/, 'the proof for the seam is named')
  assert.match(reason, /agent\/created/, 'the at-start provenance gap is named')
  assert.match(reason, /command-alias/, 'the activation gap is named')
  assert.match(reason, /D10/, 'the activation gap names its decision')
  assert.match(reason, /plugin details/, 'the oracle gap is named')
  assert.match(reason, /keep-coding-instructions/, 'the composition gap is named')
  assert.match(reason, /force-for-plugin/, 'the session-wide activation rule is named')
  assert.match(reason, /body is carried byte for byte/, 'the carry is not hidden by the planned class')
}

test('the fixture carries both identities as planned output-style rows', () => {
  const ir = readClaudePlugin(fixture)
  const rows = ir.outputStyles ?? []
  const byName = new Map(rows.map((row) => [row.name, row]))

  assert.equal(rows.length, 2, 'one row per style file')
  assert.deepEqual(
    [...byName.keys()].sort(),
    ['concise-review', 'plain'],
    'frontmatter name wins; a missing name falls back to the file stem',
  )
  assert.equal(byName.get('concise-review').sourcePath, 'output-styles/precise.md')
  assert.equal(byName.get('plain').sourcePath, 'output-styles/plain.md')
  assert.equal(byName.get('concise-review').description, 'Review code with short, evidence-first findings.')
  assert.equal(byName.get('plain').description, 'A terse style with no name; the file stem is the identity.')

  for (const style of rows) {
    assert.equal(style.surface, 'outputStyles')
    assert.equal(style.annotation.fidelity, 'planned')
    assert.equal(isCarried(style.annotation), false, 'carried bytes are not an emitted prompt')
    assertNamesEveryGap(style.annotation.reason)
  }

  assert.equal(
    ir.pending.some((row) => row.surface === 'outputStyles'),
    false,
    'a carried style is not also a pending placeholder',
  )
  assert.deepEqual(validateIr(ir), [], 'a planned row with a body is still a valid annotation')
})

test('each carried body equals the file byte for byte and hashes the same', () => {
  const rows = readClaudePlugin(fixture).outputStyles ?? []
  assert.equal(rows.length, 2, 'the fixture must exercise the hash, not an empty list')

  for (const style of rows) {
    const raw = readFileSync(join(fixture, style.sourcePath), 'utf8')
    const authored = bodyOf(raw)

    assert.equal(style.body, authored, `${style.name}: the IR body drifted from ${style.sourcePath}`)
    assert.ok(raw.endsWith(style.body), `${style.name}: the carried body is not the file's tail`)
    assert.equal(
      sha256(style.body),
      sha256(authored),
      `${style.name}: sha-256 of the carried body differs from sha-256 of the file body`,
    )
    assert.notEqual(style.body, '', `${style.name}: an empty body is not a carry`)
  }
})

test('rig report shows the rows, and --json carries the planned annotation', () => {
  const text = runRig(['report', 'fixtures/claude-output-styles'])
  assert.equal(text.status, 0, text.stderr)
  assert.ok(text.stdout.includes(`plugin: output-styles-fixture  pin: ${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`))
  assert.match(text.stdout, /^outputStyles\/concise-review {2}class=planned {2}carry=skipped$/m)
  assert.match(text.stdout, /^outputStyles\/plain {2}class=planned {2}carry=skipped$/m)
  assert.match(text.stdout, /^totals: 2 declared, 0 emitted, 0 refused, 2 skipped$/m)
  assert.match(text.stdout, /^validation: PASS$/m)
  assert.match(text.stdout, /reason: Output style "concise-review"/m)

  const json = runRig(['report', 'fixtures/claude-output-styles', '--json'])
  assert.equal(json.status, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.ok, true)
  assert.deepEqual(report.totals, { declared: 2, emitted: 0, refused: 0, skipped: 2 })
  const styles = report.components.filter((component) => component.surface === 'outputStyles')
  assert.deepEqual(styles.map((component) => component.name).sort(), ['concise-review', 'plain'])
  for (const component of styles) {
    assert.equal(component.class, 'planned')
    assert.equal(component.carried, false)
    assertNamesEveryGap(component.reason)
  }
})

test('the carry pins CRLF, a mid-body delimiter, and a missing trailing newline', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'anyplugin-output-style-bytes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'style-bytes', version: '0.0.1' })}\n`,
  )
  const bodies = {
    'output-styles/crlf.md': '---\r\ndescription: CRLF style\r\n---\r\n\r\nLine one\r\nLine two\r\n',
    'output-styles/mid-body-dashes.md': '---\ndescription: A dash in the body\n---\n\nBefore.\n---\nAfter.\n',
    'output-styles/no-trailing-newline.md':
      '---\ndescription: No trailing newline\n---\n\nLast line without a newline',
  }
  for (const [rel, raw] of Object.entries(bodies)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), raw)
  }

  const rows = new Map((readClaudePlugin(root).outputStyles ?? []).map((row) => [row.name, row]))
  for (const [rel, raw] of Object.entries(bodies)) {
    const name = rel.split('/').pop().replace(/\.md$/, '')
    const style = rows.get(name)
    assert.ok(style, `${name}: the file was not carried`)
    const authored = bodyOf(raw)
    assert.equal(style.body, authored, `${name}: the body bytes changed in the IR`)
    assert.equal(sha256(style.body), sha256(authored), `${name}: the carried body hashes differently`)
    assert.ok(raw.endsWith(style.body), `${name}: the carried body is not the file's tail`)
  }
})
