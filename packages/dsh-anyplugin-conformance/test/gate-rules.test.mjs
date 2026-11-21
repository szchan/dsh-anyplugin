// R14 and R15 exist because a number in this repository is a claim. These
// tests construct the counter-example each rule is supposed to reject — an
// orphan fixture directory, a stale exclusion, a count with no owning test —
// so the rule fails for the right reason and not only because the tree happens
// to be clean. The scripts themselves call the same helpers; the mutation that
// reddens `npm run check:arch` / `check:features` is in the ticket's PR body.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  EXCLUSIONS_FILE,
  EXPECTED_ROWS_FILE,
  FIXTURE_EXCLUSIONS,
  expectedRowFixtures,
  fixtureViolations,
  fixturesDir,
  topLevelFixtures,
} from '../../../scripts/fixture-ratchet.mjs'
import { countOwnerViolations, ownedCounts } from '../../../scripts/count-owners.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))

test('R14: a fixture directory in neither the ratchet nor the exclusion table is a violation', () => {
  const violations = fixtureViolations({
    fixtures: ['claude-agents', 'hooks', 'zzz-orphan'],
    rows: ['claude-agents'],
    exclusions: { hooks: 'owned by hooks.test.mjs' },
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].fixture, 'zzz-orphan')
  assert.match(violations[0].message, /no EXPECTED_ROWS entry/u)
  assert.match(violations[0].message, new RegExp(EXCLUSIONS_FILE.replaceAll('.', '\\.'), 'u'))
  assert.match(violations[0].message, new RegExp(EXPECTED_ROWS_FILE.replaceAll('.', '\\.'), 'u'))
})

test('R14: an exclusion for a fixture that is gone is stale, and one without a reason is empty', () => {
  const stale = fixtureViolations({
    fixtures: ['claude-agents'],
    rows: ['claude-agents'],
    exclusions: { ghost: 'owned by ghost.test.mjs' },
  })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].fixture, 'ghost')
  assert.match(stale[0].message, /does not exist/u)

  const empty = fixtureViolations({ fixtures: ['ghost'], rows: [], exclusions: { ghost: '  ' } })
  assert.equal(empty.length, 1)
  assert.equal(empty[0].fixture, 'ghost')
  assert.match(empty[0].message, /no reason/u)
})

test('R14: the real tree is accounted for by rows plus the six named exclusions', () => {
  const fixtures = topLevelFixtures(fixturesDir(root))
  const rows = expectedRowFixtures(readFileSync(join(root, EXPECTED_ROWS_FILE), 'utf8'))
  assert.ok(fixtures.length >= 14)
  assert.ok(rows.length >= 11)
  assert.deepEqual(fixtureViolations({ fixtures, rows, exclusions: FIXTURE_EXCLUSIONS }), [])
})

test('R15: a count in a paragraph without an owning test is a violation', () => {
  const text = [
    'The one number the project reports: **25 declared / 24 matched / 0 missing / 1 refused** rows',
    'in the coverage ratchet (`packages/dsh-anyplugin-conformance/test/coverage.test.mjs`).',
    '',
    'Across 14 fixtures.',
    '',
    '| rows | owner |',
    '| --- | --- |',
    '| 25 declared | `packages/dsh-anyplugin-conformance/test/coverage.test.mjs` |',
  ].join('\n')
  const violations = countOwnerViolations(text)
  assert.equal(violations.length, 1)
  assert.match(violations[0].claim, /14 fixtures/u)
  assert.equal(violations[0].line, 4)
  assert.equal(ownedCounts(text), 2, 'the intro paragraph and the table own their counts')
})

test('R15: a count whose paragraph names the test passes, and a heading is not a claim', () => {
  const owned = 'The ratchet: 25 declared, see `packages/dsh-anyplugin-conformance/test/coverage.test.mjs`.'
  assert.deepEqual(countOwnerViolations(owned), [])
  assert.deepEqual(countOwnerViolations('## 3 tests\n\nprose without a number\n'), [])
  assert.equal(ownedCounts('## 3 tests\n\nprose'), 0)
})

test('R15: every non-decisions doc currently owns its counts', () => {
  const failures = []
  for (const name of ['FEATURES.md', 'ARCHITECTURE.md', 'TODO.md', 'WORKFLOW.md', 'TRIAGE.md', 'CONFORMANCE.md']) {
    const text = readFileSync(join(root, 'docs', name), 'utf8')
    for (const violation of countOwnerViolations(text)) failures.push(`${name}:${violation.line}: ${violation.message}`)
  }
  assert.deepEqual(failures, [])
})
