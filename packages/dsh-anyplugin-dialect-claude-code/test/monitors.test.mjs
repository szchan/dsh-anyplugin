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

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = (name) => join(repoRoot, 'fixtures', name)

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

function assertOneUnsupportedRow(ir, { sourcePath, detail, client }) {
  const rows = monitorRefusals(ir)
  assert.equal(rows.length, 1, 'a file-shaped rejection produces exactly one unsupported row')
  assert.equal(rows[0].name, 'monitors')
  assert.equal(rows[0].sourcePath, sourcePath)
  assert.equal(rows[0].annotation.fidelity, 'unsupported')
  assert.match(rows[0].annotation.reason, detail)
  assert.match(rows[0].annotation.reason, client)
  assert.match(rows[0].annotation.reason, /loaded with errors/)
  assert.match(rows[0].annotation.reason, /claude-code@2\.1\.329/)
  assert.match(rows[0].annotation.reason, /directory form/)
  assert.match(rows[0].annotation.reason, /`rig install <dir>`/)
  assert.match(rows[0].annotation.reason, /D37/)
  assert.deepEqual(monitorRows(ir), [])
  assert.deepEqual(validateIr(ir), [])
}

function assertManifestRefusal(fn, { detail, client }) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'MonitorsRefusal')
    assert.equal(error.kind, 'manifest')
    assert.match(error.message, /invalid monitors declaration/)
    assert.match(error.message, detail)
    assert.match(error.message, client)
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
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, trigger: 'always' }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\/monitors\.json monitors\[0\]: unrecognized key "trigger" \(the accepted keys are name, command, description, when\)/,
    client: /Unrecognized key: "trigger"/,
  },
  {
    name: 'when enum in the directory file',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, when: 'sometimes' }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not "sometimes"/,
    client: /Invalid string: must start with "on-skill-invoke:"/,
  },
  {
    name: 'on-skill-invoke without a skill in the directory file',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([{ ...VALID, when: 'on-skill-invoke:' }]))
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: "on-skill-invoke:" must name a skill after the colon/,
    client: /on-skill-invoke: must specify a skill name/,
  },
  {
    name: 'top level is an object in the directory file',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), '{}')
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\/monitors\.json monitors: must be an array of monitor declarations, not an object/,
    client: /expected array, received object/,
  },
  {
    name: 'invalid JSON in the directory file',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), '[{')
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors: not valid JSON/,
    client: /JSON Parse error:/,
  },
  {
    name: 'duplicate names in the directory file',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(
        join(dir, 'monitors', 'monitors.json'),
        JSON.stringify([VALID, { ...VALID, description: 'second' }]),
      )
    },
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[1\]\.name: duplicate monitor name "beat"/,
    client: /Monitor names must be unique within a plugin/,
  },
  {
    name: 'the directory file is a directory',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors', 'monitors.json'), { recursive: true })
    },
    sourcePath: 'monitors/monitors.json',
    detail: /is a directory, not a declaration file/,
    client: /EISDIR: illegal operation on a directory, read/,
  },
  {
    name: 'the directory file cannot be read',
    setup: (dir) => {
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'monitors.json'), JSON.stringify([VALID]))
      chmodSync(join(dir, 'monitors', 'monitors.json'), 0o000)
    },
    sourcePath: 'monitors/monitors.json',
    detail: /cannot read /,
    client: /EACCES: permission denied, open /,
  },
  {
    name: 'manifest path is missing',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/gone.json' })
    },
    sourcePath: './monitors/gone.json',
    detail: /refers to "\.\/monitors\/gone\.json", which is not a readable file/,
    client: /ENOENT: no such file or directory, lstat/,
  },
  {
    name: 'manifest path target is a directory',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/target.json' })
      mkdirSync(join(dir, 'monitors', 'target.json'), { recursive: true })
    },
    sourcePath: './monitors/target.json',
    detail: /refers to "\.\/monitors\/target\.json", which is a directory/,
    client: /EISDIR: illegal operation on a directory, read/,
  },
  {
    name: 'manifest path target is unreadable',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/locked.json' })
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'locked.json'), JSON.stringify([VALID]))
      chmodSync(join(dir, 'monitors', 'locked.json'), 0o000)
    },
    sourcePath: './monitors/locked.json',
    detail: /cannot read /,
    client: /EACCES: permission denied, open /,
  },
  {
    name: 'bad manifest path file content',
    setup: (dir) => {
      writePlugin(dir, { monitors: './monitors/custom.json' })
      mkdirSync(join(dir, 'monitors'))
      writeFileSync(join(dir, 'monitors', 'custom.json'), JSON.stringify([{ ...VALID, trigger: 'always' }]))
    },
    sourcePath: './monitors/custom.json',
    detail: /unrecognized key "trigger"/,
    client: /Unrecognized key: "trigger"/,
  },
  {
    name: 'duplicate names in a manifest path file',
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
    client: /Monitor names must be unique within a plugin/,
  },
]

for (const refusal of FILE_REFUSALS) {
  test(`carries ${refusal.name} as unsupported`, () => {
    withPlugin((dir) => {
      writePlugin(dir)
      refusal.setup(dir)
      assertOneUnsupportedRow(readClaudePlugin(dir), refusal)
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
    client: /Unrecognized key: "interval"/,
  },
  {
    name: 'when enum inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, when: 'sometimes' }] })
    },
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not "sometimes"/,
    client: /Invalid string: must start with "on-skill-invoke:"/,
  },
  {
    name: 'missing description inline',
    setup: (dir) => {
      const { description, ...entry } = VALID
      writePlugin(dir, { monitors: [entry] })
    },
    detail: /monitors\[0\]\.description: is required and must be a non-empty string/,
    client: /expected string, received undefined/,
  },
  {
    name: 'non-string name inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, name: 7 }] })
    },
    detail: /monitors\[0\]\.name: must be a string, not a number/,
    client: /expected string, received number/,
  },
  {
    name: 'empty command inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [{ ...VALID, command: '' }] })
    },
    detail: /monitors\[0\]\.command: must be at least 1 character/,
    client: /Too small: expected string to have >=1 characters/,
  },
  {
    name: 'inline entry is null',
    setup: (dir) => {
      writePlugin(dir, { monitors: [null] })
    },
    detail: /monitors\[0\]: must be an object, not null/,
    client: /expected object, received null/,
  },
  {
    name: 'duplicate names inline',
    setup: (dir) => {
      writePlugin(dir, { monitors: [VALID, { ...VALID, description: 'second' }] })
    },
    detail: /monitors\[1\]\.name: duplicate monitor name "beat"/,
    client: /Monitor names must be unique within a plugin/,
  },
  {
    name: 'manifest path does not start with "./"',
    setup: (dir) => {
      writePlugin(dir, { monitors: 'monitors/monitors.json' })
    },
    detail: /monitors: the manifest path form must start with "\.\/", not "monitors\/monitors\.json"/,
    client: /Invalid string: must start with "\.\/"/,
  },
  {
    name: 'manifest value is neither array nor path string',
    setup: (dir) => {
      writePlugin(dir, { monitors: 3 })
    },
    detail: /monitors: must be an array of monitor declarations or a "\.\/"-relative path, not a number/,
    client: /Invalid input/,
  },
  {
    name: 'manifest value is null',
    setup: (dir) => {
      writePlugin(dir, { monitors: null })
    },
    detail: /monitors: must be an array of monitor declarations or a "\.\/"-relative path, not null/,
    client: /Invalid input/,
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
    client: /Unrecognized key: "trigger"/,
  })
  // The sibling skill is still served: the client loads it despite the error.
  assert.deepEqual(badKey.skills.map((skill) => skill.name), ['innocent'])
  assertOneUnsupportedRow(readClaudePlugin(fixture('claude-monitors-bad-when-enum')), {
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: must be "always" or "on-skill-invoke:<skill-name>", not "sometimes"/,
    client: /Invalid string: must start with "on-skill-invoke:"/,
  })
  assertOneUnsupportedRow(readClaudePlugin(fixture('claude-monitors-bad-when-short')), {
    sourcePath: 'monitors/monitors.json',
    detail: /monitors\[0\]\.when: "on-skill-invoke:" must name a skill after the colon/,
    client: /on-skill-invoke: must specify a skill name/,
  })
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
