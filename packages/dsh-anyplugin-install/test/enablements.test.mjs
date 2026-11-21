// D2: installation is profile-global, enablement is layered per workspace.
// Precedence is local > project > user, and the first layer that *mentions* a
// plugin wins even when it disables it.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  InstallsFileError,
  enablementPaths,
  parseEnablements,
  readEnablements,
  resolveEnablement,
  serializeEnablements,
  writeEnablements,
} from '../src/index.ts'

const id = 'claude-code:skills-only'
const layer = (plugins) => ({ plugins })

test('local disable beats project enable beats user enable', () => {
  const enablements = {
    local: layer({ [id]: { enabled: false, grants: [] } }),
    project: layer({ [id]: { enabled: true, grants: [] } }),
    user: layer({ [id]: { enabled: true, grants: [] } }),
  }
  assert.deepEqual(resolveEnablement(id, enablements), { enabled: false, scope: 'local', grants: [] })

  delete enablements.local
  assert.deepEqual(resolveEnablement(id, enablements), { enabled: true, scope: 'project', grants: [] })

  delete enablements.project
  assert.deepEqual(resolveEnablement(id, enablements), { enabled: true, scope: 'user', grants: [] })
})

test('project disable beats user enable, and no mention is inert', () => {
  assert.deepEqual(
    resolveEnablement(id, {
      project: layer({ [id]: { enabled: false, grants: [] } }),
      user: layer({ [id]: { enabled: true, grants: [] } }),
    }),
    { enabled: false, scope: 'project', grants: [] },
  )
  assert.deepEqual(resolveEnablement(id, {}), { enabled: false, scope: null, grants: [] })
  assert.deepEqual(resolveEnablement(id, { user: layer({ 'claude-code:other': { enabled: true, grants: [] } }) }), {
    enabled: false,
    scope: null,
    grants: [],
  })
})

test('the deciding layer carries the grants; they are not merged across layers', () => {
  assert.deepEqual(
    resolveEnablement(id, {
      local: layer({ [id]: { enabled: true, grants: ['exec:hooks'] } }),
      user: layer({ [id]: { enabled: true, grants: ['exec:mcp', 'exec:hooks'] } }),
    }),
    { enabled: true, scope: 'local', grants: ['exec:hooks'] },
  )
})

test('a layer file is a strict, tiny subset; malformed input is rejected with a line', () => {
  assert.deepEqual(
    parseEnablements(
      ['# comment', 'plugins:', `  ${id}: { enabled: true, grants: [exec:hooks, exec:mcp] }`, ''].join('\n'),
      'anyplugin.yml',
    ),
    { plugins: { [id]: { enabled: true, grants: ['exec:hooks', 'exec:mcp'] } } },
  )
  const bad = [
    ['', /empty file/],
    ['not plugins:\n', /expected.*plugins:/],
    ['plugins:\n  claude-code:x: { enabled: yes }\n', /expected `  <dialect>/],
    ['plugins:\n  Claude-Code:x: { enabled: true }\n', /not a <dialect>/],
    [`plugins:\n  ${id}: { enabled: true }\n  ${id}: { enabled: false }\n`, /duplicate plugin/],
    ['plugins:\n  claude-code:x: { enabled: true, grants: [exec: hooks] }\n', /bare capability names/],
    ['plugins: []\n  claude-code:x: { enabled: true }\n', /cannot be followed by plugin entries/],
  ]
  for (const [text, reason] of bad) {
    assert.throws(
      () => parseEnablements(text, 'anyplugin.yml'),
      (error) => {
        assert.match(error.reason, reason)
        assert.match(error.message, /^anyplugin\.yml:\d+: /)
        return true
      },
    )
  }
})

test('readEnablements reads only the files that exist and resolves their paths', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'anyplugin-project-'))
  const home = mkdtempSync(join(tmpdir(), 'anyplugin-home-'))
  const paths = enablementPaths({ projectDir, home })
  assert.equal(paths.local, join(projectDir, '.dsh', 'anyplugin.local.yml'))
  assert.equal(paths.project, join(projectDir, '.dsh', 'anyplugin.yml'))
  assert.equal(paths.user, join(home, 'anyplugin', 'enabled.yml'))

  assert.deepEqual(readEnablements({ projectDir, home }), {})
  mkdirSync(join(projectDir, '.dsh'), { recursive: true })
  mkdirSync(join(home, 'anyplugin'), { recursive: true })
  writeFileSync(paths.project, `plugins:\n  ${id}: { enabled: true }\n`)
  writeFileSync(paths.user, 'plugins:\n  claude-code:other: { enabled: true }\n')
  assert.deepEqual(readEnablements({ projectDir, home }), {
    project: layer({ [id]: { enabled: true, grants: [] } }),
    user: layer({ 'claude-code:other': { enabled: true, grants: [] } }),
  })
})

test('serializeEnablements is canonical: sorted ids, one line per plugin, grants preserved', () => {
  assert.equal(
    serializeEnablements({ plugins: {} }),
    '# dsh-anyplugin enablement — generated; edit through the installer.\nplugins: []\n',
  )
  const text = serializeEnablements({
    plugins: {
      'claude-code:zeta': { enabled: false, grants: [] },
      'claude-code:alpha': { enabled: true, grants: ['exec:hooks', 'exec:mcp'] },
    },
  })
  assert.equal(
    text,
    [
      '# dsh-anyplugin enablement — generated; edit through the installer.',
      'plugins:',
      '  claude-code:alpha: { enabled: true, grants: [exec:hooks, exec:mcp] }',
      '  claude-code:zeta: { enabled: false }',
      '',
    ].join('\n'),
  )
  assert.deepEqual(parseEnablements(text, 'enabled.yml'), {
    plugins: {
      'claude-code:alpha': { enabled: true, grants: ['exec:hooks', 'exec:mcp'] },
      'claude-code:zeta': { enabled: false, grants: [] },
    },
  })
})

test('serializeEnablements rejects what parseEnablements would reject', () => {
  for (const plugins of [
    { 'Claude-Code:x': { enabled: true, grants: [] } },
    { 'claude-code:x': { enabled: 'yes', grants: [] } },
    { 'claude-code:x': { enabled: true, grants: ['exec: hooks'] } },
  ]) {
    assert.throws(() => serializeEnablements({ plugins }), (error) => error instanceof InstallsFileError)
  }
})

test('writeEnablements is a whole-file atomic replace, not an append', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-enablement-'))
  const file = join(dir, 'nested', 'enabled.yml')
  writeEnablements(file, { plugins: { [id]: { enabled: true, grants: [] } } })
  assert.equal(
    readFileSync(file, 'utf8'),
    '# dsh-anyplugin enablement — generated; edit through the installer.\nplugins:\n  claude-code:skills-only: { enabled: true }\n',
  )
  writeEnablements(file, { plugins: { [id]: { enabled: false, grants: ['exec:hooks'] } } })
  assert.equal(
    readFileSync(file, 'utf8'),
    '# dsh-anyplugin enablement — generated; edit through the installer.\nplugins:\n  claude-code:skills-only: { enabled: false, grants: [exec:hooks] }\n',
  )
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false)
})
