// The four S9-confirmed listener seams, the five notification records and the
// five S23-routed records, on one real headless run.
//
// The probe boots the pinned harness (not a hand-rolled emitter), materializes
// `claude-hooks-seams`, and proves that every handler wrote a line *because the
// host event fired*. The counters beside the fixtures are the mutation
// evidence: each one is what the same turn would have produced without the seam
// filter, so the difference between the two numbers is the filter's work,
// measured rather than declared.
//
// `probeSeams` is exported so `coverage.test.mjs` can count the fixture's hook
// rows from the same run instead of guessing them. Test registration is guarded
// on being the entry module, so importing the probe does not register a second
// test.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { defaultMaterializers, emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import {
  classify,
  emptyGrants,
  gate,
  grant,
  pluginIdentity,
} from '../../dsh-anyplugin-trust/src/index.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE = 'claude-hooks-seams'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(5)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
}

function safeExists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * The oracle's own loader base: the product directory (`<harness>/dsh` in a
 * fetched tree, `<harness>/../..` in an extracted install), as a directory URL.
 * Duplicated here because the probe module does not export it and this test may
 * not edit `src/oracles/dsh.ts`.
 */
function loaderBaseUrl(harnessDir) {
  const anchor = safeExists(join(harnessDir, 'dsh', 'package.json'))
    ? join(harnessDir, 'dsh')
    : join(harnessDir, '..', '..')
  return pathToFileURL(`${anchor}/`).href
}

const loadFromHarness = (harnessDir, specifier) =>
  import(pathToFileURL(join(harnessDir, specifier)).href)

const failingChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'error', failure: { code: 'SEAMS_FAILURE', message: text } } },
]

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

function toolCall(id, name, args) {
  return toolCallChunks({ id, name, arguments: JSON.stringify(args) })
}

/** A tool whose execute returns the argument, for the two approval probes. */
function echoTool(name) {
  return {
    name,
    description: `conformance echo tool ${name}`,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { tool: name, text: args?.text ?? '' }
    },
  }
}

const boomTool = {
  name: 'boom',
  description: 'conformance tool that always fails',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render: (value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute() {
    throw new Error('boom: synthetic failure')
  },
}

/**
 * Run one real session against the materialized fixture and return everything
 * the assertions need: the events log, payloads, counters and the settings
 * revisions. The caller owns `dataDir` and the emitted `entry`.
 */
export async function probeSeams({ harnessDir, entry, dataDir, timeoutMs = 120_000 }) {
  const workDir = join(dataDir, 'work')
  mkdirSync(workDir, { recursive: true })
  // The worktree service resolves a repository from the agent's working
  // directory, so the probe workdir is a real git repository with one commit.
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: workDir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('config', 'user.email', 'seams@example.invalid')
  git('config', 'user.name', 'Seams probe')
  writeFileSync(join(workDir, 'README.md'), '# Seams probe repository\n')
  git('add', 'README.md')
  git('commit', '-qm', 'seams probe base')
  const written = join(workDir, 'changed.txt')
  const elsewhere = join(workDir, 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const { Context } = await loadFromHarness(harnessDir, 'cordis/lib/index.js')
  const Loader = (await loadFromHarness(harnessDir, 'cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await loadFromHarness(harnessDir, 'dsh-skill/lib/index.js')).default
  const SessionStore = (await loadFromHarness(harnessDir, 'dsh-session/lib/index.js')).default
  const SessionProjections = (await loadFromHarness(harnessDir, 'dsh-session-projection/lib/index.js')).default
  const SystemPrompt = (await loadFromHarness(harnessDir, 'dsh-system-prompt/lib/index.js')).default
  const ToolsService = (await loadFromHarness(harnessDir, 'dsh-tools/lib/index.js')).default
  const AgentRegistry = (await loadFromHarness(harnessDir, 'dsh-agent/lib/index.js')).default
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await loadFromHarness(
    harnessDir,
    'dsh-llm/lib/index.js',
  )
  const AgentLoop = (await loadFromHarness(harnessDir, 'dsh-agent-loop/lib/index.js')).default
  const nativeExecutor = await loadFromHarness(harnessDir, 'dsh-tool-executor-native/lib/index.js')
  const SubagentRuntime = (await loadFromHarness(harnessDir, 'dsh-subagent/lib/index.js')).default
  const ForkProvider = await loadFromHarness(harnessDir, 'dsh-subagent-fork-in-process/lib/index.js')
  const FileSystem = (await loadFromHarness(harnessDir, 'dsh-fs-local/lib/index.js')).default
  const WorkingDirectory = (await loadFromHarness(harnessDir, 'dsh-working-directory/lib/index.js')).default
  const Approval = (await loadFromHarness(harnessDir, 'dsh-user-approval/lib/index.js')).default
  const ToolFs = await loadFromHarness(harnessDir, 'dsh-tool-fs/lib/index.js')
  const Settings = (await loadFromHarness(harnessDir, 'dsh-settings/lib/index.js')).default
  const TokenMeter = (await loadFromHarness(harnessDir, 'dsh-token-meter/lib/index.js')).default
  const Compaction = (await loadFromHarness(harnessDir, 'dsh-compaction-basic/lib/index.js')).default
  const Jsonl = await loadFromHarness(harnessDir, 'dsh-session-persistence-jsonl/lib/index.js')
  const SubprocessLocal = (await loadFromHarness(harnessDir, 'dsh-subprocess-local/lib/index.js')).default
  const Sandbox = (await loadFromHarness(harnessDir, 'dsh-sandbox/lib/index.js')).default
  const SandboxPolicy = (await loadFromHarness(harnessDir, 'dsh-sandbox-policy/lib/index.js')).default
  const Teams = (await loadFromHarness(harnessDir, 'dsh-agent-team/lib/index.js')).default
  const Worktrees = (await loadFromHarness(harnessDir, 'dsh-experimental-worktree/lib/index.js')).default
  const z = (await loadFromHarness(harnessDir, 'schemastery/lib/index.mjs')).default

  // One mutable configuration entry, so the settings revision can move from
  // 0 (the first read) to 1 (a changed document) on demand.
  const configEntry = {
    id: 'hooks-seams-config',
    options: { id: 'hooks-seams-config', config: {} },
    fiber: {
      uid: 9001,
      state: 2,
      runtime: { Config: z.object({ mode: z.string().default('a').volatile() }) },
      effectiveConfig: { mode: 'a' },
      ctx: { fiber: { state: 2 } },
    },
  }
  class FakeSettingsDeps {
    static inject = ['loader']
    static name = 'hooks-seams-fake-settings-deps'

    constructor(ctx) {
      ctx.provide('configEditor', {
        documentPath: join(dataDir, 'settings.json'),
        configuration: () => [{ entry: configEntry, inherited: {}, override: {} }],
        edit: async () => {},
      })
      ctx.provide('profileContext', { home: dataDir, name: 'hooks-seams' })
    }
  }

  const queue = []
  class StubAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 8192 }, defaultMaxTokens: 1024 }
    }

    async *stream(request) {
      // A compaction summary is a model request too. Its prompt names the
      // job, and it must answer in text: a queued tool call there would
      // desynchronize the turn it was meant for.
      const last = JSON.stringify(request?.messages?.at(-1)?.content ?? '')
      if (last.includes('You are now acting as a compaction engine')) {
        for (const chunk of textChunks('The earlier turn asked for seams coverage.')) yield chunk
        return
      }
      const chunks = queue.length > 0 ? queue.shift() : textChunks('stub answer')
      for (const chunk of chunks) yield chunk
    }
  }

  const sessionsRoot = join(dataDir, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const ctx = new Context()
  // The worktree reclamation reads the workspace registry and the session
  // query; both are transitive, not members of the fetched union, so they are
  // one-method doubles (the S23 spike does the same).
  ctx.provide('workspaceRegistry', { archivedSessionIds: new Set() })
  ctx.provide('sessionQuery', {
    async listSessions() {
      return []
    },
  })
  const loaderFiber = ctx.plugin(Loader, { baseUrl: loaderBaseUrl(harnessDir) })
  ctx.plugin(SkillRegistry, {})
  ctx.plugin(SessionStore)
  ctx.plugin(SessionProjections)
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolsService, {})
  ctx.plugin(AgentRegistry)
  ctx.plugin(nativeExecutor, {})
  ctx.plugin({ name: Jsonl.name, apply: Jsonl.apply, Config: Jsonl.Config }, { root: sessionsRoot, compression: 'none' })
  ctx.plugin(FileSystem, { cwd: workDir })
  ctx.plugin(SubprocessLocal)
  ctx.plugin(Sandbox)
  ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: workDir })
  ctx.plugin(WorkingDirectory, { defaultDirectory: workDir })
  ctx.plugin(SubagentRuntime, {})
  ctx.plugin(ForkProvider, { providerName: 'fork' })
  ctx.plugin(Teams, { defaultEnabled: false })
  // createCheckout resolves this relative pool against the repository root it
  // discovers from the agent's working directory.
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentLoop)
  ctx.plugin(Approval, {})
  ctx.plugin(ToolFs, {})
  ctx.plugin(FakeSettingsDeps, {})
  ctx.plugin(Settings, {})
  ctx.plugin(TokenMeter, {})
  ctx.plugin(Compaction, { auto: true, thresholdRatio: 0.9, retainRatio: 0.02, headroomTokens: 0, maxTokens: 8192 })

  // Mutation counters: each records what the host event produced before the
  // seam filter, so the number beside the handler's line is the unfiltered
  // count and the difference is the filter.
  const preSteps = []
  const postExecute = []
  const fsObserved = []
  const approvalRequests = []
  const permissionDenials = []
  const settingsEvents = []

  try {
    for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'subagents', 'approval', 'fs', 'workingDirectory', 'tokenMeter', 'compaction', 'agentTeams']) {
      await until(() => Boolean(ctx.get(name)), 10_000, `${name} service`)
    }
    assert.ok(ctx.settings !== undefined, 'the settings service is live')
    ctx.llm.registerAdapter(['fake'], new StubAdapter())
    await until(() => Boolean(ctx.get('llm')), 10_000, 'llm service')
    await until(() => Boolean(ctx.get('agentLoop')), 10_000, 'agent loop service')

    ctx.tools.register(echoTool('gated-allow'))
    ctx.tools.register(echoTool('gated-other'))
    ctx.tools.register(boomTool)

    // The two approval demands: one tool the fixture's PermissionRequest
    // matcher names, one it does not. The first is allowed, the second
    // rejected, so the calendar holds one PermissionRequest and one
    // PermissionDenied — not two of the first.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'gated-allow' && exec.name !== 'gated-other') return next()
      const outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') return { kind: 'deny', reason: `approval ${outcome}` }
      return next()
    })

    const root = await ctx.agentLoop.create('anyplugin-seams-root', { provider: 'fake', model: 'fake-1' }, { cwd: workDir })
    await ctx.loader.create(entry)
    await ctx.loader.await()

    // Registered after the entry so the materializer's own listener has
    // first position on every waterfall; each counter forwards.
    ctx.on('approval/request', async (request) => {
      approvalRequests.push({ toolName: request.toolName, keys: Object.keys(request) })
      return request.toolName === 'gated-allow' ? 'allowed-once' : 'rejected'
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      preSteps.push({ step: payload?.step })
      return next()
    })
    const agentCtx = root.ctx
    agentCtx.on('tools/post-execute', async (exec, result, next) => {
      postExecute.push({ tool: exec.name, isError: result?.isError === true })
      return next()
    })
    ctx.on('fs/observed', (target, observation, exec) => {
      fsObserved.push({ tool: exec?.name, kind: observation?.kind, path: target?.displayPath })
    })
    ctx.on('session/event', (_session, event) => {
      if (event?.type === 'approval/decided') permissionDenials.push({ type: event.type, data: event.data })
    })
    ctx.on('settings/document-updated', (namespace, revision) => {
      settingsEvents.push({ namespace, revision })
    })

    // Turns are sequential: wait for the next `turn/end`, which is what the
    // oracle's probe waits for too. The turn number is read from the record
    // rather than guessed from the header.
    let lastTurn = 0
    const runTurn = async (text) => {
      const done = new Promise((resolveTurn, rejectTurn) => {
        const timer = setTimeout(() => rejectTurn(new Error(`the turn after ${lastTurn} did not end`)), timeoutMs)
        const dispose = ctx.on('session/event', (_session, event) => {
          const turn = event?.data?.turn
          if (event?.type !== 'turn/end' || typeof turn !== 'number' || turn <= lastTurn) return
          lastTurn = turn
          clearTimeout(timer)
          if (typeof dispose === 'function') dispose()
          resolveTurn()
        })
      })
      await root.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await done
    }

    // Turn 1: two approval demands, one failure, one write and one read. The
    // write is the FileChanged slice; the read is the same event with a tool
    // the filter must drop.
    queue.push(toolCall('call-allow', 'gated-allow', { text: 'allowed' }))
    queue.push(toolCall('call-other', 'gated-other', { text: 'rejected' }))
    queue.push(toolCall('call-boom', 'boom', { text: 'fail' }))
    queue.push(toolCall('call-write', 'write', { file_path: written, content: 'changed' }))
    queue.push(toolCall('call-read', 'read', { file_path: written }))
    await runTurn('seams prompt one')

    // Turns 2 and 3 pressure the token meter so the compaction lifecycle
    // writes its start/summary/end records on the real turn path.
    await runTurn('x'.repeat(40_000))
    await runTurn('after the compaction')

    // The settings revision-0 case: the first read is an event too, an
    // unchanged second read is not, and a changed document is revision 1.
    const first = ctx.settings.describe()
    await until(() => settingsEvents.length >= 1, 5_000, 'the first settings read')
    const second = ctx.settings.describe()
    configEntry.options.config = { mode: 'b' }
    configEntry.fiber.effectiveConfig = { mode: 'b' }
    const third = ctx.settings.describe()

    // CwdChanged is a service operation, not a model step: the record is
    // produced by the working-directory service and must fire exactly once.
    await ctx.workingDirectory.set(root, elsewhere)
    await until(
      () => readFileSync(join(dataDir, 'events.log'), 'utf8').includes('CwdChanged'),
      10_000,
      'the CwdChanged line',
    )

    const eventsLog = join(dataDir, 'events.log')
    const lineCount = (name) =>
      safeExists(eventsLog) ? readFileSync(eventsLog, 'utf8').trim().split('\n').filter((line) => line === name).length : 0
    const untilLine = (name, expected = 1) => until(() => lineCount(name) >= expected, 30_000, `the ${name} line`)

    // TaskCreated/TaskCompleted: service calls on the root's own team. The
    // durable record is the occurrence; no model turn is involved.
    const taskSubject = 'Seams task'
    const taskDescription = 'Route the team/task record'
    await ctx.agentTeams.setEnabled(root, true)
    const createdTask = await ctx.agentTeams.createTask(root, { subject: taskSubject, description: taskDescription })
    await ctx.agentTeams.updateTask(root, { taskId: createdTask.id, expectedRevision: 1, action: 'claim' })
    await ctx.agentTeams.updateTask(root, { taskId: createdTask.id, expectedRevision: 2, action: 'complete' })
    await untilLine('TaskCreated')
    await untilLine('TaskCompleted')

    // The worktree service reads the settings document when it loads, which
    // would consume the revision-0 read the ConfigChange case observes; it is
    // mounted here, after those reads, because nothing before needs it.
  ctx.plugin(Worktrees, { directory: '.agents/worktrees', retainOnArchive: false })
    await until(() => Boolean(ctx.get('worktrees')), 10_000, 'worktrees service')

    // WorktreeCreate/Remove: a second agent with the repository as its working
    // directory. Archiving it runs reclamation, whose scheduled and settled
    // cleanup records must produce exactly one handler line.
    const worktreeAgent = await ctx.agentLoop.create('anyplugin-seams-worktree', { provider: 'fake', model: 'fake-1' })
    // This set records nothing: the agent has no header cwd, so the service
    // reads its configured default (workDir) as the previous directory and
    // commit() returns early. The agent's first record comes from the ensure
    // inside createCheckout, which initialises the projection.
    await ctx.workingDirectory.set(worktreeAgent, workDir)
    const branch = `seams-worktree-${Date.now().toString(36)}`
    const checkout = await ctx.worktrees.create(worktreeAgent, { name: branch })
    await untilLine('WorktreeCreate')
    const workspaceRegistry = ctx.get('workspaceRegistry')
    workspaceRegistry.archivedSessionIds.add(worktreeAgent.session.id)
    ctx.emit('workspace/session-archived', { sessionId: worktreeAgent.session.id })
    await untilLine('WorktreeRemove')
    const cleanup = await ctx.worktrees.cleanupOf(worktreeAgent.session, null)

    // StopFailure: one failing turn. The loop emits agent/error and commits an
    // error-shaped turn/end; both observers share one key, so one handler runs.
    const failureText = 'seams model failure'
    const stopAgent = await ctx.agentLoop.create('anyplugin-seams-stop-failure', { provider: 'fake', model: 'fake-1' })
    const stopAgentId = stopAgent.session.id
    const stopped = new Promise((resolveStop, rejectStop) => {
      const timer = setTimeout(() => rejectStop(new Error('the failing turn did not end')), timeoutMs)
      const dispose = ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end' || event?.data?.turn !== 1) return
        if (session?.header?.id !== stopAgentId) return
        clearTimeout(timer)
        if (typeof dispose === 'function') dispose()
        resolveStop()
      })
    })
    queue.push(failingChunks(failureText))
    stopAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'trigger the failure' }], source: { kind: 'user' } }))
    await stopped
    await untilLine('StopFailure')

    // A real child session that fails: StopFailure is root-only (SubagentStop
    // owns children), so this must not add a second line.
    const childAgent = await ctx.agentLoop.create(
      'anyplugin-seams-child',
      { provider: 'fake', model: 'fake-1' },
      { parentSession: root.session.id, cwd: workDir },
    )
    const childEnded = new Promise((resolveChild, rejectChild) => {
      const timer = setTimeout(() => rejectChild(new Error('the child failing turn did not end')), timeoutMs)
      const dispose = ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return
        if (session?.header?.id !== childAgent.session.id) return
        if (event?.data?.turn !== 1) return
        clearTimeout(timer)
        if (typeof dispose === 'function') dispose()
        resolveChild()
      })
    })
    queue.push(failingChunks('seams child model failure'))
    childAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'fail as a child' }], source: { kind: 'user' } }))
    await childEnded
    await untilLine('StopFailure')

    // A final, deterministic directory set: the CwdChanged payload the script
    // keeps must be the new directory, so the seam's meaning is asserted on the
    // record this probe itself produced last.
    await ctx.workingDirectory.set(stopAgent, elsewhere)

    // The script writes the payload first and the log line last, so a payload
    // read racing the line would count four lines that all exist and one that
    // is still being written. Wait for the completion marker, and let a timeout
    // carry the trail: the count assertion is never reached when the line
    // never lands, which is exactly the case a diagnostic must serve.
    const cwdTrail = () => {
      const trail = join(dataDir, 'payloads', 'CwdChanged.jsonl')
      if (!safeExists(trail)) return []
      return readFileSync(trail, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          // A killed or full disk leaves a partial last line; the trail exists
          // to be printed by the timeout, so it must not throw on the way out.
          try {
            const payload = JSON.parse(line)
            return { cwd: payload.cwd, session: payload.session_id }
          } catch {
            return { cwd: '<unparsable CwdChanged.jsonl line>', session: null }
          }
        })
    }
    try {
      await untilLine('CwdChanged', 5)
    } catch (error) {
      throw new Error(`${error.message}; recorded: ${JSON.stringify(cwdTrail())}`)
    }

    const lines = readFileSync(eventsLog, 'utf8').trim().split('\n')
    const count = (name) => lines.filter((line) => line === name).length
    const payload = (name) => JSON.parse(readFileSync(join(dataDir, 'payloads', `${name}.json`), 'utf8'))
    return {
      lines,
      count,
      payload,
      cwdTrail,
      settingsEvents,
      preSteps,
      postExecute,
      fsObserved,
      approvalRequests,
      permissionDenials,
      first,
      second,
      third,
      workDir,
      written,
      elsewhere,
      taskId: createdTask.id,
      taskSubject,
      worktreeBranch: branch,
      worktreePath: checkout.path,
      worktreeSessionId: worktreeAgent.session.id,
      worktreeCleanup: cleanup?.status,
      stopFailureMessage: failureText,
      stopFailureSessionId: stopAgentId,
    }
  } finally {
    loaderFiber?.dispose?.()
  }
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntry) {
  const harness = resolveHarness()

  test(
    'the four listener seams and the ten notification records fire on one real run',
    { skip: harness ? false : harnessSkipReason(), timeout: 120_000 },
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), `anyplugin-${FIXTURE}-`))
      try {
        const directory = join(repoRoot, 'fixtures', FIXTURE)
        const ir = readClaudePlugin(directory, { source: `plugin-dir:fixtures/${FIXTURE}` })
        let grants = emptyGrants()
        for (const row of classify(ir)) {
          grants = grant(grants, { plugin: pluginIdentity(ir), ...row }, { scope: 'user' })
        }
        const gated = gate(ir, grants)
        const { entry } = emitPlugin(gated.ir, {
          materializers: defaultMaterializers(),
          sdkRoot: harness.modulesDir,
          trusted: gated.decision.allowed,
          dataDir,
        })
        assert.ok(entry !== undefined, 'the fixture emitted a plugin entry')

        const observed = await probeSeams({ harnessDir: harness.harnessDir, entry, dataDir })
        const { count, payload, lines, cwdTrail } = observed

        // The four listener seams, one line per operation on this turn. The
        // mutation counters below are the same turn without the filter, so the
        // gap between a handler's line count and its counter is the filter's
        // measured work, not a declaration.
        assert.equal(count('UserPromptSubmit'), 4, `one line per prompt, not per model step: ${lines.join(', ')}`)
        assert.equal(count('PermissionRequest'), 1, 'the matcher runs only for gated-allow')
        assert.equal(count('PostToolUseFailure'), 1, 'only the failed body is the failure slice; the denied call is excluded')
        assert.equal(count('FileChanged'), 1, 'only the write is a mutation; the read is dropped')

        // The fixture's script keeps the most recent payload per event; the line
        // count above is what proves the earlier prompts also ran.
        // The stop-failure turn is a prompt too; the last payload is that one.
        assert.equal(payload('UserPromptSubmit').prompt, 'trigger the failure')
        assert.equal(payload('UserPromptSubmit').hook_event_name, 'UserPromptSubmit')
        assert.equal(payload('UserPromptSubmit').session_id, 'anyplugin-seams-stop-failure')
        // The stop-failure agent is created without a cwd, so the host gives it
        // the process directory; that is the session's real cwd, not the fixture's.
        assert.equal(payload('UserPromptSubmit').cwd, process.cwd())
        assert.deepEqual(Object.keys(payload('UserPromptSubmit')).sort(), ['cwd', 'hook_event_name', 'prompt', 'session_id'])

        assert.equal(payload('PermissionRequest').tool_name, 'gated-allow')
        assert.equal(payload('PermissionRequest').hook_event_name, 'PermissionRequest')
        assert.equal(typeof payload('PermissionRequest').tool_use_id, 'string')
        assert.deepEqual(Object.keys(payload('PermissionRequest')).sort(), [
          'cwd',
          'hook_event_name',
          'session_id',
          'tool_name',
          'tool_use_id',
        ])

        assert.equal(payload('PostToolUseFailure').tool_name, 'boom')
        assert.match(payload('PostToolUseFailure').error, /boom: synthetic failure/)
        assert.equal(payload('PostToolUseFailure').tool_use_id, 'call-boom')
        assert.equal(payload('PostToolUseFailure').hook_event_name, 'PostToolUseFailure')
        assert.equal(payload('PostToolUseFailure').tool_input.text, 'fail')

        assert.equal(payload('FileChanged').file_path, observed.written)
        assert.equal(payload('FileChanged').hook_event_name, 'FileChanged')
        assert.equal(payload('FileChanged').session_id, 'anyplugin-seams-root')

        // The five notification records. Each names its operation, not the
        // process: the compaction id is shared by start and end, the denial is
        // the rejected tool only, and the settings event carries its revision.
        const compactions = lines.filter((line) => line === 'PreCompact' || line === 'PostCompact')
        assert.ok(compactions.length > 0, 'the pressure turn compacted')
        for (let index = 0; index < compactions.length; index += 2) {
          assert.equal(compactions[index], 'PreCompact', 'each operation opens with start')
          assert.equal(compactions[index + 1], 'PostCompact', 'and closes with end')
        }
        assert.equal(count('PreCompact'), count('PostCompact'))
        assert.equal(payload('PreCompact').compaction_id, payload('PostCompact').compaction_id)
        assert.equal(payload('PreCompact').hook_event_name, 'PreCompact')
        assert.equal(payload('PostCompact').hook_event_name, 'PostCompact')

        assert.equal(count('PermissionDenied'), 1, 'the allowed request is not a denial')
        assert.equal(payload('PermissionDenied').tool_name, 'gated-other')
        assert.equal(payload('PermissionDenied').outcome, 'rejected')
        assert.equal(payload('PermissionDenied').hook_event_name, 'PermissionDenied')

        // Five records happen on the run, and only three of them come from a
        // set(): the root leaves the repo; createCheckout initialises the
        // worktree agent's projection (an ensure — the set above targets the
        // service's own default, so it would record nothing even with a null
        // projection) and then enters the checkout (a set); the stop-failure
        // agent's first prompt assembly initialises its projection (an ensure,
        // also in workDir, which is why the trail keeps the session id), and
        // the final set after StopFailure moves it to elsewhere. The probe
        // waits for the fifth line, the fixture's completion marker.
        assert.equal(count('CwdChanged'), 5, `the recorded transitions: ${JSON.stringify(cwdTrail())}`)
        assert.equal(payload('CwdChanged').cwd, observed.elsewhere)
        assert.equal(payload('CwdChanged').hook_event_name, 'CwdChanged')

        assert.equal(count('ConfigChange'), 2, 'first read (0) and one change (1), not the unchanged read')

        // The five S23 records. WorktreeRemove and StopFailure are emitted
        // twice by the host; one line each on a real run shows the mount ran
        // once. The paired/replayed records are pinned in the materializer's
        // lifecycle tests, which is where a dropped key goes red.
        assert.equal(count('TaskCreated'), 1)
        assert.equal(count('TaskCompleted'), 1)
        assert.equal(count('WorktreeCreate'), 1)
        assert.equal(count('WorktreeRemove'), 1, 'scheduled and removed collapsed to one handler run')
        assert.equal(count('StopFailure'), 1, 'agent/error and turn/end collapsed to one handler run')
        assert.equal(
          payload('StopFailure').session_id,
          observed.stopFailureSessionId,
          'the failing child turn did not add a StopFailure line',
        )
        assert.equal(observed.worktreeCleanup, 'removed', 'the reclamation settled before the line was read')
        assert.equal(payload('TaskCreated').task_id, observed.taskId)
        assert.equal(payload('TaskCreated').task_subject, observed.taskSubject)
        assert.equal(payload('TaskCreated').hook_event_name, 'TaskCreated')
        assert.equal(payload('TaskCreated').session_id, 'anyplugin-seams-root')
        assert.deepEqual(Object.keys(payload('TaskCreated')).sort(), [
          'cwd',
          'hook_event_name',
          'session_id',
          'task_description',
          'task_id',
          'task_subject',
        ])
        assert.equal(payload('TaskCompleted').task_id, observed.taskId)
        assert.equal(payload('TaskCompleted').hook_event_name, 'TaskCompleted')
        assert.equal(typeof payload('TaskCompleted').teammate_name, 'string')
        assert.ok(payload('TaskCompleted').teammate_name.length > 0, 'ownerName is the teammate_name source')
        assert.deepEqual(Object.keys(payload('TaskCompleted')).sort(), [
          'cwd',
          'hook_event_name',
          'session_id',
          'task_description',
          'task_id',
          'task_subject',
          'teammate_name',
        ])
        assert.equal(payload('WorktreeCreate').name, observed.worktreeBranch)
        assert.equal(payload('WorktreeCreate').hook_event_name, 'WorktreeCreate')
        assert.equal(payload('WorktreeCreate').session_id, observed.worktreeSessionId)
        assert.deepEqual(Object.keys(payload('WorktreeCreate')).sort(), ['cwd', 'hook_event_name', 'name', 'session_id'])
        assert.equal(payload('WorktreeRemove').worktree_path, observed.worktreePath)
        assert.equal(payload('WorktreeRemove').cwd, process.cwd(), 'cwd is the host process directory, not the removed checkout')
        assert.notEqual(payload('WorktreeRemove').cwd, observed.worktreePath, 'classic cwd and worktree_path stay distinct')
        assert.equal(payload('WorktreeRemove').hook_event_name, 'WorktreeRemove')
        assert.equal(payload('WorktreeRemove').session_id, observed.worktreeSessionId)
        assert.deepEqual(Object.keys(payload('WorktreeRemove')).sort(), [
          'cwd',
          'hook_event_name',
          'session_id',
          'worktree_path',
        ])
        assert.equal(payload('StopFailure').error_details, observed.stopFailureMessage)
        assert.equal(payload('StopFailure').hook_event_name, 'StopFailure')
        assert.equal(payload('StopFailure').session_id, observed.stopFailureSessionId)
        assert.deepEqual(Object.keys(payload('StopFailure')).sort(), [
          'cwd',
          'error_details',
          'hook_event_name',
          'session_id',
        ])
        assert.deepEqual(observed.settingsEvents.map((event) => event.revision), [0, 1])
        assert.equal(observed.settingsEvents[0].namespace, 'hooks-seams-config')
        assert.equal(payload('ConfigChange').hook_event_name, 'ConfigChange')
        assert.equal(payload('ConfigChange').namespace, 'hooks-seams-config')
        assert.equal(payload('ConfigChange').revision, 1)

        // Mutation evidence, measured on this run: the same host events without
        // the seam filters would have produced these counter values.
        //   UserPromptSubmit: preSteps.length model steps vs 3 prompts.
        //   PermissionRequest: approvalRequests.length demands vs 1 matcher hit.
        //   PostToolUseFailure: 5 settled calls (gated-other and boom failed) vs 1.
        //   FileChanged: 2 fs/observed presents (write and read) vs 1 mutation.
        assert.ok(observed.preSteps.length > 3, `the turn had more model steps than prompts: ${observed.preSteps.length}`)
        assert.equal(observed.fsObserved.length, 2, 'one write and one read observation')
        assert.equal(observed.postExecute.length, 5, 'every call reaches post-execute')
        assert.equal(observed.postExecute.filter((call) => call.isError).length, 2, 'the denied call and the thrown body')
        assert.equal(observed.approvalRequests.length, 2, 'two approval demands')
        assert.equal(observed.permissionDenials.length, 2, 'one decision per demand')
        assert.equal(
          observed.permissionDenials.filter((decision) => decision.data?.outcome !== 'allowed-once').length,
          1,
          'one approval decision was a non-grant',
        )
        assert.equal(typeof observed.first, 'object')
        assert.equal(typeof observed.second, 'object')
        assert.equal(typeof observed.third, 'object')
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )
}
