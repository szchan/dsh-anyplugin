import assert from 'node:assert/strict'
import test from 'node:test'

import { GATE_MARKERS, GATE_MODULES, KERNEL_ENTRY, lintShippedLib } from './shipped-gates.mjs'

/** A clean artifact: every gate module lazy, the kernel alone uses node:vm. */
function cleanFiles() {
  const cli = GATE_MODULES.map((module) => `const load = () => import("./${module}")`).join('\n')
  return [
    { path: 'lib/cli.js', source: cli },
    { path: 'lib/chunk-AAAA.js', source: 'export const version = "0.2.0"' },
    { path: KERNEL_ENTRY, source: 'import { SourceTextModule } from "node:vm"' },
  ]
}

test('shipped gates: a clean artifact passes', () => {
  assert.deepEqual(lintShippedLib(cleanFiles()), [])
})

test('shipped gates: a bundled inventory is named, not hidden', () => {
  const files = cleanFiles()
  files.push({ path: 'lib/chunk-QNQKM6QM.js', source: 'const INVENTORY_SCHEMA = "dsh-anyplugin/inventory@1"' })
  assert.deepEqual(lintShippedLib(files), [
    'lib/chunk-QNQKM6QM.js carries conformance-gate code: INVENTORY_SCHEMA',
  ])
})

test('shipped gates: a module that stops being lazy is a failure', () => {
  const files = cleanFiles().map((file) =>
    file.path === 'lib/cli.js' ? { ...file, source: file.source.replace('import("./inventory.ts")', 'import("./rig.ts")') } : file,
  )
  assert.deepEqual(lintShippedLib(files), [
    'lib/cli.js does not load "./inventory.ts" lazily; a packed command would need the conformance gate',
  ])
})

test('shipped gates: SourceTextModule is kernel-only', () => {
  const files = cleanFiles()
  files.push({ path: 'lib/chunk-BBBB.js', source: 'const x = SourceTextModule' })
  assert.deepEqual(lintShippedLib(files), [
    'lib/chunk-BBBB.js carries SourceTextModule; only the kernel entry may',
  ])
})

test('shipped gates: every marker is non-empty and distinct', () => {
  assert.equal(new Set(GATE_MARKERS).size, GATE_MARKERS.length)
  assert.equal(new Set(GATE_MODULES).size, GATE_MODULES.length)
  assert.ok(GATE_MARKERS.every((marker) => marker.length > 0))
})
