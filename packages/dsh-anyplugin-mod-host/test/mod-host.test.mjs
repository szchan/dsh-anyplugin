import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadMod, resolveModSpecifier } from '../src/index.ts'
import { FRAGMENT } from '../src/jsx.ts'

const ROOT = fileURLToPath(new URL('../../../fixtures/mods/synthetic/', import.meta.url))
const REGISTER = join(ROOT, 'register.ts')
const ASK_INDEX = join(ROOT, 'ask', 'index.ts')

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * A host whose `$` records the authored call order. `usage` defaults to the
 * upstream shape; pass `{ usage: undefined }` to exercise the clock.now path.
 */
function recorder(options = {}) {
  const usage = Object.hasOwn(options, 'usage') ? options.usage : { startedAt: 1700000000000 }
  const calls = []
  const commands = []
  let built = 0
  // A fresh object per dollar() call: the host may not cache, clone or freeze
  // it, but it also cannot make a reusing host fresh. Reuse is this fixture's
  // job to expose, so each call builds a new namespace.
  const makeDollar = () => {
    built += 1
    return {
      session: {
        usage: async () => {
          calls.push('session.usage')
          return usage
        },
        messages: async () => {
          calls.push('session.messages')
          return []
        },
        flush: async () => {
          calls.push('flush')
        },
      },
      clock: {
        now: async () => {
          calls.push('clock.now')
          return 1700000000001
        },
      },
      command: {
        register: async (spec) => {
          calls.push('command.register')
          commands.push(spec)
        },
      },
    }
  }
  return {
    calls,
    commands,
    built: () => built,
    host: { dollar: makeDollar },
  }
}

/** Assert a rejection is a ModHostError with `code`, and optionally substrings. */
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

async function loadFixture(entry, host = recorder().host) {
  return loadMod({ root: ROOT, entry, host })
}

// ---------------------------------------------------------------------------
// Hermetic mod: authored graph, controlled on(), per-handler $, no rewriting.
// ---------------------------------------------------------------------------

test('fires session.start as usage → command.register → session.messages', async () => {
  const before = new Map(
    [REGISTER, ASK_INDEX, join(ROOT, 'value.ts')].map((file) => [file, sha256(file)]),
  )
  const recorderHost = recorder()
  const mod = await loadFixture('register.ts', recorderHost.host)

  assert.equal(mod.registrations.length, 1)
  const registration = mod.registrations[0]
  assert.equal(registration.event, 'session.start')
  assert.equal(registration.matcher, undefined)
  assert.equal(typeof registration.handler, 'function')
  assert.ok(Object.isFrozen(mod.registrations))
  assert.ok(Object.isFrozen(registration))

  // D30: $ exists only as the handler's first argument, built per invocation.
  assert.equal(recorderHost.built(), 0, 'host.dollar must not run at load time')
  assert.deepEqual(recorderHost.calls, [])

  const event = { kind: 'start', sessionId: 'abc' }
  const nextResult = { kind: 'continued' }
  const result = await registration.handler(event, (seen) => {
    assert.equal(seen, event)
    return nextResult
  })
  assert.equal(result, nextResult, 'the handler must return next(e) unchanged')
  assert.equal(recorderHost.built(), 1)
  assert.deepEqual(recorderHost.calls, ['session.usage', 'command.register', 'session.messages'])

  // The three imports (directory-index, '.' self, .js→.ts) reached register().
  assert.equal(recorderHost.commands.length, 1)
  assert.equal(recorderHost.commands[0].name, 'diff')
  assert.equal(
    recorderHost.commands[0].description,
    'value-from-js-specifier:42:42:1700000000000',
  )

  await registration.handler(event, () => nextResult)
  assert.equal(recorderHost.built(), 2, 'each invocation gets a fresh $')

  // The host reads the authored bytes; it never writes them.
  for (const [file, digest] of before) {
    assert.equal(sha256(file), digest, `${file} must keep its authored bytes`)
  }

  const evaluation = mod.evaluate()
  assert.equal(await evaluation, undefined)
  assert.equal(await mod.evaluate(), undefined, 'evaluate() never re-runs the mod')

  mod.dispose()
  mod.dispose()
  await assert.rejects(mod.evaluate(), (error) => error.code === 'ERR_MOD_HOST_LINK')
  await assert.rejects(registration.handler(event, () => nextResult), (error) => {
    return error.code === 'ERR_MOD_HOST_LINK'
  })
})

test('each invocation gets its own $; a mutation does not leak to the next handler', async () => {
  const recorderHost = recorder()
  const mod = await loadFixture('mutation.ts', recorderHost.host)

  assert.equal(mod.registrations.length, 2)
  const [first, second] = mod.registrations
  assert.equal(first.event, 'first')
  assert.equal(second.event, 'second')

  assert.equal(await first.handler({}, () => {}), undefined)
  assert.equal(
    await second.handler({}, () => {}),
    undefined,
    'the second handler observed the first handler\'s $ mutation: the host reused a namespace',
  )
  assert.equal(recorderHost.built(), 2, 'one dollar() call per handler invocation')
})

test('falls back to clock.now when usage() returns undefined', async () => {
  const recorderHost = recorder({ usage: undefined })
  const mod = await loadFixture('register.ts', recorderHost.host)
  const event = { kind: 'start' }
  const nextResult = { kind: 'continued' }

  assert.equal(await mod.registrations[0].handler(event, () => nextResult), nextResult)
  assert.deepEqual(recorderHost.calls, [
    'session.usage',
    'clock.now',
    'command.register',
    'session.messages',
  ])
  assert.equal(
    recorderHost.commands[0].description,
    'value-from-js-specifier:42:42:1700000000001',
  )
})

test('resolveModSpecifier implements the D30/D39 behaviors in candidate order', () => {
  assert.deepEqual(resolveModSpecifier({ specifier: '.', parent: ASK_INDEX, root: ROOT }), {
    file: ASK_INDEX,
    behavior: 'directory-index',
  })
  assert.deepEqual(resolveModSpecifier({ specifier: './ask', parent: REGISTER, root: ROOT }), {
    file: ASK_INDEX,
    behavior: 'directory-index',
  })
  assert.deepEqual(resolveModSpecifier({ specifier: './value.js', parent: REGISTER, root: ROOT }), {
    file: join(ROOT, 'value.ts'),
    behavior: 'js-to-ts',
  })
  assert.deepEqual(
    resolveModSpecifier({ specifier: './view.jsx', parent: join(ROOT, 'jsx-reach.ts'), root: ROOT }),
    { file: join(ROOT, 'view.tsx'), behavior: 'jsx-to-tsx' },
  )
})

test('an extensionless import tries the file form before the directory form', () => {
  // Both exist under order-choice/; Node's order says the file wins. The
  // directory form is not shadowed today only because the pinned
  // `mods/diff/hooks/views/` has no sibling `views.ts(x)`; this fixture pins
  // the order before such a file can appear.
  assert.deepEqual(
    resolveModSpecifier({
      specifier: './order-choice/thing',
      parent: REGISTER,
      root: ROOT,
    }),
    { file: join(ROOT, 'order-choice', 'thing.ts'), behavior: 'extensionless-file' },
  )
  assert.deepEqual(
    resolveModSpecifier({ specifier: './order-tsx/only', parent: REGISTER, root: ROOT }),
    { file: join(ROOT, 'order-tsx', 'only.tsx'), behavior: 'extensionless-file' },
  )
  assert.deepEqual(
    resolveModSpecifier({
      specifier: './order-index-tsx/only',
      parent: REGISTER,
      root: ROOT,
    }),
    { file: join(ROOT, 'order-index-tsx', 'only', 'index.tsx'), behavior: 'directory-index' },
  )
})

test('resolveModSpecifier fails loudly for every specifier outside the three rules', () => {
  const cases = [
    ['node:fs', 'ERR_MOD_HOST_LINK', 'Node builtin'],
    ['claude-code', 'ERR_MOD_HOST_LINK', 'bare'],
    ['https://example.com/mod.ts', 'ERR_MOD_HOST_LINK', 'URL'],
    ['./nowhere.js', 'ERR_MOD_HOST_MISSING', 'does not exist'],
    ['./data.json', 'ERR_MOD_HOST_UNSUPPORTED_EXT', '.json'],
    ['../outside', 'ERR_MOD_HOST_LINK', 'outside the mod root'],
    ['', 'ERR_MOD_HOST_LINK', 'empty'],
    ['./view.tsx', 'ERR_MOD_HOST_TSX', '.tsx'],
  ]
  for (const [specifier, code, needle] of cases) {
    assert.throws(
      () => resolveModSpecifier({ specifier, parent: REGISTER, root: ROOT }),
      (error) => {
        assert.equal(error.code, code, `${specifier}: ${error.message}`)
        assert.ok(error.message.includes(needle), `${specifier}: ${error.message}`)
        return true
      },
    )
  }
})

// ---------------------------------------------------------------------------
// Loud failures: each surface names its reason (no silent skips).
// ---------------------------------------------------------------------------

test('a missing relative module fails at link time with the specifier and expected file', async () => {
  await rejectsWith(
    loadFixture('missing-module.ts'),
    'ERR_MOD_HOST_MISSING',
    './nowhere.js',
    'does not exist',
  )
})

test('a link-time missing export is ERR_MOD_HOST_LINK, not a raw SyntaxError', async () => {
  await rejectsWith(
    loadFixture('bad-export.ts'),
    'ERR_MOD_HOST_LINK',
    "does not provide an export named 'nope'",
    'bad-export.ts',
  )
})

test('a minimal .tsx graph loads and its handler builds an h() descriptor', async () => {
  const view = join(ROOT, 'view.tsx')
  const before = sha256(view)
  const mod = await loadFixture('jsx-reach.ts')
  assert.equal(mod.registrations.length, 1)
  assert.equal(mod.registrations[0].event, 'ui.render')

  const element = await mod.registrations[0].handler({}, () => undefined)
  assert.deepEqual(element, { type: 'div', props: null, children: [7] })
  assert.equal(sha256(view), before, 'the transform is in memory; it must not rewrite the authored file')
})

test('fragment syntax becomes a Fragment descriptor, not a string', async () => {
  const mod = await loadFixture('fragment.tsx')
  const element = await mod.registrations[0].handler({}, () => undefined)
  assert.equal(element.type, FRAGMENT)
  assert.deepEqual(element.children, ['a', 'b'])
})

test('a .tsx module without the classic pragma is a typed refusal naming the file', async () => {
  await rejectsWith(
    loadFixture('view-no-pragma.tsx'),
    'ERR_MOD_HOST_TSX',
    'view-no-pragma.tsx',
    'leading comment block',
    '@jsx h',
  )
})

test('a .tsx module with a foreign @jsx pragma is a typed refusal naming the file', async () => {
  await rejectsWith(
    loadFixture('view-foreign-pragma.tsx'),
    'ERR_MOD_HOST_TSX',
    'view-foreign-pragma.tsx',
    '@jsx h2',
  )
})

test('a .tsx module with a non-classic runtime is a typed refusal naming the file', async () => {
  await rejectsWith(
    loadFixture('view-automatic-runtime.tsx'),
    'ERR_MOD_HOST_TSX',
    'view-automatic-runtime.tsx',
    '@jsxRuntime automatic',
  )
})

test('a pragma after the leading comment block is not a file pragma', async () => {
  await rejectsWith(
    loadFixture('view-late-pragma.tsx'),
    'ERR_MOD_HOST_TSX',
    'view-late-pragma.tsx',
    'leading comment block',
  )
})

test('a .tsx module with a foreign @jsxFrag is a typed refusal naming the file', async () => {
  await rejectsWith(
    loadFixture('view-foreign-fragment.tsx'),
    'ERR_MOD_HOST_TSX',
    'view-foreign-fragment.tsx',
    '@jsxFrag div',
  )
})

test('an unknown extension is a typed error naming the extension', async () => {
  await rejectsWith(loadFixture('unknown-ext.txt'), 'ERR_MOD_HOST_UNSUPPORTED_EXT', '.txt')
})

test('an entry without register(on) is a typed error', async () => {
  await rejectsWith(loadFixture('no-register.ts'), 'ERR_MOD_HOST_LINK', "'register'")
})

test('misused on() is a typed error naming the argument', async () => {
  await rejectsWith(loadFixture('bad-on.ts'), 'ERR_MOD_HOST_LINK', 'non-empty string')
})

test('an authored throw is not wrapped: the mod keeps its own error', async () => {
  await assert.rejects(loadFixture('register-throws.ts'), (error) => {
    assert.equal(error.message, 'authored register boom')
    assert.equal(error.name, 'Error')
    assert.equal(error.code, undefined, 'the host must not rebrand authored errors')
    return true
  })
})

test('a module-level $ read is a ReferenceError, not a host error', async () => {
  await assert.rejects(loadFixture('dollar-at-load.ts'), (error) => {
    assert.equal(error.name, 'ReferenceError')
    assert.match(String(error.message), /\$/)
    assert.equal(error.code, undefined)
    return true
  })
})

test('the vm realm has no process, URL or $ global', async () => {
  const mod = await loadFixture('globals.ts')
  const seen = await mod.registrations[0].handler(null, () => {
    throw new Error('this handler does not call next')
  })
  assert.equal(seen.process, 'undefined')
  assert.equal(seen.url, 'undefined')
  assert.equal(seen.dollar, 'undefined')
})

test('register(on) preserves event order and matcher values', async () => {
  const mod = await loadFixture('order.ts')
  assert.deepEqual(
    mod.registrations.map((registration) => [registration.event, registration.matcher]),
    [
      ['first', undefined],
      ['second', 'matcher-value'],
    ],
  )
})

test('.js and .mjs entries load as authored and receive $', async () => {
  const nextResult = { kind: 'continued' }
  const js = await loadFixture('plain.js')
  assert.equal(await js.registrations[0].handler(null, () => nextResult), nextResult)

  const recorderHost = recorder()
  const mjs = await loadFixture('plain.mjs', recorderHost.host)
  assert.equal(await mjs.registrations[0].handler(null, () => nextResult), nextResult)
  assert.deepEqual(recorderHost.calls, ['flush'])
})

test('evaluate() is an idempotent accessor, not a second evaluation', async () => {
  const mod = await loadFixture('evaluates-once.ts')
  const [registration] = mod.registrations
  const seen = await registration.handler(null, () => null)
  assert.equal(seen, 1, 'the module evaluated exactly once')
  await mod.evaluate()
  await mod.evaluate()
  assert.equal(await registration.handler(null, () => null), 1)
})

// ---------------------------------------------------------------------------
// Load-surface validation.
// ---------------------------------------------------------------------------

test('bad load surfaces are typed errors with reasons', async () => {
  await rejectsWith(
    loadMod({ root: join(ROOT, 'does-not-exist'), entry: 'register.ts', host: recorder().host }),
    'ERR_MOD_HOST_MISSING',
  )
  await rejectsWith(loadFixture('no-such-entry.ts'), 'ERR_MOD_HOST_MISSING', 'does not exist')
  await rejectsWith(loadFixture('../outside.ts'), 'ERR_MOD_HOST_MISSING', 'outside')
  await rejectsWith(loadFixture(REGISTER), 'ERR_MOD_HOST_MISSING', 'relative')
  await rejectsWith(loadMod({ root: ROOT, entry: 'register.ts', host: {} }), 'ERR_MOD_HOST_LINK')
})

test('without --experimental-vm-modules the host refuses before touching the mod', async () => {
  const index = new URL('../src/index.ts', import.meta.url).href
  const script = [
    `import { loadMod } from ${JSON.stringify(index)}`,
    'try { await loadMod({}) } catch (error) { console.log(error.code) }',
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), 'ERR_MOD_HOST_LINK')
})

// ---------------------------------------------------------------------------
// D52 (M4): the linker is bounded by the granted set, and the snapshot bytes —
// not whatever is on disk — are what evaluates.
// ---------------------------------------------------------------------------

test('an import outside the granted file set is refused before it is created', async () => {
  await rejectsWith(
    loadMod({ root: ROOT, entry: 'register.ts', host: recorder().host, files: ['register.ts'] }),
    'ERR_MOD_HOST_UNGRANTED',
    'which the grant does not pin',
  )
})

test('loadMod evaluates the snapshot bytes, never re-opening the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-snapshot-'))
  try {
    writeFileSync(
      join(dir, 'register.ts'),
      "export function register(on) { on('turn.complete', async () => {}) }\n",
    )
    // The map says session.start; the file on disk says turn.complete. A loader
    // that re-read the path would seat turn.complete.
    const sources = new Map([
      ['register.ts', "export function register(on) { on('session.start', async () => {}) }\n"],
    ])
    const loaded = await loadMod({
      root: dir,
      entry: 'register.ts',
      host: recorder().host,
      files: ['register.ts'],
      sources,
    })
    assert.deepEqual(
      loaded.registrations.map((registration) => registration.event),
      ['session.start'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
