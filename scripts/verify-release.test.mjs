// The post-publish probe is only worth running if its judgment is right: a
// verifier that accepts a version the registry does not have, an artifact with
// no provenance, or a report with no components is a rubber stamp. These cases
// are the ways the first draft did exactly that.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgePackage, judgeRegistry, judgeReport } from './verify-release.mjs'

const good = {
  versions: ['0.2.0', '0.3.0'],
  predicateType: 'https://slsa.dev/provenance/v1',
}

test('judgeRegistry: a published, attested version has nothing to say', () => {
  assert.deepEqual(judgeRegistry(good, '0.3.0'), [])
})

test('judgeRegistry: a version the registry does not serve fails and names what it serves', () => {
  const failures = judgeRegistry(good, '0.2.99')
  assert.equal(failures.length, 1)
  assert.match(failures[0], /dsh-anyplugin@0\.2\.99 is not published/)
  assert.match(failures[0], /registry has 0\.2\.0, 0\.3\.0/)
})

test('judgeRegistry: an empty version list is "no version list", not "no match"', () => {
  assert.deepEqual(judgeRegistry({ versions: [], predicateType: good.predicateType }, '0.3.0'), [
    'the registry returned no version list',
  ])
})

test('judgeRegistry: a tarball with no SLSA v1 provenance is refused', () => {
  const failures = judgeRegistry({ versions: good.versions, predicateType: undefined }, '0.3.0')
  assert.equal(failures.length, 1)
  assert.match(failures[0], /carries no SLSA v1 provenance \(found none\)/)
})

test('judgePackage: the packed manifest must be the version that was asked for', () => {
  assert.deepEqual(judgePackage({ version: '0.3.0' }, '0.3.0'), [])
  assert.deepEqual(judgePackage({ version: '0.2.0' }, '0.3.0'), ["the tarball's package.json says 0.2.0, not 0.3.0"])
})

test('judgeReport: a report from the packed compiler is read as facts, not as prose', () => {
  const report = {
    ok: true,
    plugin: 'skills-only',
    pin: { tool: 'claude-code', version: '2.1.329' },
    components: [{ surface: 'skills', class: 'equivalent' }],
  }
  assert.deepEqual(judgeReport(report, { version: '0.3.0', name: 'skills-only' }), [])
})

test('judgeReport: every fact the release claim rests on is checked', () => {
  const base = {
    ok: true,
    plugin: 'skills-only',
    pin: { tool: 'claude-code', version: '2.1.329' },
    components: [{ surface: 'skills', class: 'equivalent' }],
  }
  const failuresOf = (patch) => judgeReport({ ...base, ...patch }, { version: '0.3.0', name: 'skills-only' })

  assert.match(failuresOf({ ok: false })[0], /report is not ok \(ok=false\)/)
  assert.match(failuresOf({ plugin: 'other' })[0], /names plugin "other", not "skills-only"/)
  assert.match(failuresOf({ pin: { tool: 'codex' } })[0], /pin is "codex", not "claude-code"/)
  assert.match(failuresOf({ pin: { tool: 'claude-code', version: 'latest' } })[0], /pin version is "latest"/)
  assert.match(failuresOf({ components: [] })[0], /carries no components/)
  assert.match(failuresOf({ components: [{ surface: 'skills' }] })[0], /1 component\(s\) carry no surface or class/)
})
