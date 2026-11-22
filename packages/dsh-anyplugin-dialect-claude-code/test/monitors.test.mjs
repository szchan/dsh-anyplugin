// Monitors are an oracle-invisible face (S22): the pinned client validates the
// declaration, never lists it in `plugin details`, and never spawns it in a
// headless run. The declaration shape is therefore the only thing worth
// claiming, and the pinned client has two distinct verdicts on a bad one:
//
//   1. a manifest-shaped violation (the manifest's `monitors` value is not an
//      array or `"./"` path, or an inline entry is invalid) refuses the whole
//      plugin: `plugin details` lists nothing. Our compile must refuse too.
//   2. a file-shaped violation (bad JSON/content in `monitors/monitors.json`
//      or the `"./"` target, a duplicate name, an unreadable target) loads the
//      plugin with an error: `plugin list` says `✘ loaded with errors`,
//      `plugin details` still serves the other components. The declaration is
//      carried as one `unsupported` row quoting the client's error text.
//
// A valid declaration is one `planned` row citing S22; the manifest key wins
// over `monitors/monitors.json`, because reading both would report a
// declaration the client never sees.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { readClaudePlugin } from '../src/index.ts'
import { monitorClientText } from '../src/monitor-client-text.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = (name) => join(repoRoot, 'fixtures', name)
const OBSERVED = join(repoRoot, 'fixtures', 'claude-monitors-errors', 'observed')

/**
 * The client message inside one captured line. File-shaped lines are a JSON
 * error list (message field) or a plain `…: <message>` tail; a truncated line
 * yields undefined, so those shapes keep the containment-only check.
 */
function capturedClientMessage(observed) {
  const message = /\u201dmessage\u201d: \u201d(.*?)\u201d \}/.exec(observed)
  if (message) return message[1]
  const tail = /^Error: monitors load failed .*?: (.*)$/.exec(observed)
  if (tail && !tail[1].startsWith('[')) return tail[1]
  return undefined
}

const VALID = {
  name: 'beat',
  command: 'node monitor.mjs',
  description: 'Emit a heartbeat.',
}

function writePlugin(dir, manifest = {}) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'probe', version: '0.0.1', ...manifest }),
  )
  return dir
}

function withPlugin(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-monitors-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const monitorRows = (ir) => ir.pending.filter((entry) => entry.surface === 'monitors')
const monitorRefusals = (ir) => ir.unsupported.filter((entry) => entry.surface === 'monitors')

function assertOnePlannedRow(ir, sourcePath) {
  const rows = monitorRows(ir)
  assert.equal(rows.length, 1, 'a declaration produces exactly one pending row')
  assert.equal(rows[0].name, 'monitors')
  assert.equal(rows[0].sourcePath, sourcePath)
  assert.equal(rows[0].annotation.fidelity, 'planned')
  assert.match(rows[0].annotation.reason, /S22/)
  assert.match(rows[0].annotation.reason, /claude-code@2\.1\.329/)
  assert.match(rows[0].annotation.reason, /0 monitor starts/)
  assert.match(rows[0].annotation.reason, /plugin details/)
  assert.match(rows[0].annotation.reason, /\/dev\/ptmx/)
  assert.match(rows[0].annotation.reason, /D37/)
  assert.deepEqual(monitorRefusals(ir), [])
  assert.deepEqual(validateIr(ir), [])
}

function assertOneUnsupportedRow(ir, { sourcePath, detail, clientKey, clientParams, observed, dir }) {
  const rows = monitorRefusals(ir)
  assert.equal(rows.length, 1, 'a file-shaped rejection produces exactly one unsupported row')
  assert.equal(rows[0].name, 'monitors')
  assert.equal(rows[0].sourcePath, sourcePath)
  assert.equal(rows[0].annotation.fidelity, 'unsupported')
  assert.match(rows[0].annotation.reason, detail)
  // The reason must quote the captured client line verbatim, not a string this
  // code happened to emit: the table is the source of truth.
  const client = monitorClientText(clientKey, clientParams ?? {})
  if (observed) {
    // The row must quote the captured message exactly, not a prefix of it:
    // this is what makes a truncated table entry redden this test.
    const captured = capturedClientMessage(
      readFileSync(join(OBSERVED, `${observed}.txt`), 'utf8').trim(),
    )
    // Captured lines scrub the throwaway plugin path to <plugin>; the row
    // quotes the live path, so put the live root back before comparing.
    const expected = dir && captured ? captured.replaceAll('<plugin>', dir) : captured
    assert.equal(client, expected, `${observed}: table entry matches the captured client message exactly`)
  }
  assert.ok(rows[0].annotation.reason.includes(client), `reason quotes the captured client text: ${client}`)
  // Our filesystem vocabulary must not leak into the quoted reason.
  assert.doesNotMatch(rows[0].annotation.reason, /EISDIR|ENOTDIR/)
  assert.doesNotMatch(rows[0].annotation.reason, /line \d+ column|position \d+/)
  assert.match(rows[0].annotation.reason, /loaded with errors/)
  assert.match(rows[0].annotation.reason, /claude-code@2\.1\.329/)
  assert.match(rows[0].annotation.reason, /directory form/)
  assert.match(rows[0].annotation.reason, /\`rig install <dir>\`/)
  assert.match(rows[0].annotation.reason, /D37/)
  assert.deepEqual(monitorRows(ir), [])
  assert.deepEqual(validateIr(ir), [])
}

function assertManifestRefusal(fn, { detail, clientKey, clientParams }) {
  const client = monitorClientText(clientKey, clientParams ?? {})
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'MonitorsRefusal')
    assert.equal(error.kind, 'manifest')
    assert.match(error.message, /invalid monitors declaration/)
    assert.match(error.message, detail)
    assert.ok(error.message.includes(client), `message quotes the captured client text: ${client}`)
    if (clientKey === 'manifestGeneric') assert.match(error.message, /generic validation line/)
    assert.match(error.message, /refuses the manifest/)
    assert.match(error.message, /claude-code@2\.1\.329/)
    return true
  })
}

test('a valid monitors/monitors.json is one planned row citing S22', () => {
  withPlugin((dir) => {
    writePlugin(dir)
    mkdirSync(join(dir, 'monitors'))
    writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([VALID]))
    assertOnePlannedRow(readClaudePlugin(dir), 'monitors/monitors.json')
  })
})

test('an inline manifest monitors array is a declaration too', () => {
  withPlugin((dir) => {
    writePlugin(dir, { monitors: [{ ...VALID, when: 'on-skill-invoke:greet' }] })
    assertOnePlannedRow(readClaudePlugin(dir), '.claude-plugin/plugin.json')
  })
  withPlugin((dir) => {
    // The client accepts an empty array; an empty declaration is still a row.
    writePlugin(dir, { monitors: [] })
    assertOnePlannedRow(readClaudePlugin(dir), '.claude-plugin/plugin.json')
  })
})

test('a valid monitors declaration produces no unsupported row', () => {
  withPlugin((dir) => {
    writePlugin(dir, { monitors: [VALID] })
    const ir = readClaudePlugin(dir)
    assert.deepEqual(monitorRefusals(ir), [])
    assert.equal(monitorRows(ir).length, 1)
    assert.equal(ir.unsupported.some((entry) => entry.surface === 'monitors'), false)
  })
})

test('the "./"-relative manifest path form is a declaration too', () => {
  withPlugin((dir) => {
    writePlugin(dir, { monitors: './monitors/custom.json' })
    mkdirSync(join(dir, 'monitors'))
    writeFileSync(join(dir, 'monitors', 'custom.json'), JSON.stringify([VALID]))
    assertOnePlannedRow(readClaudePlugin(dir), './monitors/custom.json')
  })
})

test('the manifest key overrides monitors/monitors.json instead of merging with it', () => {
  // S22 measured the precedence: an inline-valid (or path-valid) manifest keeps
  // the plugin enabled even when the directory file is bad, so the bad file is
  // not this plugin's declaration and must not become an unsupported row.
  withPlugin((dir) => {
    writePlugin(dir, { monitors: [VALID] })
    mkdirSync(join(dir, 'monitors'))
    writeFileSync(
      join(dir, 'monitors', 'monitors.json'),
      JSON.stringify([{ ...VALID, trigger: 'always' }]),
    )
    assertOnePlannedRow(readClaudePlugin(dir), '.claude-plugin/plugin.json')
  })
  withPlugin((dir) => {
    writePlugin(dir, { monitors: './monitors/good.json' })
    mkdirSync(join(dir, 'monitors'))
    writeFileSync(join(dir, 'monitors', 'good.json'), JSON.stringify([VALID]))
    writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, trigger: 'always' }]))
    assertOnePlannedRow(readClaudePlugin(dir), './monitors/good.json')
  })
})

test('a bare monitors/ directory keeps the presence-only row', () => {
  // No declaration file is one of the shapes the client accepts silently; the
  // surface still exists, so the row stays (the bin.test ordering depends on it).
  withPlugin((dir) => {
    writePlugin(dir)
    mkdirSync(join(dir, 'monitors'))
    const rows = monitorRows(readClaudePlugin(dir))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sourcePath, 'monitors')
    assert.equal(rows[0].annotation.fidelity, 'planned')
  })
})

test('a plain monitors/ file (not a directory) is accepted', () => {
  // The client treats `monitors` as a file as `✔ loaded`; no declaration file
  // can exist under it, so the presence row is all there is to carry.
  withPlugin((dir) => {
    writePlugin(dir)
    writeFileSync(join(dir, 'monitors'), 'not a directory')
    const rows = monitorRows(readClaudePlugin(dir))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sourcePath, 'monitors')
    assert.equal(rows[0].annotation.fidelity, 'planned')
  })
})

test('no monitors declaration and no monitors/ directory produces no row', () => {
  withPlugin((dir) => {
    writePlugin(dir)
    assert.deepEqual(monitorRows(readClaudePlugin(dir)), [])
  })
})

test('monitor names are case-sensitive in the file form', () => {
  withPlugin((dir) => {
    writePlugin(dir)
    mkdirSync(join(dir, 'monitors'))
    writeFileSync(
      join(dir, 'monitors', 'monitors.json'),
      JSON.stringify([VALID, { ...VALID, name: 'SAME' }, { ...VALID, name: 'same' }]),
    )
    const ir = readClaudePlugin(dir)
    assertOnePlannedRow(ir, 'monitors/monitors.json')
  })
})

// File-shaped violations: the client loads the plugin with an error and serves
// everything else, so each becomes one `unsupported` row.
const FILE_REFUSALS = [
  {
    name: 'unknown key in the directory file',
    observed: 'file-unknown-key',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, trigger: 'always' }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]: unrecognized key "trigger" \(the accepted keys are name, command, description, when\)/,
    clientKey: 'fileUnknownKey',
    clientParams: { key: 'trigger' },
  },
  {
    name: 'when enum in the directory file',
    observed: 'file-when-enum',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, when: 'sometimes' }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not "sometimes"/,
    clientKey: 'fileWhenFormat',
    observed: 'file-when-enum',
  },
  {
    name: 'on-skill-invoke without a skill in the directory file',
    observed: 'file-when-short',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, when: 'on-skill-invoke:' }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: "on-skill-invoke:" must name a skill after the colon/,
    clientKey: 'fileWhenShort',
    observed: 'file-when-short',
  },
  {
    name: 'when is a number in the directory file',
    observed: 'file-when-number',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, when: 3 }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not a number/,
    clientKey: 'fileWhenUnion',
  },
  {
    name: 'top level is an object in the directory file',
    observed: 'file-top-object',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), '{}')
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors: must be an array of monitor declarations, not an object/,
    clientKey: 'fileNotArray',
    clientParams: { shape: 'object' },
  },
  {
    name: 'top level is null in the directory file',
    observed: 'file-top-null',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), 'null')
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors: must be an array of monitor declarations, not null/,
    clientKey: 'fileNotArray',
    clientParams: { shape: 'null' },
  },
  {
    name: 'an entry is null in the directory file',
    observed: 'file-null-entry',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([null]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]: must be an object, not null/,
    clientKey: 'fileNotObject',
    clientParams: { shape: 'null' },
  },
  {
    name: 'description is missing in the directory file',
    observed: 'file-missing-description',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(
        join(dir, 'monitors', 'monitors.json'),
        JSON.stringify([{ name: 'beat', command: 'node monitor.mjs' }]),
      )
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.description: is required and must be a non-empty string/,
    clientKey: 'fileNotString',
    clientParams: { shape: 'undefined' },
  },
  {
    name: 'name is empty in the directory file',
    observed: 'file-empty-name',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, name: '' }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.name: must be at least 1 character/,
    clientKey: 'fileTooSmall',
  },
  {
    name: 'invalid JSON in the directory file',
    observed: 'file-invalid-json',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), '[{')
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors: is not valid JSON/,
    clientKey: 'fileInvalidJson',
  },
  {
    name: 'duplicate names in the directory file',
    observed: 'file-duplicate',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(
        join(dir, 'monitors', 'monitors.json'),
        JSON.stringify([VALID, { ...VALID, description: 'second' }]),
      )
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[1\]\.name: duplicate monitor name "beat"/,
    clientKey: 'fileDuplicateName',
  },
  {
    name: 'the directory file is a directory',
    observed: 'file-is-directory',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors', 'monitors.json'), { recursive: true })
    },
    sourcePath: 'monitors/monitors.json',
    detail: /is a directory, not a declaration file/,
    clientKey: 'fileNotRegularFile',
  },
  {
    name: 'the directory file cannot be read',
    observed: 'file-unreadable',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([VALID]))
      chmodSync(join(dir, 'monitors', 'monitors.json'), 0o000)
    },
    sourcePath: 'monitors/monitors.json',
    detail: /cannot read /,
    clientKey: 'fileUnreadable',
    clientParams: (dir) => ({ path: join(dir, 'monitors', 'monitors.json') }),
  },
  {
    name: 'manifest path is missing',
    observed: 'path-missing',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/gone.json' })
    },
    sourcePath: './monitors/gone.json',
    detail: /refers to "\.\/monitors\/gone\.json", which is not a readable file/,
    clientKey: 'fileMissing',
    clientParams: (dir) => ({ path: join(dir, 'monitors', 'gone.json') }),
  },
  {
    name: 'manifest path target is a directory',
    observed: 'path-is-directory',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/target.json' })
      mkdirSync(join(dir, 'monitors', 'target.json'), { recursive: true })
    },
    sourcePath: './monitors/target.json',
    detail: /refers to "\.\/monitors\/target\.json", which is a directory/,
    clientKey: 'fileNotRegularFile',
  },
  {
    name: 'manifest path target is unreadable',
    observed: 'path-unreadable',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/locked.json' })
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'locked.json'), JSON.stringify([VALID]))
      chmodSync(join(dir, 'monitors', 'locked.json'), 0o000)
    },
    sourcePath: './monitors/locked.json',
    detail: /cannot read /,
    clientKey: 'fileUnreadable',
    clientParams: (dir) => ({ path: join(dir, 'monitors', 'locked.json') }),
  },
  {
    name: 'bad manifest path file content',
    observed: 'path-bad-content',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/custom.json' })
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'custom.json'), JSON.stringify([{ ...VALID, trigger: 'always' }]))
    },
    sourcePath: './monitors/custom.json',
    detail: /unrecognized key "trigger"/,
    clientKey: 'fileUnknownKey',
    clientParams: { key: 'trigger' },
  },
  {
    name: 'duplicate names in a manifest path file',
    observed: 'path-duplicate',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/custom.json' })
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(
        join(dir, 'monitors', 'custom.json'),
        JSON.stringify([VALID, { ...VALID, description: 'second' }]),
      )
    },
    sourcePath: './monitors/custom.json',
    detail: /monitors\[1\]\.name: duplicate monitor name "beat"/,
    clientKey: 'fileDuplicateName',
  },
]

for (const refusal of FILE_REFUSALS) {
  test(`carries ${refusal.name} as unsupported`, () => {
    withPlugin((dir) => {
      writePlugin(dir)
      refusal.setup(dir)
      assertOneUnsupportedRow(readClaudePlugin(dir), {
        ...refusal,
        dir,
        clientParams:
          typeof refusal.clientParams === 'function' ? refusal.clientParams(dir) : refusal.clientParams,
      })
    })
  })
}

// Manifest-shaped violations: the client refuses the manifest and does not
// load the plugin, so these stay fatal (the same CompileReport path a broken
// manifest takes).
const MANIFEST_REFUSALS = [
  {
    name: 'unknown key inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, interval: 5 }] })
    },
    detail: /monitors\[0\]: unrecognized key "interval"/,
    clientKey: 'manifestUnknownKey',
    clientParams: { key: 'interval' },
  },
  {
    name: 'when enum inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, when: 'sometimes' }] })
    },
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not "sometimes"/,
    clientKey: 'manifestWhenFormat',
  },
  {
    name: 'when is a number inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, when: 3 }] })
    },
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not a number/,
    clientKey: 'manifestGeneric',
  },
  {
    name: 'missing description inline',
    setup: (dir) => {
      const { description, ...entry } = VALID
      writePlugin(dir, { monitors: [entry] })
    },
    detail: /monitors\[0\]\.description: is required and must be a non-empty string/,
    clientKey: 'manifestGeneric',
  },
  {
    name: 'non-string name inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, name: 7 }] })
    },
    detail: /monitors\[0\]\.name: must be a string, not a number/,
    clientKey: 'manifestGeneric',
  },
  {
    name: 'empty command inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, command: '' }] })
    },
    detail: /monitors\[0\]\.command: must be at least 1 character/,
    clientKey: 'manifestTooSmall',
  },
  {
    name: 'inline entry is null',
    setup: (dir) => {
      writePlugin(dir, { monitors: [null] })
    },
    detail: /monitors\[0\]: must be an object, not null/,
    clientKey: 'manifestGeneric',
  },
  {
    name: 'duplicate names inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [VALID, { ...VALID, description: 'second' }] })
    },
    detail: /monitors\[1\]\.name: duplicate monitor name "beat"/,
    clientKey: 'manifestDuplicateName',
  },
  {
    name: 'manifest path does not start with "./"',
    setup: (dir) => {
      writePlugin(dir, { monitors: 'monitors/monitors.json' })
    },
    detail: /monitors: the manifest path form must start with "\.\/", not "monitors\/monitors\.json"/,
    clientKey: 'manifestPathPrefix',
  },
  {
    name: 'manifest value is neither array nor path string',
    setup: (dir) => {
      writePlugin(dir, { monitors: 3 })
    },
    detail: /monitors: must be an array of monitor declarations or a "\.\/"-relative path, not a number/,
    clientKey: 'manifestGeneric',
  },
  {
    name: 'manifest value is null',
    setup: (dir) => {
      writePlugin(dir, { monitors: null })
    },
    detail: /monitors: must be an array of monitor declarations or a "\.\/"-relative path, not null/,
    clientKey: 'manifestGeneric',
  },
]

for (const refusal of MANIFEST_REFUSALS) {
  test(`refuses ${refusal.name} as a manifest violation`, () => {
    withPlugin((dir) => {
      writePlugin(dir)
      refusal.setup(dir)
      assertManifestRefusal(() => readClaudePlugin(dir), refusal)
    })
  })
}

test('the S22 file-shaped fixtures become unsupported rows with the client text', () => {
  const badKey = readClaudePlugin(fixture('claude-monitors-bad-key'))
  assertOneUnsupportedRow(badKey, {
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]: unrecognized key "trigger"/,
    clientKey: 'fileUnknownKey',
    clientParams: { key: 'trigger' },
    observed: 'file-unknown-key',
  })
  // The sibling skill is still served: the client loads it despite the error.
  assert.deepEqual(badKey.skills.map((skill) => skill.name), ['innocent'])
  assertOneUnsupportedRow(readClaudePlugin(fixture('claude-monitors-bad-when-enum')), {
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not "sometimes"/,
    clientKey: 'fileWhenFormat',
  })
  assertOneUnsupportedRow(readClaudePlugin(fixture('claude-monitors-bad-when-short')), {
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: "on-skill-invoke:" must name a skill after the colon/,
    clientKey: 'fileWhenShort',
  })
})


// The table is not allowed to drift from the capture: every rendered entry
// must be a substring of the line the pinned client printed for that shape.
const CAPTURED_CLIENT_TEXT = [
  ['file-unknown-key', 'fileUnknownKey', { key: 'trigger' }],
  ['file-when-enum', 'fileWhenFormat', {}],
  ['file-when-short', 'fileWhenShort', {}],
  ['file-when-number', 'fileWhenUnion', {}],
  ['file-top-object', 'fileNotArray', { shape: 'object' }],
  ['file-top-null', 'fileNotArray', { shape: 'null' }],
  ['file-null-entry', 'fileNotObject', { shape: 'null' }],
  ['file-missing-description', 'fileNotString', { shape: 'undefined' }],
  ['file-empty-name', 'fileTooSmall', {}],
  ['file-duplicate', 'fileDuplicateName', {}],
  ['file-invalid-json', 'fileInvalidJson', {}],
  ['file-is-directory', 'fileNotRegularFile', {}],
  ['file-unreadable', 'fileUnreadable', null],
  ['path-missing', 'fileMissing', null],
  ['path-is-directory', 'fileNotRegularFile', {}],
  ['path-unreadable', 'fileUnreadable', null],
  ['path-bad-content', 'fileUnknownKey', { key: 'trigger' }],
  ['path-duplicate', 'fileDuplicateName', {}],
  ['manifest-unknown-key', 'manifestUnknownKey', { key: 'trigger' }],
  ['manifest-when-enum', 'manifestWhenFormat', {}],
  ['manifest-missing-description', 'manifestGeneric', {}],
  ['manifest-nonstring-name', 'manifestGeneric', {}],
  ['manifest-when-number', 'manifestGeneric', {}],
  ['manifest-empty-command', 'manifestTooSmall', {}],
  ['manifest-null-entry', 'manifestGeneric', {}],
  ['manifest-duplicate', 'manifestDuplicateName', {}],
  ['manifest-path-not-relative', 'manifestPathPrefix', {}],
  ['manifest-value-number', 'manifestGeneric', {}],
  ['manifest-value-null', 'manifestGeneric', {}],
]

test('MONITOR_CLIENT_TEXT is the text captured from the pinned client', () => {
  for (const [shape, key, params] of CAPTURED_CLIENT_TEXT) {
    const observed = readFileSync(join(OBSERVED, `${shape}.txt`), 'utf8')
    // The path-shaped entries interpolate the client's own path (scrubbed to
    // <plugin> in the capture); take it from the captured line.
    const path = params === null ? /\u2019([^\u2019]+)\u2019/.exec(observed)?.[1] : undefined
    assert.ok(params !== null || path, `${shape} captured the client's path`)
    const rendered = monitorClientText(key, params ?? { path })
    assert.ok(observed.includes(rendered), `${shape} contains ${key}: ${rendered}`)
  }
})

test('the valid fixture golden contains no monitors component (D37)', () => {
  // The client prints no Monitors line (S22), so the golden must not invent
  // one. fixtures.test.mjs re-probes this pin, so a client that starts
  // inventorying monitors makes this assumption fail rather than rot.
  const golden = JSON.parse(
    readFileSync(join(fixture('claude-monitors-valid'), '.inventory', 'claude-code@2.1.329.json'), 'utf8'),
  )
  assert.equal(golden.pin.version, '2.1.329')
  assert.equal(golden.components.some((component) => component.surface === 'monitors'), false)
  assert.deepEqual(golden.components, [{ surface: 'skills', name: 'greet' }])
})
