/**
 * profile-boot — boot the freshly packed tarball through the host's profile
 * loader, in a scratch profile, and say exactly what the boot observed.
 *
 * `scripts/check-pack.mjs` proves the tarball's bytes and
 * `scripts/smoke-install.mjs` proves a hermetic install by composing the bundle
 * patch itself. Neither boots the artifact the way a user does: a profile whose
 * `package.json` lists the package in `dependencies` and `dsh.profile.bundles`,
 * installed by npm, then loaded by the host's own `loadProfile` →
 * `readProfilePatches` → `boot` (ticket #137, S20). This script is that boot.
 *
 * `packages/dsh-anyplugin-conformance/test/profile-mount.test.mjs` (S17) calls
 * the same `mountProfile` helper, so there is one boot implementation, not two.
 *
 * Usage:
 *   node scripts/profile-boot.mjs <tarball>                  # the gate
 *   node scripts/profile-boot.mjs --pack                     # build + pack, then boot
 *   node scripts/profile-boot.mjs --mutation=no-patch <tarball>
 *
 * A mutation run inverts the check: it must fail for the named reason, and the
 * process prints `mutation <name>: reddened — <message>` and exits 0 only when
 * that reason is the one observed. `--mutation` names the ticket's three:
 *
 *   no-patch  the tarball is repacked without `cordis.patch.yml`;
 *   no-bundle the profile's `dsh.profile.bundles` does not list the bundle;
 *   checkout  the installed package is replaced by a link to this checkout.
 *
 * The real `$DSH_HOME` and `$DSH_PROFILE_DIR` are fingerprinted before and
 * after; the boot must not touch them. The running Desktop host writes its own
 * session state under `$DSH_HOME/sessions` and `$DSH_HOME/storages` while the
 * boot runs, so those two host-owned subtrees are excluded from the home
 * fingerprint only, and the exclusion is printed rather than hidden. Every other
 * path is compared by content (files up to 64 KiB) plus size/mtime; the profile
 * fingerprint has no exclusion, so `<profile>/sessions` is an ordinary path.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { harnessSkipReason, isCI, resolveHarness } from '../packages/dsh-anyplugin-conformance/src/harness.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(repoRoot, 'fixtures', 'claude-skills-only')
const PROFILE_NAME = 'pack-profile'
const PIN = 'claude-code@2.1.329'
const SCHEMA = 'dsh-anyplugin/installs@1'
// Files larger than this are compared by size and mtime; a real $DSH_HOME has
// a few hundred MB of session transcripts, and hashing them twice per boot
// costs seconds without adding a path the install could write.
const MAX_HASH_BYTES = 64 * 1024
// The live Desktop host owns these two directories only under `$DSH_HOME`;
// the profile fingerprint excludes nothing (a write there is a violation).
const HOST_LIVE_STATE = new Set(['sessions', 'storages'])
const MUTATIONS = new Map([
  ['no-patch', /^bundle skipped: "dsh-anyplugin": .*cordis\.patch\.yml/s],
  ['no-bundle', /^the profile's dsh\.profile\.bundles does not list dsh-anyplugin/u],
  ['checkout', /^dsh-anyplugin resolved outside the profile node_modules: file:\/\//u],
])

/** Build and pack exactly the way `check:pack` does. Returns the tarball path. */
export function packTarball() {
  const packDir = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-pack-'))
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], { cwd: repoRoot, stdio: 'pipe' })
  const [entry] = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  return join(packDir, entry.filename)
}

/**
 * Boot one packed tarball in a scratch profile and return what the boot saw.
 *
 * The caller gets no say in which package is loaded: the profile manifest lists
 * it, npm installs it into the profile, and the boot records the module URL that
 * actually resolved. A mutation changes the artifact or the profile, never the
 * assertions that follow.
 *
 * `afterBoot` is a test seam for the real-profile guard: it runs inside the
 * guarded window — after the scratch boot, before the snapshots are compared —
 * so a test can prove that a write under either watched root reddens the boot.
 * The gate never passes it.
 *
 * `realHome` and `realProfile` name the roots the guard fingerprints. The gate
 * passes neither, so it guards the ambient `$DSH_HOME`/`$DSH_PROFILE_DIR`, which
 * is the install a user is running. A test passes a throwaway pair it owns,
 * because the running Desktop writes its own state under the ambient roots
 * while the boot runs; guarding them from a test would redden on the host's
 * write, not the boot's (issue #165).
 */
export async function bootPackedTarball({
  tarball,
  mutation = 'none',
  afterBoot,
  realHome: guardedHome,
  realProfile: guardedProfile,
} = {}) {
  if (!['none', ...MUTATIONS.keys()].includes(mutation)) throw new Error(`unknown mutation ${JSON.stringify(mutation)}`)
  if (!existsSync(tarball)) throw new Error(`the packed tarball ${tarball} does not exist`)
  const harness = resolveHarness()
  if (harness === undefined) throw new Error(`no DSH harness resolved: ${harnessSkipReason()}`)
  const moduleApi = await import('node:module')
  if (typeof moduleApi.registerHooks !== 'function') {
    throw new Error(`the profile boot needs module.registerHooks (Node >= 22.15); this is ${process.version}`)
  }

  const host = await loadHost(harness.harnessDir)
  const realHome = guardedHome === undefined ? realHomeDir() : resolve(guardedHome)
  const realProfile = guardedProfile === undefined ? realProfileDir(realHome) : resolve(guardedProfile)
  const beforeHome = fingerprint(realHome, { hostLiveState: true })
  const beforeProfile = fingerprint(realProfile)
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-pack-profile-'))
  let failure
  let observed
  try {
    for (const [candidate, label] of [
      [realHome, 'DSH_HOME'],
      [realProfile, 'DSH_PROFILE_DIR'],
    ]) {
      if (candidate === undefined) continue
      if (sameOrInside(scratch, candidate) || sameOrInside(candidate, scratch)) {
        throw new Error(`the scratch profile ${scratch} overlaps the real ${label} ${candidate}`)
      }
    }
    observed = await bootInScratch({
      tarball,
      mutation,
      scratch,
      harness,
      host,
      registerHooks: moduleApi.registerHooks,
    })
    if (typeof afterBoot === 'function') await afterBoot(observed)
  } catch (error) {
    failure = error
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  assertUnchanged('DSH_HOME', realHome, beforeHome, fingerprint(realHome, { hostLiveState: true }))
  assertUnchanged('DSH_PROFILE_DIR', realProfile, beforeProfile, fingerprint(realProfile))
  if (failure !== undefined) throw failure
  return {
    ...observed,
    realHome: summarize(beforeHome, realHome),
    realProfile: summarize(beforeProfile, realProfile),
  }
}

/**
 * Run one mutation and require the exact failure the ticket names.
 *
 * Returns `{ mutation, reddened: true, message }` on success. A boot that
 * accepts the mutated artifact, or fails for a different reason, is an error:
 * that is how a vacuous assertion would otherwise pass as a successful mutation.
 *
 * `realHome` and `realProfile` are forwarded to `bootPackedTarball`; the
 * profile-mount test uses them to guard a throwaway home and profile it owns
 * instead of the ambient roots the live Desktop writes to (issue #165).
 */
export async function expectMutation({ tarball, mutation, realHome, realProfile }) {
  const expected = MUTATIONS.get(mutation)
  if (expected === undefined) throw new Error(`unknown mutation ${JSON.stringify(mutation)}`)
  let error
  let observed
  try {
    observed = await bootPackedTarball({ tarball, mutation, realHome, realProfile })
  } catch (caught) {
    error = caught
  }
  if (error === undefined) {
    throw new Error(
      `mutation ${mutation} did not redden: the boot accepted the mutated artifact and observed ${JSON.stringify({
        hostPath: observed.hostPath,
        group: observed.group,
        module: observed.module,
      })}`,
    )
  }
  const message = String(error?.message ?? error)
  if (!expected.test(message)) {
    throw new Error(`mutation ${mutation} reddened for an unexpected reason: ${message}`)
  }
  return { mutation, reddened: true, message: message.split('\n')[0] }
}

/**
 * The shared profile mount.
 *
 * Given a profile the host has already loaded, this writes the profile root
 * config, creates the host's runtime resolution, provides the launcher's
 * context, and boots. It returns the context plus every observation the S17
 * test and the pack gate assert; it never decides whether a fallback is allowed
 * (the caller knows whether it runs under CI).
 */
export async function mountProfile({ appBoot, registerHooks, SkillRegistry, harnessDir, installAnchor, profile, home, cwd }) {
  const rootConfig = join(profile.dir, 'cordis.yml')
  // The launcher writes the profile root config before boot: the include reads
  // this file, and the bundle rows reach it through `patches`.
  writeFileSync(rootConfig, '# dsh profile root — an empty entry list.\n[]\n')

  const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile, home })

  // Whether the addon can initialize is measured, not inferred from the
  // version. If it can, the boot below must use it and the caller asserts the
  // effect; if it cannot, the caller decides whether the fallback is allowed.
  let pluginPackagesCapable = false
  const requireFromInstall = createRequire(installAnchor)
  try {
    const addon = requireFromInstall('node-addon-require-builtin')
    for (const id of [
      'internal/modules/esm/loader',
      'internal/modules/cjs/loader',
      'internal/modules/helpers',
      'internal/modules/esm/utils',
      'internal/modules/esm/resolve',
    ]) {
      addon.requireBuiltin(id)
    }
    pluginPackagesCapable = true
  } catch {
    // The known Node loader patch failure; the fallback below has to stand in
    // and the caller's assertions decide whether that is allowed here.
  }

  const profileContext = {
    name: profile.name,
    dir: profile.dir,
    patchPath: join(profile.dir, 'cordis.patch.yml'),
    installAnchor,
    startedBundles: profile.layers.map((layer) => layer.packageName),
    cwd,
    home,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED ?? '',
  }
  const patches = appBoot.readProfilePatches('dsh', profileContext, profile)

  const logs = []
  const moduleUrls = []
  const groupUrls = []
  let hostPath = 'Unsupported'
  let scopeLink = null
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      if (specifier === 'dsh-anyplugin') moduleUrls.push(result.url)
      if (specifier === '@deepseek-ai/cordis-plugin-group') groupUrls.push(result.url)
      return result
    },
  })
  try {
    const ctx = await appBoot.boot('dsh', rootConfig, patches, async (hostCtx) => {
      hostCtx.provide('profileContext', profileContext)
      hostCtx.logger.exporter({
        levels: { default: 4 },
        export: ({ type, name, args }) => logs.push({ type, name, args: args.map(String) }),
      })
      try {
        // The host's installation-path interception: resolves the bundle's
        // `@deepseek-ai/*` imports from the installation instead of the profile.
        await hostCtx.plugin(appBoot.PluginPackages, { resolution })
        hostPath = 'PluginPackages'
      } catch (error) {
        const message = String(error?.message ?? error)
        if (!/node-addon-require-builtin unsupported/.test(message)) {
          throw new Error(`PluginPackages failed for a reason other than the known Node loader surface: ${message}`)
        }
        hostPath = 'scope-link (PluginPackages unsupported)'
        const link = join(profile.dir, 'node_modules', '@deepseek-ai')
        try {
          symlinkSync(harnessDir, link, 'dir')
        } catch (linkError) {
          if (linkError?.code !== 'EEXIST') throw linkError
        }
        scopeLink = link
      }
      await hostCtx.plugin(SkillRegistry, {})
    })
    return {
      ctx,
      logs,
      moduleUrls,
      groupUrls,
      profileContext,
      patches,
      rootConfig,
      hostPath,
      pluginPackagesCapable,
      scopeLink,
    }
  } finally {
    hook.deregister()
  }
}

/**
 * The whole boot, from `initProfile` to the last observation, for one scratch
 * profile. Throws the mutation-specific failure when the artifact is mutated.
 */
async function bootInScratch({ tarball, mutation, scratch, harness, host, registerHooks }) {
  const { appBoot, SkillRegistry, renderSkillContent } = host
  const home = join(scratch, 'home')
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })
  const previousHome = process.env.DSH_HOME
  // The host reads the profile path explicitly everywhere below, but the
  // controller and the reconcile layer also consult the ambient home; make the
  // scratch home ambient so a missed parameter cannot reach the real one.
  process.env.DSH_HOME = home
  let ctx
  try {
    // The profile is composed the way the launcher composes it: the host's own
    // `initProfile` writes the manifest, `pnpm-workspace.yaml` and the empty
    // `cordis.patch.yml`; npm installs the package into the profile.
    appBoot.initProfile(profileDir, mutation === 'no-bundle' ? [] : ['dsh-anyplugin'])
    const source = mutation === 'no-patch' ? stripBundlePatch(tarball, scratch) : tarball
    prepareProfile(profileDir, source)
    npmInstall(profileDir, scratch)

    const packageDir = join(profileDir, 'node_modules', 'dsh-anyplugin')
    if (!existsSync(join(packageDir, 'lib', 'index.js'))) {
      throw new Error(`npm install left no ${packageDir}/lib/index.js`)
    }
    const installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (installed.name !== 'dsh-anyplugin' || installed.version !== '0.2.0') {
      throw new Error(`npm installed ${installed.name}@${installed.version}, not dsh-anyplugin@0.2.0`)
    }
    if (mutation === 'checkout') {
      // The same profile tree, with the installed package replaced by this
      // checkout. Everything about the profile still looks right; only the
      // module URL can tell the difference.
      rmSync(packageDir, { recursive: true, force: true })
      symlinkSync(repoRoot, packageDir, 'dir')
    }

    const installsPath = writeLock(home)
    const installAnchor = join(harness.installRoot, 'package.json')
    const profile = appBoot.loadProfile('dsh', PROFILE_NAME, installAnchor, home)

    // A bundle the host could not read is skipped, not fatal (the host's own
    // contract). A pack check that let that pass would ship a tarball whose
    // patch never reached the loader, so name the skip and stop.
    if (profile.skippedBundles.length > 0) {
      const [skipped] = profile.skippedBundles
      throw new Error(`bundle skipped: ${JSON.stringify(skipped.packageName)}: ${skipped.reason}`)
    }
    if (!profile.layers.some((layer) => layer.packageName === 'dsh-anyplugin')) {
      throw new Error("the profile's dsh.profile.bundles does not list dsh-anyplugin (no bundle layer was loaded)")
    }
    // The patch the boot applies must be the one npm installed into the
    // profile, not a copy from the checkout.
    if (!profile.layers.every((layer) => layer.patchPaths.every((file) => sameOrInside(file, packageDir)))) {
      throw new Error('the loaded bundle patch is not the one installed into the profile node_modules')
    }

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
    const { logs, moduleUrls, groupUrls, hostPath, pluginPackagesCapable } = mounted

    // The patch is applied, not merely present: compose the same layers the
    // boot used and find the controller row the patch inserts.
    const composed = appBoot.composeEntries([mounted.patches])
    if (!composed.some((row) => row.id === 'dsh-anyplugin')) {
      throw new Error('the bundle patch did not insert the dsh-anyplugin controller entry')
    }

    if (ctx.fiber.state !== 2) throw new Error(`the harness itself settled in state ${ctx.fiber.state}, not active`)
    const entries = [...ctx.loader.entries()]
    const controller = entries.find((entry) => entry.options?.id === 'dsh-anyplugin')
    if (controller === undefined) throw new Error('the controller entry is not in the loader tree')
    if (controller.fiber?.state !== 2) {
      throw new Error(`the controller entry settled in state ${controller.fiber?.state}, not active`)
    }

    const groups = entries.filter(
      (entry) =>
        entry.parent === ctx.loader.root &&
        typeof entry.options?.id === 'string' &&
        entry.options.id.startsWith('anyplugin.'),
    )
    if (groups.length !== 1) throw new Error(`exactly one plugin group must be mounted, found ${groups.length}`)
    const [group] = groups
    if (!/^anyplugin\.claude-code/u.test(group.options.id) || !/skills-only/u.test(group.options.id)) {
      throw new Error(`the mounted group is ${group.options.id}, not the fixture's anyplugin.claude-code…skills-only`)
    }
    if (group.options.group !== true) throw new Error(`the ${group.options.id} row is not a loader group`)
    if (group.fiber?.state !== 2) throw new Error(`the ${group.options.id} group settled in state ${group.fiber?.state}, not active`)
    const skillChild = (group.options.config ?? []).find((child) => child.name === 'dsh-anyplugin/materialize/skill')
    if (skillChild === undefined) throw new Error('the group carries no dsh-anyplugin/materialize/skill child row')
    if (ctx.loader.resolve(skillChild.id)?.fiber?.state !== 2) {
      throw new Error('the dsh-anyplugin/materialize/skill child is not active')
    }
    const skills = (await ctx.skills.list()).map((skill) => skill.name).sort()
    if (skills.join(',') !== 'greet,hello') throw new Error(`the mounted skills are ${JSON.stringify(skills)}, expected greet,hello`)
    const helloBody = readFileSync(join(FIXTURE, 'skills', 'hello', 'SKILL.md'), 'utf8').split('---').at(-1).trim()
    if (!renderSkillContent(await ctx.skills.get('hello')).includes(helloBody)) {
      throw new Error('the rendered hello skill does not carry the fixture body')
    }

    // The module URL is the claim: a mount of the checkout's `lib/index.js`
    // would leave every other assertion above unchanged.
    if (moduleUrls.length === 0) throw new Error('the bundle name was never resolved')
    const packageUrl = pathToFileURL(packageDir).href
    for (const url of moduleUrls) {
      if (!url.startsWith(`${packageUrl}/`)) {
        throw new Error(`dsh-anyplugin resolved outside the profile node_modules: ${url}`)
      }
      if (!/\/dsh-anyplugin\/lib\/index\.js$/u.test(url)) {
        throw new Error(`the controller resolved to ${url}, not the bundle entry`)
      }
    }
    if (
      !logs.some(
        (record) => record.name === 'dsh-anyplugin' && record.args.join(' ').includes(`from ${installsPath}`),
      )
    ) {
      throw new Error(`the controller never read the scratch lock at ${installsPath}`)
    }

    if (pluginPackagesCapable) {
      if (hostPath !== 'PluginPackages') {
        throw new Error(`this Node initializes PluginPackages, but the boot took ${hostPath}`)
      }
      if (existsSync(join(profileDir, 'node_modules', '@deepseek-ai'))) {
        throw new Error('the PluginPackages path must not create a scope-link stand-in')
      }
      if (groupUrls.length === 0) throw new Error('the group entry was never resolved')
      const installationPrefix = `${pathToFileURL(harness.harnessDir).href}/`
      for (const url of groupUrls) {
        if (!url.startsWith(installationPrefix)) {
          throw new Error(`the group entry must resolve from the installation tree, got ${url}`)
        }
      }
    } else if (isCI(process.env)) {
      throw new Error(
        `CI's Node ${process.version} cannot initialize PluginPackages, so installation closure is not asserted; ` +
          'S18 measured 24.22.2 failing and 24.22.3 working — pin the gate to a Node on the working side',
      )
    } else if (!/^scope-link/u.test(hostPath)) {
      throw new Error(`an incapable Node must take the scope-link path, took ${hostPath}`)
    }

    return {
      hostPath,
      pluginPackagesCapable,
      controller: 'dsh-anyplugin',
      group: group.options.id,
      child: 'dsh-anyplugin/materialize/skill',
      module: moduleUrls.find((url) => /\/dsh-anyplugin\/lib\/index\.js$/u.test(url)),
      installsPath,
      packageDir,
      skills,
    }
  } finally {
    if (ctx !== undefined) {
      try {
        await ctx.fiber.dispose()
      } catch {
        // Disposal is best-effort cleanup; the assertions already ran.
      }
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

/** The host modules and the fixture body the assertions are based on. */
async function loadHost(harnessDir) {
  const load = (specifier) => import(pathToFileURL(join(harnessDir, specifier)).href)
  const appBoot = await load('dsh-app-boot/lib/index.js')
  const { default: SkillRegistry, renderSkillContent } = await load('dsh-skill/lib/index.js')
  return { appBoot, SkillRegistry, renderSkillContent }
}

/** `npm install` the tarball the profile manifest names, offline, from the repository's cache. */
function npmInstall(profileDir, scratch) {
  const userconfig = join(scratch, 'npmrc')
  writeFileSync(userconfig, '')
  try {
    execFileSync(
      'npm',
      ['install', '--no-audit', '--no-fund', '--offline', '--ignore-scripts', '--legacy-peer-deps'],
      {
        cwd: profileDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          npm_config_cache: join(repoRoot, '.npm-cache'),
          npm_config_userconfig: userconfig,
          npm_config_offline: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_update_notifier: 'false',
          npm_config_loglevel: 'error',
        },
      },
    )
  } catch (error) {
    throw new Error(
      `npm install of the packed tarball failed: ${String(error.stdout ?? '')}${String(error.stderr ?? '')}${String(error.message ?? error)}`,
    )
  }
}

/**
 * Compose the profile manifest and lock for an offline install.
 *
 * `initProfile` writes `dependencies: {}`; the ticket's install adds the
 * tarball to it, which is what a user's `npm install <tarball>` records. npm
 * cannot resolve the tarball's `^` ranges offline — the cache that `npm ci`
 * leaves holds tarballs, not packuments, and a bare offline install fails
 * `ENOTCACHED` — so the profile also gets the repository's own lockfile, which
 * pins the versions this checkout installed. npm still installs (and prunes)
 * the whole closure itself: it never copies the checkout's `node_modules`.
 * What this does not prove is dependency *metadata* resolution; a range the
 * lock already satisfies is not re-resolved against a registry. S20 says so,
 * and the alternative — a registry round-trip in the gate — is the thing this
 * check exists to avoid.
 */
function prepareProfile(profileDir, tarball) {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, 'dsh-anyplugin': `file:${tarball}` }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  cpSync(join(repoRoot, 'package-lock.json'), join(profileDir, 'package-lock.json'))
}

/** Repack the tarball without its bundle patch — mutation `no-patch`. */
function stripBundlePatch(tarball, scratch) {
  const tree = join(scratch, 'stripped')
  mkdirSync(tree, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', tree], { stdio: 'pipe' })
  rmSync(join(tree, 'package', 'cordis.patch.yml'), { force: true })
  const stripped = join(scratch, 'dsh-anyplugin-no-patch.tgz')
  execFileSync('tar', ['-czf', stripped, '-C', tree, 'package'], { stdio: 'pipe' })
  return stripped
}

/** The lock the fixture needs: one skill-only plugin, enabled. */
function writeLock(home) {
  const anypluginDir = join(home, 'anyplugin')
  mkdirSync(anypluginDir, { recursive: true })
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
  writeFileSync(join(anypluginDir, 'enabled.yml'), 'plugins:\n  claude-code:skills-only: { enabled: true }\n')
  return join(anypluginDir, 'installs.yml')
}

/** The real Harness home the boot must not touch; a missing path fingerprints absent. */
function realHomeDir() {
  const named = process.env.DSH_HOME?.trim()
  return named === undefined || named === '' ? join(homedir(), '.dsh') : resolve(named)
}

/**
 * The real profile directory, named or conventional. Always a path: a missing
 * directory is a state the fingerprint reports as absent, not an unknown.
 */
function realProfileDir(home) {
  const named = process.env.DSH_PROFILE_DIR?.trim()
  if (named !== undefined && named !== '') return resolve(named)
  const name = process.env.DSH_PROFILE?.trim() || 'desktop'
  return join(home, 'profiles', name)
}

/**
 * A deterministic fingerprint of a tree.
 *
 * Every entry contributes its kind, mode, size and mtime; regular files up to
 * `MAX_HASH_BYTES` also contribute their sha256. Paths are compared one by one
 * (the map is retained) so a failure can name what changed instead of only
 * saying the digest differs. `sessions/` and `storages/` at the top of
 * `$DSH_HOME` are the live Desktop host's own state and are left out only when
 * `hostLiveState` is set — the home fingerprint. The profile fingerprint
 * excludes nothing: a write under `<profile>/sessions` is a violation.
 */
function fingerprint(dir, { hostLiveState = false } = {}) {
  const entries = new Map()
  if (dir === undefined) return { present: false, entries, digest: 'absent', files: 0, hashed: 0 }
  try {
    lstatSync(dir)
  } catch {
    // A root that does not exist is absent, not "present and unreadable": CI
    // has no real home or profile, and the boot must say so rather than print a
    // digest of nothing.
    return { present: false, entries, digest: 'absent', files: 0, hashed: 0 }
  }
  let files = 0
  let hashed = 0
  const hash = createHash('sha256')
  const walk = (relative) => {
    const absolute = relative === '' ? dir : join(dir, relative)
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      entries.set(relative, 'unreadable')
      return
    }
    const kind = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : stat.isFile() ? 'f' : 'o'
    let record = `${kind}:${stat.mode & 0o7777}:${stat.size}:${stat.mtimeMs}`
    if (kind === 'l') {
      try {
        record += `:${readlinkSync(absolute)}`
      } catch {
        record += ':unreadable'
      }
      entries.set(relative, record)
      return
    }
    if (kind === 'd') {
      entries.set(relative, record)
      for (const name of readdirSync(absolute).sort()) {
        if (hostLiveState && relative === '' && HOST_LIVE_STATE.has(name)) continue
        walk(relative === '' ? name : join(relative, name))
      }
      return
    }
    files += 1
    if (kind === 'f' && stat.size <= MAX_HASH_BYTES) {
      try {
        record += `:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`
        hashed += 1
      } catch {
        record += ':unreadable'
      }
    }
    entries.set(relative, record)
  }
  walk('')
  for (const path of [...entries.keys()].sort()) hash.update(`${path}\0${entries.get(path)}\n`)
  return { present: true, entries, digest: `sha256:${hash.digest('hex')}`, files, hashed }
}

function assertUnchanged(label, dir, before, after) {
  if (before.present !== after.present) {
    throw new Error(`the real ${label} ${dir === undefined ? '(unset)' : dir} appeared or disappeared during the boot`)
  }
  if (!before.present || before.digest === after.digest) return
  const changed = []
  for (const [path, record] of before.entries) {
    if (after.entries.get(path) !== record) changed.push(path === '' ? '.' : path)
  }
  for (const path of after.entries.keys()) {
    if (!before.entries.has(path)) changed.push(path === '' ? '.' : path)
  }
  throw new Error(
    `the real ${label} ${dir} changed during the boot: ${changed.length} path(s), e.g. ${changed.slice(0, 5).join(', ')}`,
  )
}

/** A short, loggable summary of a fingerprint. */
function summarize(fingerprintValue, dir) {
  if (fingerprintValue === undefined || !fingerprintValue.present) return { path: dir, state: 'absent' }
  return {
    path: dir,
    state: 'unchanged',
    digest: fingerprintValue.digest.slice(0, 19),
    files: fingerprintValue.files,
    hashed: fingerprintValue.hashed,
  }
}

function sameOrInside(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`)
}

/** One line `check:pack` parses; every claim the boot proves is named. */
function describe(observed) {
  const home = observed.realHome
  const profile = observed.realProfile
  return [
    `host path: ${observed.hostPath}`,
    'controller: dsh-anyplugin active',
    'patch: dsh-anyplugin inserted',
    `group: ${observed.group} active`,
    'child: dsh-anyplugin/materialize/skill active',
    `module: ${observed.module}`,
    `installs: ${observed.installsPath}`,
    home.state === 'absent'
      ? 'real home: absent'
      : `real home: ${home.state} ${home.digest}… (${home.files} files, ${home.hashed} content-hashed; sessions/ storages/ excluded)`,
    profile.state === 'absent'
      ? 'real profile: absent'
      : `real profile: ${profile.state} ${profile.digest}… (${profile.files} files, ${profile.hashed} content-hashed)`,
  ].join('; ')
}

async function main() {
  const args = process.argv.slice(2)
  const mutationArg = args.find((arg) => arg.startsWith('--mutation='))
  const mutation = mutationArg === undefined ? 'none' : mutationArg.slice('--mutation='.length)
  if (mutation !== 'none' && !MUTATIONS.has(mutation)) {
    throw new Error(`unknown --mutation=${mutation}; expected no-patch, no-bundle, or checkout`)
  }
  let tarball
  if (args.includes('--pack')) {
    tarball = packTarball()
  } else {
    tarball = args.find((arg) => !arg.startsWith('--'))
  }
  if (tarball === undefined || !existsSync(tarball)) {
    throw new Error('usage: node scripts/profile-boot.mjs <tarball> [--mutation=no-patch|no-bundle|checkout] [--pack]')
  }
  if (mutation === 'none') {
    const observed = await bootPackedTarball({ tarball })
    process.stdout.write(`profile boot: ok — ${describe(observed)}\n`)
    return
  }
  const result = await expectMutation({ tarball, mutation })
  process.stdout.write(`mutation ${mutation}: reddened — ${result.message}\n`)
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  if (!process.execArgv.includes('--experimental-vm-modules')) {
    const child = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit' },
    )
    process.exit(child.status ?? 1)
  }
  await main().catch((error) => {
    process.stderr.write(`profile boot: ${String(error?.stack ?? error)}\n`)
    process.exitCode = 1
  })
}
