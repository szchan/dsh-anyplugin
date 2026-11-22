// R14 and R15 exist because a number in this repository is a claim. These
// tests construct the counter-example each rule is supposed to reject — an
// orphan fixture directory, a stale exclusion, a count with no owning test —
// so the rule fails for the right reason and not only because the tree happens
// to be clean. The scripts themselves call the same helpers; the mutation that
// reddens `npm run check:arch` / `check:features` is in the ticket's PR body.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
    ownerExists: () => true,
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
    ownerExists: () => true,
  })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].fixture, 'ghost')
  assert.match(stale[0].message, /does not exist/u)

  const empty = fixtureViolations({ fixtures: ['ghost'], rows: [], exclusions: { ghost: '  ' }, ownerExists: () => true })
  assert.equal(empty.length, 1)
  assert.equal(empty[0].fixture, 'ghost')
  assert.match(empty[0].message, /no reason/u)
})

test('R14: the real tree is accounted for by rows plus the six named exclusions', () => {
  const fixtures = topLevelFixtures(fixturesDir(root))
  const rows = expectedRowFixtures(readFileSync(join(root, EXPECTED_ROWS_FILE), 'utf8'))
  assert.ok(fixtures.length >= 14)
  assert.ok(rows.length >= 11)
  assert.deepEqual(
    fixtureViolations({
      fixtures,
      rows,
      exclusions: FIXTURE_EXCLUSIONS,
      ownerExists: (owner) => existsSync(join(root, owner)),
    }),
    [],
  )
})

test('R14: a fake owner and a row for a missing fixture are both violations', () => {
  const fake = fixtureViolations({
    fixtures: ['claude-agents'],
    rows: ['claude-agents'],
    exclusions: { 'claude-agents': 'covered by packages/dsh-anyplugin-conformance/test/does-not-exist.test.mjs' },
    ownerExists: (owner) => existsSync(join(root, owner)),
  })
  assert.equal(fake.length, 1)
  assert.match(fake[0].message, /does-not-exist\.test\.mjs, which does not exist/u)

  const ghostRow = fixtureViolations({
    fixtures: ['claude-agents'],
    rows: ['claude-agents', 'zzz-orphan'],
    exclusions: {},
    ownerExists: () => true,
  })
  assert.equal(ghostRow.length, 1)
  assert.equal(ghostRow[0].fixture, 'zzz-orphan')
  assert.match(ghostRow[0].message, /does not exist/u)

  const ownerless = fixtureViolations({
    fixtures: ['claude-agents'],
    rows: [],
    exclusions: { 'claude-agents': 'covered by prose' },
    ownerExists: () => true,
  })
  assert.equal(ownerless.length, 1)
  assert.match(ownerless[0].message, /names no \.test\.mjs owner/u)
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
  assert.equal(ownedCounts(text), 5, 'the four snapshot claims and the table row are verified')
})

test('R15: a count whose paragraph names the test passes, and a heading is a claim too', () => {
  const owned = 'The ratchet: 25 declared, see `packages/dsh-anyplugin-conformance/test/coverage.test.mjs`.'
  assert.deepEqual(countOwnerViolations(owned), [])
  assert.equal(ownedCounts(owned), 1)
  const heading = countOwnerViolations('## 3 tests\n\nprose without a number\n')
  assert.equal(heading.length, 1)
  assert.match(heading[0].claim, /3 tests/u)
  assert.equal(ownedCounts('## 3 tests\n\nprose'), 0)

  const fake = countOwnerViolations('The gate has 375 total tests, see `packages/dsh-anyplugin-conformance/test/does-not-exist.test.mjs`.')
  assert.equal(fake.length, 1)
  assert.match(fake[0].claim, /375 total tests/u)
  assert.match(fake[0].message, /does not exist/u)
})

test('R15: the doc number is compared with the owner, and an owner-only change reddens the doc', () => {
  const owner = (served) => ({
    ownerExists: () => true,
    readOwner: () => JSON.stringify({ totals: { methods: { served } } }),
  })
  const text = 'The bridge row states 26 served members (`fixtures/mods/coverage.json` `totals.methods`).'
  const stale = countOwnerViolations(text, owner(25))
  assert.equal(stale.length, 1)
  assert.match(stale[0].claim, /26 served/u)
  assert.match(
    stale[0].message,
    /"26 served" disagrees with its owner: the doc says 26, fixtures\/mods\/coverage\.json totals\.methods\.served says 25/u,
  )
  assert.deepEqual(countOwnerViolations(text, owner(26)), [])
})

test('R15: a claim with no owner citation is a violation', () => {
  const violations = countOwnerViolations('The bridge row states 26 served members.', {
    ownerExists: () => true,
    readOwner: () => '{}',
  })
  assert.equal(violations.length, 1)
  assert.match(violations[0].claim, /26 served/u)
  assert.match(violations[0].message, /names no owner file/u)
})

test('R15: a citation to a file that does not exist is a violation', () => {
  const violations = countOwnerViolations(
    'The bridge row states 26 served members (`fixtures/mods/does-not-exist.json` `totals.methods`).',
    {
      ownerExists: () => false,
      readOwner: () => {
        throw new Error('the checker must not read a file it knows is missing')
      },
    },
  )
  assert.equal(violations.length, 1)
  assert.match(violations[0].message, /fixtures\/mods\/does-not-exist\.json, which does not exist/u)
})

test('R15: a JSON citation without a section cannot be read', () => {
  const violations = countOwnerViolations('The bridge row states 26 served members (`fixtures/mods/coverage.json`).', {
    ownerExists: () => true,
    readOwner: () => JSON.stringify({ totals: { methods: { served: 26 } } }),
  })
  assert.equal(violations.length, 1)
  assert.match(violations[0].message, /without an object section/u)
})

test('R15: a test owner must export EXPECTED_COUNTS with the claim key', () => {
  const path = 'packages/dsh-anyplugin-conformance/test/coverage.test.mjs'
  const owner = (body) => ({ ownerExists: () => true, readOwner: () => body })
  const text = `The ratchet states 25 declared rows (\`${path}\`).`
  assert.deepEqual(countOwnerViolations(text, owner('export const EXPECTED_COUNTS = { declared: 25 }')), [])

  const stale = countOwnerViolations(text, owner('export const EXPECTED_COUNTS = { declared: 24 }'))
  assert.equal(stale.length, 1)
  assert.match(stale[0].message, /the doc says 25, .* EXPECTED_COUNTS\.declared says 24/u)

  const missing = countOwnerViolations(text, owner('export const EXPECTED_COUNTS = { served: 25 }'))
  assert.match(missing[0].message, /has no `declared`/u)

  const none = countOwnerViolations(text, owner('const EXPECTED_ROWS = {}'))
  assert.match(none[0].message, /declares no `EXPECTED_COUNTS` object/u)
})

test('R15: a claim is bound by its category noun, not by the nearest citation', () => {
  const ledger = JSON.stringify({
    totals: {
      renderSites: { served: 1, absent: 19 },
      namespaces: { served: 9, refusedOnly: 2, absent: 13 },
    },
  })
  const options = { ownerExists: () => true, readOwner: () => ledger }
  const text =
    'The host draws 1 served render site and 1 served namespace (`fixtures/mods/coverage.json` `totals.renderSites`).'
  const violations = countOwnerViolations(text, options)
  assert.equal(violations.length, 1, 'the render-site claim is right; the namespace claim must not reuse its 1')
  assert.match(violations[0].claim, /1 served/u)
  assert.match(violations[0].message, /namespace count but is certified by an owner of a different count/u)
  assert.match(violations[0].message, /cite fixtures\/mods\/coverage\.json totals\.namespaces/u)
})

test('R15: a member claim is not certified by the coverage test', () => {
  const text =
    'The bridge has 1 refused member (`packages/dsh-anyplugin-conformance/test/coverage.test.mjs`).'
  const violations = countOwnerViolations(text, {
    ownerExists: () => true,
    readOwner: () => 'export const EXPECTED_COUNTS = { refused: 1 }',
  })
  assert.equal(violations.length, 1)
  assert.match(violations[0].message, /member count but is certified by an owner of a different count/u)
  assert.match(violations[0].message, /cite fixtures\/mods\/coverage\.json totals\.methods/u)
})

test('R15: a section-less citation fails rather than borrowing a later section', () => {
  const text =
    'The bridge states 26 served members (`fixtures/mods/coverage.json`), and the totals live at (`fixtures/mods/coverage.json` `totals.methods`).'
  const violations = countOwnerViolations(text, {
    ownerExists: () => true,
    readOwner: () => JSON.stringify({ totals: { methods: { served: 26 } } }),
  })
  assert.equal(violations.length, 1)
  assert.match(violations[0].message, /without an object section/u)
})

test('R15: a table row cannot borrow the next row citation', () => {
  const text = [
    '| surface | claim |',
    '| --- | --- |',
    '| A | 3 served |',
    '| B | `fixtures/mods/coverage.json` `totals.methods` |',
  ].join('\n')
  const violations = countOwnerViolations(text, {
    ownerExists: () => true,
    readOwner: () => JSON.stringify({ totals: { methods: { served: 3 } } }),
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 3)
  assert.match(violations[0].message, /names no owner file/u)
})

test('R15: a mismatch reports the claim line, not the paragraph start', () => {
  const text = [
    'Intro.',
    '',
    'This paragraph starts here',
    'and runs for several lines',
    'before the claim appears:',
    'the ratchet states 25 declared rows (`packages/dsh-anyplugin-conformance/test/coverage.test.mjs`).',
  ].join('\n')
  const violations = countOwnerViolations(text, {
    ownerExists: () => true,
    readOwner: () => 'export const EXPECTED_COUNTS = { declared: 24, rows: 11 }',
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 6)
  assert.match(violations[0].message, /the doc says 25/u)
})

test('R15: every non-decisions doc currently owns its counts', () => {
  const failures = []
  for (const name of ['FEATURES.md', 'ARCHITECTURE.md', 'TODO.md', 'WORKFLOW.md', 'TRIAGE.md', 'CONFORMANCE.md']) {
    const text = readFileSync(join(root, 'docs', name), 'utf8')
    for (const violation of countOwnerViolations(text)) {
      failures.push(`${name}:${violation.line}: ${violation.message}`)
    }
  }
  assert.deepEqual(failures, [])
})
