import assert from 'node:assert/strict'
import test from 'node:test'

import { agentProblem, agentTool, apply } from '../src/index.ts'

const PLUGIN = 'agents-fixture'
const REVIEWER = {
  name: 'reviewer',
  description: 'Reviews a diff for defects.',
  content: 'You review diffs.\n\nBe specific about the defect, not the style.',
  path: 'agents/reviewer.md',
}

function fakeContext({
  subagents = { startActivation: () => Promise.resolve({ name: 'agent-1' }) },
  hasSubagents = true,
  hasTools = true,
} = {}) {
  const tools = new Map()
  const warnings = []
  let waiting
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`tool ${definition.name} is already registered`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(run) {
      return run()
    },
    inject(names, callback) {
      waiting = () => callback({ get: (service) => (service === 'tools' ? ctx.tools : undefined) })
    },
    get(service) {
      if (service === 'subagents') return hasSubagents ? subagents : undefined
      if (service === 'tools') return hasTools ? ctx.tools : undefined
      return undefined
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
  }
  return { ctx, tools, warnings, startWaiting: () => waiting?.() }
}

test('one tool per agent, scoped by plugin, description verbatim, body never in it', () => {
  const { ctx, tools, warnings } = fakeContext()
  apply(ctx, { plugin: PLUGIN, agents: [REVIEWER] })
  const tool = tools.get(`${PLUGIN}:reviewer`)
  assert.ok(tool, 'agents-fixture:reviewer registered')
  assert.equal(tool.description, REVIEWER.description)
  assert.equal(tool.description.includes('You review diffs.'), false)
  assert.deepEqual(tool.parameters.required, ['prompt'])
  assert.deepEqual(warnings, [])
})

test('invoking the tool starts a child with the body ahead of the task', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const { ctx, tools } = fakeContext({ subagents })
  apply(ctx, { plugin: PLUGIN, agents: [REVIEWER] })
  const parent = { id: 'lead' }
  const value = await tools.get(`${PLUGIN}:reviewer`).execute(
    { prompt: 'Review the patch that changed retry handling.', description: 'diff review' },
    { agent: parent },
  )
  assert.deepEqual(value, { name: 'agent-7' })
  assert.equal(started.length, 1)
  const spec = started[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'diff review')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.parent, parent)
  assert.deepEqual(spec.prompt, [
    { type: 'text', text: REVIEWER.content.trim() },
    { type: 'text', text: 'Review the patch that changed retry handling.' },
  ])
})

test('without the subagents service the catalog loads and invocation names the seam', async () => {
  const { ctx, tools, warnings } = fakeContext({ hasSubagents: false })
  assert.doesNotThrow(() => apply(ctx, { plugin: PLUGIN, agents: [REVIEWER] }))
  assert.ok(tools.get(`${PLUGIN}:reviewer`), 'the model still sees the agent it was promised')
  await assert.rejects(
    tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: { id: 'lead' } }),
    (error) => {
      assert.match(error.message, /subagents service is absent/)
      assert.match(error.message, /dsh-subagent/)
      return true
    },
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ctx\.subagents is absent/)
})

test('a late tools service is awaited and the skip is recorded, not silent', () => {
  const { ctx, tools, warnings, startWaiting } = fakeContext({ hasTools: false })
  assert.doesNotThrow(() => apply(ctx, { plugin: PLUGIN, agents: [REVIEWER] }))
  assert.deepEqual([...tools.keys()], [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ctx\.tools is absent/)
  startWaiting()
  assert.deepEqual([...tools.keys()], [`${PLUGIN}:reviewer`])
})

test('a malformed agent becomes no tool and a recorded reason', () => {
  const { ctx, tools, warnings } = fakeContext()
  apply(ctx, {
    plugin: PLUGIN,
    agents: [{ ...REVIEWER, description: '' }, { ...REVIEWER, name: 'empty-body', content: '   ' }],
  })
  assert.deepEqual([...tools.keys()], [])
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /no description/)
  assert.match(warnings[1], /body is empty/)
})

test('a config without a plugin scope refuses every agent with a reason', () => {
  const { ctx, tools, warnings } = fakeContext()
  apply(ctx, { agents: [REVIEWER] })
  assert.deepEqual([...tools.keys()], [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /no plugin name/)
})

test('a duplicate agent name warns instead of taking the group down', () => {
  const { ctx, tools, warnings } = fakeContext()
  apply(ctx, { plugin: PLUGIN, agents: [REVIEWER, { ...REVIEWER }] })
  assert.deepEqual([...tools.keys()], [`${PLUGIN}:reviewer`])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not register "agents-fixture:reviewer"/)
})

test('agentProblem distinguishes every refusal', () => {
  assert.equal(agentProblem(REVIEWER, PLUGIN), undefined)
  assert.match(agentProblem({ ...REVIEWER, name: '' }, PLUGIN), /no name/)
  assert.match(agentProblem(REVIEWER, undefined), /no plugin name/)
  assert.match(agentProblem({ ...REVIEWER, description: '  ' }, PLUGIN), /no description/)
  assert.match(agentProblem({ ...REVIEWER, content: '\n' }, PLUGIN), /body is empty/)
  assert.equal(agentTool(REVIEWER, fakeContext().ctx, { plugin: PLUGIN }).description, REVIEWER.description)
})
