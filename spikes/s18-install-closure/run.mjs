// S18: does the pinned harness boot with `PluginPackages` *really* intercepting?
//
// S17 mounts the packed bundle through a real profile, but when
// `PluginPackages` cannot initialize it falls back to a scope-link symlink and
// records `host path: scope-link (… unsupported)` as a diagnostic. S18 asks
// whether the launcher's interception layer initializes on the Node this repo
// gates on, and if so, whether an import with no scope link resolves from the
// installation because of it.
//
// The answer is derived from the measured rows. A row proves closure only when
// all five internal modules load, the constructor succeeds, the bare
// @deepseek-ai/cordis-plugin-group import is unresolved before and resolves
// from the installation after, and S17 boots with `host path: PluginPackages`.
// There is no hardcoded verdict.
//
// The boundary is a patch, not a minor: Node 24.22.2 fails with
// Unsupported/no-getter and 24.22.3 (CI's `node-version: '24'` today) works;
// the Desktop's 24.21.0 works and 24.12.0 fails. Pass both extra binaries to
// reproduce it:
//
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
//   DSH_HARNESS_VERSION=0.2.2-rc.5 \
//   DSH_NODE_EXECUTABLE=<desktop node 24.21> \
//   S18_EXTRA_NODES=/path/to/node-24.22.3:/path/to/node-24.12 \
//     env -u CI node spikes/s18-install-closure/run.mjs
//
// The spike stays: it is the artifact behind the S18 table in
// docs/ARCHITECTURE.md §10 and the closure assertion in S17. Its assertions are
// the guard: if a Node changes sides of the patch boundary, or S17 falls back
// on a Node that initializes, the spike exits non-zero instead of letting the
// claim rot.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'
const OUT = join(HERE, 'out')

function fail(message) {
  console.error(`S18: ${message}`)
  process.exit(1)
}

function harnessLocation() {
  const named = process.env.DSH_HARNESS_DIR?.trim()
  const root = named || join(REPO, '.harness', VERSION)
  const candidates = [
    join(root, 'node_modules', '@deepseek-ai'),
    join(root, '@deepseek-ai'),
    root,
    dirname(root),
  ]
  const harnessDir = candidates.find((candidate) => existsSync(join(candidate, 'dsh-app-boot', 'package.json')))
  if (harnessDir === undefined) {
    fail(
      `no harness with @deepseek-ai/dsh-app-boot under ${root}; ` +
        `run 'node scripts/fetch-harness.mjs ${VERSION}' or set DSH_HARNESS_DIR`,
    )
  }
  const parent = dirname(harnessDir)
  const installRoot = parent.endsWith('/node_modules') ? dirname(parent) : harnessDir
  return {
    installRoot,
    harnessDir,
    version: JSON.parse(readFileSync(join(harnessDir, 'dsh-skill', 'package.json'), 'utf8')).version,
  }
}

function nodeVersion(binary) {
  const run = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (run.status !== 0) return null
  return run.stdout.trim()
}

function probeNode(binary, harness) {
  const script = join(profile, 'probe.mjs')
  try {
    const stdout = execFileSync(binary, [script], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        S18_HARNESS_DIR: harness.harnessDir,
        S18_INSTALL_ANCHOR: join(harness.installRoot, 'package.json'),
      },
    })
    const line = stdout.trim().split('\n').filter(Boolean).at(-1)
    return JSON.parse(line)
  } catch (error) {
    const stdout = String(error.stdout ?? '')
    const line = stdout.trim().split('\n').filter(Boolean).at(-1)
    if (line?.startsWith('{')) return { ...JSON.parse(line), probeExit: error.status ?? 'signal' }
    return { node: null, execPath: binary, fatal: { message: String(error.message).slice(0, 600) } }
  }
}

function runS17(binary, harness) {
  // S17 turns an incapable Node into a failure when CI is set; this spike is a
  // measurement, so the per-Node rows must exercise S17's local branch.
  const env = { ...process.env }
  delete env.CI
  const testPath = join(REPO, 'packages', 'dsh-anyplugin-conformance', 'test', 'profile-mount.test.mjs')
  const run = spawnSync(binary, ['--test', testPath], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      ...env,
      DSH_HARNESS_DIR: harness.installRoot,
      DSH_HARNESS_VERSION: harness.version,
    },
  })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  const hostPath = /host path: ([^\n]+)/.exec(output)?.[1]?.trim() ?? null
  const pass = Number(/ℹ pass (\d+)/.exec(output)?.[1] ?? NaN)
  const failCount = Number(/ℹ fail (\d+)/.exec(output)?.[1] ?? NaN)
  const skipped = Number(/ℹ skipped (\d+)/.exec(output)?.[1] ?? NaN)
  return { status: run.status, hostPath, pass, fail: failCount, skipped }
}

function flagSweep(binary, harness) {
  const flags = [
    [],
    ['--jitless'],
    ['--no-sparkplug'],
    ['--no-maglev'],
    ['--no-turbofan'],
    ['--interpreted-frames-native-stack'],
    ['--no-opt'],
    ['--no-concurrent-recompilation'],
  ]
  const script = [
    "import { createRequire } from 'node:module'",
    'const require = createRequire(process.env.S18_INSTALL_ANCHOR)',
    "const addon = require('node-addon-require-builtin')",
    'try {',
    "  addon.requireBuiltin('internal/modules/esm/loader')",
    "  console.log('OK')",
    '} catch (error) {',
    "  console.log(`ERR ${error.code ?? error.message}`)",
    '}',
  ].join('\n')
  return flags.map((args) => {
    const run = spawnSync(binary, [...args, '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, S18_INSTALL_ANCHOR: join(harness.installRoot, 'package.json') },
    })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    const line = /^(OK|ERR .+)$/m.exec(output)?.[1] ?? output.trim().split('\n').filter(Boolean).at(-1) ?? ''
    return { args: args.join(' ') || '(none)', result: line.replace(/^ERR /, '').slice(0, 120) }
  })
}

const harness = harnessLocation()
const bootModule = pathToFileURL(join(harness.harnessDir, 'dsh-app-boot', 'lib', 'index.js')).href

// `initProfile` comes from the same package that constructs PluginPackages, so
// the scratch home has exactly the layout the launcher expects.
const appBoot = await import(bootModule)
const home = mkdtempSync(join(tmpdir(), 's18-home-'))
const profile = join(home, 'profiles', 's18')
appBoot.initProfile(profile, [])
copyFileSync(join(HERE, 'probe.mjs'), join(profile, 'probe.mjs'))

const binaries = []
const gateReal = realpathSync(process.execPath)
const addBinary = (source, binary) => {
  if (binary === undefined || binary.trim() === '') return
  const absolute = resolve(binary.trim())
  if (!existsSync(absolute)) return
  const real = realpathSync(absolute)
  const existing = binaries.find((entry) => entry.real === real)
  if (existing !== undefined) {
    // The same binary can be both process.execPath and DSH_NODE_EXECUTABLE.
    // Keep every source tag instead of letting the first addBinary win.
    if (!existing.sources.includes(source)) existing.sources.push(source)
    return
  }
  binaries.push({ sources: [source], real, binary: absolute, gate: real === gateReal, desktop: false })
  if (source === 'DSH_NODE_EXECUTABLE') binaries.at(-1).desktop = true
}
addBinary('process.execPath', process.execPath)
addBinary('DSH_NODE_EXECUTABLE', process.env.DSH_NODE_EXECUTABLE)
for (const [index, binary] of (process.env.S18_EXTRA_NODES ?? '').split(':').entries()) {
  addBinary(`S18_EXTRA_NODES[${index}]`, binary)
}

const nodes = binaries.map((entry) => {
  const version = nodeVersion(entry.binary)
  const probe = probeNode(entry.binary, harness)
  const s17 = runS17(entry.binary, harness)
  return {
    ...entry,
    source: entry.sources.join(' + '),
    version: version ?? probe.node ?? 'unknown',
    probe,
    s17,
  }
})

const gate = nodes.find((node) => node.gate)
const desktop = nodes.find((node) => node.desktop)
if (gate === undefined) fail('the gate Node (process.execPath) probe is missing')
if (desktop === undefined) {
  fail('DSH_NODE_EXECUTABLE is unset or not a node binary; the 24.21 positive cannot be measured (incomplete, not a skip)')
}

const flagOutcomes = flagSweep(gate.binary, harness)
const builtinOk = (probe) => (probe.builtins ?? []).filter((builtin) => builtin.ok).length
const pluginPackagesText = (probe) => {
  if (probe.pluginPackages?.ok === true) return 'ok'
  const message = probe.pluginPackages?.message ?? ''
  const code = /Unsupported\/no-getter/.test(message) ? 'Unsupported/no-getter' : (probe.pluginPackages?.code ?? 'error')
  return `throws ${code}`
}

const table = nodes.map((node) => {
  const probe = node.probe
  const total = (probe.builtins ?? []).length
  const ok = builtinOk(probe)
  const pluginPackages = pluginPackagesText(probe)
  const before = probe.before?.ok === true ? 'resolved' : (probe.before?.code ?? 'failed')
  const after = probe.after?.ok === true ? 'resolved' : (probe.after?.code ?? 'failed')
  return {
    node: node.version,
    source: node.source,
    builtin: total === 0 ? 'n/a' : `${ok}/${total}${ok < total ? ' Unsupported/no-getter' : ''}`,
    pluginPackages,
    before,
    after,
    installation: probe.resolvedFromInstallation === true ? 'yes' : 'no',
    s17: node.s17.hostPath ?? (node.s17.status === 0 ? 'unknown' : `test exit ${node.s17.status}`),
  }
})

const columns = [
  ['node', 'node'],
  ['source', 'source'],
  ['builtin', 'requireBuiltin'],
  ['pluginPackages', 'PluginPackages'],
  ['before', 'pre-import'],
  ['after', 'post-import'],
  ['installation', 'from install'],
  ['s17', 'S17 host path'],
]
const widths = columns.map(([key, title]) => Math.max(title.length, ...table.map((row) => String(row[key]).length)))
const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ').trimEnd()
console.log('')
console.log(line(columns.map(([, title]) => title)))
console.log(line(widths.map((width) => '-'.repeat(width))))
for (const row of table) console.log(line(columns.map(([key]) => row[key])))
console.log('')
console.log(`harness: ${harness.version} at ${harness.installRoot}`)
const flagsThatWork = flagOutcomes.filter((flag) => flag.result === 'OK').length
console.log(`flags on the gate Node (${gate.version}): ${flagOutcomes.length} tried, ${flagsThatWork} initialize`)
for (const flag of flagOutcomes) console.log(`  ${flag.args.padEnd(34)} ${flag.result}`)
if (desktop.probe.after?.resolved) console.log(`desktop resolves to: ${desktop.probe.after.resolved}`)

const assertions = []
const assert = (name, ok, detail) => assertions.push({ name, ok: ok === true, detail })

// A row "closes" only when the minimal probe and the profile boot agree, in
// both directions. Nothing is hardcoded per Node model: the matrix is the
// answer.
const closes = (node) => {
  const builtins = node.probe.builtins ?? []
  return (
    builtins.length === 5 &&
    builtins.every((builtin) => builtin.ok) &&
    node.probe.pluginPackages?.ok === true &&
    node.probe.before?.ok === false &&
    node.probe.after?.ok === true &&
    node.probe.resolvedFromInstallation === true &&
    node.s17.pass === 5 &&
    node.s17.fail === 0 &&
    node.s17.skipped === 0 &&
    node.s17.hostPath === 'PluginPackages'
  )
}
const refuses = (node) => {
  const builtins = node.probe.builtins ?? []
  return (
    builtins.length === 5 &&
    builtins.every((builtin) => !builtin.ok) &&
    node.probe.pluginPackages?.ok === false &&
    /Unsupported\/no-getter/.test(node.probe.pluginPackages?.message ?? '') &&
    node.probe.before?.ok === false &&
    node.probe.after?.ok === false &&
    node.s17.pass === 5 &&
    node.s17.fail === 0 &&
    node.s17.skipped === 0 &&
    /^scope-link/.test(node.s17.hostPath ?? '')
  )
}

for (const node of nodes) {
  assert(
    `${node.version} (${node.source}): probe and S17 agree on one outcome`,
    closes(node) || refuses(node),
    JSON.stringify({
      builtin: `${builtinOk(node.probe)}/${(node.probe.builtins ?? []).length}`,
      pluginPackages: node.probe.pluginPackages,
      before: node.probe.before?.code,
      after: node.probe.after?.code,
      installation: node.probe.resolvedFromInstallation,
      s17: node.s17,
    }),
  )
}

for (const version of ['v24.22.2', 'v24.12.0']) {
  const rows = nodes.filter((node) => node.version === version)
  if (rows.length > 0) {
    assert(
      `${version}: still fails to initialize interception (Unsupported/no-getter)`,
      rows.every(refuses),
      rows.map((node) => JSON.stringify(node.s17)).join('; '),
    )
  }
}
for (const version of ['v24.22.3', 'v24.21.0']) {
  const rows = nodes.filter((node) => node.version === version)
  if (rows.length > 0) {
    assert(
      `${version}: still proves closure (constructor, import, S17 host path)`,
      rows.every(closes),
      rows.map((node) => JSON.stringify(node.s17)).join('; '),
    )
  }
}

assert(
  'at least one measured Node proves closure',
  nodes.some(closes),
  `no row closes; rows=${JSON.stringify(table)}`,
)
assert(
  'the gate Node row is green on its own side of the boundary',
  gate.s17.pass === 5 && gate.s17.fail === 0 && gate.s17.skipped === 0,
  JSON.stringify(gate.s17),
)

// The flag sweep is run on the gate binary. Its answer must agree with the
// gate row: a flag that flips the outcome would invalidate "no public knob".
assert(
  'the eight Node option sets (default + seven flags) leave the gate Node on its side of the boundary',
  flagOutcomes.every((flag) => (flag.result === 'OK') === closes(gate)),
  flagOutcomes.map((flag) => `${flag.args || '(none)'}=${flag.result}`).join('; '),
)
assert(
  'no separate @deepseek-ai/dsh-plugin-packages package at this pin',
  nodes.every(
    (node) =>
      node.probe.separatePackage?.ok === false &&
      /ERR_MODULE_NOT_FOUND/.test(node.probe.separatePackage?.code ?? ''),
  ),
  nodes.map((node) => `${node.version}=${node.probe.separatePackage?.code}`).join(', '),
)

const proven = nodes.filter(closes)
const refused = nodes.filter(refuses)
const ciNode = nodes.find((node) => node.version === 'v24.22.3') ?? null
const answer = {
  closure:
    proven.length === 0
      ? 'not-proven'
      : gate !== undefined && closes(gate)
        ? 'gate-node'
        : 'measured-node',
  gate: gate.version,
  gateProven: closes(gate),
  provenBy: proven.map((node) => `${node.version} (${node.source})`),
  failedOn: refused.map((node) => `${node.version} (${node.source})`),
  ciNode: ciNode === null ? null : { version: ciNode.version, proven: closes(ciNode) },
  patchBoundary:
    'v24.22.2 fails with Unsupported/no-getter and v24.22.3 works; the same minor, one patch apart',
}
const verdict =
  answer.closure === 'gate-node'
    ? `closure proven on the gate Node (${answer.gate})`
    : answer.closure === 'measured-node'
      ? `closure proven on ${answer.provenBy.join(', ')}, not on the gate Node (${answer.gate})`
      : 'closure not proven on any measured Node'

console.log('')
for (const assertion of assertions) {
  console.log(`${assertion.ok ? 'PASS' : 'FAIL'}  ${assertion.name}`)
  if (!assertion.ok) console.log(`      ${assertion.detail}`)
}
console.log('')
console.log(`S18 answer: ${answer.closure} — ${verdict}`)
console.log(`patch boundary: ${answer.patchBoundary}`)
if (ciNode !== null) console.log(`CI Node ${ciNode.version}: ${closes(ciNode) ? 'proves closure' : 'does not prove closure'}`)

mkdirSync(OUT, { recursive: true })
const report = {
  spike: 'S18',
  question:
    'Can the pinned harness boot with PluginPackages actually intercepting module resolution, ' +
    'on a Node this repo can run its gate on?',
  generatedAt: new Date().toISOString(),
  harness,
  nodes: nodes.map((node) => ({
    version: node.version,
    source: node.source,
    binary: node.binary,
    probe: node.probe,
    s17: node.s17,
  })),
  mechanism: {
    separatePackage: existsSync(join(harness.harnessDir, 'dsh-plugin-packages', 'package.json')),
    entry: '@deepseek-ai/dsh-app-boot/lib/index.js exports PluginPackages (top-level, no subpath)',
    constructor: 'src/profile-resolution/service.ts:66; installs interception at line 70, synchronously',
    internalModules: 'src/profile-resolution/resolver.ts:733 requires internal/modules/esm/loader, cjs/loader, helpers, esm/utils, esm/resolve',
    publicKnobs: 'the only config key is resolution (an early return at service.ts:67 when it is undefined); no process.env read in src/profile-resolution',
    registrationOrder:
      'ctx.plugin(PluginPackages, {resolution}) constructs the service immediately; the failure precedes any registration, so ordering another plugin first cannot help',
  },
  flags: { node: gate.version, outcomes: flagOutcomes },
  assertions,
  answer,
}
const reportPath = join(OUT, 'report.json')
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`report: ${reportPath}`)

rmSync(home, { recursive: true, force: true })
if (assertions.some((assertion) => !assertion.ok)) process.exit(1)
