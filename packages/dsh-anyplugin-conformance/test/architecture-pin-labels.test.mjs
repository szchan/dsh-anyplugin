import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { pinLabelViolations } from '../../../scripts/architecture-pin-labels.mjs'

test('R12 rejects a bare claude-code.d.ts line citation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-r12-'))
  try {
    const file = join(dir, 'bare.md')
    writeFileSync(file, 'Next lives at `claude-code.d.ts:8289`.\n')
    const violations = pinLabelViolations([file])
    assert.equal(violations.length, 1)
    assert.match(violations[0].message, /needs the pin on the same line/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R12 accepts the pin in either number or word form, and ignores other packages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-r12-'))
  try {
    const file = join(dir, 'labelled.md')
    writeFileSync(
      file,
      [
        'Current: `claude-code.d.ts:8289-8367` (2.1.329 pin).',
        'Historical: `d.ts:5271-5352` (2.1.322).',
        'Word form: `d.ts:8289` at the pin.',
        'Other package: `dsh-user-approval/lib/types/index.d.ts:65-66`.',
        '',
      ].join('\n'),
    )
    assert.deepEqual(pinLabelViolations([file]), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
