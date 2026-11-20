// compileEntries is the seam between the lock + scope replay and the loader.
// Its two invariants: children come from `emitPlugin` (never a second emitter),
// and ids are the install layer's dialect-qualified, profile-global form.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin, GROUP_PLUGIN, mangleId } from '../../dsh-anyplugin-emit/src/index.ts'
import { compileEntries, compileReport } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const workspace = mkdtempSync(join(tmpdir(), 'anyplugin-compile-'))
const fixture = (name) => join(repoRoot, 'fixtures', name)
const materializers = {
  skill: pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts')).href,
}
const PIN = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`
const record = (name, directory = name, overrides = {}) => ({
  dialect: 'claude-code',
  name,
  version: '0.0.1',
  root: fixture(directory),
  dataDir: join(workspace, 'data', name),
  pin: PIN,
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

test('precedence: local disable > project enable > user enable', () => {
  const installs = lock(record('skills-only', 'claude-skills-only'))
  const id = 'claude-code:skills-only'
  const base = { materializers }

  assert.deepEqual(
    compileEntries(installs, {
      ...base,
      enablements: {
        local: { plugins: { [id]: { enabled: false, grants: [] } } },
        project: { plugins: { [id]: { enabled: true, grants: [] } } },
        user: { plugins: { [id]: { enabled: true, grants: [] } } },
      },
    }),
    [],
  )
  assert.equal(
    compileEntries(installs, {
      ...base,
      enablements: {
        project: { plugins: { [id]: { enabled: true, grants: [] } } },
        user: { plugins: { [id]: { enabled: false, grants: [] } } },
      },
    }).length,
    1,
  )
  assert.deepEqual(
    compileEntries(installs, {
      ...base,
      enablements: {
        project: { plugins: { [id]: { enabled: false, grants: [] } } },
        user: { plugins: { [id]: { enabled: true, grants: [] } } },
      },
    }),
    [],
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
  const installs = lock(record('x', 'claude-skills-only', { dialect: 'codex' }))
  const report = compileReport(installs, { materializers, enablements: enabled('codex:x') })
  assert.equal(report.entries.length, 0)
  assert.match(report.problems[0].reason, /unsupported dialect "codex"/)
})

test('compileEntries fails closed instead of dropping a per-record problem', () => {
  const installs = lock(record('x', 'claude-skills-only', { dialect: 'codex' }))
  assert.throws(
    () => compileEntries(installs, { materializers, enablements: enabled('codex:x') }),
    /compileEntries: .*unsupported dialect "codex"/,
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
