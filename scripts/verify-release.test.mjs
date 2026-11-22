// The post-publish probe is only worth running if its judgment is right: a
// verifier that accepts a version the registry does not have, an artifact with
// no provenance, a report that placed nothing or a usage typo that checks the
// wrong version is a rubber stamp. Each case below is a way the first draft
// did exactly that; the mutation table in the PR says which case catches which
// deletion.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { binPath, expectedComponents, judgePackage, judgeRegistry, judgeReport, repoPin, run, verifyRelease } from './verify-release.mjs'

const SLSA = 'https://slsa.dev/provenance/v1'
const PIN = { tool: 'claude-code', version: '2.1.329' }
const EXPECTED = ['skills/greet', 'skills/hello']

const component = (surface, name, patch = {}) => ({
  surface,
  name,
  class: 'equivalent',
  reason: 'Body is preserved byte for byte inside a different envelope.',
  carried: true,
  ...patch,
})

const REPORT = {
  ok: true,
  plugin: 'skills-only',
  pin: PIN,
  components: [component('skills', 'greet'), component('skills', 'hello')],
  totals: { declared: 2, emitted: 2, refused: 0, skipped: 0 },
  problems: [],
}

const judge = (patch = {}) => judgeReport({ ...REPORT, ...patch }, { name: 'skills-only', pin: PIN, expected: EXPECTED })

const dirs = []
after(() => {
  for (const directory of dirs) rmSync(directory, { recursive: true, force: true })
})
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), 'verify-release-test-'))
  dirs.push(directory)
  return directory
}

const registryServing = (versions, predicateType = SLSA) => ({
  versions: async () => versions,
  document: async () => ({ dist: { attestations: { provenance: { predicateType } } } }),
})

/** A tarball shaped like npm's: package/package.json + the bin it names. */
function fakeTarball(directory, version, { bin = 'lib/cli.js', noBin = false, writeBin = true, cli = 'console.log("{}")\n' } = {}) {
  const build = join(directory, 'build', 'package')
  mkdirSync(join(build, 'lib'), { recursive: true })
  writeFileSync(join(build, 'package.json'), JSON.stringify({ name: 'dsh-anyplugin', version, ...(noBin ? {} : { bin: { 'dsh-anyplugin': bin } }) }))
  if (writeBin && !noBin) writeFileSync(join(build, bin), cli)
  execFileSync('tar', ['-czf', join(directory, 'dsh-anyplugin.tgz'), '-C', join(directory, 'build'), 'package'])
  return 'dsh-anyplugin.tgz'
}

// --- registry ------------------------------------------------------------

test('judgeRegistry: a published, attested version has nothing to say', () => {
  assert.deepEqual(judgeRegistry({ versions: ['0.2.0', '0.3.0'], predicateType: SLSA }, '0.3.0'), [])
})

test('judgeRegistry: an absent version is one failure, not a provenance claim about nothing', () => {
  const failures = judgeRegistry({ versions: ['0.2.0', '0.3.0'], predicateType: undefined }, '0.2.99')
  assert.deepEqual(failures, ['dsh-anyplugin@0.2.99 is not published (registry has 0.2.0, 0.3.0)'])
})

test('judgeRegistry: an empty version list is not "no match"', () => {
  assert.deepEqual(judgeRegistry({ versions: [], predicateType: SLSA }, '0.3.0'), ['the registry returned no version list'])
})

test('judgeRegistry: SLSA v0.2 is not SLSA v1', () => {
  const failures = judgeRegistry({ versions: ['0.3.0'], predicateType: 'https://slsa.dev/provenance/v0.2' }, '0.3.0')
  assert.match(failures[0], /carries no SLSA v1 provenance \(found https:\/\/slsa\.dev\/provenance\/v0\.2\)/)
})

// --- package -------------------------------------------------------------

test('judgePackage: the manifest must be the version that was asked for, and must name a bin', () => {
  assert.deepEqual(judgePackage({ version: '0.3.0', bin: { 'dsh-anyplugin': 'lib/cli.js' } }, '0.3.0'), [])
  assert.deepEqual(judgePackage({ version: '0.2.0', bin: 'lib/cli.js' }, '0.3.0'), ["the tarball's package.json says 0.2.0, not 0.3.0"])
  assert.deepEqual(judgePackage({ version: '0.3.0' }, '0.3.0'), ['the tarball declares no bin, so a user has no command to run'])
})

test('binPath: an object bin, a string bin, and neither', () => {
  assert.equal(binPath({ bin: { 'dsh-anyplugin': './lib/cli.js' } }), './lib/cli.js')
  assert.equal(binPath({ bin: 'lib/cli.js' }), 'lib/cli.js')
  assert.equal(binPath({}), undefined)
})

// --- report --------------------------------------------------------------

test('judgeReport: the report of the default fixture is read as facts', () => {
  assert.deepEqual(judge(), [])
})

test('judgeReport: a not-ok report or a reported problem is refused', () => {
  assert.match(judge({ ok: false })[0], /report is not ok \(ok=false\)/)
  assert.match(judge({ problems: ['two entries share an identity'] })[0], /2 problem\(s\)|reported 1 problem\(s\): two entries share an identity/)
})

test('judgeReport: the plugin name and the pin are the claim', () => {
  assert.match(judge({ plugin: 'other' })[0], /names plugin "other", not "skills-only"/)
  assert.match(judge({ pin: { tool: 'codex', version: '1.0.0' } })[0], /pin tool is "codex", not "claude-code"/)
  assert.match(judge({ pin: { tool: 'claude-code', version: '2.1.322' } })[0], /pin version is "2.1.322", not "2.1.329"/)
})

test('judgeReport: every row carries a class from the five and a reason', () => {
  const bad = { ...REPORT, components: [component('skills', 'greet', { class: 'junk' }), component('skills', 'hello')] }
  assert.match(judgeReport(bad, { name: 'skills-only', pin: PIN, expected: EXPECTED })[0], /has class "junk", not one of the five/)
  const blank = { ...REPORT, components: [component('skills', 'greet', { reason: '   ' }), component('skills', 'hello')] }
  assert.match(judgeReport(blank, { name: 'skills-only', pin: PIN, expected: EXPECTED })[0], /carries no reason/)
})

test('judgeReport: an exact or equivalent row that was not carried is a failed claim', () => {
  const bad = { ...REPORT, components: [component('skills', 'greet', { carried: false }), component('skills', 'hello')], totals: { declared: 2, emitted: 1, refused: 0, skipped: 1 } }
  assert.match(judgeReport(bad, { name: 'skills-only', pin: PIN, expected: EXPECTED })[0], /is equivalent but was not carried/)
})

test('judgeReport: a dropped row and a lying total are refused', () => {
  const nothing = { ...REPORT, components: [component('skills', 'greet', { carried: false, class: 'planned' })], totals: { declared: 2, emitted: 0, refused: 0, skipped: 1 } }
  const failures = judgeReport(nothing, { name: 'skills-only', pin: PIN, expected: EXPECTED })
  assert.ok(failures.some((failure) => /missing skills\/hello/.test(failure)))
  const lying = { ...REPORT, totals: { declared: 2, emitted: 1, refused: 0, skipped: 1 } }
  assert.match(judgeReport(lying, { name: 'skills-only', pin: PIN, expected: EXPECTED })[0], /totals say 1 component\(s\) emitted, but 2 row\(s\) are carried/)
})

test('judgeReport: a report that placed nothing is refused even when every row is present', () => {
  const downgraded = {
    ...REPORT,
    components: REPORT.components.map((row) => ({ ...row, class: 'planned', carried: false })),
    totals: { declared: 2, emitted: 0, refused: 0, skipped: 2 },
  }
  assert.match(
    judgeReport(downgraded, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'),
    /a row the fixture declares must be exact or equivalent/,
  )
})

test('judgeReport: the fixture decides the rows — invented and dropped rows both fail', () => {
  const invented = { ...REPORT, components: [...REPORT.components, component('skills', 'junk', { class: 'planned', carried: false })], totals: { declared: 3, emitted: 2, refused: 0, skipped: 1 } }
  assert.match(judgeReport(invented, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /invented or repeated skills\/junk/)
  const dropped = { ...REPORT, components: [REPORT.components[0]], totals: { declared: 1, emitted: 1, refused: 0, skipped: 0 } }
  assert.match(judgeReport(dropped, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /missing skills\/hello/)
})

test('judgeReport: a repeated row is a failure, not a larger set', () => {
  const duplicated = {
    ...REPORT,
    components: [component('skills', 'greet'), component('skills', 'greet'), component('skills', 'hello')],
    totals: { declared: 3, emitted: 3, refused: 0, skipped: 0 },
  }
  assert.match(judgeReport(duplicated, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /repeats skills\/greet/)
})

test('judgeReport: a row on a surface the fixture does not declare is invented', () => {
  const rogue = {
    ...REPORT,
    components: [...REPORT.components, component('agents', 'rogue', { class: 'equivalent' })],
    totals: { declared: 3, emitted: 3, refused: 0, skipped: 0 },
  }
  assert.match(judgeReport(rogue, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /invented or repeated agents\/rogue/)
})

test('judgeReport: a missing problems array is not "no problems"', () => {
  const { problems, ...rest } = REPORT
  void problems
  assert.match(judgeReport(rest, { name: 'skills-only', pin: PIN, expected: EXPECTED })[0], /no problems array/)
})

test('judgeReport: a missing totals object is a failure', () => {
  const { totals, ...rest } = REPORT
  void totals
  assert.match(judgeReport(rest, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /no totals object/)
})

test('repoPin: the version comes from the file it is given', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pin-source-'))
  try {
    const file = join(directory, 'pin.ts')
    writeFileSync(file, "export const CLAUDE_CODE_PIN = { tool: 'claude-code', version: '9.9.9' } as const\n")
    assert.deepEqual(repoPin(file), { tool: 'claude-code', version: '9.9.9' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the entry point exits 2 on a usage error, not 0', () => {
  const result = spawnSync(process.execPath, [new URL('./verify-release.mjs', import.meta.url).pathname, '--wat'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option --wat/)
})

test('expectedComponents: the fixture is the list (skills, commands, agents, output styles)', () => {
  assert.deepEqual(expectedComponents(join(process.cwd(), 'fixtures', 'claude-skills-only')), ['skills/greet', 'skills/hello'])
  assert.deepEqual(expectedComponents(join(process.cwd(), 'fixtures', 'claude-commands-flat')), ['commands/migrate', 'commands/review'])
})

test('expectedComponents: agents and output styles are enumerated too', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-surfaces-'))
  try {
    for (const [surface, name] of [['agents', 'reviewer'], ['output-styles', 'quiet']]) {
      mkdirSync(join(directory, surface), { recursive: true })
      writeFileSync(join(directory, surface, `${name}.md`), '')
    }
    assert.deepEqual(expectedComponents(directory), ['agents/reviewer', 'output-styles/quiet'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('repoPin: the verifier reads the pin from its single source', () => {
  assert.deepEqual(repoPin(), PIN)
})

// --- the whole probe -----------------------------------------------------

test('verifyRelease: it unpacks the tarball and asks the bin it names', async () => {
  const seen = {}
  const result = await verifyRelease({
    version: '0.3.0',
    registry: registryServing(['0.3.0']),
    pack: async (version, directory) => fakeTarball(directory, version, { bin: 'lib/cli.js' }),
    runCli: (cli, fixture) => {
      seen.cli = cli
      seen.fixture = fixture
      return REPORT
    },
  })

  assert.deepEqual(result.failures, [])
  assert.equal(result.ok, true)
  assert.match(seen.cli, /unpacked[/\\]package[/\\]lib[/\\]cli\.js$/)
  assert.match(seen.fixture, /fixtures[/\\]claude-skills-only$/)
  assert.match(result.notes.join('; '), /plugin skills-only; pin claude-code@2\.1\.329; 2 components; 2 emitted/)
})

test('verifyRelease: a version the registry does not serve never reaches the packer', async () => {
  let packed = 0
  const result = await verifyRelease({
    version: '0.2.99',
    registry: registryServing(['0.3.0']),
    pack: async () => {
      packed += 1
      return 'unused.tgz'
    },
    runCli: () => REPORT,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.failures, ['dsh-anyplugin@0.2.99 is not published (registry has 0.3.0)'])
  assert.equal(packed, 0, 'a version that is not published must not be packed')
})

test('verifyRelease: the wiring calls judgeReport — a bad report is a failure, not a note', async () => {
  const result = await verifyRelease({
    version: '0.3.0',
    registry: registryServing(['0.3.0']),
    pack: async (version, directory) => fakeTarball(directory, version),
    runCli: () => ({ ...REPORT, ok: false }),
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => /report is not ok/.test(failure)), 'judgeReport must be on the path')
})

test('verifyRelease: a tarball with no bin, or a bin that is not in the archive, does not run', async () => {
  const noBin = await verifyRelease({
    version: '0.3.0',
    registry: registryServing(['0.3.0']),
    pack: async (version, directory) => fakeTarball(directory, version, { noBin: true }),
    runCli: () => REPORT,
  })
  assert.ok(noBin.failures.some((failure) => /declares no bin/.test(failure)))
  assert.ok(noBin.failures.some((failure) => /bin null is not in the archive/.test(failure)))

  const moved = await verifyRelease({
    version: '0.3.0',
    registry: registryServing(['0.3.0']),
    pack: async (version, directory) => fakeTarball(directory, version, { bin: 'lib/moved-cli.js', writeBin: false }),
    runCli: () => REPORT,
  })
  assert.ok(moved.failures.some((failure) => /bin "lib\/moved-cli\.js" is not in the archive/.test(failure)))
})

test('judgeReport: a non-integer skipped total is refused, like refused', () => {
  const broken = { ...REPORT, totals: { declared: 2, emitted: 2, refused: 0, skipped: 'many' } }
  assert.match(judgeReport(broken, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /totals\.skipped is "many", not an integer/)
})

test('judgeReport: refused and skipped are required, not optional', () => {
  for (const totals of [{ declared: 2, emitted: 2 }, { declared: 2, emitted: 2, refused: 0 }, { declared: 2, emitted: 2, skipped: 0 }]) {
    const partial = { ...REPORT, totals }
    assert.match(judgeReport(partial, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /totals\.(refused|skipped) is undefined, not an integer/)
  }
})

test('judgeReport: a carried row that also carries a refusal cannot exist', () => {
  const row = { ...component('skills', 'greet'), refused: 'hook' }
  const impossible = { ...REPORT, components: [row, component('skills', 'hello')], totals: { declared: 2, emitted: 2, refused: 1, skipped: -1 } }
  assert.match(judgeReport(impossible, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /is carried and carries a refusal/)
})

test('judgeReport: totals that contradict the rows are refused', () => {
  const noRefusals = { ...REPORT, totals: { declared: 2, emitted: 2, refused: 99, skipped: 0 } }
  assert.match(judgeReport(noRefusals, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /refuse 99 component\(s\), but 0 row\(s\) carry a refusal/)
  const tooManySkips = { ...REPORT, totals: { declared: 2, emitted: 2, refused: 0, skipped: 99 } }
  assert.match(judgeReport(tooManySkips, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /totals skip 99 row\(s\)/)
})

test('judgeReport: totals.declared is the number of rows, not a lower bound', () => {
  const under = { ...REPORT, totals: { declared: 1, emitted: 2, refused: 0, skipped: 0 } }
  assert.match(judgeReport(under, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /declare 1 component\(s\) for 2 row\(s\)/)
})

test('judgeReport: refused and skipped totals must be integers when present', () => {
  const broken = { ...REPORT, totals: { declared: 2, emitted: 2, refused: 'many', skipped: 0 } }
  assert.match(judgeReport(broken, { name: 'skills-only', pin: PIN, expected: EXPECTED }).join('\n'), /totals\.refused is "many", not an integer/)
})

test('verifyRelease: a tarball naming another version reports the mismatch after the CLI runs', async () => {
  let ran = 0
  const result = await verifyRelease({
    version: '0.3.0',
    registry: registryServing(['0.3.0']),
    pack: async (version, directory) => fakeTarball(directory, '0.2.0'),
    runCli: () => {
      ran += 1
      return REPORT
    },
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => /says 0\.2\.0, not 0\.3\.0/.test(failure)))
  assert.equal(ran, 1, 'the version mismatch is one failure; the CLI still runs and is judged')
})

test('verifyRelease: a packed artifact that will not run is a failure, not a stack trace', async () => {
  const result = await verifyRelease({
    version: '0.3.0',
    registry: registryServing(['0.3.0']),
    pack: async (version, directory) => fakeTarball(directory, version),
    runCli: () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Error: Cannot find module cli.js\n    at ...' })
    },
  })
  assert.deepEqual(result.failures, ['the packed artifact did not run: Error: Cannot find module cli.js'])
})

test('verifyRelease: a fixture that cannot be read is a failure, not a throw', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'broken-fixture-'))
  try {
    mkdirSync(join(directory, '.claude-plugin'), { recursive: true })
    writeFileSync(join(directory, '.claude-plugin', 'plugin.json'), '{not json')
    const result = await verifyRelease({ fixture: directory, registry: { versions: async () => ['0.3.0'], document: async () => ({}) } })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /manifest could not be read/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('verifyRelease: scratch is cleaned even when the packer throws', async () => {
  const scratchRoot = scratch()
  await verifyRelease({
    version: '0.3.0',
    registry: registryServing(['0.3.0']),
    pack: async () => {
      throw Object.assign(new Error('boom'), { stderr: 'npm error code ETARGET' })
    },
    runCli: () => REPORT,
    scratchRoot,
  })
  assert.deepEqual(readdirSync(scratchRoot), [])
})

test('defaultRunCli: it executes the path it is given, as `report <fixture> --json`', async () => {
  const directory = scratch()
  const cli = join(directory, 'cli.js')
  writeFileSync(cli, 'console.log(JSON.stringify({ argv: process.argv.slice(2), ok: true }))\n')
  const { defaultRunCli } = await import('./verify-release.mjs')
  assert.deepEqual(defaultRunCli(cli, '/some/fixture'), { argv: ['report', '/some/fixture', '--json'], ok: true })
})

// --- the command surface -------------------------------------------------

const capture = () => {
  const chunks = []
  return { chunks, write: (chunk) => chunks.push(String(chunk)), get text() { return chunks.join('') } }
}

test('run: success prints the claim and exits 0', async () => {
  const out = capture()
  const code = await run(['--version', '0.3.0'], {
    verify: async () => ({ ok: true, version: '0.3.0', failures: [], notes: ['plugin skills-only'] }),
    out,
    err: capture(),
  })
  assert.equal(code, 0)
  assert.match(out.text, /verify-release: ok — dsh-anyplugin@0\.3\.0: plugin skills-only/)
})

test('run: a failed claim exits 1 and lists each one', async () => {
  const err = capture()
  const code = await run(['--version', '0.1.0'], {
    verify: async () => ({ ok: false, version: '0.1.0', failures: ['a', 'b'], notes: [] }),
    out: capture(),
    err,
  })
  assert.equal(code, 1)
  assert.match(err.text, /2 claim\(s\) do not hold for 0\.1\.0\n  - a\n  - b/)
})

test('run: an unknown flag after --json is a usage error, not "verify the checkout"', async () => {
  for (const argv of [['--json', '--wat'], ['--json', '0.1.0'], ['--version', '0.3.0', 'extra']]) {
    const err = capture()
    const code = await run(argv, { verify: async () => assert.fail('must not verify'), out: capture(), err })
    assert.equal(code, 2, argv.join(' '))
    assert.match(err.text, /verify-release: /)
  }
})

test('run: a flag is not a value for another flag', async () => {
  for (const argv of [['--version', '--json'], ['--fixture', '--wat']]) {
    const err = capture()
    const code = await run(argv, { verify: async () => assert.fail('must not verify'), out: capture(), err })
    assert.equal(code, 2, argv.join(' '))
    assert.match(err.text, /needs a value/)
  }
  const out = capture()
  const code = await run(['--json', '--version', '0.3.0'], {
    verify: async (options) => ({ ok: true, version: options.version, failures: [], notes: ['stub'] }),
    out,
    err: capture(),
  })
  assert.equal(code, 0)
  assert.match(out.text, /"version": "0.3.0"/)
})

test('run: a fixture manifest without a usable name is a usage error', async () => {
  for (const body of ['{"name":""}', '{"name":42}']) {
    const directory = mkdtempSync(join(tmpdir(), 'nameless-fixture-'))
    try {
      mkdirSync(join(directory, '.claude-plugin'), { recursive: true })
      writeFileSync(join(directory, '.claude-plugin', 'plugin.json'), body)
      const err = capture()
      const code = await run(['--version', '0.3.0', '--fixture', directory], { verify: async () => assert.fail('must not verify'), out: capture(), err })
      assert.equal(code, 2, body)
      assert.match(err.text, /does not name the plugin/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('run: a malformed fixture manifest is exit 2, not a SyntaxError stack', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bad-fixture-'))
  try {
    mkdirSync(join(directory, '.claude-plugin'), { recursive: true })
    writeFileSync(join(directory, '.claude-plugin', 'plugin.json'), '{not json')
    const err = capture()
    const code = await run(['--version', '0.3.0', '--fixture', directory], { verify: async () => assert.fail('must not verify'), out: capture(), err })
    assert.equal(code, 2)
    assert.match(err.text, /not JSON/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('run: a usage typo is exit 2, not a defaulted check', async () => {
  for (const argv of [['--version'], ['--fixture'], ['--wat']]) {
    const err = capture()
    const code = await run(argv, { verify: async () => assert.fail('must not verify'), out: capture(), err })
    assert.equal(code, 2)
    assert.match(err.text, /verify-release: /)
  }
})

test('run: a directory that is not a plugin is exit 2 with the reason', async () => {
  const err = capture()
  const code = await run(['--fixture', join(tmpdir(), 'not-a-plugin-here')], { verify: async () => assert.fail('must not verify'), out: capture(), err })
  assert.equal(code, 2)
  assert.match(err.text, /is not a Claude Code plugin directory \(no \.claude-plugin\/plugin\.json\)/)
})

test('run: --json carries both keys in both shapes', async () => {
  const ok = capture()
  await run(['--json'], { verify: async () => ({ ok: true, version: '0.3.0', failures: [], notes: ['x'] }), out: ok, err: capture() })
  assert.deepEqual(JSON.parse(ok.text), { ok: true, version: '0.3.0', notes: ['x'], failures: [] })

  const bad = capture()
  await run(['--json'], { verify: async () => ({ ok: false, version: '0.3.0', failures: ['x'], notes: [] }), out: bad, err: capture() })
  assert.deepEqual(JSON.parse(bad.text), { ok: false, version: '0.3.0', failures: ['x'], notes: [] })
})
