/**
 * verify:release — what the registry actually serves, run, not read.
 *
 * `docs/RELEASING.md` checks the registry document (`dist-tags`, provenance)
 * and that the bin answers `--help`. Neither runs the compiler: a tarball can
 * carry the right manifest, the right provenance and a working `--help` while
 * its materializer or dialect is broken. This script unpacks the published
 * tarball, runs *its* `lib/cli.js report` on a checkout fixture, and asserts
 * the report's own facts.
 *
 * It is the post-publish step, not part of `verify`: it reaches the registry
 * and npm. The judgment functions are exported so a unit test asserts them
 * without the network.
 *
 * Stand outside the checkout when you invoke `npx` by hand: inside it, npm
 * resolves the workspace bin, whose `lib/cli.js` only exists after a build,
 * and the same command fails with `dsh-anyplugin: command not found`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REGISTRY = 'https://registry.npmjs.org'
const root = fileURLToPath(new URL('..', import.meta.url))

/** The registry's own words about the version. */
export function judgeRegistry({ versions, predicateType }, version) {
  const failures = []
  if (!Array.isArray(versions) || versions.length === 0) {
    failures.push('the registry returned no version list')
  } else if (!versions.includes(version)) {
    failures.push(`dsh-anyplugin@${version} is not published (registry has ${versions.join(', ')})`)
  }
  if (predicateType !== 'https://slsa.dev/provenance/v1') {
    failures.push(`dsh-anyplugin@${version} carries no SLSA v1 provenance (found ${predicateType ?? 'none'})`)
  }
  return failures
}

/** The packed artifact's manifest, as npm will serve it. */
export function judgePackage({ version }, expected) {
  if (version !== expected) {
    return [`the tarball's package.json says ${version}, not ${expected}`]
  }
  return []
}

/** What the packed compiler printed for the fixture, compared with the fixture. */
export function judgeReport(report, { version, name }) {
  const failures = []
  if (report.ok !== true) failures.push(`the packed compiler's report is not ok (ok=${JSON.stringify(report.ok)})`)
  if (report.plugin !== name) failures.push(`the report names plugin ${JSON.stringify(report.plugin)}, not ${JSON.stringify(name)}`)
  if (report.pin?.tool !== 'claude-code') failures.push(`the report's pin is ${JSON.stringify(report.pin?.tool)}, not "claude-code"`)
  if (typeof report.pin?.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(report.pin.version)) {
    failures.push(`the report's pin version is ${JSON.stringify(report.pin?.version)}`)
  }
  if (!Array.isArray(report.components) || report.components.length === 0) {
    failures.push('the report carries no components')
  } else {
    const unnamed = report.components.filter((component) => typeof component.surface !== 'string' || typeof component.class !== 'string')
    if (unnamed.length > 0) failures.push(`${unnamed.length} component(s) carry no surface or class`)
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
  const named = lines.find((candidate) => candidate.startsWith('Error: ')) ?? lines[0]
  return named === undefined ? 'no output' : named.slice(0, 200)
}

const DEFAULT_FIXTURE = join(root, 'fixtures', 'claude-skills-only')

function fixtureName(directory) {
  return JSON.parse(readFileSync(join(directory, '.claude-plugin', 'plugin.json'), 'utf8')).name
}

function defaultRunCli(cli, fixture) {
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
 * document, the published tarball and the packed CLI. The defaults are what
 * production uses; the test drives this same function with a tarball on disk,
 * so the wiring between the judges is asserted, not only the judges.
 */
export async function verifyRelease({
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  fixture = DEFAULT_FIXTURE,
  name = fixtureName(fixture),
  registry = {
    versions: async () => JSON.parse(npm(['view', 'dsh-anyplugin', 'versions', '--json'])),
    document: registryDocument,
  },
  pack = async (wanted, directory) =>
    JSON.parse(npm(['pack', `dsh-anyplugin@${wanted}`, '--json', '--pack-destination', directory], { cwd: directory }))[0].filename,
  runCli = defaultRunCli,
} = {}) {
  const failures = []
  const notes = []
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
  if (versions.length > 0) failures.push(...judgeRegistry({ versions, predicateType }, version))
  // A version the registry does not serve cannot be packed; asking npm anyway
  // would add a second, noisier failure (ETARGET) for the same fact.
  if (versions.length > 0 && !versions.includes(version)) return { ok: false, version, failures, notes }

  const scratch = mkdtempSync(join(tmpdir(), 'verify-release-'))
  try {
    const tarball = join(scratch, await pack(version, scratch))
    const unpacked = join(scratch, 'unpacked')
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', tarball, '-C', unpacked], { stdio: ['ignore', 'pipe', 'pipe'] })
    const manifest = JSON.parse(readFileSync(join(unpacked, 'package', 'package.json'), 'utf8'))
    failures.push(...judgePackage(manifest, version))

    const cli = join(unpacked, 'package', 'lib', 'cli.js')
    if (!existsSync(cli)) {
      failures.push('the packed artifact did not run: Error: the tarball carries no lib/cli.js (this version shipped no CLI)')
    } else {
      const report = runCli(cli, fixture)
      failures.push(...judgeReport(report, { version, name }))
      notes.push(
        tarball.slice(scratch.length + 1),
        `plugin ${report.plugin}`,
        `pin ${report.pin?.tool}@${report.pin?.version}`,
        `${report.components?.length} components`,
      )
    }
  } catch (error) {
    failures.push(`the packed artifact did not run: ${firstLine(error.stderr ?? error.stdout ?? error.message)}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  return { ok: failures.length === 0, version, failures, notes }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  const json = argv.includes('--json')
  const version = flag('--version', JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
  const fixture = flag('--fixture', DEFAULT_FIXTURE)
  const result = await verifyRelease({ version, fixture })

  if (result.failures.length > 0) {
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, version, failures: result.failures }, null, 2)}\n`)
    else {
      process.stderr.write(`verify-release: ${result.failures.length} claim(s) do not hold for ${version}\n`)
      for (const failure of result.failures) process.stderr.write(`  - ${failure}\n`)
    }
    process.exit(1)
  }
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, version, notes: result.notes }, null, 2)}\n`)
  else process.stdout.write(`verify-release: ok — dsh-anyplugin@${version}: ${result.notes.join('; ')}\n`)
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
