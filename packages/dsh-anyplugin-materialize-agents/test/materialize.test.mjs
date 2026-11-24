import assert from 'node:assert/strict'
import test from 'node:test'

import { agentProblem, agentTool, apply } from '../src/index.ts'
import { loadEffectiveModelMap } from '../../dsh-anyplugin-model-map/src/index.ts'

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
  llm,
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
      if (service === 'llm') return llm
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

test('a skill preload with an empty body is refused, not silently dropped', async () => {
  const subagents = {
    startActivation() {
      throw new Error('a child must not start for an empty preload')
    },
  }
  const { ctx, tools } = fakeContext({ subagents })
  apply(ctx, {
    plugin: PLUGIN,
    agents: [
      {
        ...REVIEWER,
        skills: ['blank'],
        skillContents: [{ name: 'blank', content: '  \n' }],
      },
    ],
  })
  await assert.rejects(
    () => tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'task' }, { agent: { id: 'lead' } }),
    /empty body/,
  )
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

// D91: the materializer resolves the frontmatter model/effort through this
// layer's model map and the live catalog. A route the catalog does not confirm
// is never sent (S16); the child still starts on the session default and the
// gap is logged.
const MODEL_MAP = loadEffectiveModelMap({
  env: { ANYPLUGIN_MODEL_MAP: '/tmp/anyplugin-materialize-no-model-map.json' },
  homedir: '/tmp',
})
const MAPPED_SONNET = { ...REVIEWER, model: 'sonnet', effort: 'high' }
const sessionParent = (provider) => ({
  id: 'lead',
  session: { requestHeader: () => ({ config: { provider, model: 'session-model', reasoningEffort: 'max' } }) },
})

/** A stub llm service: providers advertise model ids and reasoning efforts. */
function modelCatalog({ providers, models, efforts = {} }) {
  return {
    listProviders: () => providers.map((id) => ({ id, name: id })),
    listModels: async (provider) => (models[provider] ?? []).map((id) => ({ provider, id, name: id })),
    resolveModelInfo: async (provider, model) => {
      const advertised = efforts[provider + '/' + model]
      return {
        provider,
        id: model,
        name: model,
        ...(advertised === undefined ? {} : { reasoning: { efforts: advertised.map((id) => ({ id, name: id })) } }),
      }
    },
  }
}

test('a mapped agent forwards the resolved route, preferring the session provider', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const llm = modelCatalog({
    providers: ['acme', 'other'],
    models: { acme: ['deepseek-flash'], other: ['deepseek-flash'] },
    efforts: { 'acme/deepseek-flash': ['low', 'high', 'max'], 'other/deepseek-flash': ['low'] },
  })
  const { ctx, tools, warnings } = fakeContext({ subagents, llm })
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: MODEL_MAP })

  await tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: sessionParent('acme') })

  assert.deepEqual(started[0].agentOptions, { provider: 'acme', model: 'deepseek-flash', reasoningEffort: 'high' })
  // The declared provider is absent here, so the substitution is recorded even
  // though the session provider owns the route.
  assert.ok(warnings.some((warning) => /not registered and does not advertise .*resolved it on provider "acme"/.test(warning)))
})

test('the declared provider resolves the id when the session provider does not advertise it', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const llm = modelCatalog({
    providers: ['acme', 'deepseek-account'],
    models: { acme: ['session-model'], 'deepseek-account': ['deepseek-flash'] },
    efforts: { 'deepseek-account/deepseek-flash': ['low', 'high', 'max'] },
  })
  const { ctx, tools, warnings } = fakeContext({ subagents, llm })
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: MODEL_MAP })

  await tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: sessionParent('acme') })

  assert.deepEqual(started[0].agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  // The declared provider owns the route, so there is nothing to substitute or warn about.
  assert.deepEqual(warnings, [])
})

test('a model id no provider advertises is never forwarded; the child starts on the session default', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const llm = modelCatalog({ providers: ['acme'], models: { acme: ['session-model'] } })
  const { ctx, tools, warnings } = fakeContext({ subagents, llm })
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: MODEL_MAP })

  const value = await tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: sessionParent('acme') })

  assert.deepEqual(value, { name: 'agent-7' })
  assert.equal(started[0].agentOptions, undefined)
  assert.ok(warnings.some((warning) => /no registered provider advertises model id "deepseek-flash"/.test(warning)))
})

test('a malformed user document refuses to forward anything, visibly', async () => {
  const { ctx, tools, warnings } = fakeContext()
  const malformed = loadEffectiveModelMap({
    env: { ANYPLUGIN_MODEL_MAP: '/tmp/anyplugin-model-map-test-broken.json' },
    homedir: '/tmp',
  })
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: malformed })
  // Point the loader at a real malformed file by giving the map a document and problem.
  const broken = { ...malformed, document: '/tmp/anyplugin-model-map-test-broken.json', problems: ['unknown effort "turbo"'] }
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: broken })
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const { ctx: runCtx, tools: runTools, warnings: runWarnings } = fakeContext({ subagents })
  apply(runCtx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: broken })

  await runTools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: sessionParent('acme') })

  assert.equal(started[0].agentOptions, undefined)
  assert.ok(runWarnings.some((warning) => /malformed/.test(warning)))
})

test('an effort the selected provider does not advertise is dropped; the model still forwards', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const llm = modelCatalog({
    providers: ['acme'],
    models: { acme: ['deepseek-flash'] },
    efforts: { 'acme/deepseek-flash': ['low', 'medium'] },
  })
  const { ctx, tools, warnings } = fakeContext({ subagents, llm })
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: MODEL_MAP })

  await tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: sessionParent('acme') })

  assert.deepEqual(started[0].agentOptions, { provider: 'acme', model: 'deepseek-flash' })
  assert.ok(warnings.some((warning) => /does not advertise effort "high" .*advertised: low, medium/.test(warning)))
})

test('an unknown frontmatter effort keeps the mapped default effort and says so', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const llm = modelCatalog({
    providers: ['acme'],
    models: { acme: ['deepseek-flash'] },
    efforts: { 'acme/deepseek-flash': ['low', 'high', 'max'] },
  })
  const { ctx, tools, warnings } = fakeContext({ subagents, llm })
  apply(ctx, { plugin: PLUGIN, agents: [{ ...MAPPED_SONNET, effort: 'turbo' }], modelMap: MODEL_MAP })

  await tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: sessionParent('acme') })

  // The shipped sonnet route asks for `high`; `turbo` is not an effort id, so
  // the mapped effort stays in force rather than being guessed.
  assert.equal(started[0].agentOptions.reasoningEffort, 'high')
  assert.ok(warnings.some((warning) => /turbo" is not a provider effort id/.test(warning)))
})

test('a provider that does not accept agentOptions is retried on the session default', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      if (spec.agentOptions !== undefined) {
        throw Object.assign(new Error('this provider does not accept agentOptions'), { code: 'UNSUPPORTED_CAPABILITY' })
      }
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const llm = modelCatalog({
    providers: ['acme'],
    models: { acme: ['deepseek-flash'] },
    efforts: { 'acme/deepseek-flash': ['low', 'high', 'max'] },
  })
  const { ctx, tools, warnings } = fakeContext({ subagents, llm })
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: MODEL_MAP })

  const value = await tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: sessionParent('acme') })

  assert.deepEqual(value, { name: 'agent-7' })
  assert.equal(started.length, 1)
  assert.equal(started[0].agentOptions, undefined)
  assert.ok(warnings.some((warning) => /does not accept provider\/model\/reasoningEffort overrides/.test(warning)))
})

test('without the llm service nothing is forwarded and the gap names the seam', async () => {
  const started = []
  const subagents = {
    startActivation(spec) {
      started.push(spec)
      return Promise.resolve({ name: 'agent-7' })
    },
  }
  const { ctx, tools, warnings } = fakeContext({ subagents })
  apply(ctx, { plugin: PLUGIN, agents: [MAPPED_SONNET], modelMap: MODEL_MAP })

  await tools.get(`${PLUGIN}:reviewer`).execute({ prompt: 'review' }, { agent: { id: 'lead' } })

  assert.equal(started[0].agentOptions, undefined)
  assert.ok(warnings.some((warning) => /llm service is absent/.test(warning)))
})
