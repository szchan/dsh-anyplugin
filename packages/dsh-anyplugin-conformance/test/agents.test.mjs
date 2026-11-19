// S10: the model sees one tool per `agents/*.md` persona, scoped as
// `<plugin>:<agent>`, and the tool's description is the frontmatter description
// byte for byte. The inventory row is learned from the harness's own registry
// and compared against the emitted declaration; the IR skeleton alone cannot
// make it appear. This test is the independent fixture anchor: it reads the
// description from the fixture's frontmatter bytes and the body from the
// emitted `agents` child, so it fails if the materializer stops registering,
// starts leaking the body into the description, or the dialect stops
// extracting the body.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'
import { probeWithDsh } from '../src/oracles/dsh.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harness = resolveHarness()
const materializerUrl = (pkg) => pathToFileURL(join(repoRoot, 'packages', pkg, 'src', 'index.ts')).href
const materializers = {
  skill: materializerUrl('dsh-anyplugin-materialize-skill'),
  agents: materializerUrl('dsh-anyplugin-materialize-agents'),
}
const fixtureRoot = join(repoRoot, 'fixtures', 'claude-agents')
const reviewerSource = readFileSync(join(fixtureRoot, 'agents', 'reviewer.md'), 'utf8')
// The file is the specification: no parser, trim, or constant sits between the
// authored frontmatter line and the expected description.
const descriptionLine = reviewerSource.split('\n').find((line) => line.startsWith('description:'))
const expectedDescription = descriptionLine.slice('description: '.length).replace(/\r$/, '')
const bodyStart = reviewerSource.indexOf('\n---\n') + '\n---\n'.length
const expectedBody = reviewerSource.slice(bodyStart)

test(
  'claude-agents: the model sees the scoped agent name and its frontmatter description',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const ir = readClaudePlugin(fixtureRoot, { source: 'plugin-dir:fixtures/claude-agents' })
    const agent = ir.agents.find((item) => item.name === 'reviewer')
    assert.ok(agent, 'reviewer is in the IR')
    // The nested file is not loaded by Claude at this pin; the dialect records
    // that as `unsupported`, not as an agent.
    assert.deepEqual(
      (ir.unsupported ?? []).map((item) => `${item.surface}:${item.name}`),
      ['agents:planner'],
    )

    const { entry, considered } = emitPlugin(ir, { materializers })
    assert.ok(entry, 'the agents child produced an entry')
    assert.deepEqual(considered, ['agents/reviewer'])

    const probe = await probeWithDsh({ harnessDir: harness.harnessDir, entry })
    assert.deepEqual(
      probe.inventory.components.filter((component) => component.surface === 'agents'),
      [{ surface: 'agents', name: 'reviewer' }],
    )

    const schema = probe.toolSchemas.find((item) => item.name === 'agents-fixture:reviewer')
    assert.ok(schema, 'a tool named agents-fixture:reviewer was registered')
    assert.equal(expectedDescription, 'Reviews a diff for defects.')
    assert.equal(schema.description, expectedDescription)
    assert.equal(schema.description, agent.description)
    // The body is payload for the child, never catalog text for the parent.
    assert.equal(schema.description.includes('You review diffs.'), false)
    assert.ok(
      probe.inventory.notes.includes(
        'agents/reviewer: tool "agents-fixture:reviewer" matches the emitted declaration (name and description)',
      ),
    )
  },
)

test('the agent body reaches the emitted config byte for byte', () => {
  const ir = readClaudePlugin(fixtureRoot, { source: 'plugin-dir:fixtures/claude-agents' })
  const { entry } = emitPlugin(ir, { materializers })
  const child = entry.config.find((item) => item.id === 'agents')
  assert.equal(child.config.plugin, 'agents-fixture')
  assert.equal(expectedBody, 'You review diffs.\n')
  assert.equal(child.config.agents[0].content, expectedBody)
})

test('an agent without a description defines no model-visible surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-agent-malformed-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', 'broken.md'), '---\nname: broken\n---\nBody without a catalog description.\n')
  const ir = readClaudePlugin(dir, { source: 'plugin-dir:test-malformed' })
  assert.deepEqual(ir.agents, [])
  assert.equal((ir.unsupported ?? []).length, 1)
  assert.equal(ir.unsupported[0].surface, 'agents')
  assert.match(ir.unsupported[0].annotation.reason, /description/)
  const { entry, considered, skipped } = emitPlugin(ir, { materializers })
  assert.equal(entry, null)
  assert.deepEqual(considered, [])
  assert.deepEqual(skipped, [])
})

test('an empty body or a duplicate name is refused with a recorded reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-agent-invalid-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', 'empty.md'), '---\nname: empty\ndescription: Nothing to say.\n---\n\n')
  writeFileSync(join(dir, 'agents', 'first.md'), '---\nname: twice\ndescription: First.\n---\nFirst body.\n')
  writeFileSync(join(dir, 'agents', 'second.md'), '---\nname: twice\ndescription: Second.\n---\nSecond body.\n')
  const ir = readClaudePlugin(dir, { source: 'plugin-dir:test-invalid' })
  assert.deepEqual(ir.agents.map((agent) => agent.name), ['twice'])
  assert.equal(ir.agents[0].content, 'First body.\n')
  const reasons = (ir.unsupported ?? []).map((item) => item.annotation.reason)
  assert.equal(reasons.length, 2)
  assert.match(reasons[0], /body is empty/)
  assert.match(reasons[1], /Duplicate agent name "twice"/)
})

test('without an agents materializer the agent is skipped with a reason, not faked', () => {
  const ir = readClaudePlugin(fixtureRoot, { source: 'plugin-dir:fixtures/claude-agents' })
  const { entry, skipped } = emitPlugin(ir, { materializers: { skill: materializers.skill } })
  assert.equal(entry, null)
  assert.deepEqual(skipped, ['agents/reviewer'])
})
