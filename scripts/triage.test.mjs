// End-to-end wiring test for the queue (docs/TRIAGE.md §2). The rules themselves
// are unit-tested in triage-rules.test.mjs; this file pins that scripts/triage.mjs
// actually routes a bot-filed `arch:` issue into its own section, reports the
// author class as `agent`, and lists it in the inbox without raising the exit
// code (D83). A real `gh` would hit the network, so the test puts a fake `gh` at
// the head of PATH and lets the script call it like the real one.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const triage = fileURLToPath(new URL('./triage.mjs', import.meta.url))

// The exact reads scripts/triage.mjs makes: the issue list, the PR list, and the
// comment view of the known issue. Anything else fails loudly so a new `gh` call
// cannot silently pass here.
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2)
const issue = {
  number: 42,
  title: 'arch: FEATURES row F4 points at a deleted file',
  author: { login: 'szchan-bot' },
  labels: [],
  createdAt: '2026-11-23T07:00:00Z',
  body: 'finding body',
}
const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (args[0] === 'issue' && args[1] === 'list') print([issue])
else if (args[0] === 'issue' && args[1] === 'view') print({ comments: [] })
else if (args[0] === 'pr' && args[1] === 'list') print([])
else {
  process.stderr.write('fake gh: unexpected ' + args.join(' ') + '\\n')
  process.exit(1)
}
`

const withFakeGh = (callback) => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-triage-'))
  try {
    const gh = join(dir, 'gh')
    writeFileSync(gh, FAKE_GH)
    chmodSync(gh, 0o755)
    return callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// MAINTAINER_LOGINS is set so the script does not ask `gh api user`; the bot
// login comes from the project's own environment variable.
const run = (bin, args) =>
  spawnSync(process.execPath, [triage, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      MAINTAINER_LOGINS: 'szchan',
      DSH_ANYPLUGIN_BOT_LOGIN: 'szchan-bot',
    },
  })

test('the queue routes a bot-filed arch: issue as an agent finding', () => {
  withFakeGh((bin) => {
    const result = run(bin, ['--json'])
    assert.equal(result.status, 0, result.stderr)
    const queue = JSON.parse(result.stdout)
    assert.equal(queue.total, 1)
    const findings = queue.sections['Agent findings (review)']
    assert.equal(findings.length, 1)
    assert.equal(findings[0].number, 42)
    // The author is the bot, not a maintainer: the row must say `agent`, not
    // `maintainer` (mutating roleOfIssue to roleOf reddens this line).
    assert.equal(findings[0].role, 'agent')
  })
})

test('the inbox lists the finding without raising the exit code', () => {
  withFakeGh((bin) => {
    const result = run(bin, ['--waiting'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /agent finding to review: #42 arch: FEATURES row F4 points at a deleted file/)
    assert.match(result.stdout, /1 agent finding\(s\) to review/)
  })
})

test('the markdown queue prints findings in their own section', () => {
  withFakeGh((bin) => {
    const result = run(bin, [])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /## Agent findings \(review\) — 1/)
    assert.match(result.stdout, /- #42 arch: FEATURES row F4 points at a deleted file — agent, labels: none/)
  })
})
