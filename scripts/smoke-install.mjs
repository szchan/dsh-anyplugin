/**
 * Install smoke — the ticket-#79 acceptance test, as a script rather than a
 * unit test because it installs a tarball and boots a profile.
 *
 * It proves the *packaged* artifact, not the source tree:
 *
 *   1. extract the tarball into a scratch profile's `node_modules` exactly as
 *      a package manager would;
 *   2. create the profile's package scope and the services a profile provides
 *      (the real cordis Loader, the real `dsh-skill` registry);
 *   3. read `dsh.bundle.patch` from the extracted manifest, parse the patch
 *      with the harness' own YAML reader, and compose it with `dsh-app-boot`'s
 *      `composeEntries` — the same call boot makes;
 *   4. create the composed row through the real loader, let the controller
 *      reconcile `installs.yml`, and assert the fixture's skill is listed by
 *      `ctx.skills.list()`;
 *   5. import every published subpath through the loader's own resolver
 *      helper, so a broken `exports` map fails here.
 *
 * A missing harness is a failure, not a skip: skipping the install smoke is
 * exactly the silent-success mode it exists to prevent.
 *
 * Usage: node scripts/smoke-install.mjs <tarball> [--keep]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const keep = process.argv.includes('--keep')
const verbose = process.argv.includes('--verbose')
const step = (message) => {
  if (verbose) process.stderr.write(`install smoke: … ${message}\n`)
}
const tarball = process.argv[2]
const CLAUDE_PIN = 'claude-code@2.1.329' // CLAUDE_CODE_PIN; compile rejects a stale pin by design.
const PUBLISHED_SUBPATHS = [
  'materialize/skill',
  'materialize/command',
  'materialize/mcp',
  'materialize/hook',
  'materialize/agents',
  'materialize/output-style',
]
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const fail = (message) => {
  throw new Error(`install smoke: ${message}`)
}

if (!tarball) fail('usage: node scripts/smoke-install.mjs <tarball> [--keep]')
if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`)

/** Resolve the pinned harness (D22): explicit env first, then the checkout's fetch. */
function harnessRoot() {
  for (const name of ['DSH_HARNESS_DIR', 'DSH_INSTALL_DIR']) {
    const raw = process.env[name]?.trim()
    if (!raw) continue
    let current = resolve(raw)
    for (let depth = 0; depth < 6; depth += 1) {
      if (existsSync(join(current, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'))) return current
      current = dirname(current)
    }
    fail(`${name}=${raw} does not contain node_modules/@deepseek-ai/cordis`)
  }
  const fetched = join(root, '.harness')
  if (existsSync(fetched)) {
    const candidates = readdirSync(fetched).sort().reverse()
    for (const name of candidates) {
      const candidate = join(fetched, name)
      if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'))) return candidate
    }
  }
  fail(
    'no harness resolved; run `node scripts/fetch-harness.mjs 0.2.2-rc.5` and set DSH_HARNESS_DIR ' +
      '(the install smoke never skips: an unproven install is a failed install)',
  )
}

const harness = harnessRoot()
const modules = join(harness, 'node_modules', '@deepseek-ai')

function until(predicate, label, timeout = 5000) {
  const started = Date.now()
  return new Promise((done, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return done()
      } catch (error) {
        return reject(error)
      }
      if (Date.now() - started > timeout) return reject(new Error(`install smoke: timed out waiting for ${label}`))
      setTimeout(tick, 5)
    }
    void tick()
  })
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-smoke-'))
  let ok = false
  try {
    process.env.DSH_HOME = join(scratch, 'home')
    // The controller reads project-scope layers from process.cwd(); keep the
    // smoke inside its scratch tree so a developer's checkout cannot alter it.
    process.chdir(scratch)

    step('extracting the tarball into a scratch profile')
    const profile = join(scratch, 'profile')
    const packageDir = join(profile, 'node_modules', 'dsh-anyplugin')
    mkdirSync(packageDir, { recursive: true })
    execFileSync('tar', ['-xzf', resolve(tarball), '--strip-components=1', '-C', packageDir], { stdio: 'pipe' })

    if (!existsSync(join(packageDir, 'lib', 'index.js'))) {
      fail('the tarball has no lib/index.js — build before packing (this is the mutation the smoke must catch)')
    }

    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (manifest.name !== 'dsh-anyplugin') fail(`tarball manifest is ${JSON.stringify(manifest.name)}, not dsh-anyplugin`)
    if (typeof manifest.dsh?.bundle?.patch !== 'string') fail('tarball manifest has no dsh.bundle.patch')

    step('anchoring the profile scope')
    // A profile package scope, so the loader's resolver helper has an anchor.
    writeFileSync(
      join(profile, 'package.json'),
      `${JSON.stringify({ name: 'dsh-profile-smoke', private: true, dsh: { profile: { bundles: ['dsh-anyplugin'] } } }, null, 2)}\n`,
    )
    // The harness packages a profile would get from its bundle dependencies.
    symlinkSync(join(harness, 'node_modules', '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), 'dir')
    const mcpScope = join(harness, 'node_modules', '@modelcontextprotocol')
    if (existsSync(mcpScope)) {
      symlinkSync(mcpScope, join(profile, 'node_modules', '@modelcontextprotocol'), 'dir')
    }

    step('writing the fixture plugin, the lock and the enabled layer')
    // Fixture plugin: one skill, the smallest surface the 0.1 compile path emits.
    const fixture = join(scratch, 'fixtures', 'skill-smoke')
    mkdirSync(join(fixture, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(fixture, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'skill-smoke', description: 'install-smoke fixture', version: '0.0.1' }, null, 2)}\n`,
    )
    mkdirSync(join(fixture, 'skills', 'hello'), { recursive: true })
    writeFileSync(
      join(fixture, 'skills', 'hello', 'SKILL.md'),
      '---\nname: hello\ndescription: Says hello from the installed tarball.\n---\n\nSay hello.\n',
    )

    // One carried output style, so the smoke proves the selection reaches a
    // published materializer child — not merely that the subpath imports.
    mkdirSync(join(fixture, 'output-styles'), { recursive: true })
    writeFileSync(
      join(fixture, 'output-styles', 'concise.md'),
      '---\nname: concise\ndescription: Answer in as few words as possible.\n---\n\nBe terse.\n',
    )

    // The lock and the enabled layer, in the canonical forms the installer writes.
    const anypluginDir = join(process.env.DSH_HOME, 'anyplugin')
    mkdirSync(anypluginDir, { recursive: true })
    writeFileSync(
      join(anypluginDir, 'installs.yml'),
      [
        '# dsh-anyplugin installs — generated; edit through the installer.',
        'schema: "dsh-anyplugin/installs@1"',
        'plugins:',
        '  - dialect: "claude-code"',
        '    name: "skill-smoke"',
        '    version: "0.0.1"',
        `    root: ${JSON.stringify(fixture)}`,
        `    dataDir: ${JSON.stringify(join(scratch, 'data', 'skill-smoke'))}`,
        `    pin: ${JSON.stringify(CLAUDE_PIN)}`,
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(anypluginDir, 'enabled.yml'),
      ['plugins:', '  claude-code:skill-smoke: { enabled: true }', ''].join('\n'),
    )

    // D42: the activation record is the profile's explicit choice of one style.
    writeFileSync(
      join(anypluginDir, 'output-styles.yml'),
      [
        'schema: "dsh-anyplugin/output-styles@1"',
        'outputStyles:',
        '  active: "skill-smoke:concise"',
        '',
      ].join('\n'),
    )

    step('booting the real loader and the skill registry')
    // The real loader, the real skill registry, anchored at the profile scope.
    const load = (relative) => import(pathToFileURL(join(modules, relative)).href)
    const { Context } = await load('cordis/lib/index.js')
    const Loader = (await load('cordis-plugin-loader/lib/index.js')).default
    const SkillRegistry = (await load('dsh-skill/lib/index.js')).default
    const ctx = new Context()
    const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(`${profile}/`).href })
    ctx.plugin(SkillRegistry, {})
    await until(() => Boolean(ctx.loader) && Boolean(ctx.skills), 'the loader and skills services')

    try {
      step('composing the published bundle patch')
      // Compose the published patch with boot's own composition helper, then
      // create exactly the rows it names. `!!js` expressions would need the
      // launcher context; this bundle ships a static patch, and a dynamic row
      // here is a regression the smoke should not silently accept.
      const patchPath = join(packageDir, manifest.dsh.bundle.patch)
      if (!existsSync(patchPath)) fail(`dsh.bundle.patch points at ${patchPath}, which the tarball does not contain`)
      const yamlModule = await import(pathToFileURL(join(harness, 'node_modules', 'js-yaml', 'index.js')).href)
      const yaml = yamlModule.default ?? yamlModule
      const patch = yaml.load(readFileSync(patchPath, 'utf8'))
      if (!Array.isArray(patch) || patch.length === 0) fail('the bundle patch is not a non-empty YAML list')
      const appBoot = await import(pathToFileURL(join(modules, 'dsh-app-boot', 'lib', 'index.js')).href)
      const rows = appBoot.composeEntries([patch])
      step(`creating ${rows.length} composed patch row(s)`)
      for (const row of rows) {
        if (row.id === undefined || row.name === undefined) fail(`composed patch row is not a loader entry: ${JSON.stringify(row)}`)
        await ctx.loader.create(row)
      }
      step('waiting for the loader to settle')
      await ctx.loader.await()
      step('asserting the fixture skill')

      const skills = await ctx.skills.list()
      const names = skills.map((skill) => skill.name)
      if (!names.includes('hello')) {
        fail(`the fixture skill is not registered; ctx.skills.list() = ${JSON.stringify(names)}`)
      }

      const groups = [...ctx.loader.entries()].filter(
        (entry) =>
          entry.parent === ctx.loader.root &&
          typeof entry.options?.id === 'string' &&
          entry.options.id.startsWith('anyplugin.'),
      )
      if (groups.length !== 1) fail(`expected exactly one reconciled group, found ${groups.length}`)
      const group = groups[0]
      if (group.options.group !== true) fail(`the reconciled entry ${group.options.id} is not a group`)
      if (group.fiber?.state !== 2) fail(`the reconciled group ${group.options.id} is not active (state ${group.fiber?.state})`)
      const children = group.options.config
      if (!Array.isArray(children) || children.length === 0) fail(`the reconciled group ${group.options.id} has no children`)
      for (const child of children) {
        if (!String(child.name).startsWith('dsh-anyplugin/')) {
          fail(`child ${child.id} was not created from a published subpath: ${JSON.stringify(child.name)}`)
        }
        if (ctx.loader.resolve(child.id).fiber?.state !== 2) fail(`child ${child.id} is not active`)
      }
      const styleChild = children.find((child) => child.name === 'dsh-anyplugin/materialize/output-style')
      if (styleChild === undefined) {
        fail(
          'the activated output style did not become a published materializer child: ' +
            JSON.stringify(children.map((child) => child.name)),
        )
      }
      if (ctx.loader.resolve(styleChild.id).fiber?.state !== 2) fail(`output-style child ${styleChild.id} is not active`)

      step('importing every published subpath through the loader resolver')
      // The loader writes `.cordis/resolve.mjs` in the profile scope; using it
      // proves the published `exports` map, not a path under the repo.
      const helperUrl = pathToFileURL(join(profile, '.cordis', 'resolve.mjs')).href
      if (!existsSync(join(profile, '.cordis', 'resolve.mjs'))) fail('the loader did not create its resolver helper')
      const resolveFromProfile = (await import(helperUrl)).default
      for (const subpath of PUBLISHED_SUBPATHS) {
        const url = resolveFromProfile(`dsh-anyplugin/${subpath}`)
        await import(url)
      }

      process.stdout.write(
        `install smoke: ok — ${manifest.name}@${manifest.version}, skill "hello" and output style ` +
          `"concise" via ${group.options.id}, ${PUBLISHED_SUBPATHS.length} subpaths resolved from ${harness}\n`,
      )
      ok = true
    } finally {
      loaderFiber.dispose()
    }
  } finally {
    if (ok && !keep) rmSync(scratch, { recursive: true, force: true })
    else process.stdout.write(`install smoke: scratch tree kept at ${scratch}\n`)
  }
}

await main()
