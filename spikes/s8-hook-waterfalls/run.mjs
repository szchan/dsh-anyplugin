// S8: do `tools/pre-execute` and `tools/post-execute` carry the hook semantics?
//
// The question this spike answers is narrow and load-bearing: before writing a
// single line of hook materializer, can a plugin
//   1. see a pending call (name, parsed arguments) before dispatch,
//   2. deny it so the model reads `Error: <reason>`,
//   3. see the normalized result after dispatch,
//   4. replace that result, and attach `additionalContexts`.
//
// If any of these is false, the PreToolUse/PostToolUse arm needs a new seam and
// the plan changes. Runs against the installed harness (D9).
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'

const installedDir = process.env.DSH_INSTALL_DIR
if (installedDir === undefined) {
  console.error('DSH_INSTALL_DIR is not set')
  process.exit(2)
}
const pkgs = join(installedDir, '..')
const load = async (name) => import(pathToFileURL(join(pkgs, name, 'lib', 'index.js')).href)

const { Context } = await load('cordis')
const { default: ToolsService } = await load('dsh-tools')
const { default: SystemPrompt } = await load('dsh-system-prompt')
// Exported as a functional plugin (name + apply), not a default class.
const nativeExecutor = await load('dsh-tool-executor-native')

const ctx = new Context()
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

ctx.plugin(SystemPrompt, {})
ctx.plugin(ToolsService, {})
ctx.plugin(nativeExecutor, {})
await new Promise((resolve) => setTimeout(resolve, 50))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
for (let i = 0; i < 20 && ctx.tools === undefined; i += 1) await sleep(25)
if (ctx.tools === undefined) {
  console.error('tools service did not mount')
  process.exit(2)
}

// A tool that simply echoes, so a result exists to inspect.
ctx.tools.register({
  name: 'echo',
  description: 'Echo the text.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
  async execute(args) {
    if (args?.text === 'throw') throw new Error('boom')
    return { echoed: args?.text ?? '' }
  },
})

const seen = { pre: [], post: [] }
let denyNext = undefined

const offPre = ctx.on('tools/pre-execute', async (exec, next) => {
  seen.pre.push({ name: exec.name, arguments: exec.arguments, hasAgent: exec.agent !== undefined, callId: exec.callId })
  if (denyNext !== undefined) return { kind: 'deny', reason: denyNext }
  return next()
})

const offPost = ctx.on('tools/post-execute', async (exec, result, next) => {
  seen.post.push({ name: exec.name, result: JSON.parse(JSON.stringify(result)) })
  const decision = await next()
  return decision
})

const call = (name, args) => ({
  calls: [{ type: 'tool-call', id: `call_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }],
  signal: new AbortController().signal,
})

// 1. the pre-execute waterfall sees the call.
const ok = await ctx.tools.execute(call('echo', { text: 'hello' }))
check('pre-execute observes the pending call', seen.pre.length === 1, JSON.stringify(seen.pre[0]))
check('pre-execute sees parsed arguments', seen.pre[0]?.arguments?.text === 'hello')
check('pre-execute sees no agent for a standalone call', seen.pre[0]?.hasAgent === false)

// 2. the result shape after a normal call.
const textOf = (result) => JSON.stringify(result)
check('a normal call settles', ok !== undefined, textOf(ok)?.slice(0, 160))
check('post-execute observes the normalized result', seen.post.length === 1, JSON.stringify(seen.post[0]).slice(0, 240))

// 3. deny: what does the model read?
denyNext = 'no writes after midnight'
const denied = await ctx.tools.execute(call('echo', { text: 'blocked' }))
const deniedText = JSON.stringify(denied)
check('a denial reaches the caller as an error result', deniedText.includes('no writes after midnight'), deniedText.slice(0, 200))
check('the denial is marked as an error', deniedText.includes('"isError":true') || deniedText.includes('isError'))

denyNext = undefined

// 4. post-execute replacement and additionalContexts.
offPost()
const offPost2 = ctx.on('tools/post-execute', async (exec, result, next) => {
  const decision = await next()
  if (decision.kind !== 'accept') return decision
  return {
    kind: 'accept',
    value: { replaced: true, original: 'swallowed' },
    additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'hook says: remember the ticket' }] }],
  }
})
const replaced = await ctx.tools.execute(call('echo', { text: 'replace me' }))
const replacedText = JSON.stringify(replaced)
check('post-execute can replace the projection', replacedText.includes('replaced'), replacedText.slice(0, 240))
check('post-execute can attach additionalContexts', replacedText.includes('remember the ticket'), replacedText.slice(0, 300))

// 5. a throwing tool still reaches post-execute.
const countBefore = seen.post.length
const offPost3 = ctx.on('tools/post-execute', async (exec, result, next) => {
  seen.post.push({ name: exec.name, threw: JSON.stringify(result).includes('boom') })
  return next()
})
await ctx.tools.execute(call('echo', { text: 'throw' })).catch(() => {})
check('post-execute sees throwing tools', seen.post.length > countBefore, JSON.stringify(seen.post.at(-1)))

offPre()
offPost2()
offPost3()

const passed = checks.filter((entry) => entry.ok).length
console.log(`\n${passed}/${checks.length} checks`)
const out = join(import.meta.dirname, 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'report.json'), `${JSON.stringify({ checks, seen }, null, 2)}\n`)
process.exit(passed === checks.length ? 0 : 1)
