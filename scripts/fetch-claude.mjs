#!/usr/bin/env node
/**
 * Fetch the pinned Claude Code CLI under test into `.claude-code/<version>/`.
 *
 * The upstream half of the conformance rig asks the real `claude` what a plugin
 * loads. CI has no Desktop installation to borrow that binary from, so the
 * oracle gets an explicit npm pin instead (D24): `@anthropic-ai/claude-code` at
 * the exact version in `src/pin.ts`. Fetching is this explicit step — the tests
 * themselves never touch the network.
 *
 * The install uses `--ignore-scripts`. The package's postinstall selects,
 * validates and copies a platform-native binary over the `bin/claude.exe` stub;
 * the real binary is already shipped in
 * `@anthropic-ai/claude-code-<platform>-<arch>`, so this script points at that
 * and runs no lifecycle script at all.
 *
 * Usage:
 *   node scripts/fetch-claude.mjs                  # install (idempotent), print the binary
 *   node scripts/fetch-claude.mjs --verify <path>  # assert <path> --version is the pin
 *
 * Prints the absolute binary path on stdout, one line, and nothing else.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { claudeVersion } from '../packages/dsh-anyplugin-conformance/src/oracles/claude.ts'
import { CLAUDE_CODE_PACKAGE, CLAUDE_CODE_PIN } from '../packages/dsh-anyplugin-conformance/src/pin.ts'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE_DIR = join(REPO_ROOT, '.npm-cache')
const VERSION = CLAUDE_CODE_PIN.version
const ROOT = resolve(join(REPO_ROOT, '.claude-code', VERSION))

const USAGE = `usage: node scripts/fetch-claude.mjs [--verify <path>]

Installs ${CLAUDE_CODE_PACKAGE}@${VERSION} into .claude-code/${VERSION}/ and prints
the absolute path of the native binary. Idempotent: an existing install at the
pin is reused after one --version check. The version comes from
packages/dsh-anyplugin-conformance/src/pin.ts; "latest" is never installed.

--verify <path> runs <path> --version and exits non-zero when it does not report
${CLAUDE_CODE_PIN.tool}@${VERSION}. It installs nothing.
`

function die(message) {
  process.stderr.write(`fetch-claude: ${message}\n`)
  process.exit(1)
}

function installedVersion(root, name) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function isExecutable(path) {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The runnable binary is in the optional platform package, not in
 * `@anthropic-ai/claude-code/bin/claude.exe` (that is a stub until postinstall
 * rewrites it, and this install deliberately runs no scripts). npm installs the
 * one platform package that matches this machine.
 */
function findPlatformBinary(root) {
  const scope = join(root, 'node_modules', '@anthropic-ai')
  let entries
  try {
    entries = readdirSync(scope).sort()
  } catch {
    return undefined
  }
  const candidates = []
  for (const name of entries) {
    if (!name.startsWith('claude-code-')) continue
    const version = installedVersion(root, `@anthropic-ai/${name}`)
    if (version !== VERSION) continue
    for (const file of ['claude', 'claude.exe']) {
      const candidate = join(scope, name, file)
      try {
        if (!statSync(candidate).isFile()) continue
        // npm preserves the mode from the tarball; normalize anyway so a cache
        // restore with a different umask cannot produce an unrunnable tree.
        if (process.platform !== 'win32' && !isExecutable(candidate)) chmodSync(candidate, 0o755)
      } catch {
        continue
      }
      if (isExecutable(candidate)) candidates.push(candidate)
    }
  }
  // If npm ever installs more than the matching platform package, prefer the
  // one named for this platform and architecture.
  const preferred = candidates.find((path) => path.includes(`claude-code-${process.platform}-${process.arch}`))
  return preferred ?? candidates[0]
}

function isComplete(root) {
  return installedVersion(root, CLAUDE_CODE_PACKAGE) === VERSION && findPlatformBinary(root) !== undefined
}

/** The manifest makes the install root a scope for npm and the pin inspectable. */
function writeManifest(root) {
  const manifest = {
    name: 'claude-code-under-test',
    version: '0.0.0',
    private: true,
    description: `Pinned Claude Code ${VERSION}, fetched by scripts/fetch-claude.mjs. Not a package.`,
    dependencies: { [CLAUDE_CODE_PACKAGE]: VERSION },
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function verify(bin) {
  const resolved = resolve(bin)
  if (!isExecutable(resolved)) {
    die(`${resolved} is not an executable file — point --verify at the binary printed by \`node scripts/fetch-claude.mjs\``)
  }
  let actual
  try {
    actual = await claudeVersion(resolved)
  } catch (error) {
    die(`cannot read a version from ${resolved}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (actual !== VERSION) {
    die(
      `${resolved} reports ${CLAUDE_CODE_PIN.tool}@${actual}; this repository is pinned to ${CLAUDE_CODE_PIN.tool}@${VERSION} — install the pin or re-capture the goldens (D8)`,
    )
  }
  process.stderr.write(`fetch-claude: ${resolved} reports ${CLAUDE_CODE_PIN.tool}@${actual}\n`)
}

async function install() {
  if (existsSync(join(ROOT, 'package.json')) && existsSync(join(ROOT, 'node_modules')) && isComplete(ROOT)) {
    // A cache hit is still an install claim: run the binary once so a restored
    // or half-written tree cannot hand the suite a different oracle. The
    // workflow guard does this too; doing it here keeps local runs honest.
    const cached = findPlatformBinary(ROOT)
    let actual
    try {
      actual = await claudeVersion(cached)
    } catch (error) {
      die(
        `cached install at ${ROOT} cannot run ${cached}: ${error instanceof Error ? error.message : String(error)} — ` +
          `delete .claude-code/${VERSION} and re-run`,
      )
    }
    if (actual !== VERSION) {
      die(
        `${cached} in the cached install reports ${CLAUDE_CODE_PIN.tool}@${actual}; this repository is pinned to ` +
          `${CLAUDE_CODE_PIN.tool}@${VERSION} — delete .claude-code/${VERSION} and re-run`,
      )
    }
    process.stderr.write(`fetch-claude: ${VERSION} already installed and verified\n`)
    process.stdout.write(`${cached}\n`)
    return
  }

  mkdirSync(ROOT, { recursive: true })
  writeManifest(ROOT)

  // `npm install` with no arguments installs the manifest above. --no-save keeps
  // the manifest exactly as written; the lockfile is not part of the pin.
  // --ignore-scripts is intentional: see the header.
  const npmCli = process.env.npm_execpath
  const result = spawnSync(
    npmCli === undefined ? 'npm' : process.execPath,
    [
      ...(npmCli === undefined ? [] : [npmCli]),
      'install',
      '--prefix',
      ROOT,
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--cache',
      CACHE_DIR,
      '--loglevel',
      'error',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, npm_config_cache: CACHE_DIR, npm_config_update_notifier: 'false' },
      encoding: 'utf8',
    },
  )
  if (result.error !== undefined) die(result.error.message)
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '')
    die(`npm install exited ${result.status}`)
  }

  const bin = findPlatformBinary(ROOT)
  if (bin === undefined) {
    die(
      `installed ${CLAUDE_CODE_PACKAGE}@${VERSION} but found no native binary under ${join(ROOT, 'node_modules', '@anthropic-ai')}; ` +
        `the platform optional dependency is missing (unsupported platform, or --omit=optional)`,
    )
  }
  const actual = await claudeVersion(bin)
  if (actual !== VERSION) {
    die(
      `${bin} reports ${CLAUDE_CODE_PIN.tool}@${actual} after installing ${CLAUDE_CODE_PACKAGE}@${VERSION}; ` +
        `the npm tree does not match the pin`,
    )
  }

  process.stderr.write(`fetch-claude: installed ${CLAUDE_CODE_PIN.tool}@${actual}\n`)
  // The only stdout line: CI captures this as CLAUDE_BIN.
  process.stdout.write(`${bin}\n`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE)
    return
  }
  if (args[0] === '--verify') {
    if (args.length !== 2) die(USAGE.trim())
    await verify(args[1])
    return
  }
  if (args.length !== 0) die(USAGE.trim())
  await install()
}

await main()
