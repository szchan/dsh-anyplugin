// S16: which `agents/*.md` frontmatter faces can the pinned DSH host express?
//
// S10 answered the catalog question (one tool per persona, body in the child
// user message). S16 asks the remaining question per *face*: does the seam the
// materializer already uses — `ctx.subagents.startActivation` — carry the value,
// and does the child observe the effect?
//
// The checks below are child-side wherever possible: the child's first model
// request (recorded by a stub adapter), the child session header (the cwd the
// host actually created), and the number of model requests a capped child made.
// A field that only appears in our own config is not evidence, so every check
// names the call and the value it observed.
//
// Run:
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
//     node spikes/s16-agent-faces/run.mjs
//
// The spike stays: it is the artifact behind the S16 table in
// docs/ARCHITECTURE.md §10, and it must be re-run when the pin moves.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'

const REQUIRED = [
  'cordis',
  'dsh-session',
  'dsh-session-persistence-jsonl',
  'dsh-session-projection',
  'dsh-system-prompt',
  'dsh-tools',
  'dsh-agent',
  'dsh-llm',
  'dsh-agent-loop',
  'dsh-tool-executor-native',
  'dsh-fs-local',
  'dsh-working-directory',
  'dsh-subagent',
  'dsh-subagent-fork-in-process',
]

function candidates(root) {
  return [join(root, 'node_modules', '@deepseek-ai'), join(root, '@deepseek-ai'), root, dirname(root)]
}
function usable(candidate) {
  return candidate !== undefined && REQUIRED.every((name) => existsSync(join(candidate, name, 'package.json')))
}
function missingIn(candidate) {
  return REQUIRED.filter((name) => !existsSync(join(candidate, name, 'package.json')))
}
function locateHarness() {
  const explicit = process.env.DSH_HARNESS_DIR?.trim()
  if (explicit) {
    const root = resolve(explicit)
    const candidate = candidates(root).find(usable)
    if (candidate === undefined) {
      console.error(`DSH_HARNESS_DIR=${root} is set but unusable (missing: ${missingIn(candidates(root)[0]).join(', ')})`)
      process.exit(2)
    }
    return { dir: candidate, source: 'DSH_HARNESS_DIR' }
  }
  const roots = []
  const install = process.env.DSH_INSTALL_DIR?.trim()
  if (install) roots.push([resolve(install), 'DSH_INSTALL_DIR'])
  roots.push([join(REPO, '.harness', VERSION), '.harness'])
  for (const [root, source] of roots) {
    const candidate = candidates(root).find(usable)
    if (candidate !== undefined) return { dir: candidate, source }
  }
  console.error(`no usable harness: ${roots.map(([r, s]) => `${s}=${r}`).join(', ')}`)
  console.error(`missing: ${missingIn(candidates(roots[0][0])[0]).join(', ')}`)
  process.exit(2)
}

const { dir: HARNESS, source: HARNESS_SOURCE } = locateHarness()
const pathToFileURL = (path) => new URL(`file://${path}`).href
const version = () => JSON.parse(readFileSync(join(HARNESS, 'dsh-subagent', 'package.json'), 'utf8')).version

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const until = async (fn, label, timeoutMs = 5000) => {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

const textChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: 'stop' },
]
const toolCallChunks = (call) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } },
  { type: 'finish', reason: 'tool-calls' },
]

async function main() {
  const { Context } = await import(pathToFileURL(join(HARNESS, 'cordis', 'lib', 'index.js')))
  const SessionStore = (await import(pathToFileURL(join(HARNESS, 'dsh-session', 'lib', 'index.js')))).default
  const JsonlPersistence = await import(pathToFileURL(join(HARNESS, 'dsh-session-persistence-jsonl', 'lib', 'index.js')))
  const SessionProjections = (await import(pathToFileURL(join(HARNESS, 'dsh-session-projection', 'lib', 'index.js')))).default
  const SystemPrompt = (await import(pathToFileURL(join(HARNESS, 'dsh-system-prompt', 'lib', 'index.js')))).default
  const ToolsService = (await import(pathToFileURL(join(HARNESS, 'dsh-tools', 'lib', 'index.js')))).default
  const AgentRegistry = (await import(pathToFileURL(join(HARNESS, 'dsh-agent', 'lib', 'index.js')))).default
  const FileSystem = (await import(pathToFileURL(join(HARNESS, 'dsh-fs-local', 'lib', 'index.js')))).default
  const WorkingDirectory = (await import(pathToFileURL(join(HARNESS, 'dsh-working-directory', 'lib', 'index.js')))).default
  const { default: LlmRuntime, LlmAdapter } = await import(pathToFileURL(join(HARNESS, 'dsh-llm', 'lib', 'index.js')))
  const AgentLoop = (await import(pathToFileURL(join(HARNESS, 'dsh-agent-loop', 'lib', 'index.js')))).default
  const SubagentRuntime = (await import(pathToFileURL(join(HARNESS, 'dsh-subagent', 'lib', 'index.js')))).default
  const ForkProvider = await import(pathToFileURL(join(HARNESS, 'dsh-subagent-fork-in-process', 'lib', 'index.js')))
  const nativeExecutor = await import(pathToFileURL(join(HARNESS, 'dsh-tool-executor-native', 'lib', 'index.js')))

  class RecordingAdapter extends LlmAdapter {
    constructor() {
      super()
      this.calls = []
      this.resolved = []
      this.loopProbe = false
    }
    async resolveModel(provider, model) {
      this.resolved.push({ provider, model })
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 8192 },
        defaultMaxTokens: 1024,
        // Advertise the three Claude levels so the raw token can pass the
        // runtime validation; the value space stays the adapter's, not Claude's.
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
      }
    }
    async *stream(options) {
      const texts = (options.messages ?? []).map((message) => ({
        role: message.role,
        text: (message.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      }))
      this.calls.push({
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        texts,
        tools: (options.tools ?? []).map((tool) => tool.name),
      })
      const inLoopProbe = this.loopProbe && texts.some((entry) => entry.text.includes('LOOP-PROBE'))
      const loopCalls = this.calls.filter((call) => call.texts.some((entry) => entry.text.includes('LOOP-PROBE'))).length
      const chunks = inLoopProbe && loopCalls <= 2
        ? toolCallChunks({ id: `call_s16_${this.calls.length}`, name: 'echo', arguments: '{}' })
        : textChunks('ok')
      for (const chunk of chunks) yield chunk
    }
  }

  const ctx = new Context()
  const mount = (plugin, config = {}) => ctx.plugin(plugin, config)
  mount(SessionStore)
  rmSync(join(HERE, 'out', 'sessions'), { recursive: true, force: true })
  mkdirSync(join(HERE, 'out', 'sessions'), { recursive: true })
  mount(JsonlPersistence, { root: join(HERE, 'out', 'sessions'), compression: 'none' })
  mount(SessionProjections)
  mount(SystemPrompt)
  mount(ToolsService)
  mount(AgentRegistry)
  mount(nativeExecutor)
  mount(FileSystem, { cwd: process.cwd() })
  mount(WorkingDirectory, { defaultDirectory: process.cwd() })
  mount(SubagentRuntime)
  mount(ForkProvider, { providerName: 'fork' })
  mount(LlmRuntime)
  mount(AgentLoop)
  for (const name of ['agents', 'tools', 'subagents', 'llm', 'agentLoop', 'sessions']) {
    await until(() => ctx.get(name), name)
  }

  ctx.tools.register({
    name: 'echo',
    description: 'Echo a value back; used to keep the child in a tool loop.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: async () => ({ ok: true }),
  })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['fake'], adapter)

  const DATA = join(HERE, 'out', 'cwd')
  mkdirSync(DATA, { recursive: true })
  const root = await ctx.agentLoop.create('s16-root', { provider: 'fake', model: 'fake-1' }, { cwd: DATA })

  const childOf = (parentSession) =>
    new Promise((resolveChild) => {
      const off = ctx.on('agent/created', (payload) => {
        if (payload.agent.session.header.parentSession === parentSession) {
          off()
          resolveChild(payload.agent)
        }
      })
    })
  const endedChild = (parentSession) =>
    new Promise((resolveEnd) => {
      const off = ctx.on('subagent/end', (payload) => {
        if (payload.parentSessionId !== parentSession) return
        off()
        resolveEnd(payload)
      })
    })

  // One activation, one child. The extra keys are deliberately not fields of
  // SubagentActivationSpec; they are what an agent frontmatter carries.
  const activate = async (label, text, extra = {}) => {
    const created = childOf(root.id)
    const ended = endedChild(root.id)
    const activation = await ctx.subagents.startActivation({
      provider: 'fork',
      parent: root,
      prompt: [{ type: 'text', text }],
      delivery: 'caller',
      label,
      signal: new AbortController().signal,
      ...extra,
    })
    const child = await created
    const end = await ended
    const header = child.session?.header
    return { activation, child, end, header }
  }

  console.log(`harness: ${HARNESS} (${HARNESS_SOURCE}, ${version()})\n`)

  // A. every frontmatter key passed as an activation key, except the one
  //    agentOptions escape. None is a field; the child must be unchanged.
  const a = await activate('s16 all faces', 'ALL-FACES-PROBE', {
    tools: ['Read', 'Grep'],
    disallowedTools: ['Bash'],
    model: 'sonnet',
    effort: 'high',
    maxTurns: 1,
    isolation: 'worktree',
    skills: ['s16-skill'],
    memory: 'user',
    background: true,
    omitClaudeMd: true,
    color: 'red',
    autoCompactWindow: 200000,
  })
  const aCall = adapter.calls.find((call) => call.texts.some((entry) => entry.text.includes('ALL-FACES-PROBE')))
  check(
    'unknown activation keys are accepted and ignored (no refusal, no mapping)',
    a.end !== undefined && aCall !== undefined,
    JSON.stringify({ stopReason: a.end?.stopReason }),
  )
  check(
    '`tools`/`disallowedTools` do not restrict the child: it still sees the tool they would remove',
    (aCall?.tools ?? []).includes('echo'),
    JSON.stringify(aCall?.tools),
  )
  check(
    'top-level `model` is ignored: the child inherits the parent provider/model',
    aCall?.model === 'fake-1',
    JSON.stringify({ model: aCall?.model }),
  )
  check(
    'top-level `effort` is ignored: the child request has no reasoningEffort',
    aCall?.reasoningEffort === undefined,
    JSON.stringify({ reasoningEffort: aCall?.reasoningEffort }),
  )
  check(
    '`isolation: worktree` does not change the child cwd: it equals the parent session cwd',
    a.header?.cwd === DATA,
    JSON.stringify({ root: ctx.sessions.get(root.id)?.header?.cwd, child: a.header?.cwd }),
  )
  check(
    '`skills` is not a prompt field: no skill text reaches the child request',
    aCall !== undefined && !aCall.texts.some((entry) => entry.text.includes('s16-skill')),
    JSON.stringify(aCall?.texts?.map((entry) => entry.role)),
  )
  await a.activation?.dispose?.()

  // B. the one field the seam does carry: agentOptions. It reaches the provider
  //    as a raw id and a raw effort token — no Claude alias resolution.
  const b = await activate('s16 agent options', 'OPTIONS-PROBE', {
    agentOptions: { model: 'sonnet', reasoningEffort: 'high' },
  })
  const bCall = adapter.calls.find((call) => call.texts.some((entry) => entry.text.includes('OPTIONS-PROBE')))
  check(
    'agentOptions.model reaches the child model call as the raw model id "sonnet"',
    bCall?.model === 'sonnet' && adapter.resolved.some((entry) => entry.model === 'sonnet' && entry.provider === 'fake'),
    JSON.stringify({ model: bCall?.model, resolved: adapter.resolved.slice(-2) }),
  )
  check(
    'agentOptions.reasoningEffort reaches the child model call as the raw token "high"',
    bCall?.reasoningEffort === 'high',
    JSON.stringify({ reasoningEffort: bCall?.reasoningEffort }),
  )
  await b.activation?.dispose?.()

  // C. maxTurns: a capped child that keeps calling a tool. If the cap were
  //    carried, the child would stop after one agentic turn; the host issues a
  //    second model request instead.
  adapter.loopProbe = true
  const c = await activate('s16 max turns', 'LOOP-PROBE', { maxTurns: 1 })
  adapter.loopProbe = false
  const loopCalls = adapter.calls.filter((call) => call.texts.some((entry) => entry.text.includes('LOOP-PROBE')))
  check(
    '`maxTurns: 1` does not cap the child: it issues a second model request after a tool call',
    loopCalls.length >= 2,
    JSON.stringify({ requests: loopCalls.length, stopReason: c.end?.stopReason }),
  )
  await c.activation?.dispose?.()

  // D. The type-level claim: the request contract has no slot for any of the
  //    ten faces except the provider/model/effort escape. Read from the pin.
  const types = readFileSync(join(HARNESS, 'dsh-subagent', 'src', 'types.ts'), 'utf8')
  const start = types.indexOf('export interface SubagentStartRequest')
  const request = types.slice(start, types.indexOf('\n}', start))
  const faceFields = ['tools', 'disallowedTools', 'model', 'effort', 'maxTurns', 'isolation', 'skills', 'memory', 'background', 'omitClaudeMd', 'color', 'autoCompactWindow']
  const carried = faceFields.filter((field) => new RegExp(`^\\s+${field}\\??:`, 'm').test(request))
  check(
    'SubagentStartRequest carries none of the ten frontmatter keys (only prompt/parent/agentOptions/...)',
    carried.length === 0,
    JSON.stringify({ carried, fields: request.split('\n').filter((line) => /^\s+\w+\??:/.test(line)).map((line) => line.trim().split(/[?:]/)[0]) }),
  )

  const report = { harness: HARNESS, source: HARNESS_SOURCE, version: version(), checks, calls: adapter.calls.map((call) => ({ model: call.model, reasoningEffort: call.reasoningEffort, tools: call.tools, texts: call.texts.map((entry) => `${entry.role}:${entry.text.slice(0, 60)}`) })) }
  writeFileSync(join(HERE, 'out', 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
