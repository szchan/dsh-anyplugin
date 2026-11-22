// R14 support: every fixture directory is accounted for.
//
// A fixture is a claim: the conformance rig transplants it and the coverage
// test says which rows it produces. A directory that no row mentions and no
// exclusion names is a fixture nobody asserts anything about — it can rot,
// and the ratchet will not notice. `scripts/check-architecture.mjs` fails on
// it, and on the reverse: an exclusion naming a fixture that no longer
// exists is a stale reason that reads as coverage.
//
// Imported by `scripts/check-architecture.mjs`; exported so the rule has a
// unit test (`packages/dsh-anyplugin-conformance/test/gate-rules.test.mjs`)
// that can construct both counter-examples without touching the tree.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Directories directly under `fixtures/`, sorted. Nested files are theirs. */
export function topLevelFixtures(fixturesDir) {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** The quoted keys of `const EXPECTED_ROWS = { … }` in the coverage test. */
export function expectedRowFixtures(source) {
  const block = /const EXPECTED_ROWS = \{([\s\S]*?)\n\}/u.exec(source)
  if (block === null) return []
  return [...block[1].matchAll(/^\s*'([^']+)':/gmu)].map((match) => match[1])
}

/**
 * Fixtures that own their assertions outside the coverage ratchet.
 *
 * Each reason names the test that reads the directory. The coverage ratchet
 * counts transplanted rows; these fixtures answer different questions (a
 * seam's observed payload, the trace reader, the mod host) and their claims
 * live in those tests. An exclusion is not "no test": it is a different owner.
 */
export const FIXTURE_EXCLUSIONS = {
  'claude-hooks-fanout': 'hook fan-out and matcher ordering: packages/dsh-anyplugin-conformance/test/hooks.test.mjs',
  'claude-monitors-bad-when-enum': 'file-shaped monitors rejection with no sibling component to inventory (Skills (0)), owned by the unsupported-row tests: packages/dsh-anyplugin-dialect-claude-code/test/monitors.test.mjs',
  'claude-monitors-errors':
    'captured client error-text corpus for the monitors dialect, not a plugin: packages/dsh-anyplugin-dialect-claude-code/test/monitors.test.mjs',
  'claude-monitors-bad-when-short': 'file-shaped monitors rejection with no sibling component to inventory (Skills (0)), owned by the unsupported-row tests: packages/dsh-anyplugin-dialect-claude-code/test/monitors.test.mjs',
  'claude-output-styles': 'output-style activation carry: packages/dsh-anyplugin-conformance/test/output-styles-carry.test.mjs',
  'claude-output-styles-activation': 'output-style activation at agent start: packages/dsh-anyplugin-conformance/test/output-styles-activation.test.mjs',
  'codex-portable': 'the codex dialect fixture: packages/dsh-anyplugin-conformance/test/codex.test.mjs',
  hooks: 'raw hook payload fixtures: packages/dsh-anyplugin-conformance/test/hooks.test.mjs and inventory.test.mjs',
  'marketplace-local': 'the hand-authored catalog and its local plugin: packages/dsh-anyplugin-conformance/test/marketplace.test.mjs',
  mods: 'the mod ABI fixtures: packages/dsh-anyplugin-conformance/test/mods.test.mjs, mod-scan.test.mjs, trust.test.mjs and upstream-mods.test.mjs',
  traces: 'reader fixtures for captured traces: packages/dsh-anyplugin-conformance/test/trace.test.mjs',
}

export const EXPECTED_ROWS_FILE = 'packages/dsh-anyplugin-conformance/test/coverage.test.mjs'
export const EXCLUSIONS_FILE = 'scripts/fixture-ratchet.mjs'

/**
 * One violation per orphaned fixture, stale exclusion or reasonless exclusion.
 * `file` is what the architecture check reports as the location.
 */
export function fixtureViolations({ fixtures, rows, exclusions = FIXTURE_EXCLUSIONS, ownerExists = () => true }) {
  const rowSet = new Set(rows)
  const fixtureSet = new Set(fixtures)
  const violations = []
  for (const fixture of fixtures) {
    if (rowSet.has(fixture)) continue
    if (Object.prototype.hasOwnProperty.call(exclusions, fixture)) continue
    violations.push({
      fixture,
      message: `fixtures/${fixture} has no EXPECTED_ROWS entry in ${EXPECTED_ROWS_FILE} and no exclusion in ${EXCLUSIONS_FILE}; add a row or name the test that owns it`,
    })
  }
  for (const fixture of rows) {
    if (fixtureSet.has(fixture)) continue
    violations.push({
      fixture,
      file: EXPECTED_ROWS_FILE,
      message: `EXPECTED_ROWS names fixtures/${fixture}, which does not exist; a row cannot own a directory that is gone`,
    })
  }
  for (const [fixture, reason] of Object.entries(exclusions)) {
    if (!fixtures.includes(fixture)) {
      violations.push({
        fixture,
        file: EXCLUSIONS_FILE,
        message: `the exclusion for fixtures/${fixture} names a directory that does not exist; remove the stale reason`,
      })
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      violations.push({
        fixture,
        file: EXCLUSIONS_FILE,
        message: `the exclusion for fixtures/${fixture} has no reason; name the test that owns it`,
      })
      continue
    }
    // A reason is only an owner if the test it names exists. A path-shaped
    // string is not evidence.
    const owners = [...reason.matchAll(/[\w./-]+\.test\.mjs\b/gu)].map((match) => match[0])
    if (owners.length === 0) {
      violations.push({
        fixture,
        file: EXCLUSIONS_FILE,
        message: `the exclusion for fixtures/${fixture} names no .test.mjs owner; name the test that reads it`,
      })
      continue
    }
    const missing = owners.filter((owner) =>
      !ownerExists(owner.includes('/') ? owner : `packages/dsh-anyplugin-conformance/test/${owner}`),
    )
    if (missing.length > 0) {
      violations.push({
        fixture,
        file: EXCLUSIONS_FILE,
        message: `the exclusion for fixtures/${fixture} names ${missing.join(', ')}, which does not exist; point at the test that owns it`,
      })
    }
  }
  return violations
}

export function fixturesDir(repoRoot) {
  return join(repoRoot, 'fixtures')
}
