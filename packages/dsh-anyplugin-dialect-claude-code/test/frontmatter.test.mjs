// Frontmatter is shared by commands, skills, agents and output styles, so a
// parser bug silently changes every face. These tests pin the YAML subset the
// dialect claims: literal and folded block scalars, wrapped plain scalars, and
// a leading byte-order mark. They live with the dialect because that is where
// the parser lives; the output-style carry test only pins the style bodies.
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFrontmatter } from '../src/index.ts'

test('a folded scalar folds line breaks to spaces and keeps a paragraph break', () => {
  const parsed = parseFrontmatter(
    '---\ndescription: >\n  first line\n  second line\n\n  next para\n---\n\nBody.\n',
  )
  assert.equal(parsed.data.description, 'first line second line\nnext para')
})

test('a wrapped plain scalar keeps its continuation', () => {
  const parsed = parseFrontmatter('---\ndescription: first line\n  second line\n---\n\nBody.\n')
  assert.equal(parsed.data.description, 'first line second line')
})

test('a literal block keeps its line breaks and |- drops the trailing newline', () => {
  const literal = parseFrontmatter('---\ndescription: |\n  one\n  two\n---\n\nBody.\n')
  assert.equal(literal.data.description, 'one\ntwo')
  const stripped = parseFrontmatter('---\ndescription: |-\n  one\n  two\n---\n\nBody.\n')
  assert.equal(stripped.data.description, 'one\ntwo')
})

test('a byte-order mark before the opening fence is not read as body text', () => {
  const parsed = parseFrontmatter('\uFEFF---\nname: x\n---\n\nBody.\n')
  assert.equal(parsed.data.name, 'x')
  assert.equal(parsed.body, '\nBody.\n')
})

test('CRLF frontmatter parses and the body keeps its bytes', () => {
  const parsed = parseFrontmatter('---\r\nname: x\r\n---\r\n\r\nBody CRLF\r\n')
  assert.equal(parsed.data.name, 'x')
  assert.equal(parsed.body, '\r\nBody CRLF\r\n')
})
