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
 *      reconcile `installs.yml`, and assert that a fixture with a skill, an
 *      MCP server, a PostToolUse hook, an agent and an output style produces
 *      **five active materializer children**, that the tools service lists the
 *      agent tool and the namespaced MCP tool, and that the skill is in
 *      `ctx.skills.list()`;
 *   5. import every published subpath through a resolver anchored in the
 *      profile's package scope, so a broken `exports` map fails here;
 *   6. load real mods from `ANYPLUGIN_MODS_TREE` through the *packaged* hook
 *      entry and run one real turn: the kernel seats them, serves `$` through
 *      the bridge, keeps a classic hook in the same turn, and a mod's deny
 *      reaches `tools/pre-execute`.
 *
 * The lock's `grants.yml` is authored with the repository's own trust code
 * (the same call an installer UI makes). That is fixture setup only: the
 * packaged controller must still re-hash the hook and match the recorded
 * artifact hash, or the hook child would be absent.
 *
 * A missing harness is a failure, not a skip: skipping the install smoke is
 * exactly the silent-success mode it exists to prevent.
 *
 * Usage: node scripts/smoke-install.mjs <tarball> [--keep]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// D30 loads mods in a `node:vm` realm, which Node exposes only behind this
// flag. Re-exec once so a direct `node scripts/smoke-install.mjs <tarball>`
// runs the same proof as `npm run check:pack`.
if (!process.execArgv.includes('--experimental-vm-modules')) {
  const child = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', ...process.argv.slice(1)],
    { stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const keep = process.argv.includes('--keep')
const verbose = process.argv.includes('--verbose')
const step = (message) => {
  if (verbose) process.stderr.write(`install smoke: … ${message}\n`)
}
const tarball = process.argv[2]
// The pin is part of the claim, so read it from its one source rather than
// repeating it here: compile rejects a record whose pin is stale by design.
const pinFile = join(root, 'packages', 'dsh-anyplugin-conformance', 'src', 'pin.ts')
const pinMatch = /version:\s*'([^']+)'/.exec(readFileSync(pinFile, 'utf8'))
if (pinMatch === null) fail(`cannot read the Claude Code pin from ${pinFile}`)
const CLAUDE_PIN = `claude-code@${pinMatch[1]}`
const PUBLISHED_SUBPATHS = [
  'materialize/skill',
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

/** A hook descriptor whose artifact hash the materializer re-checks (D25). */
/** The lock/emitter pin for a mod tree: entry plus every authored file under it. */
function pinnedModRow(treeArtifact, pluginRoot, entry) {
  const tree = treeArtifact(pluginRoot, entry)
  if (!tree.ok) throw new Error(`cannot pin ${entry}: ${tree.refusal.path}: ${tree.refusal.reason}`)
  return {
    entry,
    artifactHash: tree.artifact.artifactHash,
    artifactMode: tree.artifact.mode,
    artifact: tree.artifact.manifest,
  }
}

function pinnedCommandHook(hashManifest, event, command) {
  const artifact = { mode: 'command', invocation: command, command, files: [] }
  return { event, index: 0, command, artifactHash: hashManifest(artifact), artifactMode: 'command', artifact }
}

/** The probe's Bash tool: every executed call is evidence the deny did not win late. */
function bashTool(calls) {
  return {
    name: 'Bash',
    description: 'Run a shell command and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args) => {
      calls.push(args)
      return 'ran'
    },
  }
}

function readTraceFile(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

/**
 * The packaging proof for the mods kernel (issue #99, acceptance 3): the mods
 * are loaded through the *tarball's* hook entry, not the source tree, and one
 * real turn runs on the pinned harness. `sec-default` is upstream and pinned;
 * the `kernel-probe` mod is written here because the `$` proof must be
 * deterministic (each load gets a fresh store); the `guard` fixture is the
 * deny half the repository already tests.
 */
async function modsProof({ harnessDir, hookEntry, scratch }) {
  const modsTree = process.env.ANYPLUGIN_MODS_TREE?.trim()
  if (!modsTree) {
    fail(
      'ANYPLUGIN_MODS_TREE is not set; fetch the pinned mods with `node scripts/fetch-mod.mjs` ' +
        '(the install smoke never reaches the network)',
    )
  }
  const tree = resolve(modsTree)
  const secRoot = join(tree, 'mods', 'sec-default')
  const secEntry = join(secRoot, 'hooks', 'register.ts')
  if (!existsSync(secEntry)) {
    fail(`ANYPLUGIN_MODS_TREE=${modsTree} has no mods/sec-default/hooks/register.ts; run \`node scripts/fetch-mod.mjs\``)
  }

  const trust = await import(pathToFileURL(join(root, 'packages', 'dsh-anyplugin-trust', 'src', 'index.ts')).href)
  const { probeLifecycleWithDsh } = await import(
    pathToFileURL(join(root, 'packages', 'dsh-anyplugin-conformance', 'src', 'oracles', 'dsh.ts')).href
  )

  // Two proofs in one load. `$`: `clock.now` and `store.get` round-trip, then
  // report through telemetry — the materializer's telemetry sink writes the line
  // to its trace file, so the assertion is on the bridge, not on the fixture's
  // own state. D34: the mod imports a classic-pragma `.tsx` module, so the
  // packaged Babel pass is exercised, not merely declared.
  const probeRoot = join(scratch, 'mods-smoke', 'kernel-probe')
  mkdirSync(probeRoot, { recursive: true })
  writeFileSync(
    join(probeRoot, 'view.tsx'),
    ['/** @jsx h */', 'export function view(label: string) {', '  return <box label={label}><text>{label}</text></box>', '}', ''].join('\n'),
  )
  writeFileSync(
    join(probeRoot, 'register.mjs'),
    [
      '// Written by scripts/smoke-install.mjs — the packaged kernel\'s $ and .tsx proof.',
      'import { view } from "./view"',
      'export function register(on) {',
      "  on('session.start', async ($, event, next) => {",
      '    const now = await $.clock.now()',
      '    if (typeof now !== "number" || !Number.isFinite(now)) throw new Error("clock.now did not return a number")',
      '    await $.store.set("smoke/clock", now)',
      '    const stored = await $.store.get("smoke/clock")',
      '    if (stored !== now) throw new Error("store round-trip failed: " + JSON.stringify(stored))',
      '    const rendered = view("smoke")',
      '    if (rendered?.type !== "box" || !Array.isArray(rendered.children) || rendered.children[0]?.type !== "text") {',
      '      throw new Error("classic .tsx transform did not produce h() elements: " + JSON.stringify(rendered))',
      '    }',
      '    await $.telemetry.log({ smoke: "clock.now+store.get+tsx", at: now })',
      '    return next(event)',
      '  })',
      '}',
      '',
    ].join('\n'),
  )

  const classicCommand = 'printf \'%s\\n\' classic-fired >> "$CLAUDE_PLUGIN_DATA/events.log"'
  const bashCall = { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) }
  const groupEntry = (id, config) => ({
    id,
    name: '@deepseek-ai/cordis-plugin-group',
    group: true,
    config: [
      // The materializer reads the command registry from the service when it
      // exists; the pinned harness has it, so give it the same anchor tests use.
      { id: 'commands', name: pathToFileURL(join(harnessDir, 'dsh-commands', 'lib', 'index.js')).href },
      { id: 'hook', name: hookEntry, config },
    ],
  })

  // One probe per mod: a seat owns the agent's pre-execute waterfall, so a
  // denying mod in the same agent would short-circuit the other rows' chains.
  // Splitting the runs keeps each assertion causally its own.
  const run = async (label, config, expected) => {
    const dataDir = join(scratch, 'mods-data', label)
    mkdirSync(dataDir, { recursive: true })
    const traceFile = join(dataDir, 'trace.jsonl')
    const calls = []
    const observation = await probeLifecycleWithDsh({
      harnessDir,
      entry: groupEntry(`anyplugin.mods-smoke.${label}`, { ...config, pluginData: dataDir, traceFile }),
      expected,
      tool: bashTool(calls),
      toolCall: bashCall,
      timeoutMs: 20_000,
    })
    return { dataDir, traceFile, calls, events: observation.events }
  }

  const sec = await run(
    'sec-default',
    {
      pluginRoot: secRoot,
      plugin: 'sec-default',
      mods: [pinnedModRow(trust.treeArtifact, secRoot, 'hooks/register.ts')],
      hooks: [pinnedCommandHook(trust.hashManifest, 'PreToolUse', classicCommand)],
    },
    // The classic hook's line is the completion marker: the probe waits for it,
    // so the "classic arm still fires" assertion is never a race.
    ['classic-fired'],
  )
  const probe = await run(
    'kernel-probe',
    { pluginRoot: probeRoot, plugin: 'kernel-probe', mods: [pinnedModRow(trust.treeArtifact, probeRoot, 'register.mjs')] },
    [],
  )
  const guard = await run(
    'guard',
    { pluginRoot: join(root, 'fixtures', 'mods', 'guard'), plugin: 'guard', mods: [pinnedModRow(trust.treeArtifact, join(root, 'fixtures', 'mods', 'guard'), 'register.ts')] },
    [],
  )

  const warningsOf = (traceFile) =>
    readTraceFile(traceFile)
      .filter((record) => typeof record.warning === 'string')
      .map((record) => record.warning)
  const countOf = (warnings, label) => {
    const warning = warnings.find((line) => line.startsWith(`anyplugin mod ${label}: loaded `))
    if (warning === undefined) return undefined
    const match = /loaded (\d+) registration/.exec(warning)
    return match === null ? undefined : Number(match[1])
  }

  const secWarnings = warningsOf(sec.traceFile)
  const secCount = countOf(secWarnings, 'sec-default/hooks/register.ts')
  if (secCount !== 45) {
    fail(
      `the upstream mod reported ${JSON.stringify(secCount)} registrations, expected 45 at the pinned tree; ` +
        `warnings: ${JSON.stringify(secWarnings)}`,
    )
  }
  const probeWarnings = warningsOf(probe.traceFile)
  const probeCount = countOf(probeWarnings, 'kernel-probe/register.mjs')
  if (probeCount !== 1) fail(`the kernel-probe mod reported ${JSON.stringify(probeCount)} registrations`)
  const guardWarnings = warningsOf(guard.traceFile)
  const guardCount = countOf(guardWarnings, 'guard/register.ts')
  if (guardCount !== 1) fail(`the guard mod reported ${JSON.stringify(guardCount)} registrations`)

  const served = probeWarnings.find(
    (line) => line.includes('kernel-probe/register.mjs: telemetry.log') && line.includes('clock.now+store.get+tsx'),
  )
  if (served === undefined) {
    fail(`$.clock.now/$.store.get did not reach the bridge; warnings: ${JSON.stringify(probeWarnings)}`)
  }

  const pre = (traceFile) => readTraceFile(traceFile).filter((record) => record.event === 'PreToolUse')
  const classicStar = pre(sec.traceFile)
    .flatMap((record) => (Array.isArray(record.trace) ? record.trace : []))
    .find((stepFound) => typeof stepFound.source === 'string' && stepFound.source.includes('sec-default/hooks/register.ts'))
  if (classicStar?.status !== 'ran') {
    fail(`the upstream mod's classic.* handler did not run: ${JSON.stringify(classicStar)}`)
  }
  if (!sec.events.includes('classic-fired')) {
    fail(`the classic hook did not fire alongside the mods; events: ${JSON.stringify(sec.events)}`)
  }
  if (sec.calls.length !== 1) fail(`the allowed tool call ran ${sec.calls.length} time(s), expected 1`)

  const denied = pre(guard.traceFile).find((record) => record.decision?.kind === 'deny')
  if (denied === undefined || denied.decision.reason !== 'the guard mod does not allow Bash') {
    fail(`no mod-initiated deny reached tools/pre-execute: ${JSON.stringify(pre(guard.traceFile).map((record) => record.decision))}`)
  }
  if (guard.calls.length !== 0) fail(`the denied tool call still executed: ${JSON.stringify(guard.calls)}`)

  return `sec-default/hooks/register.ts ${secCount} registrations, kernel-probe/register.mjs ${probeCount}, guard/register.ts ${guardCount}`
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
    // The kernel's only runtime dependencies are the classic-JSX pair (D34). A
    // real profile installs the tarball's `dependencies` from the registry (the
    // reviewer measured 60 packages / 35 MB for this tarball, about 99 KiB); the smoke
    // links the checkout's copies so the proof stays offline. Its claim is
    // therefore narrow: the packaged hook entry imports the declared packages,
    // and their declared versions are what resolve — not that npm's install
    // graph was exercised.
    mkdirSync(join(profile, 'node_modules', '@babel'), { recursive: true })
    for (const dependency of ['core', 'plugin-transform-react-jsx']) {
      const source = join(root, 'node_modules', '@babel', dependency)
      if (!existsSync(source)) fail(`the checkout has no node_modules/@babel/${dependency}; run \`npm install\` first`)
      symlinkSync(source, join(profile, 'node_modules', '@babel', dependency), 'dir')
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

    // An MCP server the materializer must actually connect to (the probe is
    // dependency-free and speaks JSON-RPC on stdio).
    writeFileSync(join(fixture, 'probe-server.mjs'), readFileSync(join(root, 'fixtures', 'claude-hooks-mcp', 'probe-server.mjs')))
    writeFileSync(
      join(fixture, '.mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            probe: { type: 'stdio', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/probe-server.mjs'] },
          },
        },
        null,
        2,
      )}\n`,
    )

    // One exec-class hook: emitted only when its recorded artifact hash matches
    // the bytes the controller re-reads (D25).
    mkdirSync(join(fixture, 'hooks'), { recursive: true })
    writeFileSync(
      join(fixture, 'hooks', 'hooks.json'),
      `${JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                matcher: 'Write|Edit',
                hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh"' }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    )
    mkdirSync(join(fixture, 'scripts'), { recursive: true })
    writeFileSync(
      join(fixture, 'scripts', 'format.sh'),
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"anyplugin-hook: PostToolUse fired"}}\'\n',
    )

    // One agent persona: the materializer turns it into <plugin>:<agent>.
    mkdirSync(join(fixture, 'agents'), { recursive: true })
    writeFileSync(
      join(fixture, 'agents', 'persona.md'),
      '---\nname: persona\ndescription: Reviews a diff.\n---\nYou review diffs.\n',
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

    // Exec artifacts are default-off. Author the grant the way the installer
    // does (classify -> grant -> canonical grants.yml), then let the packaged
    // controller prove it: the hook child exists only if the hash still matches.
    {
      const { readClaudePlugin } = await import(
        pathToFileURL(join(root, 'packages', 'dsh-anyplugin-dialect-claude-code', 'src', 'index.ts')).href
      )
      const trust = await import(pathToFileURL(join(root, 'packages', 'dsh-anyplugin-trust', 'src', 'index.ts')).href)
      const ir = readClaudePlugin(fixture)
      const rows = trust.classify(ir)
      if (rows.length === 0) fail('the fixture hook was not classified, so there is nothing to grant')
      let store = trust.emptyGrants()
      for (const row of rows) {
        store = trust.grant(
          store,
          {
            plugin: trust.pluginIdentity(ir),
            capability: row.capability,
            target: row.target,
            artifactHash: row.artifactHash,
          },
          { scope: 'user', grantedAt: '2026-01-01T00:00:00.000Z' },
        )
      }
      trust.writeGrants(trust.grantsPath(join(anypluginDir, 'installs.yml')), store)
    }

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
    const SystemPrompt = (await load('dsh-system-prompt/lib/index.js')).default
    const ToolRuntime = (await load('dsh-tools/lib/index.js')).default
    const ctx = new Context()
    const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(`${profile}/`).href })
    ctx.plugin(SkillRegistry, {})
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(ToolRuntime, {})
    await until(
      () => Boolean(ctx.loader) && Boolean(ctx.skills) && Boolean(ctx.systemPrompt) && Boolean(ctx.tools),
      'the loader, skills, prompt and tools services',
    )

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
      // One fixture row must exercise every published materializer: a bundling
      // regression in an apply() would otherwise pass with only an import check.
      const expected = [
        'dsh-anyplugin/materialize/skill',
        'dsh-anyplugin/materialize/mcp',
        'dsh-anyplugin/materialize/hook',
        'dsh-anyplugin/materialize/agents',
        'dsh-anyplugin/materialize/output-style',
      ]
      const childNames = children.map((child) => String(child.name))
      for (const name of childNames) {
        if (!name.startsWith('dsh-anyplugin/')) {
          fail(`a child was not created from a published subpath: ${JSON.stringify(name)}`)
        }
      }
      for (const name of expected) {
        if (!childNames.includes(name)) fail(`the reconciled group is missing ${name}: ${JSON.stringify(childNames)}`)
      }
      if (children.length !== expected.length) {
        fail(`expected ${expected.length} materializer children, found ${children.length}: ${JSON.stringify(childNames)}`)
      }
      for (const child of children) {
        if (ctx.loader.resolve(child.id).fiber?.state !== 2) fail(`child ${child.id} is not active`)
      }
      const hookChild = children.find((child) => child.name === 'dsh-anyplugin/materialize/hook')
      const hookHash = hookChild.config?.hooks?.[0]?.artifactHash
      if (typeof hookHash !== 'string' || !hookHash.startsWith('sha256:')) {
        fail('the hook child does not carry the granted artifact hash')
      }

      // The services the two tool-shaped surfaces register into: the MCP tool
      // keeps Claude's name as the suffix behind DSH's namespace, and the agent
      // becomes <plugin>:<agent>.
      const agentToolName = 'skill-smoke:persona'
      const mcpToolName = 'mcp__plugin_skill-smoke_probe__create_issue'
      // The MCP child connects in the background after its apply returns, so
      // the tool appears once the server answers tools/list — not at settle.
      await until(() => ctx.tools.get(agentToolName) !== undefined, `the agent tool ${agentToolName}`)
      await until(() => ctx.tools.get(mcpToolName) !== undefined, `the MCP tool ${mcpToolName}`)

      step('importing every published subpath from the profile scope')
      // Resolve from a module that lives in the profile scope: a bare
      // `dsh-anyplugin/...` can then only come from the extracted tarball under
      // `<profile>/node_modules`, never from the repo checkout. Do not borrow
      // the loader's `.cordis/resolve.mjs`: when the loader takes its
      // internal-loader path (Node with `--expose-internals`, or a Node whose
      // builtin loader it can reach) it writes no helper, and that is a loader
      // implementation detail rather than a package invariant.
      const probe = join(profile, '.anyplugin-smoke-resolve.mjs')
      writeFileSync(probe, 'export default (specifier) => import.meta.resolve(specifier)\n')
      const resolveFromProfile = (await import(pathToFileURL(probe).href)).default
      const installedLib = pathToFileURL(join(packageDir, 'lib')).href
      for (const subpath of PUBLISHED_SUBPATHS) {
        const url = resolveFromProfile(`dsh-anyplugin/${subpath}`)
        if (!url.startsWith(installedLib)) {
          fail(`dsh-anyplugin/${subpath} resolved outside the installed tarball: ${url}`)
        }
        await import(url)
      }

      step('loading real mods from the tarball through the published hook entry')
      // Everything above proved the published surface; this proves the kernel
      // inside `lib/materialize/hook.js` runs an upstream mod in a real turn.
      const modsSummary = await modsProof({
        harnessDir: modules,
        hookEntry: resolveFromProfile('dsh-anyplugin/materialize/hook'),
        scratch,
      })

      process.stdout.write(
        `install smoke: ok — ${manifest.name}@${manifest.version}; skill "hello", MCP "probe", hook ` +
          `"PostToolUse", agent "persona" and output style "concise" across ${expected.length} active materializer ` +
          `children; tools "${agentToolName}" + "${mcpToolName}"; ${PUBLISHED_SUBPATHS.length} subpaths resolved from ${harness}; ` +
          `mods: ${modsSummary}\n`,
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
