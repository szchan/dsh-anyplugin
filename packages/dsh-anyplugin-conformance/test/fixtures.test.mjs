/**
 * End-to-end: re-probe every oracle-backed fixture with the installed upstream
 * CLI and diff against its committed golden. This is the test that turns
 * "100 %" into a number: it fails when the pin moves and behavior changes.
 *
 * Resolution lives in `resolveClaudeBinary()` (D24): `CLAUDE_BIN`, then
 * `claude` on PATH. Locally, no CLI means a named skip; under CI it throws,
 * because a skipped fidelity test on CI is a bug.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeInventory, diffInventories } from '../src/inventory.ts'
import {
  claudeSkipReason,
  claudeVersion,
  probeWithClaude,
  resolveClaudeBinary,
} from '../src/oracles/claude.ts'
import { readInventoryFile } from '../src/oracles/file.ts'
import { CLAUDE_CODE_PIN } from '../src/pin.ts'
import { HAND_AUTHORED_FIXTURES } from '../../../scripts/hand-authored-fixtures.mjs'

const root = new URL('..', import.meta.url).pathname
const repoRoot = join(root, '../..')
const fixturesDir = join(repoRoot, 'fixtures')
const skip = claudeSkipReason()

const claude = resolveClaudeBinary()

/**
 * Fixtures no upstream command can inventory. The list lives in
 * `scripts/hand-authored-fixtures.mjs` so the capture command and this test
 * read one source of truth: `claude-output-styles` is hand-authored because
 * at the pin `claude plugin details` prints no output-style line (D29), so an
 * `.inventory` golden would be a hand-written row pretending to have been
 * observed. Its evidence is the body hash in `output-styles-carry.test.mjs`.
 * The tests below assert the README label, the absence of a golden, the
 * capture skip, and the live oracle's silence, so the exclusion cannot go
 * stale silently.
 */

/**
 * Fixtures that are evidence, not plugins: the client's captured monitor error
 * lines. They have no manifest and no inventory for the oracle to re-probe; the
 * dialect tests own them.
 */
const EVIDENCE_ONLY_FIXTURES = new Set(['claude-monitors-errors'])

async function fixtureDirs() {
  const entries = await readdir(fixturesDir)
  const dirs = []
  for (const entry of entries.sort()) {
    if (!entry.startsWith('claude-')) continue
    if (HAND_AUTHORED_FIXTURES.has(entry)) continue
    if (EVIDENCE_ONLY_FIXTURES.has(entry)) continue
    const dir = join(fixturesDir, entry)
    if ((await stat(dir)).isDirectory()) dirs.push({ name: entry, dir })
  }
  return dirs
}

test('a hand-authored fixture says so and has no invented golden', () => {
  for (const name of HAND_AUTHORED_FIXTURES.keys()) {
    const dir = join(fixturesDir, name)
    assert.ok(existsSync(join(dir, '.claude-plugin', 'plugin.json')), `${name}: a fixture is still a plugin`)
    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    assert.match(readme, /Hand-authored, not observed/, `${name}: the README must label the fixture as hand-authored`)
    assert.equal(
      existsSync(join(dir, '.inventory')),
      false,
      `${name}: no oracle can produce this inventory; do not invent a golden for it`,
    )
  }
})

test('the capture command refuses to invent a golden for a hand-authored fixture', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'anyplugin-capture-'))
  try {
    const copy = join(tempDir, 'claude-output-styles')
    cpSync(join(fixturesDir, 'claude-output-styles'), copy, { recursive: true })
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts/capture-fixtures.mjs'), '--fixtures-dir', tempDir, 'claude-output-styles'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /claude-output-styles: skipped \(hand-authored fixture;/)
    assert.match(result.stdout, /no output-style line/)
    assert.equal(
      existsSync(join(copy, '.inventory')),
      false,
      'capture must not write a golden for a hand-authored fixture',
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test(
  'the pinned CLI cannot see output styles, which is why the fixture has no golden',
  { skip: claude ? false : skip },
  async () => {
    const probe = await probeWithClaude({ pluginDir: join(fixturesDir, 'claude-output-styles'), bin: claude.bin })
    assert.ok(probe.raw.length > 0, 'the probe produced no report')
    assert.match(probe.raw, /Component inventory/, 'the probe ran and printed an inventory')
    assert.doesNotMatch(
      probe.raw,
      /^\s*Output styles?\s*\(/im,
      'the pin grew an output-style inventory line; re-review this fixture (D29)',
    )
    assert.equal(
      probe.inventory.components.some((component) => component.surface === 'outputStyles'),
      false,
      'the oracle must not report an outputStyles component at this pin',
    )
  },
)

test(
  `the resolved claude reports ${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`,
  { skip: claude ? false : skip },
  async () => {
    const actual = `${CLAUDE_CODE_PIN.tool}@${await claudeVersion(claude.bin)}`
    const expected = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`
    assert.equal(
      actual,
      expected,
      `${claude.bin} reports ${actual}; the goldens are pinned to ${expected} — install the pin (node scripts/fetch-claude.mjs) or re-capture the goldens (D8)`,
    )
  },
)

test('every fixture matches its golden inventory', { skip: claude ? false : skip }, async (t) => {
  const expectedGolden = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}.json`
  // Point the ambient resolver at a decoy that can never produce a report. If
  // the probe ignores its explicit `bin`, it picks the decoy and this test goes
  // red; passing the real binary is therefore observable, not an echo.
  const previousClaudeBin = process.env.CLAUDE_BIN
  const decoyDir = mkdtempSync(join(tmpdir(), 'anyplugin-decoy-'))
  const decoy = join(decoyDir, 'claude')
  writeFileSync(decoy, '#!/bin/sh\necho "decoy: explicit bin was ignored" >&2\nexit 3\n')
  chmodSync(decoy, 0o755)
  process.env.CLAUDE_BIN = decoy
  try {
    for (const fixture of await fixtureDirs()) {
      const goldensDir = join(fixture.dir, '.inventory')
      const goldens = (await readdir(goldensDir)).filter((file) => file.endsWith('.json'))
      assert.ok(goldens.length > 0, `${fixture.name} has no golden inventory`)
      assert.ok(
        goldens.includes(expectedGolden),
        `${fixture.name}: no ${expectedGolden} golden (found ${goldens.join(', ')}) — capture the pin before claiming conformance`,
      )
      for (const golden of goldens) {
        await t.test(`${fixture.name} @ ${golden}`, async () => {
          const expected = await readInventoryFile(join(goldensDir, golden))
          const probe = await probeWithClaude({ pluginDir: fixture.dir, bin: claude.bin })
          assert.ok(probe.raw.length > 0, `probe of ${fixture.name} returned no report`)
          assert.equal(
            probe.bin,
            claude.bin,
            `probe reported ${probe.bin} but was asked for ${claude.bin}; the oracle must be the resolved pin (D24)`,
          )
          const actual = normalizeInventory({ ...probe.inventory, pin: probe.pin })
          const report = diffInventories(expected, actual)
          assert.ok(report.ok, JSON.stringify(report.rows.filter((row) => row.status !== 'match'), null, 2))
        })
      }
    }
  } finally {
    if (previousClaudeBin === undefined) delete process.env.CLAUDE_BIN
    else process.env.CLAUDE_BIN = previousClaudeBin
    rmSync(decoyDir, { recursive: true, force: true })
  }
})
