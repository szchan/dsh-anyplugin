import assert from 'node:assert/strict'
import { test } from 'node:test'

import { expandCommandTemplate, splitArguments } from '../src/index.ts'

test('splitArguments: whitespace, quotes, escapes, empty tokens', () => {
  assert.deepEqual(splitArguments('a  b\tc'), ['a', 'b', 'c'])
  assert.deepEqual(splitArguments('"a b" c'), ['a b', 'c'])
  assert.deepEqual(splitArguments("'a b' c"), ['a b', 'c'])
  assert.deepEqual(splitArguments('a\\ b c'), ['a b', 'c'])
  assert.deepEqual(splitArguments('a "" b'), ['a', '', 'b'])
  assert.deepEqual(splitArguments(''), [])
  assert.deepEqual(splitArguments('   '), [])
})

test('$ARGUMENTS is replaced by the trimmed argument string', () => {
  const { text, used, args } = expandCommandTemplate('Review $ARGUMENTS carefully.\n', '  the diff  ')
  assert.equal(text, 'Review the diff carefully.\n')
  assert.equal(used, 'arguments')
  assert.equal(args, 'the diff')
})

test('$ARGUMENTS is replaced everywhere, including code fences', () => {
  const { text } = expandCommandTemplate('```\ngit log $ARGUMENTS\n```\nand $ARGUMENTS', 'HEAD~1')
  assert.equal(text, '```\ngit log HEAD~1\n```\nand HEAD~1')
})

test('positionals map $1..$9 and record the ones the caller omitted', () => {
  const { text, used, missing } = expandCommandTemplate('cp $1 $2 $3', 'a b')
  assert.equal(text, 'cp a b ')
  assert.equal(used, 'positional')
  assert.deepEqual(missing, ['$3'])
})

test('a body with no placeholder appends the arguments after a blank line', () => {
  const { text, used } = expandCommandTemplate('Summarize the branch.\n', 'main')
  assert.equal(text, 'Summarize the branch.\n\nmain')
  assert.equal(used, 'none')
})

test('a body with no placeholder and no arguments is left untouched', () => {
  const { text, used } = expandCommandTemplate('Summarize the branch.\n', '   ')
  assert.equal(text, 'Summarize the branch.\n')
  assert.equal(used, 'none')
})

test('both placeholder families are reported as both', () => {
  const { text, used } = expandCommandTemplate('$1 then $ARGUMENTS', 'x y z')
  assert.equal(text, 'x then x y z')
  assert.equal(used, 'both')
})
