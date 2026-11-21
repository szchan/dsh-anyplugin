// Ticket #117: `rig marketplace list|install`.
//
// The catalog formats are upstream specifications (Claude's
// `.claude-plugin/marketplace.json`, Codex's `.agents/plugins/marketplace.json`
// and the Claude file as Codex's legacy-compatible fallback), so every catalog
// here is hand-authored — nothing is vendored from an upstream repository
// (D14). The tests run the real CLI against a temp `$DSH_HOME`: the claims are
// file claims (which record, which bytes, which refusal), not stdout claims.
//
// The property that keeps this slice honest is delegation: a marketplace
// install must leave the same lock and the same enablement layer a plain
// `rig install <dir>` would, apart from the `source` provenance line. If a
// second writer ever appears, that comparison fails.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readInstalls, serializeInstalls } from '../../dsh-anyplugin-install/src/index.ts'
import { InstallCliError } from '../src/install-cli.ts'
import { parseMarketplace } from '../src/marketplace.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'marketplace-local')
const catalog = join(fixture, '.claude-plugin', 'marketplace.json')
const pluginDir = join(fixture, 'plugins', 'local-hello')
const claudeFixture = join(repoRoot, 'fixtures', 'claude-skills-only')

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-marketplace-'))
  const home = join(dir, 'home')
  const project = join(dir, 'project')
  mkdirSync(project, { recursive: true })
  return {
    dir,
    home,
    project,
    lock: join(home, 'anyplugin', 'installs.yml'),
    userLayer: join(home, 'anyplugin', 'enabled.yml'),
    projectLayer: join(project, '.dsh', 'anyplugin.yml'),
  }
}

/** Run the real CLI; DSH_HOME is always the temp home, never the profile. */
function run(box, args, options = {}) {
  return spawnSync(process.execPath, [rigPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: box.home },
  })
}

function digest(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
}

function inode(file) {
  return existsSync(file) ? statSync(file).ino : null
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** A catalog directory shaped like a marketplace root with one `.claude-plugin` catalog. */
function writeCatalog(dir, document, plugin = true) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(document, null, 2))
  if (plugin) {
    mkdirSync(join(dir, 'plugins', 'hello', '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, 'plugins', 'hello', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'hello', description: 'Hand-authored test plugin.', version: '0.1.0' }),
    )
    mkdirSync(join(dir, 'plugins', 'hello', 'skills', 'hello'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'hello', 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n\nSay hello.\n')
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list prints name, description, source kind and policy, and records what it cannot carry', () => {
  const box = sandbox()
  try {
    const listed = run(box, ['marketplace', 'list', '--from', catalog])
    // One malformed entry is a recorded problem; the good entries still list.
    assert.equal(listed.status, 1, listed.stderr)
    assert.match(listed.stdout, /^marketplace: local-marketplace {2}.*marketplace\.json/u)
    assert.match(listed.stdout, /\(2 entries, 1 malformed\)/u)
    assert.match(listed.stdout, / {2}local-hello {2}local {2}\.\/plugins\/local-hello/u)
    assert.match(listed.stdout, / {4}A skill that greets the user\./u)
    assert.match(listed.stdout, /category: testing {2}version: 0\.1\.0/u)
    assert.match(listed.stdout, / {2}remote-helper {2}url {2}https:\/\/example\.invalid\/remote-helper\.git/u)
    assert.match(listed.stdout, /policy: AVAILABLE \/ ON_INSTALL/u)
    assert.match(listed.stdout, /unsupported: url sources are not installable yet/u)
    assert.match(listed.stdout, /D27/u)
    assert.match(listed.stdout, /slice 2 of #117/u)
    assert.match(listed.stdout, /note: marketplace: field "owner" is not carried by this slice/u)
    assert.match(listed.stdout, /note: entry "local-hello": field "author" is not carried by this slice/u)
    assert.match(listed.stdout, /problem: plugins\[2\] \("broken-entry"\) at line \d+: "source" must be/u)
  } finally {
    cleanup(box.dir)
  }
})

test('list --json distinguishes "not installable here" from "malformed"', () => {
  const box = sandbox()
  try {
    const listed = run(box, ['marketplace', 'list', '--from', catalog, '--json'])
    assert.equal(listed.status, 1, listed.stderr)
    const payload = JSON.parse(listed.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.name, 'local-marketplace')
    assert.equal(payload.entries.length, 2)
    const [local, remote] = payload.entries
    assert.equal(local.name, 'local-hello')
    assert.equal(local.installable, true)
    assert.deepEqual(local.source, { kind: 'local', path: './plugins/local-hello' })
    assert.equal(remote.name, 'remote-helper')
    assert.equal(remote.installable, false)
    assert.match(remote.unsupported, /fetch, a content hash pin and explicit consent/u)
    assert.equal(payload.problems.length, 1)
    assert.equal(payload.problems[0].name, 'broken-entry')
    assert.equal(typeof payload.problems[0].line, 'number')
    assert.equal(payload.notes.length, 2)
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// install: delegation, provenance, and byte equality with `rig install`
// ---------------------------------------------------------------------------

test('install by name writes the same canonical YAML as `rig install <dir>`, plus provenance', () => {
  const viaMarketplace = sandbox()
  const viaDirectory = sandbox()
  try {
    const installed = run(viaMarketplace, ['marketplace', 'install', 'local-hello', '--from', catalog])
    assert.equal(installed.status, 0, installed.stderr)
    assert.match(installed.stdout, /^marketplace: local-marketplace/u)
    assert.match(installed.stdout, / {2}entry: local-hello/u)
    assert.match(installed.stdout, /install claude-code:local-hello: added/u)
    assert.match(installed.stdout, /report: 1 declared, 1 emitted, 0 refused, 0 skipped/u)

    const plain = run(viaDirectory, ['install', pluginDir])
    assert.equal(plain.status, 0, plain.stderr)

    const marketplaceLock = readInstalls(viaMarketplace.lock)
    const directoryLock = readInstalls(viaDirectory.lock)
    assert.equal(marketplaceLock.schema, 'dsh-anyplugin/installs@1')
    assert.equal(marketplaceLock.plugins.length, 1)
    const record = marketplaceLock.plugins[0]
    assert.equal(record.dialect, 'claude-code')
    assert.equal(record.name, 'local-hello')
    assert.equal(record.version, '0.1.0')
    assert.equal(record.root, pluginDir)
    assert.equal(record.pin, 'claude-code@2.1.329')
    // The provenance is a structured value, validated by the lock schema.
    assert.deepEqual(record.source, { marketplace: 'local-marketplace', entry: 'local-hello', version: '0.1.0' })
    assert.match(readFileSync(viaMarketplace.lock, 'utf8'), /source: "\{\\"marketplace\\":/u)

    // The only difference is the source line: one writer, two callers (D49).
    const withoutSource = (installs, home) =>
      serializeInstalls({ ...installs, plugins: installs.plugins.map(({ source, ...rest }) => rest) }).replaceAll(
        home,
        '<home>',
      )
    assert.equal(withoutSource(marketplaceLock, viaMarketplace.home), withoutSource(directoryLock, viaDirectory.home))
    assert.equal(
      readFileSync(viaMarketplace.userLayer, 'utf8'),
      readFileSync(viaDirectory.userLayer, 'utf8'),
      'enablement is decided by the same code, so the layer is byte-identical',
    )

    const listed = run(viaMarketplace, ['list', '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.deepEqual(JSON.parse(listed.stdout).plugins[0].source, record.source)

    // Re-installing from the same catalog is the same no-op as re-installing
    // from the directory: same bytes, same exit 0.
    const lockBytes = readFileSync(viaMarketplace.lock, 'utf8')
    const layerBytes = readFileSync(viaMarketplace.userLayer, 'utf8')
    const again = run(viaMarketplace, ['marketplace', 'install', 'local-hello', '--from', catalog])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /already installed/u)
    assert.equal(readFileSync(viaMarketplace.lock, 'utf8'), lockBytes)
    assert.equal(readFileSync(viaMarketplace.userLayer, 'utf8'), layerBytes)
  } finally {
    cleanup(viaMarketplace.dir)
    cleanup(viaDirectory.dir)
  }
})

test('a Codex marketplace resolves its object source under the marketplace root', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'codex-market')
    writeCatalog(root, {
      name: 'codex-market',
      plugins: [
        {
          name: 'hello',
          description: 'Installed from a Codex catalog.',
          category: 'testing',
          source: { source: 'local', path: './plugins/hello' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      ],
    })
    // Codex keeps the catalog in `.agents/plugins/`, but `source.path` still
    // resolves from the marketplace root, not from the catalog's directory.
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
    cpSync(
      join(root, '.claude-plugin', 'marketplace.json'),
      join(root, '.agents', 'plugins', 'marketplace.json'),
    )
    const codexCatalog = join(root, '.agents', 'plugins', 'marketplace.json')

    const listed = run(box, ['marketplace', 'list', '--from', codexCatalog])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /hello {2}local {2}\.\/plugins\/hello/u)
    assert.match(listed.stdout, /policy: AVAILABLE \/ ON_INSTALL/u)

    const installed = run(box, ['marketplace', 'install', 'hello', '--from', codexCatalog])
    assert.equal(installed.status, 0, installed.stderr)
    const record = readInstalls(box.lock).plugins[0]
    assert.equal(record.root, join(root, 'plugins', 'hello'))
    assert.deepEqual(record.source, { marketplace: 'codex-market', entry: 'hello' })
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// refusals: remote sources, malformed entries, escapes
// ---------------------------------------------------------------------------

test('a remote entry is refused as unsupported, naming the missing piece, and writes nothing', () => {
  const box = sandbox()
  try {
    const refused = run(box, ['marketplace', 'install', 'remote-helper', '--from', catalog])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(unsupported-marketplace-source\)/u)
    assert.match(refused.stderr, /entry "remote-helper" installs from url/u)
    assert.match(refused.stderr, /a fetch, a content hash pin and explicit consent \(D27\)/u)
    assert.match(refused.stderr, /slice 2 of #117/u)
    assert.equal(existsSync(box.lock), false, 'a refusal must not create the lock')
    assert.equal(existsSync(box.userLayer), false, 'a refusal must not enable anything')

    const json = run(box, ['marketplace', 'install', 'remote-helper', '--from', catalog, '--json'])
    assert.equal(json.status, 1)
    const payload = JSON.parse(json.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.refusals[0].code, 'unsupported-marketplace-source')
    assert.match(payload.refusals[0].reason, /D27/u)
  } finally {
    cleanup(box.dir)
  }
})

test('a malformed entry is refused by name with its line, and writes nothing', () => {
  const box = sandbox()
  try {
    const refused = run(box, ['marketplace', 'install', 'broken-entry', '--from', catalog])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(malformed-marketplace-entry\)/u)
    assert.match(refused.stderr, /plugins\[2\] \("broken-entry"\) at line \d+/u)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
  } finally {
    cleanup(box.dir)
  }
})

test('an unknown entry names the entries that do exist', () => {
  const box = sandbox()
  try {
    const refused = run(box, ['marketplace', 'install', 'nope', '--from', catalog])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(unknown-marketplace-entry\)/u)
    assert.match(refused.stderr, /known: local-hello, remote-helper/u)
  } finally {
    cleanup(box.dir)
  }
})

test('a local source that leaves the marketplace root is refused before any write', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'catalog')
    writeCatalog(root, {
      name: 'escape-marketplace',
      plugins: [{ name: 'hello', source: './../outside' }],
    })
    mkdirSync(join(box.dir, 'outside', '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(box.dir, 'outside', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'hello', version: '0.1.0' }),
    )
    const refused = run(box, ['marketplace', 'install', 'hello', '--from', join(root, '.claude-plugin', 'marketplace.json')])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-path-escape\)/u)
    // The lexical check is the one that refuses this: the target exists, so a
    // realpath-only refusal would say “through a symlink” and leave the
    // declared path looking contained.
    assert.match(refused.stderr, /resolves to .*outside the marketplace root/u)
    assert.doesNotMatch(refused.stderr, /through a symlink/u)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a symlink out of the marketplace root is refused by realpath, not just lexically', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'catalog')
    writeCatalog(root, {
      name: 'symlink-marketplace',
      plugins: [{ name: 'hello', source: './linked' }],
    })
    mkdirSync(join(box.dir, 'outside', '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(box.dir, 'outside', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'hello', version: '0.1.0' }),
    )
    symlinkSync(join(box.dir, 'outside'), join(root, 'linked'), 'dir')
    const refused = run(box, ['marketplace', 'install', 'hello', '--from', join(root, '.claude-plugin', 'marketplace.json')])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-path-escape\)/u)
    assert.match(refused.stderr, /through a symlink/u)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a missing catalog file is a typed refusal, not an empty catalog', () => {
  const box = sandbox()
  try {
    const refused = run(box, ['marketplace', 'list', '--from', join(box.dir, 'absent.json')])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(unreadable-marketplace\)/u)
    assert.match(refused.stderr, /hint: pass --from the catalog file/u)
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------

test('--dry-run prints the exact change and leaves every file byte-identical', () => {
  const box = sandbox()
  try {
    const seeded = run(box, ['install', claudeFixture])
    assert.equal(seeded.status, 0, seeded.stderr)
    const lockDigest = digest(box.lock)
    const layerDigest = digest(box.userLayer)
    const lockInode = inode(box.lock)
    assert.equal(readInstalls(box.lock).plugins.length, 1)

    const dry = run(box, ['marketplace', 'install', 'local-hello', '--from', catalog, '--dry-run'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /dry run — nothing written/u)
    assert.match(dry.stdout, /\+ +- dialect: "claude-code"/u)
    assert.match(dry.stdout, /\+ +source: "\{\\"marketplace\\":/u)

    assert.equal(digest(box.lock), lockDigest)
    assert.equal(digest(box.userLayer), layerDigest)
    assert.equal(inode(box.lock), lockInode, 'the lock must not be rewritten')
    assert.equal(readInstalls(box.lock).plugins.length, 1, 'the dry run must not add a record')
  } finally {
    cleanup(box.dir)
  }
})

test('--dry-run on an empty profile creates neither the lock nor a layer', () => {
  const box = sandbox()
  try {
    const dry = run(box, ['marketplace', 'install', 'local-hello', '--from', catalog, '--dry-run'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test('the marketplace command has a closed option set and a required --from', () => {
  const box = sandbox()
  try {
    const noSub = run(box, ['marketplace'])
    assert.equal(noSub.status, 2)
    assert.match(noSub.stderr, /missing marketplace subcommand \(list or install\)/u)

    const unknownSub = run(box, ['marketplace', 'frobnicate'])
    assert.equal(unknownSub.status, 2)
    assert.match(unknownSub.stderr, /unknown marketplace subcommand "frobnicate"/u)

    const extraOption = run(box, ['marketplace', 'list', '--from', catalog, '--dry-run'])
    assert.equal(extraOption.status, 2)
    assert.match(extraOption.stderr, /unknown option --dry-run for marketplace list/u)
    assert.match(extraOption.stderr, /allowed: --from, --json, --help/u)

    const missingFrom = run(box, ['marketplace', 'install', 'local-hello'])
    assert.equal(missingFrom.status, 2)
    assert.match(missingFrom.stderr, /missing --from/u)

    const extraPositional = run(box, ['marketplace', 'list', '--from', catalog, 'surprise'])
    assert.equal(extraPositional.status, 2)
    assert.match(extraPositional.stderr, /unexpected argument: surprise/u)

    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// parse unit: one entry's failure is that entry's, never the catalog's
// ---------------------------------------------------------------------------

test('parseMarketplace keeps good entries when siblings are malformed, and never throws for them', () => {
  const text = JSON.stringify({
    name: 'unit-marketplace',
    futureField: true,
    plugins: [
      { name: 'good', source: './good' },
      { name: 'no-source' },
      { name: 'bad-kind', source: { source: 'carrier-pigeon' } },
      { name: 'good', source: './duplicate' },
    ],
  })
  const marketplace = parseMarketplace(text, 'unit.json')
  assert.deepEqual(marketplace.entries.map((entry) => entry.name), ['good'])
  assert.equal(marketplace.notes.length, 1)
  assert.match(marketplace.notes[0], /field "futureField" is not carried/u)
  assert.deepEqual(
    marketplace.problems.map((problem) => problem.name),
    ['no-source', 'bad-kind', 'good'],
  )
  assert.match(marketplace.problems[2].reason, /duplicate entry name "good" \(first at plugins\[0\]\)/u)
  // A duplicate is a problem even though the first one is fine: the catalog
  // can no longer answer "install good" unambiguously.
  assert.equal(marketplace.entries[0].source.path, './good')
})

test('parseMarketplace refuses a catalog that has no usable name or plugins array', () => {
  for (const text of ['{"plugins": []}', '{"name": "m"}', '{"name": "m", "plugins": {}}', 'not json']) {
    assert.throws(
      () => parseMarketplace(text, 'bad.json'),
      (error) => error instanceof InstallCliError && error.code === 'malformed-marketplace',
    )
  }
})

// ---------------------------------------------------------------------------
// review round: policy, duplicates, containment names, version provenance
// ---------------------------------------------------------------------------

/** A plugin tree at `dir` with an explicit artifact name and version. */
function writePluginAt(dir, name, version = '0.1.0') {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, description: 'Hand-authored test plugin.', version }),
  )
  mkdirSync(join(dir, 'skills', name), { recursive: true })
  writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n\nSay hello.\n`)
}

function writeCatalogAt(root, document) {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify(document, null, 2))
}

test('policy.installation NOT_AVAILABLE is enforced by install, not just printed by list', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'policy-catalog')
    writePluginAt(join(root, 'plugins', 'hello'), 'hello')
    writeCatalogAt(root, {
      name: 'policy-marketplace',
      plugins: [
        {
          name: 'hello',
          source: './plugins/hello',
          policy: { installation: 'NOT_AVAILABLE', authentication: 'ON_INSTALL' },
        },
      ],
    })
    const file = join(root, '.claude-plugin', 'marketplace.json')

    const listed = run(box, ['marketplace', 'list', '--from', file])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /policy: NOT_AVAILABLE \/ ON_INSTALL/u)

    const refused = run(box, ['marketplace', 'install', 'hello', '--from', file])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-entry-not-available\)/u)
    assert.match(refused.stderr, /entry "hello" declares policy\.installation "NOT_AVAILABLE"/u)
    assert.match(refused.stderr, /policy-marketplace|marketplace\.json/u)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a duplicated entry name is refused by list and by install instead of picking an entry', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'duplicate-catalog')
    writePluginAt(join(root, 'plugins', 'hello'), 'hello')
    writeCatalogAt(root, {
      name: 'duplicate-marketplace',
      plugins: [
        { name: 'hello', source: './plugins/hello' },
        { name: 'hello', source: './plugins/elsewhere' },
      ],
    })
    const file = join(root, '.claude-plugin', 'marketplace.json')

    const listed = run(box, ['marketplace', 'list', '--from', file])
    assert.equal(listed.status, 1)
    assert.match(listed.stdout, /problem: plugins\[1\] \("hello"\) at line \d+: duplicate entry name "hello"/u)

    const refused = run(box, ['marketplace', 'install', 'hello', '--from', file])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(ambiguous-marketplace-entry\)/u)
    assert.match(refused.stderr, /duplicate entry name "hello"/u)
    assert.doesNotMatch(refused.stderr, /nothing-emitted|name-mismatch/u)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a directory whose name begins with two dots is inside the root, not an escape', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'weird-name-literal')
    writePluginAt(join(root, '..weird'), 'hello')
    writeCatalogAt(root, { name: 'weird-literal', plugins: [{ name: 'hello', source: './..weird' }] })
    const installed = run(box, ['marketplace', 'install', 'hello', '--from', join(root, '.claude-plugin', 'marketplace.json')])
    assert.equal(installed.status, 0, installed.stderr)
    const lock = readInstalls(box.lock)
    assert.equal(lock.plugins[0].source.entry, 'hello')
  } finally {
    cleanup(box.dir)
  }
})

test('a symlink to a ".."-prefixed sibling stays inside the root through realpath', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'weird-name-link')
    writePluginAt(join(root, '..weird'), 'hello')
    symlinkSync(join(root, '..weird'), join(root, 'linked'), 'dir')
    writeCatalogAt(root, { name: 'weird-link', plugins: [{ name: 'hello', source: './linked' }] })
    const installed = run(box, ['marketplace', 'install', 'hello', '--from', join(root, '.claude-plugin', 'marketplace.json')])
    assert.equal(installed.status, 0, installed.stderr)
    const lock = readInstalls(box.lock)
    assert.equal(lock.plugins[0].source.entry, 'hello')
  } finally {
    cleanup(box.dir)
  }
})

test('a catalog version that differs from the artifact is reported, and the record keeps the artifact version', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'version-catalog')
    writePluginAt(join(root, 'plugins', 'hello'), 'hello', '0.1.0')
    writeCatalogAt(root, {
      name: 'version-marketplace',
      plugins: [{ name: 'hello', source: './plugins/hello', version: '9.9.9' }],
    })
    const installed = run(box, ['marketplace', 'install', 'hello', '--from', join(root, '.claude-plugin', 'marketplace.json')])
    assert.equal(installed.status, 0, installed.stderr)
    assert.match(
      installed.stdout,
      /the catalog advertises version "9\.9\.9" but the artifact declares "0\.1\.0"/u,
    )
    const lock = readInstalls(box.lock)
    assert.equal(lock.plugins[0].version, '0.1.0')
    assert.deepEqual(lock.plugins[0].source, { marketplace: 'version-marketplace', entry: 'hello', version: '9.9.9' })
  } finally {
    cleanup(box.dir)
  }
})

test('an entry with no usable name still reports a line, not just an array index', () => {
  const text = `{
  "name": "line-marketplace",
  "plugins": [
    {
      "description": "no name here"
    },
    {
      "name": "good",
      "source": "./good"
    }
  ]
}`
  const marketplace = parseMarketplace(text, 'lines.json')
  assert.equal(marketplace.problems.length, 1)
  assert.equal(marketplace.problems[0].index, 0)
  assert.equal(marketplace.problems[0].name, undefined)
  assert.equal(marketplace.problems[0].line, 4)
  assert.match(marketplace.problems[0].reason, /"name" must be a bare plugin name/u)
})
