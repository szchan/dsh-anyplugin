import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SUBMIT_KIND,
  probeColonSeam,
  registerCommands,
} from '../src/index.ts'

/** The harness as it ships today: `dsh-commands` rejects anything outside /^[a-z][a-z0-9_-]*$/. */
function strictRegistry() {
  const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
  const registered = new Map()
  return {
    registered,
    register(definition) {
      if (!COMMAND_NAME.test(definition.name)) {
        throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`)
      }
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
}

/** The same registry with the colon seam landed (the shape we are asking for). */
function seamedRegistry() {
  const COMMAND_NAME = /^[a-z][a-z0-9_:-]*$/u
  const registered = new Map()
  return {
    registered,
    register(definition) {
      if (!COMMAND_NAME.test(definition.name)) {
        throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`)
      }
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
}

const command = {
  name: 'review:deep',
  description: 'Review a change in depth.',
  content: 'Review $ARGUMENTS carefully.',
  argumentHint: '[path]',
  sourcePath: 'fixtures/claude-commands-flat/commands/review.md',
}

test('today: the harness rejects the colon name and the rejection is reported, not thrown', () => {
  const registry = strictRegistry()
  const outcome = registerCommands(registry, [command])
  assert.deepEqual(outcome.registered, [])
  assert.equal(outcome.rejected.length, 1)
  assert.equal(outcome.rejected[0].name, 'review:deep')
  assert.match(outcome.rejected[0].error, /must match/)
  assert.equal(registry.registered.size, 0)
})

test('with the seam: the exact upstream name is registered', () => {
  const registry = seamedRegistry()
  const outcome = registerCommands(registry, [command])
  assert.deepEqual(outcome.registered, ['review:deep'])
  assert.ok(registry.registered.has('review:deep'))
})

test('with the seam: the handler submits the expanded template as the next message', () => {
  const registry = seamedRegistry()
  registerCommands(registry, [command])
  const result = registry.registered.get('review:deep').handler({ rawInput: 'src/index.ts' })
  assert.equal(result.kind, SUBMIT_KIND)
  assert.equal(result.text, 'Review src/index.ts carefully.')
})

test('the argument hint becomes the command input hint', () => {
  const registry = seamedRegistry()
  registerCommands(registry, [command])
  assert.deepEqual(registry.registered.get('review:deep').input, { hint: '[path]' })
})

test('probeColonSeam reports the harness, and leaves nothing registered behind', () => {
  const strict = strictRegistry()
  const refused = probeColonSeam(strict)
  assert.equal(refused.supported, false)
  assert.match(refused.error, /must match/)

  const seamed = seamedRegistry()
  assert.deepEqual(probeColonSeam(seamed), { supported: true })
  assert.equal(seamed.registered.size, 0)
})

test('apply logs one line per rejection and never throws', () => {
  const warnings = []
  const ctx = { commands: strictRegistry(), logger: { warn: (line) => warnings.push(line) } }
  // apply is imported lazily so this test does not depend on the local registry shape.
  return import('../src/index.ts').then(({ apply }) => {
    apply(ctx, { commands: [command] })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /review:deep/)
    assert.match(warnings[0], /D10/)
  })
})
