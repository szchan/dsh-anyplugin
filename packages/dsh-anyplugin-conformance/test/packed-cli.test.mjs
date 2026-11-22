// Ticket #146: the tarball a registry user actually gets, run end to end.
//
// Every other CLI test runs the checkout's source. This one builds, packs and
// extracts the artifact, then:
//
//   1. runs `lib/cli.js --help` from the extracted copy with no DSH variable at
//      all — the "npm user on a machine without the harness" claim;
//   2. fingerprints a scratch `$DSH_HOME` (sentinel files included), runs
//      `install <absolute fixture dir> --dry-run`, and requires the fingerprint
//      to be unchanged;
//   3. runs the same install without `--dry-run` and requires exactly one lock
//      record plus exactly two new files — `installs.yml`/`enabled.yml` — with
//      every pre-existing byte identical.
//
// It deliberately does not import the source CLI: the thing under test is the
// packed file. The lock is read back through the canonical reader (`readInstalls`)
// so "one record" means the parser's one record, not one `- dialect:` line.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readInstalls } from '../../dsh-anyplugin-install/src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'claude-skills-only')

/** path → sha256 for every file under `dir`; directories are not bytes. */
function fingerprint(dir) {
  const files = new Map()
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, key)
      else if (entry.isFile()) files.set(key, createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  walk(dir, '')
  return files
}

test('packed artifact: install from the extracted tarball writes one record and nothing else', () => {
  const work = mkdtempSync(join(tmpdir(), 'anyplugin-packed-cli-'))
  try {
    const packDir = join(work, 'pack')
    mkdirSync(packDir)
    // The same build the publish path runs (prepack → build), then
    // `--ignore-scripts` so the bytes under test are the built ones.
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], { cwd: repoRoot, stdio: 'pipe' })
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )[0]
    const tarball = join(packDir, packed.filename)
    const tree = join(work, 'unpacked')
    mkdirSync(tree)
    execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', tree], { stdio: 'pipe' })

    const bin = join(tree, 'lib', 'cli.js')
    assert.equal(existsSync(bin), true, `the tarball has no lib/cli.js:\n${packed.files.map((file) => file.path).join('\n')}`)
    const manifest = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.bin, { 'dsh-anyplugin': './lib/cli.js' })

    const home = join(work, 'home')
    mkdirSync(join(home, 'profiles', 'sentinel'), { recursive: true })
    writeFileSync(join(home, 'sentinel.txt'), 'this file must survive unchanged\n')
    writeFileSync(join(home, 'profiles', 'sentinel', 'config.json'), '{"sentinel":true}\n')

    // The only environment a user needs: no DSH_HARNESS_DIR, no CLAUDE_BIN, no
    // ANYPLUGIN_*; `--help` gets no DSH_HOME either.
    const run = (args, extraEnv = {}) =>
      spawnSync(process.execPath, [bin, ...args], {
        cwd: tree,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home, ...extraEnv },
      })

    const help = run(['--help'])
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /^dsh-anyplugin — install foreign agent plugins/)
    assert.match(help.stdout, /rig install <plugin-dir>/)

    const before = fingerprint(home)
    const dry = run(['install', fixture, '--dry-run'], { DSH_HOME: home })
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /^install claude-code:skills-only: added \(dry run — nothing written\)$/m)
    assert.deepEqual(fingerprint(home), before, 'install --dry-run changed $DSH_HOME')
    assert.equal(existsSync(join(home, 'anyplugin', 'installs.yml')), false)

    const real = run(['install', fixture], { DSH_HOME: home })
    assert.equal(real.status, 0, real.stderr)
    assert.match(real.stdout, /^install claude-code:skills-only: added$/m)

    const after = fingerprint(home)
    for (const [path, hash] of before) {
      assert.equal(after.get(path), hash, `${path} changed under a real install`)
    }
    const added = [...after.keys()].filter((path) => !before.has(path)).sort()
    assert.deepEqual(added, ['anyplugin/enabled.yml', 'anyplugin/installs.yml'])

    const lock = readInstalls(join(home, 'anyplugin', 'installs.yml'))
    assert.equal(lock.plugins.length, 1)
    assert.equal(lock.plugins[0].dialect, 'claude-code')
    assert.equal(lock.plugins[0].name, 'skills-only')
    assert.equal(lock.plugins[0].root, fixture)
    assert.match(readFileSync(join(home, 'anyplugin', 'enabled.yml'), 'utf8'), /claude-code:skills-only/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
