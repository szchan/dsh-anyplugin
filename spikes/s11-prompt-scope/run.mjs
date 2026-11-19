// S11: can a plugin contribute system-prompt text that is active for the
// agents it acts on — and only those?
//
// Claude's `output-styles/*.md` is F1: the style body *is* prompt text the model
// receives at agent start. The old answer ("no seam") was wrong. This spike
// boots the pinned harness and dumps `options.messages[0]` — the composed
// system prompt the model actually receives — for every reachable path:
//
//   1. `createAgent(..., { setup(agentCtx) })` — the creation-time composition
//      seam: a section registered there reaches that agent, not its sibling,
//      and disappears when the agent is disposed;
//   2. a command handler (the activation shape `/<plugin>:<name>`): the handler
//      receives `invocation.agent`, registers a `complete: true` section there,
//      and the next request's system prompt is byte-for-byte the style text —
//      only for that agent; it persists into its next turn;
//   3. an `agent/created` listener: `payload.agent.ctx` is agent-scoped, so a
//      filtered listener can compose the agent at announcement time;
//   4. `dsh-persona` mounted under the agent ctx and a preset registered with
//      `dsh-agent-preset-registry` + mounted in setup: the declarative forms;
//   5. a section registered at setup survives history compaction (the prompt
//      is re-assembled from sections each request).
//
// Answer: yes — the seam exists and is per-agent. It is not plugin-scoped by
// provenance: a Loader entry sees agent creation only as a global
// `agent/created` event, and the payload carries no plugin id, so an at-start
// contribution must filter by agent id or create the agent itself (both shown
// here). Carrying `output-styles` is therefore `planned`, not `unsupported`:
// it still waits on (i) the `/<plugin>:<name>` alias — command names cannot
// contain ':' until D10's additive alias seam; (ii) plugin provenance; (iii)
// the CLI inventory not listing styles at 2.1.322, so a fixture must compare a
// dumped composed prompt; (iv) `keep-coding-instructions`.
//
// Run:
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   npm install --prefix .harness/0.2.2-rc.5 --no-save --ignore-scripts \
//     --cache "$PWD/.npm-cache" \
//     @deepseek-ai/dsh-agent-loop@0.2.2-rc.5 \
//     @deepseek-ai/dsh-subagent@0.2.2-rc.5 \
//     @deepseek-ai/dsh-subagent-fork-in-process@0.2.2-rc.5 \
//     @deepseek-ai/dsh-fs-local@0.2.2-rc.5 \
//     @deepseek-ai/dsh-working-directory@0.2.2-rc.5 \
//     @deepseek-ai/dsh-llm@0.2.2-rc.5 \
//     @deepseek-ai/dsh-session@0.2.2-rc.5 \
//     @deepseek-ai/dsh-session-projection@0.2.2-rc.5 \
//     @deepseek-ai/dsh-agent@0.2.2-rc.5 \
//     @deepseek-ai/dsh-commands@0.2.2-rc.5 \
//     @deepseek-ai/dsh-compaction-basic@0.2.2-rc.5 \
//     @deepseek-ai/dsh-token-meter@0.2.2-rc.5 \
//     @deepseek-ai/dsh-persona@0.2.2-rc.5 \
//     @deepseek-ai/dsh-agent-preset@0.2.2-rc.5 \
//     @deepseek-ai/dsh-agent-preset-registry@0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
//     node spikes/s11-prompt-scope/run.mjs   # or: npm run spike:s11
//
// A missing package is reported by name and the run exits 2: an explicitly
// configured but incomplete harness fails closed. `out/` is report output only
// (gitignored); `out/report.json` and the prompt dumps are the machine-readable
// result.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'
const STYLE = 'S11-STYLE: Answer in terse bullet points. Never explain the obvious.'
const COMPLETE_STYLE = 'S11-COMPLETE: terse.'
const CREATED_STYLE = 'S11-CREATED: terse.'
const PERSONA_STYLE = 'S11-PERSONA: terse.'
const PRESET_STYLE = 'S11-PRESET: terse.'
const SECTION = 'anyplugin:output-style:terse'
const ORDER = 1500

const REQUIRED = [
  'cordis',
  'dsh-session',
  'dsh-session-projection',
  'dsh-system-prompt',
  'dsh-tools',
  'dsh-agent',
  'dsh-commands',
  'cordis-plugin-loader',
  'dsh-persona',
  'dsh-agent-preset-registry',
  'dsh-llm',
  'dsh-agent-loop',
  'dsh-tool-executor-native',
  'dsh-compaction-basic',
  'dsh-token-meter',
]

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeoutMs = 5000, label = 'condition') => {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

function candidates(root) {
  return [join(root, 'node_modules', '@deepseek-ai'), join(root, '@deepseek-ai'), root, dirname(root)]
}
function usable(candidate) {
  return candidate !== undefined && REQUIRED.every((name) => existsSync(join(candidate, name, 'package.json')))
}
function locateHarness() {
  const named = process.env.DSH_HARNESS_DIR?.trim()
  const installed = process.env.DSH_INSTALL_DIR?.trim()
  // An explicitly configured root is a contract: if it is incomplete, say what
  // is missing and stop. Falling through to another install would report a
  // result for a tree the caller did not name (the S10 lesson).
  const roots = named
    ? [[resolve(named), 'DSH_HARNESS_DIR']]
    : installed
      ? [[resolve(installed), 'DSH_INSTALL_DIR']]
      : [[join(REPO, '.harness', VERSION), '.harness']]
  for (const [root, source] of roots) {
    for (const candidate of candidates(root)) if (usable(candidate)) return { dir: candidate, source }
  }
  const missing = REQUIRED.filter((name) => !roots.some(([root]) => candidates(root).some((candidate) => existsSync(join(candidate, name, 'package.json')))))
  console.error(`no usable harness: ${roots.map(([r, s]) => `${s}=${r}`).join(', ') || '(no candidate)'}`)
  console.error(`missing: ${missing.join(', ')}`)
  process.exit(2)
}

const { dir: HARNESS, source: HARNESS_SOURCE } = locateHarness()
const version = () => {
  try {
    return JSON.parse(readFileSync(join(HARNESS, 'dsh-skill', 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}
const load = (name) => import(pathToFileURL(name.endsWith('.js') ? join(HARNESS, name) : join(HARNESS, name, 'lib', 'index.js')).href)
const loadPlugin = (name) => load(name)

function fakeAdapterClass(LlmAdapter) {
  return class FakeAdapter extends LlmAdapter {
    constructor() {
      super()
      this.calls = []
    }
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 8192 }, defaultMaxTokens: 1024 }
    }
    async *stream(options) {
      this.calls.push({
        purpose: options.purpose,
        model: options.model,
        messages: (options.messages ?? []).map((message) => ({ role: message.role, text: messageText(message) })),
        tools: (options.tools ?? []).map((tool) => tool.name),
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  return (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** The composed system prompt of the last request whose conversation contains `needle`. */
function systemPromptFor(adapter, needle) {
  const call = [...adapter.calls].reverse().find((entry) => entry.messages.some((message) => message.text.includes(needle)))
  if (call === undefined) return undefined
  return call.messages.find((message) => message.role === 'system')?.text
}

async function boot({ plugins = [] } = {}) {
  const { Context } = await load('cordis/lib/index.js')
  const SessionStore = (await load('dsh-session/lib/index.js')).default
  const SessionProjections = (await load('dsh-session-projection/lib/index.js')).default
  const SystemPrompt = (await load('dsh-system-prompt/lib/index.js')).default
  const ToolsService = (await load('dsh-tools/lib/index.js')).default
  const AgentRegistry = (await load('dsh-agent/lib/index.js')).default
  const Commands = (await load('dsh-commands/lib/index.js')).default
  const Loader = (await load('cordis-plugin-loader/lib/index.js')).default
  const Presets = (await load('dsh-agent-preset-registry/lib/index.js')).default
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm/lib/index.js')
  const AgentLoop = (await load('dsh-agent-loop/lib/index.js')).default
  const nativeExecutor = await loadPlugin('dsh-tool-executor-native')

  const ctx = new Context()
  const fibers = []
  const mount = (plugin, config = {}) => fibers.push(ctx.plugin(plugin, config))
  mount(SessionStore)
  mount(SessionProjections)
  mount(SystemPrompt)
  mount(ToolsService)
  mount(AgentRegistry)
  mount(nativeExecutor)
  mount(Commands)
  mount(Loader, { baseUrl: join(HARNESS, '..', '..') })
  mount(Presets, { default: 's11-preset' })
  for (const [plugin, config] of plugins) mount(plugin, config)
  mount(LlmRuntime)
  mount(AgentLoop)

  for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'commands', 'loader', 'agentPresets', 'llm', 'agentLoop']) {
    await until(() => ctx.get(name), 5000, name)
  }
  const adapter = new (fakeAdapterClass(LlmAdapter))()
  ctx.llm.registerAdapter(['fake'], adapter)
  return { ctx, adapter, createUserMessage }
}

function turnEnd(ctx, turn) {
  return new Promise((resolveTurn, rejectTurn) => {
    const timer = setTimeout(() => rejectTurn(new Error(`turn ${turn} did not end`)), 15_000)
    const off = ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end' && event.data?.turn === turn) {
        clearTimeout(timer)
        off()
        resolveTurn(event)
      }
    })
  })
}

async function drive(ctx, agent, createUserMessage, text, turn) {
  const done = turnEnd(ctx, turn)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await done
  await agent.whenIdle()
}

async function scopedAgent(ctx, id) {
  return ctx.agentLoop.createAgent(ctx, {
    sessionId: id,
    agentOptions: { provider: 'fake', model: `fake-${id}` },
    setup: (agentCtx) => {
      agentCtx.systemPrompt.section({ name: SECTION, order: ORDER, text: STYLE })
    },
  })
}

async function main() {
  const started = new Date().toISOString()
  console.log(`harness: ${HARNESS} (${HARNESS_SOURCE}, ${version()})\n`)

  const { ctx, adapter, createUserMessage } = await boot()

  // --- 1. the creation-time account: setup(agentCtx) reaches that agent only --
  const plain = await ctx.agentLoop.create('s11-plain', { provider: 'fake', model: 'fake-plain' })
  await drive(ctx, plain, createUserMessage, 'S11-PLAIN-1', 1)
  const baseline = systemPromptFor(adapter, 'S11-PLAIN-1')
  check(
    'the model receives a composed system prompt (the baseline dump is non-empty)',
    typeof baseline === 'string' && baseline.includes('DeepSeek Harness'),
    JSON.stringify(baseline?.slice(0, 80)),
  )
  check('the baseline prompt does not contain the style text', !(baseline ?? '').includes(STYLE))

  const scoped = await ctx.agentLoop.createAgent(ctx, {
    sessionId: 's11-scoped',
    agentOptions: { provider: 'fake', model: 'fake-scoped' },
    setup: (agentCtx) => {
      agentCtx.systemPrompt.section({ name: SECTION, order: ORDER, text: STYLE })
    },
  })
  await drive(ctx, scoped.agent, createUserMessage, 'S11-SCOPED-1', 1)
  const scopedPrompt = systemPromptFor(adapter, 'S11-SCOPED-1')
  check(
    'a section registered in setup(agentCtx) is in that agent\'s system prompt',
    (scopedPrompt ?? '').includes(STYLE),
    JSON.stringify(scopedPrompt?.slice(scopedPrompt.indexOf(STYLE) - 40, scopedPrompt.indexOf(STYLE) + STYLE.length + 40)),
  )

  await drive(ctx, plain, createUserMessage, 'S11-PLAIN-2', 2)
  const siblingPrompt = systemPromptFor(adapter, 'S11-PLAIN-2')
  check('the identical section name is absent from a sibling agent', !(siblingPrompt ?? '').includes(STYLE))

  // The scope is the agent (the setup owner), not the plugin or the section
  // name: disposing the agent unwinds the registration.
  await scoped.dispose()
  const afterDispose = await ctx.agentLoop.create('s11-after-dispose', { provider: 'fake', model: 'fake-after-dispose' })
  await drive(ctx, afterDispose, createUserMessage, 'S11-AFTER-DISPOSE', 1)
  const afterDisposePrompt = systemPromptFor(adapter, 'S11-AFTER-DISPOSE')
  check('disposing the agent removes the scoped section', !(afterDisposePrompt ?? '').includes(STYLE))

  // --- 2. the activation account: a command handler receives the agent ------
  // This is the exact shape of `/output-style <name>`: the handler runs without
  // a model turn, and registers a section on the invoking agent. `complete`
  // makes the style the whole system prompt, byte for byte.
  let handled = false
  const command = ctx.commands.register({
    name: 's11-style',
    description: 'S11 probe: apply a complete output style to the invoking agent',
    handler: (invocation) => {
      handled = true
      invocation.agent.ctx.systemPrompt.section({
        name: 'anyplugin:output-style:complete',
        order: ORDER,
        text: COMPLETE_STYLE,
        complete: true,
      })
      return { kind: 'success' }
    },
  })
  check('a command handler can be registered and receives the invoking agent', typeof command === 'function' && !!ctx.commands.find(plain, 's11-style'))

  const commandAgent = await ctx.agentLoop.create('s11-command', { provider: 'fake', model: 'fake-command' })
  const execution = await ctx.commands.execute(commandAgent, '/s11-style', [], new AbortController().signal)
  check('the command executes without a model turn', handled && execution?.result?.kind === 'success', JSON.stringify(execution?.result))

  await drive(ctx, commandAgent, createUserMessage, 'S11-COMMAND-1', 1)
  const commandPrompt = systemPromptFor(adapter, 'S11-COMMAND-1')
  check(
    'complete:true makes the invoking agent\'s system prompt byte-for-byte the style text',
    commandPrompt === COMPLETE_STYLE,
    JSON.stringify(commandPrompt),
  )

  const commandSibling = await ctx.agentLoop.create('s11-command-sibling', { provider: 'fake', model: 'fake-command-sibling' })
  await drive(ctx, commandSibling, createUserMessage, 'S11-COMMAND-SIBLING', 1)
  const commandSiblingPrompt = systemPromptFor(adapter, 'S11-COMMAND-SIBLING')
  check('the command style is absent from a sibling agent', !(commandSiblingPrompt ?? '').includes(COMPLETE_STYLE))

  await drive(ctx, commandAgent, createUserMessage, 'S11-COMMAND-2', 2)
  const commandPersist = systemPromptFor(adapter, 'S11-COMMAND-2')
  check('the command style persists into the agent\'s next turn', commandPersist === COMPLETE_STYLE, JSON.stringify(commandPersist))

  // --- 3. the announcement account: agent/created carries the live agent ----
  // The payload has no plugin provenance, so an at-start contribution must
  // filter by id (or have created the agent itself). The payload's `agent.ctx`
  // is the agent scope.
  const createdIds = []
  ctx.on('agent/created', (payload) => {
    createdIds.push(payload.agent.id)
    if (payload.agent.id === 's11-created') {
      payload.agent.ctx.systemPrompt.section({ name: 'anyplugin:output-style:created', order: ORDER, text: CREATED_STYLE })
    }
  })
  const created = await ctx.agentLoop.create('s11-created', { provider: 'fake', model: 'fake-created' })
  const createdSibling = await ctx.agentLoop.create('s11-created-sibling', { provider: 'fake', model: 'fake-created-sibling' })
  await drive(ctx, created, createUserMessage, 'S11-CREATED-1', 1)
  await drive(ctx, createdSibling, createUserMessage, 'S11-CREATED-SIBLING', 1)
  const createdPrompt = systemPromptFor(adapter, 'S11-CREATED-1')
  const createdSiblingPrompt = systemPromptFor(adapter, 'S11-CREATED-SIBLING')
  check(
    'an agent/created listener composes that agent through payload.agent.ctx',
    (createdPrompt ?? '').includes(CREATED_STYLE) && createdIds.includes('s11-created'),
    JSON.stringify({ createdIds, contains: (createdPrompt ?? '').includes(CREATED_STYLE) }),
  )
  check('the agent/created style is absent from the sibling agent', !(createdSiblingPrompt ?? '').includes(CREATED_STYLE))

  // --- 4. the declarative accounts: dsh-persona and an agent preset ---------
  const Persona = await load('dsh-persona/lib/index.js')
  const personaAgent = await ctx.agentLoop.createAgent(ctx, {
    sessionId: 's11-persona',
    agentOptions: { provider: 'fake', model: 'fake-persona' },
    setup: async (agentCtx) => {
      agentCtx.plugin(Persona, { prefix: PERSONA_STYLE })
      // `ctx.plugin` schedules `apply`; setup is allowed to await its children
      // (the setup contract), so wait for the row to register before publishing.
      await sleep(20)
    },
  })
  await drive(ctx, personaAgent.agent, createUserMessage, 'S11-PERSONA-1', 1)
  const personaPrompt = systemPromptFor(adapter, 'S11-PERSONA-1')
  check(
    'dsh-persona mounted under the agent ctx contributes the persona section',
    (personaPrompt ?? '').includes(PERSONA_STYLE),
    JSON.stringify(personaPrompt?.slice(0, 120)),
  )

  const presets = ctx.get('agentPresets')
  const unregisterPreset = await presets.register({
    id: 's11-preset',
    name: 'S11 preset',
    description: 'S11 probe: a preset whose only row is a persona',
    plugins: [{ name: '@deepseek-ai/dsh-persona', config: { prefix: PRESET_STYLE } }],
  })
  const presetAgent = await ctx.agentLoop.createAgent(ctx, {
    sessionId: 's11-preset',
    agentOptions: { provider: 'fake', model: 'fake-preset' },
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, 's11-preset')
    },
  })
  await drive(ctx, presetAgent.agent, createUserMessage, 'S11-PRESET-1', 1)
  const presetPrompt = systemPromptFor(adapter, 'S11-PRESET-1')
  check(
    'an agent preset mounted in setup contributes its persona section',
    (presetPrompt ?? '').includes(PRESET_STYLE),
    JSON.stringify({ preset: presets.composedPreset(presetAgent.agent.ctx), contains: (presetPrompt ?? '').includes(PRESET_STYLE) }),
  )

  // --- 5. compaction: the agent-scoped section is re-assembled each request --
  const TokenMeter = (await load('dsh-token-meter/lib/index.js')).default
  const Compaction = (await load('dsh-compaction-basic/lib/index.js')).default
  const compactBoot = await boot({
    plugins: [[TokenMeter, {}], [Compaction, { auto: true, thresholdRatio: 0.1, retainRatio: 0.02, headroomTokens: 0, maxTokens: 512 }]],
  })
  const compact = await scopedAgent(compactBoot.ctx, 's11-compaction')
  const markers = []
  const off = compactBoot.ctx.on('session/event', (_session, event) => {
    if (event.type.startsWith('compaction/')) markers.push(event.type)
  })
  await drive(compactBoot.ctx, compact.agent, compactBoot.createUserMessage, 'x'.repeat(20_000), 1)
  await drive(compactBoot.ctx, compact.agent, compactBoot.createUserMessage, 'y'.repeat(20_000), 2)
  await drive(compactBoot.ctx, compact.agent, compactBoot.createUserMessage, 'trigger pressure', 3)
  await sleep(50)
  off()
  check(
    'the compaction engine compacted the history',
    markers.includes('compaction/start') && markers.includes('compaction/end'),
    JSON.stringify(markers),
  )
  await drive(compactBoot.ctx, compact.agent, compactBoot.createUserMessage, 'S11-AFTER-COMPACTION', 4)
  const afterCompaction = systemPromptFor(compactBoot.adapter, 'S11-AFTER-COMPACTION')
  check(
    'the scoped style survives compaction (still in the post-compaction request)',
    (afterCompaction ?? '').includes(STYLE),
    JSON.stringify({ markers, contains: (afterCompaction ?? '').includes(STYLE) }),
  )

  await unregisterPreset()

  // --- 6. dumps --------------------------------------------------------------
  const outDir = join(HERE, 'out')
  mkdirSync(outDir, { recursive: true })
  const dumps = {
    'prompt-baseline.txt': baseline,
    'prompt-scoped.txt': scopedPrompt,
    'prompt-sibling.txt': siblingPrompt,
    'prompt-after-dispose.txt': afterDisposePrompt,
    'prompt-command-complete.txt': commandPrompt,
    'prompt-command-sibling.txt': commandSiblingPrompt,
    'prompt-command-persist.txt': commandPersist,
    'prompt-created.txt': createdPrompt,
    'prompt-created-sibling.txt': createdSiblingPrompt,
    'prompt-persona.txt': personaPrompt,
    'prompt-preset.txt': presetPrompt,
    'prompt-after-compaction.txt': afterCompaction,
  }
  for (const [name, text] of Object.entries(dumps)) {
    if (typeof text === 'string') writeFileSync(join(outDir, name), `${text}\n`)
  }

  const report = {
    harness: HARNESS,
    source: HARNESS_SOURCE,
    version: version(),
    checks,
    style: STYLE,
    completeStyle: COMPLETE_STYLE,
    createdStyle: CREATED_STYLE,
    personaStyle: PERSONA_STYLE,
    presetStyle: PRESET_STYLE,
    section: SECTION,
    dumps: Object.fromEntries(
      Object.entries(dumps).map(([name, text]) => [name, { containsStyle: (text ?? '').includes(STYLE), exactComplete: text === COMPLETE_STYLE, bytes: (text ?? '').length }]),
    ),
    compaction: markers,
    started,
    ended: new Date().toISOString(),
  }
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  console.log(`\nbaseline prompt (first 300 chars):\n${(baseline ?? '').slice(0, 300)}`)
  console.log(`\ncommand-complete prompt:\n${JSON.stringify(commandPrompt)}`)
  if (failed.length > 0 || checks.length === 0) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(`\nS11 failed: ${error?.stack ?? error}`)
  process.exitCode = 1
}
