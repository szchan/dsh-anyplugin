#!/usr/bin/env node
// S15 — what do the five pinned Claude mods demand on a real DSH turn?
//
// The instrument is deliberately thin. The *real* materializer seats the mods
// through the real kernel, the real mod host loads them, and the real S9
// lifecycle probe produces the turn. Two ESM resolve hooks redirect only the
// materializer's own imports of `dsh-anyplugin-mod-host` and
// `dsh-anyplugin-intercept` to shims in this directory; the shims re-export
// the real modules and wrap `createModBridge` / `loadMod` /
// `modRegistrationsToKernel` for measurement. No namespace, dispatcher, event
// or payload is reimplemented.
//
// It is local-only and key-less: the S9 stub adapter is the only LLM, and no
// network call is made. Run:
//
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
//   DSH_HARNESS_VERSION=0.2.2-rc.5 \
//   ANYPLUGIN_MODS_TREE=$PWD/.mods/f9e4d1e5753ccffcffdd832f047d72be000396a6 \
//     node --experimental-vm-modules spikes/s15-mod-demand/run.mjs
//
// It skips cleanly (exit 0 with a reason) when ANYPLUGIN_MODS_TREE is unset, so
// it can be wired into a test runner without fetching anything.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const spikeDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(spikeDir, '..', '..')
const outDir = join(spikeDir, 'out')

const modsTree = process.env.ANYPLUGIN_MODS_TREE
if (modsTree === undefined || modsTree.trim() === '') {
  console.log('s15-mod-demand: skipped (ANYPLUGIN_MODS_TREE is unset); see spikes/s15-mod-demand/REPORT.md')
  process.exit(0)
}

// The materializer is loaded by the harness loader under its file URL. Only its
// two package imports are redirected; every other importer keeps the real
// modules, and the shims themselves import the real ones too.
const materializerUrl = pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-hook', 'src', 'index.ts')).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(materializerUrl)) {
      if (specifier === '../../dsh-anyplugin-mod-host/src/index.ts') {
        return { url: pathToFileURL(join(spikeDir, 'mod-host-shim.mjs')).href, shortCircuit: true }
      }
      if (specifier === '../../dsh-anyplugin-intercept/src/index.ts') {
        return { url: pathToFileURL(join(spikeDir, 'intercept-shim.mjs')).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})

const { probeLifecycleWithDsh } = await import('../../packages/dsh-anyplugin-conformance/src/oracles/dsh.ts')
const { resolveHarness } = await import('../../packages/dsh-anyplugin-conformance/src/harness.ts')
const { UPSTREAM_MODS_PIN } = await import('../../packages/dsh-anyplugin-mod-host/src/pin.ts')
const { scanModSource } = await import('../../packages/dsh-anyplugin-mod-scan/src/index.ts')
const { snapshot } = await import('./recorder.mjs')

const harness = resolveHarness()
if (harness === undefined) {
  console.error('s15-mod-demand: no pinned harness (set DSH_HARNESS_DIR or DSH_HARNESS_VERSION)')
  process.exit(1)
}
const tree = resolve(modsTree)

// S15 asks about the five mods that existed at 2.1.322. Later pins add mods
// (2.1.329 adds easel and hipaa-default); the question stays the same five, so
// filter them out of the pin's list rather than letting the spike silently grow.
const S15_MODS = ['agents-md', 'diff', 'privacy', 'sec-default', 'telemetry']
const mods = UPSTREAM_MODS_PIN.mods.map((mod) => mod.name).filter((name) => S15_MODS.includes(name))
if (mods.length !== 5) throw new Error(`expected the five S15 mods at this pin, got ${mods.length}: ${mods.join(', ')}`)

// The authored demand: every literal `on('event')` and `$.ns.method` site the
// scanner can prove. This is the hypothesis the turn tests; the recorder says
// which of these sites actually ran.
const authored = {}
for (const name of mods) {
  const file = join(tree, 'mods', name, 'hooks', 'register.ts')
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`s15-mod-demand: ${file} is missing; is ANYPLUGIN_MODS_TREE the fetched tree root?`)
  }
  const scan = scanModSource(source, { file })
  authored[name] = {
    file: `mods/${name}/hooks/register.ts`,
    events: scan.events,
    calls: scan.calls,
    dynamic: scan.dynamic,
  }
}

// Aggregate the authored `$` demand by namespace.method: how many mods ask for
// it, and where. The report ranks this against what the bridge serves.
const demand = new Map()
for (const name of mods) {
  for (const call of authored[name].calls) {
    const key = `${call.namespace}.${call.method}`
    const row = demand.get(key) ?? { key, mods: new Set(), sites: [] }
    row.mods.add(name)
    row.sites.push(`${authored[name].file}:${call.line}`)
    demand.set(key, row)
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const dataDir = join(outDir, 'data')
mkdirSync(dataDir, { recursive: true })
const traceFile = join(dataDir, 'trace.jsonl')

const commandsChild = {
  id: 'commands',
  name: pathToFileURL(join(harness.harnessDir, 'dsh-commands', 'lib', 'index.js')).href,
}

// One materializer child per mod: same wiring as a real install, a distinct
// plugin name so the kernel trace says which mod a step belongs to, and a
// distinct plugin data directory. The first child keeps the id `hook` because
// the S9 probe derives the root cwd from it.
const children = mods.map((name, index) => {
  const pluginData = join(dataDir, name)
  mkdirSync(pluginData, { recursive: true })
  return {
    id: index === 0 ? 'hook' : `hook-${name}`,
    name: materializerUrl,
    config: {
      pluginRoot: join(tree, 'mods', name),
      pluginData,
      plugin: name,
      mods: [{ entry: 'hooks/register.ts' }],
      hooks: [],
      traceFile,
    },
  }
})

const entry = {
  id: 'anyplugin.s15-mod-demand',
  name: '@deepseek-ai/cordis-plugin-group',
  group: true,
  config: [commandsChild, ...children],
}

const toolCalls = []
const bashTool = {
  name: 'Bash',
  description: 'Run a shell command and return its output.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  execute: async (args) => {
    toolCalls.push(args)
    return 'ran'
  },
}

// The turn: one tool call (PreToolUse/PostToolUse), and the probe always
// delegates a real child agent (SubagentStart/SubagentStop).
const observation = await probeLifecycleWithDsh({
  harnessDir: harness.harnessDir,
  entry,
  expected: [],
  tool: bashTool,
  toolCall: { id: 'call_s15_bash', name: 'Bash', arguments: JSON.stringify({ command: 'true' }) },
  secondAgent: false,
  timeoutMs: 20_000,
})

const trace = readFileSync(traceFile, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line))
const observed = snapshot()

// ---------------------------------------------------------------------------
// Assertions: the instrument must prove it measured the real turn, or the
// report is not evidence.

function fail(message) {
  console.error(`s15-mod-demand: FAIL: ${message}`)
  process.exitCode = 1
}

// A load refusal is recorded by the materializer as a trace warning; keep the
// exact message so the report can print the resolver gap instead of "no
// handler ran".
const loadRefusals = new Map()
for (const line of trace) {
  if (typeof line.warning !== 'string') continue
  const match = /^anyplugin mod ([^/]+)\/hooks\/register\.ts: load refused \((.*)\)$/.exec(line.warning)
  if (match) loadRefusals.set(match[1], match[2])
}

const invocations = observed.invocations
const byMod = new Map(mods.map((name) => [name, []]))
for (const invocation of invocations) {
  if (!byMod.has(invocation.mod)) throw new Error(`invocation from unknown mod ${invocation.mod}`)
  byMod.get(invocation.mod).push(invocation)
}

function chainFor(event) {
  return trace.filter((line) => line.event === event)
}
function invokedIn(event, sourcePrefix) {
  // `error` means the handler *was* invoked and threw; that is a measurement,
  // not an instrument failure. Only `not-called` and a skipped matcher mean the
  // handler never saw the event.
  return chainFor(event).some((line) =>
    (line.trace ?? []).some(
      (step) =>
        step.source.startsWith(sourcePrefix) &&
        step.status !== 'not-called' &&
        step.status !== 'skipped-matcher',
    ),
  )
}

// 1. session.start fires once at load, for the three mods that register it.
const sessionStartInvocations = invocations.filter((invocation) => invocation.kernelEvent === 'session.start')
if (sessionStartInvocations.length !== 3) {
  fail(`expected 3 session.start invocations (agents-md, diff, telemetry), got ${sessionStartInvocations.length}`)
}
for (const name of ['agents-md', 'diff', 'telemetry']) {
  if (byMod.get(name).filter((invocation) => invocation.kernelEvent === 'session.start').length !== 1) {
    fail(`${name} did not receive session.start exactly once`)
  }
}
if (byMod.get('privacy').length !== 0) {
  fail(`privacy ran ${byMod.get('privacy').length} handlers; tool.check is not routed, so it must run none`)
}

// 2. The turn really reached the tool: both classic chains ran, unless
//    sec-default is refused at load. At 2.1.329 upstream added extensionless
//    *file* imports; the D39 resolver fallback now serves them, so the mod
//    seats and the chains run. The conditional keeps a future refusal honest:
//    a refused load is data, and the report names the exact resolver gap; it
//    must not be mistaken for "the chain silently vanished".
if (toolCalls.length !== 1) fail(`expected one Bash call, saw ${toolCalls.length}`)
const classicEvents = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']
for (const event of classicEvents) {
  const expected = !loadRefusals.has('sec-default')
  if (expected) {
    if (chainFor(event).length === 0) fail(`${event} chain never ran`)
    if (!invokedIn(event, 'sec-default/')) fail(`${event} chain did not invoke sec-default's classic.* handler`)
  } else if (chainFor(event).length !== 0) {
    fail(`${event} chain ran although sec-default was refused at load`)
  }
}

// 3. session.start had no session: the host passes `{cwd}` only, and the `$`
//    resolves session.messages to [] rather than throwing.
for (const invocation of sessionStartInvocations) {
  if (invocation.eventKeys.includes('session')) fail(`${invocation.mod} session.start was handed a session`)
  for (const group of invocation.dollars) {
    if (group.sessionId !== null) fail(`${invocation.mod} session.start $ resolved a session id (${group.sessionId})`)
  }
}

// 5. A throwing handler is data (the report names it), not an instrument
//    failure; a typed `$` refusal is likewise data. Count both.
const handlerErrors = invocations.filter((invocation) => invocation.status === 'error')
const refused = observed.dollars.flatMap((group) => group.calls.filter((call) => call.outcome.startsWith('refused:')))

// ---------------------------------------------------------------------------
// Output: a value-free JSON snapshot (for the report's numbers) and a compact
// stdout table (for the PR's output tail).

const report = {
  pin: {
    harness: { version: harness.version, source: harness.source },
    mods: { commit: UPSTREAM_MODS_PIN.commit, version: UPSTREAM_MODS_PIN.version, treeSha256: UPSTREAM_MODS_PIN.treeSha256 },
  },
  tree,
  dataDir,
  toolCalls,
  authored,
  demand: [...demand.values()]
    .map((row) => ({
      key: row.key,
      mods: [...row.mods].sort(),
      modCount: row.mods.size,
      sites: row.sites,
    }))
    .sort((a, b) => b.modCount - a.modCount || a.key.localeCompare(b.key)),
  trace,
  observed,
}
writeFileSync(join(outDir, 'observed.json'), `${JSON.stringify(report, null, 2)}\n`)

function callLine(call) {
  const args = call.args.length === 0 ? '' : `(${call.args.join(', ')})`
  return `$.${call.namespace}.${call.method}${args} → ${call.outcome}`
}

console.log(`s15-mod-demand: five mods × one real headless turn (harness ${harness.version}, mods ${UPSTREAM_MODS_PIN.commit.slice(0, 12)})`)
console.log(`tree:     ${tree}`)
console.log(`commands: ${entry.id} (${mods.length} materializer children)`)
console.log(
  `tool:     ${toolCalls.length} Bash call; child agent: started; SubagentStart chain: ${
    chainFor('SubagentStart').length > 0 ? 'observed' : 'none (no handler registered)'
  }`,
)
const sessionStartMods = new Map()
for (const row of invocations.filter((invocation) => invocation.authoredEvent === 'session.start')) {
  sessionStartMods.set(row.mod, (sessionStartMods.get(row.mod) ?? 0) + 1)
}
console.log(`session.start: ${[...sessionStartMods.values()].reduce((sum, count) => sum + count, 0)} handler invocation(s) — ${[...sessionStartMods].map(([mod, count]) => `${mod} ×${count}`).join(', ')}; load-time, no session in $`)
console.log('')
console.log('per mod / handler:')
for (const name of mods) {
  const rows = byMod.get(name)
  if (rows.length === 0) {
    const refusal = loadRefusals.get(name)
    console.log(
      refusal === undefined
        ? `  ${name.padEnd(12)} — no handler ran (registrations are not routed by D32)`
        : `  ${name.padEnd(12)} — load refused: ${refusal}`,
    )
    continue
  }
  const counts = new Map()
  for (const row of rows) {
    const key = `${row.authoredEvent} → ${row.kernelEvent}${row.modEvent === null ? '' : ` (${row.modEvent})`}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of counts) console.log(`  ${name.padEnd(12)} ${key} × ${count}`)
  for (const row of rows) {
    const calls = row.dollars.flatMap((group) => group.calls)
    const status = row.status === 'error' ? `error: ${row.error?.message}` : row.status
    if (calls.length > 0) {
      console.log(`    ${row.authoredEvent} [${status}] ${calls.map(callLine).join('; ')}`)
    } else {
      console.log(`    ${row.authoredEvent} [${status}] (no $ calls)`)
    }
  }
}
console.log('')
console.log('chains observed (kernel event → sources that were invoked):')
for (const line of trace) {
  if (line.event === undefined) continue
  const ran = (line.trace ?? [])
    .filter((step) => step.status !== 'not-called' && step.status !== 'skipped-matcher')
    .map((step) => `${step.source} [${step.status}]`)
  if (ran.length === 0) continue
  console.log(`  ${line.event}: ${ran.join(', ')}`)
}
console.log('')
console.log(`trace: ${trace.length} lines; invocations: ${invocations.length}; $ groups: ${observed.dollars.length}; $ calls: ${observed.dollars.reduce((sum, group) => sum + group.calls.length, 0)}`)
console.log(`handler errors: ${handlerErrors.length}${handlerErrors.length === 0 ? '' : ` (${[...new Set(handlerErrors.map((row) => `${row.mod}: ${row.error?.name}: ${row.error?.message}`))].join('; ')})`}`)
console.log(`$ refusals on the executed path: ${refused.length}`)
console.log('')
console.log('authored $ demand (scanned from all five mods; status is the bridge surface):')
// The bridge surface, member for member (createModBridge in
// packages/dsh-anyplugin-mod-host/src/bridge.ts). A name outside the served
// and refused tables is absent, not refused: it throws "not a function"
// rather than a typed ModBridgeError. Keep these tables in sync with the
// bridge; the point is that a new namespace cannot be reported as served by
// accident.
const BRIDGE_SERVES = {
  session: ['id', 'cwd', 'messages', 'usage'],
  clock: ['now', 'after', 'every'],
  process: [],
  fs: ['stat', 'list', 'read'],
  store: ['get', 'set', 'delete', 'keys'],
  settings: ['read'],
  env: ['get'],
  // #75 serves the six headless ui members; ask answers through a person and
  // refuses with the sink's typed code.
  ui: ['invalidate', 'status', 'log', 'open', 'close', 'resolve', 'ask'],
  command: ['register'],
  telemetry: ['mark', 'log'],
  // #119 serves the read-only git members; the other four are typed refusals.
  vcs: ['detect', 'diff'],
}
const BRIDGE_REFUSES = new Map([
  ['process.run', 'ERR_MOD_HOST_EXEC_UNSUPPORTED'],
  ['settings.read', 'ERR_MOD_HOST_SETTINGS_SOURCE'],
  ['ui.ask', 'ERR_MOD_HOST_UI_UNSUPPORTED'],
  ['vcs.isolate', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
  ['vcs.list', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
  ['vcs.status', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
  ['vcs.release', 'ERR_MOD_HOST_VCS_UNSUPPORTED'],
])
const surfaceStatus = (key) => {
  const [namespace, method] = key.split('.')
  const refusal = BRIDGE_REFUSES.get(key)
  if (refusal !== undefined) return `refused:${refusal}`
  const members = BRIDGE_SERVES[namespace]
  if (members === undefined) return 'missing'
  return members.includes(method) ? 'served' : 'missing'
}
const tally = { served: 0, refused: 0, missing: 0 }
for (const row of [...demand.values()].sort((a, b) => b.mods.size - a.mods.size || a.key.localeCompare(b.key))) {
  const status = surfaceStatus(row.key)
  if (status === 'served') tally.served += 1
  else if (status === 'missing') tally.missing += 1
  else tally.refused += 1
  console.log(`  ${String(row.mods.size)}/5 ${row.key.padEnd(22)} ${status.padEnd(38)} ${[...row.mods].join(', ')}`)
}
console.log('')
console.log(
  `authored $ partition: ${tally.served} served + ${tally.refused} typed refusals + ${tally.missing} absent = ${demand.size} pairs`,
)
if (process.exitCode === 1) {
  console.log('')
  console.log('result: FAILED (see s15-mod-demand: FAIL lines above)')
} else {
  console.log('')
  const refusedList = [...loadRefusals.keys()]
  console.log(
    `result: OK (turn assertions passed; handler errors are recorded above${
      refusedList.length === 0 ? '' : `; refused at load: ${refusedList.join(', ')}`
    })`,
  )
}
