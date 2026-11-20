import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { loadMod } from '../src/index.ts'
import { DIFF_MOD_PIN } from '../src/pin.ts'

const isCI = process.env.CI === 'true' || process.env.CI === '1'
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// `scripts/fetch-mod.mjs` prints the root of the whole pinned `mods/` tree;
// the diff test loads one mod out of it. Accept either that root or the diff
// hooks root itself, so an older cache and the new layout both work.
const diffRoot = (candidate) => {
  const root = resolve(candidate)
  if (existsSync(join(root, DIFF_MOD_PIN.entry))) return root
  const nested = join(root, 'mods', 'diff', 'hooks')
  return existsSync(join(nested, DIFF_MOD_PIN.entry)) ? nested : root
}

/**
 * The upstream acceptance for #45 is the load, not the refusal: the fetched
 * graph reaches `views/pane-view.tsx` through `views/index.ts`, and the narrow
 * classic transform makes that `.tsx` module loadable (D34). The entry pin and
 * the untouched bytes are asserted on both sides of the load.
 */
test('the fetched diff mod loads through the classic JSX transform', async (t) => {
  const tree = process.env.ANYPLUGIN_MOD_TREE
  if (!tree) {
    const reason =
      'ANYPLUGIN_MOD_TREE is unset; run `node scripts/fetch-mod.mjs` and set it to the printed root (or its mods/diff/hooks)'
    if (isCI) {
      assert.fail(`CI must fetch the pinned diff mod before npm test: ${reason}`)
    }
    return t.skip(reason)
  }

  const root = diffRoot(tree)
  const entry = join(root, DIFF_MOD_PIN.entry)
  const before = sha256(entry)
  assert.equal(statSync(entry).size, DIFF_MOD_PIN.entryBytes, 'fetched entry size must match the pin')
  assert.equal(before, DIFF_MOD_PIN.entrySha256, 'fetched entry sha256 must match the pin')

  const calls = []
  const mod = await loadMod({
    root,
    entry: DIFF_MOD_PIN.entry,
    host: {
      dollar: () => ({
        session: {
          usage: async () => {
            calls.push('session.usage')
            return undefined
          },
          messages: async () => {
            calls.push('session.messages')
            return []
          },
        },
        clock: {
          now: async () => {
            calls.push('clock.now')
            return 1700000000000
          },
        },
        command: {
          register: async (spec) => {
            calls.push(`command.register:${spec.name}`)
          },
        },
      }),
    },
  })

  const events = mod.registrations.map((registration) => registration.event)
  assert.deepEqual(events, [
    'session.start',
    'ui.render',
    'ui.render',
    'command.run',
    'ui.close',
    'ui.focus',
    'ui.scroll',
    'command.run',
    'tool.call',
    'turn.complete',
    'prompt.submit',
  ])
  assert.equal(new Set(events).size, 9)

  // D31's handler contract, on the real mod's session.start handler.
  const sessionStart = mod.registrations[0]
  const event = { hook_event_name: 'SessionStart', cwd: '/tmp/diff-mod' }
  const next = { kind: 'continued' }
  let sawNext
  const result = await sessionStart.handler(event, (seen) => {
    sawNext = seen
    return next
  })
  assert.equal(result, next)
  assert.equal(sawNext, event)
  assert.deepEqual(calls, [
    'session.usage',
    'clock.now',
    'command.register:diff',
    'session.messages',
  ])

  assert.equal(sha256(entry), before, 'loading the mod must not touch the authored bytes')
})
