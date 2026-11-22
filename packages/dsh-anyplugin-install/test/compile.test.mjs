// compileEntries is the seam between the lock + scope replay and the loader.
// Its two invariants: children come from `emitPlugin` (never a second emitter),
// and ids are the install layer's dialect-qualified, profile-global form.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { monitorClientText } from '../../dsh-anyplugin-dialect-claude-code/src/monitor-client-text.ts'
import { AGENT_PLUGINS_PIN, readCodexPlugin } from '../../dsh-anyplugin-dialect-codex/src/index.ts'
import { emitPlugin, GROUP_PLUGIN, mangleId } from '../../dsh-anyplugin-emit/src/index.ts'
import { compileEntries, compileReport } from '../src/index.ts'
import { emptyGrants, grantFor } from '../../dsh-anyplugin-trust/src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const workspace = mkdtempSync(join(tmpdir(), 'anyplugin-compile-'))
const fixture = (name) => join(repoRoot, 'fixtures', name)
const materializers = {
  skill: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href,
}
const PIN = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`
const CODEX_PIN = `${AGENT_PLUGINS_PIN.tool}@${AGENT_PLUGINS_PIN.version}`
const record = (name, directory = name, overrides = {}) => ({
  dialect: 'claude-code',
  name,
  version: '0.0.1',
  root: fixture(directory),
  dataDir: join(workspace, 'data', name),
  pin: PIN,
  ...overrides,
})
const codexRecord = (name, directory = name, overrides = {}) => ({
  dialect: 'codex',
  name,
  version: '1.0.0',
  root: fixture(directory),
  dataDir: join(workspace, 'data', name),
  pin: CODEX_PIN,
  ...overrides,
})
const lock = (...plugins) => ({ schema: 'dsh-anyplugin/installs@1', plugins })
const enabled = (id, scope = 'user') => ({ [scope]: { plugins: { [id]: { enabled: true, grants: [] } } } })
const scopeOf = (id) => mangleId(id)

test('one group per enabled plugin with an emittable surface, with a dialect-qualified id', () => {
  const entries = compileEntries(lock(record('skills-only', 'claude-skills-only')), {
    materializers,
    enablements: enabled('claude-code:skills-only'),
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, `anyplugin.${scopeOf('claude-code:skills-only')}`)
  assert.equal(entries[0].name, GROUP_PLUGIN)
  assert.equal(entries[0].group, true)
  assert.deepEqual(
    entries[0].config.map((child) => child.id),
    [`anyplugin.${scopeOf('claude-code:skills-only')}#skill`],
  )
})

test('children are exactly what emitPlugin produced, with ids qualified', () => {
  const installs = lock(record('skills-only', 'claude-skills-only'))
  const compiled = compileEntries(installs, {
    materializers,
    enablements: enabled('claude-code:skills-only'),
  })[0]
  const ir = readClaudePlugin(fixture('claude-skills-only'))
  const emitted = emitPlugin(ir, { materializers })
  assert.ok(emitted.entry)
  const scope = scopeOf('claude-code:skills-only')
  assert.deepEqual(compiled, {
    ...emitted.entry,
    id: `anyplugin.${scope}`,
    config: emitted.entry.config.map((child) => ({ ...child, id: `anyplugin.${scope}#${child.id}` })),
  })
})

test('the codex dialect resolves through the registry and shares the one emitter', () => {
  const installs = lock(codexRecord('codex-portable', 'codex-portable'))
  const compiled = compileEntries(installs, {
    materializers,
    enablements: enabled('codex:codex-portable'),
  })[0]
  const ir = readCodexPlugin(fixture('codex-portable'))
  assert.equal(ir.pin.tool, AGENT_PLUGINS_PIN.tool)
  const emitted = emitPlugin(ir, { materializers })
  assert.ok(emitted.entry)
  const scope = scopeOf('codex:codex-portable')
  assert.equal(compiled.id, `anyplugin.${scope}`)
  assert.deepEqual(compiled, {
    ...emitted.entry,
    id: `anyplugin.${scope}`,
    config: emitted.entry.config.map((child) => ({ ...child, id: `anyplugin.${scope}#${child.id}` })),
  })
})

test('a lock row must name the pin its own dialect reads', () => {
  const id = 'codex:codex-portable'
  const wrongVersion = compileReport(lock(codexRecord('codex-portable', 'codex-portable', { pin: 'agent-plugins@0.9.0' })), {
    materializers,
    enablements: enabled(id),
  })
  assert.equal(wrongVersion.entries.length, 0)
  assert.match(
    wrongVersion.problems[0].reason,
    /installed against pin "agent-plugins@0\.9\.0", this build reads "agent-plugins@1\.0\.0"/,
  )

  // The Claude pin is a different dialect's pin; naming it here is a mismatch,
  // not a synonym.
  const claudePin = compileReport(lock(codexRecord('codex-portable', 'codex-portable', { pin: PIN })), {
    materializers,
    enablements: enabled(id),
  })
  assert.equal(claudePin.entries.length, 0)
  assert.match(claudePin.problems[0].reason, /this build reads "agent-plugins@1\.0\.0"/)
})

test('precedence: local disable > project enable > user enable', () => {
  const installs = lock(record('skills-only', 'claude-skills-only'), codexRecord('codex-portable', 'codex-portable'))
  const claudeId = 'claude-code:skills-only'
  const codexId = 'codex:codex-portable'
  const base = { materializers }
  const claudeEntry = `anyplugin.${scopeOf(claudeId)}`
  const codexEntry = `anyplugin.${scopeOf(codexId)}`
  const on = { enabled: true, grants: [] }
  const off = { enabled: false, grants: [] }
  const layers = (local, project, user) => ({ local: { plugins: local }, project: { plugins: project }, user: { plugins: user } })

  // A local disable beats project + user enables, per record and per dialect.
  assert.deepEqual(
    compileEntries(installs, {
      ...base,
      enablements: layers({ [claudeId]: off }, { [claudeId]: on, [codexId]: on }, { [codexId]: on }),
    }).map((entry) => entry.id),
    [codexEntry],
  )
  assert.deepEqual(
    compileEntries(installs, {
      ...base,
      enablements: layers({ [codexId]: off }, { [claudeId]: on, [codexId]: on }, { [codexId]: on }),
    }).map((entry) => entry.id),
    [claudeEntry],
  )

  // A project disable beats a user enable; a project enable beats a user disable.
  assert.deepEqual(
    compileEntries(installs, {
      ...base,
      enablements: layers({}, { [codexId]: off }, { [codexId]: on }),
    }),
    [],
  )
  assert.deepEqual(
    compileEntries(installs, {
      ...base,
      enablements: layers({}, { [codexId]: on }, { [codexId]: off }),
    }).map((entry) => entry.id),
    [codexEntry],
  )

  assert.deepEqual(compileEntries(installs, { ...base, enablements: {} }), [], 'no mention is inert')
})

test('a disabled plugin is not read at all', () => {
  const installs = lock(record('gone', undefined, { root: '/nonexistent/anyplugin-artifact' }))
  const entries = compileEntries(installs, {
    materializers,
    enablements: { user: { plugins: { 'claude-code:gone': { enabled: false, grants: [] } } } },
  })
  assert.deepEqual(entries, [])
})

test('a plugin with no emittable surface produces no empty group', () => {
  const installs = lock(record('agents-fixture', 'claude-agents'))
  const entries = compileEntries(installs, {
    materializers,
    enablements: enabled('claude-code:agents-fixture'),
  })
  assert.deepEqual(entries, [])
})

test('entries are sorted by identity, independent of lock order', () => {
  const installs = lock(
    record('skills-only', 'claude-skills-only'),
    record('commands-flat', 'claude-commands-flat'),
  )
  const entries = compileEntries(installs, {
    materializers,
    enablements: {
      user: {
        plugins: {
          'claude-code:skills-only': { enabled: true, grants: [] },
          'claude-code:commands-flat': { enabled: true, grants: [] },
        },
      },
    },
  })
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [`anyplugin.${scopeOf('claude-code:commands-flat')}`, `anyplugin.${scopeOf('claude-code:skills-only')}`],
  )
})

test('the lock pin must be the pin this build reads against', () => {
  const installs = lock(record('skills-only', 'claude-skills-only', { pin: 'claude-code@2.1.321' }))
  const report = compileReport(installs, { materializers, enablements: enabled('claude-code:skills-only') })
  assert.equal(report.entries.length, 0)
  assert.match(report.problems[0].reason, /installed against pin "claude-code@2\.1\.321"/)
})

test('the artifact must declare the name the lock recorded', () => {
  const installs = lock(record('other', 'claude-skills-only'))
  const report = compileReport(installs, { materializers, enablements: enabled('claude-code:other') })
  assert.equal(report.entries.length, 0)
  assert.match(report.problems[0].reason, /declares "skills-only"/)
})

test('an unknown dialect is rejected, not guessed', () => {
  // `constructor` is a legal identifier (the lock file grammar accepts it) and
  // an inherited `Object.prototype` key, so it must still be rejected as an
  // unsupported dialect rather than crash while reading `.pin.tool`.
  for (const dialect of ['cursor', 'constructor']) {
    const installs = lock(record('x', 'claude-skills-only', { dialect }))
    const report = compileReport(installs, { materializers, enablements: enabled(`${dialect}:x`) })
    assert.equal(report.entries.length, 0)
    assert.match(
      report.problems[0].reason,
      new RegExp(`unsupported dialect "${dialect}" \\(installed dialects: claude-code, codex\\)`),
    )
  }
})

test('compileEntries fails closed instead of dropping a per-record problem', () => {
  for (const dialect of ['cursor', 'constructor']) {
    const installs = lock(record('x', 'claude-skills-only', { dialect }))
    assert.throws(
      () => compileEntries(installs, { materializers, enablements: enabled(`${dialect}:x`) }),
      new RegExp(`compileEntries: .*unsupported dialect "${dialect}"`),
    )
  }
})

test('a refused monitors declaration is unsupported while its sibling skill is emitted', () => {
  // The pinned client does not refuse the plugin: `plugin list` reports it as
  // loaded with errors, and `plugin details` still serves the skill. Refusing
  // the whole plugin here would drop a component the host keeps, so the bad
  // declaration becomes an `unsupported` row and the skill still compiles.
  const id = 'claude-code:monitors-bad-key'
  const installs = lock(record('monitors-bad-key', 'claude-monitors-bad-key'))
  const ir = readClaudePlugin(fixture('claude-monitors-bad-key'))
  const refusals = ir.unsupported.filter((entry) => entry.surface === 'monitors')
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].annotation.fidelity, 'unsupported')
  assert.ok(
    refusals[0].annotation.reason.includes(monitorClientText('fileUnknownKey', { key: 'trigger' })),
    'the unsupported reason quotes the captured file-shaped client line',
  )
  assert.match(refusals[0].annotation.reason, /loaded with errors/)
  assert.deepEqual(ir.skills.map((skill) => skill.name), ['innocent'])

  const report = compileReport(installs, { materializers, enablements: enabled(id) })
  assert.deepEqual(report.problems, [])
  assert.equal(report.entries.length, 1)
  assert.deepEqual(
    report.entries[0].config.map((child) => child.id),
    [`anyplugin.${scopeOf(id)}#skill`],
  )
  const entries = compileEntries(installs, { materializers, enablements: enabled(id) })
  assert.equal(entries.length, 1)
})

test('no refused monitors fixture becomes a compile problem', () => {
  // The other two fixtures carry no sibling component; the plugin still
  // compiles to nothing instead of being reported as a problem or throwing.
  for (const [name, directory] of [
    ['monitors-bad-when-enum', 'claude-monitors-bad-when-enum'],
    ['monitors-bad-when-short', 'claude-monitors-bad-when-short'],
  ]) {
    const id = `claude-code:${name}`
    const installs = lock(record(name, directory))
    const report = compileReport(installs, { materializers, enablements: enabled(id) })
    assert.deepEqual(report.problems, [], `${directory}: not a compile problem`)
    assert.deepEqual(report.entries, [], `${directory}: no carried surface emits no group`)
    assert.deepEqual(
      compileEntries(installs, { materializers, enablements: enabled(id) }),
      [],
    )
  }
})

test('an invalid inline monitors manifest is fatal through CompileReport', () => {
  // The client refuses a manifest whose own `monitors` value is invalid: the
  // plugin never loads and `plugin details` lists nothing. That is the one
  // monitors shape that stays fatal, through the same path a broken manifest
  // takes, and it must emit nothing.
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-monitors-inline-'))
  try {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'monitors-inline',
        version: '0.0.1',
        monitors: [{ name: 'beat', command: 'node monitor.mjs', description: 'x', trigger: 'always' }],
      }),
    )
    const id = 'claude-code:monitors-inline'
    const installs = lock(record('monitors-inline', 'monitors-inline', { root: dir }))
    const report = compileReport(installs, { materializers, enablements: enabled(id) })
    assert.deepEqual(report.entries, [])
    assert.equal(report.problems.length, 1)
    assert.match(report.problems[0].reason, /invalid monitors declaration/)
    assert.match(report.problems[0].reason, /Unrecognized key: "trigger"/)
    assert.match(report.problems[0].reason, /refuses the manifest/)
    assert.throws(
      () => compileEntries(installs, { materializers, enablements: enabled(id) }),
      /compileEntries: invalid monitors declaration/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a valid monitors declaration emits the sibling skill and no monitor row', () => {
  const id = 'claude-code:monitors-valid'
  const entries = compileEntries(lock(record('monitors-valid', 'claude-monitors-valid')), {
    materializers,
    enablements: enabled(id),
  })
  assert.equal(entries.length, 1)
  assert.deepEqual(
    entries[0].config.map((child) => child.id),
    [`anyplugin.${scopeOf(id)}#skill`],
  )
})

test('projectDir reads the three scope files when enablements is omitted', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'anyplugin-scopes-'))
  const home = mkdtempSync(join(tmpdir(), 'anyplugin-home-'))
  mkdirSync(join(projectDir, '.dsh'), { recursive: true })
  mkdirSync(join(home, 'anyplugin'), { recursive: true })
  writeFileSync(
    join(projectDir, '.dsh', 'anyplugin.yml'),
    'plugins:\n  claude-code:skills-only: { enabled: true }\n',
  )
  writeFileSync(join(home, 'anyplugin', 'enabled.yml'), 'plugins:\n  claude-code:skills-only: { enabled: false }\n')
  const installs = lock(record('skills-only', 'claude-skills-only'))

  assert.equal(compileEntries(installs, { materializers, projectDir, home }).length, 1)
  writeFileSync(
    join(projectDir, '.dsh', 'anyplugin.local.yml'),
    'plugins:\n  claude-code:skills-only: { enabled: false }\n',
  )
  assert.deepEqual(compileEntries(installs, { materializers, projectDir, home }), [])

  assert.throws(
    () => compileEntries(installs, { materializers }),
    /projectDir is required/,
  )
})

test('a mod the lock does not record is refused, not compiled, even with a grant', () => {
  const modsRoot = join(repoRoot, 'packages', 'dsh-anyplugin-dialect-claude-code', 'test', 'fixtures', 'claude-mods')
  const ir = readClaudePlugin(modsRoot)
  const grants = grantFor(ir, emptyGrants(), 'mod:hooks/register.ts', { scope: 'user' })
  const modMaterializers = {
    ...materializers,
    hooks: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-hook', 'src', 'index.ts')).href,
  }
  // 0.1.0-shaped: the same record, no `mods` paragraph.
  const legacy = {
    schema: 'dsh-anyplugin/installs@1',
    plugins: [{ ...record('mods'), root: modsRoot, pin: `${ir.pin.tool}@${ir.pin.version}` }],
  }

  const refused = compileReport(legacy, {
    materializers: modMaterializers,
    enablements: enabled('claude-code:mods'),
    grants,
    requireRecordedMods: true,
  })
  assert.deepEqual(refused.entries, [])
  assert.equal(refused.refusals.length, 1)
  assert.equal(refused.refusals[0].code, 'not-recorded')
  assert.equal(refused.refusals[0].name, 'hooks/register.ts')
  assert.match(refused.refusals[0].reason, /not-recorded: the lock does not record this module tree/)
  assert.ok(refused.decisions[0].allowed.includes('mod:hooks/register.ts'))

  // The safe value is the default (M2): omitting the flag must refuse. A
  // mutation of `=== false` to `!== true` compiles the tree and reddens this.
  const defaulted = compileReport(legacy, {
    materializers: modMaterializers,
    enablements: enabled('claude-code:mods'),
    grants,
  })
  assert.deepEqual(defaulted.entries, [])
  assert.equal(defaulted.refusals.length, 1)
  assert.equal(defaulted.refusals[0].code, 'not-recorded')

  // A record that exists but pins a different tree names both digests: what
  // the grant authorized now, and what the lock recorded.
  const zero = `sha256:${'0'.repeat(64)}`
  const stale = {
    schema: 'dsh-anyplugin/installs@2',
    plugins: [
      {
        ...record('mods'),
        root: modsRoot,
        pin: `${ir.pin.tool}@${ir.pin.version}`,
        mods: [
          {
            entry: 'hooks/register.ts',
            rootRelative: 'hooks',
            mode: 'file',
            artifactHash: zero,
            files: [{ path: 'hooks/register.ts', sha256: zero, bytes: 1 }],
          },
        ],
      },
    ],
  }
  const staleReport = compileReport(stale, {
    materializers: modMaterializers,
    enablements: enabled('claude-code:mods'),
    grants,
  })
  assert.deepEqual(staleReport.entries, [])
  assert.equal(staleReport.refusals.length, 1)
  assert.match(staleReport.refusals[0].reason, /granted tree: sha256:[0-9a-f]{64}/)
  assert.match(staleReport.refusals[0].reason, new RegExp(`the recorded tree is ${zero}`))

  // The install path is creating the record, so it compiles the granted tree.
  const install = compileReport(legacy, {
    materializers: modMaterializers,
    enablements: enabled('claude-code:mods'),
    grants,
    requireRecordedMods: false,
  })
  assert.equal(install.entries.length, 1)
  const hook = install.entries[0].config.find((child) => child.id.endsWith('#hook'))
  assert.equal(hook.config.mods[0].entry, 'hooks/register.ts')
})
