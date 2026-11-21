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
 * Two deliberate choices:
 *
 * - **No source maps, no minification, no code generation at runtime.** The
 *   emitted loader configs are still pure data (D1); this script only turns
 *   the compiler that produces them into a file a consumer can import.
 * - **`dsh-anyplugin-mod-host` is replaced by `scripts/build-stubs/mod-host.mjs`.**
 *   The mods kernel is not part of 0.1.0. Bundling the real one would pull
 *   `@babel/core` and the whole host into the tarball and quietly ship a
 *   surface the release does not claim. The stub keeps the classic-hook path
 *   working and refuses a hand-written `mods` list with a named reason.
 */
import { readFileSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lib = join(root, 'lib')
const stub = join(root, 'scripts', 'build-stubs', 'mod-host.mjs')

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
]

/** Redirect the mods host to the 0.1 stub; nothing else is allowed to be rewritten. */
const modHostStub = {
  name: 'mod-host-stub',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /dsh-anyplugin-mod-host/ }, (args) => {
      if (!args.path.includes('dsh-anyplugin-mod-host')) return null
      return { path: stub }
    })
  },
}

async function main() {
  rmSync(lib, { recursive: true, force: true })
  for (const out of Object.keys(ENTRIES)) {
    await mkdir(dirname(join(lib, `${out}.js`)), { recursive: true })
  }

  for (const [out, entry] of Object.entries(ENTRIES)) {
    await build({
      entryPoints: [join(root, entry)],
      outfile: join(lib, `${out}.js`),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: ['node22'],
      external: externals,
      plugins: [modHostStub],
      logLevel: 'warning',
      legalComments: 'none',
      banner: { js: `// dsh-anyplugin ${pkg.version} — built by scripts/build.mjs; do not edit.` },
    })
  }

  process.stdout.write(`build: ${Object.keys(ENTRIES).length} entries → lib/\n`)
}

await main()
