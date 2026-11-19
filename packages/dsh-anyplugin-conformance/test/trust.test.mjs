// Trust gate (D24): grants pin the bytes that run, scope decides, and a
// refused hook must never appear in the entries the loader receives.
//
// These are filesystem tests on purpose. The rule is "hash, not path/mtime":
// the only convincing assertion flips a byte and watches the grant stop
// matching. Nothing here executes a hook script.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { compileEntries } from '../../dsh-anyplugin-install/src/index.ts'
import {
  authorize,
  classify,
  emptyGrants,
  gate,
  grant,
  hashBytes,
  hashFile,
  pluginIdentity,
  readGrants,
  revoke,
  serializeGrants,
  writeGrants,
  GrantsFileError,
} from '../../dsh-anyplugin-trust/src/index.ts'
import { buildTransplantReport, formatTransplantReport } from '../src/report.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const rigPath = fileURLToPath(new URL('../src/rig.ts', import.meta.url))
const materializerUrl = (pkg) => pathToFileURL(join(repoRoot, 'packages', pkg, 'src', 'index.ts')).href
const materializers = {
  skill: materializerUrl('dsh-anyplugin-materialize-skill'),
  mcp: materializerUrl('dsh-anyplugin-materialize-mcp'),
  hooks: materializerUrl('dsh-anyplugin-materialize-hook'),
}

function makePlugin({ name = 'gated', command = '"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"', args, event = 'PostToolUse' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-trust-'))
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name, version: '0.0.1' })}\n`, 'utf8')
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

function rewriteCommand(dir, { command, args, event = 'PostToolUse' }) {
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
}

function userGrant(ir, row, scope = 'user') {
  return grant(
    emptyGrants(),
    { plugin: pluginIdentity(ir), capability: row.capability, target: row.target, artifactHash: row.artifactHash },
    { scope },
  )
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
        pin: 'claude-code@2.1.322',
      },
    ],
  }
}

test('one-byte mutation of the hook script refuses the grant and reports both hashes', () => {
  const { dir, script, ir } = makePlugin()
  try {
    const [row] = classify(ir)
    assert.equal(row.mode, 'file')
    assert.equal(row.sourcePath, 'scripts/hook.sh')
    const store = userGrant(ir, row)
    assert.deepEqual(authorize(ir, store).allowed, [row.target])

    const bytes = readFileSync(script)
    bytes[0] ^= 0xff
    writeFileSync(script, bytes)

    const mutated = readClaudePlugin(dir)
    const [current] = classify(mutated)
    assert.notEqual(current.artifactHash, row.artifactHash, 'a one-byte change must change the hash')
    const decision = authorize(mutated, store)
    assert.deepEqual(decision.allowed, [])
    assert.equal(decision.refused.length, 1)
    assert.equal(decision.refused[0].code, 'hash-mismatch')
    assert.equal(decision.refused[0].grantedHash, row.artifactHash)
    assert.equal(decision.refused[0].artifactHash, current.artifactHash)
    assert.match(decision.refused[0].reason, /pins sha256:[0-9a-f]+ but the artifact is now sha256:[0-9a-f]+/)

    // The gate turns the refusal into a planned node, and emit has no hook to
    // place: with a hook-only plugin there is no entry at all.
    const gated = gate(mutated, store)
    assert.equal(gated.ir.hooks.length, 0)
    assert.match(gated.ir.pending[0].annotation.reason, /re-grant/)
    assert.equal(gated.ir.pending[0].annotation.fidelity, 'planned')
    const emitted = emitPlugin(gated.ir, { materializers, trusted: gated.decision.allowed })
    assert.equal(emitted.entry, null)
    assert.deepEqual(emitted.refused, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused hook never reaches the loader: compileEntries has no group for it', () => {
  const { dir, ir } = makePlugin()
  try {
    const installs = installsFor(ir)
    const [row] = classify(ir)

    // No grant: the plugin has no MCP/skill child to keep the group alive.
    assert.deepEqual(compileEntries(installs, compileOptions(undefined)), [])

    const allowed = compileEntries(installs, compileOptions(userGrant(ir, row)))
    assert.equal(allowed.length, 1)
    const hookChildren = allowed[0].config.filter((child) => child.name === materializers.hooks)
    assert.equal(hookChildren.length, 1)
    assert.equal(hookChildren[0].config.hooks[0].command, '"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"')

    // Same bytes plus a stale grant is refused, and the group disappears again:
    // not a disabled entry, not a hook that "did not run" — no entry.
    const bytes = readFileSync(join(dir, 'scripts', 'hook.sh'))
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0x0a ? 0x21 : 0x0a
    writeFileSync(join(dir, 'scripts', 'hook.sh'), bytes)
    assert.deepEqual(compileEntries(installs, compileOptions(userGrant(ir, row))), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope precedence: a local revoke beats a user grant, and a narrow mismatch never falls back', () => {
  const { dir, ir } = makePlugin()
  try {
    const [row] = classify(ir)
    const userStore = userGrant(ir, row, 'user')
    assert.deepEqual(authorize(ir, userStore).allowed, [row.target])

    const revoked = revoke(userStore, { plugin: pluginIdentity(ir), capability: row.capability, target: row.target }, {
      scope: 'local',
    })
    const decision = authorize(ir, revoked)
    assert.deepEqual(decision.allowed, [])
    assert.equal(decision.refused[0].code, 'revoked')
    assert.match(decision.refused[0].reason, /revoked at local scope/)

    // A local grant outranks a user revoke, and a project revoke outranks a user grant.
    const localGrant = grant(userStore, {
      plugin: pluginIdentity(ir),
      capability: row.capability,
      target: row.target,
      artifactHash: row.artifactHash,
    }, { scope: 'local' })
    const userRevoke = revoke(localGrant, {
      plugin: pluginIdentity(ir),
      capability: row.capability,
      target: row.target,
    }, { scope: 'user' })
    assert.deepEqual(authorize(ir, userRevoke).allowed, [row.target])

    const projectRevoke = revoke(userStore, {
      plugin: pluginIdentity(ir),
      capability: row.capability,
      target: row.target,
    }, { scope: 'project' })
    assert.equal(authorize(ir, projectRevoke).refused[0].code, 'revoked')

    // Local grant with the wrong hash must refuse, not fall back to the valid
    // user grant. Otherwise changed bytes would ride an old broad grant.
    const staleLocal = grant(userStore, {
      plugin: pluginIdentity(ir),
      capability: row.capability,
      target: row.target,
      artifactHash: `sha256:${'0'.repeat(64)}`,
    }, { scope: 'local' })
    const mismatch = authorize(ir, staleLocal)
    assert.deepEqual(mismatch.allowed, [])
    assert.equal(mismatch.refused[0].code, 'hash-mismatch')
    assert.equal(mismatch.refused[0].scope, 'local')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inline command hashing is over the command text, and changing the text invalidates', () => {
  const { dir, ir } = makePlugin({ command: 'echo hello' })
  try {
    const [row] = classify(ir)
    assert.equal(row.mode, 'inline')
    assert.equal(row.sourcePath, 'hooks/hooks.json')
    assert.equal(row.artifactHash, hashBytes('echo hello'))
    const store = userGrant(ir, row)
    assert.deepEqual(authorize(ir, store).allowed, [row.target])

    rewriteCommand(dir, { command: 'echo hello!' })
    const changed = readClaudePlugin(dir)
    const decision = authorize(changed, store)
    assert.equal(decision.refused[0].code, 'hash-mismatch')
    assert.equal(decision.refused[0].grantedHash, hashBytes('echo hello'))
    assert.equal(decision.refused[0].artifactHash, hashBytes('echo hello!'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file-plus-args command pins the file, not the argv that points at it', () => {
  const { dir, ir } = makePlugin({ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh', args: ['--flag', 'a'] })
  try {
    const [row] = classify(ir)
    assert.equal(row.mode, 'file')
    assert.equal(row.artifactHash, hashFile(join(dir, 'scripts', 'hook.sh')))
    const store = userGrant(ir, row)

    // Changing only the argv leaves the artifact bytes alone: the grant holds.
    rewriteCommand(dir, { command: '${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh', args: ['--flag', 'b'] })
    const rearg = readClaudePlugin(dir)
    assert.deepEqual(authorize(rearg, store).allowed, [row.target])

    // Changing the file it points at does not.
    const bytes = readFileSync(join(dir, 'scripts', 'hook.sh'))
    bytes[1] ^= 0x01
    writeFileSync(join(dir, 'scripts', 'hook.sh'), bytes)
    assert.equal(authorize(readClaudePlugin(dir), store).refused[0].code, 'hash-mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a compound shell command pins the text and every file it names', () => {
  const command = 'cat "${CLAUDE_PLUGIN_ROOT}/data.txt" | "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"'
  const { dir, ir } = makePlugin({ command })
  try {
    writeFileSync(join(dir, 'data.txt'), 'some data\n', 'utf8')
    const [row] = classify(ir)
    assert.equal(row.mode, 'inline')
    const store = userGrant(ir, row)

    // Editing the pipeline text invalidates.
    rewriteCommand(dir, { command: `${command} | cat` })
    assert.equal(authorize(readClaudePlugin(dir), store).refused[0].code, 'hash-mismatch')

    // So does editing the script the pipeline names, with the text restored.
    rewriteCommand(dir, { command })
    const bytes = readFileSync(join(dir, 'scripts', 'hook.sh'))
    bytes[bytes.length - 1] ^= 0x01
    writeFileSync(join(dir, 'scripts', 'hook.sh'), bytes)
    assert.equal(authorize(readClaudePlugin(dir), store).refused[0].code, 'hash-mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('grants.yml round-trips through the canonical form and refuses a malformed file with a line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-grants-'))
  try {
    const { ir } = makePlugin()
    const [row] = classify(ir)
    let store = userGrant(ir, row, 'project')
    store = revoke(store, { plugin: pluginIdentity(ir), capability: row.capability, target: row.target }, {
      scope: 'local',
    })
    const file = join(dir, 'grants.yml')
    writeGrants(file, store)
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^# dsh-anyplugin grants/m)
    assert.match(text, /^schema: "dsh-anyplugin\/grants@1"$/m)
    assert.deepEqual(readGrants(file), store)
    assert.deepEqual(readGrants(join(dir, 'missing.yml')), emptyGrants())
    assert.deepEqual(readdirSync(dir), ['grants.yml'], 'no temp file survives the rename')

    const roundTrip = serializeGrants(store)
    assert.match(roundTrip, /^revokes:/m)

    const hashLine = text.split('\n').findIndex((line) => line.includes('artifactHash:')) + 1
    const badHash = text.replace(row.artifactHash, 'sha256:not-hex')
    assert.throws(
      () => readGrants(write(file, badHash)),
      (error) =>
        error instanceof GrantsFileError &&
        error.line === hashLine &&
        /artifactHash/.test(error.message) &&
        error.message.startsWith(`${file}:${hashLine}:`),
    )

    const scopeLine = text.split('\n').findIndex((line) => line.includes('scope: "project"')) + 1
    const unknownField = text.replace('    scope: "project"', '    scopes: "project"')
    assert.throws(
      () => readGrants(write(file, unknownField)),
      (error) => error instanceof GrantsFileError && error.line === scopeLine && /unknown field "scopes"/.test(error.message),
    )
    assert.throws(
      () => readGrants(write(file, 'schema: "dsh-anyplugin/grants@1"\ngrants: []\n')),
      (error) => error instanceof GrantsFileError && /revokes/.test(error.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  function write(file, body) {
    writeFileSync(file, body, 'utf8')
    return file
  }
})

test('a grant for one plugin never authorizes identical bytes in another', () => {
  const first = makePlugin({ name: 'first' })
  const second = makePlugin({ name: 'second' })
  try {
    const firstRow = classify(first.ir)[0]
    const store = userGrant(first.ir, firstRow)
    assert.equal(authorize(second.ir, store).refused[0].code, 'no-grant')
    assert.notEqual(pluginIdentity(first.ir), pluginIdentity(second.ir))
  } finally {
    rmSync(first.dir, { recursive: true, force: true })
    rmSync(second.dir, { recursive: true, force: true })
  }
})

test('the report carries refused:exec, distinct from skipped', () => {
  const { dir, ir } = makePlugin()
  try {
    const refused = buildTransplantReport(ir, { materializers })
    assert.deepEqual(refused.totals, { declared: 1, emitted: 0, refused: 1, skipped: 0 })
    assert.equal(refused.components[0].surface, 'hooks')
    assert.equal(refused.components[0].class, 'planned')
    assert.equal(refused.components[0].refused, 'exec')
    assert.match(refused.components[0].reason, /no exec grant/)
    assert.match(refused.components[0].reason, /; command: .*hook\.sh/m)
    const text = formatTransplantReport(refused)
    assert.match(text, /^hooks\/PostToolUse#0 {2}class=planned {2}carry=refused:exec$/m)
    assert.match(text, /^ {2}reason: Not emitted: no exec grant for hook:PostToolUse#0 of claude-code:gated/m)
    assert.match(text, /^totals: 1 declared, 0 emitted, 1 refused, 0 skipped$/m)
    assert.equal(refused.ok, true, 'a refusal is not an IR validation failure')

    const [row] = classify(ir)
    const granted = buildTransplantReport(ir, { materializers, grants: userGrant(ir, row) })
    assert.deepEqual(granted.totals, { declared: 1, emitted: 1, refused: 0, skipped: 0 })
    assert.equal(granted.components[0].refused, undefined)
    assert.match(formatTransplantReport(granted), /^hooks\/PostToolUse#0 {2}class=equivalent {2}carry=emitted$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig report reads --grants and refuses without it', () => {
  const { dir, ir } = makePlugin()
  try {
    const [row] = classify(ir)
    const grantsFile = join(dir, 'grants.yml')
    writeGrants(grantsFile, userGrant(ir, row))

    const without = spawnSync(process.execPath, [rigPath, 'report', dir, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(without.status, 0, without.stderr)
    const denied = JSON.parse(without.stdout)
    assert.deepEqual(denied.totals, { declared: 1, emitted: 0, refused: 1, skipped: 0 })
    assert.equal(denied.components[0].refused, 'exec')

    const withGrants = spawnSync(process.execPath, [rigPath, 'report', dir, '--json', '--grants', grantsFile], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(withGrants.status, 0, withGrants.stderr)
    assert.deepEqual(JSON.parse(withGrants.stdout).totals, { declared: 1, emitted: 1, refused: 0, skipped: 0 })

    writeFileSync(grantsFile, 'schema: "dsh-anyplugin/grants@1"\ngrants: []\n', 'utf8')
    const malformed = spawnSync(process.execPath, [rigPath, 'report', dir, '--grants', grantsFile], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(malformed.status, 2)
    assert.match(malformed.stderr, /grants\.yml:\d+: expected a `revokes:` section/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
