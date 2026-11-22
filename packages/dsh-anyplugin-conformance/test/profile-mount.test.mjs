// Ticket #112 — the packed bundle mounts from a real profile through the
// host's own profile loader, not through the repository's test boot.
//
// `scripts/smoke-install.mjs` (ticket #79) extracts the tarball into a scratch
// tree and then composes the bundle patch itself: it reads the packed
// manifest, calls `composeEntries` and `ctx.loader.create(row)`. That proves
// the package's data, but it bypasses everything a profile contributes — the
// manifest's `dsh.profile.bundles`, `initProfile`'s package scope,
// `loadProfile`/`loadProfileDirectory`, `readProfilePatches` and `boot`'s root
// `cordis:include`. This test uses those host functions and asserts the tree
// the host builds.
//
// That the profile copy is what runs is asserted, not assumed: a
// `module.registerHooks` recorder captures the resolution of the bare entry
// name, and the captured URL must be the extracted tarball under the scratch
// profile, never this checkout. The boundary-control test below is the control
// for that assertion: it boots the same profile with
// `node_modules/dsh-anyplugin` symlinked to the checkout and requires the
// recorder to see the checkout URL, so a vacuous "every URL is somewhere"
// check cannot pass. The pack-gate test below runs the three ticket mutations
// against the npm-installed tarball and requires three distinct messages.
//
// The mount is shared with `scripts/profile-boot.mjs`, which the pack gate
// (`scripts/check-pack.mjs`, S20, #137) runs against the npm-installed tarball
// in a scratch profile. `initProfile` → profile manifest → `loadProfile` →
// `readProfilePatches` → `boot` is implemented once, there, so this test and
// the pack gate cannot drift into two different boots.
//
// Two host seams are named here rather than assumed:
//
//   * `PluginPackages` is the host's installation-path interception. It needs
//     `node-addon-require-builtin`, whose napi binding fails with
//     `Unsupported/no-getter` on some Node patches (24.22.2 and 24.12.0) and
//     works on others (24.22.3, 24.21.0); S18 measures that patch boundary.
//     When it initializes, the positive test below asserts its effect: no scope
//     link, and the `cordis-plugin-group` entry resolves from the installation
//     tree. When it cannot initialize, the profile borrows the installation's
//     `@deepseek-ai` scope with a link — the same fallback
//     `scripts/smoke-install.mjs` uses — and `hostPath` records that. On CI the
//     fallback is a failure: the Node CI runs must prove closure.
//   * The profile template bundle (the stock base application bundle) is not
//     in the fetched harness union, so the profile lists only `dsh-anyplugin`
//     and the services the assertions need (`skillRegistry`, `profileContext`)
//     are provided by this test's prepare, as the launcher does for its own.
//
// Install: pnpm 10.28.1 with the host's `pnpm-workspace.yaml` (hoisted linker,
// `autoInstallPeers: false`) was measured in the spike: `pnpm add <tarball>`
// records `file:...` and leaves the `~4.1.0` peer out. The suite is offline,
// so this test produces the same layout by extracting the tarball into the
// profile's `node_modules` and linking the three declared runtime dependencies
// from the checkout, exactly as `scripts/smoke-install.mjs` does.
//
// Node floor: `module.registerHooks` landed in 22.15. The published engine
// floor stays 22.14 (it describes the package, not this test); here the API is
// imported dynamically and the seven tests below skip with a reason naming the
// version when it is absent, so an older Node reports skips instead of a
// link-time failure.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'

import { bootPackedTarball, expectMutation, mountProfile } from '../../../scripts/profile-boot.mjs'
import { harnessSkipReason, isCI, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE = join(repoRoot, 'fixtures', 'claude-skills-only')
// Not one of `PROFILE_TEMPLATES` (acp/web/headless/sdk-minimal): those would
// be rewritten by `normalizeShippedProfile`, and this test wants the manifest
// it writes to be the manifest the host reads back.
const PROFILE_NAME = 'profile-mount'
const PIN = 'claude-code@2.1.329'
const SCHEMA = 'dsh-anyplugin/installs@1'

// Dynamic: a static named import of `registerHooks` fails to link on 22.14,
// before a skip can be reported.
const moduleApi = await import('node:module').catch(() => ({}))
const registerHooks = moduleApi.registerHooks

const harness = resolveHarness()
const nodeFloorSkip =
  typeof registerHooks === 'function'
    ? false
    : `the profile mount needs module.registerHooks (Node >= 22.15); this is ${process.version}`
const skip = harness ? nodeFloorSkip : harnessSkipReason()
const options = { skip, timeout: 240_000 }

const loadFromHarness = (harnessDir, specifier) =>
  import(pathToFileURL(join(harnessDir, specifier)).href)

let packDir
let tarball
let host

/** The host modules and the fixture body the assertions below are based on. */
async function hostPrimitives() {
  if (host === undefined) {
    const appBoot = await loadFromHarness(harness.harnessDir, 'dsh-app-boot/lib/index.js')
    const { default: SkillRegistry, renderSkillContent } = await loadFromHarness(
      harness.harnessDir,
      'dsh-skill/lib/index.js',
    )
    const helloPath = join(FIXTURE, 'skills', 'hello', 'SKILL.md')
    const helloBody = readFileSync(helloPath, 'utf8').split('---').at(-1).trim()
    assert.equal(helloBody, 'Say hello to the user.')
    host = { appBoot, SkillRegistry, renderSkillContent, helloBody }
  }
  return host
}

/** Build and pack exactly the way `npm run check:pack` does. */
function packedTarball() {
  if (tarball !== undefined) return tarball
  packDir = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-pack-'))
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
  const [entry] = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  )
  tarball = join(packDir, entry.filename)
  return tarball
}

function extractPackage(profileDir, tarballPath) {
  const packageDir = join(profileDir, 'node_modules', 'dsh-anyplugin')
  mkdirSync(packageDir, { recursive: true })
  execFileSync('tar', ['-xzf', tarballPath, '-C', packageDir, '--strip-components=1'])
  // The tarball's declared runtime dependencies: `@babel/core` and
  // `@babel/plugin-transform-react-jsx` for the `.tsx` path,
  // `@modelcontextprotocol/client` for the MCP materializer. A hoisted
  // `pnpm add` puts them beside the bundle; the offline test links the
  // checkout's copies instead.
  for (const scope of ['@babel', '@modelcontextprotocol']) {
    symlinkSync(join(repoRoot, 'node_modules', scope), join(profileDir, 'node_modules', scope), 'dir')
  }
  return packageDir
}

function writeLock(home, mode) {
  const anypluginDir = join(home, 'anyplugin')
  mkdirSync(anypluginDir, { recursive: true })
  if (mode === 'missing') {
    // No lock at all: the controller must stay active and mount nothing.
    writeFileSync(join(anypluginDir, 'enabled.yml'), 'plugins: {}\n')
    return join(anypluginDir, 'installs.yml')
  }
  if (mode === 'corrupt') {
    // YAML the schema reader must reject with a line: the harness still boots,
    // the controller reports a typed `InstallsFileError` and stays inactive.
    writeFileSync(join(anypluginDir, 'installs.yml'), `schema: "${SCHEMA}"\nplugins: [this is not a mapping\n`)
  } else {
    writeFileSync(
      join(anypluginDir, 'installs.yml'),
      [
        `schema: "${SCHEMA}"`,
        'plugins:',
        '  - dialect: "claude-code"',
        '    name: "skills-only"',
        '    version: "0.0.1"',
        `    root: ${JSON.stringify(FIXTURE)}`,
        `    dataDir: ${JSON.stringify(join(home, 'data', 'skills-only'))}`,
        `    pin: ${JSON.stringify(PIN)}`,
        '',
      ].join('\n'),
    )
  }
  writeFileSync(
    join(anypluginDir, 'enabled.yml'),
    ['plugins:', `  claude-code:skills-only: { enabled: ${mode !== 'disabled'} }`, ''].join('\n'),
  )
  return join(anypluginDir, 'installs.yml')
}

/**
 * Compose one scratch profile and boot it with the host's own functions.
 *
 * The caller owns the scratch tree and must dispose the returned context; the
 * returned `moduleUrls` are every resolution of the bare bundle name.
 * `symlinkToRepo` is the control for the URL assertion: it replaces the
 * extracted profile copy with the checkout, so a correct recorder must report
 * the checkout instead.
 */
async function bootProfile(appBoot, SkillRegistry, mode, { symlinkToRepo = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), `dsh-anyplugin-profile-${mode}-`))
  const home = join(scratch, 'home')
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let ctx

  try {
    const packageDir = join(profileDir, 'node_modules', 'dsh-anyplugin')
    // The profile is composed the way the launcher composes it: the host's own
    // `initProfile` writes the manifest, `pnpm-workspace.yaml` and the empty
    // `cordis.patch.yml`; the package lands in the profile's node_modules.
    appBoot.initProfile(profileDir, ['dsh-anyplugin'])
    extractPackage(profileDir, packedTarball())
    if (symlinkToRepo) {
      rmSync(packageDir, { recursive: true, force: true })
      symlinkSync(repoRoot, packageDir, 'dir')
    }
    const installsPath = writeLock(home, mode)

    const installAnchor = join(harness.installRoot, 'package.json')
    const profile = appBoot.loadProfile('dsh', PROFILE_NAME, installAnchor, home)
    // The mount is shared with the pack gate's npm-installed profile boot
    // (`scripts/profile-boot.mjs`), so S17 and #137 prove the same boot.
    const mounted = await mountProfile({
      appBoot,
      registerHooks,
      SkillRegistry,
      harnessDir: harness.harnessDir,
      installAnchor,
      profile,
      home,
      cwd: repoRoot,
    })
    ctx = mounted.ctx
    return {
      ...mounted,
      profileDir,
      packageDir,
      installsPath,
      home,
      scratch,
      profile,
    }
  } catch (error) {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (ctx !== undefined) {
      try {
        await ctx.fiber.dispose()
      } catch {
        // best-effort cleanup of the failed scenario
      }
    }
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
}

async function withProfile(appBoot, SkillRegistry, mode, body, options) {
  const previousHome = process.env.DSH_HOME
  const mounted = await bootProfile(appBoot, SkillRegistry, mode, options)
  try {
    await body(mounted)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    try {
      await mounted.ctx.fiber.dispose()
    } catch {
      // Disposal is best-effort cleanup; the assertions already ran.
    }
    rmSync(mounted.scratch, { recursive: true, force: true })
  }
}

test('positive: installs.yml mounts one active group and its skill child', options, async (t) => {
  const { appBoot, SkillRegistry, renderSkillContent, helloBody } = await hostPrimitives()
  await withProfile(
    appBoot,
    SkillRegistry,
    'positive',
    async ({
      ctx,
      logs,
      moduleUrls,
      groupUrls,
      profileDir,
      packageDir,
      installsPath,
      home,
      hostPath,
      pluginPackagesCapable,
    }) => {
      assert.ok(home.startsWith(tmpdir()), 'the scratch home must stay under the temp dir')
      assert.equal(ctx.fiber.state, 2, 'the harness itself must boot')
      t.diagnostic(`host path: ${hostPath}`)

      if (pluginPackagesCapable) {
        // The addon initializes on this Node, so the boot must use the host's
        // interception. A fallback here would mean S17 proved the stand-in even
        // though the real path was available.
        assert.equal(hostPath, 'PluginPackages', 'a Node that initializes PluginPackages must boot through it')
        assert.equal(
          existsSync(join(profileDir, 'node_modules', '@deepseek-ai')),
          false,
          'the interception path must not create a scope-link stand-in',
        )
        assert.ok(groupUrls.length > 0, 'the group entry must resolve through the loader')
        const installationPrefix = `${pathToFileURL(harness.harnessDir).href}/`
        for (const url of groupUrls) {
          assert.ok(
            url.startsWith(installationPrefix),
            `the group entry must resolve from the installation tree, got ${url}`,
          )
        }
      } else if (isCI(process.env)) {
        assert.fail(
          `CI's Node ${process.version} cannot initialize PluginPackages, so installation closure is not asserted; ` +
            'S18 measured 24.22.2 failing and 24.22.3 working — pin the gate to a Node on the working side',
        )
      } else {
        assert.match(hostPath, /^scope-link/, 'an incapable Node must take the scope-link path')
      }

      const entries = [...ctx.loader.entries()]
      const controller = entries.find((entry) => entry.options?.id === 'dsh-anyplugin')
      assert.ok(controller, 'the profile patch must insert the controller entry')
      assert.equal(controller.fiber?.state, 2, 'the controller must be active')

      const groups = entries.filter(
        (entry) =>
          entry.parent === ctx.loader.root &&
          typeof entry.options?.id === 'string' &&
          entry.options.id.startsWith('anyplugin.'),
      )
      assert.equal(groups.length, 1, 'exactly one plugin group')
      const [group] = groups
      assert.match(group.options.id, /^anyplugin\.claude-code/)
      assert.match(group.options.id, /skills-only/)
      assert.equal(group.options.group, true, 'the row must be a loader group')
      assert.equal(group.fiber?.state, 2, 'the group must settle active')

      const children = group.options.config ?? []
      const skillChild = children.find((child) => child.name === 'dsh-anyplugin/materialize/skill')
      assert.ok(skillChild, 'the group must carry a skill child row')
      assert.equal(ctx.loader.resolve(skillChild.id)?.fiber?.state, 2, 'the skill child must be active')

      const skills = await ctx.skills.list()
      assert.deepEqual(skills.map((skill) => skill.name).sort(), ['greet', 'hello'])
      const rendered = renderSkillContent(await ctx.skills.get('hello'))
      assert.ok(rendered.includes(helloBody), `rendered skill content must carry the fixture body:\n${rendered}`)

      // The module URL is the claim: a mount of the checkout's `lib/index.js`
      // would leave every other assertion above unchanged.
      assert.ok(moduleUrls.length > 0, 'the bundle name must have been resolved')
      const packageUrl = pathToFileURL(packageDir).href
      for (const url of moduleUrls) {
        assert.match(url, /\/dsh-anyplugin\/lib\/index\.js$/)
        assert.ok(url.startsWith(`${packageUrl}/`), `the controller must load from the profile, got ${url}`)
        assert.ok(!url.startsWith(pathToFileURL(repoRoot).href), `the controller must not load from the checkout, got ${url}`)
      }

      // Reading the scratch lock is visible in the reconcile line; the count it
      // reports is deliberately not asserted (see the header: the include's
      // load pass settles the group after the loader's await returns).
      assert.ok(
        logs.some(
          (record) =>
            record.name === 'dsh-anyplugin' &&
            record.args.join(' ').includes(`from ${installsPath}`),
        ),
        'the controller must report reconciling the scratch installs.yml',
      )
    })
})

test('negative: no installs.yml boots the harness with zero plugins', options, async () => {
  const { appBoot, SkillRegistry } = await hostPrimitives()
  await withProfile(appBoot, SkillRegistry, 'missing', async ({ ctx, logs, moduleUrls, installsPath }) => {
    assert.equal(ctx.fiber.state, 2)
    const controller = [...ctx.loader.entries()].find((entry) => entry.options?.id === 'dsh-anyplugin')
    assert.equal(controller?.fiber?.state, 2, 'a missing lock is not an error')
    assert.equal(groupsOf(ctx).length, 0)
    assert.equal((await ctx.skills.list()).length, 0)
    assert.ok(
      logs.some(
        (record) =>
          record.name === 'dsh-anyplugin' &&
          record.args.join(' ').includes(`no lock at ${installsPath}`),
      ),
      'the controller must say it found no lock at the scratch home',
    )
    assert.ok(moduleUrls.length > 0, 'the bundle still mounts when there is nothing to reconcile')
  })
})

test('negative: a corrupt installs.yml is a typed controller error and the harness still boots', options, async () => {
  const { appBoot, SkillRegistry } = await hostPrimitives()
  await withProfile(appBoot, SkillRegistry, 'corrupt', async ({ ctx, logs, installsPath }) => {
    assert.equal(ctx.fiber.state, 2, 'a bad lock must not take the host down')
    const controller = [...ctx.loader.entries()].find((entry) => entry.options?.id === 'dsh-anyplugin')
    assert.equal(controller?.fiber?.state, 3, 'the controller must be the failed entry')
    assert.equal(groupsOf(ctx).length, 0)
    const record = logs.find(
      (entry) =>
        entry.name === 'dsh-anyplugin' &&
        entry.type === 'error' &&
        entry.args.join(' ').includes('InstallsFileError'),
    )
    assert.ok(record, 'the failure must name the typed error')
    assert.ok(record.args.join(' ').includes(installsPath), 'the typed error must name the file')
  })
})

test('negative: a disabled plugin mounts no group', options, async () => {
  const { appBoot, SkillRegistry } = await hostPrimitives()
  await withProfile(appBoot, SkillRegistry, 'disabled', async ({ ctx }) => {
    const controller = [...ctx.loader.entries()].find((entry) => entry.options?.id === 'dsh-anyplugin')
    assert.equal(controller?.fiber?.state, 2)
    assert.equal(groupsOf(ctx).length, 0, 'an enabled: false plugin must not be mounted')
    assert.equal((await ctx.skills.list()).length, 0)
  })
})

// M2 of the three mutations the ticket asked for, kept as a permanent control:
// the same working profile, with the extracted package replaced by a link to
// this checkout. Everything about the tree is still correct; only the module
// URL changes. If this control passed the positive URL assertion, that
// assertion would be vacuous.
test('boundary: the URL assertion separates the profile copy from the checkout', options, async (t) => {
  const { appBoot, SkillRegistry } = await hostPrimitives()
  await withProfile(
    appBoot,
    SkillRegistry,
    'positive',
    async ({ ctx, moduleUrls, packageDir }) => {
      assert.equal(ctx.fiber.state, 2)
      assert.equal(groupsOf(ctx).length, 1, 'the control profile must mount the same tree')
      t.diagnostic('the extracted package was replaced by a link to this checkout')

      const checkoutUrl = pathToFileURL(join(repoRoot, 'lib', 'index.js')).href
      const packageUrl = pathToFileURL(packageDir).href
      assert.ok(moduleUrls.length > 0, 'the bundle name must have been resolved')
      for (const url of moduleUrls) {
        assert.equal(url, checkoutUrl, `the recorder must see the checkout copy, got ${url}`)
        assert.ok(!url.startsWith(`${packageUrl}/`), 'the checkout URL must not look like the profile copy')
      }
    },
    { symlinkToRepo: true },
  )
})

// The pack gate's subject is the artifact, so the ticket's three mutations are
// kept as tests: each must redden for its own reason, and the three reasons must
// be distinguishable. `expectMutation` boots the tarball through the npm-
// installed profile path the gate uses (`scripts/profile-boot.mjs`), not this
// test's extraction path, so a passing mutation here is evidence about S20.
test('pack: the three ticket mutations redden with distinct messages', options, async () => {
  const tarball = packedTarball()
  const messages = []
  for (const mutation of ['no-patch', 'no-bundle', 'checkout']) {
    const result = await expectMutation({ tarball, mutation })
    assert.equal(result.reddened, true)
    messages.push(result.message)
  }
  assert.equal(
    new Set(messages).size,
    3,
    `each mutation must fail for its own reason:\n${messages.join('\n')}`,
  )
})

// The real-profile guard must be scoped. The Desktop host writes its own
// `sessions/` and `storages/` under `$DSH_HOME` while the gate runs, so those
// two names are excluded there — but the same names under `$DSH_PROFILE_DIR`
// are ordinary profile content, and a write to them is a violation. This boot
// writes both inside the guarded window: the home is compared first and passes
// only because the exclusion is scoped, and the failure must name the profile.
test('guard: a profile sessions/ write reddens while the home exclusion covers its own', options, async () => {
  const tarball = packedTarball()
  const home = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-guard-home-'))
  const profile = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-guard-profile-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(profile, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'live.txt'), 'home before\n')
  writeFileSync(join(profile, 'sessions', 'live.txt'), 'profile before\n')
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  try {
    await assert.rejects(
      bootPackedTarball({
        tarball,
        afterBoot: async () => {
          appendFileSync(join(home, 'sessions', 'live.txt'), 'the host wrote\n')
          appendFileSync(join(profile, 'sessions', 'live.txt'), 'the host wrote\n')
        },
      }),
      (error) => {
        assert.match(
          String(error.message),
          /the real DSH_PROFILE_DIR .* changed during the boot/,
          `the profile write must be the failure, got: ${String(error.message)}`,
        )
        assert.doesNotMatch(String(error.message), /the real DSH_HOME .* changed/)
        return true
      },
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    rmSync(home, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

after(() => {
  if (packDir !== undefined) rmSync(packDir, { recursive: true, force: true })
})

/** Root-level `anyplugin.*` group entries: the controller's only public output. */
function groupsOf(ctx) {
  return [...ctx.loader.entries()].filter(
    (entry) =>
      entry.parent === ctx.loader.root &&
      typeof entry.options?.id === 'string' &&
      entry.options.id.startsWith('anyplugin.'),
  )
}
