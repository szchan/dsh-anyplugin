// D91: an agent `model`/`effort` face carried through this layer's model map is
// `derived` — a policy of ours with no Claude counterpart, never "Claude
// semantics" — and a face the map cannot resolve stays `unsupported` with the
// gap named. These are unit tests over the dialect's annotation, so they do not
// need the pinned harness; the child-side observation lives in
// `conformance/test/agent-faces.test.mjs`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readClaudePlugin } from '../src/index.ts'
import { EFFORT_NAMES } from '../../dsh-anyplugin-model-map/src/index.ts'

const PLAN = 's16-plan-plugin'

/** A plugin with one agent whose frontmatter is exactly `frontmatter`. */
function makePlugin(frontmatter, plugin = PLAN) {
  const root = join(mkdtempSync(join(tmpdir(), 'anyplugin-model-map-faces-')), plugin)
  mkdirSync(join(root, 'agents'), { recursive: true })
  writeFileSync(join(root, 'agents', 'helper.md'), `---\nname: helper\ndescription: A helper.\n${frontmatter}---\nYou help.\n`)
  return root
}

const DEFAULTS = {
  path: '/tmp/does-not-exist/model-map.json',
  document: null,
  entries: [
    { alias: 'haiku', route: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'low' }, source: 'default' },
    { alias: 'opus', route: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'max' }, source: 'default' },
    { alias: 'sonnet', route: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' }, source: 'default' },
  ],
  overrides: [],
  problems: [],
}

function facesOf(root, modelMap = DEFAULTS) {
  const ir = readClaudePlugin(root, { source: 'plugin-dir:test', modelMap })
  const agent = ir.agents.find((item) => item.name === 'helper')
  assert.ok(agent, 'helper is in the IR')
  return agent
}

test('a mapped alias and effort are derived, name the route, and deny Claude semantics', () => {
  const agent = facesOf(makePlugin('model: sonnet\neffort: high\n'))
  assert.equal(agent.faces.model.fidelity, 'derived')
  assert.equal(agent.faces.effort.fidelity, 'derived')
  assert.match(agent.faces.model.reason, /`model: sonnet`/)
  assert.match(agent.faces.model.reason, /provider "deepseek-account" model "deepseek-flash"/)
  assert.match(agent.faces.model.reason, /policy \(D91\)/)
  assert.match(agent.faces.model.reason, /not a Claude semantic/)
  assert.match(agent.faces.effort.reason, /`effort: high`/)
  assert.match(agent.faces.effort.reason, /policy \(D91\)/)
  assert.match(agent.faces.effort.reason, /not a Claude semantic/)
  // The raw frontmatter values are still carried as data for the materializer.
  assert.equal(agent.model, 'sonnet')
  assert.equal(agent.effort, 'high')
  // A derived face is still a face: the component's overall class cannot be stronger.
  assert.notEqual(agent.annotation.fidelity, 'exact')
})

test('an alias the map does not declare is unsupported and names the document and the keys', () => {
  const agent = facesOf(makePlugin('model: claude-opus-9\n'))
  assert.equal(agent.faces.model.fidelity, 'unsupported')
  assert.match(agent.faces.model.reason, /claude-opus-9/)
  assert.match(agent.faces.model.reason, /"opus"/)
  assert.match(agent.faces.model.reason, /\/tmp\/does-not-exist\/model-map\.json/)
  assert.match(agent.faces.model.reason, /session default/)
})

test('an empty model value declares no face: the dialect does not invent a mapping for it', () => {
  const agent = facesOf(makePlugin('model:\n'))
  assert.equal(agent.faces.model, undefined)
  assert.equal(agent.model, undefined)
})

test('an effort without a mapped model is unsupported: no route is guessed for an effort alone', () => {
  const agent = facesOf(makePlugin('effort: high\n'))
  assert.equal(agent.faces.effort.fidelity, 'unsupported')
  assert.match(agent.faces.effort.reason, /no mapped `model` alias/)
  assert.match(agent.faces.effort.reason, /provider/)
})

test('an effort name outside the vocabulary is unsupported and lists what is accepted', () => {
  const agent = facesOf(makePlugin('model: sonnet\neffort: turbo\n'))
  assert.equal(agent.faces.model.fidelity, 'derived')
  assert.equal(agent.faces.effort.fidelity, 'unsupported')
  assert.match(agent.faces.effort.reason, /turbo/)
  for (const effort of EFFORT_NAMES) assert.match(agent.faces.effort.reason, new RegExp(effort))
})

test('a malformed user document is unsupported, with the document problem in the reason', () => {
  const malformed = {
    ...DEFAULTS,
    document: '/tmp/broken/model-map.json',
    problems: ['/tmp/broken/model-map.json: unknown top-level key "route" (only "models" is accepted)'],
  }
  const agent = facesOf(makePlugin('model: sonnet\neffort: high\n'), malformed)
  assert.equal(agent.faces.model.fidelity, 'unsupported')
  assert.equal(agent.faces.effort.fidelity, 'unsupported')
  assert.match(agent.faces.model.reason, /malformed/)
  assert.match(agent.faces.model.reason, /unknown top-level key/)
  assert.match(agent.faces.effort.reason, /malformed/)
})

test('readClaudePlugin annotates against the map the caller resolved', () => {
  const custom = {
    path: '/tmp/custom/model-map.json',
    document: '/tmp/custom/model-map.json',
    entries: [
      { alias: 'sonnet', route: { provider: 'acme', model: 'acme-flash', effort: 'max' }, source: 'user' },
    ],
    overrides: ['sonnet'],
    problems: [],
  }
  const agent = facesOf(makePlugin('model: sonnet\neffort: high\n'), custom)
  assert.equal(agent.faces.model.fidelity, 'derived')
  assert.match(agent.faces.model.reason, /provider "acme" model "acme-flash" at effort "max"/)
  assert.match(agent.faces.effort.reason, /`effort: high`/)
})
