/**
 * Where the DSH under test lives.
 *
 * D9 originally said the oracle must boot the *installed* Desktop bundle and
 * never npm, because the products were believed to differ. They do not: the
 * published `@deepseek-ai/dsh-skill@0.2.2-rc.2` is byte-identical to the copy
 * inside the app. The corrected rule (D22) is that the oracle boots an
 * explicit harness *pin* — the Desktop install when that is what the user runs,
 * or a released npm harness fetched by `scripts/fetch-harness.mjs` — and never
 * an unpinned `latest`.
 *
 * Resolution order, first match wins:
 *
 *   DSH_HARNESS_DIR      an install root made by `scripts/fetch-harness.mjs`
 *   DSH_INSTALL_DIR      a Desktop install (the `@deepseek-ai/dsh` package dir)
 *   .harness/<version>   for the version named by DSH_HARNESS_VERSION
 *
 * A variable that is set but names nothing usable is a configuration error, not
 * a reason to fall through: silently testing rc.2 while the caller asked for
 * rc.5 would make every green run a lie. Only "nothing was named" resolves to
 * `undefined`, which is what lets a local test skip with a reason. In CI
 * (`CI=true`) that is an error too — a skipped fidelity test on CI is a bug.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, for resolving `.harness/<version>`. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export type HarnessSource = 'DSH_HARNESS_DIR' | 'DSH_INSTALL_DIR' | '.harness'

export interface HarnessLocation {
  /**
   * Directory holding the `@deepseek-ai/*` package folders. This is what the
   * oracle imports from (and what DshProbeOptions.harnessDir expects).
   */
  harnessDir: string
  /** The `node_modules` root that contains `harnessDir`; sdkRoot for materializers. */
  modulesDir: string
  /** The directory `npm install --prefix` created (contains `node_modules`). */
  installRoot: string
  /** Version of the harness packages actually on disk, not the version asked for. */
  version: string
  /** Which input named this directory. */
  source: HarnessSource
}

export interface ResolveHarnessOptions {
  env?: NodeJS.ProcessEnv
  /** Override for tests; defaults to this repository. */
  repoRoot?: string
}

/** Packages every usable harness must provide; they are what the oracle imports. */
const REQUIRED_PACKAGES = ['cordis', 'cordis-plugin-loader', 'dsh-skill'] as const

function manifestVersion(harnessDir: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(harnessDir, name, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * The version the packages on disk claim.
 *
 * The Desktop bundle ships the `dsh` product package; an npm harness install
 * deliberately does not (it would drag the whole application in), so the version
 * comes from `dsh-skill`, the package the oracle actually boots. When both are
 * present they must agree — a mixed tree is not a pin.
 */
export function readHarnessVersion(harnessDir: string): string {
  const product = manifestVersion(harnessDir, 'dsh')
  const skill = manifestVersion(harnessDir, 'dsh-skill')
  if (product !== undefined && skill !== undefined && product !== skill) {
    throw new Error(`dsh oracle: mixed harness at ${harnessDir}: dsh@${product} but dsh-skill@${skill}`)
  }
  const version = product ?? skill
  if (version === undefined) {
    throw new Error(`dsh oracle: no dsh or dsh-skill manifest under ${harnessDir}`)
  }
  return version
}

function isHarnessDir(dir: string): boolean {
  return REQUIRED_PACKAGES.every((name) => existsSync(join(dir, name, 'package.json')))
}

function fromHarnessDir(harnessDir: string, source: HarnessSource): HarnessLocation {
  const modulesDir = dirname(harnessDir)
  return {
    harnessDir,
    modulesDir,
    installRoot: dirname(modulesDir),
    version: readHarnessVersion(harnessDir),
    source,
  }
}

/**
 * Accept the three shapes a caller can reasonably name: the install root printed
 * by `fetch-harness.mjs`, a `node_modules` directory, the `@deepseek-ai` scope
 * directory itself, or (for `DSH_INSTALL_DIR`) the `dsh` package directory
 * inside it.
 */
function locate(root: string, source: HarnessSource): HarnessLocation {
  const candidates = [join(root, 'node_modules', '@deepseek-ai'), join(root, '@deepseek-ai'), root, dirname(root)]
  for (const candidate of candidates) {
    if (isHarnessDir(candidate)) return fromHarnessDir(candidate, source)
  }
  throw new Error(
    `dsh oracle: ${source}=${root} does not look like a DSH harness; expected ${REQUIRED_PACKAGES.join(', ')} ` +
      `under ${join(root, 'node_modules', '@deepseek-ai')}`,
  )
}

function isCI(env: NodeJS.ProcessEnv): boolean {
  return env.CI === 'true' || env.CI === '1'
}

/**
 * Resolve the harness under test, or `undefined` when no source was named.
 * Throws when an explicit source is unusable, when the requested version does
 * not match the tree on disk, or when running in CI with nothing resolved.
 */
export function resolveHarness(options: ResolveHarnessOptions = {}): HarnessLocation | undefined {
  const env = options.env ?? process.env
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const requested = env.DSH_HARNESS_VERSION?.trim()
  const explicitDir = env.DSH_HARNESS_DIR?.trim()
  const installDir = env.DSH_INSTALL_DIR?.trim()

  let location: HarnessLocation | undefined
  if (explicitDir !== undefined && explicitDir !== '') {
    location = locate(resolve(explicitDir), 'DSH_HARNESS_DIR')
  } else if (installDir !== undefined && installDir !== '') {
    location = locate(resolve(installDir), 'DSH_INSTALL_DIR')
  } else if (requested !== undefined && requested !== '') {
    const root = join(repoRoot, '.harness', requested)
    // A missing fetched version is "nothing resolves" locally (the test skips
    // and says how to fetch it); CI's guard below turns it into a failure.
    if (existsSync(root)) location = locate(root, '.harness')
  }

  if (location !== undefined) {
    if (requested !== undefined && requested !== '' && location.version !== requested) {
      throw new Error(
        `dsh oracle: DSH_HARNESS_VERSION=${requested} but ${location.harnessDir} contains dsh@${location.version}`,
      )
    }
    return location
  }

  if (isCI(env)) {
    throw new Error(
      'dsh oracle: CI requires a resolved harness; set DSH_HARNESS_DIR to a directory made by ' +
        '`node scripts/fetch-harness.mjs <version>` (a skipped fidelity test on CI is a bug)',
    )
  }
  return undefined
}

/** The reason to pass to a test's `skip`, so a skip is never silent. */
export function harnessSkipReason(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.DSH_HARNESS_VERSION?.trim()
  if (requested !== undefined && requested !== '') {
    return (
      `no DSH harness resolved for DSH_HARNESS_VERSION=${requested}: run ` +
      `\`node scripts/fetch-harness.mjs ${requested}\` (or set DSH_HARNESS_DIR/DSH_INSTALL_DIR)`
    )
  }
  return (
    'no DSH harness resolved: set DSH_HARNESS_DIR, or DSH_INSTALL_DIR for a Desktop install, ' +
    'or fetch a version with `node scripts/fetch-harness.mjs <version>` and set DSH_HARNESS_VERSION'
  )
}
