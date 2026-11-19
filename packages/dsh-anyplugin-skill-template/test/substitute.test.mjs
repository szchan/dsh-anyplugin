import assert from 'node:assert/strict'
import { test } from 'node:test'

import { splitSkillArguments, substituteSkillArguments } from '../src/index.ts'

test('the recorded trace: a named placeholder expands to the argument', () => {
  // fixtures/claude-skills-only/skills/greet/SKILL.md is `Greet $name.` with
  // `arguments: [name]`; the 2.1.322 trace shows the model receiving
  // "Greet Ada." — this is that line, byte for byte.
  const rendered = substituteSkillArguments('Greet $name.\n', { names: ['name'], raw: 'Ada' })
  assert.equal(rendered.text, 'Greet Ada.\n')
  assert.deepEqual(rendered.used, { arguments: false, indexed: false, named: true })
  assert.equal(rendered.appended, false)
})

test('$ARGUMENTS receives the whole string as typed', () => {
  const rendered = substituteSkillArguments('Deploy $ARGUMENTS to production:', {
    raw: 'v1.2 "us west"',
  })
  assert.equal(rendered.text, 'Deploy v1.2 "us west" to production:')
  assert.equal(rendered.used.arguments, true)
})

test('indexed forms are zero-based, unlike commands', () => {
  const body = 'Migrate the $0 component from $1 to $2.'
  const rendered = substituteSkillArguments(body, { raw: 'SearchBar JavaScript TypeScript' })
  assert.equal(rendered.text, 'Migrate the SearchBar component from JavaScript to TypeScript.')
})

test('$ARGUMENTS[N] and $N address the same position', () => {
  const rendered = substituteSkillArguments('$ARGUMENTS[1] then $1', { raw: 'a b' })
  assert.equal(rendered.text, 'b then b')
})

test('an indexed placeholder with no argument stays literal', () => {
  const rendered = substituteSkillArguments('From $1 to $2', { raw: 'a b' })
  assert.equal(rendered.text, 'From b to $2')
  assert.equal(rendered.used.indexed, true)
})

test('a named placeholder with no argument expands to empty and counts as used', () => {
  const rendered = substituteSkillArguments('Fix issue $issue.', { names: ['issue'] })
  assert.equal(rendered.text, 'Fix issue .')
  assert.equal(rendered.used.named, true)
  assert.equal(rendered.appended, false)
})

test('with no placeholder receiving an argument, the trailer carries the text', () => {
  const rendered = substituteSkillArguments('Fix the bug.\n', { raw: 'issue 42' })
  assert.equal(rendered.text, 'Fix the bug.\n\nARGUMENTS: issue 42')
  assert.equal(rendered.appended, true)
})

test('no arguments leaves a placeholder-free body untouched', () => {
  const body = 'Just instructions.\n'
  const rendered = substituteSkillArguments(body, { names: ['issue'] })
  assert.equal(rendered.text, body)
  assert.equal(rendered.appended, false)
})

test('a single backslash escapes the placeholder and is dropped', () => {
  const rendered = substituteSkillArguments('Costs \\$1.00 now')
  assert.equal(rendered.text, 'Costs $1.00 now')
})

test('a doubled backslash stays and the placeholder still expands', () => {
  // $0 is the first argument: skill indices are zero-based.
  const rendered = substituteSkillArguments('Path \\\\$0 here', { raw: 'x' })
  assert.equal(rendered.text, 'Path \\\\x here')
})

test('an undeclared $name is literal text, not a placeholder', () => {
  const rendered = substituteSkillArguments('Price is $usd', { names: [], raw: 'x' })
  assert.equal(rendered.text, 'Price is $usd\n\nARGUMENTS: x')
  assert.equal(rendered.appended, true)
})

test('an inserted value is not re-expanded', () => {
  const rendered = substituteSkillArguments('Summarize $0', { raw: '"$ARGUMENTS from yesterday"' })
  assert.equal(rendered.text, 'Summarize $ARGUMENTS from yesterday')
})

test('argument splitting keeps quoted groups and empty strings', () => {
  assert.deepEqual(splitSkillArguments('a "b c" \'d e\' ""'), ['a', 'b c', 'd e', ''])
})
