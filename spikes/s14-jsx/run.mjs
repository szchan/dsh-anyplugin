#!/usr/bin/env node
// S14: can a `.tsx` mod graph load through one classic JSX transform?
//
// The question is narrow. The `diff` mod is pinned by commit and sha256, and
// this spike does not vendor it: the tree is fetched (or reused) by
// `scripts/fetch-mod.mjs`. Every `.tsx` module is transformed with the host's
// classic transform (`@babel/plugin-transform-react-jsx`, runtime `classic`,
// pragma `h`, fragment pragma `Fragment`), type-stripped in memory, linked and
// evaluated in one `node:vm` realm whose only additions are `h` and `Fragment`.
// The whole graph is then loaded and its registrations compared with the static
// scanner: 10 `on()` sites, 8 unique events, 23 `$.` calls, 0 dynamic.
//
// Nothing renders. `h()` only builds `{ type, props, children }` descriptors;
// a host that draws them is out of scope (D34).
//
// Run:
//   node --experimental-vm-modules spikes/s14-jsx/run.mjs
//
// Set ANYPLUGIN_MOD_TREE to a fetched tree, or let the spike use
// `.mods/<commit>` / run `scripts/fetch-mod.mjs` itself. Every check prints.
// A run that records zero checks exits 1 (docs/ARCHITECTURE.md §10, the S9
// rule), as does any failed check.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as vm from 'node:vm'

import { FRAGMENT, jsxRealmGlobals, transformTsx } from '../../packages/dsh-anyplugin-mod-host/src/jsx.ts'
import { DIFF_MOD_PIN } from '../../packages/dsh-anyplugin-mod-host/src/pin.ts'
import { scanModSource } from '../../packages/dsh-anyplugin-mod-scan/src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const REPORT = join(OUT, 'report.json')
const ENTRY_NAME = DIFF_MOD_PIN.entry
const checks = []
const negatives = []

if (!vm.SourceTextModule) {
  console.error('S14 needs --experimental-vm-modules')
  process.exit(1)
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const rel = (file) => relative(TREE, file)
const read = (file) => readFileSync(file, 'utf8')
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '.git' ? [] : walk(path)
    return [path]
  })

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined || ok ? '' : ` — ${detail}`}`)
}

function equal(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    check(name, true)
  } catch (error) {
    check(name, false, error.message)
  }
}

function findTree() {
  const candidates = [process.env.ANYPLUGIN_MOD_TREE, join(REPO, '.mods', DIFF_MOD_PIN.commit)]
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, ENTRY_NAME))) return { tree: resolve(candidate), source: 'cache' }
  }
  const fetched = spawnSync(process.execPath, [join(REPO, 'scripts/fetch-mod.mjs')], { encoding: 'utf8' })
  if (fetched.status !== 0) {
    throw new Error(`scripts/fetch-mod.mjs failed: ${fetched.stderr || fetched.stdout}`)
  }
  const printed = fetched.stdout.trim().split('\n').at(-1)
  return { tree: resolve(printed), source: 'fetch' }
}

const { tree: TREE, source: TREE_SOURCE } = findTree()
const ENTRY = join(TREE, ENTRY_NAME)

// ---- Q1: the pin, the pragma, the transform --------------------------------
console.log(`S14: pinned mod ${TREE_SOURCE === 'cache' ? 'reused from' : 'fetched into'} ${TREE}`)
equal('q1.artifact.bytes', statSync(ENTRY).size, DIFF_MOD_PIN.entryBytes)
equal('q1.artifact.sha256', sha256(ENTRY), DIFF_MOD_PIN.entrySha256)

const files = walk(TREE)
const tsFiles = files.filter((file) => file.endsWith('.ts'))
const tsxFiles = files.filter((file) => file.endsWith('.tsx'))
equal('q1.tree.ts-count', tsFiles.length, DIFF_MOD_PIN.tsFiles)
equal('q1.tree.tsx-count', tsxFiles.length, DIFF_MOD_PIN.tsxFiles)

const PRAGMA = [/@jsxRuntime\s+classic/, /@jsx\s+h(?:\s|$)/, /@jsxFrag\s+Fragment/]
let pragmaMissing = 0
let hImports = 0
for (const file of tsxFiles) {
  const source = read(file)
  const head = source.slice(0, 400)
  if (!PRAGMA.every((pattern) => pattern.test(head))) {
    pragmaMissing += 1
    check(`q1.pragma.${rel(file)}`, false, 'not the classic pragma in the leading comment block')
  }
  if (/\bimport\b[^\n;]*\b(?:h|Fragment)\b/.test(source)) {
    hImports += 1
    check(`q1.pragma.${rel(file)}.no-import`, false, 'imports h/Fragment instead of using the realm globals')
  }
}
equal('q1.pragma.all-classic', pragmaMissing, 0)
equal('q1.pragma.no-h-imports', hImports, 0)

const transformed = new Map()
let transformFailures = 0
let stripFailures = 0
let parseFailures = 0
let hCallFiles = 0
for (const file of tsxFiles) {
  try {
    const code = transformTsx(read(file), file)
    transformed.set(file, code)
    check(`q1.transform.${rel(file)}`, code.length > 0 && code !== undefined)
    if (/\bh\s*\(/.test(code)) hCallFiles += 1
  } catch (error) {
    transformFailures += 1
    check(`q1.transform.${rel(file)}`, false, error.message)
    continue
  }
  try {
    const code = stripTypeScriptTypes(transformed.get(file), { mode: 'strip' })
    check(`q1.strip.${rel(file)}`, code.length > 0)
  } catch (error) {
    stripFailures += 1
    check(`q1.strip.${rel(file)}`, false, error.message)
    continue
  }
  try {
    new vm.SourceTextModule(stripTypeScriptTypes(transformed.get(file), { mode: 'strip' }), {
      identifier: pathToFileURL(file).href,
      context: vm.createContext({}),
    })
    check(`q1.parse.${rel(file)}`, true)
  } catch (error) {
    parseFailures += 1
    check(`q1.parse.${rel(file)}`, false, error.message)
  }
}
equal('q1.transform.all-tsx', transformFailures, 0)
equal('q1.transform.count', transformed.size, tsxFiles.length)
equal('q1.strip.all-tsx', stripFailures, 0)
equal('q1.parse.all-tsx', parseFailures, 0)
// 20 modules author elements; views/body/list-block-of.tsx is JSX-free.
check('q1.transform.h-call-files', hCallFiles >= 20, `only ${hCallFiles} transformed modules mention h(`)

// A file without the pragma is a typed refusal naming the file. The refusal
// is the host's, so the spike checks the same seam the fixture relies on.
for (const [label, source, needle] of [
  ['no-pragma', 'export const view = <div />\n', 'leading comment block'],
  ['foreign-pragma', '/* @jsx h2 */\nexport const view = <div />\n', '@jsx h2'],
  ['automatic-runtime', '/* @jsxRuntime automatic */\n/* @jsx h */\nexport const view = <div />\n', '@jsxRuntime automatic'],
]) {
  try {
    transformTsx(source, join(OUT, `${label}.tsx`))
    check(`q1.negative.${label}`, false, 'transform accepted a module it must refuse')
  } catch (error) {
    check(
      `q1.negative.${label}`,
      error?.name === 'ModHostError' && error?.code === 'ERR_MOD_HOST_TSX' && `${error.message}`.includes(needle),
      error?.message,
    )
  }
}

// ---- Q2: link and evaluate every .tsx in one realm -------------------------
const context = vm.createContext({ ...jsxRealmGlobals(), console })
check('q2.realm.h', vm.runInContext('typeof h', context) === 'function')
check('q2.realm.fragment', vm.runInContext('typeof Fragment', context) === 'symbol')
check('q2.realm.fragment-identity', context.Fragment === FRAGMENT)
check('q2.realm.no-dollar', vm.runInContext('typeof $', context) === 'undefined')
check('q2.realm.no-process', vm.runInContext('typeof process', context) === 'undefined')
check('q2.realm.no-url', vm.runInContext('typeof URL', context) === 'undefined')

const modules = new Map()
const stats = { directoryIndex: 0, jsToTs: 0, jsxToTsx: 0, loadedTs: 0, loadedTsx: 0, loadedJs: 0 }
const bare = []

function isWithin(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}

function resolveSpecifier(specifier, parentFile) {
  if (!specifier.startsWith('.') && !specifier.startsWith('..') && specifier !== '.') {
    bare.push({ specifier, parent: rel(parentFile) })
    throw new Error(`S14 resolver: a bare specifier must have been erased: ${specifier}`)
  }
  const base = resolve(dirname(parentFile), specifier)
  const ext = extname(base)
  let file
  let behavior
  if (ext === '.js') {
    file = `${base.slice(0, -3)}.ts`
    behavior = 'jsToTs'
  } else if (ext === '.jsx') {
    file = `${base.slice(0, -4)}.tsx`
    behavior = 'jsxToTsx'
  } else if (ext === '') {
    file = join(base, 'index.ts')
    behavior = 'directoryIndex'
  } else {
    throw new Error(`S14 resolver: no D30 rule for ${specifier}`)
  }
  if (!isWithin(TREE, file) || !existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`S14 resolver: ${specifier} from ${rel(parentFile)} names no file (${file})`)
  }
  stats[behavior] += 1
  return file
}

function createModule(file) {
  if (modules.has(file)) return modules.get(file)
  const ext = extname(file)
  let code = read(file)
  if (ext === '.tsx') {
    code = transformed.get(file) ?? transformTsx(code, file)
    code = stripTypeScriptTypes(code, { mode: 'strip' })
    stats.loadedTsx += 1
  } else if (ext === '.ts') {
    code = stripTypeScriptTypes(code, { mode: 'strip' })
    stats.loadedTs += 1
  } else if (ext === '.js' || ext === '.mjs') {
    stats.loadedJs += 1
  } else {
    throw new Error(`S14 loader: ${rel(file)} has no loadable extension`)
  }
  const module = new vm.SourceTextModule(code, {
    identifier: pathToFileURL(file).href,
    context,
  })
  modules.set(file, module)
  return module
}

async function linkAndEvaluate(file) {
  const module = createModule(file)
  if (module.status === 'unlinked') {
    await module.link((specifier, referencing) => {
      const parent = fileURLToPath(referencing.identifier)
      return createModule(resolveSpecifier(specifier, parent))
    })
  }
  if (module.status !== 'evaluated') await module.evaluate()
  return module
}

// Linking the entry builds the whole authored graph (all 21 .tsx are reached
// through views/index.ts), so the per-module resolutions below are counted
// once, exactly as S13 counted them.
const entryModule = await linkAndEvaluate(ENTRY)

let evaluatedTsx = 0
for (const file of tsxFiles) {
  try {
    await linkAndEvaluate(file)
    evaluatedTsx += 1
    check(`q2.evaluate.${rel(file)}`, true)
  } catch (error) {
    check(`q2.evaluate.${rel(file)}`, false, error.message)
  }
}
equal('q2.evaluate.all-tsx', evaluatedTsx, tsxFiles.length)

// `divider` is a tiny authored component. Calling it proves the evaluated
// module really calls the realm's `h`, not a copied or stubbed function.
const divider = await linkAndEvaluate(join(TREE, 'views/sections/divider.tsx'))
const element = divider.namespace.divider({ ui: { Text: 'Text' }, columns: 3 })
equal('q2.h.descriptor', JSON.parse(JSON.stringify(element)), {
  type: 'Text',
  props: { dimColor: true, wrap: 'truncate-end' },
  children: ['───'],
})

// ---- Q3: the whole graph, registrations vs the scanner ---------------------
const declarations = []
const on = (event, matcherOrHandler, maybeHandler) => {
  const hasMatcher = typeof matcherOrHandler !== 'function'
  const handler = hasMatcher ? maybeHandler : matcherOrHandler
  declarations.push({ event, matcher: hasMatcher ? matcherOrHandler : undefined, handler })
}
entryModule.namespace.register(on)

equal('q3.modules.tsx', stats.loadedTsx, tsxFiles.length)
equal('q3.modules.ts', stats.loadedTs, 505)
equal('q3.resolution.jsx-to-tsx', stats.jsxToTsx, 21)
equal('q3.resolution.js-to-ts', stats.jsToTs, 246)
// S13 counted 737 with name-preserving .tsx stubs. The real .tsx modules import
// their own siblings, which adds 58 directory resolutions but no new modules.
equal('q3.resolution.directory-index', stats.directoryIndex, 795)
equal('q3.resolution.no-bare', bare, [])

const scanner = scanModSource(read(ENTRY), { file: 'mods/diff/hooks/register.ts' })
equal('q3.scan.events', scanner.events.length, 10)
equal('q3.scan.unique-events', new Set(scanner.events.map((event) => event.name)).size, 8)
equal('q3.scan.calls', scanner.calls.length, 23)
equal('q3.scan.dynamic', scanner.dynamic.length, 0)
equal('q3.runtime.events', declarations.length, 10)
equal('q3.runtime.unique-events', new Set(declarations.map((declaration) => declaration.event)).size, 8)
equal(
  'q3.runtime.matches-scan',
  declarations.map((declaration) => declaration.event),
  scanner.events.map((event) => event.name),
)
equal(
  'q3.runtime.matchers-match-scan',
  declarations.map((declaration) => declaration.matcher !== undefined),
  scanner.events.map((event) => event.matcher !== undefined),
)
check(
  'q3.runtime.handlers-are-functions',
  declarations.every((declaration) => typeof declaration.handler === 'function'),
)
equal('q3.artifact.sha256-after-run', sha256(ENTRY), DIFF_MOD_PIN.entrySha256)

negatives.push({
  probe: 'stock Node + .tsx extension',
  result: 'ERR_UNKNOWN_FILE_EXTENSION (S13 Q1; the extension alone does not make a module loadable)',
})
negatives.push({
  probe: 'Babel reprint',
  result:
    'the transform rewrites the whole module, not only JSX spans; the spike does not claim source positions',
})

mkdirSync(OUT, { recursive: true })
const failures = checks.filter((entry) => !entry.ok)
const report = {
  spike: 'S14',
  question: 'Can the pinned diff mod graph load through one classic JSX transform and h/Fragment realm globals?',
  answer: failures.length === 0 ? 'yes: 21/21 .tsx transform, strip, link and evaluate; registrations match the scanner' : 'no',
  pin: DIFF_MOD_PIN,
  treeSource: TREE_SOURCE,
  environment: { node: process.version, flags: '--experimental-vm-modules' },
  counts: {
    tsxTransformed: transformed.size,
    tsxEvaluated: evaluatedTsx,
    ts: stats.loadedTs,
    resolution: { directoryIndex: stats.directoryIndex, jsToTs: stats.jsToTs, jsxToTsx: stats.jsxToTsx },
    registrations: declarations.length,
    uniqueEvents: new Set(declarations.map((declaration) => declaration.event)).size,
    scanCalls: scanner.calls.length,
    scanDynamic: scanner.dynamic.length,
    checks: checks.length,
    failed: failures.length,
  },
  negatives,
  checks,
}
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)

console.log(`S14: ${checks.length - failures.length}/${checks.length} checks passed`)
for (const failure of failures) console.log(`FAILED: ${failure.name}`)
console.log(`report: ${REPORT}`)
if (checks.length === 0) {
  console.error('S14: zero checks recorded; refusing to report success')
  process.exit(1)
}
if (failures.length > 0) process.exit(1)
