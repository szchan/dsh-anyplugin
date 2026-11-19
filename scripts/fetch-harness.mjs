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
 * Only the packages the oracle and the materializers actually import are
 * installed. `@deepseek-ai/dsh` (the application) is deliberately absent: it
 * would drag in the whole product, and `harness.ts` reads the version from
 * `dsh-skill` when there is no `dsh` package. The two non-harness packages are
 * pinned because their versions are part of the tree the oracle boots:
 *   - cordis-plugin-loader / cordis-plugin-group: the loader resolves the
 *     emitted group entry by name;
 *   - @modelcontextprotocol/client: materialize-mcp imports it from sdkRoot.
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
  return {
    '@deepseek-ai/dsh-skill': version,
    '@deepseek-ai/dsh-system-prompt': version,
    '@deepseek-ai/dsh-tool-executor-native': version,
    '@deepseek-ai/dsh-tools': version,
    ...SUPPORTING,
  }
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

  // `npm install` with no arguments installs the manifest above. --no-save keeps
  // the manifest exactly as written; the lockfile is not part of the pin.
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
      '--no-audit',
      '--no-fund',
      '--cache',
      CACHE_DIR,
      '--loglevel',
      'error',
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

main()
