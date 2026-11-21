// Trust gate (D25): grants pin the bytes that run, scope decides, and a
// refused hook must never appear in the entries the loader receives.
//
// These are filesystem tests on purpose. The rule is "hash, not path/mtime":
// the only convincing assertion flips a byte and watches the grant stop
// matching. The materializer cases execute harmless fixture scripts, because
// "both groups run" and "the edited bytes do not run" are behavioral claims.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
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

import { CLAUDE_CODE_PIN, readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { compileEntries, compileReport, reconcile } from '../../dsh-anyplugin-install/src/index.ts'
import { apply as applyHooks } from '../../dsh-anyplugin-materialize-hook/src/index.ts'
import {
  authorize,
  classify,
  emptyGrants,
  gate,
  grant,
  grantFor,
  hashManifest,
  pluginIdentity,
  parseGrants,
  readGrants,
  revoke,
  revokeFor,
  serializeGrants,
  updateGrants,
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
        pin: `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`,
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

test('a refused hook is in no entry and reconcile creates none', async () => {
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
    // the loader is handed no entry at all, not a disabled one and not a hook
    // that "did not run".
    const bytes = readFileSync(join(dir, 'scripts', 'hook.sh'))
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0x0a ? 0x21 : 0x0a
    writeFileSync(join(dir, 'scripts', 'hook.sh'), bytes)
    assert.deepEqual(compileEntries(installs, compileOptions(userGrant(ir, row))), [])

    const created = []
    const loader = {
      root: {},
      entries: () => [],
      resolve: () => { throw new Error('no entries') },
      await: async () => undefined,
      create: async (entry) => { created.push(entry) },
      update: async () => undefined,
      remove: () => {},
    }
    const report = compileReport(installs, compileOptions(undefined))
    const result = await reconcile(loader, report.entries, { decisions: report.decisions })
    assert.deepEqual(created, [])
    assert.equal(result.refused.length, 1)
    assert.equal(result.refused[0].target, row.target)
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
    assert.equal(row.mode, 'text')
    assert.equal(row.sourcePath, 'hooks/hooks.json')
    assert.equal(row.artifactHash, hashManifest(row.manifest))
    assert.equal(row.manifest.invocation, 'echo hello')
    assert.equal(row.manifest.command, '')
    assert.deepEqual(row.manifest.files, [])
    const store = userGrant(ir, row)
    assert.deepEqual(authorize(ir, store).allowed, [row.target])

    rewriteCommand(dir, { command: 'echo hello!' })
    const changed = readClaudePlugin(dir)
    const decision = authorize(changed, store)
    assert.equal(decision.refused[0].code, 'hash-mismatch')
    assert.equal(decision.refused[0].grantedHash, row.artifactHash)
    const [current] = classify(changed)
    assert.equal(decision.refused[0].artifactHash, current.artifactHash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file-plus-args command pins the program, not the data operand', () => {
  const { dir, ir } = makePlugin({ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh', args: ['${CLAUDE_PLUGIN_ROOT}/data.txt'] })
  try {
    writeFileSync(join(dir, 'data.txt'), 'one\n', 'utf8')
    const [row] = classify(ir)
    assert.equal(row.mode, 'composite')
    assert.deepEqual(row.manifest.files.map((file) => file.path), [join(dir, 'scripts', 'hook.sh')])
    assert.equal(row.artifactHash, hashManifest(row.manifest))
    const store = userGrant(ir, row)

    // Data bytes are not pinned: formatting an input in place is the ordinary
    // formatter hook and must not refuse itself.
    writeFileSync(join(dir, 'data.txt'), 'two\n', 'utf8')
    assert.deepEqual(authorize(readClaudePlugin(dir), store).allowed, [row.target])

    // The program is.
    const bytes = readFileSync(join(dir, 'scripts', 'hook.sh'))
    bytes[1] ^= 0x01
    writeFileSync(join(dir, 'scripts', 'hook.sh'), bytes)
    assert.equal(authorize(readClaudePlugin(dir), store).refused[0].code, 'hash-mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a compound shell command pins each program and leaves data bytes alone', () => {
  const command = 'cat "${CLAUDE_PLUGIN_ROOT}/data.txt" | "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"'
  const { dir, ir } = makePlugin({ command })
  try {
    writeFileSync(join(dir, 'data.txt'), 'some data\n', 'utf8')
    const [row] = classify(ir)
    assert.equal(row.mode, 'composite')
    assert.deepEqual(row.manifest.files.map((file) => file.path), [join(dir, 'scripts', 'hook.sh')])
    const store = userGrant(ir, row)

    // Editing data is not editing the program.
    writeFileSync(join(dir, 'data.txt'), 'other data\n', 'utf8')
    assert.deepEqual(authorize(readClaudePlugin(dir), store).allowed, [row.target])

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

test('exec-form args pin the program and hash the exact invocation', () => {
  const { dir, script, ir: initial } = makePlugin()
  try {
    const data = join(dir, 'data.txt')
    writeFileSync(data, 'one\n', 'utf8')
    rewriteCommand(dir, { command: 'node', args: [script, data, '--verbose'] })
    const execIr = readClaudePlugin(dir)
    const [row] = classify(execIr)
    assert.equal(row.mode, 'composite')
    assert.deepEqual(row.manifest.files.map((file) => file.path), [script], 'the program, not its data, is pinned')
    assert.equal(row.artifactHash, hashManifest(row.manifest))

    // Data bytes are not pinned.
    writeFileSync(data, 'two\n', 'utf8')
    assert.deepEqual(authorize(readClaudePlugin(dir), userGrant(execIr, row)).allowed, [row.target])

    // The invocation text is: a flag change is a different artifact.
    rewriteCommand(dir, { command: 'node', args: [script, data, '--quiet'] })
    assert.equal(authorize(readClaudePlugin(dir), userGrant(execIr, row)).refused[0].code, 'hash-mismatch')

    // The program bytes are.
    writeFileSync(script, '#!/bin/sh\necho changed\n', 'utf8')
    assert.equal(authorize(readClaudePlugin(dir), userGrant(execIr, row)).refused[0].code, 'hash-mismatch')
  } finally {
    assert.equal(initial.hooks.length, 1)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relative file operands are refused because hooks run in the project directory', () => {
  const { dir, ir: initial } = makePlugin()
  try {
    for (const command of [
      'cd "${CLAUDE_PLUGIN_ROOT}" && ./scripts/hook.sh',
      'sh scripts/hook.sh',
    ]) {
      rewriteCommand(dir, { command })
      const ir = readClaudePlugin(dir)
      const [row] = classify(ir)
      assert.match(row.unsupported, /program "\.?\/?scripts\/hook\.sh" is relative/)
      assert.match(row.unsupported, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hook\.sh/)
      const decision = authorize(ir, userGrant(ir, row))
      assert.deepEqual(decision.allowed, [])
      assert.equal(decision.refused[0].code, 'unsupported')
      assert.throws(() => grantFor(ir, emptyGrants(), row.target, { scope: 'user' }), /cannot be pinned/)
    }
    assert.equal(initial.hooks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a script outside the plugin root is refused, not hashed as path text', () => {
  const { dir } = makePlugin()
  const outsideDir = mkdtempSync(join(tmpdir(), 'anyplugin-outside-'))
  try {
    const outside = join(outsideDir, 'outside.sh')
    writeFileSync(outside, '#!/bin/sh\necho outside\n', 'utf8')
    rewriteCommand(dir, { command: outside })
    const ir = readClaudePlugin(dir)
    const [row] = classify(ir)
    assert.match(row.unsupported, /outside the plugin root/)
    assert.equal(row.manifest.files.length, 0)
    const decision = authorize(ir, userGrant(ir, row))
    assert.equal(decision.refused[0].code, 'unsupported')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('data operand order and duplicates are invocation text, not pinned files', () => {
  const { dir, ir: initial } = makePlugin()
  try {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    const program = join(dir, 'scripts', 'hook.sh')
    writeFileSync(a, 'a\n')
    writeFileSync(b, 'b\n')

    rewriteCommand(dir, { command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" ${a} ${b}` })
    const [forward] = classify(readClaudePlugin(dir))
    assert.deepEqual(forward.manifest.files.map((file) => file.path), [program])

    rewriteCommand(dir, { command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" ${b} ${a}` })
    const [backward] = classify(readClaudePlugin(dir))
    assert.deepEqual(backward.manifest.files.map((file) => file.path), [program])
    assert.notEqual(backward.artifactHash, forward.artifactHash, 'order stays in the invocation hash')

    // The same data file twice is two invocation words; the program is still one file.
    rewriteCommand(dir, { command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" ${a} ${a}` })
    const [twice] = classify(readClaudePlugin(dir))
    assert.deepEqual(twice.manifest.files.map((file) => file.path), [program])

    // A relative data operand is allowed: the hook's own cwd decides what it means.
    rewriteCommand(dir, { command: 'node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" a.txt b.txt' })
    const [relative] = classify(readClaudePlugin(dir))
    assert.equal(relative.unsupported, undefined)
    assert.deepEqual(relative.manifest.files.map((file) => file.path), [program])
    assert.equal(initial.hooks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('interpreter eval payloads are code: editing the payload refuses the grant', () => {
  const { dir, ir: initial } = makePlugin()
  try {
    const cases = [
      { first: 'sh -c \'printf one\'', second: 'sh -c \'printf two\'' },
      { first: 'node -e \'console.log(1)\'', second: 'node -e \'console.log(2)\'' },
      { first: 'node', args: ['-e', 'console.log(1)'], second: 'node', secondArgs: ['-e', 'console.log(2)'] },
    ]
    for (const item of cases) {
      rewriteCommand(dir, item.args === undefined ? { command: item.first } : { command: item.first, args: item.args })
      const ir = readClaudePlugin(dir)
      const [row] = classify(ir)
      assert.equal(row.mode, 'text')
      const store = userGrant(ir, row)

      const next = item.secondArgs === undefined
        ? { command: item.second }
        : { command: item.second, args: item.secondArgs }
      rewriteCommand(dir, next)
      const decision = authorize(readClaudePlugin(dir), store)
      assert.equal(decision.refused[0].code, 'hash-mismatch', `${item.first} must pin its payload`)
    }
    assert.equal(initial.hooks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hook writing --out under the root still runs twice: outputs are not artifacts', async () => {
  const { dir, script, ir } = makePlugin({ event: 'PreToolUse' })
  try {
    writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "${CLAUDE_PLUGIN_ROOT}/out.txt"\n', 'utf8')
    rewriteCommand(dir, {
      event: 'PreToolUse',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh --out ${CLAUDE_PLUGIN_ROOT}/out.txt',
    })
    const current = readClaudePlugin(dir)
    const [row] = classify(current)
    assert.deepEqual(row.manifest.files.map((file) => file.path), [script], 'the output flag value is not an operand')

    const report = compileReport(installsFor(current), compileOptions(userGrant(current, row)))
    const child = report.entries[0].config.find((entry) => entry.name === materializers.hooks)
    const handlers = new Map()
    const ctx = { logger: { warn() {} }, effect: (register) => register(), on: (event, handler) => handlers.set(event, handler) }
    applyHooks(ctx, child.config)
    let calls = 0
    const invoke = () => handlers.get('tools/pre-execute')(
      { callId: 1, name: 'Write', arguments: {} },
      async () => { calls += 1; return { kind: 'accept' } },
    )
    assert.deepEqual(await invoke(), { kind: 'accept' })
    assert.deepEqual(await invoke(), { kind: 'accept' })
    assert.equal(calls, 2)
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim().split('\n').length, 2)
    assert.equal(ir.hooks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('grantFor and revokeFor reject a target that the plugin does not declare', () => {
  const { dir, ir } = makePlugin()
  try {
    assert.throws(
      () => grantFor(ir, emptyGrants(), 'hook:BogusEvent#9', { scope: 'user' }),
      (error) => error.name === 'GrantTargetError' && /known targets: hook:PostToolUse#0/.test(error.message),
    )
    assert.throws(
      () => revokeFor(ir, emptyGrants(), 'bin:missing', { scope: 'local' }),
      (error) => error.name === 'GrantTargetError' && /no exec artifact/.test(error.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classify covers bin, monitor and mod files with file manifests', () => {
  const { dir, ir: initial } = makePlugin()
  try {
    for (const [directory, name] of [['bin', 'tool.js'], ['monitors', 'watch.mjs'], ['mods', 'index.js']]) {
      mkdirSync(join(dir, directory, 'nested'), { recursive: true })
      writeFileSync(join(dir, directory, 'nested', name), `// ${name}\n`)
    }
    const ir = readClaudePlugin(dir)
    const rows = classify(ir)
    const byTarget = new Map(rows.map((row) => [row.target, row]))
    for (const [directory, prefix, name] of [['bin', 'bin', 'tool.js'], ['monitors', 'monitor', 'watch.mjs'], ['mods', 'mod', 'index.js']]) {
      const row = byTarget.get(`${prefix}:nested/${name}`)
      assert.ok(row, `${prefix}:nested/${name} must be classified`)
      assert.equal(row.mode, 'file')
      assert.equal(row.manifest.files[0].path, join(dir, directory, 'nested', name))
      assert.equal(row.artifactHash, hashManifest(row.manifest))
      assert.ok(grantFor(ir, emptyGrants(), row.target, { scope: 'user' }))
    }

    const before = byTarget.get('bin:nested/tool.js').artifactHash
    writeFileSync(join(dir, 'bin', 'nested', 'tool.js'), '// changed\n')
    const after = classify(readClaudePlugin(dir)).find((row) => row.target === 'bin:nested/tool.js')
    assert.notEqual(after.artifactHash, before)
    assert.equal(initial.hooks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a grant and a revoke at the same scope refuse: revoke wins', () => {
  const { dir, ir } = makePlugin()
  try {
    const [row] = classify(ir)
    const spec = {
      plugin: pluginIdentity(ir),
      capability: row.capability,
      target: row.target,
      artifactHash: row.artifactHash,
    }
    const store = revoke(grant(emptyGrants(), spec, { scope: 'local' }), {
      plugin: spec.plugin,
      capability: spec.capability,
      target: spec.target,
    }, { scope: 'local' })
    const decision = authorize(ir, store)
    assert.deepEqual(decision.allowed, [])
    assert.equal(decision.refused[0].code, 'revoked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classify refuses two artifacts with the same target instead of silently gating one', () => {
  const { dir, ir } = makePlugin()
  try {
    const duplicate = { ...ir, hooks: [ir.hooks[0], { ...ir.hooks[0] }] }
    assert.throws(() => classify(duplicate), /duplicate exec target "hook:PostToolUse#0"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two matcher groups under one event keep distinct per-event indexes and both run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-trust-groups-'))
  try {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    mkdirSync(join(dir, 'hooks'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'groups', version: '0.0.1' })}\n`)
    writeFileSync(
      join(dir, 'hooks', 'hooks.json'),
      `${JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Write', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/one.sh"' }] },
            { matcher: 'Write', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/two.sh"' }] },
          ],
        },
      }, null, 2)}\n`,
    )
    for (const name of ['one', 'two']) {
      const script = join(dir, 'scripts', `${name}.sh`)
      writeFileSync(script, `#!/bin/sh\necho '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"${name}"}}'\n`)
      chmodSync(script, 0o755)
    }
    const ir = readClaudePlugin(dir)
    assert.deepEqual(ir.hooks.map((hook) => hook.index), [0, 1])
    const rows = classify(ir)
    assert.deepEqual(rows.map((row) => row.target), ['hook:PostToolUse#0', 'hook:PostToolUse#1'])

    let store = emptyGrants()
    for (const row of rows) {
      store = grant(store, { plugin: pluginIdentity(ir), capability: row.capability, target: row.target, artifactHash: row.artifactHash }, { scope: 'user' })
    }
    const gated = gate(ir, store)
    const emitted = emitPlugin(gated.ir, { materializers, trusted: gated.decision.allowed })
    const hookChild = emitted.entry?.config.find((child) => child.name === materializers.hooks)
    assert.equal(hookChild?.config.hooks.length, 2)

    const handlers = new Map()
    const warnings = []
    const ctx = {
      logger: { warn: (message) => warnings.push(message) },
      effect: (register) => register(),
      on: (event, handler) => handlers.set(event, handler),
    }
    applyHooks(ctx, hookChild.config)
    const post = handlers.get('tools/post-execute')
    const decision = await post({ callId: 1, name: 'Write', arguments: {} }, { ok: true }, async () => ({ kind: 'accept' }))
    const texts = (decision.additionalContexts ?? []).map((context) => context.content[0].text)
    assert.deepEqual(texts.sort(), ['one', 'two'])
    assert.deepEqual(warnings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('editing the artifact after load refuses the next call; a re-pin lets the new bytes run', async () => {
  const { dir, script, ir } = makePlugin({ event: 'PreToolUse' })
  try {
    const [row] = classify(ir)
    const configFor = (store) => {
      const report = compileReport(installsFor(ir), compileOptions(store))
      const child = report.entries[0].config.find((entry) => entry.name === materializers.hooks)
      return child.config
    }
    const mount = (config) => {
      const handlers = new Map()
      const ctx = { logger: { warn() {} }, effect: (register) => register(), on: (event, handler) => handlers.set(event, handler) }
      applyHooks(ctx, config)
      return handlers
    }
    let handlers = mount(configFor(userGrant(ir, row)))
    let calls = 0
    const invoke = () => handlers.get('tools/pre-execute')(
      { callId: 1, name: 'Write', arguments: {} },
      async () => { calls += 1; return { kind: 'accept' } },
    )

    const emitted = handlers.size === 1 ? configFor(userGrant(ir, row)) : undefined
    assert.equal(emitted.hooks[0].index, row.target.slice('hook:PostToolUse#'.length) | 0)
    assert.equal(emitted.hooks[0].artifactHash, row.artifactHash)
    assert.equal(emitted.hooks[0].artifactMode, 'file')
    assert.equal(emitted.hooks[0].artifactRoot, dir)
    assert.deepEqual(emitted.hooks[0].artifact, row.manifest)

    assert.deepEqual(await invoke(), { kind: 'accept' })
    assert.equal(calls, 1)

    writeFileSync(script, '#!/bin/sh\necho changed\n', 'utf8')
    const refused = await invoke()
    assert.equal(refused.kind, 'deny')
    assert.match(refused.reason, /artifact changed since the grant \(pinned sha256:[0-9a-f]+, now sha256:[0-9a-f]+\)/)
    assert.match(refused.reason, /command: .*scripts\/hook\.sh/)
    assert.equal(calls, 1, 'the changed bytes must not run')

    // What a re-grant followed by reconcile does: classify the edited bytes,
    // grant the new manifest, compile again and mount that child config.
    const [changedRow] = classify(readClaudePlugin(dir))
    handlers = mount(configFor(userGrant(ir, changedRow)))
    assert.deepEqual(await invoke(), { kind: 'accept' })
    assert.equal(calls, 2)

    // A missing artifact is refused too, not an exception in the waterfall.
    rmSync(script)
    const missing = await invoke()
    assert.equal(missing.kind, 'deny')
    assert.match(missing.reason, /artifact cannot be re-hashed/)
    assert.equal(calls, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PostToolUse warns and skips an edited artifact; a re-grant and recompile lets it run', async () => {
  const { dir, script, ir } = makePlugin({ event: 'PostToolUse' })
  const marker = join(dir, 'ran.log')
  const runs = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0)
  try {
    writeFileSync(script, `#!/bin/sh\nprintf 'run\\n' >> ${JSON.stringify(marker)}\n`, 'utf8')
    const [row] = classify(readClaudePlugin(dir))
    const loader = {
      root: {},
      entries: () => [],
      resolve: () => { throw new Error('no entries') },
      await: async () => undefined,
      create: async () => undefined,
      update: async () => undefined,
      remove: () => {},
    }
    const configFor = async (store) => {
      const report = compileReport(installsFor(ir), compileOptions(store))
      const result = await reconcile(loader, report.entries, { decisions: report.decisions })
      assert.deepEqual(result.refused, [])
      return report.entries[0].config.find((entry) => entry.name === materializers.hooks).config
    }
    const mount = (config) => {
      const handlers = new Map()
      const warnings = []
      const ctx = {
        logger: { warn: (message) => warnings.push(message) },
        effect: (register) => register(),
        on: (event, handler) => handlers.set(event, handler),
      }
      applyHooks(ctx, config)
      return { handlers, warnings }
    }
    let mounted = mount(await configFor(userGrant(ir, row)))
    const invoke = () => mounted.handlers.get('tools/post-execute')(
      { callId: 1, name: 'Write', arguments: {} },
      {},
      async () => ({ kind: 'accept', additionalContexts: [] }),
    )

    assert.deepEqual(await invoke(), { kind: 'accept', additionalContexts: [] })
    assert.equal(runs(), 1)

    writeFileSync(script, `#!/bin/sh\n# changed\nprintf 'run\\n' >> ${JSON.stringify(marker)}\n`, 'utf8')
    const warned = await invoke()
    assert.equal(warned.kind, 'accept')
    assert.equal(runs(), 1, 'the changed bytes must not run')
    assert.equal(warned.additionalContexts.length, 1)
    assert.match(warned.additionalContexts[0].content[0].text, /artifact changed since the grant/)
    assert.match(mounted.warnings.join('\n'), /artifact changed since the grant/)

    const [changedRow] = classify(readClaudePlugin(dir))
    mounted = mount(await configFor(userGrant(ir, changedRow)))
    assert.deepEqual(await invoke(), { kind: 'accept', additionalContexts: [] })
    assert.equal(runs(), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('compileReport keeps trusted and refused decisions; reconcile surfaces refusals without an entry', async () => {
  const trusted = makePlugin({ name: 'trusted' })
  const refused = makePlugin({ name: 'refused' })
  try {
    const installs = {
      schema: 'dsh-anyplugin/installs@1',
      plugins: [...installsFor(trusted.ir).plugins, ...installsFor(refused.ir).plugins],
    }
    const enablements = {
      user: { plugins: {
        'claude-code:trusted': { enabled: true, grants: [] },
        'claude-code:refused': { enabled: true, grants: [] },
      } },
    }
    const [row] = classify(trusted.ir)
    const report = compileReport(installs, {
      materializers,
      enablements,
      grants: userGrant(trusted.ir, row),
    })
    assert.equal(report.entries.length, 1)
    assert.equal(report.entries[0].id, 'anyplugin.claude-code~3atrusted')
    assert.equal(report.decisions.length, 2)
    const refusedDecision = report.decisions.find((decision) => decision.plugin === 'claude-code:refused')
    assert.equal(refusedDecision.refused.length, 1)
    assert.equal(refusedDecision.refused[0].code, 'no-grant')

    const seen = []
    const result = await reconcile(
      {
        root: {},
        entries: () => [],
        resolve: () => { throw new Error('no entries') },
        await: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        remove: () => {},
      },
      [],
      { decisions: report.decisions, onRefused: (rows) => seen.push(...rows) },
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0].plugin, 'claude-code:refused')
    assert.equal(seen[0].target, 'hook:PostToolUse#0')
    assert.deepEqual(result.refused, seen)

    // An unknown dialect is a per-record problem, not a whole-lock abort.
    const unknown = {
      ...installs,
      plugins: [...installs.plugins, { ...installs.plugins[0], name: 'unknown', dialect: 'cursor' }],
    }
    const withUnknown = {
      user: { plugins: { ...enablements.user.plugins, 'cursor:unknown': { enabled: true, grants: [] } } },
    }
    const withProblems = compileReport(unknown, {
      materializers,
      enablements: withUnknown,
      grants: userGrant(trusted.ir, row),
    })
    assert.equal(withProblems.entries.length, 1)
    assert.equal(withProblems.problems.length, 1)
    assert.match(withProblems.problems[0].reason, /unsupported dialect "cursor" \(installed dialects: claude-code, codex\)/)
  } finally {
    rmSync(trusted.dir, { recursive: true, force: true })
    rmSync(refused.dir, { recursive: true, force: true })
  }
})

test('a malformed store rejects an unknown capability at its own line', () => {
  const { dir, ir } = makePlugin()
  try {
    const [row] = classify(ir)
    const text = serializeGrants(userGrant(ir, row)).replace('capability: "exec"', 'capability: "exev"')
    const line = text.split('\n').findIndex((candidate) => candidate.includes('capability: "exev"')) + 1
    assert.throws(
      () => parseGrants(text, 'grants.yml'),
      (error) => error instanceof GrantsFileError && error.line === line && /capability.*exec/.test(error.reason),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent writers through updateGrants keep every grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-trust-lock-'))
  const file = join(dir, 'grants.yml')
  try {
    writeGrants(file, emptyGrants())
    const moduleUrl = pathToFileURL(join(repoRoot, 'packages', 'dsh-anyplugin-trust', 'src', 'grants.ts')).href
    const worker = (tag) => [
      `import { updateGrants, grant } from ${JSON.stringify(moduleUrl)};`,
      `const file = ${JSON.stringify(file)};`,
      'for (let i = 0; i < 4; i += 1) {',
      '  updateGrants(file, (store) => grant(store, {',
      "    plugin: 'claude-code:concurrent', capability: 'exec',",
      `    target: ${JSON.stringify(`hook:PostToolUse#${tag}`)} + i,`,
      `    artifactHash: 'sha256:${'0'.repeat(64)}',`,
      "  }, { scope: 'user' }));",
      '}',
    ].join('\n')
    const run = (code) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: repoRoot, stdio: 'inherit' })
      child.on('error', reject)
      child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`writer exited ${status}`)))
    })
    await Promise.all([run(worker('a')), run(worker('b'))])
    assert.equal(readGrants(file).grants.length, 8, 'a lock, not last-rename-wins')
    assert.equal(readdirSync(dir).some((entry) => entry.endsWith('.lock')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit copies the gate artifact and never re-resolves after authorize', () => {
  const { dir, script, ir } = makePlugin()
  try {
    const [row] = classify(ir)
    const store = userGrant(ir, row)
    const decision = authorize(ir, store)
    assert.deepEqual(decision.allowed, [row.target])

    // Race: the script changes after authorize but before emit. The original IR
    // carries no attached artifact, so emit must fail closed.
    writeFileSync(script, '#!/bin/sh\necho new bytes\n', 'utf8')
    const emitted = emitPlugin(ir, { materializers, trusted: decision.allowed })
    assert.equal(emitted.entry, null, 'no child may be emitted for an unresolved trusted hook')
    assert.deepEqual(emitted.refused, ['hooks/PostToolUse#0'])

    // With the artifact attached before the edit, emit copies exactly what the
    // gate resolved; it does not re-resolve the changed script.
    const current = readClaudePlugin(dir)
    const [currentRow] = classify(current)
    const gated = gate(current, userGrant(current, currentRow))
    writeFileSync(script, '#!/bin/sh\necho newer bytes\n', 'utf8')
    const copied = emitPlugin(gated.ir, { materializers, trusted: gated.decision.allowed })
    const hookChild = copied.entry?.config.find((child) => child.name === materializers.hooks)
    assert.equal(hookChild?.config.hooks[0].artifactHash, gated.decision.rows[0].artifactHash)
    assert.notEqual(hookChild?.config.hooks[0].artifactHash, classify(readClaudePlugin(dir))[0].artifactHash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('positional outputs and redirects are data: a hook runs twice and updates them', async () => {
  const { dir, script } = makePlugin({ event: 'PreToolUse' })
  const mount = (ir, store) => {
    const report = compileReport(installsFor(ir), compileOptions(store))
    const child = report.entries[0].config.find((entry) => entry.name === materializers.hooks)
    const handlers = new Map()
    const ctx = { logger: { warn() {} }, effect: (register) => register(), on: (event, handler) => handlers.set(event, handler) }
    applyHooks(ctx, child.config)
    let calls = 0
    return {
      invoke: () => handlers.get('tools/pre-execute')(
        { callId: 1, name: 'Write', arguments: {} },
        async () => { calls += 1; return { kind: 'accept' } },
      ),
      calls: () => calls,
    }
  }
  try {
    writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "${CLAUDE_PLUGIN_ROOT}/out.txt"\n', 'utf8')
    rewriteCommand(dir, {
      event: 'PreToolUse',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh ${CLAUDE_PLUGIN_ROOT}/out.txt',
    })
    const positional = readClaudePlugin(dir)
    const [positionalRow] = classify(positional)
    assert.deepEqual(positionalRow.manifest.files.map((file) => file.path), [script])
    const first = mount(positional, userGrant(positional, positionalRow))
    assert.deepEqual(await first.invoke(), { kind: 'accept' })
    assert.deepEqual(await first.invoke(), { kind: 'accept' })
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim().split('\n').length, 2)
    assert.equal(first.calls(), 2)

    writeFileSync(script, '#!/bin/sh\necho redirected\n', 'utf8')
    rewriteCommand(dir, {
      event: 'PreToolUse',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh > ${CLAUDE_PLUGIN_ROOT}/redirect.txt',
    })
    const redirect = readClaudePlugin(dir)
    const [redirectRow] = classify(redirect)
    assert.deepEqual(redirectRow.manifest.files.map((file) => file.path), [script])
    const second = mount(redirect, userGrant(redirect, redirectRow))
    assert.deepEqual(await second.invoke(), { kind: 'accept' })
    assert.deepEqual(await second.invoke(), { kind: 'accept' })
    assert.equal(readFileSync(join(dir, 'redirect.txt'), 'utf8').trim(), 'redirected')
    assert.equal(second.calls(), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
