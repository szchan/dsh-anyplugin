#!/usr/bin/env node
// Spike S22: what does a plugin `monitors` entry actually do in the pinned
// Claude Code client?
//
// The spike stages plugins whose monitor and hooks write ONE trace file, runs
// the pinned client with a real model turn, and then asks the trace, the
// client's own transcript, and the exact model request bodies whether the
// monitor ever existed and whether its stdout reached the model. Every answer
// in REPORT.md must come from a file this script wrote.
//
// Usage:
//   DEEPSEEK_API_KEY=... node spikes/s22-monitors/run.mjs --deepseek [--publish]
//
// --publish copies the reviewed artifacts into spikes/s22-monitors/captures/.
// The spike is local-only: the model stage needs the network and a key.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const PIN = '2.1.329'
const NODE = process.execPath

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const deepseek = flag('--deepseek')
const publish = flag('--publish')

const FIXTURES = [
  { id: 'one-monitor', name: 's22-one', monitors: 1, valid: true },
  { id: 'two-monitors', name: 's22-two', monitors: 2, valid: true },
  { id: 'gated-skill', name: 's22-gated', monitors: 1, valid: true, when: 'on-skill-invoke:s22-skill' },
  { id: 'inline-array', name: 's22-inline', monitors: 1, valid: true, inline: true },
  { id: 'bad-extra-key', name: 's22-bad-extra', monitors: 0, valid: false },
  { id: 'bad-when-short', name: 's22-bad-when-short', monitors: 0, valid: false },
  { id: 'bad-when-enum', name: 's22-bad-when-enum', monitors: 0, valid: false },
]

const checks = []
const check = (id, ok, detail) => {
  checks.push({ id, ok: Boolean(ok), detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${detail === undefined ? '' : ` — ${detail}`}`)
  return Boolean(ok)
}

function fail(message) {
  console.error(`s22: ${message}`)
  process.exit(2)
}

function resolveClaude() {
  const explicit = process.env.CLAUDE_BIN
  if (explicit !== undefined && explicit.trim() !== '') {
    if (!fs.existsSync(explicit)) fail(`CLAUDE_BIN does not exist: ${explicit}`)
    return explicit
  }
  const pinned = path.join(
    REPO, '.claude-code', PIN, 'node_modules', '@anthropic-ai/claude-code-linux-x64', 'claude',
  )
  if (fs.existsSync(pinned)) return pinned
  return 'claude'
}

const CLAUDE = resolveClaude()
const reported = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' })
if (reported.status !== 0) fail(`cannot run ${CLAUDE} --version: ${reported.error ?? reported.stderr}`)
const version = (reported.stdout ?? '').trim().split(/\s+/)[0]
check('client-is-pinned-2.1.329', version === PIN, `${CLAUDE} reports ${JSON.stringify(reported.stdout.trim())}`)

if (!deepseek) fail('pass --deepseek: the local proxy forwards only to the DeepSeek endpoint')

const key = process.env.DEEPSEEK_API_KEY
if (key === undefined || key === '') {
  fail('the model stage needs DEEPSEEK_API_KEY in the environment (never printed, never written)')
}

// Claude Code speaks the Anthropic Messages API; DeepSeek serves that dialect
// at /anthropic (docs/CONFORMANCE.md, spikes/s6-hook-payloads/run.mjs). The
// client is pointed at a local recording proxy so the spike can prove what the
// model was and was not told.
const backend = {
  ANTHROPIC_AUTH_TOKEN: key,
  ANTHROPIC_MODEL: 'deepseek-flash',
  ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-flash',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anyplugin-s22-'))
const outDir = path.join(root, 'out')
const loaderHome = path.join(root, 'loader-home')
const modelHome = path.join(root, 'model-home')
const pluginsDir = path.join(root, 'plugins')
const marketplace = path.join(root, 'marketplace')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(loaderHome, { recursive: true })
fs.mkdirSync(modelHome, { recursive: true })
fs.mkdirSync(pluginsDir, { recursive: true })
fs.mkdirSync(path.join(marketplace, '.claude-plugin'), { recursive: true })
fs.mkdirSync(path.join(marketplace, 'plugins'), { recursive: true })

const loaderEnv = {
  ...process.env,
  HOME: loaderHome,
  CLAUDE_CONFIG_DIR: path.join(loaderHome, '.claude'),
  S22_MARKER: 's22-spike',
  ...backend,
}

const modelEnv = {
  ...process.env,
  HOME: modelHome,
  CLAUDE_CONFIG_DIR: path.join(modelHome, '.claude'),
  S22_MARKER: 's22-spike',
  ...backend,
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ---------------------------------------------------------------- staging ---

const staged = new Map()
for (const fixture of FIXTURES) {
  const source = path.join(HERE, 'fixtures', fixture.id)
  const dest = path.join(pluginsDir, fixture.name)
  fs.cpSync(source, dest, { recursive: true })
  fs.copyFileSync(path.join(HERE, 'monitor.mjs'), path.join(dest, 'monitor.mjs'))
  fs.copyFileSync(path.join(HERE, 'hook.mjs'), path.join(dest, 'hook.mjs'))
  fs.chmodSync(path.join(dest, 'monitor.mjs'), 0o755)
  fs.chmodSync(path.join(dest, 'hook.mjs'), 0o755)
  for (const relative of ['hooks/hooks.json', 'monitors/monitors.json']) {
    const file = path.join(dest, relative)
    if (!fs.existsSync(file)) continue
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replaceAll('__NODE__', NODE).replaceAll('__PLUGIN_ROOT__', dest),
    )
  }
  staged.set(fixture.id, dest)
  const marketDest = path.join(marketplace, 'plugins', fixture.name)
  fs.cpSync(dest, marketDest, { recursive: true })
}

const marketplaceManifest = {
  name: 's22-mkt',
  owner: { name: 's22 spike' },
  plugins: FIXTURES.map((fixture) => ({
    name: fixture.name,
    source: `./plugins/${fixture.name}`,
    description: `Spike S22 fixture ${fixture.id}`,
  })),
}
fs.writeFileSync(
  path.join(marketplace, '.claude-plugin', 'marketplace.json'),
  `${JSON.stringify(marketplaceManifest, null, 2)}\n`,
)

function cli(args, { timeoutMs = 120_000, env = {} } = {}) {
  const started = Date.now()
  const result = spawnSync(CLAUDE, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...loaderEnv, ...env },
  })
  return {
    args,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ms: Date.now() - started,
  }
}

// --------------------------------------------------- loader stage (no turn) ---

const loaderDir = path.join(outDir, 'loader')
fs.mkdirSync(loaderDir, { recursive: true })

const addMarket = cli(['plugin', 'marketplace', 'add', marketplace])
fs.writeFileSync(path.join(loaderDir, 'marketplace-add.txt'), `${addMarket.stdout}${addMarket.stderr}`)
check('marketplace-added', addMarket.code === 0, `exit ${addMarket.code} in ${addMarket.ms}ms`)

const installs = []
for (const fixture of FIXTURES) {
  installs.push({ fixture: fixture.name, ...cli(['plugin', 'install', `${fixture.name}@s22-mkt`]) })
}
fs.writeFileSync(path.join(loaderDir, 'installs.json'), `${JSON.stringify(installs, null, 2)}\n`)

const list = cli(['plugin', 'list'])
fs.writeFileSync(path.join(loaderDir, 'plugin-list.txt'), `${list.stdout}${list.stderr}`)
const listText = `${list.stdout}${list.stderr}`

const details = {}
for (const fixture of FIXTURES.filter((f) => f.valid)) {
  const detail = cli(['plugin', 'details', fixture.name])
  details[fixture.name] = `${detail.stdout}${detail.stderr}`
  fs.writeFileSync(path.join(loaderDir, `details-${fixture.name}.txt`), details[fixture.name])
}

check('inline-monitors-array-accepted', /s22-inline[\s\S]*?Status:.*enabled/.test(listText),
  'plugin list status for s22-inline')
check('monitors-json-accepted', /s22-one[\s\S]*?Status:.*enabled/.test(listText),
  'plugin list status for s22-one')
check('unknown-monitor-key-refused', /s22-bad-extra[\s\S]{0,800}?failed to load/.test(listText),
  firstLine(listText, /s22-bad-extra[\s\S]*?(Error:[^\n]*)/))
check('short-on-skill-invoke-refused', /on-skill-invoke: must specify a skill name/.test(listText),
  firstLine(listText, /on-skill-invoke[^\n]*/))
check('enum-when-refused', /s22-bad-when-enum[\s\S]{0,800}?failed to load/.test(listText),
  firstLine(listText, /s22-bad-when-enum[\s\S]*?(Error:[\s\S]*?)\n\n/))

check(
  'details-inventory-omits-monitors',
  (details['s22-one'] ?? '').includes('Component inventory') && !/Monitors/i.test(details['s22-one'] ?? ''),
  'claude plugin details s22-one: Skills/Agents/Hooks/MCP/LSP only',
)

// The fixture monitor must demonstrably work on its own; otherwise the
// "nothing armed" result could be the fixture's fault, not the client's.
const standaloneDir = path.join(outDir, 'standalone')
fs.mkdirSync(standaloneDir, { recursive: true })
const standaloneLog = path.join(standaloneDir, 'events.jsonl')
const standalone = spawnSync(NODE, [path.join(HERE, 'monitor.mjs'), 'standalone', '100', '2'], {
  encoding: 'utf8',
  timeout: 3000,
  cwd: standaloneDir,
  env: { ...process.env, S22_LOG: standaloneLog, S22_MARKER: 's22-spike' },
})
fs.writeFileSync(path.join(standaloneDir, 'stdout.txt'), standalone.stdout ?? '')
fs.writeFileSync(path.join(standaloneDir, 'stderr.txt'), standalone.stderr ?? '')
const standaloneEvents = fs.existsSync(standaloneLog)
  ? fs.readFileSync(standaloneLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []
const standaloneBeats = (standalone.stdout ?? '').split('\n').filter((line) => line.startsWith('S22_MON '))
check(
  'monitor-script-emits-beats-standalone',
  standaloneEvents.some((event) => event.event === 'start') && standaloneBeats.length === 2,
  `${standaloneBeats.length} stdout beats, ${standaloneEvents.length} events; first: ${standaloneBeats[0] ?? '(none)'}`,
)

function firstLine(text, pattern) {
  const match = text.match(pattern)
  return match === null ? '(no match)' : match[0].replace(/\s+/g, ' ').slice(0, 240)
}

// ---------------------------------------------------------------- proxy -----

const UPSTREAM = 'https://api.deepseek.com'

function startProxy(logPath) {
  const records = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const record = {
      seq: records.length + 1,
      t: new Date().toISOString(),
      method: request.method,
      path: request.url,
      requestBytes: body.length,
      requestSha256: sha256(body),
      requestMonitorMentions: (body.toString('utf8').match(/S22_MON/g) ?? []).length,
      requestTaskNotificationMentions: (body.toString('utf8').match(/task_notification/g) ?? []).length,
      roles: rolesOf(body),
    }
    records.push(record)
    try {
      const headers = { ...request.headers }
      for (const name of ['host', 'content-length', 'accept-encoding', 'connection']) delete headers[name]
      const upstream = await fetch(UPSTREAM + (request.url ?? '/'), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
      })
      const payload = Buffer.from(await upstream.arrayBuffer())
      record.status = upstream.status
      record.responseBytes = payload.length
      record.responseSha256 = sha256(payload)
      const responseHeaders = {}
      for (const [name, value] of upstream.headers) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) continue
        responseHeaders[name] = value
      }
      response.writeHead(upstream.status, responseHeaders)
      response.end(payload)
    } catch (error) {
      record.error = String(error)
      response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(`s22 proxy error: ${error}`)
    } finally {
      fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`)
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/anthropic`,
        records,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function rolesOf(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return Array.isArray(parsed.messages) ? parsed.messages.map((message) => message.role) : []
  } catch {
    return []
  }
}

// ------------------------------------------------------------ model runs ----

function runSession({ captureName, pluginDirs, messages, extraArgs = [], timeoutMs = 240_000 }) {
  const dir = path.join(outDir, captureName)
  fs.mkdirSync(dir, { recursive: true })
  const args = []
  for (const pluginDir of pluginDirs) args.push('--plugin-dir', pluginDir)
  args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose')
  for (const tool of ['Bash', 'Skill', 'Read']) args.push('--allowedTools', tool)
  args.push('--debug-file', path.join(dir, 'debug.log'), ...extraArgs)

  const env = {
    ...modelEnv,
    S22_LOG: path.join(dir, 'events.jsonl'),
    ANTHROPIC_BASE_URL: proxy.baseUrl,
    S22_RUN: captureName,
  }
  const started = Date.now()
  const child = spawn(CLAUDE, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  let stdoutBuffer = ''
  let stderr = ''
  let index = 0
  let timedOut = false

  const sendNext = () => {
    if (index >= messages.length) {
      child.stdin.end()
      return
    }
    const text = messages[index]
    index += 1
    child.stdin.write(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    })}\n`)
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line.trim() !== '') {
        fs.appendFileSync(path.join(dir, 'stream.jsonl'), `${line}\n`)
        try {
          const event = JSON.parse(line)
          events.push(event)
          if (event.type === 'result') sendNext()
        } catch {
          // keep the raw line; the report quotes raw lines, not parsed ones
        }
      }
      newline = stdoutBuffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.on('error', () => {})

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      fs.writeFileSync(path.join(dir, 'stderr.txt'), stderr)
      const results = events.filter((event) => event.type === 'result')
      const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
      resolve({
        captureName,
        dir,
        args,
        code,
        signal,
        timedOut,
        ms: Date.now() - started,
        results,
        init,
        events,
        stderr,
      })
    })
    sendNext()
  })
}

function readEvents(dir) {
  const file = path.join(dir, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function transcriptPath(sessionId) {
  if (sessionId === undefined) return undefined
  const projects = path.join(modelHome, '.claude', 'projects')
  if (!fs.existsSync(projects)) return undefined
  for (const entry of fs.readdirSync(projects)) {
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

const promptOne = 'Run this exact bash command and nothing else: echo s22-one'
const promptTwo = 'Reply with exactly: turn-two-done'
const promptGated = '/s22-gated:s22-skill'
const promptResume = 'Reply with exactly: resumed-done'

const proxy = await startProxy(path.join(outDir, 'model-requests.jsonl'))

const one = await runSession({
  captureName: 'one-monitor',
  pluginDirs: [staged.get('one-monitor')],
  messages: [promptOne, promptTwo],
})
const two = await runSession({
  captureName: 'two-monitors',
  pluginDirs: [staged.get('two-monitors')],
  messages: [promptOne.replace('s22-one', 's22-two'), promptTwo],
})
const gated = await runSession({
  captureName: 'gated-skill',
  pluginDirs: [staged.get('gated-skill')],
  messages: [promptGated, promptTwo],
})
const firstSession = one.results[0]?.session_id
const resumed = firstSession === undefined
  ? null
  : await runSession({
    captureName: 'resume',
    pluginDirs: [staged.get('one-monitor')],
    messages: [promptResume],
    extraArgs: ['--resume', firstSession],
  })

await proxy.close()

// ----------------------------------------------------------- observations ---

function monitorRecords(dir) {
  return readEvents(dir).filter((event) => event.src === 'monitor')
}
function hookRecords(dir) {
  return readEvents(dir).filter((event) => event.src === 'hook')
}

const runs = { one, two, gated, resume: resumed }
for (const [name, run] of Object.entries(runs)) {
  if (run === null) continue
  check(`${name}:turn-completed`, run.code === 0 && run.results.length === (name === 'resume' ? 1 : 2),
    `exit ${run.code} signal ${run.signal ?? '-'} results ${run.results.length} in ${run.ms}ms`)
  if (name === 'one' || name === 'two') {
    check(`${name}:two-turns-one-session`, run.results.length === 2 && run.results[0].session_id === run.results[1].session_id,
      run.results.map((result) => result.session_id).join(','))
  }
}

const oneHooks = hookRecords(one.dir)
check('one:hooks-ran', oneHooks.length >= 5, `${oneHooks.length} hook records`)
check('one:plugin-in-session-init', (one.init?.plugins ?? []).some((plugin) => plugin.name === 's22-one'),
  JSON.stringify((one.init?.plugins ?? []).map((plugin) => plugin.name)))
check('one:hook-transcript-has-no-monitor-bytes',
  oneHooks.every((record) => (record.transcript?.monitorMentions ?? 0) === 0),
  oneHooks.map((record) => `${record.event}:${record.transcript?.size ?? 'n/a'}`).join(' '))

const spawns = {
  one: monitorRecords(one.dir).filter((event) => event.event === 'start').length,
  two: monitorRecords(two.dir).filter((event) => event.event === 'start').length,
  gated: monitorRecords(gated.dir).filter((event) => event.event === 'start').length,
  resume: resumed === null ? null : monitorRecords(resumed.dir).filter((event) => event.event === 'start').length,
}

const requestMentions = proxy.records.reduce((sum, record) => sum + record.requestMonitorMentions, 0)
const requestCount = proxy.records.length
const requestBytes = proxy.records.reduce((sum, record) => sum + record.requestBytes, 0)

check('monitor-process-start-recorded', spawns.one > 0,
  `one-monitor: ${spawns.one} start records of ${monitorRecords(one.dir).length} monitor records`)
check('two-monitor-processes-start-recorded', spawns.two > 0, `two-monitors: ${spawns.two} start records`)
check('gated-monitor-start-recorded', spawns.gated > 0, `on-skill-invoke: ${spawns.gated} start records`)
check('resume-monitor-start-recorded', spawns.resume !== null && spawns.resume > 0,
  `resume: ${spawns.resume} start records`)
check('monitor-bytes-never-reached-model', requestMentions === 0,
  `${requestCount} requests, ${requestBytes} request bytes, ${requestMentions} S22_MON occurrences`)

const sessionTranscript = transcriptPath(firstSession)
const transcriptText = sessionTranscript === undefined ? '' : fs.readFileSync(sessionTranscript, 'utf8')
check('transcript-has-no-monitor-bytes',
  sessionTranscript === undefined || !transcriptText.includes('S22_MON'),
  sessionTranscript === undefined ? 'no transcript file found' : `${transcriptText.length} bytes at ${sessionTranscript}`)

// --------------------------------------------------------------- evidence ---

const evidence = {
  pin: version,
  claudeBin: CLAUDE,
  tempRoot: root,
  createdAt: new Date().toISOString(),
  runs: Object.fromEntries(Object.entries(runs).filter(([, run]) => run !== null).map(([name, run]) => [name, {
    exit: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    ms: run.ms,
    results: run.results.map((result) => ({
      subtype: result.subtype,
      isError: result.is_error,
      sessionId: result.session_id,
      durationMs: result.duration_ms,
      numTurns: result.num_turns,
      result: typeof result.result === 'string' ? result.result.slice(0, 200) : undefined,
      modelUsage: result.modelUsage,
    })),
    initPlugins: (run.init?.plugins ?? []).map((plugin) => plugin.name),
  }])),
  hooks: Object.fromEntries(Object.entries(runs).filter(([, run]) => run !== null).map(([name, run]) => [
    name,
    hookRecords(run.dir).map((record) => ({
      t: record.t,
      event: record.event,
      arg: record.arg,
      toolName: record.toolName,
      transcriptSize: record.transcript?.size,
      monitorMentions: record.transcript?.monitorMentions,
    })),
  ])),
  monitors: {
    startRecords: spawns,
    records: Object.fromEntries(Object.entries(runs).filter(([, run]) => run !== null).map(([name, run]) => [
      name, monitorRecords(run.dir),
    ])),
  },
  modelRequests: {
    count: requestCount,
    requestBytes,
    monitorMentions: requestMentions,
    taskNotificationMentions: proxy.records.reduce((sum, record) => sum + record.requestTaskNotificationMentions, 0),
    records: proxy.records,
  },
  transcript: {
    path: sessionTranscript,
    bytes: sessionTranscript === undefined ? 0 : Buffer.byteLength(transcriptText),
    monitorMentions: (transcriptText.match(/S22_MON/g) ?? []).length,
  },
  loader: {
    pluginList: listText,
    details,
  },
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(evidence, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`)

console.log('\n--- S22 evidence ---')
for (const [name, run] of Object.entries(runs)) {
  if (run === null) continue
  const hooks = hookRecords(run.dir)
  console.log(`${name}: exit=${run.code} turns=${run.results.length} hooks=${hooks.length} monitors=${monitorRecords(run.dir).length} ms=${run.ms}`)
  for (const hook of hooks) {
    console.log(`  hook ${hook.t} ${hook.event}${hook.toolName === undefined ? '' : ` ${hook.toolName}`} transcript=${hook.transcript?.size ?? 'n/a'} monitorMentions=${hook.transcript?.monitorMentions ?? 'n/a'}`)
  }
}
console.log(`model requests: ${requestCount}, ${requestBytes} bytes, S22_MON mentions ${requestMentions}, task_notification mentions ${evidence.modelRequests.taskNotificationMentions}`)
console.log(`monitor start records: ${JSON.stringify(spawns)}`)
console.log(`debug monitor lines: ${countDebugMonitorLines()}`)
console.log(`standalone monitor: ${standaloneBeats.length} stdout beats; first: ${standaloneBeats[0] ?? '(none)'}`)

function countDebugMonitorLines() {
  let count = 0
  for (const run of Object.values(runs)) {
    if (run === null) continue
    const file = path.join(run.dir, 'debug.log')
    if (!fs.existsSync(file)) continue
    count += fs.readFileSync(file, 'utf8').split('\n').filter((line) => /monitor/i.test(line)).length
  }
  return count
}

// ---------------------------------------------------------------- publish ---

if (publish) {
  const captures = path.join(HERE, 'captures')
  fs.rmSync(captures, { recursive: true, force: true })
  fs.mkdirSync(captures, { recursive: true })
  const scrub = (text) =>
    text
      .split(root).join('<tmp>')
      .split(modelHome).join('<model-home>')
      .split(CLAUDE).join('<claude-bin>')
      .split(os.homedir()).join('<user-home>')

  for (const [name, run] of Object.entries(runs)) {
    if (run === null) continue
    const dir = path.join(captures, name)
    fs.mkdirSync(dir, { recursive: true })
    for (const file of ['stream.jsonl', 'events.jsonl', 'stderr.txt']) {
      const source = path.join(run.dir, file)
      if (fs.existsSync(source)) fs.writeFileSync(path.join(dir, file), scrub(fs.readFileSync(source, 'utf8')))
    }
    const debugFile = path.join(run.dir, 'debug.log')
    if (fs.existsSync(debugFile)) {
      const lines = fs.readFileSync(debugFile, 'utf8').split('\n')
      const monitorLines = lines.filter((line) => /monitor/i.test(line))
      fs.writeFileSync(
        path.join(dir, 'debug-monitor-lines.txt'),
        `${monitorLines.length} lines mention "monitor" (of ${lines.length} debug lines)\n${monitorLines.join('\n')}\n`,
      )
    }
  }
  fs.writeFileSync(path.join(captures, 'model-requests.jsonl'), `${proxy.records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const loaderCaptures = path.join(captures, 'loader')
  fs.mkdirSync(loaderCaptures, { recursive: true })
  for (const file of fs.readdirSync(loaderDir)) {
    if (file === 'installs.json') continue
    fs.writeFileSync(path.join(loaderCaptures, file), scrub(fs.readFileSync(path.join(loaderDir, file), 'utf8')))
  }
  fs.writeFileSync(path.join(captures, 'standalone-stdout.txt'), standalone.stdout ?? '')
  if (fs.existsSync(standaloneLog)) fs.writeFileSync(path.join(captures, 'standalone-events.jsonl'), scrub(fs.readFileSync(standaloneLog, 'utf8')))
  fs.writeFileSync(path.join(captures, 'checks.json'), scrub(`${JSON.stringify(checks, null, 2)}\n`))
  fs.writeFileSync(path.join(captures, 'summary.json'), scrub(`${JSON.stringify(evidence, null, 2)}\n`))
  const transcript = sessionTranscript === undefined ? null : path.join(captures, 'transcript.jsonl')
  if (transcript !== null) fs.writeFileSync(transcript, scrub(transcriptText))
  console.log(`published captures to ${captures}`)
}

// ------------------------------------------------------------- exit code ----

if (checks.length === 0) {
  console.error('s22: REFUSED: zero checks ran; a silent pass would be a lie')
  process.exit(1)
}

const refused = spawns.one === 0
if (refused) {
  console.error('\ns22: REFUSED — the pinned client never spawned a plugin monitor.')
  console.error(`  fixture:   ${path.join(HERE, 'fixtures/one-monitor')} (plugin "${FIXTURES[0].name}", one monitor "beat")`)
  console.error(`  evidence:  ${spawns.one} monitor start records; ${requestCount} model requests with ${requestMentions} S22_MON bytes; ` +
    `${oneHooks.length} hook records; ${countDebugMonitorLines()} debug lines mentioning "monitor"`)
  console.error('  the plugin itself loaded and its hooks ran, so the monitor surface is the thing that was declined.')
  console.error('  this exit code is the answer, not a defect: see spikes/s22-monitors/REPORT.md')
  process.exit(1)
}

const failed = checks.filter((entry) => !entry.ok)
if (failed.length > 0) {
  console.error(`\ns22: ${failed.length} check(s) failed: ${failed.map((entry) => entry.id).join(', ')}`)
  process.exit(1)
}
console.log('\ns22: all checks passed')
