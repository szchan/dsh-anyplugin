// M1/M2 through the real controller: a `@1` lock, a matching `mod:` grant and
// an enabled plugin must still boot nothing. The lock is the install decision;
// the controller is where a boot decides, so this is the wiring a mutation
// `requireRecordedMods: true → false` must redden.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emptyGrants, grantFor, grantsPath, writeGrants } from '../../dsh-anyplugin-trust/src/index.ts'
import { apply } from '../src/controller.ts'
import { writeEnablements } from '../src/enablements.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const modsRoot = join(repoRoot, 'packages', 'dsh-anyplugin-dialect-claude-code', 'test', 'fixtures', 'claude-mods')

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'anyplugin-controller-'))
  const projectDir = join(home, 'project')
  const lock = join(home, 'anyplugin', 'installs.yml')
  return { home, projectDir, lock, grants: grantsPath(lock) }
}

test('a @1 lock plus a mod grant boots no mod through the controller', async () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.home, 'anyplugin'), { recursive: true })
    const ir = readClaudePlugin(modsRoot)
    // Deliberately the 0.1.0 shape: no `mods` field at all.
    writeFileSync(
      box.lock,
      [
        'schema: "dsh-anyplugin/installs@1"',
        'plugins:',
        '  - dialect: "claude-code"',
        '    name: "mods"',
        '    version: "0.0.1"',
        `    root: ${JSON.stringify(modsRoot)}`,
        `    dataDir: ${JSON.stringify(join(box.home, 'data'))}`,
        '    pin: "claude-code@2.1.329"',
        '',
      ].join('\n'),
    )
    writeGrants(box.grants, grantFor(ir, emptyGrants(), 'mod:hooks/register.ts', { scope: 'user' }))
    writeEnablements(join(box.home, 'anyplugin', 'enabled.yml'), {
      plugins: { 'claude-code:mods': { enabled: true, grants: [] } },
    })

    const created = []
    const warnings = []
    const loader = {
      root: {},
      entries: () => [],
      resolve: () => undefined,
      await: async () => {},
      create: (entry) => {
        created.push(entry)
      },
      update: () => {},
      remove: () => {},
    }
    await apply(
      { loader, get: () => undefined, logger: { warn: (message) => warnings.push(String(message)) } },
      { installs: box.lock, grants: box.grants, home: box.home, projectDir: box.projectDir },
    )
    assert.deepEqual(created, [], 'an unrecorded tree must not reach the loader')
    assert.ok(
      warnings.some((message) => /not-recorded: the lock does not record this module tree/.test(message)),
      `the refusal must be reported; got ${JSON.stringify(warnings)}`,
    )
    assert.match(warnings.join('\n'), /granted tree: sha256:/)
    assert.match(warnings.join('\n'), /no mod for this entry/)
  } finally {
    rmSync(box.home, { recursive: true, force: true })
  }
})
