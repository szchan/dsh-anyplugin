// The scanner's contract. Every test is written so it fails when the scanner
// stops proving what it claims: a missing literal site, a changed matcher, a
// wrong line, or a dynamic site silently dropped.

import assert from 'node:assert/strict'
import test from 'node:test'

import { SCAN_CAVEAT, capabilityList, scanModSource } from '../src/index.ts'

const scan = (source) => scanModSource(source, { file: 'fixture.ts' })

test('records a literal event, its matcher and a direct $ call', () => {
  const source = [
    'export function register(on, $) {',
    "  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {",
    '    await $.fs.read(event.path)',
    '    return next()',
    '  })',
    '}',
  ].join('\n')

  const result = scan(source)
  assert.deepEqual(result.events, [{ name: 'tool.call', matcher: "{ tool: 'Bash' }", line: 2 }])
  assert.deepEqual(result.calls, [{ namespace: 'fs', method: 'read', line: 3 }])
  assert.deepEqual(result.dynamic, [])
})

test('records a multi-line on call at the line of on and keeps the matcher raw', () => {
  const source = [
    'on(',
    "  'tool.call',",
    '  { tool: [...Tools.EDITING_TOOLS, ...Tools.SHELL_TOOLS] },',
    '  handler,',
    ')',
  ].join('\n')

  const result = scan(source)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].line, 1)
  assert.equal(result.events[0].name, 'tool.call')
  assert.equal(result.events[0].matcher, '{ tool: [...Tools.EDITING_TOOLS, ...Tools.SHELL_TOOLS] }')
})

test('reports a non-literal event under dynamic instead of dropping it', () => {
  const source = ["const name = 'tool.call'", 'on(name, handler)'].join('\n')

  const result = scan(source)
  assert.deepEqual(result.events, [])
  assert.equal(result.dynamic.length, 1)
  assert.equal(result.dynamic[0].line, 2)
  assert.match(result.dynamic[0].reason, /event name is an identifier/)
})

test('reports a template-literal event under dynamic', () => {
  const source = 'on(`tool.${suffix}`, handler)'

  const result = scan(source)
  assert.deepEqual(result.events, [])
  assert.equal(result.dynamic.length, 1)
  assert.equal(result.dynamic[0].line, 1)
  assert.match(result.dynamic[0].reason, /template literal with an interpolation/)
})

test('reports computed namespace and method access under dynamic', () => {
  const source = ['$(namespace)', '$[namespace].read()', '$?.[namespace].read()', '$.fs[method]()'].join('\n')

  const result = scan(source)
  assert.deepEqual(result.calls, [])
  assert.equal(result.dynamic.length, 4)
  assert.match(result.dynamic[0].reason, /call of \$ itself/)
  assert.match(result.dynamic[1].reason, /computed namespace/)
  assert.match(result.dynamic[2].reason, /computed namespace/)
  assert.match(result.dynamic[3].reason, /computed method name on \$\.fs/)
})

test('records an on call and a $ call through optional chaining or generics', () => {
  const source = [
    "$?.fs.read('a')",
    "$.fs?.read('b')",
    "$.fs.read?.('c')",
    "on?.('tool.call', handler)",
    "on<T>('tool.call', handler)",
  ].join('\n')

  const result = scan(source)
  assert.deepEqual(result.events, [
    { name: 'tool.call', line: 4 },
    { name: 'tool.call', line: 5 },
  ])
  assert.deepEqual(result.calls, [
    { namespace: 'fs', method: 'read', line: 1 },
    { namespace: 'fs', method: 'read', line: 2 },
    { namespace: 'fs', method: 'read', line: 3 },
  ])
  assert.deepEqual(result.dynamic, [])
})

test('records a call whose namespace and method are on different lines', () => {
  const source = ['$.session', '  .usage()'].join('\n')

  const result = scan(source)
  assert.deepEqual(result.calls, [{ namespace: 'session', method: 'usage', line: 1 }])
  assert.deepEqual(result.dynamic, [])
})

test('reports optional computed method access under dynamic', () => {
  const result = scan("$.fs?.[method]('x')")

  assert.deepEqual(result.calls, [])
  assert.equal(result.dynamic.length, 1)
  assert.match(result.dynamic[0].reason, /computed method name on \$\.fs/)
})

test('deduplicates and sorts only in the capability list', () => {
  const source = [
    "on('ui.render', handler)",
    "on('command.run', handler)",
    "on('ui.render', handler)",
    "$.ui.open('pane')",
    "$.env.get('HOME')",
    "$.ui.open('other')",
  ].join('\n')

  const result = scan(source)
  assert.equal(result.events.length, 3)
  assert.equal(result.calls.length, 3)
  assert.deepEqual(capabilityList(result), [
    'hooks: command.run, ui.render',
    'calls: env.get, ui.open',
  ])
})

test('ignores comments, strings and regular expression literals', () => {
  const source = [
    "// on('ghost', handler)",
    '/* $.fs.read() */',
    'const text = "on(\'ghost\') and $.fs.read()"',
    String.raw`const re = /on\('ghost'\)/`,
    "on('real', handler)",
  ].join('\n')

  const result = scan(source)
  assert.deepEqual(result.events.map((event) => event.name), ['real'])
  assert.deepEqual(result.calls, [])
})

test('accepts any literal event name instead of imposing a vocabulary', () => {
  const result = scan("on('classic.*', handler)")
  assert.deepEqual(result.events, [{ name: 'classic.*', line: 1 }])
})

test('does not treat member calls or function declarations as on', () => {
  const source = ["registry.on('not-a-mod-event', handler)", 'function on(event, handler) {}'].join('\n')

  const result = scan(source)
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.dynamic, [])
})

test('does not treat $ used as a parameter as a capability call', () => {
  const source = ["on('tool.call', async ($, event, next) => {", '  return next()', '})'].join('\n')

  const result = scan(source)
  assert.equal(result.events.length, 1)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.dynamic, [])
})

test('reports template interpolations the lexical scan does not descend into', () => {
  const source = "on('tool.call', `run ${$.process.run(argv)}`, handler)"

  const result = scan(source)
  assert.equal(result.events.length, 1)
  assert.ok(
    result.dynamic.some((site) => site.line === 1 && /template interpolation/.test(site.reason)),
    'a capability-shaped interpolation must be reported, not silently skipped',
  )
})

test('carries the file it was asked to scan and states the scan limits', () => {
  const result = scanModSource('', { file: 'mods/example.ts' })

  assert.equal(result.file, 'mods/example.ts')
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.dynamic, [])
  assert.deepEqual(capabilityList(result), ['hooks:', 'calls:'])
  assert.match(SCAN_CAVEAT, /Aliases, imported helpers/)
  assert.match(SCAN_CAVEAT, /eval\/new Function/)
  assert.match(SCAN_CAVEAT, /unrecognised syntax/)
})

test('validates its inputs', () => {
  assert.throws(() => scanModSource(42, { file: 'x.ts' }), /source must be a string/)
  assert.throws(() => scanModSource('on(1)', {}), /options\.file must be a non-empty string/)
  assert.throws(() => scanModSource('on(1)', { file: '   ' }), /options\.file must be a non-empty string/)
})
