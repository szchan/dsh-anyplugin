/**
 * The monitor-error corpus is only evidence while it still reproduces. The
 * dialect quotes `MONITOR_CLIENT_TEXT`, whose entries are slices of these
 * captures; without a live re-capture, a pin bump could change the client's
 * wording and leave the quoted reason silently stale.
 *
 * `scripts/capture-monitor-errors.mjs --check` rebuilds all shapes into a
 * temporary directory and diffs them against `fixtures/claude-monitors-errors/
 * observed/`, naming every file that moved. This test runs that check against
 * the resolved pinned CLI, so `npm run verify` re-establishes the capture↔client
 * link on every run. Locally, no CLI is a named skip (D24); CI sets CLAUDE_BIN,
 * where a skip is a failure.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { claudeSkipReason, resolveClaudeBinary } from '../src/oracles/claude.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const script = join(repoRoot, 'scripts', 'capture-monitor-errors.mjs')
const claude = resolveClaudeBinary()
const skip = claudeSkipReason()

test(
  'the monitor error corpus still matches the pinned client',
  { skip: claude ? false : skip },
  () => {
    const run = spawnSync(process.execPath, [script, '--check'], {
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, CLAUDE_BIN: claude.bin },
    })
    assert.equal(
      run.status,
      0,
      `capture --check must match the committed corpus:\n${run.stdout ?? ''}\n${run.stderr ?? ''}`,
    )
  },
)
