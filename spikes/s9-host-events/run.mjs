// S9: which DSH host events can carry the classic hook events that have no
// materializer yet?
//
// D19/D20 only let a classic hook claim an event when a listener actually runs.
// S8 proved the two tool waterfalls; S9 answers the other 30. The spike has two
// halves:
//
//   1. a reproducible lexical sweep of every dispatch site in the pinned
//      harness (`emit`, `waterfall`, `serial`, `parallel`, plus the two
//      wrapper shapes), and
//   2. runtime probes that boot the harness, attach listeners, drive a real
//      agent turn (and real services where a turn is not the point), and
//      record what actually arrived plus whether the listener could change
//      the outcome.
//
// A name in a bundle is not evidence: a row is only "observed" when a probe
// saw it. Probe failures are recorded, not swallowed.
//
// Run:
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
//     node spikes/s9-host-events/run.mjs   # or: npm run spike:s9
//
// The full turn probes boot the agent loop and friends. `fetch-harness.mjs`
// installs the union of every package this spike loads, at the pin; the list
// lives there with a consumer note per entry, so the fetch above is the only
// install the run needs (never `latest`).
//
// When a package is absent the corresponding probe reports `skipped` with the
// missing name. A skipped required probe (or a run with no checks at all) exits
// non-zero: a bare fetched harness is a vacuous 0/0, not a green run. The
// lexical half still runs against whatever tree was named. `out/` is report
// output only (gitignored); `out/report.json` is the machine-readable result.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'
const REQUIRED = ['cordis', 'dsh-session', 'dsh-tools', 'dsh-system-prompt', 'dsh-agent', 'dsh-llm']
const FULL_TURN = [...REQUIRED, 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-session-projection']

const checks = []
const skipped = []
const check = (name, ok, detail) => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const skip = (name, why) => {
  skipped.push({ name, why, required: true })
  console.log(`SKIP  ${name} — ${why}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeoutMs = 3000, label = 'condition') => {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

/** Locate the @deepseek-ai package directory, mirroring harness.ts's shapes. */
function locateHarness() {
  const named = process.env.DSH_HARNESS_DIR?.trim()
  const installed = process.env.DSH_INSTALL_DIR?.trim()
  const roots = []
  if (named) roots.push([resolve(named), 'DSH_HARNESS_DIR'])
  if (installed) roots.push([resolve(installed), 'DSH_INSTALL_DIR'])
  if (named === undefined && installed === undefined) roots.push([join(REPO, '.harness', VERSION), '.harness'])
  for (const [root, source] of roots) {
    const candidates = [join(root, 'node_modules', '@deepseek-ai'), join(root, '@deepseek-ai'), root, dirname(root)]
    for (const candidate of candidates) if (REQUIRED.every((name) => existsSync(join(candidate, name, 'package.json')))) return { dir: candidate, source }
  }
  console.error(`no usable harness: ${roots.map(([r, s]) => `${s}=${r}`).join(', ')}`)
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
/** Import a package's module namespace (plugins are `{name, inject, apply}`). */
const loadPlugin = (name) => load(name)
const has = (name) => existsSync(join(HARNESS, name, 'package.json'))

// ---------------------------------------------------------------------------
// 1. Lexical sweep
// ---------------------------------------------------------------------------

/**
 * Read the first top-level string-literal argument of a call, skipping nested
 * calls/objects. The carrier-first shape (`.waterfall(carrier, "event", ...)`)
 * puts the name second, and S8's own seam would be invisible to a bare
 * `.emit(` grep.
 */
function firstStringArgument(text, openParenIndex) {
  let depth = 0
  let quote = undefined
  let escaped = false
  for (let i = openParenIndex + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (depth === 0) {
        let end = i + 1
        while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1
        const raw = text.slice(i + 1, end)
        return /^[\w./:-]+$/.test(raw) ? raw : undefined
      }
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return undefined
      depth -= 1
    }
  }
  return undefined
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (entry.endsWith('.js')) out.push(path)
  }
  return out
}

function sweep() {
  const packages = readdirSync(HARNESS).filter((name) => existsSync(join(HARNESS, name, 'package.json')))
  const calls = []
  for (const pkg of packages) {
    const lib = join(HARNESS, pkg, 'lib')
    if (!existsSync(lib)) continue
    const files = statSync(lib).isDirectory() ? walk(lib, []) : []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const rel = `@deepseek-ai/${pkg}/${file.slice(join(HARNESS, pkg).length + 1)}`
      const lineAt = (index) => text.slice(0, index).split('\n').length
      for (const match of text.matchAll(/\.(emit|waterfall|serial|parallel|bail)\s*\(/g)) {
        const name = firstStringArgument(text, match.index + match[0].length - 1)
        if (name !== undefined) calls.push({ event: name, method: match[1], file: rel, line: lineAt(match.index) })
      }
      // Wrappers that are the only dispatch site for an event.
      for (const match of text.matchAll(/emitLifecycle\s*\(\s*["']([\w./:-]+)["']/g)) {
        calls.push({ event: match[1], method: 'emitLifecycle', file: rel, line: lineAt(match.index) })
      }
      for (const match of text.matchAll(/events\.dispatch\(\s*["']emit["']\s*,\s*\[\s*["']([\w./:-]+)["']/g)) {
        calls.push({ event: match[1], method: 'dispatch-emit', file: rel, line: lineAt(match.index) })
      }
    }
  }
  calls.sort((a, b) => a.event.localeCompare(b.event) || a.file.localeCompare(b.file) || a.line - b.line)
  return calls
}

console.log(`harness: ${HARNESS} (${HARNESS_SOURCE}, ${version()})`)
const sweepCalls = sweep()
const sweepByName = new Map()
for (const call of sweepCalls) {
  const list = sweepByName.get(call.event) ?? []
  list.push(call)
  sweepByName.set(call.event, list)
}
const countByMethod = sweepCalls.reduce((acc, call) => ({ ...acc, [call.method]: (acc[call.method] ?? 0) + 1 }), {})
console.log(`\nlexical sweep: ${sweepCalls.length} dispatch sites, ${sweepByName.size} event names (${JSON.stringify(countByMethod)})`)

// ---------------------------------------------------------------------------
// 2. Runtime probes
// ---------------------------------------------------------------------------

function fakeAdapterClass(LlmAdapter) {
  return class FakeAdapter extends LlmAdapter {
    constructor(script) {
      super()
      this.script = script
      this.calls = []
    }
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 8192 },
        defaultMaxTokens: 1024,
      }
    }
    async *stream(options) {
      this.calls.push({
        messages: options.messages.map((message) => ({ role: message.role, content: message.content })),
        tools: (options.tools ?? []).map((tool) => tool.name),
        purpose: options.purpose,
      })
      const chunks = this.script(this.calls.length, options)
      for (const chunk of chunks) yield chunk
    }
  }
}

const textChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: 'stop' },
]
const toolChunks = (id, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: 'tool-calls' },
]
const failingChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: 'error', failure: { code: 'PROBE_FAILURE', message: text } },
]

/**
 * Boot the minimal service graph that runs a real turn. Extra plugins are
 * mounted before the loop so their services are ready when the agent is made.
 */
async function boot({ plugins = [], fakeScript } = {}) {
  const { Context } = await load('cordis/lib/index.js')
  const SessionStore = (await load('dsh-session/lib/index.js')).default
  const SessionProjections = (await load('dsh-session-projection/lib/index.js')).default
  const SystemPrompt = (await load('dsh-system-prompt/lib/index.js')).default
  const ToolsService = (await load('dsh-tools/lib/index.js')).default
  const AgentRegistry = (await load('dsh-agent/lib/index.js')).default
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm/lib/index.js')
  const AgentLoop = (await load('dsh-agent-loop/lib/index.js')).default
  const nativeExecutor = await loadPlugin('dsh-tool-executor-native')

  const ctx = new Context()
  const fibers = []
  const mount = (plugin, config = {}) => {
    fibers.push(ctx.plugin(plugin, config))
  }
  mount(SessionStore)
  mount(SessionProjections)
  mount(SystemPrompt)
  mount(ToolsService)
  mount(AgentRegistry)
  mount(nativeExecutor)
  for (const [plugin, config] of plugins) mount(plugin, config)
  mount(LlmRuntime)
  mount(AgentLoop)

  for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents']) await until(() => ctx.get(name), 3000, name)
  for (const [plugin] of plugins) void plugin
  const adapter = new (fakeAdapterClass(LlmAdapter))(fakeScript ?? (() => textChunks('ok')))
  ctx.llm.registerAdapter(['fake'], adapter)
  await until(() => ctx.get('llm'), 3000, 'llm')
  await until(() => ctx.get('agentLoop'), 3000, 'agentLoop')
  return { ctx, fibers, adapter, createUserMessage }
}

/** Collect events into a mutable journal and return disposers. */
function journal() {
  const seen = { emits: [], session: [], waterfalls: [] }
  return { seen, record: (kind, name, payload) => seen[kind].push({ name, payload }) }
}

/** Wait for the turn to finish; resolves with the `turn/end` data. */
function turnEnd(ctx, turn) {
  return new Promise((resolveTurn, rejectTurn) => {
    const timer = setTimeout(() => rejectTurn(new Error(`turn ${turn} did not end`)), 10_000)
    const off = ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end' && event.data?.turn === turn) {
        clearTimeout(timer)
        off()
        resolveTurn(event)
      }
    })
  })
}

async function startTurn(ctx, agent, createUserMessage, text, turn) {
  const done = turnEnd(ctx, turn)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  return done
}

function messageText(message) {
  return (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
}

// --- Probe 1: one plain turn ------------------------------------------------

async function probeTurn() {
  console.log('\n[probe] plain turn')
  if (!FULL_TURN.every(has)) return skip('plain turn', `missing ${FULL_TURN.filter((name) => !has(name)).join(', ')}`)
  const { ctx, fibers, adapter, createUserMessage } = await boot()
  const seen = { created: undefined, createdSource: undefined, disposed: undefined, preStep: [], stopping: [], assembled: [], streams: [], statuses: [], assistantStream: [], session: [] }
  const offs = [
    ctx.on('agent/created', (payload) => { seen.created = Object.keys(payload); seen.createdSource = payload.source }),
    ctx.on('agent/disposed', (payload) => { seen.disposed = Object.keys(payload) }),
    ctx.on('agent/pre-step', async (payload, next) => { seen.preStep.push({ keys: Object.keys(payload), turn: payload.turn, step: payload.step }); return next() }),
    ctx.on('agent/turn-stopping', async (payload) => { seen.stopping.push({ keys: Object.keys(payload) }) }),
    ctx.on('agent/status', (payload) => { seen.statuses.push(payload.status) }),
    ctx.on('agent/assistant-stream', (payload) => { seen.assistantStream.push(Object.keys(payload)) }),
    ctx.on('agent/request', async (payload, next) => { seen.request = Object.keys(payload); return next() }),
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => { const value = await next(); seen.assembled.push(Object.keys(assembly)); return value }),
    ctx.on('llm/stream', (options, next) => { seen.streams.push({ keys: Object.keys(options), messageCount: options.messages.length }); return next() }),
    ctx.on('session/event', (_session, event) => { seen.session.push(event.type) }),
  ]
  const agent = await ctx.agentLoop.create('probe-turn', { provider: 'fake', model: 'fake-1' })
  await startTurn(ctx, agent, createUserMessage, 'say hi', 1)
  await sleep(20)

  check('agent/created reached a listener', seen.created !== undefined)
  check('agent/created payload carries agent/source/signal', seen.created !== undefined && ['agent', 'source', 'signal'].every((key) => seen.created.includes(key)), JSON.stringify(seen.created))
  check('agent/created names a source', typeof seen.createdSource === 'string', String(seen.createdSource))
  check('agent/pre-step reached a listener', seen.preStep.length > 0, JSON.stringify(seen.preStep[0]))
  check('agent/pre-step carries turn/step/messages', seen.preStep[0] !== undefined && ['messages', 'turn', 'step', 'signal', 'modelSelection'].every((key) => seen.preStep[0].keys.includes(key)), JSON.stringify(seen.preStep[0]))
  check('agent/request reached a listener', seen.request !== undefined, JSON.stringify(seen.request))
  check('system-prompt/assemble reached a listener', seen.assembled.length > 0)
  check('llm/stream reached a listener', seen.streams.length > 0)
  check('agent/assistant-stream reached a listener', seen.assistantStream.length > 0)
  check('agent/turn-stopping reached a listener', seen.stopping.length > 0, JSON.stringify(seen.stopping[0]))
  check('the turn produced turn/start..turn/end', ['turn/start', 'request/header', 'assistant/message', 'step/end', 'turn/end'].every((type) => seen.session.includes(type)), JSON.stringify(seen.session))
  check('the fake model saw the composed system prompt', adapter.calls.length === 1 && messageText(adapter.calls[0].messages[0]).includes('DeepSeek Harness'))
  check('the fake model saw the user prompt', adapter.calls.length === 1 && messageText(adapter.calls[0].messages.at(-1)) === 'say hi')
  check('agent/status changed while the turn ran', seen.statuses.includes('running') && seen.statuses.includes('idle'), JSON.stringify(seen.statuses))

  // Detach the live registry entry before removing listeners: agent/disposed is
  // dispatched through the agent carrier, and the root context is its ancestor.
  const entries = [...(ctx.agents.store?.values?.() ?? [])]
  const entry = entries.at(-1)
  if (entry !== undefined) ctx.agents.detachEntered(entry)
  check('agent/disposed found the live registry entry', entry !== undefined, `storeEntries=${entries.length}`)
  await sleep(20)
  for (const off of offs) off()
  check('agent/disposed reached a listener', seen.disposed !== undefined, JSON.stringify(seen.disposed))
  return { seen, adapterCalls: adapter.calls.length }
}

// --- Probe: agent/request model rewrite (refutes PreModelSwitch) -----------

async function probeRequestRewrite() {
  console.log('\n[probe] agent/request model rewrite')
  if (!FULL_TURN.every(has)) return skip('agent/request model rewrite', `missing ${FULL_TURN.filter((name) => !has(name)).join(', ')}`)
  const { ctx, createUserMessage } = await boot()
  const seen = { requests: [], errors: [] }
  const offs = [
    ctx.on('agent/request', async (payload, next) => {
      const seed = await next()
      seen.requests.push({ keys: Object.keys(seed), model: seed.model })
      return { ...seed, model: 'other-model' }
    }),
    ctx.on('agent/error', (payload) => { seen.errors.push(payload.error?.message ?? String(payload)) }),
  ]
  const agent = await ctx.agentLoop.create('probe-request-rewrite', { provider: 'fake', model: 'fake-1' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await sleep(300)
  for (const off of offs) off()
  check('agent/request fires per request, not on a model switch', seen.requests.length === 1, JSON.stringify(seen.requests))
  check('agent/request rejects a model rewrite after step preparation', seen.errors.some((message) => message.includes('after step preparation fixed')), JSON.stringify(seen.errors))
  return seen
}

// --- Probe 2: pre-step injection, reject, system prompt rewrite, llm rewrite

async function probeInfluence() {
  console.log('\n[probe] pre-step injection, system-prompt rewrite, llm/stream rewrite')
  if (!FULL_TURN.every(has)) return skip('prompt influence', `missing ${FULL_TURN.filter((name) => !has(name)).join(', ')}`)
  const { ctx, adapter, createUserMessage } = await boot({
    fakeScript: (call) => call === 1 ? textChunks('original') : textChunks('rewritten'),
  })
  let preStepCalls = 0
  let assistantText = ''
  const offs = [
    ctx.on('agent/pre-step', async (payload, next) => {
      preStepCalls += 1
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: 'PRE-STEP-CONTEXT' }], source: { kind: 'user' } })] }
    }),
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const value = await next()
      return { ...value, contexts: [...value.contexts, { name: 's9-probe', text: 'ASSEMBLED-CONTEXT', interpolate: false }] }
    }),
    // The consumer iterates the waterfall's return value directly, so this
    // listener must stay synchronous and return an async iterable, not a promise.
    ctx.on('llm/stream', (options, next) => {
      const stream = next()
      return (async function* replace() {
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') yield { ...chunk, text: 'REWRITTEN-OUTPUT' }
          else if (chunk.type === 'block-end' && chunk.block.type === 'text') yield { ...chunk, block: { ...chunk.block, text: 'REWRITTEN-OUTPUT' } }
          else yield chunk
        }
      })()
    }),
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'assistant/message') assistantText = (event.data?.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
    }),
  ]
  const agent = await ctx.agentLoop.create('probe-influence', { provider: 'fake', model: 'fake-1' })
  const ended = await startTurn(ctx, agent, createUserMessage, 'say hi', 1)
  await sleep(20)
  const first = adapter.calls[0]
  if (first === undefined) throw new Error(`no llm call; turn end reason ${JSON.stringify(ended.data?.reason)}`)
  const system = messageText(first.messages[0])
  const last = messageText(first.messages.at(-1))
  check('agent/pre-step can append model-visible context', last.includes('PRE-STEP-CONTEXT') || first.messages.some((m) => messageText(m).includes('PRE-STEP-CONTEXT')), JSON.stringify(first.messages.map((m) => m.role)))
  check('system-prompt/assemble can append a context section', first.messages.some((message) => messageText(message).includes('ASSEMBLED-CONTEXT')), JSON.stringify(first.messages.map((message) => [message.role, messageText(message).slice(0, 60)])))
  check('llm/stream can replace the streamed answer', assistantText === 'REWRITTEN-OUTPUT', JSON.stringify(assistantText))
  for (const off of offs) off()
  return { preStepCalls, system: system.slice(0, 200), assistantText, calls: adapter.calls.length }
}

// --- Probe 3: tools/pre-execute, tools/post-execute, failure context ---------

async function probeTools() {
  console.log('\n[probe] tool waterfalls (success, deny, failure context)')
  if (!FULL_TURN.every(has)) return skip('tool waterfalls', `missing ${FULL_TURN.filter((name) => !has(name)).join(', ')}`)
  const { ctx, adapter, createUserMessage } = await boot({
    fakeScript: (call) => call === 1 ? toolChunks('call_echo', 'echo', { text: 'hi' }) : call === 2 ? toolChunks('call_boom', 'boom', {}) : textChunks('done'),
  })
  ctx.tools.register({
    name: 'echo',
    description: 'Echo the text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return { echoed: args?.text ?? '' } },
  })
  ctx.tools.register({
    name: 'boom',
    description: 'Always throws.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() { throw new Error('boom from the tool') },
  })
  const seen = { pre: [], post: [], errors: [], batch: undefined, preSteps: [] }
  const offs = [
    ctx.on('agent/error', (payload) => { seen.errors.push(payload.error?.stack ?? JSON.stringify(Object.keys(payload))) }),
    ctx.on('agent/pre-step', async (payload, next) => { seen.preSteps.push({ turn: payload.turn, step: payload.step }); return next() }),
    ctx.on('tools/execute', async (payload, next) => { seen.batch = Object.keys(payload); return next() }),
    ctx.on('tools/pre-execute', async (exec, next) => { seen.pre.push({ name: exec.name, keys: Object.keys(exec) }); return next() }),
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      seen.post.push({ name: exec.name, isError: result.isError === true, keys: Object.keys(result) })
      if (exec.name === 'boom' && decision.kind === 'accept') {
        return { ...decision, additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'FAILURE-CONTEXT' }], source: { kind: 'user' } })] }
      }
      return decision
    }),
  ]
  const agent = await ctx.agentLoop.create('probe-tools', { provider: 'fake', model: 'fake-1' })
  const ended = await startTurn(ctx, agent, createUserMessage, 'run the tools', 1)
  await sleep(20)
  const endReason = JSON.stringify(ended.data?.reason) + ' errors=' + JSON.stringify(seen.errors)
  await sleep(20)
  check('tools/execute wraps one call before execution (not a batch)', seen.batch !== undefined && seen.batch.includes('name') && seen.batch.includes('arguments'), JSON.stringify(seen.batch))
  check('tools/pre-execute observes a loop-driven call', seen.pre.some((entry) => entry.name === 'echo'))
  check('tools/post-execute observes a successful result', seen.post.some((entry) => entry.name === 'echo' && entry.isError === false))
  check('tools/post-execute observes a failed result', seen.post.some((entry) => entry.name === 'boom' && entry.isError === true))
  check('tools/post-execute also fires on success (PostToolUseFailure needs result.isError)', seen.post.some((entry) => entry.name === 'echo' && entry.isError === false) && seen.post.filter((entry) => entry.isError === true).length === 1, JSON.stringify(seen.post.map((entry) => [entry.name, entry.isError])))
  check('without the isError filter the count is wrong (2 vs 1)', seen.post.length === 2 && seen.post.filter((entry) => entry.isError === true).length === 1, JSON.stringify(seen.post.map((entry) => [entry.name, entry.isError])))
  check('agent/pre-step fires once per model step, not once per turn', seen.preSteps.length === 3 && seen.preSteps.map((entry) => entry.step).join(',') === '1,2,3', JSON.stringify(seen.preSteps))
  check('agent/pre-step step===1 selects one call per turn (UserPromptSubmit filter)', seen.preSteps.filter((entry) => entry.step === 1).length === 1, JSON.stringify(seen.preSteps))
  const third = adapter.calls[2]
  check('a failed result can carry additionalContexts to the next request', third !== undefined && third.messages.some((message) => messageText(message).includes('FAILURE-CONTEXT')), `calls=${adapter.calls.length} end=${endReason} third=${JSON.stringify(third?.messages.map((m) => [m.role, messageText(m).slice(0, 40)]))}`)
  for (const off of offs) off()
  return { pre: seen.pre, post: seen.post, calls: adapter.calls.length, endReason, errors: seen.errors }
}

// --- Probe 4: approval/request ---------------------------------------------

async function probeApproval() {
  console.log('\n[probe] approval/request waterfall')
  if (!has('dsh-user-approval')) return skip('approval/request', 'dsh-user-approval is not in this harness')
  if (!FULL_TURN.every(has)) return skip('approval/request', `missing ${FULL_TURN.filter((name) => !has(name)).join(', ')}`)
  const Approval = (await load('dsh-user-approval/lib/index.js')).default
  const { ctx, adapter, createUserMessage } = await boot({
    plugins: [[Approval, {}]],
    fakeScript: (call) => call === 1 ? toolChunks('call_echo', 'echo', { text: 'hi' }) : textChunks('done'),
  })
  ctx.tools.register({
    name: 'echo',
    description: 'Echo the text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return { echoed: args?.text ?? '' } },
  })
  await until(() => ctx.get('approval'), 3000, 'approval')
  const seen = { requests: [], session: [] }
  let outcome
  const offs = [
    ctx.on('approval/request', async (request) => { seen.requests.push({ keys: Object.keys(request), toolName: request.toolName, callId: request.callId, hasToolInput: 'tool_input' in request }); return 'rejected' }),
    ctx.on('session/event', (_session, event) => { if (event.type.startsWith('approval/')) seen.session.push({ type: event.type, dataKeys: Object.keys(event.data ?? {}) }) }),
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'echo' && outcome === undefined) {
        outcome = await ctx.approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal })
      }
      return next()
    }),
  ]
  const agent = await ctx.agentLoop.create('probe-approval', { provider: 'fake', model: 'fake-1' })
  await startTurn(ctx, agent, createUserMessage, 'ask', 1)
  await sleep(20)
  check('approval/request reached a listener', seen.requests.length === 1, JSON.stringify(seen.requests[0]))
  check('approval/request payload names the tool and call', seen.requests[0]?.toolName === 'echo' && typeof seen.requests[0]?.callId === 'string')
  check('a listener decision is the normalized outcome', outcome === 'rejected', String(outcome))
  check('approval/asked and approval/decided were recorded', ['approval/asked', 'approval/decided'].every((type) => seen.session.some((entry) => entry.type === type)), JSON.stringify(seen.session))
  check('approval/request has toolName/callId but no tool_input (correlation required)', seen.requests[0]?.hasToolInput === false && typeof seen.requests[0]?.toolName === 'string' && typeof seen.requests[0]?.callId === 'string', JSON.stringify(seen.requests[0]))
  check('approval/asked and approval/decided are notification-only session records', seen.session.every((entry) => entry.dataKeys.length > 0), JSON.stringify(seen.session))
  for (const off of offs) off()
  return { outcome, requests: seen.requests, session: seen.session }
}

// --- Probe 5: working-directory/access + working-directory/change -----------

async function probeWorkingDirectory() {
  console.log('\n[probe] working-directory seam')
  if (!has('dsh-fs-local') || !has('dsh-working-directory')) return skip('working-directory', 'dsh-fs-local or dsh-working-directory is not in this harness')
  const FileSystem = (await load('dsh-fs-local/lib/index.js')).default
  const WorkingDirectory = (await load('dsh-working-directory/lib/index.js')).default
  const { ctx, adapter, createUserMessage } = await boot({
    plugins: [[FileSystem, { cwd: process.cwd() }], [WorkingDirectory, { defaultDirectory: process.cwd() }]],
  })
  await until(() => ctx.get('workingDirectory'), 3000, 'workingDirectory')
  const seen = { access: [], session: [] }
  const offs = [
    ctx.on('working-directory/access', async (request, next) => { seen.access.push({ keys: Object.keys(request), path: request.path }); return next() }),
    ctx.on('session/event', (_session, event) => { if (event.type === 'working-directory/change') seen.session.push({ keys: Object.keys(event.data ?? {}), data: event.data }) }),
  ]
  const agent = await ctx.agentLoop.create('probe-cwd', { provider: 'fake', model: 'fake-1' })
  const target = join(process.cwd(), 'spikes')
  await ctx.workingDirectory.set(agent, target)
  await startTurn(ctx, agent, createUserMessage, 'where am I', 1)
  await sleep(20)
  check('working-directory/access reached a listener', seen.access.some((entry) => entry.path === target), JSON.stringify(seen.access))
  check('working-directory/access also fires with path:null (pre-access, not a change event)', seen.access.some((entry) => entry.path === null), JSON.stringify(seen.access))
  check('working-directory/access carries no old/new cwd', seen.access.every((entry) => !entry.keys.includes('previous') && !entry.keys.includes('cwd')), JSON.stringify(seen.access[0]))
  check('working-directory/change is the record and carries only the new cwd', seen.session.length === 1 && seen.session[0].keys.join(',') === 'cwd', JSON.stringify(seen.session))
  check('the change notice reached the model', adapter.calls[0]?.messages.some((message) => messageText(message).includes('working directory changed')), JSON.stringify(adapter.calls[0]?.messages.map((m) => messageText(m).slice(0, 60))))
  let denied
  const offDeny = ctx.on('working-directory/access', async (request, next) => { if (request.path?.endsWith('/denied')) throw new Error('s9 working-directory deny'); return next() })
  try { await ctx.workingDirectory.set(agent, join(process.cwd(), 'denied')) }
  catch (error) { denied = String(error?.message ?? error) }
  offDeny()
  check('a throwing access listener denies the change', denied === 's9 working-directory deny', String(denied))
  for (const off of offs) off()
  return { access: seen.access, change: seen.session }
}

// --- Probe 6: fs/observed ---------------------------------------------------

async function probeFs() {
  console.log('\n[probe] fs/observed (tool:write)')
  if (!has('dsh-fs-local') || !has('dsh-tool-fs') || !has('dsh-working-directory')) return skip('fs/observed', 'fs/tool-fs/working-directory is not in this harness')
  const FileSystem = (await load('dsh-fs-local/lib/index.js')).default
  const WorkingDirectory = (await load('dsh-working-directory/lib/index.js')).default
  const ToolFs = await loadPlugin('dsh-tool-fs')
  const { ctx, adapter, createUserMessage } = await boot({
    plugins: [[FileSystem, { cwd: process.cwd() }], [WorkingDirectory, { defaultDirectory: process.cwd() }], [ToolFs, {}]],
    fakeScript: (call) => call === 1
      ? toolChunks('call_write', 'write', { file_path: join(process.cwd(), 'spikes', 's9-host-events', 'out', 'observed.txt'), content: 'observed' })
      : call === 2
        ? toolChunks('call_read', 'read', { file_path: join(process.cwd(), 'spikes', 's9-host-events', 'out', 'observed.txt') })
        : call === 3
          ? toolChunks('call_edit', 'edit', { file_path: join(process.cwd(), 'spikes', 's9-host-events', 'out', 'observed.txt'), old_string: 'observed', new_string: 'edited' })
          : textChunks('done'),
  })
  await until(() => ctx.get('fs'), 3000, 'fs')
  mkdirSync(join(HERE, 'out'), { recursive: true })
  const seen = []
  const off = ctx.on('fs/observed', (target, observation, exec) => { seen.push({ displayPath: target.displayPath, kind: observation.kind, tool: exec.name }) })
  const agent = await ctx.agentLoop.create('probe-fs', { provider: 'fake', model: 'fake-1' })
  await startTurn(ctx, agent, createUserMessage, 'write it', 1)
  await sleep(30)
  check('fs/observed reached a listener', seen.length > 0, JSON.stringify(seen))
  check('fs/observed carries the target and observation', seen[0]?.displayPath !== undefined && seen[0]?.kind !== undefined)
  check('fs/observed also fires on reads (FileChanged needs a tool filter)', seen.some((entry) => entry.tool === 'read') && seen.some((entry) => entry.tool === 'write') && seen.some((entry) => entry.tool === 'edit'), JSON.stringify(seen))
  check("tool in {write,edit} && kind==='present' selects exactly the two change observations", seen.filter((entry) => ['write', 'edit'].includes(entry.tool) && entry.kind === 'present').length === 2, JSON.stringify(seen))
  check('apply_patch was NOT exercised (the wiring ticket must confirm it)', !seen.some((entry) => entry.tool === 'apply_patch'))
  off()
  return { seen }
}

// --- Probe 7: subagent lifecycle -------------------------------------------

async function probeSubagent() {
  console.log('\n[probe] subagent/start and subagent/end')
  if (!has('dsh-subagent') || !has('dsh-subagent-fork-in-process')) return skip('subagent lifecycle', 'dsh-subagent is not in this harness')
  if (!FULL_TURN.every(has)) return skip('subagent lifecycle', `missing ${FULL_TURN.filter((name) => !has(name)).join(', ')}`)
  const SubagentRuntime = (await load('dsh-subagent/lib/index.js')).default
  const ForkProvider = await loadPlugin('dsh-subagent-fork-in-process')
  const FileSystem = (await load('dsh-fs-local/lib/index.js')).default
  const WorkingDirectory = (await load('dsh-working-directory/lib/index.js')).default
  const { ctx, createUserMessage } = await boot({
    plugins: [
      [FileSystem, { cwd: process.cwd() }],
      [WorkingDirectory, { defaultDirectory: process.cwd() }],
      [SubagentRuntime, {}],
      [ForkProvider, { providerName: 'fork' }],
    ],
  })
  await until(() => ctx.get('subagents'), 3000, 'subagents')
  const seen = { start: [], end: [], providers: [], created: [], disposed: [] }
  const offs = [
    ctx.on('agent/created', (payload) => { seen.created.push({ id: payload.agent.id, parentSession: payload.agent.session.header.parentSession, source: payload.source }) }),
    ctx.on('agent/disposed', (payload) => { seen.disposed.push({ id: payload.agent.id, parentSession: payload.agent.session.header.parentSession }) }),
    ctx.on('subagent/start', (payload) => { seen.start.push({ keys: Object.keys(payload), provider: payload.provider, id: payload.id }) }),
    ctx.on('subagent/end', (payload) => { seen.end.push({ keys: Object.keys(payload), stopReason: payload.stopReason }) }),
    ctx.on('subagent/provider-added', (payload) => { seen.providers.push(payload.provider?.name ?? payload.name ?? Object.keys(payload)) }),
  ]
  const parent = await ctx.agentLoop.create('probe-subagent-parent', { provider: 'fake', model: 'fake-1' })
  await startTurn(ctx, parent, createUserMessage, 'parent turn', 1)
  await sleep(20)
  const endSeen = new Promise((resolveEnd) => {
    const off = ctx.on('subagent/end', (payload) => { off(); resolveEnd(payload) })
    setTimeout(() => { off(); resolveEnd(undefined) }, 8000)
  })
  const activation = await ctx.subagents.startActivation({
    provider: 'fork',
    parent,
    prompt: [{ type: 'text', text: 'child prompt' }],
    delivery: 'caller',
    label: 's9 probe child',
    signal: new AbortController().signal,
  })
  const ended = await endSeen
  check('subagent/start reached a listener', seen.start.length > 0, JSON.stringify(seen.start))
  check('subagent/start carries run/provider/parent/id', seen.start[0] !== undefined && ['runId', 'provider', 'parentSessionId', 'id'].every((key) => seen.start[0].keys.includes(key)))
  check('subagent/end reached a listener', ended !== undefined, JSON.stringify(seen.end))
  check('subagent/end carries a stop reason', ended !== undefined && ended.stopReason !== undefined, JSON.stringify(seen.end[0]))
  check('the activation exposes the child id', activation?.childId !== undefined, JSON.stringify(Object.keys(activation ?? {})))
  check('agent/created also fires for the subagent child (filter header.parentSession)', seen.created.some((entry) => entry.id === activation?.childId && entry.parentSession === parent.id) && seen.created.some((entry) => entry.id === parent.id && entry.parentSession === undefined), JSON.stringify(seen.created))
  check('without the parentSession filter the count is wrong (2 vs 1)', seen.created.filter((entry) => entry.parentSession === undefined).length === 1 && seen.created.length >= 2, JSON.stringify(seen.created))
  try { await activation?.dispose?.() } catch {}
  await sleep(50)
  check('agent/disposed covers subagent children (non-vacuous)', seen.disposed.some((entry) => entry.id === activation?.childId && entry.parentSession === parent.id), JSON.stringify(seen.disposed))
  for (const off of offs) off()
  return { start: seen.start, end: seen.end, providers: seen.providers, activation: { childId: activation?.childId, runId: activation?.runId } }
}

// --- Probe: settings/document-updated (ConfigChange) ------------------------

async function probeSettings() {
  console.log('\n[probe] settings/document-updated')
  if (!has('dsh-settings')) return skip('settings/document-updated', 'dsh-settings is not in this harness')
  const Loader = (await load('cordis-plugin-loader/lib/index.js')).default
  const Settings = (await load('dsh-settings/lib/index.js')).default
  const z = (await import(pathToFileURL(join(HARNESS, 'schemastery/lib/index.mjs')).href)).default
  const out = join(HERE, 'out', 'settings-profile')
  mkdirSync(out, { recursive: true })
  const schema = z.object({ mode: z.string().default('a').volatile() })
  const box = {}
  class FakeDeps {
    static inject = ['loader']
    static name = 's9-fake-settings-deps'
    constructor(ctx) {
      const fiber = { uid: 9001, state: 2, runtime: { Config: schema }, effectiveConfig: { mode: 'a' }, ctx: { fiber: { state: 2 } } }
      box.entry = { id: 's9-config-entry', options: { id: 's9-config-entry', config: {} }, fiber }
      ctx.provide('configEditor', {
        documentPath: join(out, 'profile.yml'),
        configuration: () => [{ entry: box.entry, inherited: {}, override: {} }],
        edit: async () => {},
      })
      ctx.provide('profileContext', { home: out, name: 's9' })
    }
  }
  const { ctx } = await boot({ plugins: [[Loader, { baseUrl: join(HARNESS, '..', '..') }], [FakeDeps, {}], [Settings, {}]] })
  await until(() => ctx.get('settings'), 3000, 'settings')
  const seen = []
  const off = ctx.on('settings/document-updated', (ns, revision) => { seen.push({ ns, revision }) })
  ctx.settings.describe()
  const first = seen.slice()
  ctx.settings.describe()
  const afterSame = seen.length
  box.entry.options.config = { mode: 'b' }
  ctx.settings.describe()
  await sleep(20)
  off()
  check('settings/document-updated reached a listener', seen.length >= 2, JSON.stringify(seen))
  check('the first read emits revision 0 (it is also a first-read event)', first.length === 1 && first[0].revision === 0, JSON.stringify(first))
  check('an unchanged second read emits nothing', afterSame === 1, `${afterSame} events: ${JSON.stringify(seen)}`)
  check('a changed document emits revision 1 (real change, not just compare)', seen[seen.length - 1]?.revision === 1, JSON.stringify(seen))
  check('settings/document-updated carries ns and revision only', seen.every((entry) => Object.keys(entry).join(',') === 'ns,revision'), JSON.stringify(seen))
  return { seen }
}

// --- Probe 8: compaction markers -------------------------------------------

async function probeCompaction() {
  console.log('\n[probe] compaction/start and compaction/end')
  if (!has('dsh-compaction-basic') || !has('dsh-token-meter')) return skip('compaction markers', 'dsh-compaction-basic is not in this harness')
  if (!FULL_TURN.every(has)) return skip('compaction markers', `missing ${FULL_TURN.filter((name) => !has(name)).join(', ')}`)
  const TokenMeter = (await load('dsh-token-meter/lib/index.js')).default
  const Compaction = (await load('dsh-compaction-basic/lib/index.js')).default
  const { ctx, createUserMessage } = await boot({
    plugins: [[TokenMeter, {}], [Compaction, { auto: true, thresholdRatio: 0.1, retainRatio: 0.02, headroomTokens: 0, maxTokens: 512 }]],
  })
  await until(() => ctx.get('compaction'), 3000, 'compaction')
  await until(() => ctx.get('tokenMeter'), 3000, 'tokenMeter')
  const sessionEvents = []
  const waterfall = []
  const offs = [
    ctx.on('session/event', (_session, event) => { if (event.type.startsWith('compaction/')) sessionEvents.push({ type: event.type, dataKeys: Object.keys(event.data ?? {}) }) }),
    ctx.on('compaction/summary-error', (payload, next) => { waterfall.push(Object.keys(payload)); return next() }),
  ]
  const errors = []
  ctx.on('agent/error', (payload) => { errors.push(payload?.error?.message ?? String(payload)) })
  const agent = await ctx.agentLoop.create('probe-compaction', { provider: 'fake', model: 'fake-1' })
  await startTurn(ctx, agent, createUserMessage, 'x'.repeat(20000), 1)
  await agent.whenIdle()
  await startTurn(ctx, agent, createUserMessage, 'y'.repeat(20000), 2)
  await agent.whenIdle()
  await startTurn(ctx, agent, createUserMessage, 'trigger pressure', 3)
  await sleep(50)
  const markers = sessionEvents.map((entry) => entry.type)
  const firstStart = markers.indexOf('compaction/start')
  const firstSummary = markers.indexOf('compaction/summary')
  const firstEnd = markers.indexOf('compaction/end')
  check('the compaction engine compacted the history', markers.includes('compaction/start') && markers.includes('compaction/end'), JSON.stringify(markers))
  check('compaction/summary was recorded', markers.includes('compaction/summary'), JSON.stringify(markers))
  check('compaction/start is observed before summary (PreCompact is notification-only)', firstStart !== -1 && firstSummary !== -1 && firstStart < firstSummary, JSON.stringify(markers))
  check('compaction/end is observed after summary (PostCompact is notification-only)', firstEnd !== -1 && firstSummary !== -1 && firstSummary < firstEnd, JSON.stringify(markers))
  check('compaction markers carry durable data only (no decision protocol)', sessionEvents.every((entry) => entry.dataKeys.length > 0), JSON.stringify(sessionEvents))
  check('compaction/summary-error is the only compaction waterfall', waterfall.length === 0, JSON.stringify(waterfall))
  for (const off of offs) off()
  return { markers, events: sessionEvents, waterfall, errors }
}

// ---------------------------------------------------------------------------
// 3. Report
// ---------------------------------------------------------------------------

const results = {}
for (const [name, fn] of Object.entries({
  turn: probeTurn,
  requestRewrite: probeRequestRewrite,
  influence: probeInfluence,
  tools: probeTools,
  approval: probeApproval,
  workingDirectory: probeWorkingDirectory,
  fs: probeFs,
  settings: probeSettings,
  subagent: probeSubagent,
  compaction: probeCompaction,
})) {
  try {
    results[name] = await fn()
  } catch (error) {
    results[name] = { error: String(error?.stack ?? error) }
    check(`probe ${name} completed`, false, String(error?.message ?? error))
  }
}

const passed = checks.filter((entry) => entry.ok).length
console.log(`\n${passed}/${checks.length} checks passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`)
if (checks.length === 0) {
  console.error('s9: no checks ran; fetch the pin with scripts/fetch-harness.mjs and pass that tree, not a bare one')
} else if (skipped.length > 0) {
  console.error(`s9: ${skipped.length} required probe(s) skipped; a vacuous run is a failure, not a pass`)
}
const out = join(HERE, 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'report.json'), `${JSON.stringify({ harness: { dir: HARNESS, source: HARNESS_SOURCE, version: version() }, sweep: { count: sweepCalls.length, byMethod: countByMethod, events: [...sweepByName].map(([event, calls]) => ({ event, calls })) }, results, checks, skipped }, null, 2)}\n`)
console.log(`wrote ${join(out, 'report.json')}`)
process.exit(checks.length === 0 || skipped.length > 0 ? 1 : passed === checks.length ? 0 : 1)
