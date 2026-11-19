// Resolution of the harness under test (D22).
//
// These tests never boot anything: they build throwaway directory trees and
// assert which one `resolveHarness` picks, which source it reports, and when it
// refuses instead of silently falling back. The boot itself is covered by the
// oracle tests, which skip for a named reason when no harness resolves.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { harnessSkipReason, readHarnessVersion, resolveHarness } from '../src/harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'anyplugin-harness-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Create `<root>` as an npm harness install root (the shape fetch-harness prints). */
function installRoot(root, version, { product = false } = {}) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  for (const name of ['cordis', 'cordis-plugin-loader', 'dsh-skill']) {
    writeJson(join(scope, name, 'package.json'), { name: `@deepseek-ai/${name}`, version: name === 'dsh-skill' ? version : '1.0.0' })
  }
  if (product) writeJson(join(scope, 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version })
  writeJson(join(root, 'package.json'), { name: 'dsh-harness-under-test', private: true, version: '0.0.0' })
  return root
}

/** Create a Desktop-shaped install: `<app>/node_modules/@deepseek-ai/dsh/...`. */
function desktopInstall(app, version) {
  const scope = join(app, 'node_modules', '@deepseek-ai')
  for (const name of ['cordis', 'cordis-plugin-loader', 'dsh-skill', 'dsh']) {
    writeJson(join(scope, name, 'package.json'), { name: `@deepseek-ai/${name}`, version })
  }
  return join(scope, 'dsh')
}

function resolve(env, repoRoot = scratch) {
  return resolveHarness({ env, repoRoot })
}

test('DSH_HARNESS_DIR wins over DSH_INSTALL_DIR and reports its source', () => {
  const fromFetch = installRoot(join(scratch, 'npm-rc5'), '0.2.2-rc.5')
  const fromDesktop = desktopInstall(join(scratch, 'desktop'), '0.2.2-rc.2')
  const found = resolve({ DSH_HARNESS_DIR: fromFetch, DSH_INSTALL_DIR: fromDesktop })
  assert.equal(found.harnessDir, join(fromFetch, 'node_modules', '@deepseek-ai'))
  assert.equal(found.modulesDir, join(fromFetch, 'node_modules'))
  assert.equal(found.installRoot, fromFetch)
  assert.equal(found.version, '0.2.2-rc.5')
  assert.equal(found.source, 'DSH_HARNESS_DIR')
})

test('DSH_INSTALL_DIR resolves a Desktop install when no fetched harness is named', () => {
  const desktop = desktopInstall(join(scratch, 'desktop-only'), '0.2.2-rc.2')
  const found = resolve({ DSH_INSTALL_DIR: desktop })
  assert.equal(found.harnessDir, join(scratch, 'desktop-only', 'node_modules', '@deepseek-ai'))
  assert.equal(found.version, '0.2.2-rc.2')
  assert.equal(found.source, 'DSH_INSTALL_DIR')
})

test('.harness/<DSH_HARNESS_VERSION> is the fallback, resolved against the repo root', () => {
  const repo = join(scratch, 'repo')
  installRoot(join(repo, '.harness', '0.2.2-rc.2'), '0.2.2-rc.2')
  const found = resolve({ DSH_HARNESS_VERSION: '0.2.2-rc.2' }, repo)
  assert.equal(found.installRoot, join(repo, '.harness', '0.2.2-rc.2'))
  assert.equal(found.version, '0.2.2-rc.2')
  assert.equal(found.source, '.harness')
})

test('nothing named resolves to undefined locally, and the skip reason says how to fetch', () => {
  assert.equal(resolve({}), undefined)
  assert.equal(resolve({ DSH_HARNESS_VERSION: '9.9.9' }), undefined)
  assert.match(harnessSkipReason({ DSH_HARNESS_VERSION: '9.9.9' }), /fetch-harness\.mjs 9\.9\.9/)
  assert.match(harnessSkipReason({}), /DSH_HARNESS_DIR/)
})

test('a named but unusable harness is an error, never a silent fallback', () => {
  const empty = join(scratch, 'not-a-harness')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => resolve({ DSH_HARNESS_DIR: empty }), /does not look like a DSH harness/)
  assert.throws(() => resolve({ DSH_INSTALL_DIR: empty }), /does not look like a DSH harness/)
})

test('DSH_HARNESS_VERSION must match the tree on disk', () => {
  const root = installRoot(join(scratch, 'mismatch'), '0.2.2-rc.2')
  assert.throws(
    () => resolve({ DSH_HARNESS_DIR: root, DSH_HARNESS_VERSION: '0.2.2-rc.5' }),
    /DSH_HARNESS_VERSION=0\.2\.2-rc\.5 but .* contains dsh@0\.2\.2-rc\.2/,
  )
})

test('CI with no resolved harness fails instead of skipping', () => {
  assert.throws(() => resolve({ CI: 'true' }), /CI requires a resolved harness/)
  assert.throws(() => resolve({ CI: '1', DSH_HARNESS_VERSION: '9.9.9' }), /CI requires a resolved harness/)
  assert.equal(resolve({ CI: 'false' }), undefined)
})

test('the reported version comes from the packages, and a mixed tree is rejected', () => {
  // Desktop ships `dsh` and dsh-skill; an npm harness has only dsh-skill.
  const desktop = desktopInstall(join(scratch, 'mixed'), '0.2.2-rc.2')
  assert.equal(readHarnessVersion(join(scratch, 'mixed', 'node_modules', '@deepseek-ai')), '0.2.2-rc.2')
  writeJson(join(desktop, '..', 'dsh-skill', 'package.json'), { name: '@deepseek-ai/dsh-skill', version: '0.2.2-rc.5' })
  assert.throws(
    () => readHarnessVersion(join(scratch, 'mixed', 'node_modules', '@deepseek-ai')),
    /mixed harness .* dsh@0\.2\.2-rc\.2 but dsh-skill@0\.2\.2-rc\.5/,
  )
})
