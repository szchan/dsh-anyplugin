/**
 * check:pack — the invariants a publishable tarball must satisfy.
 *
 * `npm run verify` runs this, so a package that would ship a broken `exports`
 * map, a TypeScript source, a harness import, an undeclared runtime dependency,
 * or a mods stub instead of the kernel cannot merge. It builds first and then
 * packs with `--ignore-scripts`: building here is what makes `node
 * scripts/check-pack.mjs` and `npm run check:pack` check the same sources, and
 * the flag is what lets the install smoke be tested against a lib-less tarball
 * (the mutation the smoke must catch).
 *
 * The final steps boot the packed artifact. The install smoke composes the
 * packed data in a synthetic harness; the profile boot installs the tarball
 * into a scratch profile and boots the host's own profile loader, so the gate
 * observes what a user's installation observes (S20, ticket #137). This is the
 * only check that boots the tarball npm installed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GATE_MODULES, lintShippedLib } from './shipped-gates.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []
const notes = []

/**
 * The packaged artifact's own budget. D46 asserts the 128 KiB *kernel* ceiling;
 * this one bounds the tarball the registry serves, so growth is a visible
 * decision. The deduped controller+CLI build measures ~174.3 KiB; 180 KiB
 * leaves room for a doc paragraph without inviting drift. Raise it only with a
 * decision entry. D65 raised it from 180 KiB to 184 KiB: the shipped CLI carries the Codex
 * marketplace reader, which measures 181.9 KiB compressed. D71 raises it to 188 KiB: routing
 * the five S23 classic events adds record translation to the shipped hook materializer, and
 * the tarball measures 190257 bytes. D77 ships the panel in the same tarball: its server half
 * is bundled into lib/index.js and its client bundle becomes lib/client.js, and the packed size
 * measures 195,992 bytes (191.4 KiB) in CI check:pack (+5,735 bytes on D71). The ceiling moves to 193 KiB — the
 * measured cost plus one doc paragraph of headroom — instead of a second package carrying its
 * own 64 KiB budget. D92 ships the agent model map (D91) in the same tarball: the map resolver
 * is bundled into lib/index.js, lib/cli.js and lib/materialize/agents.js, and the packed size
 * measures 202,134 bytes (197.4 KiB) in CI check:pack (+6,142 bytes on D77). The ceiling moves
 * to 200 KiB, leaving 2,666 bytes of headroom.
 */
const TARBALL_CEILING_BYTES = 200 * 1024
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
  // The tarball must be built from the sources in this checkout, not from a
  // `lib/` left by an earlier run: a direct invocation is a gate too.
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe' })
  } catch (error) {
    failures.push(`build failed: ${error.stderr?.toString().trim() || error.message}`)
  }

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
    notes.push(`${packed.entryCount} entries, ${packed.size} bytes`)
    check(
      packed.size <= TARBALL_CEILING_BYTES,
      `the tarball is ${packed.size} bytes, above the ${TARBALL_CEILING_BYTES}-byte ceiling; decide before it grows`,
    )
    notes.push(`tarball: ${packed.size} bytes (${(packed.size / 1024).toFixed(1)} KiB) / ceiling ${TARBALL_CEILING_BYTES} bytes`)

    const tree = join(packDir, 'unpacked')
    mkdirSync(tree, { recursive: true })
    execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', tree], { stdio: 'pipe' })
    const files = new Set(packed.files.map((file) => file.path.split(sep).join('/')))
    const has = (path) => files.has(path)
    check(has('package.json'), 'the tarball has no package.json')
    check(has('LICENSE'), 'the tarball has no LICENSE')
    check(has('INSTALL.md'), 'the tarball has no INSTALL.md')
    check(has('README.md'), 'the tarball has no README.md')
    // Both READMEs ship and render on npm: a local image they name must be in
    // the tarball, or the package page shows a broken image.
    for (const name of ['README.md', 'README_cn.md']) {
      if (!has(name)) continue
      const text = readFileSync(join(tree, name), 'utf8')
      for (const match of text.matchAll(/(?:src|href)=["'](?!(?:https?:|#|\/\/))([^"']+)["']/g)) {
        const target = match[1].replace(/^\.\//, '')
        if (!/\.(?:svg|png|jpe?g|gif|webp)$/i.test(target)) continue
        check(has(target), `${name} references ${target}, which is not in the tarball`)
      }
    }
    check(has(manifest.dsh?.bundle?.patch?.replace(/^\.\//, '') ?? 'cordis.patch.yml'), 'the bundle patch is not in the tarball')

    // The generated mod type surface is internal (#144, D59): shipping it would
    // redistribute Anthropic's pinned declaration, which D14 forbids. The TODO
    // Done entry says it is not shipped; this assertion is what makes that true.
    const typeSurface = [...files].filter((path) => path === 'types/mod.d.ts' || path.startsWith('types/') || path.includes('/types/'))
    check(typeSurface.length === 0, `the tarball ships the internal type surface: ${typeSurface.join(', ')}`)

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
    // These are exactly the entries the reconciler can name (MATERIALIZERS in
    // controller.ts); a missing one is a child the loader could never import.
    for (const name of ['skill', 'mcp', 'hook', 'agents', 'output-style']) {
      check(materialize.includes(`./materialize/${name}`), `exports is missing ./materialize/${name}`)
    }
    notes.push(`${Object.keys(manifest.exports ?? {}).length} exports, ${materialize.length} materializer subpaths`)

    // 1b. The published bin. One command, one file, and it must start from the
    //     extracted copy with no environment — `--help` is how a user checks an
    //     install before any DSH profile exists.
    const bins = manifest.bin !== null && typeof manifest.bin === 'object' ? Object.entries(manifest.bin) : []
    check(
      bins.length === 1 && bins[0][0] === 'dsh-anyplugin' && bins[0][1] === './lib/cli.js',
      `bin is ${JSON.stringify(manifest.bin)}, expected exactly {"dsh-anyplugin": "./lib/cli.js"}`,
    )
    check(has('lib/cli.js'), 'the tarball has no lib/cli.js — the declared bin does not ship')
    if (has('lib/cli.js')) {
      const cliSource = readFileSync(join(tree, 'lib', 'cli.js'), 'utf8')
      check(cliSource.startsWith('#!/usr/bin/env node\n'), 'lib/cli.js has no node shebang; an installed bin cannot execute')
      const binEnv = { ...process.env }
      for (const key of Object.keys(binEnv)) {
        // A value in this shell must not be what makes the command start: the
        // assertion is "works on a machine with no DSH install".
        if (key === 'CLAUDE_BIN' || key.startsWith('DSH_') || key.startsWith('ANYPLUGIN_')) delete binEnv[key]
      }
      binEnv.HOME = join(packDir, 'bin-home')
      binEnv.USERPROFILE = binEnv.HOME
      mkdirSync(binEnv.HOME, { recursive: true })
      try {
        const help = execFileSync(process.execPath, [join(tree, 'lib', 'cli.js'), '--help'], {
          cwd: tree,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: binEnv,
          timeout: 60_000,
        })
        check(help.includes('install <plugin-dir>'), 'lib/cli.js --help does not print the install command')
        check(help.includes('marketplace install'), 'lib/cli.js --help does not print the marketplace commands')
        notes.push('bin: node lib/cli.js --help exits 0 with no DSH environment')
      } catch (error) {
        failures.push(`lib/cli.js --help failed without a DSH environment:\n${(error.stdout || '') + (error.stderr || '')}`)
      }
    }

    // 2. No TypeScript in lib, and no source tree in the tarball at all.
    const libFiles = [...files].filter((path) => path.startsWith('lib/'))
    check(libFiles.length > 0, 'the tarball contains no lib/ files')
    check(!libFiles.some((path) => path.endsWith('.ts') || path.endsWith('.tsx')), 'lib/ contains TypeScript sources')
    check(![...files].some((path) => path.startsWith('src/')), 'the tarball ships src/ — the dev entry must stay out')
    check(![...files].some((path) => path.startsWith('packages/')), 'the tarball ships workspace packages/')

    // 2b. The conformance gates never ship. The shipped commands install, list,
    //     enable, disable, uninstall, report, grant, revoke and the marketplace
    //     never reach the Claude oracle, the golden-inventory reader or the
    //     trace differ; those are lazy modules left external. Scan every shipped
    //     lib file, chunks included, because a static import can land there
    //     instead of in the entry, and require the CLI to keep one literal lazy
    //     import per module so a bundled copy also removes a green check.
    //     `SourceTextModule` is allowed only in the kernel entry: D30 needs the
    //     flag there and nowhere else.
    const shippedJs = libFiles
      .filter((file) => file.endsWith('.js'))
      .map((path) => ({ path, source: readFileSync(join(tree, path), 'utf8') }))
    const gateFailures = lintShippedLib(shippedJs)
    for (const failure of gateFailures) failures.push(failure)
    if (gateFailures.length === 0) {
      notes.push('shipped lib: no conformance-gate markers (oracle, inventory reader, trace differ)')
      notes.push(`shipped lib: lazy gate modules present (${GATE_MODULES.length})`)
    }

    // 3. Runtime imports: every bare specifier in lib must be a declared runtime
    //    dependency or peer, and the harness must never be an import.
    const declared = new Map([
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.peerDependencies ?? {}),
    ])
    const contents = new Map(libFiles.map((path) => [path, readFileSync(join(tree, path), 'utf8')]))

    // 2a. The panel ships in the same artifact (D77). Its client half is a
    //     dsh.client bundle whose registration id must be the package name:
    //     dsh-client-modules keys graph rows by the manifest name, so the row
    //     the loader creates and the bundle the browser loads must agree.
    check(manifest.dsh?.client?.platform === 'web', 'package.json declares no dsh.client platform — the panel bundle cannot compose')
    check(manifest.exports?.['./client'] === './lib/client.js', 'exports["./client"] does not point at ./lib/client.js')
    check(has('lib/client.js'), 'the tarball has no lib/client.js — the panel client bundle did not ship')
    const clientSource = contents.get('lib/client.js') ?? ''
    check(clientSource.includes('window.__ModuleLoader__.load('), 'lib/client.js is not a client-modules bundle')
    check(/id:\s*['"]dsh-anyplugin['"]/.test(clientSource), 'lib/client.js does not register the dsh-anyplugin client row')
    check(clientSource.includes('settings.section'), 'lib/client.js does not register the panel slot')
    // The server half may be split into shared chunks beside lib/index.js, so
    // the route and the writer reference are asserted over every server chunk —
    // but not over lib/client.js, whose own `/anyplugin/installs` fetch would
    // otherwise satisfy the read-route check with no server at all (they are
    // different halves of the feature and must be proven separately).
    const isClient = (path) => /^lib\/client(\.|-|\/)/u.test(path)
    const serverSources = [...contents].filter(([path]) => !isClient(path)).map(([, source]) => source).join('\n')
    check(serverSources.includes('dsh-anyplugin: panel routes'), 'the shipped server has no panel route registration')
    check(serverSources.includes('/anyplugin/installs'), 'the shipped server has no panel read route')
    check(serverSources.includes('dsh-anyplugin/install'), 'the shipped server does not reach the install writer through ./install')
    // The deleted package must not survive in the code or the manifest: a
    // stale id would make the bundle look for a row that is never composed.
    // INSTALL.md is allowed to name it, because its one mention is the
    // instruction to delete an old dev-profile entry (D81).
    for (const [path, source] of contents) {
      check(!source.includes('dsh-anyplugin-ui'), `${path} still names the removed dsh-anyplugin-ui package`)
    }
    check(!JSON.stringify(manifest).includes('dsh-anyplugin-ui'), 'package.json still names the removed dsh-anyplugin-ui package')
    notes.push('panel: lib/client.js is the dsh-anyplugin dsh.client bundle; the server registers its routes in lib/index.js')
    const imported = new Set()
    // The panel reaches its own package's ./install export by name (D61/D77);
    // that is a legal self-reference through the exports map, not a dependency.
    const selfReferences = new Set()
    // Anchored to an import/export statement or an `import(...)` call: esbuild
    // emits one statement per line, while bundled code legitimately contains
    // the word `from` in other places (`const from = args.options.get("from")`
    // in the CLI). An unanchored `\bfrom\s*["']` reads those as imports and
    // fails a healthy tarball.
    const importPatterns = [
      /^[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']/gm,
      /^[ \t]*import\s*["']([^"']+)["']/gm,
      /(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g,
    ]
    for (const [path, source] of contents) {
      for (const pattern of importPatterns) {
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1]
          if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('file:')) continue
          check(!specifier.startsWith('@deepseek-ai/'), `lib/${path.slice(4)} imports the harness package ${specifier}`)
          const name = packageName(specifier)
          if (name === manifest.name) {
            selfReferences.add(specifier)
            continue
          }
          check(declared.has(name), `lib/${path.slice(4)} imports ${specifier}, which is not declared`)
          imported.add(name)
        }
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
    if (selfReferences.size > 0) notes.push(`self-references through exports: ${[...selfReferences].sort().join(', ')}`)
    notes.push(`declared runtime deps: ${[...declared.keys()].sort().join(', ')}; ${imported.size} statically imported`)

    // 4. The shipped runtime set is exact, and it is the real kernel. v0.2
    //    reverses the 0.1 assertion: the pinned Babel packages are required
    //    (D34's one classic-pragma pass), and the hook entry may not carry the
    //    0.1 stub that refused every mods row.
    const expectedDeps = {
      '@babel/core': '7.29.13',
      '@babel/plugin-transform-react-jsx': '7.29.7',
      '@modelcontextprotocol/client': '2.2.0',
    }
    const shippedDeps = manifest.dependencies ?? {}
    for (const [name, version] of Object.entries(expectedDeps)) {
      check(
        shippedDeps[name] === version,
        `dependency ${name} is ${JSON.stringify(shippedDeps[name])}, expected ${version}`,
      )
    }
    check(
      Object.keys(shippedDeps).sort().join(',') === Object.keys(expectedDeps).sort().join(','),
      `dependencies are ${JSON.stringify(Object.keys(shippedDeps).sort())}, expected exactly ${JSON.stringify(Object.keys(expectedDeps).sort())}`,
    )
    check(
      shippedDeps['@deepseek-ai/cordis'] === undefined,
      'cordis is declared as a runtime dependency; it must stay a peer',
    )
    const hookSource = contents.get('lib/materialize/hook.js') ?? ''
    check(hookSource.includes('SourceTextModule'), 'the hook entry does not boot mods in a vm realm; the kernel is missing')
    check(hookSource.includes('stripTypeScriptTypes'), 'the hook entry has no type strip; the kernel is missing')
    check(!hookSource.includes('mods are not available in dsh-anyplugin'), 'the hook entry still carries the 0.1 mods stub')
    // A page that claims mods load without saying Node needs the vm flag would
    // be a lie an install cannot recover from: every packaged page that carries
    // the requirements must name it. The install page is also the artifact
    // description, so it must describe the release it ships, not the previous
    // one (round 1 shipped a 0.1.0 INSTALL.md inside a 0.2.0 tarball).
    const [major = 0, minor = 0] = (manifest.version ?? '0.0.0').split('.').map(Number)
    if (major > 0 || minor >= 2) {
      const flag = 'experimental-vm-modules'
      const reference = 'see docs/ARCHITECTURE.md §7.8'
      check(
        readFileSync(join(tree, 'README.md'), 'utf8').includes(flag),
        `the packaged README does not name --experimental-vm-modules; mods cannot load without it (${reference})`,
      )
      check(
        readFileSync(join(tree, 'README_cn.md'), 'utf8').includes(flag),
        `the packaged README_cn.md does not name --experimental-vm-modules; mods cannot load without it (${reference})`,
      )
      const install = readFileSync(join(tree, 'INSTALL.md'), 'utf8')
      check(
        install.includes(flag),
        `the packaged INSTALL.md does not name --experimental-vm-modules; mods cannot load without it (${reference})`,
      )
      check(
        !install.includes('0.1.0'),
        'the packaged INSTALL.md still discusses 0.1.0; it must describe the artifact it ships',
      )
    }
    const recorded = has('lib/kernel-size.json')
    check(recorded, 'the build did not record lib/kernel-size.json')
    const kernel = recorded ? JSON.parse(readFileSync(join(tree, 'lib/kernel-size.json'), 'utf8')) : { bytes: 0, inputs: [], externals: [] }
    check(typeof kernel.bytes === 'number' && kernel.bytes > 0, 'lib/kernel-size.json records no kernel bytes')
    check(
      Array.isArray(kernel.inputs) && kernel.inputs.every((path) => path.startsWith('packages/dsh-anyplugin-mod-host/')),
      'lib/kernel-size.json names inputs outside packages/dsh-anyplugin-mod-host',
    )
    // A printed cost that nobody compares is decoration. The kernel may not
    // outgrow the entry that carries it, nor this named ceiling (128 KiB: 86.6
    // KiB today, room for one more measured surface but not for a bundler).
    const kernelCeilingBytes = 128 * 1024
    check(
      kernel.bytes <= kernelCeilingBytes,
      `the kernel costs ${kernel.bytes} bytes, above the ${kernelCeilingBytes}-byte ceiling; name the cost in a decision before raising it`,
    )
    const runtimeExternals = (Array.isArray(kernel.externals) ? kernel.externals : []).filter((path) => !path.startsWith('node:'))
    check(
      runtimeExternals.join(',') === '@babel/core,@babel/plugin-transform-react-jsx',
      `the hook entry's non-node externals are ${JSON.stringify(runtimeExternals)}, expected the two pinned Babel packages (D34)`,
    )
    const hookSize = packed.files.find((file) => file.path === 'lib/materialize/hook.js')?.size ?? 0
    check(hookSize > 0, 'the tarball has no lib/materialize/hook.js')
    check(kernel.bytes <= hookSize, `the kernel records ${kernel.bytes} bytes but the entry is ${hookSize} bytes`)
    notes.push(
      `mods kernel ${(kernel.bytes / 1024).toFixed(1)} KiB of lib/materialize/hook.js (${(hookSize / 1024).toFixed(1)} KiB, ${kernel.inputs.length} files)`,
    )
    notes.push(`exact runtime deps: ${Object.entries(expectedDeps).map(([name, version]) => `${name}@${version}`).join(', ')}; cordis stays a peer`)

    // 5. Metadata a consumer relies on.
    check(manifest.name === 'dsh-anyplugin', `package name is ${JSON.stringify(manifest.name)}`)
    // A release train, not an exact patch: the tag-to-version equality is the
    // release workflow's assertion, this one keeps a tarball on the current train.
    const [trainMajor = 0, trainMinor = 0] = (manifest.version ?? '0.0.0').split('.').map(Number)
    check(
      trainMajor === 0 && trainMinor >= 3,
      `version is ${JSON.stringify(manifest.version)}; the 0.3 train ships as 0.3.x`,
    )
    check(manifest.private !== true, 'the published manifest is still private')
    check(manifest.license === 'MIT', `license is ${JSON.stringify(manifest.license)}`)
    check(manifest.engines?.node === '>=22.14', `engines.node is ${JSON.stringify(manifest.engines?.node)}`)
    check(typeof manifest.engines?.dsh === 'string', 'engines.dsh is missing; the version claim must be enforceable')
    check(manifest.peerDependencies?.['@deepseek-ai/cordis'] === '~4.1.0', 'the cordis peer range is not the pinned one')
    notes.push(`engines node ${manifest.engines?.node}, dsh ${manifest.engines?.dsh}`)

    // 6. The install smoke runs against this exact tarball, not the source tree.
    if (failures.length === 0) {
      try {
        const smokeOutput = execFileSync(process.execPath, [join(root, 'scripts', 'smoke-install.mjs'), tarball], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        })
        // The kernel's proof names the mod and its registration count; keep it
        // in the gate's one-line summary, not only in the smoke's stdout.
        const mods = /mods: (.*)$/m.exec(smokeOutput)
        if (mods === null) {
          // The tarball can install every compile-path surface and still ship a
          // kernel that refuses every mod; the smoke's mods line is the proof
          // that it did not.
          failures.push('install smoke passed without reporting the mods proof')
        } else {
          // Each probe is a different refusal the release could regress to:
          // the upstream mod failing to load, the bridge not serving `$`, or a
          // mod deny not reaching the tool gate. A summary that drops one must
          // fail here, not pass on the other two.
          for (const label of ['sec-default/hooks/register.ts', 'kernel-probe/register.mjs', 'guard/register.ts']) {
            check(mods[1].includes(label), `install smoke did not report ${label}`)
          }
          notes.push(`install smoke passed; mods: ${mods[1]}`)
        }
      } catch (error) {
        failures.push(`install smoke failed:\n${(error.stdout || '') + (error.stderr || '')}`)
      }
    }

    // 7. The profile boot is the install claim: the host's own loader mounts
    // the npm-installed tarball from a scratch profile. The smoke above proves
    // the packed data; this proves the artifact the profile path actually loads.
    if (failures.length === 0) {
      try {
        const bootOutput = execFileSync(process.execPath, [join(root, 'scripts', 'profile-boot.mjs'), tarball], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          timeout: 600_000,
        })
        const boot = /^profile boot: ok — (.*)$/m.exec(bootOutput)
        if (boot === null) {
          failures.push('profile boot passed without reporting what the boot observed')
        } else {
          // The observation itself is the claim: the controller entry, the
          // applied patch, the live child, the module URL that resolved, and
          // the untouched real profile stay in the gate's one-line summary.
          notes.push(`profile boot passed; ${boot[1]}`)
        }
      } catch (error) {
        failures.push(`profile boot failed:\n${(error.stdout || '') + (error.stderr || '')}`)
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
