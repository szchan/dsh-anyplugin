// Enforce the optional panel's own budget and artifact shape. D59's 180 KiB is
// the root tarball's; the panel is a second artifact and gets a smaller ceiling
// so a future browser bundle cannot grow without a decision.
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { UI_CEILING_BYTES, packUi } from './pack-ui.mjs'

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

let packed
try {
  packed = packUi()
} catch (error) {
  failures.push(`pack:ui failed: ${error.stderr?.toString().trim() || error.message}`)
}

if (packed !== undefined) {
  const packedFiles = packed.files.map((file) => file.path)
  const has = (path) => packedFiles.includes(path)
  check(
    packed.size <= UI_CEILING_BYTES,
    `the panel tarball is ${packed.size} bytes, above the ${UI_CEILING_BYTES}-byte ceiling; decide before it grows`,
  )
  check(has('lib/index.js'), 'the panel tarball has no lib/index.js')
  check(has('lib/client.js'), 'the panel tarball has no lib/client.js (the dsh.client bundle)')
  check(has('cordis.patch.yml'), 'the panel tarball has no cordis.patch.yml')
  check(has('README.md'), 'the panel tarball has no README.md')
  check(has('LICENSE'), 'the panel tarball has no LICENSE')
  check(!packedFiles.some((path) => path.startsWith('src/')), 'the panel tarball ships src/; lib/ is the shipped tree')
  check(packed.manifest.name === 'dsh-anyplugin-ui', `the panel tarball is named ${packed.manifest.name}`)
  console.log(
    `check:ui: ok — ${packed.files.length} files; tarball: ${(packed.size / 1024).toFixed(1)} KiB / ceiling ${UI_CEILING_BYTES / 1024} KiB`,
  )
  rmSync(dirname(packed.tarball), { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('check:ui: failed')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
