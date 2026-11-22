// The brief's destination is a real `agent/pre-step` continuation inside the
// pinned host. A fake `next()` cannot prove the message is accepted: the loop
// reads `message.source.kind` on every appended message
// (`dsh-agent-loop/lib/index.js:873`), so a message without `source` throws
// before the first model call. This test boots that loop, loads the guard
// through the loader, spawns one child and asserts the child completes with
// the brief exactly once in its history.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveHarness, harnessSkipReason } from '../../dsh-anyplugin-conformance/src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const guardSource = pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-guard', 'src', 'index.ts')).href

const harness = resolveHarness()

function loaderBaseUrl(harnessDir) {
  let exists = true
  try {
    statSync(join(harnessDir, 'dsh', 'package.json'))
  } catch {
    exists = false
  }
  const base = exists ? join(harnessDir, 'dsh') : join(harnessDir, '..', '..')
  return pathToFileURL(`${base}/`).href
}

const load = (harnessDir, specifier) => import(pathToFileURL(join(harnessDir, specifier)).href)

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

function until(check, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let value
      try {
        value = check()
      } catch (error) {
        reject(error)
        return
      }
      if (value) resolve(value)
      else if (Date.now() - started > timeoutMs) reject(new Error(`timed out waiting for ${label}`))
      else setTimeout(tick, 10).unref?.()
    }
    tick()
  })
}

test(
  'the brief survives the real agent loop: one child run, one brief message, no crash',
  { skip: harness ? false : harnessSkipReason(), timeout: 120_000 },
  async () => {
    const harnessDir = harness.harnessDir
    const { Context } = await load(harnessDir, 'cordis/lib/index.js')
    const Loader = (await load(harnessDir, 'cordis-plugin-loader/lib/index.js')).default
    const SkillRegistry = (await load(harnessDir, 'dsh-skill/lib/index.js')).default
    const SessionStore = (await load(harnessDir, 'dsh-session/lib/index.js')).default
    const SessionProjections = (await load(harnessDir, 'dsh-session-projection/lib/index.js')).default
    const SystemPrompt = (await load(harnessDir, 'dsh-system-prompt/lib/index.js')).default
    const ToolsService = (await load(harnessDir, 'dsh-tools/lib/index.js')).default
    const AgentRegistry = (await load(harnessDir, 'dsh-agent/lib/index.js')).default
    const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load(harnessDir, 'dsh-llm/lib/index.js')
    const AgentLoop = (await load(harnessDir, 'dsh-agent-loop/lib/index.js')).default
    const nativeExecutor = await load(harnessDir, 'dsh-tool-executor-native/lib/index.js')
    const SubagentRuntime = (await load(harnessDir, 'dsh-subagent/lib/index.js')).default
    const ForkProvider = await load(harnessDir, 'dsh-subagent-fork-in-process/lib/index.js')
    const FileSystem = (await load(harnessDir, 'dsh-fs-local/lib/index.js')).default
    const WorkingDirectory = (await load(harnessDir, 'dsh-working-directory/lib/index.js')).default

    const dataDir = mkdtempSync(join(tmpdir(), 'anyplugin-guard-live-'))
    const outside = join(dataDir, '..', `outside-${process.pid}.txt`)
    const requests = []
    let executed = 0
    let childEnded

    class StubAdapter extends LlmAdapter {
      #calls = 0

      async resolveModel(provider, model) {
        return { provider, id: model, name: model, context: { contextWindow: 8192 }, defaultMaxTokens: 1024 }
      }

      async *stream(request) {
        requests.push(request)
        this.#calls += 1
        // The root answers in text. The child's first call asks to write
        // outside its worktree, which the guard must deny before execution;
        // the next call answers in text so the run completes.
        if (this.#calls === 2) {
          for (const chunk of toolCallChunks({
            id: 'guard-call-1',
            name: 'write',
            arguments: JSON.stringify({ file_path: outside, content: 'x' }),
          })) yield chunk
          return
        }
        for (const chunk of textChunks('stub answer')) yield chunk
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
    ctx.plugin(FileSystem, { cwd: dataDir })
    ctx.plugin(WorkingDirectory, { defaultDirectory: dataDir })
    ctx.plugin(SubagentRuntime, {})
    ctx.plugin(ForkProvider, { providerName: 'fork' })
    ctx.plugin(LlmRuntime)
    ctx.plugin(AgentLoop)

    try {
      for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'subagents']) {
        await until(() => Boolean(ctx.get(name)), 20_000, `${name} service`)
      }
      ctx.llm.registerAdapter(['fake'], new StubAdapter())
      ctx.tools.register({
        name: 'write',
        description: 'stub write used to prove the guard denies before execution',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' }, content: { type: 'string' } },
          required: ['file_path', 'content'],
          additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: (value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute() {
          executed += 1
          return { ok: true }
        },
      })
      await until(() => Boolean(ctx.get('llm')), 20_000, 'llm service')
      await until(() => Boolean(ctx.get('agentLoop')), 20_000, 'agent loop service')

      const root = await ctx.agentLoop.create('anyplugin-guard-root', { provider: 'fake', model: 'fake-1' }, { cwd: dataDir })
      const rootEnded = new Promise((resolve) => {
        const off = ctx.on('session/event', (_session, event) => {
          if (event?.type !== 'turn/end' || event?.data?.turn !== 1) return
          off()
          resolve()
        })
      })
      root.followup(createUserMessage({ content: [{ type: 'text', text: 'root turn' }], source: { kind: 'user' } }))
      await rootEnded

      await ctx.loader.create({
        id: 'anyplugin-guard-live',
        name: guardSource,
        config: {
          worktrees: [dataDir],
          protectedRoots: [],
          brief: {
            ratchet: ['27 declared / 26 matched / 0 missing / 1 refused'],
            fixtures: '13 fixtures',
            open: ['mcpServers:a-server-name-that-is-long-enough:refused'],
          },
        },
      })
      await ctx.loader.await()

      const ended = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 60_000)
        const off = ctx.on('subagent/end', (payload) => {
          if (payload.parentSessionId !== root.id) return
          clearTimeout(timer)
          off()
          resolve(payload)
        })
      })
      const activation = await ctx.subagents.startActivation({
        provider: 'fork',
        parent: root,
        prompt: [{ type: 'text', text: `Do the task. Worktree: ${dataDir}. Ticket branch ticket/99.` }],
        delivery: 'caller',
        label: 'guard live child',
        signal: new AbortController().signal,
      })
      childEnded = await ended
      await activation?.dispose?.()

      assert.notEqual(childEnded, undefined, 'the child ended (the guard did not crash the run)')
      assert.equal(childEnded.stopReason, 'completed', `stopReason: ${String(childEnded.stopReason)}`)
      assert.ok(requests.length >= 2, `the root and the child each made a model call (saw ${requests.length})`)

      const rootRequest = requests[0]
      const childRequest = requests[1]
      assert.equal(
        JSON.stringify(rootRequest?.messages ?? []).includes('<anyplugin-guard-brief>'),
        false,
        'the root turn is not briefed',
      )
      const briefMessages = (childRequest?.messages ?? []).filter(
        (message) =>
          message?.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some((block) => typeof block?.text === 'string' && block.text.includes('<anyplugin-guard-brief>')),
      )
      assert.equal(briefMessages.length, 1, 'the first child request carries the brief exactly once')
      assert.match(briefMessages[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
      assert.equal(briefMessages[0].source?.kind, 'user', 'the loop reads message.source.kind; the brief is a user source')
      assert.match(briefMessages[0].content.map((block) => block.text ?? '').join('\n'), /27 declared \/ 26 matched/u)
      assert.ok(requests.length >= 3, `the denied tool was not run; the child took another model step (saw ${requests.length})`)
      const toolResults = (requests[2]?.messages ?? []).flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
          : [],
      )
      assert.equal(executed, 0, 'the guard denied the child\'s write before the tool executed')
      assert.ok(
        toolResults.some((text) => /anyplugin-guard: refusing.*write-outside-worktree/u.test(text)),
        `the denial reason reaches the model (saw ${JSON.stringify(toolResults.slice(-2))})`,
      )
    } finally {
      loaderFiber?.dispose?.()
      rmSync(dataDir, { recursive: true, force: true })
    }
  },
)
