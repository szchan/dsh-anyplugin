// The served mod type surface (#144): `types/mod.d.ts` is generated from the
// pinned declaration and the mod ledger, so it states only what the host
// serves, and states it in the pin's own words.
//
// The test never rewrites the committed file: it regenerates into a temp
// directory and compares. A skip here would report "0 skipped" while checking
// nothing (D22/D24), so a missing pin fails with the fetch instruction instead.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ledgerPath, matchingIndex, parseDeclaration, parseMembers, readDeclaration } from '../../../scripts/mod-coverage.mjs'
import { renderModTypes, typesPath } from '../../../scripts/gen-mod-types.mjs'

const generator = fileURLToPath(new URL('../../../scripts/gen-mod-types.mjs', import.meta.url))
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
const committed = readFileSync(typesPath, 'utf8')

/** The body between an exported interface's braces, with its bracket indexes. */
const interfaceBody = (text, name) => {
  const marker = `export interface ${name} {`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `missing exported interface ${name}`)
  const open = start + marker.length - 1
  const close = matchingIndex(text, open)
  assert.notEqual(close, -1, `unterminated interface ${name}`)
  return { body: text.slice(open + 1, close), start: open, end: close }
}

/** `Map<namespace, Set<member>>` as `ModDollar` declares them. */
const declaredNamespaces = (text) => {
  const { body } = interfaceBody(text, 'ModDollar')
  const namespaces = new Map()
  for (const member of parseMembers(`{${body}}`)) {
    assert.equal(member.kind, 'property', `ModDollar.${member.name} is not a namespace property`)
    assert.ok(member.type.startsWith('{'), `ModDollar.${member.name} is not an inline object type`)
    const members = parseMembers(member.type).filter((entry) => entry.name !== undefined)
    namespaces.set(member.name, new Set(members.map((entry) => entry.name)))
  }
  return namespaces
}

test('the committed types file is exactly what the generator renders', () => {
  assert.equal(committed, renderModTypes())
})

test('two generator runs in a temp directory are byte-identical and match the committed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-mod-types-'))
  const paths = [join(dir, 'first.d.ts'), join(dir, 'second.d.ts')]
  for (const out of paths) {
    execFileSync(process.execPath, [generator, '--out', out], { env: process.env, stdio: 'pipe' })
  }
  assert.equal(readFileSync(paths[0], 'utf8'), readFileSync(paths[1], 'utf8'))
  assert.equal(readFileSync(paths[0], 'utf8'), committed)
})

test('ModDollar declares exactly the served namespaces and members from the ledger', () => {
  const actual = declaredNamespaces(committed)
  const expected = new Map()
  for (const namespace of ledger.served.namespaces) expected.set(namespace, new Set())
  for (const entry of [...ledger.served.methods, ...ledger.served.properties]) {
    const dot = entry.indexOf('.')
    assert.notEqual(dot, -1, `${entry} is not a dotted member`)
    const namespace = entry.slice(0, dot)
    const member = entry.slice(dot + 1)
    assert.ok(expected.has(namespace), `ledger serves ${entry} but does not list namespace ${namespace}`)
    expected.get(namespace).add(member)
  }
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort())
  for (const [namespace, members] of expected) {
    assert.deepEqual([...actual.get(namespace)].sort(), [...members].sort(), `ModDollar.${namespace} is not the served set`)
  }
  assert.match(committed, /^ {4}cwd: \(\) => Promise<string>;$/m, '$.session.cwd is not the pin text (#138)')
})

test('no absent member or namespace is named anywhere in the file', () => {
  for (const name of [...ledger.absent.methods, ...ledger.absent.properties]) {
    assert.equal(committed.includes(name), false, `absent member ${name} appears in the generated file`)
  }
  for (const namespace of ledger.absent.namespaces) {
    assert.doesNotMatch(committed, new RegExp(`\\b${namespace}\\b`), `absent namespace ${namespace} appears in the generated file`)
  }
  // A bare member name inside its namespace block is only visible namespace by
  // namespace: `session.identity` never appears as a dotted string in the file.
  const declared = declaredNamespaces(committed)
  for (const name of [...ledger.absent.methods, ...ledger.absent.properties]) {
    const dot = name.indexOf('.')
    if (dot === -1) continue
    const namespace = name.slice(0, dot)
    const member = name.slice(dot + 1)
    if (!declared.has(namespace)) continue
    assert.equal(declared.get(namespace).has(member), false, `absent member ${name} is declared under ${namespace}`)
  }
})

test('every refused member is named once, only in the documented error union', () => {
  const { body, start, end } = interfaceBody(committed, 'ModRefusedMemberCodes')
  const actual = new Map()
  for (const match of body.matchAll(/^\s*'([^']+)':\s*'(ERR_MOD_HOST_[A-Z0-9_]+)';$/gm)) actual.set(match[1], match[2])
  const expected = new Map([...ledger.refused.methods, ...ledger.refused.properties].map((entry) => [entry.name, entry.code]))
  assert.deepEqual([...actual.entries()].sort(), [...expected.entries()].sort())

  for (const name of expected.keys()) {
    const count = committed.split(name).length - 1
    assert.equal(count, 1, `refused member ${name} occurs ${count} times; the union must name it exactly once`)
    assert.ok(committed.indexOf(name) > start && committed.indexOf(name) < end, `refused member ${name} appears outside the union`)
  }
  for (const namespace of ledger.refused.namespaces) {
    let index = committed.indexOf(namespace)
    while (index !== -1) {
      assert.ok(index > start && index < end, `refused namespace ${namespace} appears outside the union`)
      index = committed.indexOf(namespace, index + 1)
    }
  }
})

test('the header states the pin, the declaration hash, the ledger, and that the file is generated', () => {
  assert.ok(committed.includes(`claude-code ${ledger.pin.version}`), 'pin version missing')
  assert.ok(committed.includes(ledger.pin.commit), 'mods tree commit missing')
  assert.ok(committed.includes(ledger.pin.sha256), 'declaration sha256 missing')
  assert.ok(committed.includes(ledger.pin.bytes.toString()), 'declaration byte size missing')
  assert.ok(committed.includes('fixtures/mods/coverage.json'), 'ledger path missing')
  assert.ok(committed.includes('npm run gen:types'), 'generation command missing')
  assert.match(committed, /generated/i)
  assert.match(committed, /do not edit/i)
})

test('the imported helper types are all declarations in the pin', () => {
  const parsed = parseDeclaration(readDeclaration().text)
  const block = /^import type \{\n([\s\S]*?)\n\} from 'claude-code'$/m.exec(committed)
  assert.notEqual(block, null, 'the pinned import block is missing')
  const names = block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/,$/, ''))
  assert.ok(names.length > 0)
  for (const name of names) {
    assert.notEqual(parsed.declaration(name), undefined, `${name} is imported but not declared by the pin`)
  }
})

test('generation fails naming a served member the pin does not declare', () => {
  const mutated = structuredClone(ledger)
  mutated.served.methods.push('session.nope')
  assert.throws(() => renderModTypes({ ledger: mutated, verify: false }), /session\.nope/)
})

test('generation fails naming a member whose signature references an unknown type', () => {
  const declaration = readDeclaration()
  const text = declaration.text.replace('after: TimerCall;', 'after: MysteryCall;')
  assert.notEqual(text, declaration.text, 'the probe signature was not found in the pin')
  assert.throws(
    () => renderModTypes({ declaration: { ...declaration, text }, verify: false }),
    /clock\.after[\s\S]*MysteryCall|MysteryCall[\s\S]*clock\.after/,
  )
})

test('generation refuses a declaration that does not match the ledger pin', () => {
  const declaration = readDeclaration()
  const text = declaration.text.replace('cwd: () => Promise<string>;', 'cwd: () => string;')
  assert.notEqual(text, declaration.text, 'the probe signature was not found in the pin')
  assert.throws(() => renderModTypes({ declaration: { ...declaration, text } }), /ledger pin (?:bytes|sha256)/)
})
