// The scanner against the real mod that ships with the pinned Claude Code.
//
// The source is fetched at test time from the pinned commit and is never copied
// into this repository: upstream is all rights reserved (fixtures/mods/
// PROVENANCE.md). Offline runs skip with the URL in the reason; a skip is not a
// pass.
import assert from 'node:assert/strict'
import test from 'node:test'

import { capabilityList, scanModSource } from '../../dsh-anyplugin-mod-scan/src/index.ts'

// Pin: claude-code 2.1.329, tag v2.1.329. The mod's register file is under
// hooks/, not at mods/diff/register.ts.
const PIN = 'f9e4d1e5753ccffcffdd832f047d72be000396a6'
const URL = `https://raw.githubusercontent.com/anthropics/claude-code/${PIN}/mods/diff/hooks/register.ts`

test('the pinned upstream diff mod scans deterministically and every line exists', async (t) => {
  let response
  try {
    response = await fetch(URL, { signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    t.skip(`offline: ${error.message}; expected ${URL}`)
    return
  }
  if (response.status === 404) {
    assert.fail(`the pinned upstream file is missing (HTTP 404): ${URL}`)
  }
  if (!response.ok) {
    t.skip(`upstream fetch returned HTTP ${response.status}: ${URL}`)
    return
  }
  let source
  try {
    source = await response.text()
  } catch (error) {
    t.skip(`offline while reading the body: ${error.message}; expected ${URL}`)
    return
  }

  const first = scanModSource(source, { file: 'mods/diff/hooks/register.ts' })
  const second = scanModSource(source, { file: 'mods/diff/hooks/register.ts' })

  assert.ok(first.events.length > 0, 'the real mod has literal on() sites')
  assert.ok(first.calls.length > 0, 'the real mod has direct $.namespace.method sites')
  assert.deepEqual(second, first, 'the same source must produce the same scan')
  assert.deepEqual(capabilityList(second), capabilityList(first), 'the capability list must be byte-identical across runs')

  // Pinned facts. A drift here is a real change in the mod, not test noise.
  assert.equal(first.events.length, 11)
  assert.equal(new Set(first.events.map((event) => event.name)).size, 9)
  assert.equal(first.calls.length, 25)
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
