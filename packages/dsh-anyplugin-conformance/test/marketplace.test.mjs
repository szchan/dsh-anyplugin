// Ticket #117 and #161: `rig marketplace list|install`.
//
// The catalog formats are upstream specifications (Claude's
// `.claude-plugin/marketplace.json`, Codex's `.agents/plugins/marketplace.json`
// and the Claude file as Codex's legacy-compatible fallback), so every catalog
// here is hand-authored — nothing is vendored from an upstream repository
// (D14). The tests run the real CLI against a temp `$DSH_HOME`: the claims are
// file claims (which record, which bytes, which refusal), not stdout claims.
//
// The two files are not one schema: the catalog's *path* selects the parser.
// A Claude entry's `source` is a string or a Claude source object; a Codex
// entry's `source` is a Codex source object (or a string path for `local`),
// and `policy` is Codex's field. An entry that does not match its file's
// shape is a recorded problem naming the field, never a guess.
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

import { INSTALLS_SCHEMA, readInstalls, serializeInstalls } from '../../dsh-anyplugin-install/src/index.ts'
import { InstallCliError } from '../src/install-cli.ts'
import { parseMarketplace } from '../src/marketplace.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'marketplace-local')
const catalog = join(fixture, '.claude-plugin', 'marketplace.json')
const pluginDir = join(fixture, 'plugins', 'local-hello')
const claudeFixture = join(repoRoot, 'fixtures', 'claude-skills-only')
const codexFixture = join(repoRoot, 'fixtures', 'marketplace-codex')
const codexCatalog = join(codexFixture, '.agents', 'plugins', 'marketplace.json')
const bothRoot = join(codexFixture, 'both')

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

/** A catalog directory shaped like a Codex marketplace root, with one portable plugin. */
function writeCodexCatalog(dir, document, plugin = true) {
  mkdirSync(join(dir, '.agents', 'plugins'), { recursive: true })
  writeFileSync(join(dir, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(document, null, 2))
  if (plugin) {
    mkdirSync(join(dir, 'plugins', 'hello'), { recursive: true })
    writeFileSync(
      join(dir, 'plugins', 'hello', 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'hello',
        version: '0.1.0',
        description: 'Hand-authored Codex test plugin.',
      }),
    )
    mkdirSync(join(dir, 'plugins', 'hello', 'skills', 'hello'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'hello', 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n\nSay hello.\n')
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list prints name, description, source kind and format, and records what it cannot carry', () => {
  const box = sandbox()
  try {
    const listed = run(box, ['marketplace', 'list', '--from', catalog])
    // One malformed entry is a recorded problem; the good entries still list.
    assert.equal(listed.status, 1, listed.stderr)
    assert.match(listed.stdout, /^marketplace: local-marketplace {2}.*marketplace\.json/u)
    assert.match(listed.stdout, /\(2 entries, 1 malformed\)/u)
    assert.match(listed.stdout, / {2}local-hello {2}claude-code {2}local {2}\.\/plugins\/local-hello/u)
    assert.match(listed.stdout, / {4}A skill that greets the user\./u)
    assert.match(listed.stdout, /category: testing {2}version: 0\.1\.0/u)
    assert.match(listed.stdout, / {2}remote-helper {2}claude-code {2}url {2}https:\/\/example\.invalid\/remote-helper\.git/u)
    // `policy` is Codex's entry field; a Claude entry that carries it is a
    // note, never an installation policy (the fixture moved it to the Codex
    // catalog on purpose).
    assert.doesNotMatch(listed.stdout, /policy:/u)
    // url/git-subdir/npm are installable through a network grant; only the
    // remaining kinds carry an `unsupported:` line, and this catalog has none.
    assert.doesNotMatch(listed.stdout, /unsupported:/u)
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
    assert.equal(payload.format, 'claude')
    assert.equal(payload.catalogs.length, 1)
    assert.equal(payload.catalogs[0].format, 'claude')
    assert.equal(payload.entries.length, 2)
    const [local, remote] = payload.entries
    assert.equal(local.name, 'local-hello')
    assert.equal(local.format, 'claude')
    assert.equal(local.marketplace, 'local-marketplace')
    assert.equal(local.installable, true)
    assert.deepEqual(local.source, { kind: 'local', path: './plugins/local-hello' })
    assert.equal(remote.name, 'remote-helper')
    assert.equal(remote.installable, true)
    assert.equal(remote.unsupported, undefined)
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
    assert.equal(marketplaceLock.schema, INSTALLS_SCHEMA)
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

test('a Codex catalog resolves its object source under the root and pairs dialect codex', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'codex-market')
    writeCodexCatalog(root, {
      name: 'codex-market',
      interface: { displayName: 'Codex Market' },
      plugins: [
        {
          name: 'hello',
          // Codex's local source is an object with a nested discriminator; the
          // path still resolves from the marketplace root, not from
          // `.agents/plugins/`.
          source: { source: 'local', path: './plugins/hello' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'testing',
        },
      ],
    })
    const file = join(root, '.agents', 'plugins', 'marketplace.json')

    const listed = run(box, ['marketplace', 'list', '--from', file])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, / {2}hello {2}codex {2}local {2}\.\/plugins\/hello/u)
    assert.match(listed.stdout, /policy: AVAILABLE \/ ON_INSTALL/u)
    assert.match(listed.stdout, /Codex Market/u)

    const installed = run(box, ['marketplace', 'install', 'hello', '--from', file])
    assert.equal(installed.status, 0, installed.stderr)
    assert.match(installed.stdout, /install codex:hello: added/u)
    const record = readInstalls(box.lock).plugins[0]
    assert.equal(record.dialect, 'codex')
    assert.equal(record.pin, 'agent-plugins@1.0.0')
    assert.equal(record.root, join(root, 'plugins', 'hello'))
    assert.deepEqual(record.source, { marketplace: 'codex-market', entry: 'hello' })
  } finally {
    cleanup(box.dir)
  }
})

test('a Codex string local source is a path, and a string no longer hides a Claude object', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'string-codex')
    writeCodexCatalog(root, {
      name: 'string-codex',
      plugins: [
        {
          name: 'hello',
          // The published Codex page allows this plain-string local form.
          source: './plugins/hello',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'testing',
        },
      ],
    })
    const file = join(root, '.agents', 'plugins', 'marketplace.json')
    const listed = run(box, ['marketplace', 'list', '--from', file])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, / {2}hello {2}codex {2}local {2}\.\/plugins\/hello/u)

    // A Claude-shaped object in a Codex file is not rewritten into a Codex
    // source: `github` is Claude's kind and the entry is a problem naming the
    // field, so the name never becomes installable by guessing.
    const claudeShaped = join(box.dir, 'claude-shaped')
    writeCodexCatalog(
      claudeShaped,
      {
        name: 'claude-shaped',
        plugins: [{ name: 'hello', source: { source: 'github', repo: 'example/plugin' } }],
      },
      false,
    )
    const refused = run(box, [
      'marketplace',
      'install',
      'hello',
      '--from',
      join(claudeShaped, '.agents', 'plugins', 'marketplace.json'),
    ])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(malformed-marketplace-entry\)/u)
    assert.match(refused.stderr, /"source\.source" is "github"; a Codex source must be one of local, url, git-subdir, npm/u)
    assert.equal(existsSync(box.lock), false)

    // The other direction of the same trap: Codex's object-local form in a
    // Claude file is a problem naming the field, not a local install.
    const claudeObject = join(box.dir, 'claude-object')
    writeCatalog(claudeObject, {
      name: 'claude-object',
      plugins: [{ name: 'hello', source: { source: 'local', path: './plugins/hello' } }],
    })
    const claudeCatalog = join(claudeObject, '.claude-plugin', 'marketplace.json')
    const listedObject = run(box, ['marketplace', 'list', '--from', claudeCatalog])
    assert.equal(listedObject.status, 1)
    assert.match(listedObject.stdout, /problem: plugins\[0\] \("hello"\)/u)
    assert.match(
      listedObject.stdout,
      /"source\.source" is "local"; a Claude local source is a "\.\/"-relative path string, not an object/u,
    )
    const refusedObject = run(box, ['marketplace', 'install', 'hello', '--from', claudeCatalog])
    assert.equal(refusedObject.status, 1)
    assert.match(refusedObject.stderr, /refused \(malformed-marketplace-entry\)/u)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// refusals: remote sources, malformed entries, escapes
// ---------------------------------------------------------------------------

test('a remote entry without a network grant is refused before the fetch, naming the command', () => {
  const box = sandbox()
  try {
    const refused = run(box, ['marketplace', 'install', 'remote-helper', '--from', catalog])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(network-consent-required\)/u)
    assert.match(refused.stderr, /entry "local-marketplace:remote-helper" is fetched, not read/u)
    assert.match(refused.stderr, /GET https:\/\/example\.invalid\/remote-helper\.git/u)
    assert.match(refused.stderr, /--yes/u)
    assert.match(refused.stderr, /never authorizes exec\/mod/u)
    assert.equal(existsSync(box.lock), false, 'a refusal must not create the lock')
    assert.equal(existsSync(box.userLayer), false, 'a refusal must not enable anything')
    assert.equal(existsSync(join(box.home, 'anyplugin', 'marketplace-cache')), false, 'a refusal must not fetch')

    const json = run(box, ['marketplace', 'install', 'remote-helper', '--from', catalog, '--json'])
    assert.equal(json.status, 1)
    const payload = JSON.parse(json.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.refusals[0].code, 'network-consent-required')
    assert.match(payload.refusals[0].reason, /GET https:\/\/example\.invalid/u)
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
    assert.match(refused.stderr, /hint: pass --from a catalog file/u)
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
  const marketplace = parseMarketplace(text, 'unit.json', 'claude')
  assert.equal(marketplace.format, 'claude')
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
      () => parseMarketplace(text, 'bad.json', 'claude'),
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

test('Codex policy.installation NOT_AVAILABLE is enforced by install, not just printed by list', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'policy-catalog')
    writeCodexCatalog(root, {
      name: 'policy-marketplace',
      plugins: [
        {
          name: 'hello',
          source: { source: 'local', path: './plugins/hello' },
          policy: { installation: 'NOT_AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'testing',
        },
      ],
    })
    const file = join(root, '.agents', 'plugins', 'marketplace.json')

    const listed = run(box, ['marketplace', 'list', '--from', file])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, / {2}hello {2}codex {2}local/u)
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
  const marketplace = parseMarketplace(text, 'lines.json', 'claude')
  assert.equal(marketplace.problems.length, 1)
  assert.equal(marketplace.problems[0].index, 0)
  assert.equal(marketplace.problems[0].name, undefined)
  assert.equal(marketplace.problems[0].line, 4)
  assert.match(marketplace.problems[0].reason, /"name" must be a bare plugin name/u)
})

// ---------------------------------------------------------------------------
// ticket #161: a Codex catalog is its own shape, selected by its path
// ---------------------------------------------------------------------------

test('the hand-authored Codex fixture lists every documented source shape with its format', () => {
  const box = sandbox()
  try {
    const listed = run(box, ['marketplace', 'list', '--from', codexFixture])
    // The root has no Claude catalog, so discovery found `.agents/plugins/`.
    assert.equal(listed.status, 1, listed.stderr)
    assert.match(listed.stdout, /^marketplace: codex-marketplace {2}.*\.agents\/plugins\/marketplace\.json/u)
    assert.match(listed.stdout, /\(7 entries, 3 malformed\)/u)
    assert.match(listed.stdout, / {2}Codex Marketplace Fixture/u)
    assert.match(listed.stdout, / {2}hello {2}codex {2}local {2}\.\/plugins\/hello/u)
    // The page allows a plain-string local source; it is the same local kind.
    assert.match(listed.stdout, / {2}hello-string {2}codex {2}local {2}\.\/plugins\/hello/u)
    assert.match(listed.stdout, / {2}remote-helper {2}codex {2}url {2}https:\/\/example\.invalid\/remote-helper\.git/u)
    assert.match(listed.stdout, / {2}git-helper {2}codex {2}git-subdir {2}https:\/\/example\.invalid\/mono\.git/u)
    assert.match(listed.stdout, / {2}npm-helper {2}codex {2}npm {2}@example\/helper@1\.0\.0/u)
    assert.match(listed.stdout, /policy: AVAILABLE \/ ON_INSTALL/u)
    assert.match(listed.stdout, /policy: NOT_AVAILABLE \/ ON_INSTALL/u)
    // A kind from the other file is a refusal naming the field, not an entry.
    assert.match(
      listed.stdout,
      /problem: plugins\[7\] \("claude-shaped"\) at line \d+: "source\.source" is "github"; a Codex source must be one of local, url, git-subdir, npm/u,
    )
    assert.match(
      listed.stdout,
      /problem: plugins\[8\] \("described"\) at line \d+: entry "described": field "description" is not a Codex marketplace entry field/u,
    )
    assert.match(
      listed.stdout,
      /problem: plugins\[9\] \("partial-policy"\) at line \d+: "policy\.authentication" must be a non-empty string/u,
    )
  } finally {
    cleanup(box.dir)
  }
})

test('Codex list --json carries the format, the interface title and the policy', () => {
  const box = sandbox()
  try {
    const listed = run(box, ['marketplace', 'list', '--from', codexCatalog, '--json'])
    assert.equal(listed.status, 1, listed.stderr)
    const payload = JSON.parse(listed.stdout)
    assert.equal(payload.format, 'codex')
    assert.equal(payload.displayName, 'Codex Marketplace Fixture')
    assert.equal(payload.entries.length, 7)
    const hello = payload.entries.find((entry) => entry.name === 'hello')
    assert.equal(hello.format, 'codex')
    assert.equal(hello.marketplace, 'codex-marketplace')
    assert.deepEqual(hello.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' })
    assert.deepEqual(hello.source, { kind: 'local', path: './plugins/hello' })
    const remote = payload.entries.find((entry) => entry.name === 'remote-helper')
    assert.equal(remote.installable, true)
    assert.equal(remote.unsupported, undefined)
    assert.deepEqual(
      payload.problems.map((problem) => problem.name),
      ['claude-shaped', 'described', 'partial-policy'],
    )
  } finally {
    cleanup(box.dir)
  }
})

test('Codex entries refuse their own malformed fields before any copy', () => {
  const box = sandbox()
  try {
    const described = run(box, ['marketplace', 'install', 'described', '--from', codexCatalog])
    assert.equal(described.status, 1)
    assert.match(described.stderr, /refused \(malformed-marketplace-entry\)/u)
    assert.match(described.stderr, /plugins\[8\] \("described"\) at line \d+/u)
    assert.match(described.stderr, /field "description" is not a Codex marketplace entry field/u)

    const policy = run(box, ['marketplace', 'install', 'partial-policy', '--from', codexCatalog])
    assert.equal(policy.status, 1)
    assert.match(policy.stderr, /"policy\.authentication" must be a non-empty string/u)

    // `hello-string` is a valid Codex entry (string local source) whose path
    // names a plugin that calls itself `hello`: the entry name is asserted
    // against the manifest, not used to rename the record.
    const mismatch = run(box, ['marketplace', 'install', 'hello-string', '--from', codexCatalog])
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /refused \(name-mismatch\)/u)
    assert.match(mismatch.stderr, /entry "hello-string" does not match the plugin its source declares/u)
    assert.match(mismatch.stderr, /--name "hello-string" does not match the plugin name "hello"/u)

    const escape = run(box, ['marketplace', 'install', 'escape', '--from', codexCatalog])
    assert.equal(escape.status, 1)
    assert.match(escape.stderr, /refused \(marketplace-path-escape\)/u)
    assert.match(escape.stderr, /outside the marketplace root/u)

    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a Codex entry must declare both policy and category', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'bare-codex')
    const bare = writeCodexCatalog(root, {
      name: 'bare-codex',
      plugins: [
        { name: 'no-policy', category: 'testing', source: './plugins/hello' },
        {
          name: 'no-category',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: './plugins/hello',
        },
      ],
    })
    const catalogFile = bare ?? join(root, '.agents', 'plugins', 'marketplace.json')

    const listed = run(box, ['marketplace', 'list', '--from', catalogFile])
    assert.equal(listed.status, 1, listed.stderr)
    assert.match(listed.stdout, /\(0 entries, 2 malformed\)/u)
    assert.match(
      listed.stdout,
      /problem: plugins\[0\] \("no-policy"\).*"policy" is required for a Codex marketplace entry/u,
    )
    assert.match(
      listed.stdout,
      /problem: plugins\[1\] \("no-category"\).*"category" is required for a Codex marketplace entry/u,
    )

    for (const name of ['no-policy', 'no-category']) {
      const refused = run(box, ['marketplace', 'install', name, '--from', catalogFile])
      assert.equal(refused.status, 1, refused.stderr)
      assert.match(refused.stderr, /refused \(malformed-marketplace-entry\)/u)
    }
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a malformed duplicate still makes the shared name ambiguous', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'malformed-duplicate')
    writeCatalog(root, {
      name: 'claude-side',
      plugins: [{ name: 'shared', source: './plugins/hello' }],
    })
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
    writeFileSync(
      join(root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'codex-side',
        plugins: [
          {
            name: 'shared',
            category: 'testing',
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            source: { source: 'local' },
          },
        ],
      }),
    )

    const listed = run(box, ['marketplace', 'list', '--from', root])
    assert.equal(listed.status, 1, listed.stderr)
    assert.match(listed.stdout, /\(1 entry, 1 malformed, 1 ambiguous\)/u)
    assert.match(listed.stdout, /duplicate entry name "shared"; also declared by .*\.claude-plugin\/marketplace\.json/u)

    const ambiguous = run(box, ['marketplace', 'install', 'shared', '--from', root])
    assert.equal(ambiguous.status, 1)
    assert.match(ambiguous.stderr, /refused \(ambiguous-marketplace-entry\)/u)
    assert.match(ambiguous.stderr, /duplicate entry name "shared"/u)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('--dialect across formats names the layout mismatch, not a missing version', () => {
  const box = sandbox()
  try {
    const wrongCodex = run(box, ['marketplace', 'install', 'codex-only', '--from', bothRoot, '--dialect', 'claude-code'])
    assert.equal(wrongCodex.status, 1)
    assert.match(wrongCodex.stderr, /refused \(dialect-mismatch\)/u)
    assert.match(wrongCodex.stderr, /entry "codex-only" is a codex entry/u)
    assert.match(wrongCodex.stderr, /declares a codex plugin/u)

    const wrongClaude = run(box, ['marketplace', 'install', 'claude-only', '--from', bothRoot, '--dialect', 'codex'])
    assert.equal(wrongClaude.status, 1)
    assert.match(wrongClaude.stderr, /refused \(dialect-mismatch\)/u)
    assert.match(wrongClaude.stderr, /entry "claude-only" is a claude-code entry/u)
    assert.match(wrongClaude.stderr, /declares a claude-code plugin/u)

    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('the catalog path, not a Codex marker, selects the parser', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'sniffed-as-claude')
    writeCatalog(root, {
      name: 'sniffed',
      interface: { displayName: 'Looks Codex' },
      plugins: [
        {
          name: 'hello',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'local', path: './plugins/hello' },
        },
      ],
    })
    const catalogFile = join(root, '.claude-plugin', 'marketplace.json')

    const listed = run(box, ['marketplace', 'list', '--from', catalogFile])
    assert.equal(listed.status, 1, listed.stderr)
    assert.match(
      listed.stdout,
      /problem: plugins\[0\] \("hello"\).*"source\.source" is "local"; a Claude local source is a "\.\/"-relative path string, not an object/u,
    )
    assert.match(listed.stdout, /note: marketplace: field "interface" is not carried by this slice/u)

    const refused = run(box, ['marketplace', 'install', 'hello', '--from', catalogFile])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(malformed-marketplace-entry\)/u)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a Codex remote entry keeps the D53 refusal in install and stays offline', () => {
  const box = sandbox()
  try {
    const refused = run(box, ['marketplace', 'install', 'remote-helper', '--from', codexCatalog])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(network-consent-required\)/u)
    assert.match(refused.stderr, /entry "codex-marketplace:remote-helper" is fetched, not read/u)
    assert.match(refused.stderr, /GET https:\/\/example\.invalid\/remote-helper\.git/u)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
    assert.equal(existsSync(join(box.home, 'anyplugin', 'marketplace-cache')), false, 'a refusal must not fetch')
  } finally {
    cleanup(box.dir)
  }
})

test('a Codex url source with a ref, or npm with a registry, is refused naming the field', () => {
  const text = JSON.stringify({
    name: 'closed-source',
    plugins: [
      {
        name: 'pinned',
        source: { source: 'url', url: 'https://example.invalid/pinned.git', ref: 'main' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'testing',
      },
      {
        name: 'registry',
        source: { source: 'npm', package: 'pkg', registry: 'https://registry.example.invalid' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'testing',
      },
    ],
  })
  const marketplace = parseMarketplace(text, codexCatalog)
  assert.equal(marketplace.entries.length, 0)
  assert.deepEqual(
    marketplace.problems.map((problem) => problem.name),
    ['pinned', 'registry'],
  )
  assert.match(marketplace.problems[0].reason, /"source\.ref" is not carried for a Codex "url" source/u)
  assert.match(marketplace.problems[1].reason, /"source\.registry" is not carried for a Codex "npm" source/u)
})

test('a directory --from discovers either catalog; a missing or foreign name is typed', () => {
  const box = sandbox()
  try {
    // A Claude root and a Codex root are both accepted as a directory.
    const claudeRootList = run(box, ['marketplace', 'list', '--from', fixture])
    assert.equal(claudeRootList.status, 1, claudeRootList.stderr)
    assert.match(claudeRootList.stdout, /^marketplace: local-marketplace {2}.*\.claude-plugin\/marketplace\.json/u)

    const codexRootList = run(box, ['marketplace', 'list', '--from', codexFixture])
    assert.equal(codexRootList.status, 1, codexRootList.stderr)
    assert.match(codexRootList.stdout, /^marketplace: codex-marketplace {2}.*\.agents\/plugins\/marketplace\.json/u)

    const empty = join(box.dir, 'no-catalog')
    mkdirSync(empty, { recursive: true })
    const notFound = run(box, ['marketplace', 'list', '--from', empty])
    assert.equal(notFound.status, 1)
    assert.match(notFound.stderr, /refused \(marketplace-not-found\)/u)
    assert.match(notFound.stderr, /\.claude-plugin\/marketplace\.json/u)
    assert.match(notFound.stderr, /\.agents\/plugins\/marketplace\.json/u)

    // A file that exists but is neither declared path is not guessed at.
    const elsewhere = join(box.dir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'marketplace.json'), JSON.stringify({ name: 'elsewhere', plugins: [] }))
    const unknown = run(box, ['marketplace', 'list', '--from', join(elsewhere, 'marketplace.json')])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /refused \(unknown-marketplace-format\)/u)
    assert.match(unknown.stderr, /not a Claude or Codex marketplace path/u)
  } finally {
    cleanup(box.dir)
  }
})

test('a root with both catalogs labels each row and refuses a name declared in both', () => {
  const box = sandbox()
  try {
    const listed = run(box, ['marketplace', 'list', '--from', bothRoot])
    assert.equal(listed.status, 1, listed.stderr)
    assert.match(listed.stdout, /^marketplace: claude-side \+ codex-side/u)
    assert.match(listed.stdout, /\(4 entries, 0 malformed, 1 ambiguous\)/u)
    assert.match(listed.stdout, /catalog: claude-side {2}claude-code {2}.*\.claude-plugin\/marketplace\.json/u)
    assert.match(listed.stdout, /catalog: codex-side {2}codex {2}.*\.agents\/plugins\/marketplace\.json/u)
    assert.match(listed.stdout, / {2}claude-only {2}claude-code {2}local {2}\.\/plugins\/claude-only/u)
    assert.match(listed.stdout, / {2}codex-only {2}codex {2}local {2}\.\/plugins\/codex-only/u)
    assert.match(
      listed.stdout,
      /problem: \[codex\] plugins\[1\] \("shared"\): duplicate entry name "shared"; also declared by .*\.claude-plugin\/marketplace\.json/u,
    )

    const ambiguous = run(box, ['marketplace', 'install', 'shared', '--from', bothRoot])
    assert.equal(ambiguous.status, 1)
    assert.match(ambiguous.stderr, /refused \(ambiguous-marketplace-entry\)/u)
    assert.match(ambiguous.stderr, /duplicate entry name "shared"/u)
    assert.match(ambiguous.stderr, /\.claude-plugin\/marketplace\.json/u)
    assert.match(ambiguous.stderr, /\.agents\/plugins\/marketplace\.json/u)
    assert.equal(existsSync(box.lock), false)

    // Each single-format entry still installs through the right dialect.
    const claude = run(box, ['marketplace', 'install', 'claude-only', '--from', bothRoot])
    assert.equal(claude.status, 0, claude.stderr)
    const codex = run(box, ['marketplace', 'install', 'codex-only', '--from', bothRoot])
    assert.equal(codex.status, 0, codex.stderr)
    const records = readInstalls(box.lock).plugins
    const claudeRecord = records.find((record) => record.name === 'claude-only')
    const codexRecord = records.find((record) => record.name === 'codex-only')
    assert.equal(claudeRecord.dialect, 'claude-code')
    assert.equal(claudeRecord.source.marketplace, 'claude-side')
    assert.equal(codexRecord.dialect, 'codex')
    assert.equal(codexRecord.source.marketplace, 'codex-side')

    // An explicit file is unambiguous: the same `shared` installs from the
    // Claude catalog without a merge.
    const explicit = sandbox()
    try {
      const fromFile = run(explicit, [
        'marketplace',
        'install',
        'shared',
        '--from',
        join(bothRoot, '.claude-plugin', 'marketplace.json'),
      ])
      assert.equal(fromFile.status, 0, fromFile.stderr)
      assert.equal(readInstalls(explicit.lock).plugins[0].dialect, 'claude-code')
    } finally {
      cleanup(explicit.dir)
    }
  } finally {
    cleanup(box.dir)
  }
})

test('a Claude entry keeps a Codex policy field as a note, not an install policy', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'claude-policy')
    writeCatalog(root, {
      name: 'claude-policy',
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
    assert.doesNotMatch(listed.stdout, /policy:/u)
    assert.match(listed.stdout, /note: entry "hello": field "policy" is not carried by this slice/u)

    const parsed = parseMarketplace(readFileSync(file, 'utf8'), file)
    assert.equal(parsed.entries[0].policy, undefined)
    assert.match(parsed.notes[0], /field "policy" is not carried/u)
  } finally {
    cleanup(box.dir)
  }
})

test('a Claude entry name that differs from its manifest name is refused before any write', () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'alias-catalog')
    writeCatalog(root, { name: 'alias-marketplace', plugins: [{ name: 'alias', source: './plugins/hello' }] })
    const file = join(root, '.claude-plugin', 'marketplace.json')
    const refused = run(box, ['marketplace', 'install', 'alias', '--from', file])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(name-mismatch\)/u)
    assert.match(refused.stderr, /entry "alias" does not match the plugin its source declares/u)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)
  } finally {
    cleanup(box.dir)
  }
})

test('parseMarketplace refuses a path it cannot classify, and accepts an explicit format', () => {
  const text = JSON.stringify({ name: 'm', plugins: [] })
  assert.throws(
    () => parseMarketplace(text, 'whatever.json'),
    (error) => error instanceof InstallCliError && error.code === 'unknown-marketplace-format',
  )
  assert.equal(parseMarketplace(text, 'whatever.json', 'claude').format, 'claude')
  assert.equal(parseMarketplace(text, '.claude-plugin/marketplace.json').format, 'claude')
  assert.equal(parseMarketplace(text, '.agents/plugins/marketplace.json').format, 'codex')
})
