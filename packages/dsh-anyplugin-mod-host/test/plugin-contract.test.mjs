import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadMod } from '../src/index.ts'

const ROOT = fileURLToPath(new URL('../../../fixtures/mods/contract/', import.meta.url))
const REQUIRED = fileURLToPath(new URL('../../../fixtures/mods/contract-required/', import.meta.url))

/** Cross-realm values compare as plain data, not as vm objects. */
const plain = (value) => JSON.parse(JSON.stringify(value))

async function load(entry, options = {}) {
  const reports = []
  const dollars = []
  const host = {
    dollar() {
      const namespace = {
        report(value) {
          reports.push(value)
        },
      }
      dollars.push(namespace)
      return namespace
    },
  }
  const mod = await loadMod({ root: ROOT, entry, host, ...options })
  return { mod, reports, dollars, host }
}

async function rejectsWith(promise, code, ...needles) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'ModHostError', `expected ModHostError, got ${error.name}: ${error.message}`)
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    const message = String(error.message)
    for (const needle of needles) {
      assert.ok(message.includes(needle), `expected message to include ${JSON.stringify(needle)}: ${message}`)
    }
    return true
  })
}

test('Registration.catch receives the pinned HookFailure and a replay-safe next', async () => {
  const { mod, reports, dollars } = await load('hooks/catch.ts')
  assert.equal(mod.registrations.length, 1)
  assert.equal(mod.registrations[0].event, 'session.start')

  const result = await mod.registrations[0].handler({}, () => 'beneath')
  assert.deepEqual(plain(result), { caught: true })
  assert.equal(dollars.length, 2, 'the catch handler gets a $ of its own')
  assert.deepEqual(plain(reports), [
    {
      kind: 'throw',
      message: 'mod-authored boom',
      budget: 1_000,
      frozenError: true,
      calledBefore: true,
      calledAfter: true,
      replayed: 'beneath',
    },
  ])

  // The registration survives the caught failure: a second dispatch still
  // reaches the authored hook and its catch handler.
  const again = await mod.registrations[0].handler({}, () => 'beneath')
  assert.deepEqual(plain(again), { caught: true })
  assert.equal(reports.length, 2)
})

test('PluginOptions carries the manifest fields, frozen, at the pinned value kinds', async () => {
  const { mod, reports } = await load('hooks/options.ts')
  const result = await mod.registrations[0].handler({}, () => undefined)
  assert.deepEqual(plain(result), { ok: true })
  assert.deepEqual(plain(reports), [
    {
      keys: ['instructionFiles', 'retries', 'strict'],
      frozen: true,
      instructionFiles: 'claude-md-or-agents-md',
      instructionFilesType: 'string',
      retries: 3,
      retriesType: 'number',
      strict: false,
      strictType: 'boolean',
    },
  ])
})

test('PluginOptions takes the activation values and omits undeclared fields', async () => {
  // `unknownField` is stored by the loader but not declared by this manifest,
  // so it is not a member of the pinned PluginOptions object.
  const { mod, reports } = await load('hooks/options.ts', {
    pluginOptions: { instructionFiles: 'managed-only', retries: 7, strict: true, unknownField: 'nope' },
  })
  await mod.registrations[0].handler({}, () => undefined)
  const [report] = plain(reports)
  assert.deepEqual(report.keys, ['instructionFiles', 'retries', 'strict'])
  assert.equal(report.instructionFiles, 'managed-only')
  assert.equal(report.retries, 7)
  assert.equal(report.strict, true)
})

test('a stored string outside the declared options counts as unset, so the default applies', async () => {
  const { mod, reports } = await load('hooks/options.ts', {
    pluginOptions: { instructionFiles: 'outside-the-list' },
  })
  await mod.registrations[0].handler({}, () => undefined)
  assert.equal(plain(reports)[0].instructionFiles, 'claude-md-or-agents-md')
})

test('a wrong activation value refuses the load, naming the field and the value', async () => {
  await rejectsWith(
    load('hooks/options.ts', { pluginOptions: { retries: 'many' } }),
    'ERR_MOD_HOST_OPTIONS',
    'userConfig.retries',
    'activation value',
    '"many"',
  )
})

test('a required field with no value refuses the load, naming the field', async () => {
  await rejectsWith(
    loadMod({
      root: REQUIRED,
      entry: 'hooks/register.ts',
      host: { dollar: () => ({}) },
    }),
    'ERR_MOD_HOST_OPTIONS',
    'userConfig.channel',
    'required',
  )
})

test('a required field with a value loads', async () => {
  const mod = await loadMod({
    root: REQUIRED,
    entry: 'hooks/register.ts',
    host: { dollar: () => ({}) },
    pluginOptions: { channel: 'beta' },
  })
  assert.equal(mod.registrations.length, 1)
  assert.equal(mod.registrations[0].event, 'session.start')
})

test('.catch on engine.create is refused at registration time', async () => {
  await rejectsWith(load('hooks/refuse-engine.ts'), 'ERR_MOD_HOST_REGISTRATION', "engine.create", 'no budget')
})

test('a second .catch on one registration is refused at registration time', async () => {
  await rejectsWith(
    load('hooks/refuse-second.ts'),
    'ERR_MOD_HOST_REGISTRATION',
    "Registration.catch for 'session.start'",
    'one .catch',
  )
})

test('a non-function .catch is refused at registration time', async () => {
  await rejectsWith(load('hooks/refuse-nonfunction.ts'), 'ERR_MOD_HOST_REGISTRATION', 'requires a function')
})
