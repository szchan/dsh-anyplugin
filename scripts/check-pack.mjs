/**
 * check:pack — the invariants a publishable tarball must satisfy.
 *
 * `npm run verify` runs this, so a package that would ship a broken `exports`
 * map, a TypeScript source, a harness import, or an undeclared runtime
 * dependency cannot merge. It packs with `--ignore-scripts` on purpose: the
 * caller builds first, and the flag is what lets the install smoke be tested
 * against a lib-less tarball (the mutation the smoke must catch).
 *
 * The final step is the real install smoke: this is the only check that boots
 * the harness against the packed artifact.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []
const notes = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const packDir = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-pack-'))
try {
  let packed
  try {
    packed = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )[0]
  } catch (error) {
    failures.push(`npm pack failed: ${error.stderr?.toString().trim() || error.message}`)
  }

  if (packed) {
    const tarball = join(packDir, packed.filename)
    check(existsSync(tarball), `npm pack did not leave ${tarball}`)
    notes.push(`${packed.entryCount} entries, ${(packed.size / 1024).toFixed(0)} KiB`)

    const tree = join(packDir, 'unpacked')
    mkdirSync(tree, { recursive: true })
    execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', tree], { stdio: 'pipe' })
    const files = new Set(packed.files.map((file) => file.path.split(sep).join('/')))
    const has = (path) => files.has(path)
    check(has('package.json'), 'the tarball has no package.json')
    check(has('LICENSE'), 'the tarball has no LICENSE')
    check(has('INSTALL.md'), 'the tarball has no INSTALL.md')
    check(has('README.md'), 'the tarball has no README.md')
    check(has(manifest.dsh?.bundle?.patch?.replace(/^\.\//, '') ?? 'cordis.patch.yml'), 'the bundle patch is not in the tarball')

    // 1. The built entry point and every published export target.
    check(manifest.main === './lib/index.js', `main is ${JSON.stringify(manifest.main)}, expected ./lib/index.js`)
    check(has('lib/index.js'), 'the tarball has no lib/index.js — did the build run?')
    check(typeof manifest.exports === 'object' && manifest.exports !== null, 'package.json has no exports map')
    check(manifest.exports?.['.'] === './lib/index.js', 'exports["."] does not point at ./lib/index.js')
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      if (key === './package.json') continue
      check(typeof target === 'string', `exports[${JSON.stringify(key)}] is not a string`)
      if (typeof target !== 'string') continue
      const path = target.replace(/^\.\//, '')
      check(has(path), `exports[${JSON.stringify(key)}] → ${target}, which is not in the tarball`)
      check(!path.startsWith('src/'), `exports[${JSON.stringify(key)}] points into src/ — source is the dev entry, not the shipped one`)
    }
    const materialize = Object.keys(manifest.exports ?? {}).filter((key) => key.startsWith('./materialize/'))
    check(materialize.length >= 5, `expected at least the 5 materializer subpaths, found ${materialize.length}`)
    notes.push(`${Object.keys(manifest.exports ?? {}).length} exports, ${materialize.length} materializer subpaths`)

    // 2. No TypeScript in lib, and no source tree in the tarball at all.
    const libFiles = [...files].filter((path) => path.startsWith('lib/'))
    check(libFiles.length > 0, 'the tarball contains no lib/ files')
    check(!libFiles.some((path) => path.endsWith('.ts') || path.endsWith('.tsx')), 'lib/ contains TypeScript sources')
    check(![...files].some((path) => path.startsWith('src/')), 'the tarball ships src/ — the dev entry must stay out')
    check(![...files].some((path) => path.startsWith('packages/')), 'the tarball ships workspace packages/')

    // 3. Runtime imports: every bare specifier in lib must be a declared runtime
    //    dependency or peer, and the harness must never be an import.
    const declared = new Map([
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.peerDependencies ?? {}),
    ])
    const contents = new Map(libFiles.map((path) => [path, readFileSync(join(tree, path), 'utf8')]))
    const imported = new Set()
    for (const [path, source] of contents) {
      for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('file:')) continue
        check(!specifier.startsWith('@deepseek-ai/'), `lib/${path.slice(4)} imports the harness package ${specifier}`)
        check(declared.has(packageName(specifier)), `lib/${path.slice(4)} imports ${specifier}, which is not declared`)
        imported.add(packageName(specifier))
      }
    }
    // A dependency loaded through a variable specifier (the MCP SDK is one) is
    // invisible to static scanning; require every declared dep to be named in
    // the built output so the manifest cannot drift from the code.
    for (const name of declared.keys()) {
      check(
        [...contents.values()].some((source) => source.includes(name)),
        `dependency ${name} is declared but never referenced by the built entries`,
      )
    }
    notes.push(`declared runtime deps: ${[...declared.keys()].sort().join(', ')}; ${imported.size} statically imported`)

    // 4. The mods kernel and its transform stack are a v0.2 feature: a tarball
    //    that contains them is publishing something 0.1.0 does not support.
    for (const [path, source] of contents) {
      check(!source.includes('@babel'), `lib/${path.slice(4)} contains @babel code; mods must not ship in 0.1.0`)
    }

    // 5. Metadata a consumer relies on.
    check(manifest.name === 'dsh-anyplugin', `package name is ${JSON.stringify(manifest.name)}`)
    check(manifest.version === '0.1.0', `version is ${JSON.stringify(manifest.version)}; v0.1 ships as 0.1.0`)
    check(manifest.private !== true, 'the published manifest is still private')
    check(manifest.license === 'MIT', `license is ${JSON.stringify(manifest.license)}`)
    check(manifest.engines?.node === '>=22.14', `engines.node is ${JSON.stringify(manifest.engines?.node)}`)
    check(typeof manifest.engines?.dsh === 'string', 'engines.dsh is missing; the version claim must be enforceable')
    check(manifest.peerDependencies?.['@deepseek-ai/cordis'] === '~4.1.0', 'the cordis peer range is not the pinned one')
    notes.push(`engines node ${manifest.engines?.node}, dsh ${manifest.engines?.dsh}`)

    // 6. The install smoke runs against this exact tarball, not the source tree.
    if (failures.length === 0) {
      try {
        execFileSync(process.execPath, [join(root, 'scripts', 'smoke-install.mjs'), tarball], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        })
        notes.push('install smoke passed')
      } catch (error) {
        failures.push(`install smoke failed:\n${(error.stdout || '') + (error.stderr || '')}`)
      }
    }
  }
} finally {
  rmSync(packDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`check:pack: ${failures.length} invariant(s) broken\n`)
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`check:pack: ok — ${notes.join('; ')}\n`)
