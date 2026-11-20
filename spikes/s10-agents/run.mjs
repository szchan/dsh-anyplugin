// S10: can a plugin make its `agents/*.md` personas model-selectable in DSH?
//
// The question has three parts, and each is answered here by running the pinned
// harness rather than by reading a README:
//
//   1. what does `dsh-tool-subagent` put in `ctx.tools`? (one tool per provider
//      instance, fixed description, no per-agent name or description)
//   2. does a tool whose name/description comes from `agents/<name>.md` reach the
//      model exactly? (`ctx.tools.schemas()` is the model-visible evidence)
//   3. when that tool runs, does the child receive the agent body — and where?
//      (`startActivation` has no instructions field at this pin; the body is the
//      first block of the child's initial *user* message, ahead of the task)
//
// What happens to `model`, `effort`, `tools`, `disallowedTools`, `maxTurns` and
// `isolation` is probed last: the seam carries `agentOptions` (provider/model/
// effort) but no per-activation tool filter, turn cap, or isolation field, so
// the frontmatter keys are recorded in the IR and annotated `planned` — the
// harness neither maps nor refuses them; it never sees them.
//
// Run (the fetch installs the packages this spike boots; see s9's header):
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
//     node spikes/s10-agents/run.mjs
//
// A missing package is reported by name and the run exits 2: an explicitly
// configured but incomplete harness fails closed rather than falling back to
// another install, so a bare fetched tree is never reported as a green S10.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readClaudePlugin } from '../../packages/dsh-anyplugin-dialect-claude-code/src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'

const REQUIRED = [
  'cordis',
  'dsh-session',
  'dsh-session-projection',
  'dsh-system-prompt',
  'dsh-tools',
  'dsh-agent',
  'dsh-llm',
  'dsh-agent-loop',
  'dsh-tool-executor-native',
  'dsh-fs-local',
  'dsh-session-persistence-jsonl',
  'dsh-working-directory',
  'dsh-subagent',
  'dsh-subagent-spawn-in-process',
  'dsh-tool-subagent',
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
  // An explicit pin is a claim: an unusable DSH_HARNESS_DIR must fail, never
  // fall back to the Desktop install and report a green run for another harness.
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
const load = (name) => import(pathToFileURL(join(HARNESS, name, 'lib', 'index.js')).href)
const loadPackage = (name) => import(name.startsWith('.') || name.startsWith('/') ? name : pathToFileURL(join(HARNESS, name, 'lib', 'index.js')).href)
const version = () => JSON.parse(readFileSync(join(HARNESS, 'dsh-skill', 'package.json'), 'utf8')).version

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const until = async (fn, label, timeoutMs = 3000) => {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

function fakeAdapterClass(LlmAdapter) {
  return class FakeAdapter extends LlmAdapter {
    constructor() {
      super()
      this.calls = []
      this.resolved = []
    }
    async resolveModel(provider, model) {
      this.resolved.push({ provider, model })
      return { provider, id: model, name: model, context: { contextWindow: 8192 }, defaultMaxTokens: 1024 }
    }
    async *stream(options) {
      const texts = options.messages.map((message) => ({
        role: message.role,
        text: (message.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      }))
      this.calls.push({ model: options.model, texts, tools: (options.tools ?? []).map((tool) => tool.name) })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}

// The fixture is the input; nothing about the persona is hardcoded here.
const FIXTURE = join(REPO, 'fixtures', 'claude-agents')
const TASK = 'Review the retry-handling patch.'

async function main() {
  const { Context } = await load('cordis')
  const SessionStore = (await load('dsh-session')).default
  const JsonlPersistence = await load('dsh-session-persistence-jsonl')
  const SessionProjections = (await load('dsh-session-projection')).default
  const SystemPrompt = (await load('dsh-system-prompt')).default
  const ToolsService = (await load('dsh-tools')).default
  const AgentRegistry = (await load('dsh-agent')).default
  const FileSystem = (await load('dsh-fs-local')).default
  const WorkingDirectory = (await load('dsh-working-directory')).default
  const { default: LlmRuntime, LlmAdapter } = await load('dsh-llm')
  const AgentLoop = (await load('dsh-agent-loop')).default
  const SubagentRuntime = (await load('dsh-subagent')).default
  // This one is a plugin namespace (`{name, inject, apply}`), not a class.
  const SpawnProvider = await load('dsh-subagent-spawn-in-process')
  const ToolSubagent = await load('dsh-tool-subagent')
  const nativeExecutor = await loadPackage('dsh-tool-executor-native')
  const materializer = await import(pathToFileURL(join(REPO, 'packages', 'dsh-anyplugin-materialize-agents', 'src', 'index.ts')).href)

  const ir = readClaudePlugin(FIXTURE, { source: 'plugin-dir:fixtures/claude-agents' })
  const agent = ir.agents[0]
  const PLUGIN = ir.plugin.name
  const TOOL_NAME = `${PLUGIN}:${agent.name}`
  const DESCRIPTION = agent.description
  const BODY = agent.content.trim()

  const ctx = new Context()
  const fibers = []
  const mount = (plugin, config = {}) => fibers.push(ctx.plugin(plugin, config))
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
  mount(SpawnProvider, { providerName: 'spawn' })
  // Two instances of the same consumer: if the tool were per-agent, these would
  // be N; they are one per provider instance, with identical descriptions.
  mount(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
  mount(ToolSubagent, { provider: 'spawn', toolName: 'delegate' })

  mount(LlmRuntime)
  mount(AgentLoop)
  for (const name of ['agents', 'tools', 'subagents', 'llm', 'agentLoop', 'workingDirectory']) {
    await until(() => ctx.get(name), name)
  }

  // Mounted only now that `ctx.tools` is live. The materializer has no static
  // `inject`, so a late tools service is awaited instead of silently skipped.
  mount(materializer, {
    plugin: PLUGIN,
    agents: [agent],
  })
  await sleep(50)
  const adapter = new (fakeAdapterClass(LlmAdapter))()
  ctx.llm.registerAdapter(['fake'], adapter)

  console.log(`harness: ${HARNESS} (${HARNESS_SOURCE}, ${version()})\n`)

  const schemas = ctx.tools.schemas()
  const byName = new Map(schemas.map((schema) => [schema.name, schema]))
  check('dsh-tool-subagent registers one tool per provider instance', byName.has('subagent') && byName.has('delegate'), [...byName.keys()].join(', '))
  check(
    'two instances have the same fixed description (nothing per-agent)',
    byName.get('subagent')?.description === byName.get('delegate')?.description,
  )
  check(
    'the delegation description is fixed provider wording, not the agent text',
    /Delegate a self-contained task to a subagent/.test(byName.get('subagent')?.description ?? '') &&
      !(byName.get('subagent')?.description ?? '').includes(DESCRIPTION),
    JSON.stringify(byName.get('subagent')?.description?.slice(0, 80)),
  )
  check(
    'without allowedAgentPresets there is no agent_preset enum (no per-agent address)',
    byName.get('subagent')?.parameters?.properties?.agent_preset === undefined &&
      ctx.get('agentPresets') === undefined,
  )
  check('the materializer registers a tool named <plugin>:<agent>', byName.has(TOOL_NAME), TOOL_NAME)
  check('its description is the frontmatter description byte for byte', byName.get(TOOL_NAME)?.description === DESCRIPTION)
  check('the body never appears in the description', !(byName.get(TOOL_NAME)?.description ?? '').includes(BODY))

  const parent = await ctx.agentLoop.create('s10-parent', { provider: 'fake', model: 'fake-parent' })
  let child
  const childCreated = new Promise((resolveChild) => {
    const off = ctx.on('agent/created', (payload) => {
      if (payload.agent.session.header.parentSession === parent.id) {
        off()
        resolveChild(payload.agent)
      }
    })
  })
  const childEnded = new Promise((resolveEnd) => {
    const off = ctx.on('subagent/end', (payload) => {
      off()
      resolveEnd(payload)
    })
  })
  // Execute through the public pipeline by the scoped name: this is the step a
  // colon in the name would break if dsh-tools restricted names like MCP does.
  const batch = await ctx.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: 'call_s10_reviewer',
        name: TOOL_NAME,
        arguments: JSON.stringify({ prompt: TASK }),
      },
    ],
    agent: parent,
    signal: new AbortController().signal,
  })
  const started = batch.results[0]?.result
  child = await Promise.race([childCreated, sleep(5000).then(() => undefined)])
  const ended = await Promise.race([childEnded, sleep(5000).then(() => undefined)])
  check(
    'ctx.tools.execute("<plugin>:<agent>") runs the tool and starts a real child',
    started?.isError === false && child !== undefined,
    JSON.stringify({ names: started?.content, child: child?.id }),
  )
  check('the child settles through the subagent lifecycle', ended !== undefined, JSON.stringify(ended?.stopReason))

  const childCall = adapter.calls.find((call) => call.texts.some((entry) => entry.text.includes(TASK)))
  const system = childCall?.texts.find((entry) => entry.role === 'system')
  const user = childCall?.texts.find((entry) => entry.role === 'user')
  check(
    'the child system prompt does not carry the agent body',
    childCall !== undefined && !(system?.text ?? '').includes(BODY),
    JSON.stringify(system?.text?.includes(BODY)),
  )
  check('the body is in the child user message, ahead of the task', user !== undefined && user.text.indexOf(BODY) >= 0 && user.text.indexOf(BODY) < user.text.indexOf(TASK), JSON.stringify(user?.text?.slice(0, 160)))
  check(
    'the task is the second block and the manager appends delivery guidance last',
    (user?.text ?? '').includes(TASK) && (user?.text ?? '').indexOf(TASK) < (user?.text ?? '').indexOf('Your final answer is delivered automatically'),
  )

  // The frontmatter `tools: Read, Grep` is not enforced: the seam has no
  // per-activation filter, so the child inherits the parent scope — including
  // the agent tools themselves.
  check(
    'the child inherits the parent toolset; frontmatter tools are not enforced',
    (childCall?.tools ?? []).includes(TOOL_NAME) && (childCall?.tools ?? []).includes('subagent'),
    JSON.stringify(childCall?.tools),
  )

  // The other frontmatter keys are not fields of the activation: the manager
  // forwards exactly `prompt`. Passing them anyway is silently ignored (no
  // refusal, no mapping) — the harness never sees them.
  const extra = await ctx.subagents.startActivation({
    provider: 'spawn',
    parent,
    prompt: [{ type: 'text', text: 'EXTRA-KEYS-PROBE' }],
    delivery: 'parent',
    signal: new AbortController().signal,
    label: 'extra keys',
    // Deliberately not fields of SubagentActivationSpec; checked as ignored.
    tools: ['Read'],
    disallowedTools: [TOOL_NAME],
    effort: 'high',
    maxTurns: 1,
    isolation: 'worktree',
  })
  await sleep(50)
  const extraCall = adapter.calls.find((call) => call.texts.some((entry) => entry.text.includes('EXTRA-KEYS-PROBE')))
  check(
    'unknown activation keys are ignored, not refused (no tools/effort/maxTurns/isolation field)',
    extra !== undefined && extraCall !== undefined && (extraCall.tools ?? []).includes(TOOL_NAME),
    JSON.stringify({ tools: extraCall?.tools }),
  )

  // `agentOptions` is the one escape hatch the seam has: a provider model id
  // and reasoning effort. Claude's `model: sonnet` is an alias, not an id, so
  // recording it as planned is the honest annotation until §9's escape layer.
  adapter.resolved.length = 0
  await ctx.subagents.startActivation({
    provider: 'spawn',
    parent,
    prompt: [{ type: 'text', text: 'MODEL-PROBE' }],
    delivery: 'parent',
    signal: new AbortController().signal,
    label: 'model probe',
    agentOptions: { model: 'sonnet', reasoningEffort: 'high' },
  })
  await sleep(50)
  const modelProbe = adapter.resolved.filter((entry) => entry.model === 'sonnet')
  check(
    'agentOptions.model reaches the provider as a raw model id (no Claude alias resolution)',
    modelProbe.length > 0 && modelProbe.every((entry) => entry.provider === 'fake'),
    JSON.stringify(adapter.resolved.slice(-3)),
  )

  // Lexical support for the type-level claim, since a JS object cannot prove an
  // interface absence: the activation request has no instructions field.
  const types = readFileSync(join(HARNESS, 'dsh-subagent', 'src', 'types.ts'), 'utf8')
  const request = types.slice(types.indexOf('interface SubagentStartRequest'), types.indexOf('interface SubagentStartRequest') + 1600)
  check(
    'SubagentStartRequest has no instructions/system/instructionsText field',
    !/\binstructions\b/.test(request) && !/\bsystemPrompt\b/.test(request),
    JSON.stringify(request.split('\n').filter((line) => line.includes('prompt') || line.includes('instructions')).slice(0, 3)),
  )

  const report = { harness: HARNESS, source: HARNESS_SOURCE, version: version(), checks, started, ended: ended?.stopReason }
  mkdirSync(join(HERE, 'out'), { recursive: true })
  writeFileSync(join(HERE, 'out', 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
