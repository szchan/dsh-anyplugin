// Ticket #109: `rig install`, `list`, `enable`, `disable` and `uninstall`.
//
// The contract is a file contract: the CLI is a *caller* of the canonical
// installs.yml writer, and the enablement layers are the only place a scope is
// written (D2). Every test therefore runs the real CLI against a temp
// `$DSH_HOME` and inspects the bytes it left behind — the real profile is
// never read or written. The dry-run cases compare checksums, because "prints
// a diff" is not the claim; "writes nothing" is.
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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compileEntries, readEnablements, readInstalls, reconcile } from '../../dsh-anyplugin-install/src/index.ts'
import { GRANTS_SCHEMA, grantsPath, writeGrants } from '../../dsh-anyplugin-trust/src/index.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))
const claudeFixture = join(repoRoot, 'fixtures', 'claude-skills-only')
const codexFixture = join(repoRoot, 'fixtures', 'codex-portable')
const refusedFixture = join(repoRoot, 'fixtures', 'claude-hooks-lifecycle')
const skillMaterializer = pathToFileURL(
  join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts'),
).href

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-install-cli-'))
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

function copyFixture(source, dir, name) {
  const target = join(dir, name)
  cpSync(source, target, { recursive: true })
  return target
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

const id = 'claude-code:skills-only'

test('install → list → disable → enable → uninstall moves the record and the layer independently', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    const first = run(box, ['install', claude])
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /install claude-code:skills-only: added/)
    assert.match(first.stdout, /report: 2 declared, 2 emitted, 0 refused, 0 skipped/)
    assert.match(first.stdout, /enablement: user written \(enabled: true\)/)

    const lock = readInstalls(box.lock)
    assert.equal(lock.schema, 'dsh-anyplugin/installs@2')
    assert.equal(lock.plugins.length, 1)
    assert.equal(lock.plugins[0].dialect, 'claude-code')
    assert.equal(lock.plugins[0].name, 'skills-only')
    assert.equal(lock.plugins[0].version, '0.0.1')
    assert.equal(lock.plugins[0].root, claude)
    assert.equal(lock.plugins[0].dataDir, join(box.home, 'anyplugin', 'data', 'claude-code', 'skills-only'))
    assert.equal(lock.plugins[0].pin, 'claude-code@2.1.329')
    assert.match(lock.plugins[0].source, /^plugin-dir:/)

    // Idempotence is byte idempotence, not just exit 0.
    const bytes = readFileSync(box.lock, 'utf8')
    const layerBytes = readFileSync(box.userLayer, 'utf8')
    const again = run(box, ['install', claude])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /already installed/)
    assert.equal(readFileSync(box.lock, 'utf8'), bytes)
    assert.equal(readFileSync(box.userLayer, 'utf8'), layerBytes)

    const listed = run(box, ['list', '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    const payload = JSON.parse(listed.stdout)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.plugins.map((plugin) => plugin.id), [id])
    assert.deepEqual(payload.plugins[0].enabledScopes, ['user'])
    assert.equal(payload.plugins[0].effective.enabled, true)
    assert.equal(payload.plugins[0].effective.scope, 'user')
    assert.equal(payload.plugins[0].report.totals.emitted, 2)

    const disabled = run(box, ['disable', id])
    assert.equal(disabled.status, 0, disabled.stderr)
    assert.match(disabled.stdout, /disabled claude-code:skills-only at user scope/)
    assert.deepEqual(readEnablements({ projectDir: box.project, home: box.home }).user.plugins[id], {
      enabled: false,
      grants: [],
    })
    const inert = JSON.parse(run(box, ['list', '--json']).stdout)
    assert.deepEqual(inert.plugins[0].enabledScopes, [])
    assert.equal(inert.plugins[0].effective.enabled, false)
    assert.equal(inert.plugins[0].effective.scope, 'user')

    const enabled = run(box, ['enable', 'skills-only'])
    assert.equal(enabled.status, 0, enabled.stderr)
    assert.match(enabled.stdout, /enabled claude-code:skills-only at user scope/)

    const removed = run(box, ['uninstall', id])
    assert.equal(removed.status, 0, removed.stderr)
    assert.match(removed.stdout, /record: removed/)
    assert.match(removed.stdout, /lock: .* \(0 plugins left\)/)
    assert.match(removed.stdout, /enablement: user still mention\(s\) it/)
    assert.deepEqual(readInstalls(box.lock), { schema: 'dsh-anyplugin/installs@2', plugins: [] })
    assert.equal(
      existsSync(box.userLayer),
      true,
      'uninstall removes the record, not the workspace policy that mentions it',
    )

    const empty = run(box, ['list'])
    assert.equal(empty.status, 0, empty.stderr)
    assert.match(empty.stdout, /\(empty\)/)
  } finally {
    cleanup(box.dir)
  }
})

test('the Codex fixture autodetects by plugin.json and lists the pinned dialect', () => {
  const box = sandbox()
  try {
    const codex = copyFixture(codexFixture, box.dir, 'codex')
    const installed = run(box, ['install', codex])
    assert.equal(installed.status, 0, installed.stderr)
    assert.match(installed.stdout, /install codex:codex-portable: added/)
    assert.match(installed.stdout, /pin: agent-plugins@1\.0\.0/)
    assert.equal(readInstalls(box.lock).plugins[0].dialect, 'codex')
    const payload = JSON.parse(run(box, ['list', '--json']).stdout)
    assert.equal(payload.plugins[0].pin, 'agent-plugins@1.0.0')
    assert.equal(payload.plugins[0].report.totals.emitted > 0, true)
  } finally {
    cleanup(box.dir)
  }
})

test('--config re-points the lock, and data dirs follow it', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    const lock = join(box.dir, 'custom', 'lock.yml')
    const installed = run(box, ['install', claude, '--config', lock])
    assert.equal(installed.status, 0, installed.stderr)
    assert.equal(existsSync(box.lock), false, 'the default lock must not be touched')
    const record = readInstalls(lock).plugins[0]
    assert.equal(record.dataDir, join(box.dir, 'custom', 'data', 'claude-code', 'skills-only'))
    const listed = JSON.parse(run(box, ['list', '--config', lock, '--json']).stdout)
    assert.equal(listed.file, lock)
    assert.equal(listed.plugins.length, 1)

    // A relative --config is cwd-relative: reading it from a directory that
    // does not hold it is a wrong-directory error, not an empty lock.
    const missing = run(box, ['list', '--config', 'relative/missing.yml', '--json'], { cwd: box.dir })
    assert.equal(missing.status, 1)
    const payload = JSON.parse(missing.stdout)
    assert.equal(payload.refusals[0].code, 'unreadable-lock')
    assert.match(payload.refusals[0].reason, /is relative and does not exist/)
  } finally {
    cleanup(box.dir)
  }
})

test('a reinstall at the same scope keeps an explicit disable', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    assert.equal(run(box, ['install', claude, '--scope', 'user']).status, 0)
    const disabled = run(box, ['disable', id, '--scope', 'user'])
    assert.equal(disabled.status, 0, disabled.stderr)
    const layerBytes = readFileSync(box.userLayer, 'utf8')
    const layerDigest = digest(box.userLayer)

    const again = run(box, ['install', claude, '--scope', 'user'])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /already installed/)
    assert.match(again.stdout, /enablement: user already mentions it; left as is/)
    assert.match(again.stdout, /WARNING: effective: disabled at user/)
    assert.doesNotMatch(again.stdout, /written \(enabled: true\)/)
    assert.equal(readFileSync(box.userLayer, 'utf8'), layerBytes)
    assert.equal(digest(box.userLayer), layerDigest)
    assert.match(readFileSync(box.userLayer, 'utf8'), /enabled: false/)
  } finally {
    cleanup(box.dir)
  }
})

test('unknown options are refused before any write', () => {
  const claude = join(repoRoot, 'fixtures', 'claude-skills-only')
  for (const flag of ['--dryrun', '--dry-run=false', '--bogus']) {
    const box = sandbox()
    try {
      const result = run(box, ['install', claude, flag])
      assert.equal(result.status, 2, `${flag} must not be accepted`)
      assert.match(result.stderr, /unknown option --/)
      assert.equal(existsSync(box.lock), false, `${flag} must not write the lock`)
      assert.equal(existsSync(box.userLayer), false, `${flag} must not write a layer`)
    } finally {
      cleanup(box.dir)
    }
  }

  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    assert.equal(run(box, ['install', claude]).status, 0)
    const before = readFileSync(box.lock, 'utf8')
    const result = run(box, ['uninstall', id, '--dryrun'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /unknown option --dryrun/)
    assert.equal(readFileSync(box.lock, 'utf8'), before)
  } finally {
    cleanup(box.dir)
  }
})

test('a plugin that declares nothing is refused as nothing-declared', () => {
  const box = sandbox()
  try {
    const empty = join(box.dir, 'empty-plugin')
    mkdirSync(join(empty, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(empty, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'empty-plugin', description: 'no components', version: '0.0.1' }),
    )
    const result = run(box, ['install', empty, '--json'])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.refusals[0].code, 'nothing-declared')
    assert.match(payload.refusals[0].reason, /declares no components/)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('list names refused components and both commands report retained grants', () => {
  const box = sandbox()
  try {
    const lifecycle = copyFixture(refusedFixture, box.dir, 'hooks-lifecycle')
    const granted = run(box, ['install', lifecycle, '--allow-empty'])
    assert.equal(granted.status, 0, granted.stderr)
    writeGrants(grantsPath(box.lock), {
      schema: GRANTS_SCHEMA,
      grants: [
        {
          plugin: 'claude-code:hooks-lifecycle',
          capability: 'exec',
          target: 'hook:SessionStart#0',
          artifactHash: `sha256:${'a'.repeat(64)}`,
          grantedAt: '2026-11-21T00:00:00.000Z',
          scope: 'user',
        },
      ],
      revokes: [],
    })
    const listed = run(box, ['list'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /refused: hooks\/SessionStart#0 \(exec\)/)
    assert.match(listed.stdout, /grants: 1 retained/)

    const removed = run(box, ['uninstall', 'claude-code:hooks-lifecycle'])
    assert.equal(removed.status, 0, removed.stderr)
    assert.match(removed.stdout, /grants: 1 retained/)
    assert.equal(existsSync(grantsPath(box.lock)), true)
  } finally {
    cleanup(box.dir)
  }
})

test('--dry-run prints the exact diff and every byte (and inode) stays put', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')

    // Nothing exists yet: a dry run must not even create the directory.
    const fresh = run(box, ['install', claude, '--dry-run'])
    assert.equal(fresh.status, 0, fresh.stderr)
    assert.match(fresh.stdout, /nothing written/)
    assert.match(fresh.stdout, /^\s*\+   - dialect: "claude-code"$/m)
    assert.match(fresh.stdout, /^\s*\+     name: "skills-only"$/m)
    assert.match(fresh.stdout, /^\s*\+     pin: "claude-code@2\.1\.329"$/m)
    assert.equal(existsSync(box.lock), false)
    assert.equal(existsSync(box.userLayer), false)

    const installed = run(box, ['install', claude])
    assert.equal(installed.status, 0, installed.stderr)
    const lockSum = digest(box.lock)
    const layerSum = digest(box.userLayer)
    const lockInode = inode(box.lock)
    const layerInode = inode(box.userLayer)

    const disable = run(box, ['disable', id, '--dry-run'])
    assert.equal(disable.status, 0, disable.stderr)
    assert.match(disable.stdout, /^\s*-   claude-code:skills-only: \{ enabled: true \}$/m)
    assert.match(disable.stdout, /^\s*\+   claude-code:skills-only: \{ enabled: false \}$/m)
    assert.equal(digest(box.lock), lockSum)
    assert.equal(digest(box.userLayer), layerSum)
    assert.equal(inode(box.lock), lockInode)
    assert.equal(inode(box.userLayer), layerInode)

    const uninstall = run(box, ['uninstall', id, '--dry-run'])
    assert.equal(uninstall.status, 0, uninstall.stderr)
    assert.match(uninstall.stdout, /nothing written/)
    assert.match(uninstall.stdout, /^\s*-   - dialect: "claude-code"$/m)
    assert.equal(digest(box.lock), lockSum)
    assert.equal(digest(box.userLayer), layerSum)
    assert.equal(inode(box.lock), lockInode)
    assert.equal(inode(box.userLayer), layerInode)
  } finally {
    cleanup(box.dir)
  }
})

test('a same-name plugin from another root is refused as cross-root; --force is the override', () => {
  const box = sandbox()
  try {
    const first = copyFixture(claudeFixture, box.dir, 'claude-a')
    const second = copyFixture(claudeFixture, box.dir, 'claude-b')
    assert.equal(run(box, ['install', first]).status, 0)
    const bytes = readFileSync(box.lock, 'utf8')

    const refusal = run(box, ['install', second, '--json'])
    assert.equal(refusal.status, 1)
    const payload = JSON.parse(refusal.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.refusals[0].code, 'cross-root')
    assert.match(payload.refusals[0].reason, /refusing to repoint/)
    assert.equal(readFileSync(box.lock, 'utf8'), bytes, 'a refusal must not rewrite the lock')

    // Same root, changed version: the record differs; --force replaces it.
    const manifest = join(first, '.claude-plugin', 'plugin.json')
    const plugin = JSON.parse(readFileSync(manifest, 'utf8'))
    writeFileSync(manifest, `${JSON.stringify({ ...plugin, version: '0.0.2' }, null, 2)}\n`)
    const differs = run(box, ['install', first])
    assert.equal(differs.status, 1)
    assert.match(differs.stderr, /refused \(record-differs\)/)
    assert.equal(readFileSync(box.lock, 'utf8'), bytes)

    const forced = run(box, ['install', first, '--force'])
    assert.equal(forced.status, 0, forced.stderr)
    assert.match(forced.stdout, /install claude-code:skills-only: updated/)
    assert.equal(readInstalls(box.lock).plugins[0].version, '0.0.2')
  } finally {
    cleanup(box.dir)
  }
})

test('--name is an assertion, not a rename', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    const result = run(box, ['install', claude, '--name', 'renamed', '--json'])
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).refusals[0].code, 'name-mismatch')
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('a corrupt installs.yml is refused with the parser message and no partial write', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    mkdirSync(join(box.home, 'anyplugin'), { recursive: true })
    const corrupt = [
      'schema: "dsh-anyplugin/installs@1"',
      'plugins:',
      '  - dialect: "claude-code"',
      '    name: "skills-only"',
      '',
    ].join('\n')
    writeFileSync(box.lock, corrupt)

    const result = run(box, ['install', claude, '--json'])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.refusals[0].code, 'corrupt-lock')
    assert.match(payload.refusals[0].reason, /installs\.yml:\d+: missing required field "version"/, 'the parser line is surfaced verbatim')
    assert.equal(readFileSync(box.lock, 'utf8'), corrupt)
    assert.equal(existsSync(box.userLayer), false)

    // A missing lock is not corruption: it is an empty lock.
    rmSync(box.lock)
    assert.equal(run(box, ['install', claude]).status, 0)
  } finally {
    cleanup(box.dir)
  }
})

test('a corrupt scope layer refuses enable/disable and writes neither file', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    assert.equal(run(box, ['install', claude]).status, 0)
    mkdirSync(join(box.project, '.dsh'), { recursive: true })
    writeFileSync(box.projectLayer, 'not plugins:\n')

    const result = run(box, ['enable', id, '--scope', 'project', '--project', box.project, '--json'])
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).refusals[0].code, 'corrupt-enablement')
    assert.equal(readFileSync(box.projectLayer, 'utf8'), 'not plugins:\n')
  } finally {
    cleanup(box.dir)
  }
})

test('install at one scope, enable at another: the narrower layer decides (D2)', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    const installed = run(box, ['install', claude, '--scope', 'project', '--project', box.project])
    assert.equal(installed.status, 0, installed.stderr)
    assert.match(installed.stdout, /enablement: project written/)
    assert.equal(existsSync(box.userLayer), false, 'install never invents a second scope')
    assert.equal(readInstalls(box.lock).plugins.length, 1, 'the record is profile-global')

    const user = run(box, ['enable', id, '--scope', 'user'])
    assert.equal(user.status, 0, user.stderr)
    assert.deepEqual(readEnablements({ projectDir: box.project, home: box.home }).user.plugins[id], {
      enabled: true,
      grants: [],
    })

    const listed = JSON.parse(run(box, ['list', '--json', '--project', box.project]).stdout)
    assert.deepEqual(listed.plugins[0].enabledScopes, ['project', 'user'])
    assert.equal(listed.plugins[0].effective.scope, 'project')
    assert.equal(listed.plugins[0].effective.enabled, true)

    const disabled = run(box, ['disable', id, '--scope', 'project', '--project', box.project])
    assert.equal(disabled.status, 0, disabled.stderr)
    const after = JSON.parse(run(box, ['list', '--json', '--project', box.project]).stdout)
    assert.deepEqual(after.plugins[0].enabledScopes, ['user'])
    assert.equal(after.plugins[0].effective.scope, 'project')
    assert.equal(after.plugins[0].effective.enabled, false, 'project disable beats user enable')
    assert.equal(readInstalls(box.lock).plugins.length, 1, 'disable does not delete the record')
  } finally {
    cleanup(box.dir)
  }
})

test('a plugin that emits only refusals is refused unless --allow-empty says otherwise', () => {
  const box = sandbox()
  try {
    const lifecycle = copyFixture(refusedFixture, box.dir, 'hooks-lifecycle')
    const refused = run(box, ['install', lifecycle, '--json'])
    assert.equal(refused.status, 1)
    const payload = JSON.parse(refused.stdout)
    assert.equal(payload.refusals[0].code, 'nothing-emitted')
    assert.match(payload.refusals[0].reason, /0 emitted, 5 refused/)
    assert.match(payload.refusals[0].reason, /hooks\/SessionStart#0 refused:exec/)
    assert.equal(existsSync(box.lock), false)

    const allowed = run(box, ['install', lifecycle, '--allow-empty'])
    assert.equal(allowed.status, 0, allowed.stderr)
    const listed = JSON.parse(run(box, ['list', '--json']).stdout)
    assert.equal(listed.plugins[0].report.totals.emitted, 0)
    assert.equal(listed.plugins[0].report.totals.refused, 5)
    assert.equal(listed.plugins[0].report.ok, true)
  } finally {
    cleanup(box.dir)
  }
})

test('unknown dialect, unreadable directory, and unknown plugin are typed non-zero refusals', () => {
  const box = sandbox()
  try {
    const claude = copyFixture(claudeFixture, box.dir, 'claude')
    const dialect = run(box, ['install', claude, '--dialect', 'nope', '--json'])
    assert.equal(dialect.status, 1)
    assert.equal(JSON.parse(dialect.stdout).refusals[0].code, 'unknown-dialect')

    const missing = run(box, ['install', join(box.dir, 'absent'), '--json'])
    assert.equal(missing.status, 1)
    assert.equal(JSON.parse(missing.stdout).refusals[0].code, 'unreadable-directory')
    assert.equal(existsSync(box.lock), false)

    assert.equal(run(box, ['install', claude]).status, 0)
    const unknown = run(box, ['uninstall', 'claude-code:absent', '--json'])
    assert.equal(unknown.status, 1)
    assert.equal(JSON.parse(unknown.stdout).refusals[0].code, 'unknown-plugin')
    assert.match(JSON.parse(unknown.stdout).refusals[0].reason, /claude-code:skills-only/)
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// The real loader: install's desired entry tree reconciles in, uninstall's
// empty tree reconciles out. Gated like every other harness test (D22).
// ---------------------------------------------------------------------------

const harness = resolveHarness()
const installedDir = harness?.harnessDir

function loaderBaseUrl(harnessDir) {
  const product = join(harnessDir, 'dsh')
  const anchor = existsSync(join(product, 'package.json')) ? product : join(harnessDir, '..', '..')
  return pathToFileURL(`${anchor}/`).href
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withLoader(boot) {
  const load = (specifier) => import(pathToFileURL(join(installedDir, specifier)).href)
  const { Context } = await load('cordis/lib/index.js')
  const Loader = (await load('cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await load('dsh-skill/lib/index.js')).default

  const ctx = new Context()
  const loaderFiber = ctx.plugin(Loader, { baseUrl: loaderBaseUrl(installedDir) })
  ctx.plugin(SkillRegistry, {})
  await until(() => Boolean(ctx.loader) && Boolean(ctx.skills), 'loader and skills services')
  try {
    await boot(ctx)
  } finally {
    loaderFiber.dispose()
  }
}

test(
  'the installed lock reconciles its group in, and uninstall reconciles it out',
  { skip: installedDir ? false : harnessSkipReason() },
  () =>
    withLoader(async (ctx) => {
      const box = sandbox()
      try {
        const claude = copyFixture(claudeFixture, box.dir, 'claude')
        const installed = run(box, ['install', claude, '--scope', 'project', '--project', box.project])
        assert.equal(installed.status, 0, installed.stderr)

        const loadDesired = () =>
          compileEntries(readInstalls(box.lock), {
            materializers: { skill: skillMaterializer },
            enablements: readEnablements({ projectDir: box.project, home: box.home }),
          })

        const desired = loadDesired()
        assert.equal(desired.length, 1)
        const group = desired[0].id
        const created = await reconcile(ctx.loader, desired)
        assert.deepEqual(created, { created: [group], updated: [], removed: [], kept: [], failed: [], refused: [] })
        assert.equal(ctx.loader.resolve(group).fiber.state, 2, 'the group entry is active')

        const removed = run(box, ['uninstall', 'claude-code:skills-only', '--project', box.project])
        assert.equal(removed.status, 0, removed.stderr)
        assert.match(removed.stdout, new RegExp(`entry tree: removed ${group.replace(/\./g, '\\.')}`))
        assert.match(removed.stdout, /remaining \(none\)/)

        // The layer still mentions the plugin, but no record is installed, so
        // the desired tree is empty: the entry must go away.
        assert.equal(loadDesired().length, 0)
        const reconciled = await reconcile(ctx.loader, loadDesired())
        assert.deepEqual(reconciled, { created: [], updated: [], removed: [group], kept: [], failed: [], refused: [] })
        assert.throws(() => ctx.loader.resolve(group), 'the group is gone after uninstall + reconcile')
      } finally {
        cleanup(box.dir)
      }
    }),
)

// --- a mod is an installable component, gated exactly like a hook ----------

const modsFixture = join(repoRoot, 'packages', 'dsh-anyplugin-dialect-claude-code', 'test', 'fixtures', 'claude-mods')
const modTarget = 'mod:hooks/register.ts'

test('installing a mod without a grant refuses before the lock is written', () => {
  const box = sandbox()
  try {
    const plugin = copyFixture(modsFixture, box.dir, 'mods')
    const refused = run(box, ['install', plugin])
    assert.equal(refused.status, 1, refused.stdout + refused.stderr)
    assert.match(refused.stdout + refused.stderr, /nothing-emitted/)
    assert.match(refused.stdout + refused.stderr, /mods\/hooks\/register\.ts/)
    assert.equal(existsSync(box.lock), false, 'a refused install writes no lock')
  } finally {
    cleanup(box.dir)
  }
})

test('a granted mod installs, the lock carries its tree, and list names the entry and digest', () => {
  const box = sandbox()
  try {
    const plugin = copyFixture(modsFixture, box.dir, 'mods')
    const grants = join(box.home, 'anyplugin', 'grants.yml')
    const granted = run(box, ['grant', '--plugin', plugin, '--grants', grants, '--yes'])
    assert.equal(granted.status, 0, granted.stdout + granted.stderr)
    assert.match(granted.stdout, new RegExp(modTarget))
    assert.match(granted.stdout, /entry: hooks\/register\.ts \(4 files, tree sha256:[0-9a-f]{64}\)/)

    const installed = run(box, ['install', plugin])
    assert.equal(installed.status, 0, installed.stdout + installed.stderr)
    assert.match(installed.stdout, /mod: hooks\/register\.ts \(composite, 4 files\) sha256:[0-9a-f]{64}/)
    const lock = readInstalls(box.lock)
    assert.equal(lock.schema, 'dsh-anyplugin/installs@2')
    assert.deepEqual(lock.plugins[0].mods.map((mod) => [mod.entry, mod.rootRelative, mod.mode]), [
      ['hooks/register.ts', 'hooks', 'composite'],
    ])
    assert.equal(lock.plugins[0].mods[0].files.length, 4)
    assert.match(lock.plugins[0].mods[0].artifactHash, /^sha256:[0-9a-f]{64}$/)

    const listed = JSON.parse(run(box, ['list', '--json']).stdout)
    assert.deepEqual(listed.plugins[0].mods.map((mod) => mod.entry), ['hooks/register.ts'])
    assert.equal(listed.plugins[0].report.totals.emitted, 1)
    const text = run(box, ['list']).stdout
    assert.match(text, /mod: hooks\/register\.ts \(composite, 4 files\) sha256:[0-9a-f]{64}/)
  } finally {
    cleanup(box.dir)
  }
})

test('changed module bytes invalidate the grant: install refuses and names the refusal', () => {
  const box = sandbox()
  try {
    const plugin = copyFixture(modsFixture, box.dir, 'mods')
    const grants = join(box.home, 'anyplugin', 'grants.yml')
    assert.equal(run(box, ['grant', '--plugin', plugin, '--grants', grants, '--yes']).status, 0)
    writeFileSync(join(plugin, 'hooks', 'support', 'note.ts'), 'export function note(): string {\n  return "changed"\n}\n')
    const refused = run(box, ['install', plugin])
    assert.equal(refused.status, 1)
    assert.match(refused.stdout + refused.stderr, /mods\/hooks\/register\.ts refused:exec/)
    assert.match(refused.stdout + refused.stderr, /hash|changed|re-grant/)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

test('revoke works after uninstall, when the plugin directory is already gone', () => {
  const box = sandbox()
  try {
    const plugin = copyFixture(modsFixture, box.dir, 'mods')
    const grants = join(box.home, 'anyplugin', 'grants.yml')
    assert.equal(run(box, ['grant', '--plugin', plugin, '--grants', grants, '--yes']).status, 0)
    assert.equal(run(box, ['install', plugin]).status, 0)
    assert.equal(run(box, ['uninstall', 'claude-code:mods']).status, 0)

    rmSync(plugin, { recursive: true, force: true })
    const revoked = run(box, ['revoke', '--plugin', plugin, '--grants', grants, '--target', modTarget])
    assert.equal(revoked.status, 0, revoked.stdout + revoked.stderr)
    assert.match(revoked.stdout, new RegExp(modTarget))
    assert.match(revoked.stdout, /revoke written at user scope/)
    assert.match(revoked.stdout, /REVOKED \(artifact unavailable\)/)
  } finally {
    cleanup(box.dir)
  }
})

test('list refuses a mod the lock does not record, even with a matching grant', () => {
  const box = sandbox()
  try {
    const plugin = copyFixture(modsFixture, box.dir, 'mods')
    const grants = join(box.home, 'anyplugin', 'grants.yml')
    assert.equal(run(box, ['grant', '--plugin', plugin, '--grants', grants, '--yes']).status, 0)
    assert.equal(run(box, ['install', plugin]).status, 0)

    // A genuine 0.1.0 lock: same record, no `mods` paragraph. The grant is
    // still in grants.yml, so only the lock can decide whether the tree boots.
    const lines = readFileSync(box.lock, 'utf8').split('\n')
    const at = lines.findIndex((line) => line.startsWith('    mods:'))
    assert.notEqual(at, -1, 'the installed lock should carry a mods block')
    let end = at + 1
    while (end < lines.length && lines[end].startsWith('      ')) end += 1
    const legacy = [...lines.slice(0, at), ...lines.slice(end)]
      .join('\n')
      .replace('schema: "dsh-anyplugin/installs@2"', 'schema: "dsh-anyplugin/installs@1"')
    writeFileSync(box.lock, legacy)

    const listed = run(box, ['list'])
    assert.equal(listed.status, 0, listed.stdout + listed.stderr)
    assert.match(listed.stdout, /mod not recorded: hooks\/register\.ts — not-recorded:/)
    assert.doesNotMatch(listed.stdout, /mod \(emitted\): hooks\/register\.ts/)

    const json = JSON.parse(run(box, ['list', '--json']).stdout)
    assert.deepEqual(json.plugins[0].mods, [])
    assert.equal(json.plugins[0].report.notRecorded[0].name, 'hooks/register.ts')
  } finally {
    cleanup(box.dir)
  }
})
