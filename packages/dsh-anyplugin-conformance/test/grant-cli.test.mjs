// `rig grant` / `rig revoke` — the authoring surface for the D25 store.
//
// The CLI is tested by running it, because the contract is about what a human
// sees before they confirm: the target, the mode, the hash and the exact
// command line. Every test uses a temp plugin and a temp `$DSH_HOME`; the
// real profile is never read or written.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { runGrant, runRevoke } from '../src/rig.ts'
import { compileEntries } from '../../dsh-anyplugin-install/src/index.ts'
import { buildTransplantReport, formatTransplantReport } from '../src/report.ts'
import {
  authorize,
  classify,
  emptyGrants,
  grant,
  grantFor,
  pluginIdentity,
  readGrants,
  revokeFor,
  serializeGrants,
  writeGrants,
} from '../../dsh-anyplugin-trust/src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))

const materializers = {
  skill: new URL('../../../packages/dsh-anyplugin-materialize-skill/src/index.ts', import.meta.url).href,
  mcp: new URL('../../../packages/dsh-anyplugin-materialize-mcp/src/index.ts', import.meta.url).href,
  hooks: new URL('../../../packages/dsh-anyplugin-materialize-hook/src/index.ts', import.meta.url).href,
}

function makePlugin({ command = '"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"', args, event = 'PostToolUse' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-grant-cli-'))
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'gated', version: '0.0.1' })}\n`, 'utf8')
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          [event]: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command, ...(args === undefined ? {} : { args }) }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const script = join(dir, 'scripts', 'hook.sh')
  writeFileSync(script, '#!/bin/sh\necho ok\n', 'utf8')
  chmodSync(script, 0o755)
  return { dir, script, ir: readClaudePlugin(dir) }
}

function rewriteHooks(dir, commands, script = join(dir, 'scripts', 'hook.sh')) {
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          PostToolUse: commands.map((command) => ({
            matcher: 'Write',
            hooks: [{ type: 'command', command }],
          })),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return script
}

function compileOptions(grants) {
  return {
    materializers,
    enablements: { user: { plugins: { 'claude-code:gated': { enabled: true, grants: [] } } } },
    ...(grants === undefined ? {} : { grants }),
  }
}

function installsFor(ir) {
  return {
    schema: 'dsh-anyplugin/installs@1',
    plugins: [
      {
        dialect: 'claude-code',
        name: ir.plugin.name,
        version: ir.plugin.version ?? '0.0.1',
        root: ir.plugin.root,
        dataDir: join(ir.plugin.root, '.data'),
        pin: `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`,
      },
    ],
  }
}

/** Run the CLI with a throwaway HOME; the real $DSH_HOME must never appear. */
function runRig(dir, args) {
  const home = join(dir, 'dsh-home')
  const result = spawnSync(process.execPath, [rigPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  assert.equal(existsSync(home), false, 'the grant CLI must not touch $DSH_HOME')
  return result
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('grant without --yes prints the target, mode, hash and exact command, and writes nothing', () => {
  const { dir, script } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /hook:PostToolUse#0/)
    assert.match(result.stdout, /mode: file/)
    assert.match(result.stdout, /artifact: sha256:[0-9a-f]{64}/)
    assert.ok(result.stdout.includes(`command: "${script}"`), result.stdout)
    assert.match(result.stdout, /--yes/)
    assert.equal(existsSync(store), false, 'a dry run must not create the store')
  } finally {
    cleanup(dir)
  }
})

test('grant --yes writes once; the second run says already granted and does not rewrite the file', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const first = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(first.status, 0, first.stderr)
    const bytes = readFileSync(store, 'utf8')
    const inode = statSync(store).ino

    const second = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /already granted/)
    assert.equal(readFileSync(store, 'utf8'), bytes, 'a no-op must not change the bytes')
    assert.equal(statSync(store).ino, inode, 'a no-op must not replace the file')

    const parsed = readGrants(store)
    assert.equal(parsed.grants.length, 1)
    assert.equal(parsed.grants[0].scope, 'user', 'the default scope is user')
    assert.equal(parsed.grants[0].artifactHash, classify(ir)[0].artifactHash)
    assert.equal(parsed.grants[0].plugin, pluginIdentity(ir))
  } finally {
    cleanup(dir)
  }
})

test('the CLI-written store is byte-identical to the library canonical serialization', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes', '--json'])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.command, 'grant')
    assert.equal(payload.ok, true)
    assert.equal(payload.dryRun, false)
    assert.equal(payload.wrote, true)
    assert.equal(payload.scope, 'user')
    assert.equal(payload.pending.length, 1, 'a successful write returns the granted preview rows in pending')
    assert.equal(payload.granted.length, 1)
    assert.equal(payload.skipped.length, 0)

    let canonical = emptyGrants()
    for (const record of payload.granted) {
      canonical = grantFor(ir, canonical, record.target, {
        scope: record.scope,
        grantedAt: record.grantedAt,
      })
    }
    assert.equal(readFileSync(store, 'utf8'), serializeGrants(canonical))
    assert.deepEqual(readGrants(store), canonical)
  } finally {
    cleanup(dir)
  }
})

test('a project revoke outranks a user grant, and the CLI names the grant it shadowed', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    const granted = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(granted.status, 0, granted.stderr)

    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'project',
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /effective: REVOKED/)
    assert.match(result.stdout, /user grant is broader/)
    assert.match(result.stdout, /narrower refusal never falls back/)

    const parsed = readGrants(store)
    assert.equal(parsed.grants.length, 1)
    assert.equal(parsed.revokes.length, 1)
    assert.equal(parsed.revokes[0].scope, 'project')
    assert.deepEqual(compileEntries(installsFor(ir), compileOptions(parsed)), [])
  } finally {
    cleanup(dir)
  }
})

test('a user revoke under a project grant stays allowed and exits non-zero with a warning', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    const granted = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--scope', 'project', '--yes'])
    assert.equal(granted.status, 0, granted.stderr)

    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
    ])
    assert.equal(result.status, 1, 'a revoke that does not take effect is not success')
    assert.match(result.stdout, /effective: ALLOWED/)
    assert.match(
      result.stdout,
      /WARNING: the artifact is still allowed; your user revoke did not take effect\. Revoke at project scope/,
    )
    const json = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
      '--json',
    ])
    assert.equal(json.status, 1)
    const payload = JSON.parse(json.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.wrote, false)
    assert.equal(payload.alreadyRevoked, true)
    assert.equal(payload.resolution.status, 'allowed')
    assert.equal(payload.resolution.decidingScope, 'project')
    assert.match(payload.resolution.warning, /[Rr]evoke at project scope/)

    const parsed = readGrants(store)
    assert.equal(parsed.grants.length, 1)
    assert.equal(parsed.revokes.length, 1)
    assert.equal(compileEntries(installsFor(ir), compileOptions(parsed)).length, 1)
  } finally {
    cleanup(dir)
  }
})

test('revoking the last record makes the next compileEntries produce no entry', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    const granted = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(granted.status, 0, granted.stderr)
    assert.equal(compileEntries(installsFor(ir), compileOptions(readGrants(store))).length, 1)

    const revoked = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
    ])
    assert.equal(revoked.status, 0, revoked.stderr)
    assert.match(revoked.stdout, /effective: REVOKED/)

    const parsed = readGrants(store)
    assert.equal(parsed.grants.length, 1)
    assert.equal(parsed.revokes.length, 1)
    assert.deepEqual(compileEntries(installsFor(ir), compileOptions(parsed)), [])
  } finally {
    cleanup(dir)
  }
})

test('an artifact that cannot be pinned is refused with a reason, even with --yes', () => {
  const { dir } = makePlugin({ command: 'scripts/hook.sh' })
  const store = join(dir, 'grants.yml')
  try {
    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(result.status, 1, 'a refused artifact must not look granted')
    assert.match(result.stdout, /cannot be granted/)
    assert.match(result.stdout, /cannot pin/)
    assert.match(result.stdout, /is relative/)
    assert.equal(existsSync(store), false, 'nothing is written when nothing is pinnable')
  } finally {
    cleanup(dir)
  }
})

test('plain --yes never erases a same-scope revoke; --replace-revoke does and says so per target', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    writeGrants(store, revokeFor(ir, emptyGrants(), row.target, { scope: 'user' }))
    const before = readFileSync(store, 'utf8')

    const refused = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(refused.status, 1, 'a grant must not silently erase a refusal')
    assert.match(refused.stdout, /revoke\(s\) at user scope would be erased/)
    assert.match(refused.stdout, /hook:PostToolUse#0/)
    assert.match(refused.stdout, /--replace-revoke/)
    assert.equal(readFileSync(store, 'utf8'), before, 'a refused grant leaves the store byte-identical')

    const replaced = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes', '--replace-revoke'])
    assert.equal(replaced.status, 0, replaced.stderr)
    assert.match(replaced.stdout, /cleared revoke: hook:PostToolUse#0/)

    const parsed = readGrants(store)
    assert.equal(parsed.revokes.length, 0)
    assert.equal(parsed.grants.length, 1)
    assert.deepEqual(authorize(ir, parsed).allowed, [row.target])
  } finally {
    cleanup(dir)
  }
})

test('granting two hooks, revoking one, then adding a third fails closed without --replace-revoke', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const command = '"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"'
  try {
    rewriteHooks(dir, [command, command])
    const granted = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(granted.status, 0, granted.stderr)

    const revoked = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:PostToolUse#0',
      '--scope',
      'user',
    ])
    assert.equal(revoked.status, 0, revoked.stderr)

    rewriteHooks(dir, [command, command, command])
    const before = readFileSync(store, 'utf8')
    const collateral = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(collateral.status, 1, 'the un-granted third hook must not ride along with the revoked one')
    assert.match(collateral.stdout, /would be erased/)
    assert.equal(readFileSync(store, 'utf8'), before)

    const parsed = readGrants(store)
    assert.equal(parsed.grants.filter((record) => record.scope === 'user').length, 2)
    assert.equal(parsed.revokes.length, 1)
  } finally {
    cleanup(dir)
  }
})

test('a changed artifact is re-consented at the same scope and replaces the old hash', () => {
  const { dir, ir, script } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const granted = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(granted.status, 0, granted.stderr)
    const oldHash = readGrants(store).grants[0].artifactHash

    writeFileSync(script, '#!/bin/sh\necho changed\n', 'utf8')
    const preview = runRig(dir, ['grant', '--plugin', dir, '--grants', store])
    assert.equal(preview.status, 1, 'a dry run still does not write')
    assert.match(preview.stdout, /re-consent: old sha256:[0-9a-f]{64} → new sha256:[0-9a-f]{64}/)
    assert.match(preview.stdout, new RegExp(`old ${oldHash}`))

    const replaced = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(replaced.status, 0, replaced.stderr)

    const parsed = readGrants(store)
    assert.equal(parsed.grants.length, 1, 'the same-scope record is replaced, not duplicated')
    const newHash = parsed.grants[0].artifactHash
    assert.notEqual(newHash, oldHash)
    assert.ok(!readFileSync(store, 'utf8').includes(oldHash), 'the old hash is gone from the store')

    const report = runRig(dir, ['report', dir, '--grants', store, '--json'])
    assert.equal(report.status, 0, report.stderr)
    assert.ok(report.stdout.includes(newHash), report.stdout)
    assert.ok(!report.stdout.includes(oldHash), report.stdout)
  } finally {
    cleanup(dir)
  }
})

test('a refused artifact blocks the whole write unless --partial is given', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    rewriteHooks(dir, ['"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"', 'scripts/relative.sh'])
    const refused = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stdout, /no grants written/)
    assert.equal(existsSync(store), false, 'the pinnable hook must not ride along with the refused one')

    const partial = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes', '--partial', '--json'])
    assert.equal(partial.status, 1, 'a partial write reports the skipped artifact')
    const payload = JSON.parse(partial.stdout)
    assert.equal(payload.wrote, true)
    assert.equal(payload.granted.length, 1)
    assert.equal(payload.skipped.length, 1)
    assert.match(payload.skipped[0].reason, /is relative/)

    const parsed = readGrants(store)
    assert.equal(parsed.grants.length, 1, 'only the pinnable artifact was written')
  } finally {
    cleanup(dir)
  }
})

test('an absolute program that does not exist is refused as unpinnable', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    rewriteHooks(dir, ['"${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh"'])
    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /does not exist and cannot be pinned/)
    assert.equal(existsSync(store), false)
  } finally {
    cleanup(dir)
  }
})

test('a grant refuses to write a broader record that a narrower revoke would outrank', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    writeGrants(store, revokeFor(ir, emptyGrants(), row.target, { scope: 'local' }))

    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes'])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /revoked at local scope, which is narrower than user/)
    assert.equal(readGrants(store).grants.length, 0, 'no inert user grant is written')
    assert.equal(readGrants(store).revokes.length, 1)
  } finally {
    cleanup(dir)
  }
})

test('same-scope records say "a revoke beats a grant", never narrower or outranked', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    let grants = grantFor(ir, emptyGrants(), row.target, { scope: 'user' })
    grants = revokeFor(ir, grants, row.target, { scope: 'user' })
    writeGrants(store, grants)

    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /At user a revoke beats a grant/)
    assert.doesNotMatch(result.stdout, /narrower|outranked/)

    const json = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
      '--json',
    ])
    const payload = JSON.parse(json.stdout)
    assert.match(payload.resolution.verdict, /At user a revoke beats a grant/)
    assert.doesNotMatch(payload.resolution.verdict, /narrower|outranked/)
  } finally {
    cleanup(dir)
  }
})

test('a revoke with no grant on file says no grant records the target, not "nothing records"', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /no grant records this target/)
    assert.doesNotMatch(result.stdout, /Nothing else records/)

    const json = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
      '--json',
    ])
    assert.match(JSON.parse(json.stdout).resolution.verdict, /no grant records this target/)
  } finally {
    cleanup(dir)
  }
})

test('a broader revoke left on file is reported after a narrower grant', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    writeGrants(store, revokeFor(ir, emptyGrants(), row.target, { scope: 'user' }))
    const result = runRig(dir, [
      'grant',
      '--plugin',
      dir,
      '--grants',
      store,
      '--scope',
      'project',
      '--yes',
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`the user revoke for ${row.target} remains on file`))
    assert.match(result.stdout, /the project grant outranks it/)

    const json = runRig(dir, [
      'grant',
      '--plugin',
      dir,
      '--grants',
      store,
      '--scope',
      'project',
      '--yes',
      '--json',
    ])
    const payload = JSON.parse(json.stdout)
    assert.deepEqual(payload.remainingRevokes, [{ target: row.target, scope: 'user' }])

    const parsed = readGrants(store)
    assert.equal(parsed.grants[0].scope, 'project')
    assert.equal(parsed.revokes[0].scope, 'user')
    assert.deepEqual(authorize(ir, parsed).allowed, [row.target])
  } finally {
    cleanup(dir)
  }
})

test('a revoke that loses to a mismatch grant says the revoke did not take effect', () => {
  const { dir, ir, script } = makePlugin()
  const store = join(dir, 'grants.yml')
  const [row] = classify(ir)
  try {
    const granted = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--scope', 'project', '--yes'])
    assert.equal(granted.status, 0, granted.stderr)
    writeFileSync(script, '#!/bin/sh\necho changed\n', 'utf8')

    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
    ])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /effective: HASH-MISMATCH/)
    assert.match(result.stdout, /revoke did not take effect/)
    assert.match(result.stdout, /even though its hash no longer matches/)

    const json = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      row.target,
      '--scope',
      'user',
      '--json',
    ])
    assert.match(JSON.parse(json.stdout).resolution.verdict, /revoke did not take effect/)
  } finally {
    cleanup(dir)
  }
})

test('unknown targets and misuse are usage errors, not writes', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const unknown = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:Bogus#9',
    ])
    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /no exec artifact "hook:Bogus#9"/)
    assert.match(unknown.stderr, /known targets: hook:PostToolUse#0/)

    const badScope = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--scope', 'global'])
    assert.equal(badScope.status, 2)
    assert.match(badScope.stderr, /--scope must be one of local, project, user/)

    const yesRevoke = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:PostToolUse#0',
      '--yes',
    ])
    assert.equal(yesRevoke.status, 2)
    assert.match(yesRevoke.stderr, /--yes does not apply to revoke/)

    const partialRevoke = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:PostToolUse#0',
      '--partial',
    ])
    assert.equal(partialRevoke.status, 2)
    assert.match(partialRevoke.stderr, /--replace-revoke and --partial apply only to grant/)

    assert.equal(existsSync(store), false)
  } finally {
    cleanup(dir)
  }
})

test('exec-form hooks are printed as argv, not as shell text', () => {
  const { dir, script } = makePlugin()
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: script, args: [script, '--flag', 'space here'] }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const store = join(dir, 'grants.yml')
  try {
    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /form: argv \(no shell; words passed literally\)/)
    assert.ok(
      result.stdout.includes(`command: ${JSON.stringify([script, script, '--flag', 'space here'])}`),
      result.stdout,
    )
    assert.equal(existsSync(store), false)
  } finally {
    cleanup(dir)
  }
})

test('revoke succeeds from the record after the pinned script is deleted, without showing the declaration as the artifact', () => {
  const { dir, script, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    assert.equal(runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes']).status, 0)
    const bytes = readFileSync(script)
    rmSync(script)
    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:PostToolUse#0',
      '--json',
    ])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.artifact, null, 'an unsupported row is not the artifact that was granted')
    assert.match(payload.note, /does not exist and cannot be pinned; revoking the store record/)
    assert.equal(payload.resolution.status, 'revoked')
    assert.equal(readGrants(store).revokes.length, 1)

    writeFileSync(script, bytes)
    chmodSync(script, 0o755)
    const report = buildTransplantReport(ir, { materializers, grants: readGrants(store) })
    assert.equal(report.components[0].refused, 'exec')
    assert.match(formatTransplantReport(report), /^hooks\/PostToolUse#0 {2}class=planned {2}carry=refused:exec$/m)
  } finally {
    cleanup(dir)
  }
})

test('revoke succeeds from the record after the hook is removed from the plugin', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    assert.equal(runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes']).status, 0)
    writeFileSync(join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n', 'utf8')
    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:PostToolUse#0',
      '--json',
    ])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.wrote, true)
    assert.equal(payload.alreadyRevoked, false)
    assert.equal(payload.pluginRead, true)
    assert.equal(payload.artifact, null)
    assert.match(payload.note, /the plugin no longer contains hook:PostToolUse#0/)
    assert.equal(payload.resolution.status, 'revoked')
  } finally {
    cleanup(dir)
  }
})

test('revoke succeeds from the record after the plugin directory is deleted', () => {
  const { dir } = makePlugin()
  const store = `${dir}-store.yml`
  try {
    assert.equal(runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes']).status, 0)
    rmSync(dir, { recursive: true, force: true })
    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:PostToolUse#0',
      '--json',
    ])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.plugin, 'claude-code:gated')
    assert.equal(payload.wrote, true)
    assert.equal(payload.pluginRead, false)
    assert.match(payload.pluginError, /does not exist/)
    assert.equal(payload.artifact, null)
    assert.match(payload.note, /the plugin directory could not be read/)
    assert.equal(readGrants(store).revokes.length, 1)
  } finally {
    cleanup(dir)
    rmSync(store, { force: true })
  }
})

test('a pre-emptive revoke records a refusal even when no grant exists', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:PostToolUse#0',
      '--json',
    ])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.wrote, true)
    assert.equal(payload.resolution.status, 'revoked')
    assert.equal(payload.resolution.decidingKind, 'revoke')
    const after = readGrants(store)
    assert.equal(after.grants.length, 0)
    assert.equal(after.revokes.length, 1)
    assert.equal(after.revokes[0].target, 'hook:PostToolUse#0')
  } finally {
    cleanup(dir)
  }
})

test('revoke still rejects a target that no record mentions and the plugin cannot name', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const result = runRig(dir, [
      'revoke',
      '--plugin',
      dir,
      '--grants',
      store,
      '--target',
      'hook:Never#0',
    ])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /no exec artifact "hook:Never#0"/)
    assert.equal(existsSync(store), false)
  } finally {
    cleanup(dir)
  }
})

test('the first revoke reports alreadyRevoked:false, the second reports true', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  const args = ['revoke', '--plugin', dir, '--grants', store, '--target', 'hook:PostToolUse#0', '--json']
  try {
    assert.equal(runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes']).status, 0)
    const first = runRig(dir, args)
    assert.equal(first.status, 0, first.stderr)
    const firstPayload = JSON.parse(first.stdout)
    assert.equal(firstPayload.wrote, true)
    assert.equal(firstPayload.alreadyRevoked, false)

    const second = runRig(dir, args)
    assert.equal(second.status, 0, second.stderr)
    const secondPayload = JSON.parse(second.stdout)
    assert.equal(secondPayload.wrote, false)
    assert.equal(secondPayload.alreadyRevoked, true)
  } finally {
    cleanup(dir)
  }
})

test('a changed plugin re-hashes under the lock and reports a plugin-visible cause', () => {
  const { dir, script, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    assert.throws(
      () =>
        runGrant(ir, store, {
          scope: 'user',
          yes: true,
          replaceRevoke: false,
          partial: false,
          onLocked: (current) => {
            writeFileSync(script, '#!/bin/sh\necho changed while locked\n', 'utf8')
            return current
          },
        }),
      /the plugin bytes changed while planning/,
    )
    assert.equal(existsSync(store), false)
  } finally {
    cleanup(dir)
  }
})

test('a store changed under the lock reports a store-visible cause', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    assert.throws(
      () =>
        runGrant(ir, store, {
          scope: 'user',
          yes: true,
          replaceRevoke: false,
          partial: false,
          onLocked: (current) =>
            grantFor(ir, current, 'hook:PostToolUse#0', { scope: 'user' }),
        }),
      /the grants store changed while planning/,
    )
    assert.equal(existsSync(store), false)
  } finally {
    cleanup(dir)
  }
})

test('a revoke re-plans under the lock and reports a store-visible move', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const [row] = classify(ir)
    const target = row.target
    writeGrants(
      store,
      grant(
        emptyGrants(),
        {
          plugin: pluginIdentity(ir),
          capability: 'exec',
          target,
          artifactHash: row.artifactHash,
        },
        { scope: 'user' },
      ),
    )
    assert.throws(
      () =>
        runRevoke(ir, store, target, 'user', undefined, {
          onLocked: (current) => {
            const moved = {
              ...current,
              grants: current.grants.filter((record) => record.plugin !== pluginIdentity(ir)),
            }
            return grant(
              moved,
              {
                plugin: 'claude-code:other',
                capability: 'exec',
                target,
                artifactHash: row.artifactHash,
              },
              { scope: 'user' },
            )
          },
        }),
      /the grants store changed while planning/,
    )
    const after = readGrants(store)
    assert.equal(after.revokes.length, 0, 'the losing write must not land')
    assert.equal(after.grants.length, 1)
    assert.equal(after.grants[0].plugin, pluginIdentity(ir))
  } finally {
    cleanup(dir)
  }
})

test('an inert revoke left on file is named after an already-granted run', () => {
  const { dir, ir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    const target = classify(ir)[0].target
    let records = grantFor(ir, emptyGrants(), target, { scope: 'local' })
    records = revokeFor(ir, records, target, { scope: 'project' })
    writeGrants(store, records)
    const before = readFileSync(store, 'utf8')

    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--scope', 'project', '--yes'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /a project revoke remains on file; it is inert while the local grant decides/)
    assert.equal(readFileSync(store, 'utf8'), before, 'an already-granted run writes nothing')
  } finally {
    cleanup(dir)
  }
})

test('--json reports the write contract and exit code for every path', () => {
  const { dir, ir } = makePlugin()
  const target = classify(ir)[0].target
  const store = join(dir, 'grants.yml')
  try {
    const dry = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--json'])
    assert.equal(dry.status, 1)
    assert.deepEqual(
      (({ ok, dryRun, wrote, pending }) => ({ ok, dryRun, wrote, pending: pending.length }))(
        JSON.parse(dry.stdout),
      ),
      { ok: false, dryRun: true, wrote: false, pending: 1 },
    )

    const write = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes', '--json'])
    assert.equal(write.status, 0)
    const written = JSON.parse(write.stdout)
    assert.equal(written.ok, true)
    assert.equal(written.wrote, true)
    assert.equal(written.pending.length, 1)

    const noop = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--json'])
    assert.equal(noop.status, 0)
    const noopPayload = JSON.parse(noop.stdout)
    assert.equal(noopPayload.ok, true)
    assert.equal(noopPayload.wrote, false)
    assert.equal(noopPayload.pending.length, 0)
    assert.equal(noopPayload.alreadyGranted.length, 1)

    const revoke = runRig(dir, [
      'revoke', '--plugin', dir, '--grants', store, '--target', target, '--json',
    ])
    assert.equal(revoke.status, 0)
    const revoked = JSON.parse(revoke.stdout)
    assert.equal(revoked.ok, true)
    assert.equal(revoked.wrote, true)
    assert.equal(revoked.alreadyRevoked, false)
    assert.equal(revoked.resolution.status, 'revoked')
  } finally {
    cleanup(dir)
  }
})

test('--json exits 1 without writing when a same-scope revoke would be erased', () => {
  const { dir, ir } = makePlugin()
  const target = classify(ir)[0].target
  const store = join(dir, 'grants.yml')
  try {
    writeGrants(store, revokeFor(ir, emptyGrants(), target, { scope: 'user' }))
    const result = runRig(dir, ['grant', '--plugin', dir, '--grants', store, '--yes', '--json'])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.wrote, false)
    assert.equal(payload.clearsRevokes.length, 1)
  } finally {
    cleanup(dir)
  }
})

test('--json exits 1 but writes the pinnable rows with --partial', () => {
  const { dir } = makePlugin()
  const store = join(dir, 'grants.yml')
  try {
    rewriteHooks(dir, ['"' + '${CLAUDE_PLUGIN_ROOT}' + '/scripts/hook.sh"', 'scripts/relative.sh'])
    const result = runRig(dir, [
      'grant', '--plugin', dir, '--grants', store, '--yes', '--partial', '--json',
    ])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.wrote, true)
    assert.equal(payload.granted.length, 1)
    assert.equal(payload.skipped.length, 1)
    assert.match(payload.skipped[0].reason, /is relative/)
  } finally {
    cleanup(dir)
  }
})

