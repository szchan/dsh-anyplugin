#!/usr/bin/env node
/**
 * Fetch the DSH harness under test into `.harness/<version>/`.
 *
 * D9 originally forbade npm because the published packages were believed to be
 * a different product from the Desktop bundle. They are not: the released
 * `@deepseek-ai/dsh-skill@0.2.2-rc.2` is byte-identical to the copy in the app.
 * The oracle therefore boots an explicit *pin*, and this script is how CI gets
 * one — no network at test run time, fetching is this explicit step.
 *
 * The install is the **union** of every package the oracle and the spikes the
 * workflow runs boot, all at the requested pin, in one `npm install`. Before
 * that union lived here, `verify.yml` added the turn-graph and S9/S10/S11
 * packages in four later `npm install --no-save` steps. Each of those pruned
 * the previous step's extras, and a freshly fetched tree failed `npm run
 * verify` with `ERR_MODULE_NOT_FOUND …/dsh-agent-loop/lib/index.js`. One fetch
 * now produces the tree the suite and every CI spike run against; a second
 * install is a bug, not a setup step.
 *
 * Every entry names its consumer: the oracle boot, the lifecycle turn graph, a
 * CI spike's boot list, or a package an old spike install block carried for a
 * probe the spike has not written yet (called out as such). `harness-union.
 * test.mjs` fails when a conformance test or a CI spike imports a package this
 * list does not install, so drift is caught instead of hand-installed.
 *
 * Supporting packages are not part of the harness under test; they are pinned
 * because their versions are part of the tree the oracle boots:
 *   - cordis and cordis-plugin-loader / cordis-plugin-group: the oracle creates
 *     the `Context`, and the loader resolves the emitted group entry by name;
 *   - @modelcontextprotocol/client: materialize-mcp imports it from sdkRoot.
 *
 * The version must be explicit: `@deepseek-ai/dsh` (the application) is
 * deliberately absent — it would drag in the whole product, and `harness.ts`
 * reads the version from `dsh-skill` when there is no `dsh` package.
 *
 * Usage: node scripts/fetch-harness.mjs <version>
 * Prints the absolute install root on stdout, one line, and nothing else.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE_DIR = join(REPO_ROOT, '.npm-cache')

/**
 * The union, keyed by bare package name. Each value is the consumer that needs
 * it; the drift test (packages/dsh-anyplugin-conformance/test/harness-union.
 * test.mjs) checks that every `@deepseek-ai/dsh-*` a conformance test or a CI
 * spike loads is listed here.
 */
export const HARNESS_PACKAGES = {
  // The oracle boot: every DSH probe imports these (oracles/dsh.ts boot()).
  'dsh-skill': 'oracle: skill registry, and the version the tree claims (harness.ts)',
  // The host profile loader: profile-mount.test.mjs boots a scratch profile
  // through `loadProfile`/`readProfilePatches`/`boot` (ticket #112).
  'dsh-app-boot': 'profile mount: the host profile loader and boot (S17)',
  'dsh-system-prompt': 'oracle: system-prompt service for the tool probes and the real turn',
  'dsh-tools': 'oracle: tool registry',
  'dsh-tool-executor-native': 'oracle: tool dispatch, so hook probes observe a real call (S8 seam)',

  // The lifecycle turn graph: probeLifecycleWithDsh, driven by hooks.test.mjs.
  'dsh-agent': 'oracle lifecycle turn graph; S9 and S11 boot it',
  'dsh-agent-loop': 'oracle lifecycle turn graph: one real headless turn; S9/S10/S11',
  'dsh-llm': 'oracle lifecycle turn graph: stub LlmAdapter; S9/S10/S11',
  'dsh-session': 'oracle lifecycle turn graph: session store; S9/S10/S11',
  'dsh-session-projection': 'oracle lifecycle turn graph: projections; S9/S11',
  'dsh-fs-local': 'oracle lifecycle turn graph: filesystem; S9/S10/S11',
  'dsh-working-directory': 'oracle lifecycle turn graph: cwd service; S9/S10/S11',
  'dsh-subagent': 'oracle lifecycle turn graph: subagent runtime; S9/S10/S11',
  'dsh-subagent-fork-in-process': 'oracle lifecycle turn graph: fork provider; S9/S11',
  'dsh-subagent-spawn-in-process': 'S10: spawn provider for the child-agent checks',
  'dsh-session-persistence-jsonl': 'S10: JSONL session persistence for the child session',

  // The S9 host-event composition table.
  'dsh-tool-subagent': 'S9 and S10: subagent tool',
  'dsh-compaction-basic': 'S9 and S11: compaction engine (Pre/PostCompact records)',
  'dsh-tool-fs': 'S9: filesystem tools (FileChanged observations)',
  'dsh-user-approval': 'S9: approval/request probe (also a peer of dsh-tool-fs)',
  'dsh-settings': 'S9: settings/document-updated probe',
  'dsh-token-meter': 'S9 and S11: token meter used by compaction',
  // The six below have no literal importer in the S9 source. The conformance
  // seams probe now mounts the team and worktree services for the routed S23
  // rows; the rest stay because S9's install block carried them for its
  // unprobed rows (InstructionsLoaded, Elicitation, the fs search tools), and
  // dropping them would silently narrow the pin the probe runs against.
  'dsh-agent-team': 'S9/S23: team service for the routed TaskCreated/Completed rows',
  'dsh-fs-observation-policy': 'S9: fs observation policy behind the FileChanged row',
  'dsh-user-questions': 'S9: question service for the unprobed Elicitation rows',
  'dsh-experimental-worktree': 'S9/S23: worktree service for the routed WorktreeCreate/Remove rows',
  'dsh-agent-instructions': 'S9: instructions service for the InstructionsLoaded row',
  'dsh-tool-fs-search': 'S9: fs search tools for the unprobed tool-event rows',

  // The S11 prompt-scope composition table.
  'dsh-commands': 'S11: command service (/s11-style execution)',
  'dsh-persona': 'S11: persona section',
  'dsh-agent-preset-registry': 'S11: agent-preset registry',
  'dsh-agent-preset': 'S11: the old install block carried it; the spike registers its preset in memory, so no literal importer yet',

  // The S19 PATH probe: the managed-env registry, the bash tool that consumes
  // it, and the local executor/subprocess stack that builds the child env.
  'dsh-shell-env': 'S19: ShellEnvRegistry.register/collect — the managed shell environment (issue #131)',
  'dsh-shell': 'S19: ShellExecRequest.env/dshEnv and the DSH_ prefix constants the registry validates',
  'dsh-tool-bash': 'S19: the model-facing bash tool that calls shellEnv.collect per call',
  'dsh-tool-pwsh': 'S19: source check of the second shell tool; not booted on Linux',
  'dsh-bash-local': 'S19: local shell executor — the child env assembly point',
  'dsh-subprocess': 'S19: scrubbedParentEnv — the base the child env starts from; PATH survives it',
  'dsh-subprocess-local': 'S19: subprocess runtime; its spawn spec carries the env into the child',

  // The S21 client-panel probe: the dual-face module registry that scans active
  // Loader entries for `dsh.client`, composes `__DSH_BOOT__`, and serves
  // /plugins/<package>/client.js (ticket #147).
  'dsh-client-modules': 'S21: composes and serves a third-party dsh.client bundle (issue #147)',
}

/** Versions that are not the harness under test. Pinned, never `latest`. */
const SUPPORTING = {
  '@deepseek-ai/cordis': '4.1.0',
  '@deepseek-ai/cordis-plugin-group': '1.1.0',
  '@deepseek-ai/cordis-plugin-loader': '1.1.0',
  '@modelcontextprotocol/client': '2.2.0',
}

const USAGE = `usage: node scripts/fetch-harness.mjs <version>

Installs the DSH packages for <version> into .harness/<version>/ and prints that
directory. Idempotent: an existing install with the exact versions is reused.

The install is the union the oracle and the CI spikes need, so one fetch is
enough for \`npm run verify\` and every spike in .github/workflows/verify.yml.

The version must be explicit -- @deepseek-ai's "latest" dist-tag is 0.0.1-rc.1,
which is not a harness. Released versions look like 0.2.2-rc.5.
`

function die(message) {
  process.stderr.write(`fetch-harness: ${message}\n`)
  process.exit(1)
}

/** Read the version npm actually installed for `name`, or undefined. */
function installedVersion(root, name) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function dependenciesFor(version) {
  const dependencies = {}
  for (const name of Object.keys(HARNESS_PACKAGES)) {
    dependencies[`@deepseek-ai/${name}`] = version
  }
  return { ...dependencies, ...SUPPORTING }
}

function isComplete(root, dependencies) {
  return Object.entries(dependencies).every(([name, wanted]) => installedVersion(root, name) === wanted)
}

/** A manifest makes the install root a scope for the loader's resolver, and npm deterministic. */
function writeManifest(root, version, dependencies) {
  const manifest = {
    name: 'dsh-harness-under-test',
    version: '0.0.0',
    private: true,
    description: `Pinned DSH harness ${version}, fetched by scripts/fetch-harness.mjs. Not a package.`,
    dependencies,
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1) die(USAGE.trim())
  const version = args[0]
  if (version === '--help' || version === '-h') {
    process.stdout.write(USAGE)
    return
  }
  if (version === 'latest' || version === 'next' || version === '*') {
    die(`refusing the "${version}" dist-tag: install an explicit version (e.g. 0.2.2-rc.5)`)
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) || version.includes('..')) {
    die(`not an explicit semver version: ${JSON.stringify(version)}`)
  }

  const root = resolve(join(REPO_ROOT, '.harness', version))
  const dependencies = dependenciesFor(version)

  if (existsSync(join(root, 'package.json')) && existsSync(join(root, 'node_modules')) && isComplete(root, dependencies)) {
    process.stderr.write(`fetch-harness: ${version} already installed\n`)
    process.stdout.write(`${root}\n`)
    return
  }

  mkdirSync(root, { recursive: true })
  writeManifest(root, version, dependencies)

  // One install for the whole union. --no-save keeps the manifest exactly as
  // written (the lockfile is not part of the pin); --ignore-scripts keeps the
  // fetch to unpacking, as the CI steps it replaces did. The union is passed
  // explicitly rather than read back from the manifest so a stale manifest in
  // an old tree cannot keep a pruned package alive.
  const npmCli = process.env.npm_execpath
  const result = spawnSync(
    npmCli === undefined ? 'npm' : process.execPath,
    [
      ...(npmCli === undefined ? [] : [npmCli]),
      'install',
      '--prefix',
      root,
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      CACHE_DIR,
      '--loglevel',
      'error',
      ...Object.entries(dependencies).map(([name, wanted]) => `${name}@${wanted}`),
    ],
    {
      cwd: root,
      env: { ...process.env, npm_config_cache: CACHE_DIR, npm_config_update_notifier: 'false' },
      encoding: 'utf8',
    },
  )
  if (result.error !== undefined) die(result.error.message)
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '')
    die(`npm install exited ${result.status}`)
  }
  if (!isComplete(root, dependencies)) {
    const missing = Object.entries(dependencies)
      .filter(([name, wanted]) => installedVersion(root, name) !== wanted)
      .map(([name, wanted]) => `${name}@${wanted} (found ${installedVersion(root, name) ?? 'nothing'})`)
    die(`install finished but the tree is incomplete: ${missing.join(', ')}`)
  }

  process.stderr.write(`fetch-harness: installed ${version} (${Object.keys(dependencies).length} direct packages)\n`)
  // The only stdout line: CI captures this as the harness directory.
  process.stdout.write(`${root}\n`)
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
