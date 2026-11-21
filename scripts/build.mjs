/**
 * Bundle the runtime entries into `lib/` — the packaging step, nothing more.
 *
 * `src/` stays the development entry: every workspace package keeps
 * `exports: { ".": "./src/index.ts" }` so tests and spikes run the source
 * directly (Node's type stripping). The published tarball cannot do that — a
 * consumer's Node does not strip TypeScript and the workspace manifests are
 * private — so each entry the loader can ever be asked to import is bundled
 * here, with the harness packages and Node builtins left external.
 *
 * One release fact shapes this file: **0.2.0 ships the mods kernel**. Mods load
 * as authored (D30/D31): no transpile, bundle, minify or rewrite. The one
 * exception is a classic-pragma `.tsx` module, which goes through a single
 * `@babel/plugin-transform-react-jsx` pass in memory (D34). That is why the
 * kernel is bundled into `lib/materialize/hook.js` while the two Babel
 * packages stay **external and declared**: they are the kernel's runtime, so a
 * consumer's Node must resolve them from the installed `dependencies`, not
 * from a copy baked into the tarball.
 *
 * The metafile is kept for one gate reason: `check:pack` prints the kernel's
 * share of the bundle from `lib/kernel-size.json`, so a release cannot claim
 * the kernel ships without also stating what it costs.
 *
 * Still no source maps, no minification and no runtime code generation: the
 * emitted loader configs are pure data (D1), and this script only turns the
 * compiler that produces them into a file a consumer can import.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lib = join(root, 'lib')

/** The kernel's source directory; its `bytesInOutput` sum is the shipped cost. */
const kernelDir = 'packages/dsh-anyplugin-mod-host/'

/** Entry point → output path under `lib/`, matching `exports` in package.json. */
const ENTRIES = {
  index: 'packages/dsh-anyplugin-install/src/controller.ts',
  'materialize/agents': 'packages/dsh-anyplugin-materialize-agents/src/index.ts',
  'materialize/hook': 'packages/dsh-anyplugin-materialize-hook/src/index.ts',
  'materialize/mcp': 'packages/dsh-anyplugin-materialize-mcp/src/index.ts',
  'materialize/output-style': 'packages/dsh-anyplugin-materialize-output-style/src/index.ts',
  'materialize/skill': 'packages/dsh-anyplugin-materialize-skill/src/index.ts',
}

const externals = [
  '@deepseek-ai/*',
  'node:*',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/client/*',
  // The kernel's runtime, resolved from the installed dependencies (D34).
  '@babel/core',
  '@babel/plugin-transform-react-jsx',
]

async function main() {
  rmSync(lib, { recursive: true, force: true })
  for (const out of Object.keys(ENTRIES)) {
    await mkdir(dirname(join(lib, `${out}.js`)), { recursive: true })
  }

  let kernelBytes = 0
  const kernelInputs = new Set()
  const kernelExternals = new Set()

  for (const [out, entry] of Object.entries(ENTRIES)) {
    const result = await build({
      entryPoints: [join(root, entry)],
      outfile: join(lib, `${out}.js`),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: ['node22'],
      external: externals,
      metafile: true,
      logLevel: 'warning',
      legalComments: 'none',
      banner: { js: `// dsh-anyplugin ${pkg.version} — built by scripts/build.mjs; do not edit.` },
    })

    for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
      // The hook entry's external imports are the evidence that the Babel
      // packages stayed out of the bundle; persist it instead of grepping the
      // output for a package name in a later gate.
      if (outputPath.endsWith('materialize/hook.js')) {
        for (const imported of output.imports ?? []) {
          if (imported.external === true) kernelExternals.add(imported.path)
        }
      }
      for (const [input, info] of Object.entries(output.inputs)) {
        if (!input.startsWith(kernelDir)) continue
        kernelBytes += info.bytesInOutput
        kernelInputs.add(input)
      }
    }
  }

  writeFileSync(
    join(lib, 'kernel-size.json'),
    `${JSON.stringify(
      {
        version: pkg.version,
        entry: 'lib/materialize/hook.js',
        bytes: kernelBytes,
        inputs: [...kernelInputs].sort(),
        externals: [...kernelExternals].sort(),
      },
      null,
      2,
    )}\n`,
  )

  process.stdout.write(
    `build: ${Object.keys(ENTRIES).length} entries → lib/; mods kernel ${kernelBytes} bytes across ${kernelInputs.size} files\n`,
  )
}

await main()
