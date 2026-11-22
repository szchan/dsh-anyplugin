// Pack the optional panel as a publishable artifact.
//
// The repository manifest is the *development* manifest: `exports["."]` points
// at `src/index.ts` (R7) and `private` is true. A published panel must import
// from `lib/`, so this stages the built tree in a temp directory, rewrites only
// those two fields, and lets `npm pack` produce the tarball. Nothing is written
// into the workspace.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const UI_PACKAGE = 'packages/dsh-anyplugin-ui'
/** D59 covers the root tarball; this is the panel's own, smaller budget. */
export const UI_CEILING_BYTES = 64 * 1024

export function stageUi(stage) {
  const source = resolve(UI_PACKAGE)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  manifest.private = false
  manifest.license = 'MIT'
  manifest.exports['.'] = './lib/index.js'
  manifest.peerDependencies = { 'dsh-anyplugin': '^0.2.0' }
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    cpSync(join(source, entry), join(stage, entry), { recursive: true })
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** Stage + pack; returns the tarball path, its byte size and the file list. */
export function packUi({ dest } = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'anyplugin-ui-stage-'))
  const out = dest ?? mkdtempSync(join(tmpdir(), 'anyplugin-ui-out-'))
  mkdirSync(out, { recursive: true })
  try {
    stageUi(stage)
    const raw = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], {
      cwd: stage,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [packed] = JSON.parse(raw)
    return { tarball: join(out, packed.filename), size: packed.size, files: packed.files, manifest: packed }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packed = packUi()
  console.log(`pack:ui: ${packed.tarball} (${(packed.size / 1024).toFixed(1)} KiB, ${packed.files.length} files)`)
}
