// The scanner against the real mod that ships with the pinned Claude Code.
//
// The source comes from the fetched pin (`ANYPLUGIN_MODS_TREE`, filled by
// `scripts/fetch-mod.mjs`); it is never copied into this repository — upstream
// is all rights reserved (fixtures/mods/PROVENANCE.md). The pin has to be
// present: a missing tree fails like a missing harness, it does not skip.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { capabilityList, scanModSource } from '../../dsh-anyplugin-mod-scan/src/index.ts'

// Pin: claude-code 2.1.329, commit f9e4d1e5…. The mod's register file is under
// hooks/, not at mods/diff/register.ts.
const PIN = 'f9e4d1e5753ccffcffdd832f047d72be000396a6'
const TREE = process.env.ANYPLUGIN_MODS_TREE
const ENTRY = TREE === undefined ? undefined : join(TREE, 'mods', 'diff', 'hooks', 'register.ts')
const FIXTURE = JSON.parse(
  readFileSync(new URL('../../../fixtures/mods/diff/fixture.json', import.meta.url), 'utf8'),
)

test('the pinned upstream diff mod scans deterministically and every line exists', () => {
  assert.ok(TREE !== undefined && TREE.trim() !== '', 'ANYPLUGIN_MODS_TREE is not set; run node scripts/fetch-mod.mjs')
  assert.ok(
    existsSync(ENTRY),
    `the pinned diff entry is missing at ${ENTRY}; run node scripts/fetch-mod.mjs (pin ${PIN})`,
  )
  const source = readFileSync(ENTRY, 'utf8')

  const first = scanModSource(source, { file: 'mods/diff/hooks/register.ts' })
  const second = scanModSource(source, { file: 'mods/diff/hooks/register.ts' })

  assert.ok(first.events.length > 0, 'the real mod has literal on() sites')
  assert.ok(first.calls.length > 0, 'the real mod has direct $.namespace.method sites')
  assert.deepEqual(second, first, 'the same source must produce the same scan')
  assert.deepEqual(capabilityList(second), capabilityList(first), 'the capability list must be byte-identical across runs')

  // Pinned facts, read from the same fixture the conformance suite asserts.
  // A drift here is a real change in the mod, not test noise.
  assert.equal(first.events.length, FIXTURE.registrations.length)
  assert.equal(new Set(first.events.map((event) => event.name)).size, FIXTURE.scan.uniqueEvents)
  assert.equal(first.calls.length, FIXTURE.scan.calls)
  assert.deepEqual(first.dynamic, [], 'this file has no capability the scanner cannot prove')
  assert.deepEqual(capabilityList(first), [
    'hooks: command.run, prompt.submit, session.start, tool.call, turn.complete, ui.close, ui.focus, ui.render, ui.scroll',
    'calls: clock.after, clock.every, clock.now, command.register, env.get, fs.list, fs.read, fs.stat, process.run, ' +
      'session.id, session.messages, session.usage, settings.read, store.get, store.set, telemetry.log, telemetry.mark, ' +
      'ui.close, ui.invalidate, ui.log, ui.open, ui.resolve, ui.status, vcs.detect, vcs.diff',
  ])

  // A line number that does not point at the construct would still pass a
  // "line <= length" check. Require the line to contain the exact namespace the
  // call claims, and lock the one split call by its two lines.
  const lines = source.split('\n')
  for (const event of first.events) {
    assert.ok(Number.isInteger(event.line) && event.line >= 1 && event.line <= lines.length, `event line ${event.line} exists`)
    assert.match(lines[event.line - 1], /\bon\s*\(/, `event line ${event.line} points at an on( call`)
  }
  for (const call of first.calls) {
    assert.ok(Number.isInteger(call.line) && call.line >= 1 && call.line <= lines.length, `call line ${call.line} exists`)
    assert.ok(
      lines[call.line - 1].includes(`$.${call.namespace}`),
      `call line ${call.line} points at $.${call.namespace} (not just any $. site)`,
    )
  }

  const usage = first.calls.find((call) => call.namespace === 'session' && call.method === 'usage')
  assert.ok(usage, 'the scanner found $.session.usage')
  assert.equal(usage.line, 980)
  assert.match(lines[usage.line - 1], /\$\.session\s*$/, 'line 980 is the namespace half')
  assert.match(lines[usage.line], /^\s*\.usage\(\)/, 'line 981 is the method half')
})
