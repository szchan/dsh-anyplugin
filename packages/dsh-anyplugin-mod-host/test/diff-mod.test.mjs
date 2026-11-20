import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { loadMod } from '../src/index.ts'
import { DIFF_MOD_PIN } from '../src/pin.ts'

const isCI = process.env.CI === 'true' || process.env.CI === '1'
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * The upstream acceptance for #33 is the *refusal*, not a fired hook: the
 * fetched graph reaches `views/pane-view.tsx` through `views/index.ts`, and D30
 * makes `.tsx` planned (no JSX transform). This test therefore asserts the
 * typed error names that module, plus the pin and the untouched bytes.
 */
test('the fetched diff mod is refused at views/pane-view.tsx (D30 .tsx)', async (t) => {
  const tree = process.env.ANYPLUGIN_MOD_TREE
  if (!tree) {
    const reason =
      'ANYPLUGIN_MOD_TREE is unset; run `node scripts/fetch-mod.mjs` and set it to the printed root'
    if (isCI) {
      assert.fail(`CI must fetch the pinned diff mod before npm test: ${reason}`)
    }
    return t.skip(reason)
  }

  const root = resolve(tree)
  const entry = join(root, DIFF_MOD_PIN.entry)
  const before = sha256(entry)
  assert.equal(statSync(entry).size, DIFF_MOD_PIN.entryBytes, 'fetched entry size must match the pin')
  assert.equal(before, DIFF_MOD_PIN.entrySha256, 'fetched entry sha256 must match the pin')

  await assert.rejects(
    loadMod({
      root,
      entry: DIFF_MOD_PIN.entry,
      host: {
        dollar: () => {
          throw new Error('$ must not be built: the graph is refused before any handler runs')
        },
      },
    }),
    (error) => {
      assert.equal(error.name, 'ModHostError')
      assert.equal(error.code, 'ERR_MOD_HOST_TSX', error.message)
      assert.equal(error.file, join(root, 'views', 'pane-view.tsx'))
      assert.match(error.message, /views[\\/]pane-view\.tsx/)
      assert.match(error.message, /planned/)
      assert.match(error.message, /D30/)
      return true
    },
  )

  assert.equal(sha256(entry), before, 'refusing the mod must not touch the authored bytes')
})
