// S23: do the six events S9 left "unprobed" fire as host events a listener can
// open, and what payload does each carry?
//
// S9 recorded TaskCreated, TaskCompleted, TeammateIdle, WorktreeCreate,
// WorktreeRemove and StopFailure as plausible-but-unprobed. A source line is not
// evidence (D19/D20): a row is "fired" only when a listener registered from this
// spike received the payload in this run. Everything else is "not-fired", with
// what was tried and the cheapest next attempt written down.
//
// The boot graph is S9's (see spikes/s9-host-events/run.mjs), plus the services
// the six events live behind: the JSONL persistence provider (TeamJournal's
// flush check), the subagent registry (Team task ownership and the fork
// teammate), Agent Teams, and the worktree stack. `dsh-sandbox` is mounted for
// real; `workspaceRegistry` and `sessionQuery` are one-method doubles because
// dsh-workspace and dsh-session-query are not in the fetched harness union
// (scripts/fetch-harness.mjs). The reclamation side only reads
// `archivedSessionIds` and `listSessions`.
//
// TeammateIdle is not recorded by any service at this pin, so the probe drives
// a real fork teammate (`dsh-subagent-fork-in-process`) through
// `startActivation` to idle. The row is only meaningful if the child actually
// reaches idle; the check fails when it does not, and the `team/member`
// listeners are registered before activation so "nothing fired" is measured
// over the idle transition rather than assumed.
//
// Run:
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
//     node spikes/s23-unprobed-events/run.mjs
//
// `out/` is gitignored. A bare or incomplete harness is a failure, not a green
// 0/0 run; zero of six fired also exits non-zero even if every probe "ran".
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'
const OUT = join(HERE, 'out')

// S9's minimal turn graph.
const REQUIRED = ['cordis', 'dsh-session', 'dsh-tools', 'dsh-system-prompt', 'dsh-agent', 'dsh-llm']
const FULL_TURN = [...REQUIRED, 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-session-projection']
// Services the unprobed events live behind. All are in the fetched union.
const S23_PACKAGES = [
  'dsh-session-persistence-jsonl',
  'dsh-subagent',
  'dsh-subagent-fork-in-process',
  'dsh-agent-team',
  'dsh-fs-local',
  'dsh-subprocess-local',
  'dsh-sandbox',
  'dsh-sandbox-policy',
  'dsh-working-directory',
  'dsh-experimental-worktree',
]

const checks = []
const skipped = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
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
    await sleep(10)
  }
}
const keyList = (value) => (value === undefined || value === null ? [] : Object.keys(value))

/** Locate the @deepseek-ai package directory, mirroring harness.ts's shapes. */
function packageDirFor(root) {
  const nested = join(root, 'node_modules', '@deepseek-ai')
  if (existsSync(nested)) return nested
  const scoped = join(root, '@deepseek-ai')
  if (existsSync(scoped)) return scoped
  if (existsSync(join(root, 'cordis', 'package.json'))) return root
  const parent = dirname(root)
  if (existsSync(join(parent, 'cordis', 'package.json'))) return parent
  return nested
}

function locateHarness() {
  const named = process.env.DSH_HARNESS_DIR?.trim()
  const installed = process.env.DSH_INSTALL_DIR?.trim()
  // D24: a path that was explicitly set is an error, never a fall-through.
  // Falling back from a bad DSH_HARNESS_DIR to a good DSH_INSTALL_DIR would
  // report green against a tree the operator did not name.
  const [base, source] = named
    ? [resolve(named), 'DSH_HARNESS_DIR']
    : installed
      ? [resolve(installed), 'DSH_INSTALL_DIR']
      : [join(REPO, '.harness', VERSION), '.harness']
  const dir = packageDirFor(base)
  const missing = REQUIRED.filter((name) => !existsSync(join(dir, name, 'package.json')))
  if (missing.length === 0) return { dir, source }
  console.error(`no usable harness: ${source}=${base} is unusable; missing ${missing.join(', ')}`)
  if (named) console.error('s23: DSH_HARNESS_DIR was set explicitly; it is validated alone and never replaced by DSH_INSTALL_DIR')
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
const has = (name) => existsSync(join(HARNESS, name, 'package.json'))

// A resolved tree that is not the pin is not evidence for this pin. Without
// this check, an absent DSH_HARNESS_DIR silently falls through to the Desktop
// install and the spike reports a green run against a different version.
const resolvedVersion = version()
if (resolvedVersion !== VERSION) {
  console.error(`s23: harness pin mismatch: wanted ${VERSION}, found ${resolvedVersion} at ${HARNESS} (${HARNESS_SOURCE})`)
  process.exit(2)
}

console.log(`harness: ${HARNESS} (${HARNESS_SOURCE}, ${resolvedVersion})`)

// ---------------------------------------------------------------------------
// Fixture repo for the worktree probes
// ---------------------------------------------------------------------------

function makeRepo(root) {
  const repo = join(root, 'repo')
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('config', 'user.email', 's23@example.invalid')
  git('config', 'user.name', 'S23 probe')
  writeFileSync(join(repo, 'README.md'), '# S23 probe repository\n')
  git('add', 'README.md')
  git('commit', '-qm', 's23 probe base')
  return { repo, git }
}

// ---------------------------------------------------------------------------
// Boot: S9's turn graph plus the team/worktree stack
// ---------------------------------------------------------------------------

function fakeAdapterClass(LlmAdapter) {
  return class FakeAdapter extends LlmAdapter {
    constructor(script) {
      super()
      this.script = script
      this.calls = []
    }
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 8192 }, defaultMaxTokens: 1024 }
    }
    async *stream(options) {
      this.calls.push({
        messages: options.messages.map((message) => ({ role: message.role, content: message.content })),
        tools: (options.tools ?? []).map((tool) => tool.name),
        purpose: options.purpose,
      })
      for (const chunk of this.script(this.calls.length, options)) yield chunk
    }
  }
}

const textChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

// `dsh-agent-loop` reads `finish.kind` (lib/index.js:936); a bare string reason
// is not an error at this pin. The failure object is what `LlmError.fromFailure`
// consumes, so it must carry a non-empty message and code.
const failingChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'error', failure: { code: 'PROBE_FAILURE', message: text } } },
]

async function boot({ repo, sessionsRoot, fakeScript }) {
  const { Context } = await load('cordis/lib/index.js')
  const SessionStore = (await load('dsh-session/lib/index.js')).default
  const SessionProjections = (await load('dsh-session-projection/lib/index.js')).default
  const SystemPrompt = (await load('dsh-system-prompt/lib/index.js')).default
  const ToolsService = (await load('dsh-tools/lib/index.js')).default
  const AgentRegistry = (await load('dsh-agent/lib/index.js')).default
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm/lib/index.js')
  const AgentLoop = (await load('dsh-agent-loop/lib/index.js')).default
  const nativeExecutor = await load('dsh-tool-executor-native/lib/index.js')
  const Jsonl = await load('dsh-session-persistence-jsonl/lib/index.js')
  const Subagents = (await load('dsh-subagent/lib/index.js')).default
  const Fork = await load('dsh-subagent-fork-in-process/lib/index.js')
  const Teams = (await load('dsh-agent-team/lib/index.js')).default
  const FsLocal = (await load('dsh-fs-local/lib/index.js')).default
  const SubprocessLocal = (await load('dsh-subprocess-local/lib/index.js')).default
  const Sandbox = (await load('dsh-sandbox/lib/index.js')).default
  const SandboxPolicy = (await load('dsh-sandbox-policy/lib/index.js')).default
  const WorkingDirectory = (await load('dsh-working-directory/lib/index.js')).default
  const Worktrees = (await load('dsh-experimental-worktree/lib/index.js')).default

  const ctx = new Context()
  const fibers = []
  const mount = (plugin, config = {}) => fibers.push(ctx.plugin(plugin, config))

  // One-method doubles for the two services reclamation reads. Both names are
  // resolved through `ctx.get` in WorktreeReclamation; the values are only used
  // by the archive path, which this spike drives directly.
  ctx.provide('workspaceRegistry', { archivedSessionIds: new Set() })
  ctx.provide('sessionQuery', {
    async listSessions() {
      return []
    },
  })

  mount(SessionStore)
  mount(SessionProjections)
  mount(SystemPrompt)
  mount(ToolsService)
  mount(AgentRegistry)
  mount(nativeExecutor)
  mount({ name: Jsonl.name, apply: Jsonl.apply, Config: Jsonl.Config }, { root: sessionsRoot, compression: 'none' })
  mount(FsLocal, { cwd: repo })
  mount(SubprocessLocal)
  mount(Sandbox)
  mount(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: repo })
  mount(WorkingDirectory, { defaultDirectory: repo })
  mount(Subagents)
  mount(Fork, { providerName: 'fork' })
  mount(Teams, { defaultEnabled: false })
  // The service rejects absolute or dot-segment directories; `createCheckout`
  // resolves this relative pool against the repository root it discovers from
  // the agent's working directory.
  mount(Worktrees, { directory: '.agents/worktrees', retainOnArchive: false })
  mount(LlmRuntime)
  mount(AgentLoop)

  for (const name of ['sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents']) await until(() => ctx.get(name), 5000, name)
  const adapter = new (fakeAdapterClass(LlmAdapter))(fakeScript ?? (() => textChunks('ok')))
  ctx.llm.registerAdapter(['fake'], adapter)
  await until(() => ctx.get('llm'), 5000, 'llm')
  await until(() => ctx.get('agentLoop'), 5000, 'agentLoop')
  for (const name of ['sessionPersistence', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy', 'workingDirectory', 'subagents', 'agentTeams', 'worktrees']) {
    await until(() => ctx.get(name), 5000, name)
  }
  return { ctx, adapter, createUserMessage, workspaceRegistry: ctx.get('workspaceRegistry') }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

const observations = { team: [], worktreeRecords: [], cleanups: [], agentErrors: [], statuses: [], sessionTypes: [], memberRecords: [], teamMemberEmits: [], assistantMessages: [] }
const events = new Map()
function recordEvent(event, fired, emitter, payloadKeys, detail) {
  events.set(event, { event, fired, emitter, payloadKeys, detail })
}
function emitterList(keys) {
  return [...new Set(keys)].join(',')
}

async function probeAll() {
  const { repo, git } = makeRepo(OUT)
  const sessionsRoot = join(OUT, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const branch = `s23-probe-${Date.now().toString(36)}`
  let breakdown = {}
  // Set after the StopFailure agent exists; the fork teammate's call succeeds,
  // the error turn's call fails. Keying on the session id keeps the script
  // independent of call ordering (the team and worktree actions make no calls).
  let stopFailureSessionId

  const { ctx, adapter, createUserMessage, workspaceRegistry } = await boot({
    repo,
    sessionsRoot,
    fakeScript: (_call, options) => (options.sessionId === stopFailureSessionId ? failingChunks('s23 model failure') : textChunks('teammate turn complete')),
  })

  const offs = [
    ctx.on('session/event', (_session, event) => {
      observations.sessionTypes.push(event.type)
      if (event.type === 'team/task') observations.team.push(event)
      if (event.type === 'team/member') observations.memberRecords.push(event)
      if (event.type === 'assistant/message') observations.assistantMessages.push({ sessionId: _session?.id, turn: event.data?.turn })
      if (event.type === 'plugin:worktree/created') observations.worktreeRecords.push(event)
    }),
    ctx.on('team/member', (payload) => observations.teamMemberEmits.push(payload)),
    ctx.on('worktree/cleanup', (payload) => observations.cleanups.push(payload)),
    ctx.on('agent/error', (payload) => observations.agentErrors.push(payload)),
    ctx.on('agent/status', (payload) => observations.statuses.push(payload)),
  ]

  // -- Team: TaskCreated / TaskCompleted / TeammateIdle ----------------------
  console.log('\n[probe] team/task records')
  const lead = await ctx.agentLoop.create('s23-team-lead', { provider: 'fake', model: 'fake-1' })
  await ctx.agentTeams.setEnabled(lead, true)
  const createdView = await ctx.agentTeams.createTask(lead, { subject: 'S23 task', description: 'probe task' })
  const claimedView = await ctx.agentTeams.updateTask(lead, { taskId: createdView.id, expectedRevision: 1, action: 'claim' })
  const completedView = await ctx.agentTeams.updateTask(lead, { taskId: createdView.id, expectedRevision: 2, action: 'complete' })
  await sleep(20)

  const taskRecords = observations.team
  const createRecord = taskRecords.find((event) => event.data?.task?.revision === 1)
  const completeRecord = taskRecords.find((event) => event.data?.task?.status === 'completed')
  const createKeys = keyList(createRecord?.data)
  const createTaskKeys = keyList(createRecord?.data?.task)
  const completeTaskKeys = keyList(completeRecord?.data?.task)

  check('TaskCreated: a listener received team/task revision 1', createRecord !== undefined, `records=${taskRecords.length}`)
  check('TaskCreated: record data carries version/teamId/task', ['version', 'teamId', 'task'].every((key) => createKeys.includes(key)) && createTaskKeys.includes('id') && createTaskKeys.includes('subject') && createTaskKeys.includes('description'), `data=${createKeys.join(',')} task=${createTaskKeys.join(',')}`)
  check('TaskCompleted: a listener received a completed team/task revision', completeRecord !== undefined && completeRecord.data.task.revision === 3 && completeRecord.data.task.status === 'completed', `status=${completeRecord?.data?.task?.status}`)
  check('the board recorded the claim between create and complete', claimedView.status === 'in_progress' && claimedView.ownerId === lead.id, `status=${claimedView.status} ownerId=${claimedView.ownerId}`)
  check('the only team record types observed are team/mode and team/task', [...new Set(observations.sessionTypes.filter((type) => type.startsWith('team/')))].sort().join(',') === 'team/mode,team/task', `types=${[...new Set(observations.sessionTypes.filter((type) => type.startsWith('team/')))]}`)

  // -- TeammateIdle: drive a fork teammate to idle ---------------------------
  // The worktree/cleanup and StopFailure probes do not need a teammate, so this
  // runs before them. The listeners above are already registered; the idle
  // assertion is what makes "nothing fired" a measurement rather than a
  // vacuous `[].every(...)`.
  console.log('\n[probe] fork teammate to idle')
  let activation
  let idleStatus
  let teammateError
  try {
    activation = await ctx.subagents.startActivation({
      provider: 'fork',
      parent: lead,
      label: 'S23 idle teammate',
      name: 's23-idle',
      prompt: [{ type: 'text', text: 'finish this turn and go idle' }],
      delivery: 'parent',
      signal: new AbortController().signal,
    })
    const child = ctx.agents.get(activation.childId)
    if (child === undefined) throw new Error(`activated child ${activation.childId} is not live`)
    await Promise.race([
      child.whenIdle(),
      sleep(15_000).then(() => {
        throw new Error(`fork teammate ${activation.childId} did not reach idle within 15s`)
      }),
    ])
    idleStatus = await until(() => observations.statuses.find((payload) => payload.agent?.id === activation.childId && payload.status === 'idle'), 5000, 'agent/status idle for the fork teammate')
  } catch (error) {
    teammateError = error
  }
  const idleKeys = keyList(idleStatus)
  const teammateFired = observations.memberRecords.length > 0 || observations.teamMemberEmits.length > 0
  check('TeammateIdle: the fork teammate actually reached idle', idleStatus !== undefined, teammateError === undefined ? `child=${activation?.childId} keys=${idleKeys.join(',')}` : String(teammateError?.message ?? teammateError))
  check('TeammateIdle: no team/member record and no team/member listener fired', !teammateFired, `records=${observations.memberRecords.length} emits=${observations.teamMemberEmits.length} sessionTypes=${[...new Set(observations.sessionTypes.filter((type) => type === 'team/member'))].join(',') || 'none'}`)
  check('TeammateIdle: the nearest payload is agent/status {status, agent}', idleKeys.includes('status') && idleKeys.includes('agent') && idleStatus?.status === 'idle', `keys=${idleKeys.join(',')} agentId=${idleStatus?.agent?.id}`)

  recordEvent('TaskCreated', createRecord !== undefined, 'session/event team/task @ dsh-agent-team/lib/index.js:93', createKeys, {
    mechanism: 'service call: agentTeams.createTask (no model turn)',
    taskPayloadKeys: createTaskKeys,
    task: createRecord?.data?.task,
    classicFields: ['task_id', 'task_subject', 'task_description'],
    missingClassicFields: ['team_name', 'teammate_name'],
    toolCallShaped: false,
    toolCallNote: 'service record; it carries no tool name, tool input, or call id',
    note: 'teamId is the root session id branded as a Team identity, not a display name, so team_name has no source; the revision-one task is unowned, so teammate_name has no source either',
  })
  recordEvent('TaskCompleted', completeRecord !== undefined, 'session/event team/task @ dsh-agent-team/lib/index.js:93', keyList(completeRecord?.data), {
    mechanism: 'service call: agentTeams.updateTask { action: "complete" } (no model turn)',
    taskPayloadKeys: completeTaskKeys,
    task: completeRecord?.data?.task,
    classicFields: ['task_id', 'task_subject', 'task_description', 'teammate_name'],
    missingClassicFields: ['team_name'],
    toolCallShaped: false,
    toolCallNote: 'service record; no tool name or call id, though a completed task carries ownerName',
    note: 'ownerName (observed as "lead") is the source for teammate_name; teamId is a session id, not a team display name; completion requires claim first',
  })
  recordEvent('TeammateIdle', teammateFired, 'none: no team/member record or emit in 0.2.2-rc.5; nearest agent/status @ dsh-agent-loop/lib/index.js:571', [], {
    mechanism: 'fork teammate: subagents.startActivation(provider "fork") drove a real turn and the child reached idle; no per-member record was appended and no team/member listener fired',
    childId: activation?.childId,
    childName: activation?.name,
    childReachedIdle: idleStatus !== undefined,
    teamMemberRecords: observations.memberRecords.length,
    teamMemberEmits: observations.teamMemberEmits.length,
    nearest: 'agent/status {status, agent} (generic agent status, not a teammate-idle record)',
    nearestKeys: idleKeys,
    nearestAgentId: idleStatus?.agent?.id,
    classicFields: [],
    missingClassicFields: ['teammate_name', 'team_name'],
    toolCallShaped: false,
    toolCallNote: 'no event fired; agent/status carries no tool name, tool input, or call id',
    error: teammateError === undefined ? undefined : String(teammateError?.message ?? teammateError),
    nextAttempt: 'none at this pin: the teammate lifecycle has no record or emit, so TeammateIdle needs an upstream per-member event; no listener can be wired to an existing one',
  })

  // -- Worktree: WorktreeCreate / WorktreeRemove ------------------------------
  console.log('\n[probe] worktree records and cleanup')
  const wtAgent = await ctx.agentLoop.create('s23-worktree', { provider: 'fake', model: 'fake-1' })
  await ctx.workingDirectory.set(wtAgent, repo)
  const created = await ctx.worktrees.create(wtAgent, { name: branch })
  await sleep(20)
  const createWtRecord = observations.worktreeRecords.find((event) => event.data?.branch === branch)
  const createWtKeys = keyList(createWtRecord?.data)
  const createdPathExists = existsSync(created.path)

  check('WorktreeCreate: a listener received plugin:worktree/created', createWtRecord !== undefined, `records=${observations.worktreeRecords.length}`)
  check('WorktreeCreate: record data keys are path/branch/baseCommit/repositoryRoot', ['path', 'branch', 'baseCommit', 'repositoryRoot'].every((key) => createWtKeys.includes(key)) && createWtKeys.length === 4, `keys=${createWtKeys.join(',')}`)
  check('WorktreeCreate: the service returned a live checkout', createdPathExists, created.path)

  workspaceRegistry.archivedSessionIds.add(wtAgent.session.id)
  ctx.emit('workspace/session-archived', { sessionId: wtAgent.session.id })
  let cleanupError
  let viaArchive = false
  try {
    await until(() => observations.cleanups.filter((payload) => payload.cleanup?.status === 'removed').length > 0, 20_000, 'worktree/cleanup removed')
    viaArchive = true
  } catch (error) {
    cleanupError = error
    // Fallback: the reclamation is reachable directly; record that the event
    // path did not reach it, but still prove the emitter's payload.
    try {
      await ctx.worktrees.reclamation?.schedule(wtAgent.session.id)
      await until(() => observations.cleanups.filter((payload) => payload.cleanup?.status === 'removed').length > 0, 10_000, 'worktree/cleanup removed (direct schedule)')
    } catch (fallbackError) {
      cleanupError = new AggregateError([error, fallbackError], 'worktree cleanup did not run')
    }
  }
  const firstCleanup = observations.cleanups[0]
  const finalCleanup = [...observations.cleanups].reverse().find((payload) => payload.cleanup?.status === 'removed')
  const removedFromDisk = !existsSync(created.path)
  const cleanupStatuses = observations.cleanups.map((payload) => payload.cleanup?.status)
  check('WorktreeRemove: the archive emit reached the reclamation listener', viaArchive, `viaArchive=${viaArchive} statuses=${cleanupStatuses.join(',')}`)
  check('WorktreeRemove: cleanup emits scheduled then removed', cleanupStatuses.includes('scheduled') && cleanupStatuses.includes('removed'), `statuses=${cleanupStatuses.join(',')}`)
  check('WorktreeRemove: payload carries sessionId/path/cleanup', firstCleanup !== undefined && ['sessionId', 'path', 'cleanup'].every((key) => keyList(firstCleanup).includes(key)) && ['revision', 'status'].every((key) => keyList(firstCleanup.cleanup).includes(key)), `keys=${keyList(firstCleanup).join(',')} cleanup=${keyList(firstCleanup?.cleanup).join(',')}`)
  check('WorktreeRemove: the checkout left the disk', removedFromDisk, created.path)
  check('WorktreeRemove: cleanupOf reports the final status', (await ctx.worktrees.cleanupOf(wtAgent.session, null))?.status === 'removed', JSON.stringify(await ctx.worktrees.cleanupOf(wtAgent.session, null)))

  recordEvent('WorktreeCreate', createWtRecord !== undefined, 'session/event plugin:worktree/created @ dsh-experimental-worktree/lib/index.js:898', createWtKeys, {
    mechanism: 'service call: worktrees.create (no model turn)',
    payload: createWtRecord?.data,
    classicFields: ['name'],
    toolCallShaped: false,
    toolCallNote: 'service record; no tool name, tool input, or call id',
    note: 'branch is the source for the classic name field',
  })
  recordEvent('WorktreeRemove', observations.cleanups.length > 0, 'worktree/cleanup @ dsh-experimental-worktree/lib/index.js:112,:127', keyList(firstCleanup), {
    mechanism: 'ctx.emit on workspace/session-archived; reclamation emits scheduled then removed (no model turn)',
    viaArchive,
    statuses: cleanupStatuses,
    cleanupKeys: keyList(firstCleanup?.cleanup),
    payload: finalCleanup ?? firstCleanup,
    classicFields: ['worktree_path'],
    toolCallShaped: false,
    toolCallNote: 'emit; no tool name, tool input, or call id',
    note: 'path maps to worktree_path; no tool name or call id is present',
    error: cleanupError === undefined ? undefined : String(cleanupError?.message ?? cleanupError),
  })

  // -- StopFailure: turn/end with an error reason -----------------------------
  console.log('\n[probe] error turn')
  const sfAgent = await ctx.agentLoop.create('s23-stop-failure', { provider: 'fake', model: 'fake-1' })
  stopFailureSessionId = sfAgent.session.id
  const ended = await (async () => {
    const done = new Promise((resolveEnd, rejectEnd) => {
      const timer = setTimeout(() => rejectEnd(new Error('turn 1 did not end')), 10_000)
      const off = ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/end' && event.data?.turn === 1) {
          clearTimeout(timer)
          off()
          resolveEnd(event)
        }
      })
    })
    sfAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'trigger the failure' }], source: { kind: 'user' } }))
    return done
  })()
  await sleep(20)

  const errorPayload = observations.agentErrors.at(-1)
  const reason = ended.data?.reason
  const reasonKeys = keyList(reason)
  const failureKeys = keyList(reason?.error)
  check('StopFailure: turn/end carried an error reason', reason?.kind === 'error', `kind=${reason?.kind}`)
  check('StopFailure: reason.error carries message and code', failureKeys.includes('message') && failureKeys.includes('code'), `keys=${failureKeys.join(',')}`)
  check('StopFailure: agent/error reached a listener with turn/step/error', errorPayload !== undefined && ['turn', 'step', 'error'].every((key) => keyList(errorPayload).includes(key)), `keys=${keyList(errorPayload).join(',')}`)
  check('StopFailure: the model failure is the one the probe injected', errorPayload?.error?.failure?.code === 'PROBE_FAILURE' && errorPayload?.error?.message === 's23 model failure', `code=${errorPayload?.error?.failure?.code}`)
  check('StopFailure: the error turn produced no assistant/message', !observations.assistantMessages.some((message) => message.sessionId === sfAgent.session.id && message.turn === 1), `messages=${JSON.stringify(observations.assistantMessages)}`)

  recordEvent('StopFailure', reason?.kind === 'error', 'session/event turn/end @ dsh-agent-loop/lib/index.js:832 (+ agent/error @ :657)', keyList(ended.data), {
    mechanism: 'model turn: the fake adapter returns a finish error; the loop throws LlmError and appends turn/end',
    turn: ended.data?.turn,
    agentErrorKeys: keyList(errorPayload),
    reasonKeys,
    failureKeys,
    classicFields: ['error', 'error_details'],
    missingClassicFields: ['last_assistant_message'],
    toolCallShaped: false,
    toolCallNote: 'a model/stream failure, not a tool call; no tool name or call id',
    note: 'error is the failure code class; error_details is the failure message; the streamed text is in assistant/attempt, not in the turn/end payload',
  })

  for (const off of offs) off()
  await sleep(20)

  breakdown = {
    team: {
      enable: 'ok',
      create: createdView,
      claim: claimedView,
      complete: completedView,
      records: taskRecords.map((event) => ({ type: event.type, dataKeys: keyList(event.data), task: event.data?.task })),
      teammate: {
        activation: activation === undefined ? undefined : { childId: activation.childId, name: activation.name, messageId: activation.messageId },
        reachedIdle: idleStatus !== undefined,
        idleStatus: idleStatus === undefined ? undefined : { keys: idleKeys, status: idleStatus.status, agentId: idleStatus.agent?.id },
        memberRecords: observations.memberRecords.length,
        teamMemberEmits: observations.teamMemberEmits.length,
        error: teammateError === undefined ? undefined : String(teammateError?.message ?? teammateError),
      },
    },
    worktree: {
      branch,
      created,
      createRecordKeys: createWtKeys,
      cleanups: observations.cleanups,
      cleanupStatuses,
      viaArchive,
      removedFromDisk,
      cleanupOf: await ctx.worktrees.cleanupOf(wtAgent.session, null),
      cleanupError: cleanupError === undefined ? undefined : String(cleanupError?.message ?? cleanupError),
    },
    stopFailure: {
      turnEndKeys: keyList(ended.data),
      reason,
      agentErrors: observations.agentErrors.map((payload) => ({ keys: keyList(payload), turn: payload.turn, step: payload.step, errorName: payload.error?.name, errorCode: payload.error?.code, failureKeys: keyList(payload.error?.failure) })),
      statuses: observations.statuses.map((payload) => ({ keys: keyList(payload), status: payload.status })),
    },
    adapterCalls: adapter.calls.length,
    sessionTypes: [...new Set(observations.sessionTypes)],
  }

  // Remove the probe branch; `removeCheckout` deliberately leaves it behind.
  const branchDelete = spawnSync('git', ['branch', '-D', branch], { cwd: repo, encoding: 'utf8' })
  check('WorktreeRemove: the probe branch can be deleted after removal', branchDelete.status === 0, branchDelete.stderr.trim())
  return breakdown
}

// ---------------------------------------------------------------------------
// Main + report
// ---------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const missing = [...FULL_TURN, ...S23_PACKAGES].filter((name) => !has(name))
let results = {}
if (missing.length > 0) {
  skip('S23 six-event probe', `missing harness package(s): ${missing.join(', ')}`)
} else {
  try {
    results = await probeAll()
  } catch (error) {
    results = { error: String(error?.stack ?? error) }
    check('probeAll completed', false, String(error?.message ?? error))
  }
}

const order = ['TaskCreated', 'TaskCompleted', 'TeammateIdle', 'WorktreeCreate', 'WorktreeRemove', 'StopFailure']
console.log('\nS23 events')
for (const name of order) {
  const row = events.get(name) ?? { fired: false, emitter: 'probe did not run', payloadKeys: [] }
  const keys = row.payloadKeys.filter((key) => typeof key === 'string' && key.length > 0)
  console.log(`${name} -> ${row.fired ? 'fired' : 'not-fired'}  emitter=${row.emitter}  payload=${keys.length > 0 ? keys.join(',') : 'none'}`)
}
const fired = order.filter((name) => events.get(name)?.fired === true)

const passed = checks.filter((entry) => entry.ok).length
if (checks.length === 0) console.log(`\n0 checks ran${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}; ${fired.length}/${order.length} events fired`)
else console.log(`\n${passed}/${checks.length} checks passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}; ${fired.length}/${order.length} events fired`)
if (missing.length > 0) console.error(`s23: harness incomplete: missing ${missing.join(', ')}; fetch the pin with scripts/fetch-harness.mjs and pass that tree`)
else if (checks.length === 0) console.error('s23: no checks ran; fetch the pin with scripts/fetch-harness.mjs and pass that tree')
else if (skipped.length > 0) console.error(`s23: ${skipped.length} required probe(s) skipped; a vacuous run is a failure, not a pass`)
else if (fired.length === 0) console.error('s23: zero of six events fired; the spike is red by definition')
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({
  spike: 'S23',
  pin: version(),
  harness: { dir: HARNESS, source: HARNESS_SOURCE },
  checks,
  skipped,
  events: order.map((name) => events.get(name) ?? { event: name, fired: false, emitter: 'probe did not run', payloadKeys: [] }),
  fired: fired.length,
  results,
}, null, 2)}\n`)
console.log(`wrote ${join(OUT, 'report.json')}`)
process.exit(checks.length === 0 || missing.length > 0 || skipped.length > 0 ? 2 : fired.length === 0 || passed !== checks.length ? 1 : 0)
