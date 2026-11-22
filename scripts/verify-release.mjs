/**
 * verify:release — what the registry serves, run, not read.
 *
 * `docs/RELEASING.md` used to check the registry document (`dist-tags`,
 * provenance) and that the bin answered `--help`. Neither runs the compiler: a
 * tarball can carry the right manifest, the right provenance and a working
 * `--help` while its dialect or report path is broken. This script unpacks the
 * published tarball, runs *its* bin on a checkout fixture, and judges the
 * report: every row the fixture declares is \`exact\` or \`equivalent\` and
 * carried, no row the fixture does not declare appears (and none twice), every
 * row carries a reason, the totals are the derivation `report.ts` performs
 * (`declared` = rows, `emitted` = carried, `refused` = rows with a refusal,
 * `skipped` = rows - emitted - refused), and the pin is the pin this checkout
 * claims. The row checks
 * only run when the fixture enumerates rows: for a fixture of nested commands,
 * hooks or MCP servers the list is empty and a dropped row is not detected.
 *
 * Scope, stated narrowly: this runs the packed CLI's `report` path. It does
 * not execute the packed materializers. `report.ok` is `validateIr` (the IR is
 * well formed), not placement; a tarball whose `lib/materialize/*.js` all throw
 * still reports `ok: true`. The claim this backs is the packed CLI and the
 * compile path, not that an install would work end to end.
 *
 * It is the post-publish step, not part of `verify`: it reaches the registry
 * and npm. The judgment functions are exported so a unit test asserts them
 * without the network.
 *
 * Run it from the checkout root: `node scripts/verify-release.mjs --version
 * <v>`. (`npx dsh-anyplugin@<v>` from inside the checkout resolves the
 * workspace bin, whose `lib/cli.js` only exists after a build, and fails with
 * `dsh-anyplugin: command not found`; this script does not use npx.)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REGISTRY = 'https://registry.npmjs.org'
const SLSA = 'https://slsa.dev/provenance/v1'
const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_FIXTURE = join(root, 'fixtures', 'claude-skills-only')

/** The five classes; a report row outside this set is not an annotation, it is a typo. */
const CLASSES = new Set(['exact', 'equivalent', 'derived', 'planned', 'unsupported'])

/** The registry's own words about the version. */
export function judgeRegistry({ versions, predicateType }, version) {
  if (!Array.isArray(versions) || versions.length === 0) return ['the registry returned no version list']
  if (!versions.includes(version)) return [`dsh-anyplugin@${version} is not published (registry has ${versions.join(', ')})`]
  // Only a version that exists can carry provenance: asking about a missing
  // version's attestation would be a claim about nothing.
  if (predicateType !== SLSA) return [`dsh-anyplugin@${version} carries no SLSA v1 provenance (found ${predicateType ?? 'none'})`]
  return []
}

/** The bin a user would actually run, from the manifest npm serves. */
export function binPath(manifest) {
  const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin?.['dsh-anyplugin'] ?? Object.values(manifest.bin ?? {})[0])
  return typeof bin === 'string' && bin !== '' ? bin : undefined
}

/** The packed artifact's manifest, as npm will serve it. */
export function judgePackage(manifest, expected) {
  const failures = []
  if (manifest.version !== expected) failures.push(`the tarball's package.json says ${manifest.version}, not ${expected}`)
  if (binPath(manifest) === undefined) failures.push('the tarball declares no bin, so a user has no command to run')
  return failures
}

/**
 * What the packed compiler printed, compared with the fixture and this
 * checkout's pin. `expected` is a sorted list of `${surface}/${name}` for the
 * surfaces this verifier enumerates (skills, top-level commands, agents and
 * output styles); every row the fixture declares must be exact or equivalent
 * and carried, and the report may not carry a row the fixture does not
 * declare. Nested commands, hooks and MCP rows are not enumerated: for those
 * fixtures the row list is empty and only the shape rules apply.
 */
export function judgeReport(report, { name, pin, expected }) {
  const failures = []
  if (report.ok !== true) failures.push(`the packed compiler's report is not ok (ok=${JSON.stringify(report.ok)})`)
  if (!Array.isArray(report.problems)) failures.push('the report has no problems array, so "no problems" is not proven')
  else if (report.problems.length > 0) {
    failures.push(`the packed compiler reported ${report.problems.length} problem(s): ${String(report.problems[0]).slice(0, 160)}`)
  }
  if (report.plugin !== name) failures.push(`the report names plugin ${JSON.stringify(report.plugin)}, not ${JSON.stringify(name)}`)
  if (report.pin?.tool !== pin.tool) failures.push(`the report's pin tool is ${JSON.stringify(report.pin?.tool)}, not ${JSON.stringify(pin.tool)}`)
  if (report.pin?.version !== pin.version) {
    failures.push(`the report's pin version is ${JSON.stringify(report.pin?.version)}, not ${JSON.stringify(pin.version)} (the pin is part of the claim, AGENTS.md §3.8)`)
  }

  const components = Array.isArray(report.components) ? report.components : []
  const declared = new Set(expected.map((row) => row.split('/')[0]))
  if (components.length === 0) failures.push('the report carries no components')
  for (const [index, component] of components.entries()) {
    const row = `${component?.surface}/${component?.name}`
    const where = `component[${index}] (${row})`
    if (typeof component?.surface !== 'string' || component.surface === '') failures.push(`${where} has no surface`)
    if (typeof component?.name !== 'string' || component.name === '') failures.push(`${where} has no name`)
    if (!CLASSES.has(component?.class)) failures.push(`${where} has class ${JSON.stringify(component?.class)}, not one of the five`)
    if (typeof component?.reason !== 'string' || component.reason.trim() === '') failures.push(`${where} carries no reason`)
    if (typeof component?.carried !== 'boolean') failures.push(`${where} does not say whether it was carried`)
    if (declared.has(component?.surface)) {
      if (component.class !== 'exact' && component.class !== 'equivalent') {
        failures.push(`${where} is ${component.class}: a row the fixture declares must be exact or equivalent`)
      }
      if (component.carried !== true) failures.push(`${where} is ${component.class} but was not carried`)
    }
  }

  if (report.totals === null || typeof report.totals !== 'object') failures.push('the report has no totals object')
  else {
    const carried = components.filter((component) => component?.carried === true).length
    if (Number.isInteger(report.totals.emitted) === false) failures.push(`the report's totals.emitted is ${JSON.stringify(report.totals.emitted)}, not an integer`)
    else if (report.totals.emitted !== carried) {
      failures.push(`the report's totals say ${report.totals.emitted} component(s) emitted, but ${carried} row(s) are carried`)
    }
    if (Number.isInteger(report.totals.declared) === false) failures.push(`the report's totals.declared is ${JSON.stringify(report.totals.declared)}, not an integer`)
    else if (report.totals.declared !== components.length) {
      failures.push(`the report's totals declare ${report.totals.declared} component(s) for ${components.length} row(s)`)
    }
    for (const field of ['refused', 'skipped']) {
      if (report.totals[field] !== undefined && Number.isInteger(report.totals[field]) === false) {
        failures.push(`the report's totals.${field} is ${JSON.stringify(report.totals[field])}, not an integer`)
      }
    }
    // report.ts derives these from the rows (refused = rows that carry a
    // refusal, skipped = rows - emitted - refused), so a report that disagrees
    // is not a placement decision, it is a report the code cannot have written.
    const refusedRows = components.filter((component) => component?.refused !== undefined).length
    if (Number.isInteger(report.totals.refused) && report.totals.refused !== refusedRows) {
      failures.push(`the report's totals refuse ${report.totals.refused} component(s), but ${refusedRows} row(s) carry a refusal`)
    }
    if (
      Number.isInteger(report.totals.skipped) &&
      Number.isInteger(report.totals.emitted) &&
      Number.isInteger(report.totals.refused) &&
      report.totals.skipped !== components.length - report.totals.emitted - report.totals.refused
    ) {
      failures.push(`the report's totals skip ${report.totals.skipped} row(s), but ${components.length} row(s) minus ${report.totals.emitted} emitted and ${report.totals.refused} refused cannot skip that many`)
    }
  }

  if (expected.length > 0) {
    const rows = components.map((component) => `${component?.surface}/${component?.name}`)
    const count = (list) => list.reduce((map, row) => map.set(row, (map.get(row) ?? 0) + 1), new Map())
    const wanted = count(expected)
    const got = count(rows)
    const missing = [...wanted].filter(([row, n]) => (got.get(row) ?? 0) < n).map(([row]) => row)
    const duplicated = [...wanted].filter(([row, n]) => (got.get(row) ?? 0) > n).map(([row]) => row)
    const invented = [...got].filter(([row]) => !wanted.has(row)).map(([row]) => row)
    if (missing.length > 0) failures.push(`the report is missing ${missing.join(', ')}`)
    if (invented.length > 0) failures.push(`the report invented or repeated ${invented.join(', ')}`)
    if (duplicated.length > 0) failures.push(`the report repeats ${duplicated.join(', ')}`)
  }
  return failures
}

function npm(args, options) {
  return execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: { ...process.env, npm_config_cache: join(root, '.npm-cache'), ...options?.env },
  })
}

async function registryDocument(version) {
  const response = await fetch(`${REGISTRY}/dsh-anyplugin/${version}`)
  if (!response.ok) throw new Error(`the registry answered ${response.status} for dsh-anyplugin@${version}`)
  return await response.json()
}

/** The first line of a child's failure that names the failure, not the stack. */
function firstLine(text) {
  const lines = String(text ?? '').split('\n').map((candidate) => candidate.trim()).filter((candidate) => candidate !== '')
  const named = lines.find((candidate) => candidate.startsWith('Error: ')) ?? lines.find((candidate) => candidate.startsWith('npm error ')) ?? lines[0]
  return named === undefined ? 'no output' : named.slice(0, 200)
}

/** The pin this checkout claims, read from its single source (a literal, D39). */
export function repoPin(source = join(root, 'packages', 'dsh-anyplugin-conformance', 'src', 'pin.ts')) {
  const text = readFileSync(source, 'utf8')
  const match = /tool:\s*'([^']+)',\s*version:\s*'([^']+)'/u.exec(text)
  if (match === null) throw new Error('packages/dsh-anyplugin-conformance/src/pin.ts does not name a tool and version')
  return { tool: match[1], version: match[2] }
}

/** The rows a fixture declares on the surfaces this verifier enumerates. */
export function expectedComponents(directory) {
  const rows = []
  const markdown = (sub) => {
    const base = join(directory, sub)
    if (!existsSync(base)) return
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) rows.push(`${sub}/${entry.name.slice(0, -3)}`)
    }
  }
  const skills = join(directory, 'skills')
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(skills, entry.name, 'SKILL.md'))) rows.push(`skills/${entry.name}`)
    }
  }
  markdown('commands')
  markdown('agents')
  markdown('output-styles')
  return rows.sort()
}

function fixtureName(directory) {
  return JSON.parse(readFileSync(join(directory, '.claude-plugin', 'plugin.json'), 'utf8')).name
}

export function defaultRunCli(cli, fixture) {
  return JSON.parse(
    execFileSync(process.execPath, [cli, 'report', fixture, '--json'], {
      encoding: 'utf8',
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
}

/**
 * The whole probe. Everything that reaches outside is injected: the registry
 * document, the published tarball, the packed CLI and where scratch lives.
 * The defaults are what production uses; the test drives this same function
 * with a tarball on disk, so the wiring between the judges is asserted, not
 * only the judges.
 */
export async function verifyRelease({
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  fixture = DEFAULT_FIXTURE,
  name,
  expected = expectedComponents(fixture),
  pin = repoPin(),
  registry = {
    versions: async () => JSON.parse(npm(['view', 'dsh-anyplugin', 'versions', '--json'])),
    document: registryDocument,
  },
  pack = async (wanted, directory) =>
    JSON.parse(npm(['pack', `dsh-anyplugin@${wanted}`, '--json', '--pack-destination', directory], { cwd: directory }))[0].filename,
  runCli = defaultRunCli,
  scratchRoot = tmpdir(),
} = {}) {
  const failures = []
  const notes = []
  let pluginName = name
  if (pluginName === undefined) {
    try {
      pluginName = fixtureName(fixture)
    } catch (error) {
      return { ok: false, version, failures: [`the fixture's manifest could not be read: ${firstLine(error.message)}`], notes }
    }
  }
  let versions = []
  try {
    versions = await registry.versions()
  } catch (error) {
    failures.push(`the registry's version list did not answer: ${firstLine(error.stderr ?? error.message)}`)
  }
  let predicateType
  try {
    const document = await registry.document(version)
    predicateType = document.dist?.attestations?.provenance?.predicateType
  } catch (error) {
    failures.push(`the registry's version document did not answer: ${firstLine(error.message)}`)
  }
  failures.push(...judgeRegistry({ versions, predicateType }, version))
  // A version the registry does not serve cannot be packed; asking npm anyway
  // would add a second, noisier failure (ETARGET) for the same fact.
  if (Array.isArray(versions) && versions.length > 0 && !versions.includes(version)) return { ok: false, version, failures, notes }

  const scratch = mkdtempSync(join(scratchRoot, 'verify-release-'))
  try {
    const tarball = join(scratch, await pack(version, scratch))
    const unpacked = join(scratch, 'unpacked')
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', tarball, '-C', unpacked], { stdio: ['ignore', 'pipe', 'pipe'] })
    const manifest = JSON.parse(readFileSync(join(unpacked, 'package', 'package.json'), 'utf8'))
    failures.push(...judgePackage(manifest, version))

    const bin = binPath(manifest)
    const cli = bin === undefined ? undefined : join(unpacked, 'package', bin)
    if (cli === undefined || !existsSync(cli)) {
      failures.push(`the packed artifact did not run: the tarball's bin ${JSON.stringify(bin ?? null)} is not in the archive`)
    } else {
      const report = runCli(cli, fixture)
      failures.push(...judgeReport(report, { name: pluginName, pin, expected }))
      notes.push(
        tarball.slice(scratch.length + 1),
        `plugin ${report.plugin}`,
        `pin ${report.pin?.tool}@${report.pin?.version}`,
        `${report.components?.length} components`,
        `${report.totals?.emitted} emitted`,
      )
    }
  } catch (error) {
    failures.push(`the packed artifact did not run: ${firstLine(error.stderr ?? error.stdout ?? error.message)}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  return { ok: failures.length === 0, version, failures, notes }
}

const USAGE = 'usage: node scripts/verify-release.mjs [--version <x.y.z>] [--fixture <plugin-dir>] [--json]'

/**
 * argv handling and exit codes, injectable so the failure contract (1 for a
 * failed claim, 2 for a usage error) is tested rather than observed.
 */
export async function run(argv, { verify = verifyRelease, out = process.stdout, err = process.stderr } = {}) {
  const usage = (message) => {
    err.write(`verify-release: ${message}\n${USAGE}\n`)
    return 2
  }
  let json = false
  let version
  let fixture
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument === '--version' || argument === '--fixture') {
      const candidate = argv[index + 1]
      if (candidate === undefined || candidate.startsWith('--')) return usage(`${argument} needs a value`)
      if (argument === '--version') version = candidate
      else fixture = candidate
      index += 1
      continue
    }
    return usage(`${argument.startsWith('--') ? 'unknown option' : 'unexpected argument'} ${argument}`)
  }
  const directory = fixture ?? DEFAULT_FIXTURE
  const manifest = join(directory, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) {
    const shown = fixture ?? (relative(process.cwd(), directory) || directory)
    return usage(`${shown} is not a Claude Code plugin directory (no .claude-plugin/plugin.json)`)
  }
  let name
  try {
    name = JSON.parse(readFileSync(manifest, 'utf8')).name
  } catch (error) {
    return usage(`${directory}/.claude-plugin/plugin.json is not JSON: ${firstLine(error.message)}`)
  }
  if (typeof name !== 'string' || name === '') return usage(`${directory}/.claude-plugin/plugin.json does not name the plugin`)

  const result = await verify({ ...(version === undefined ? {} : { version }), fixture: directory, name })
  if (result.failures.length > 0) {
    if (json) out.write(`${JSON.stringify({ ok: false, version: result.version, failures: result.failures, notes: result.notes }, null, 2)}\n`)
    else {
      err.write(`verify-release: ${result.failures.length} claim(s) do not hold for ${result.version}\n`)
      for (const failure of result.failures) err.write(`  - ${failure}\n`)
    }
    return 1
  }
  if (json) out.write(`${JSON.stringify({ ok: true, version: result.version, notes: result.notes, failures: [] }, null, 2)}\n`)
  else out.write(`verify-release: ok — dsh-anyplugin@${result.version}: ${result.notes.join('; ')}\n`)
  return 0
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await run(process.argv.slice(2))
}
