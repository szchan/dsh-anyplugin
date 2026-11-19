// Resolution of the Claude Code CLI under test (D24).
//
// The decision-table tests never run the CLI: they build throwaway PATH
// directories and assert which binary `resolveClaudeBinary` picks, which source
// it reports, and when it refuses instead of silently probing a different
// installation. The final test invokes whatever binary resolves, as does
// fixtures.test.mjs, which skips for a named reason only when no CLI resolves
// locally. The unusable-bin case at the end runs the probe against a missing
// path to prove the probe uses the bin it was given instead of borrowing PATH.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  claudeSkipReason,
  claudeVersion,
  probeWithClaude,
  resolveClaudeBinary,
} from '../src/oracles/claude.ts'
import { CLAUDE_CODE_PACKAGE, CLAUDE_CODE_PIN } from '../src/pin.ts'

const scratch = mkdtempSync(join(tmpdir(), 'anyplugin-claude-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

function writeExecutable(path) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

function resolve(env) {
  return resolveClaudeBinary({ env })
}

test('CLAUDE_BIN wins over PATH and reports its source', () => {
  const explicit = writeExecutable(join(scratch, 'explicit', 'claude'))
  const onPath = writeExecutable(join(scratch, 'path', 'claude'))
  const found = resolve({ CLAUDE_BIN: explicit, PATH: join(scratch, 'path') })
  assert.equal(found.bin, explicit)
  assert.equal(found.source, 'CLAUDE_BIN')
  assert.notEqual(found.bin, onPath)
})

test('a bare CLAUDE_BIN is treated as unset and PATH is used', () => {
  const onPath = writeExecutable(join(scratch, 'bare-path', 'claude'))
  const found = resolve({ CLAUDE_BIN: '   ', PATH: join(scratch, 'bare-path') })
  assert.equal(found.bin, onPath)
  assert.equal(found.source, 'PATH')
})

test('claude on PATH is found without CLAUDE_BIN', () => {
  const onPath = writeExecutable(join(scratch, 'path-only', 'claude'))
  const found = resolve({ PATH: join(scratch, 'path-only') })
  assert.equal(found.bin, onPath)
  assert.equal(found.source, 'PATH')
})

test('a named but unusable CLAUDE_BIN is an error, never a fall-through to PATH', () => {
  writeExecutable(join(scratch, 'fallback', 'claude'))
  const missing = join(scratch, 'does-not-exist', 'claude')
  assert.throws(
    () => resolve({ CLAUDE_BIN: missing, PATH: join(scratch, 'fallback') }),
    (error) =>
      error.message.includes(`CLAUDE_BIN=${missing}`) &&
      error.message.includes('not an executable file') &&
      error.message.includes('fetch-claude.mjs'),
  )
})

test('nothing named resolves to undefined locally, and the skip reason names the fix', () => {
  assert.equal(resolve({}), undefined)
  assert.equal(resolve({ PATH: '' }), undefined)
  assert.match(claudeSkipReason(), /claude CLI not installed/)
  assert.match(claudeSkipReason(), /node scripts\/fetch-claude\.mjs/)
  assert.ok(claudeSkipReason().includes(`${CLAUDE_CODE_PACKAGE}@${CLAUDE_CODE_PIN.version}`))
  assert.match(claudeSkipReason(), /PATH/)
})

test('CI with no resolvable CLI throws instead of skipping', () => {
  for (const CI of ['true', '1']) {
    assert.throws(
      () => resolve({ CI }),
      (error) =>
        error.message.includes('CI requires the Claude Code CLI') &&
        error.message.includes('skipped fidelity test on CI is a bug') &&
        error.message.includes(`@anthropic-ai/claude-code@${CLAUDE_CODE_PIN.version}`) &&
        error.message.includes('fetch-claude.mjs'),
    )
  }
  assert.equal(resolve({ CI: 'false' }), undefined)
  assert.equal(resolve({ CI: '0' }), undefined)
})

test(`the resolved Claude Code reports ${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`, async (t) => {
  // Under CI a missing CLI throws here and fails the test; locally it skips.
  const found = resolveClaudeBinary()
  if (!found) return t.skip(claudeSkipReason())
  const actual = `${CLAUDE_CODE_PIN.tool}@${await claudeVersion(found.bin)}`
  const expected = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`
  assert.equal(
    actual,
    expected,
    `${found.bin} reports ${actual}; this repository's goldens are pinned to ${expected}`,
  )
})

test('a probe fails on an explicit but unusable bin instead of borrowing PATH', async () => {
  const pluginDir = join(scratch, 'plugin-for-unusable-bin')
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"probe-bin"}\n')
  const missing = join(scratch, 'missing-bin', 'claude')
  await assert.rejects(
    probeWithClaude({ pluginDir, bin: missing }),
    (error) => error?.code === 'ENOENT' || /ENOENT/.test(String(error)),
  )
})
