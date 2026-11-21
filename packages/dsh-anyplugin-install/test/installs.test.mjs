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
  INSTALLS_SCHEMA_V1,
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
      'schema: "dsh-anyplugin/installs@2"',
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
  ['unsupported schema', 'schema: "dsh-anyplugin/installs@3"\nplugins: []\n', /unsupported schema/],
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

const mod = (overrides = {}) => ({
  entry: 'hooks/register.ts',
  rootRelative: 'hooks',
  mode: 'composite',
  artifactHash: 'sha256:' + 'a'.repeat(64),
  files: [
    { path: join(dir, 'artifact', 'hooks', 'register.ts'), sha256: 'sha256:' + 'b'.repeat(64), bytes: 42 },
    { path: join(dir, 'artifact', 'hooks', 'views', 'pane.ts'), sha256: 'sha256:' + 'c'.repeat(64), bytes: 7 },
  ],
  ...overrides,
})

test('a @2 lock round-trips a mod tree: entry, root, mode, digest, and every file', () => {
  const installs = lock(sample({ mods: [mod()] }))
  const text = serializeInstalls(installs)
  assert.match(text, /\n    mods:\n      - entry: "hooks\/register\.ts"\n        rootRelative: "hooks"\n        mode: "composite"/)
  assert.match(text, /\n          - path: .*register\.ts"\n            sha256: "sha256:b{64}"\n            bytes: "42"/)
  assert.deepEqual(parseInstalls(text, 'installs.yml'), installs)
})

test('a 0.1.0 lock still loads; @1 means no mods and writing normalizes to @2', () => {
  const text = serializeInstalls(lock(sample())).replace('installs@2', 'installs@1')
  const parsed = parseInstalls(text, 'installs.yml')
  assert.equal(parsed.schema, INSTALLS_SCHEMA)
  assert.deepEqual(parsed.plugins, [sample()])
  assert.equal(parsed.plugins[0].mods, undefined)
})

test('a @2 lock carrying mods is refused by a 0.1.0 reader (downgrade is an error, not silent data loss)', () => {
  // The 0.1.0 reader is exactly this reader minus the mods branch: it gates on
  // the @1 schema line and rejects any field it does not know. Flipping only
  // the schema line replays that second gate, so the field's rejection is
  // exercised with code, not asserted by prose.
  const text = serializeInstalls(lock(sample({ mods: [mod()] }))).replace('installs@2', 'installs@1')
  assert.throws(
    () => parseInstalls(text, 'installs.yml'),
    (error) => {
      assert.ok(error instanceof InstallsFileError)
      assert.match(error.reason, /unknown field "mods"/)
      assert.equal(error.line, 10)
      return true
    },
  )
})

test('a hand-built mod must be a tree under the record root with one hash per file', () => {
  const cases = [
    [{ ...mod(), entry: 'register.ts' }, /must be inside "rootRelative"/],
    [{ ...mod(), mode: 'file' }, /mode" is "file" but/],
    [{ ...mod(), mode: 'single' }, /must be "file" or "composite"/],
    [{ ...mod(), artifactHash: 'sha256:abc' }, /artifactHash" must match/],
    [{ ...mod(), files: [mod().files[0], mod().files[0]] }, /duplicate mod file/],
    [{ ...mod(), files: [{ ...mod().files[0], path: '/elsewhere/register.ts' }, mod().files[1]] }, /outside the record's "root"/],
    [{ ...mod(), files: [{ ...mod().files[0], bytes: -1 }, mod().files[1]] }, /bytes" must be a non-negative integer/],
  ]
  for (const [value, reason] of cases) {
    assert.throws(() => validateInstalls(lock(sample({ mods: [value] }))), reason)
  }
})

test('a hand-built record must be all strings and known fields', () => {
  assert.throws(
    () => validateInstalls(lock({ ...sample(), version: 1 })),
    /"version" must be a string/,
  )
  assert.throws(() => validateInstalls(lock({ ...sample(), license: 'MIT' })), /unknown field "license"/)
})

test('a marketplace source is a JSON object inside the canonical quoted string', () => {
  const source = { marketplace: 'local-marketplace', entry: 'local-hello', version: '0.1.0' }
  const text = serializeInstalls(lock(sample({ source })))
  assert.match(
    text,
    /    source: "\{\\"marketplace\\":\\"local-marketplace\\",\\"entry\\":\\"local-hello\\",\\"version\\":\\"0\.1\.0\\"\}"\n/u,
  )
  // The grammar did not move: one double-quoted JSON value per field (D23),
  // and the @1 tag stays, because a @1 reader already accepted this value
  // (any non-empty string) and a @2 writer would have to reject every lock
  // this version writes. Additive at the parse level, not the schema level.
  assert.match(text, /schema: "dsh-anyplugin\/installs@1"/u)
  assert.deepEqual(parseInstalls(text, 'installs.yml'), lock(sample({ source })))
})

test('a legacy string source still round-trips unchanged', () => {
  const parsed = parseInstalls(serializeInstalls(lock(sample({ source: 'plugin-dir:plugins/x' }))), 'installs.yml')
  assert.equal(parsed.plugins[0].source, 'plugin-dir:plugins/x')
})

test('a structured source is validated like every other field', () => {
  const refuse = (source, pattern) =>
    assert.throws(() => validateInstalls(lock(sample({ source }))), pattern)
  refuse({ marketplace: 'm', entry: 'e', extra: 'x' }, /unknown field "source\.extra"/)
  refuse({ marketplace: 'm' }, /"source\.entry" must be a non-empty string/)
  refuse({ entry: 'e' }, /"source\.marketplace" must be a non-empty string/)
  refuse({ marketplace: 'has space', entry: 'e' }, /"source\.marketplace" must be the marketplace name/)
  refuse({ marketplace: 'm', entry: 'has:colon' }, /"source\.entry" must be a bare plugin name/)
  refuse({ marketplace: 'm', entry: 'e', version: '1 2' }, /"source\.version" must be non-empty and contain no whitespace/)
  refuse('   ', /"source" must be a non-empty string/)
  refuse('{not json', /"source" opens with "\{" but is not a JSON object/)
})
