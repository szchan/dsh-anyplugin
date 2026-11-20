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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const root = new URL('..', import.meta.url).pathname
const fixturesDir = join(root, '../../fixtures')
const skip = claudeSkipReason()

const claude = resolveClaudeBinary()

/**
 * Fixtures no upstream command can inventory. `claude-output-styles` is
 * hand-authored: at the pin, `claude plugin details` prints no output-style
 * line (D29), so an `.inventory` golden would be a hand-written row pretending
 * to have been observed. Its evidence is the body hash in
 * `output-styles-carry.test.mjs`; this set only keeps the oracle loop from
 * demanding a golden. The test below asserts both the README label and the
 * absence of a golden, so the exclusion cannot go stale silently.
 */
const HAND_AUTHORED = new Set(['claude-output-styles'])

async function fixtureDirs() {
  const entries = await readdir(fixturesDir)
  const dirs = []
  for (const entry of entries.sort()) {
    if (!entry.startsWith('claude-')) continue
    if (HAND_AUTHORED.has(entry)) continue
    const dir = join(fixturesDir, entry)
    if ((await stat(dir)).isDirectory()) dirs.push({ name: entry, dir })
  }
  return dirs
}

test('a hand-authored fixture says so and has no invented golden', () => {
  for (const name of HAND_AUTHORED) {
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
