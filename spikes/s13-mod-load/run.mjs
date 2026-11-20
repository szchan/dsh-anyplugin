#!/usr/bin/env node
// S13: can an authored Claude Code mod be loaded unmodified and run?
//
// The `diff` mod is pinned by commit and sha256. Nothing in this spike edits,
// transpiles, bundles or rewrites it (AGENTS.md §3.7): source bytes are read,
// `.ts` goes through Node's own type stripping (positions preserved), and the
// 21 `.tsx` modules are replaced by name-preserving stubs *for the experiment
// only* — a scaffold, never a host design.
//
// Four questions, each answered by assertions:
//
//   Q1 loading  — what does stock Node ESM do with the graph, and what does it
//                 need beyond type stripping (specifier rules, `.tsx`)?
//   Q2 realm    — same-thread dynamic import vs `node:vm` SourceTextModule:
//                 which environment can host a mod, and does anything have to
//                 be provided as `$` before the module's own handlers run?
//   Q3 register — does `register(on)` reach the same event list the static
//                 scanner reports?
//   Q4 fire     — synthesise one event and record every `$` call, its result
//                 and what a host bridge has to implement.
//
// Run:
//   npm run spike:s13
//   # or: node --experimental-vm-modules spikes/s13-mod-load/run.mjs
//
// The pinned tree and file are fetched once into `out/cache/` (gitignored) and
// reused; pass `--refresh` to refetch. A run that records zero checks exits 1
// (the rule stated at docs/ARCHITECTURE.md:1332; D19 is the waterfalls
// decision), and so does any failed assertion.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const CACHE = join(OUT, 'cache')
const TREE = join(CACHE, 'tree')
const HOOKS_REL = 'mods/diff/hooks'
const HOOKS = join(TREE, HOOKS_REL)
const ENTRY = join(HOOKS, 'register.ts')
const RAW = join(CACHE, 'register.ts')
const SHIM = join(OUT, 'shim', 'claude-code.mjs')
const REPORT = join(OUT, 'report.json')
const SELF = fileURLToPath(import.meta.url)
const FLAGS = new Set(process.argv.slice(2))

const PIN = {
  claudeCode: '2.1.322',
  repo: 'https://github.com/anthropics/claude-code.git',
  commit: '6e1e44f6433bfa17d198e932bff53373aa229eea',
  path: `${HOOKS_REL}/register.ts`,
  bytes: 33_891,
  sha256: 'cce8adf7b3218f33347707ffbfb25ff3294c184d440dfb49fa540656146debab',
  rawUrl:
    'https://raw.githubusercontent.com/anthropics/claude-code/' +
    '6e1e44f6433bfa17d198e932bff53373aa229eea/mods/diff/hooks/register.ts',
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const checks = []
const negatives = []

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) })
  if (!ok) {
    console.log(`FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
  return Boolean(ok)
}

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  return check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(cmd, argv, cwd = REPO) {
  const result = spawnSync(cmd, argv, { cwd, encoding: 'utf8', timeout: 180_000 })
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${argv.join(' ')} failed (${result.status}): ` +
        `${(result.stderr || result.stdout || '').trim()}`,
    )
  }
  return result.stdout
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const read = (file) => readFileSync(file, 'utf8')
const rel = (file) => relative(HOOKS, file)
const strip = (source) => stripTypeScriptTypes(source, { mode: 'strip' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Fetch: the pinned artifact, asserted before anything loads it
// ---------------------------------------------------------------------------

function cachedTreeIsComplete() {
  if (!existsSync(ENTRY) || !existsSync(RAW)) return false
  if (sha256(ENTRY) !== PIN.sha256 || sha256(RAW) !== PIN.sha256) return false
  if (statSync(ENTRY).size !== PIN.bytes) return false
  const files = walk(HOOKS)
  return (
    files.filter((f) => f.endsWith('.ts')).length === 579 &&
    files.filter((f) => f.endsWith('.tsx')).length === 21
  )
}

function fetchPinnedMod() {
  if (cachedTreeIsComplete() && !FLAGS.has('--refresh')) return 'cache'
  if (!CACHE.startsWith(OUT)) throw new Error(`refusing to clear ${CACHE}`)
  rmSync(CACHE, { recursive: true, force: true })
  mkdirSync(CACHE, { recursive: true })

  // The exact artifact, over plain HTTPS.
  run('curl', ['-fsSL', '--retry', '3', PIN.rawUrl, '-o', RAW])
  if (sha256(RAW) !== PIN.sha256 || statSync(RAW).size !== PIN.bytes) {
    throw new Error(`curl fetched ${PIN.rawUrl} but the sha256/size do not match the pin`)
  }

  // Its siblings, from the pinned commit only. A sparse, depth-1 fetch keeps
  // this to the 601 blobs under mods/diff/hooks.
  mkdirSync(TREE, { recursive: true })
  run('git', ['init', '-q'], TREE)
  run('git', ['remote', 'add', 'origin', PIN.repo], TREE)
  run('git', ['sparse-checkout', 'init', '--cone'], TREE)
  run('git', ['sparse-checkout', 'set', HOOKS_REL], TREE)
  run('git', ['-c', 'advice.detachedHead=false', 'fetch', '-q', '--depth', '1', 'origin', PIN.commit], TREE)
  run('git', ['checkout', '-q', 'FETCH_HEAD'], TREE)
  if (!cachedTreeIsComplete()) throw new Error('fetched tree is not the pinned one')
  return 'fetch'
}

// ---------------------------------------------------------------------------
// The loader rules the graph needs (Q1)
//
// None of these are stock Node ESM: the mod is written for the Claude bundler,
// where `./x` means `./x/index.ts`, `./x.js` means x.ts, `./x.jsx` means x.tsx,
// and `.` is the current module's directory (a self-import every helper
// `index.ts` uses for `export * as default from '.'`).
// ---------------------------------------------------------------------------

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function createResolver() {
  const stats = {
    shimRequests: 0,
    builtinRequests: [],
    unresolved: [],
    resolved: 0,
    // The three behaviors the pinned graph exercises. Anything else is not a
    // host rule until an authored mod needs it; there are no extra fallbacks.
    resolution: { directoryIndex: 0, jsToTs: 0, jsxToTsx: 0 },
  }
  function resolveSpecifier(specifier, parentFile) {
    if (specifier === 'claude-code') {
      stats.shimRequests++
      return SHIM
    }
    if (specifier.startsWith('node:') || specifier.startsWith('file:') || specifier.startsWith('data:')) {
      stats.builtinRequests.push({ specifier, from: rel(parentFile) })
      throw new Error(`S13_REFUSED: a mod realm has no ${specifier} (from ${rel(parentFile)})`)
    }
    if (!specifier.startsWith('.')) {
      stats.unresolved.push({ specifier, from: rel(parentFile), why: 'bare specifier' })
      throw new Error(`S13_UNRESOLVED: bare specifier "${specifier}" from ${rel(parentFile)}`)
    }
    const base = resolve(dirname(parentFile), specifier)
    let file = null
    let behavior = null
    if (specifier.endsWith('.js')) {
      const candidate = base.slice(0, -3) + '.ts'
      if (isFile(candidate)) {
        file = candidate
        behavior = 'jsToTs'
      }
    } else if (specifier.endsWith('.jsx')) {
      const candidate = base.slice(0, -4) + '.tsx'
      if (isFile(candidate)) {
        file = candidate
        behavior = 'jsxToTsx'
      }
    } else if (extname(specifier) === '') {
      // Extensionless file and '.' self-import: every hit in this graph is a
      // directory index. No exact-file fallback is offered.
      const candidate = join(base, 'index.ts')
      if (isFile(candidate)) {
        file = candidate
        behavior = 'directoryIndex'
      }
    }
    if (file === null) {
      stats.unresolved.push({ specifier, from: rel(parentFile), why: 'no exercised host rule matched' })
      throw new Error(`S13_UNRESOLVED: "${specifier}" from ${rel(parentFile)}`)
    }
    stats.resolution[behavior]++
    stats.resolved++
    return file
  }
  return { resolveSpecifier, stats }
}

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm

function exportedNames(file) {
  return [...read(file).matchAll(EXPORT_RE)].map((match) => match[1])
}

/** A name-preserving stub for one `.tsx` leaf. No mod source is changed. */
function tsxStub(file) {
  const names = exportedNames(file)
  if (names.length === 0) throw new Error(`no exported name to stub in ${rel(file)}`)
  return {
    names,
    source: names.map((name) => `export const ${name} = undefined`).join('\n') + '\n',
  }
}

// ---------------------------------------------------------------------------
// Same-thread realm: dynamic import() + module.registerHooks (Q2)
// ---------------------------------------------------------------------------

function installSameThreadHooks({ stubTsx }) {
  const resolver = createResolver()
  const stats = { ...resolver.stats, bareRequests: [], loadedTs: new Set(), stubbedTsx: new Set(), other: new Set() }
  const handle = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'claude-code') {
        stats.shimRequests++
        return { url: pathToFileURL(SHIM).href, shortCircuit: true }
      }
      if (specifier.startsWith('file:')) return nextResolve(specifier, context)
      if (!specifier.startsWith('.')) {
        stats.bareRequests.push(specifier)
        throw new Error(`S13_REFUSED: a mod realm has no bare specifier "${specifier}"`)
      }
      const file = resolver.resolveSpecifier(specifier, fileURLToPath(context.parentURL))
      return { url: pathToFileURL(file).href, shortCircuit: true }
    },
    load(url, context, nextLoad) {
      const file = fileURLToPath(url)
      if (file.endsWith('.tsx')) {
        if (!stubTsx) return nextLoad(url, context)
        const stub = tsxStub(file)
        stats.stubbedTsx.add(rel(file))
        return { format: 'module', source: stub.source, shortCircuit: true }
      }
      if (file.endsWith('.ts')) {
        stats.loadedTs.add(rel(file))
        return { format: 'module', source: strip(read(file)), shortCircuit: true }
      }
      stats.other.add(rel(file))
      return nextLoad(url, context)
    },
  })
  return { handle, stats }
}

// ---------------------------------------------------------------------------
// vm realm: SourceTextModule in a per-mod context (Q2)
// ---------------------------------------------------------------------------

function createVmRealm({ context: givenContext } = {}) {
  const resolver = createResolver()
  const context = givenContext ?? vm.createContext({ console })
  const stats = { ...resolver.stats, createdTs: new Set(), stubbedTsx: new Set() }
  const modules = new Map()

  function create(file) {
    if (modules.has(file)) return modules.get(file)
    let module
    if (file.endsWith('.tsx')) {
      const stub = tsxStub(file)
      stats.stubbedTsx.add(rel(file))
      module = new vm.SyntheticModule(
        stub.names,
        function initialize() {
          for (const name of stub.names) this.setExport(name, undefined)
        },
        { identifier: pathToFileURL(file).href, context },
      )
    } else if (file.endsWith('.ts')) {
      stats.createdTs.add(rel(file))
      // Explicit, position-preserving strip: the same transform Node's own
      // .ts support applies, but named and observable here.
      module = new vm.SourceTextModule(strip(read(file)), {
        identifier: pathToFileURL(file).href,
        context,
      })
    } else {
      throw new Error(`S13_UNEXPECTED: ${rel(file)} is not .ts/.tsx`)
    }
    modules.set(file, module)
    return module
  }

  const linker = async (specifier, referencing) => {
    const parent = fileURLToPath(referencing.identifier)
    return create(resolver.resolveSpecifier(specifier, parent))
  }

  return {
    context,
    stats,
    async evaluate(entryFile) {
      const entry = create(entryFile)
      // One link pass over the finished graph; linking children from inside
      // the linker fails with ERR_VM_MODULE_LINK_FAILURE.
      await entry.link(linker)
      await entry.evaluate()
      return entry.namespace
    },
  }
}

// ---------------------------------------------------------------------------
// Registration and one synthesised event (Q3, Q4)
// ---------------------------------------------------------------------------

const SESSION_STARTED_AT = 1_700_000_000_000

function describeArg(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : typeof v))
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    if (typeof value.name === 'string') return { name: value.name, keys }
    return { keys }
  }
  return value
}

function makeDollar(calls, { usage = 'record' } = {}) {
  const record = (method, args) => {
    calls.push({ method, args: args.map(describeArg) })
    if (method === 'session.usage') {
      return Promise.resolve(usage === 'undefined' ? undefined : { startedAt: SESSION_STARTED_AT })
    }
    if (method === 'clock.now') return Promise.resolve(SESSION_STARTED_AT)
    if (method === 'session.messages') return Promise.resolve([])
    return Promise.resolve(undefined)
  }
  const namespace = (name) =>
    new Proxy(
      {},
      {
        get: (_target, method) => (...args) => record(`${name}.${String(method)}`, args),
      },
    )
  return new Proxy({}, { get: (_target, name) => namespace(String(name)) })
}

async function fireSessionStart(handler, { usage = 'record' } = {}) {
  const calls = []
  const dollar = makeDollar(calls, { usage })
  const event = { cwd: '/tmp/s13-fixture', hook_event_name: 'SessionStart' }
  const nextResult = { kind: 'continued' }
  let nextArg = null
  let result = null
  let fireError = null
  if (typeof handler === 'function') {
    try {
      result = await handler(dollar, event, next)
      await sleep(25)
    } catch (error) {
      fireError = { name: error?.name, message: error?.message }
    }
  }

  function next(value) {
    nextArg = value
    return nextResult
  }

  return {
    handlerFound: typeof handler === 'function',
    calls,
    result,
    nextResult,
    nextArg,
    nextSameEvent: nextArg === event,
    fireError,
  }
}

async function registerAndFire(namespace) {
  const events = []
  const on = (...args) => {
    events.push(args)
  }
  let registerError = null
  try {
    namespace.register(on, {})
  } catch (error) {
    registerError = { name: error?.name, message: error?.message }
  }

  const names = events.map((args) => args[0])
  const unique = [...new Set(names)]
  const matchers = events
    .filter((args) => args.length === 3)
    .map((args) => (args[1] && typeof args[1] === 'object' ? Object.keys(args[1]).sort() : []))

  const sessionStart = events.find((args) => args[0] === 'session.start')
  const handler = sessionStart?.at(-1)
  const primary = await fireSessionStart(handler, { usage: 'record' })
  // The authored handler is `startedAt() ?? engine.now()`: if usage() has no
  // timestamp, the clock fallback fires too, so the call count is conditional.
  const noUsage = await fireSessionStart(handler, { usage: 'undefined' })

  return {
    events,
    names,
    unique,
    matchers,
    registerArity: namespace.register.length,
    registerError,
    ...primary,
    noUsageCalls: noUsage.calls,
    noUsageFireError: noUsage.fireError,
  }
}

const q3ExpectedNames = [
  'session.start',
  'ui.render',
  'ui.render',
  'command.run',
  'ui.close',
  'ui.focus',
  'ui.scroll',
  'command.run',
  'tool.call',
  'prompt.submit',
]
const q3ExpectedLines = [938, 982, 1003, 1057, 1116, 1158, 1180, 1201, 1276, 1294]

// ---------------------------------------------------------------------------
// Child probes: run the parts that must be isolated in a fresh process
// ---------------------------------------------------------------------------

async function childProbe(mode) {
  if (!existsSync(ENTRY)) {
    console.log(JSON.stringify({ ok: false, internal: `cache missing at ${ENTRY}` }))
    return process.exit(2)
  }
  const target =
    mode === 'js-specifier'
      ? join(OUT, 'probes/js/entry.ts')
      : mode === 'dot-self'
        ? join(OUT, 'probes/dot/res/index.ts')
        : mode === 'tsx-strippable'
          ? join(HOOKS, 'views/body/list-block-of.tsx')
          : ENTRY
  const load = () =>
    import(pathToFileURL(target).href).then(
      (namespace) => ({ ok: true, register: typeof namespace.register }),
      (error) => ({ ok: false, name: error?.name, code: error?.code, message: error?.message }),
    )
  let handle = null
  if (mode === 'resolver') {
    const resolver = createResolver()
    handle = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (!specifier.startsWith('.')) return nextResolve(specifier, context)
        const file = resolver.resolveSpecifier(specifier, fileURLToPath(context.parentURL))
        return { url: pathToFileURL(file).href, shortCircuit: true }
      },
      load(url, context, nextLoad) {
        const file = fileURLToPath(url)
        if (file.endsWith('.ts')) return { format: 'module', source: strip(read(file)), shortCircuit: true }
        return nextLoad(url, context)
      },
    })
  }
  const result = await load()
  handle?.deregister()
  console.log(JSON.stringify(result))
  process.exit(0)
}

if (FLAGS.has('--probe=plain')) await childProbe('plain')
if (FLAGS.has('--probe=resolver')) await childProbe('resolver')
if (FLAGS.has('--probe=js-specifier')) await childProbe('js-specifier')
if (FLAGS.has('--probe=dot-self')) await childProbe('dot-self')
if (FLAGS.has('--probe=tsx-strippable')) await childProbe('tsx-strippable')
if ([...FLAGS].some((flag) => flag.startsWith('--probe='))) {
  console.error(`S13: unknown probe ${[...FLAGS].find((flag) => flag.startsWith('--probe='))}`)
  process.exit(2)
}

// `node -e` without the flag: the vm route needs an explicit opt-in.
function probeVmFlag() {
  const result = spawnSync(
    process.execPath,
    ['-e', 'console.log(typeof require("node:vm").SourceTextModule)'],
    { encoding: 'utf8', timeout: 20_000 },
  )
  return { status: result.status, value: result.stdout.trim(), stderr: result.stderr.trim() }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(dirname(SHIM), { recursive: true })
  if (!existsSync(SHIM)) writeFileSync(SHIM, 'export const S13_SHIM = true\n')

  // Stock-Node probes for the two specifier rules the graph needs. These
  // fixtures are ours, not the mod's: they show what Node does with the
  // authored shapes when no host loader is present.
  const jsProbe = join(OUT, 'probes/js')
  mkdirSync(jsProbe, { recursive: true })
  writeFileSync(join(jsProbe, 'helper.ts'), 'export const value = 1\n')
  writeFileSync(join(jsProbe, 'entry.ts'), "export { value } from './helper.js'\n")
  const dotProbe = join(OUT, 'probes/dot/res')
  mkdirSync(dotProbe, { recursive: true })
  writeFileSync(join(dotProbe, 'index.ts'), "export * as default from '.'\n")
  const cacheState = fetchPinnedMod()
  console.log(`S13: pinned mod ${cacheState === 'cache' ? 'reused from' : 'fetched into'} ${CACHE}`)

  // ---- Q1: the artifact and the transform -------------------------------
  equal('q1.artifact.sha256', sha256(RAW), PIN.sha256)
  equal('q1.artifact.bytes', statSync(RAW).size, PIN.bytes)
  equal('q1.tree.sha256', sha256(ENTRY), PIN.sha256)
  equal('q1.tree.bytes', statSync(ENTRY).size, PIN.bytes)

  const files = walk(HOOKS)
  const tsFiles = files.filter((file) => file.endsWith('.ts'))
  const tsxFiles = files.filter((file) => file.endsWith('.tsx'))
  equal('q1.tree.ts-count', tsFiles.length, 579)
  equal('q1.tree.tsx-count', tsxFiles.length, 21)

  const authored = read(ENTRY)
  const stripped = strip(authored)
  equal('q1.strip.bytes-preserved', Buffer.byteLength(stripped), PIN.bytes) // same UTF-8 length here
  equal('q1.strip.lines-preserved', stripped.split('\n').length, authored.split('\n').length)
  check(
    'q1.strip.session-start-line-preserved',
    stripped.split('\n').findIndex((line) => line.includes("on('session.start'")) + 1 === 938,
  )
  check('q1.strip.claude-code-import-erased', !stripped.includes("from 'claude-code'"))
  check('q1.strip.no-typescript-left', !stripped.includes('import type'))

  const stripFailures = []
  for (const file of tsFiles) {
    try {
      strip(read(file))
    } catch (error) {
      stripFailures.push({ file: rel(file), code: error?.code, message: error?.message })
    }
  }
  equal('q1.strip.all-ts', stripFailures, [])

  // Every `.tsx` module, both modes. 20 of 21 refuse; one JSX-free module
  // strips, but that does not make the extension loadable (probe below).
  const tsxResults = tsxFiles.map((file) => {
    const result = { file: rel(file) }
    for (const mode of ['strip', 'transform']) {
      try {
        stripTypeScriptTypes(read(file), { mode })
        result[mode] = { ok: true }
      } catch (error) {
        result[mode] = { ok: false, code: error?.code, message: error?.message }
      }
    }
    return result
  })
  const tsxRefused = tsxResults.filter((result) => result.strip.ok === false)
  const tsxStrippable = tsxResults.filter((result) => result.strip.ok === true)
  const tsxIdent = tsxRefused.filter((result) => /Expected '>', got 'ident'/.test(result.strip.message ?? ''))
  const tsxComma = tsxRefused.filter((result) => /Expected ',', got '\.'/.test(result.strip.message ?? ''))
  negatives.push({
    probe: 'stripTypeScriptTypes(every .tsx)',
    total: tsxResults.length,
    refused: tsxRefused.length,
    strippable: tsxStrippable.map((result) => result.file),
    results: tsxResults,
  })
  equal('q1.tsx.strip-refused-count', tsxRefused.length, 20)
  equal('q1.tsx.strippable', tsxStrippable.map((result) => result.file), ['views/body/list-block-of.tsx'])
  equal('q1.tsx.strip-error-ident', tsxIdent.length, 19)
  equal('q1.tsx.strip-error-comma', tsxComma.length, 1)
  check(
    'q1.tsx.transform-agrees',
    tsxResults.every(
      (result) =>
        result.transform.ok === result.strip.ok &&
        result.transform.message === result.strip.message,
    ),
    JSON.stringify(tsxResults.filter((result) => result.transform.ok !== result.strip.ok)),
  )

  // Positive loader-rule checks against the real graph.
  const ruleResolver = createResolver()
  equal(
    'q1.rule.extensionless-directory',
    rel(ruleResolver.resolveSpecifier('./ask', ENTRY)),
    'ask/index.ts',
  )
  equal(
    'q1.rule.js-specifier-to-ts',
    rel(ruleResolver.resolveSpecifier('./array-of.js', join(HOOKS, 'array-of/index.ts'))),
    'array-of/array-of.ts',
  )
  equal(
    'q1.rule.dot-self-import',
    rel(ruleResolver.resolveSpecifier('.', join(HOOKS, 'ask/index.ts'))),
    'ask/index.ts',
  )
  equal(
    'q1.rule.jsx-specifier-to-tsx',
    rel(ruleResolver.resolveSpecifier('./detail-view.jsx', join(HOOKS, 'views/detail/index.ts'))),
    'views/detail/detail-view.tsx',
  )
  equal(
    'q1.rule.exercised-behaviors',
    Object.entries(ruleResolver.stats.resolution)
      .filter(([, count]) => count > 0)
      .map(([behavior]) => behavior),
    ['directoryIndex', 'jsToTs', 'jsxToTsx'],
  )

  // Negative: stock dynamic import, no hooks.
  const plain = spawnSync(process.execPath, [SELF, '--probe=plain'], { encoding: 'utf8', timeout: 60_000 })
  const plainResult = JSON.parse(plain.stdout.trim().split('\n').at(-1) || '{}')
  negatives.push({ probe: 'plain import()', ...plainResult })
  check(
    'q1.plain-import.refused',
    plainResult.ok === false && plainResult.code === 'ERR_UNSUPPORTED_DIR_IMPORT',
    JSON.stringify(plainResult),
  )
  check(
    'q1.plain-import.states-directory',
    /Directory import .*\/ask.* is not supported/.test(plainResult.message ?? ''),
    plainResult.message,
  )

  // Negative: `./helper.js` does not fall back to helper.ts under stock Node.
  const jsSpecifier = spawnSync(process.execPath, [SELF, '--probe=js-specifier'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const jsSpecifierResult = JSON.parse(jsSpecifier.stdout.trim().split('\n').at(-1) || '{}')
  negatives.push({ probe: 'stock ./x.js with only x.ts', ...jsSpecifierResult })
  check(
    'q1.stock.js-specifier.refused',
    jsSpecifierResult.ok === false &&
      jsSpecifierResult.code === 'ERR_MODULE_NOT_FOUND' &&
      /helper\.js/.test(jsSpecifierResult.message ?? ''),
    JSON.stringify(jsSpecifierResult),
  )

  // Negative: `export * as default from '.'` is a directory import to Node.
  const dotSelf = spawnSync(process.execPath, [SELF, '--probe=dot-self'], { encoding: 'utf8', timeout: 60_000 })
  const dotSelfResult = JSON.parse(dotSelf.stdout.trim().split('\n').at(-1) || '{}')
  negatives.push({ probe: "stock from '.'", ...dotSelfResult })
  check(
    'q1.stock.dot-self.refused',
    dotSelfResult.ok === false &&
      dotSelfResult.code === 'ERR_UNSUPPORTED_DIR_IMPORT' &&
      /Directory import '.+\/res\/'/.test(dotSelfResult.message ?? ''),
    JSON.stringify(dotSelfResult),
  )

  // Negative: the resolver alone still cannot load a `.tsx` leaf.
  const resolverOnly = spawnSync(process.execPath, [SELF, '--probe=resolver'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const resolverResult = JSON.parse(resolverOnly.stdout.trim().split('\n').at(-1) || '{}')
  negatives.push({ probe: 'resolver + stock .tsx load', ...resolverResult })
  check(
    'q1.resolver-only.tsx-refused',
    resolverResult.ok === false && resolverResult.code === 'ERR_UNKNOWN_FILE_EXTENSION',
    JSON.stringify(resolverResult),
  )
  check(
    'q1.resolver-only.tsx-names-file',
    /\.tsx/.test(resolverResult.message ?? ''),
    resolverResult.message,
  )

  // Negative: the one `.tsx` that strips is still not loadable under stock
  // Node, because the extension itself is refused before source is parsed.
  const tsxLoad = spawnSync(process.execPath, [SELF, '--probe=tsx-strippable'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const tsxLoadResult = JSON.parse(tsxLoad.stdout.trim().split('\n').at(-1) || '{}')
  negatives.push({ probe: 'stock .tsx extension (strippable file)', ...tsxLoadResult })
  check(
    'q1.stock.tsx-extension.refused',
    tsxLoadResult.ok === false && tsxLoadResult.code === 'ERR_UNKNOWN_FILE_EXTENSION',
    JSON.stringify(tsxLoadResult),
  )
  check(
    'q1.stock.tsx-extension.names-file',
    /list-block-of\.tsx/.test(tsxLoadResult.message ?? ''),
    tsxLoadResult.message,
  )

  // ---- Q2 + Q3 + Q4: same-thread realm ----------------------------------
  const sameThreadInstalled = installSameThreadHooks({ stubTsx: true })
  const globalDollarBefore = typeof globalThis.$
  const hadDollar = Object.prototype.hasOwnProperty.call(globalThis, '$')
  let globalDollarReads = 0
  if (!hadDollar) {
    // A module-level `$` read must throw, exactly as it would with no binding.
    // The getter also counts reads, so "0 reads" is measured, not assumed.
    Object.defineProperty(globalThis, '$', {
      configurable: true,
      get() {
        globalDollarReads++
        throw new ReferenceError('S13: $ is not a module global')
      },
    })
  }
  let sameThread = null
  let sameThreadError = null
  try {
    const namespace = await import(pathToFileURL(ENTRY).href)
    sameThread = await registerAndFire(namespace)
  } catch (error) {
    sameThreadError = { name: error?.name, code: error?.code, message: error?.message }
  } finally {
    sameThreadInstalled.handle.deregister()
    if (!hadDollar) delete globalThis.$
  }
  check('q2.same-thread.loaded', sameThread !== null, JSON.stringify(sameThreadError))
  const st = sameThreadInstalled.stats
  equal('q2.same-thread.ts-module-count', st.loadedTs.size, 505)
  equal('q2.same-thread.tsx-stubs', st.stubbedTsx.size, 21)
  equal('q2.same-thread.claude-code-requests', st.shimRequests, 0)
  equal('q2.same-thread.bare-requests', st.bareRequests, [])
  check('q2.same-thread.realm-has-node', typeof process === 'object')
  equal('q2.same-thread.no-dollar-global', globalDollarBefore, 'undefined')
  equal('q2.same-thread.dollar-reads', globalDollarReads, 0)
  equal('q2.same-thread.resolution', st.resolution, {
    directoryIndex: 737,
    jsToTs: 246,
    jsxToTsx: 21,
  })

  // ---- Q2 + Q3 + Q4: vm realm ------------------------------------------
  const vmFlag = probeVmFlag()
  negatives.push({ probe: 'node without --experimental-vm-modules', ...vmFlag })
  check('q2.vm.flag-required', vmFlag.value === 'undefined', JSON.stringify(vmFlag))
  check('q2.vm.available-with-flag', typeof vm.SourceTextModule === 'function')
  let vmRealm = null
  let vmNamespace = null
  let vmError = null
  let vmRun = null
  if (typeof vm.SourceTextModule === 'function') {
    try {
      vmRealm = createVmRealm()
      vmNamespace = await vmRealm.evaluate(ENTRY)
      vmRun = await registerAndFire(vmNamespace)
    } catch (error) {
      vmError = { name: error?.name, message: error?.message }
    }
  }
  check('q2.vm.loaded', vmRun !== null, JSON.stringify(vmError))
  const vmStats = vmRealm?.stats
  if (vmStats) {
    equal('q2.vm.ts-module-count', vmStats.createdTs.size, 505)
    equal('q2.vm.tsx-stubs', vmStats.stubbedTsx.size, 21)
    equal('q2.vm.claude-code-requests', vmStats.shimRequests, 0)
    equal(
      'q2.realm.module-count-parity',
      [st.loadedTs.size, st.stubbedTsx.size],
      [vmStats.createdTs.size, vmStats.stubbedTsx.size],
    )
    equal(
      'q2.vm.realm-isolated',
      vm.runInContext('typeof process + "|" + typeof URL + "|" + typeof $', vmRealm.context),
      'undefined|undefined|undefined',
    )
    check(
      'q2.vm.dollar-read-throws',
      (() => {
        try {
          vm.runInContext('$', vmRealm.context)
          return false
        } catch (error) {
          return error?.name === 'ReferenceError'
        }
      })(),
    )
    equal('q2.vm.resolution', vmStats.resolution, {
      directoryIndex: 737,
      jsToTs: 246,
      jsxToTsx: 21,
    })
  } else {
    check('q2.vm.ts-module-count', false, 'realm did not load')
    check('q2.vm.tsx-stubs', false, 'realm did not load')
    check('q2.vm.claude-code-requests', false, 'realm did not load')
    check('q2.realm.module-count-parity', false, 'realm did not load')
    check('q2.vm.realm-isolated', false, 'realm did not load')
    check('q2.vm.dollar-read-throws', false, 'realm did not load')
    check('q2.vm.resolution', false, 'realm did not load')
  }

  // ---- Q3: registration versus the scanner ------------------------------
  const { scanModSource } = await import(
    pathToFileURL(join(REPO, 'packages/dsh-anyplugin-mod-scan/src/index.ts')).href
  )
  const scan = scanModSource(authored, { file: PIN.path })
  equal('q3.scanner.events', scan.events.length, 10)
  equal('q3.scanner.unique-events', new Set(scan.events.map((event) => event.name)).size, 8)
  equal('q3.scanner.calls', scan.calls.length, 23)
  equal('q3.scanner.dynamic', scan.dynamic.length, 0)
  equal('q3.scanner.lines', scan.events.map((event) => event.line), q3ExpectedLines)
  equal('q3.scanner.match-count', scan.events.filter((event) => event.matcher !== undefined).length, 8)

  equal('q3.same-thread.register-sites', sameThread?.names ?? [], q3ExpectedNames)
  equal('q3.same-thread.unique-events', sameThread?.unique ?? [], [...new Set(q3ExpectedNames)])
  equal('q3.same-thread.register-arity', sameThread?.registerArity, 1)
  check(
    'q3.same-thread.register-no-error',
    sameThread?.registerError === null,
    JSON.stringify(sameThread?.registerError),
  )
  equal('q3.runtime-matches-scanner', sameThread?.names ?? [], scan.events.map((event) => event.name))
  equal('q3.vm.register-sites', vmRun?.names ?? [], q3ExpectedNames)
  equal('q3.vm-matches-scanner', vmRun?.names ?? [], scan.events.map((event) => event.name))
  equal('q3.realm.register-parity', sameThread?.names ?? [], vmRun?.names ?? [])
  equal('q3.runtime.match-count', sameThread?.matchers.length ?? 0, 8)
  check(
    'q3.runtime.matcher-keys-seen-by-scanner',
    (sameThread?.matchers ?? []).every((keys, index) => {
      const authoredMatcher = scan.events.filter((event) => event.matcher !== undefined)[index]?.matcher ?? ''
      return keys.every((key) => new RegExp(`\\b${key}\\b`).test(authoredMatcher))
    }),
  )

  // ---- Q4: fire session.start and record the bridge ---------------------
  const fire = (label, run) => {
    check(`q4.${label}.handler-found`, run?.handlerFound === true)
    check(`q4.${label}.no-fire-error`, run?.fireError === null, JSON.stringify(run?.fireError))
    equal(
      `q4.${label}.dollar-calls`,
      run?.calls.map((call) => call.method) ?? [],
      ['session.usage', 'command.register', 'session.messages'],
    )
    const register = run?.calls.find((call) => call.method === 'command.register')
    equal(`q4.${label}.command-name`, register?.args[0]?.name, 'diff')
    check(
      `q4.${label}.command-shape`,
      Array.isArray(register?.args[0]?.keys) &&
        register.args[0].keys.includes('description') &&
        register.args[0].keys.includes('name'),
      JSON.stringify(register?.args[0]),
    )
    check(`q4.${label}.returns-next-result`, run?.result === run?.nextResult && run?.result?.kind === 'continued')
    check(`q4.${label}.next-got-same-event`, run?.nextSameEvent === true)
    check(`q4.${label}.no-usage-fire-error`, run?.noUsageFireError === null, JSON.stringify(run?.noUsageFireError))
    equal(
      `q4.${label}.usage-undefined.dollar-calls`,
      run?.noUsageCalls.map((call) => call.method) ?? [],
      ['session.usage', 'clock.now', 'command.register', 'session.messages'],
    )
  }
  fire('same-thread', sameThread)
  fire('vm', vmRun)

  // The bridge surface named by the module's own session.start closure.
  const bridgeSource = authored.split('\n').slice(937, 975).join('\n')
  const bridgeMethods = [...new Set([...bridgeSource.matchAll(/\$\.\s*([a-z]+)\s*\.\s*([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`))]
  check(
    'q4.bridge-table-present',
    bridgeMethods.length >= 20,
    `${bridgeMethods.length}: ${bridgeMethods.join(', ')}`,
  )
  for (const method of ['session.usage', 'command.register', 'session.messages']) {
    check(`q4.bridge-covers-${method}`, bridgeMethods.includes(method))
  }

  equal('q1.tree.sha256-after-run', sha256(ENTRY), PIN.sha256)

  // ---- report -----------------------------------------------------------
  const failures = checks.filter((entry) => !entry.ok)
  check('run.has-assertions', checks.length > 0, `${checks.length} checks`)

  const report = {
    spike: 'S13',
    pin: PIN,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      vmModules: typeof vm.SourceTextModule === 'function',
      cache: relative(REPO, CACHE),
    },
    answers: {
      q1:
        'Stock Node 24 type strip compiles all 579 .ts files unmodified (0 failures, ' +
        `${authored.split('\n').length} lines preserved), but stock ESM resolution cannot load the graph ` +
        '(no directory-index resolution for extensionless/self imports, no .js->.ts, no .jsx->.tsx) ' +
        `and stock Node refuses the ${tsxFiles.length} .tsx modules by extension. Type strip refuses 20 of ` +
        '21 .tsx modules (19 "Expected \'>\', got \'ident\'", one "Expected \',\', got \'.\'"); the one JSX-free ' +
        'module strips in both modes but is still not loadable as .tsx. A host resolver for the three ' +
        `exercised behaviors plus name-preserving .tsx stubs loads the authored entry (${st.loadedTs.size} .ts ` +
        `modules, ${st.stubbedTsx.size} .tsx stubs); the .ts source itself is never edited.`,
      q2:
        'Both realms load the authored .ts graph and register the same 10 sites, but only node:vm ' +
        'SourceTextModule gives the declared mod environment ("an environment of its own: no DOM, no Node"): ' +
        'its context has no process, URL or $ binding, and a module-level $ read throws ReferenceError, ' +
        'whereas a same-thread import shares globalThis and exposes Node globals. Build on ' +
        'vm.SourceTextModule (requires --experimental-vm-modules) with a host linker; $ must provide nothing ' +
        'at load time — it is not a global, it is the first handler argument, and the same-thread getter ' +
        'counts 0 reads during load and registration.',
      q3:
        `register(on) reaches ${sameThread?.names.length ?? 0} sites / ${sameThread?.unique.length ?? 0} unique events, ` +
        `identical to the static scan (${scan.events.length} / ${new Set(scan.events.map((e) => e.name)).size}, ` +
        `${scan.calls.length} $. calls, ${scan.dynamic.length} dynamic) in source order; the scanner's line ` +
        `numbers run ${q3ExpectedLines[0]}..${q3ExpectedLines.at(-1)}. The scanner reads authored text and ` +
        'does not need the realm.',
      q4:
        'Firing session.start with session.usage() returning a startedAt timestamp exercises exactly 3 of the ' +
        '22 $. methods the handler binds: session.usage()->{startedAt}, command.register({name:"diff", ...}), ' +
        'session.messages()->[]. If usage() returns undefined, the authored `startedAt() ?? engine.now()` ' +
        'fallback inserts a fourth call, clock.now(), before command.register. The handler returns next(e) ' +
        'unchanged; the other bridge members ' +
        `(${bridgeMethods.filter((m) => !['session.usage', 'clock.now', 'command.register', 'session.messages'].includes(m)).join(', ')}) ` +
        'are needed only when the later handlers that use them fire.',
    },
    counts: {
      checks: checks.length,
      failed: failures.length,
      tsModulesRead: tsFiles.length,
      tsxModulesStubbed: tsxFiles.length,
      sameThreadTs: st.loadedTs.size,
      sameThreadTsx: st.stubbedTsx.size,
      vmTs: vmStats?.createdTs.size ?? 0,
      vmTsx: vmStats?.stubbedTsx.size ?? 0,
      resolution: st.resolution,
    },
    negative: negatives,
    checks,
  }
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n')

  console.log(`S13: ${checks.length - failures.length}/${checks.length} checks passed`)
  for (const failure of failures) console.log(`FAILED: ${failure.name}`)
  console.log(`report: ${REPORT}`)
  process.exit(failures.length === 0 && checks.length > 0 ? 0 : 1)
}

try {
  await main()
} catch (error) {
  console.error(`S13 aborted: ${error?.stack ?? error}`)
  console.error(`S13: 0 answered (${checks.length} checks before the abort)`)
  process.exit(1)
}
