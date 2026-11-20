// The four S9-confirmed listener seams and the five notification records, on
// one real headless turn.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  const ctx = new Context()
  const loaderFiber = ctx.plugin(Loader, { baseUrl: loaderBaseUrl(harnessDir) })
  ctx.plugin(SkillRegistry, {})
  ctx.plugin(SessionStore)
  ctx.plugin(SessionProjections)
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolsService, {})
  ctx.plugin(AgentRegistry)
  ctx.plugin(nativeExecutor, {})
  ctx.plugin(FileSystem, { cwd: process.cwd() })
  ctx.plugin(WorkingDirectory, { defaultDirectory: process.cwd() })
  ctx.plugin(SubagentRuntime, {})
  ctx.plugin(ForkProvider, { providerName: 'fork' })
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
    for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'subagents', 'approval', 'fs', 'workingDirectory', 'tokenMeter', 'compaction']) {
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

    const lines = readFileSync(join(dataDir, 'events.log'), 'utf8').trim().split('\n')
    const count = (name) => lines.filter((line) => line === name).length
    const payload = (name) => JSON.parse(readFileSync(join(dataDir, 'payloads', `${name}.json`), 'utf8'))
    return {
      lines,
      count,
      payload,
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
    }
  } finally {
    loaderFiber?.dispose?.()
  }
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntry) {
  const harness = resolveHarness()

  test(
    'the four listener seams and the five notification records fire on one real turn',
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
        const { count, payload, lines } = observed

        // The four listener seams, one line per operation on this turn. The
        // mutation counters below are the same turn without the filter, so the
        // gap between a handler's line count and its counter is the filter's
        // measured work, not a declaration.
        assert.equal(count('UserPromptSubmit'), 3, `one line per prompt, not per model step: ${lines.join(', ')}`)
        assert.equal(count('PermissionRequest'), 1, 'the matcher runs only for gated-allow')
        assert.equal(count('PostToolUseFailure'), 1, 'only the failed body is the failure slice; the denied call is excluded')
        assert.equal(count('FileChanged'), 1, 'only the write is a mutation; the read is dropped')

        // The fixture's script keeps the most recent payload per event; the line
        // count above is what proves the earlier prompts also ran.
        assert.equal(payload('UserPromptSubmit').prompt, 'after the compaction')
        assert.equal(payload('UserPromptSubmit').hook_event_name, 'UserPromptSubmit')
        assert.equal(payload('UserPromptSubmit').session_id, 'anyplugin-seams-root')
        assert.equal(payload('UserPromptSubmit').cwd, observed.workDir)
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

        assert.equal(count('CwdChanged'), 1)
        assert.equal(payload('CwdChanged').cwd, observed.elsewhere)
        assert.equal(payload('CwdChanged').hook_event_name, 'CwdChanged')

        assert.equal(count('ConfigChange'), 2, 'first read (0) and one change (1), not the unchanged read')
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
