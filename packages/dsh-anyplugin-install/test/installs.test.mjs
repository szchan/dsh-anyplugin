// The lock file is the only persistence for installs (AGENTS.md §3.4), so the
// reader must be strict: a file it cannot fully understand is rejected with a
// reason instead of being repaired into a smaller install set.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import {
  INSTALLS_SCHEMA,
  InstallsFileError,
  parseInstalls,
  readInstalls,
  serializeInstalls,
  validateInstalls,
  writeInstalls,
} from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'anyplugin-installs-'))
const PIN = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`
const sample = (overrides = {}) => ({
  dialect: 'claude-code',
  name: 'skills-only',
  version: '0.0.1',
  root: join(dir, 'artifact'),
  dataDir: join(dir, 'data'),
  pin: PIN,
  ...overrides,
})
const lock = (...plugins) => ({ schema: INSTALLS_SCHEMA, plugins })

test('serialize → parse round-trips every field and sorts by identity', () => {
  const installs = lock(
    sample({ name: 'zeta', source: 'plugin-dir:zeta' }),
    sample({ name: 'alpha' }),
  )
  const parsed = parseInstalls(serializeInstalls(installs), 'installs.yml')
  assert.deepEqual(parsed, lock(sample({ name: 'alpha' }), sample({ name: 'zeta', source: 'plugin-dir:zeta' })))
})

test('write → read round-trips on disk; a missing file is an empty lock', () => {
  const file = join(dir, 'profile', 'installs.yml')
  const installs = lock(sample())
  writeInstalls(file, installs)
  assert.deepEqual(readInstalls(file), installs)
  assert.deepEqual(readInstalls(join(dir, 'never-written.yml')), lock())
  assert.match(readFileSync(file, 'utf8'), /^# dsh-anyplugin installs/)
})

test('the canonical form is schema, then one record per field, all quoted', () => {
  const text = serializeInstalls(lock(sample()))
  assert.equal(
    text,
    [
      '# dsh-anyplugin installs — generated; edit through the installer.',
      'schema: "dsh-anyplugin/installs@1"',
      'plugins:',
      '  - dialect: "claude-code"',
      '    name: "skills-only"',
      '    version: "0.0.1"',
      `    root: ${JSON.stringify(join(dir, 'artifact'))}`,
      `    dataDir: ${JSON.stringify(join(dir, 'data'))}`,
      `    pin: "${PIN}"`,
      '',
    ].join('\n'),
  )
})

const malformed = [
  ['empty file', '', /empty file/],
  ['missing schema', 'plugins: []\n', /expected `schema:/],
  ['unsupported schema', 'schema: "dsh-anyplugin/installs@2"\nplugins: []\n', /unsupported schema/],
  ['no plugins line', 'schema: "dsh-anyplugin/installs@1"\n', /expected `plugins:`/],
  ['unquoted value', 'schema: "dsh-anyplugin/installs@1"\nplugins:\n  - dialect: "claude-code"\n    name: skills-only\n', /double-quoted/],
  ['unknown field', 'schema: "dsh-anyplugin/installs@1"\nplugins:\n  - dialect: "claude-code"\n    name: "x"\n    version: "1"\n    root: "/a"\n    dataDir: "/b"\n    pin: "claude-code@1"\n    license: "MIT"\n', /unknown field "license"/],
  ['missing field', 'schema: "dsh-anyplugin/installs@1"\nplugins:\n  - dialect: "claude-code"\n    name: "x"\n    version: "1"\n    root: "/a"\n    pin: "claude-code@1"\n', /missing required field "dataDir"/],
  ['relative root', 'schema: "dsh-anyplugin/installs@1"\nplugins:\n  - dialect: "claude-code"\n    name: "x"\n    version: "1"\n    root: "relative"\n    dataDir: "/b"\n    pin: "claude-code@1"\n', /absolute path/],
  ['colon in name', serializeInstalls(lock(sample())).replace('name: "skills-only"', 'name: "a:b"'), /bare plugin name/],
  [
    'records after an empty list',
    'schema: "dsh-anyplugin/installs@1"\nplugins: []\n  - dialect: "claude-code"\n    name: "x"\n    version: "1"\n    root: "/a"\n    dataDir: "/b"\n    pin: "claude-code@1"\n',
    /cannot be followed by plugin records/,
  ],
]

for (const [label, text, reason] of malformed) {
  test(`rejects a malformed lock: ${label}`, () => {
    assert.throws(
      () => parseInstalls(text, 'installs.yml'),
      (error) => {
        assert.ok(error instanceof InstallsFileError)
        assert.match(error.reason, reason)
        assert.equal(error.file, 'installs.yml')
        assert.equal(typeof error.line, 'number')
        assert.match(error.message, /^installs\.yml:\d+: /)
        return true
      },
    )
  })
}

test('a duplicate identity is rejected, not merged', () => {
  const duplicate = lock(sample(), sample({ root: join(dir, 'other') }))
  assert.throws(() => validateInstalls(duplicate), /duplicate plugin "claude-code:skills-only"/)
  const text = serializeInstalls(lock()).replace(
    'plugins: []',
    `plugins:\n  - dialect: "claude-code"\n    name: "x"\n    version: "1"\n    root: "/a"\n    dataDir: "/b"\n    pin: "claude-code@1"\n  - dialect: "claude-code"\n    name: "x"\n    version: "2"\n    root: "/c"\n    dataDir: "/d"\n    pin: "claude-code@1"`,
  )
  assert.throws(() => parseInstalls(text), /duplicate plugin "claude-code:x"/)
})

test('writeInstalls refuses invalid input before touching the file', () => {
  const file = join(dir, 'refuse', 'installs.yml')
  const valid = lock(sample())
  writeInstalls(file, valid)
  const before = readFileSync(file, 'utf8')
  const invalid = { schema: 'nope', plugins: [] }
  assert.throws(() => writeInstalls(file, invalid), /unsupported schema/)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a hand-built record must be all strings and known fields', () => {
  assert.throws(
    () => validateInstalls(lock({ ...sample(), version: 1 })),
    /"version" must be a string/,
  )
  assert.throws(() => validateInstalls(lock({ ...sample(), license: 'MIT' })), /unknown field "license"/)
})
