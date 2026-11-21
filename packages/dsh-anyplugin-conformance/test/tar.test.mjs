// Direct tests for the tarball extractor. The marketplace fetch tests reach
// `extractTarball` through a url/npm install; this file pins the containment
// rules themselves, so mutating `safeSegments` reddens a test here even when
// the happy-path artifact still extracts.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { extractTarball, isGzip, TarError } from '../src/tar.ts'

const BLOCK = 512

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header(name, size, type) {
  const block = Buffer.alloc(BLOCK)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 8)
  block.write(octal(0, 8), 108, 8)
  block.write(octal(0, 8), 116, 8)
  block.write(octal(size, 12), 124, 12)
  block.write(octal(0, 12), 136, 12)
  block.fill(0x20, 148, 156)
  block.write(type, 156, 1, 'utf8')
  block.write('ustar\0', 257, 6, 'utf8')
  block.write('00', 263, 2, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return block
}

function padded(content) {
  const rest = content.length % BLOCK
  return rest === 0 ? content : Buffer.concat([content, Buffer.alloc(BLOCK - rest)])
}

function makeTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8')
    blocks.push(header(entry.name, content.length, entry.type ?? '0'))
    blocks.push(padded(content))
  }
  blocks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK))
  return gzipSync(Buffer.concat(blocks))
}

function extract(entries) {
  const base = mkdtempSync(join(tmpdir(), 'tar-test-'))
  const destination = join(base, 'out')
  mkdirSync(destination)
  return { base, destination, entries: entries }
}

test('a normal tarball extracts its files', () => {
  const { base, destination } = extract()
  try {
    const raw = makeTar([
      { name: 'plugin.json', content: '{"name":"x"}' },
      { name: 'skills/hello/SKILL.md', content: 'hello' },
    ])
    assert.equal(isGzip(raw), true)
    const files = extractTarball(raw, destination)
    assert.equal(files, 2)
    assert.equal(readFileSync(join(destination, 'plugin.json'), 'utf8'), '{"name":"x"}')
    assert.equal(readFileSync(join(destination, 'skills', 'hello', 'SKILL.md'), 'utf8'), 'hello')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a parent-directory member is refused and writes nothing outside', () => {
  const { base, destination } = extract()
  try {
    const raw = makeTar([{ name: '../escape', content: 'x' }])
    assert.throws(() => extractTarball(raw, destination), (error) => {
      assert.equal(error instanceof TarError, true)
      assert.match(error.message, /escapes the destination/u)
      return true
    })
    assert.equal(existsSync(join(base, 'escape')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a backslash member is refused (win32 separator)', () => {
  const { base, destination } = extract()
  try {
    const raw = makeTar([{ name: '..\\escape', content: 'x' }])
    assert.throws(() => extractTarball(raw, destination), /contains a backslash/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an absolute member and a drive member are refused', () => {
  const { base, destination } = extract()
  try {
    assert.throws(() => extractTarball(makeTar([{ name: '/etc/passwd', content: 'x' }]), destination), /absolute path/u)
    assert.throws(() => extractTarball(makeTar([{ name: 'C:/x', content: 'x' }]), destination), /drive prefix/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a component ending in a dot or space is refused', () => {
  const { base, destination } = extract()
  try {
    assert.throws(() => extractTarball(makeTar([{ name: 'a./b', content: 'x' }]), destination), /dot or space/u)
    assert.throws(() => extractTarball(makeTar([{ name: 'a /b', content: 'x' }]), destination), /dot or space/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a duplicate member is refused instead of last-wins', () => {
  const { base, destination } = extract()
  try {
    const raw = makeTar([
      { name: 'SKILL.md', content: 'one' },
      { name: 'SKILL.md', content: 'two' },
    ])
    assert.throws(() => extractTarball(raw, destination), /appears more than once/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a file/directory collision is reported as a TarError, not a raw fs error', () => {
  const { base, destination } = extract()
  try {
    const raw = makeTar([
      { name: 'a', content: 'file' },
      { name: 'a/b', content: 'child' },
    ])
    assert.throws(() => extractTarball(raw, destination), (error) => {
      assert.equal(error instanceof TarError, true)
      assert.match(error.message, /cannot extract "a\/b"/u)
      return true
    })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a symbolic-link member is refused', () => {
  const { base, destination } = extract()
  try {
    const raw = makeTar([{ name: 'link', content: '', type: '2' }])
    assert.throws(() => extractTarball(raw, destination), /link\/device/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
