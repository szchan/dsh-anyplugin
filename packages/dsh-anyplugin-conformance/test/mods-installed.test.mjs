// #114's proof, end to end through the product: the fetched `diff` mod is
// installed by the lifecycle CLI with a granted tree, the lock carries the
// manifest, `compileEntries` seats it as data on the hook row, and a real boot
// loads it through `loadMod` and reaches the kernel's `runChain`.
//
// What each assertion is allowed to claim:
// - the lock paragraph is the writer's output, read back through the strict
//   `@2` parser (`readInstalls`);
// - the group entry is what `emitPlugin` produced from the lock, not a row a
//   test wrote by hand — the only thing the test adds is `traceFile`, which is
//   read-only instrumentation owned by the materializer;
// - `loaded N registration(s)` is the materializer's own gate line (the same
//   one `check:pack` reads), written after `loadMod` resolved;
// - a `session.start` trace step with `plugin: 'diff/hooks/register.ts'` and
//   `status: 'ran'` means `runChain` invoked the authored handler. That handler
//   awaits `startedAtOf` (→ `$.session.usage` / `$.clock.now`) and
//   `$.command.register` before returning, so a `$` call that was not served
//   would surface as `status: 'error'` with the bridge's reason.

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { defaultMaterializers } from '../../dsh-anyplugin-emit/src/index.ts'
import { compileEntries, readInstalls } from '../../dsh-anyplugin-install/src/index.ts'
import { DIFF_MOD_PIN } from '../../dsh-anyplugin-mod-host/src/pin.ts'
import { emptyGrants, grantFor, readGrants, writeGrants } from '../../dsh-anyplugin-trust/src/index.ts'
import { installPlugin } from '../src/install-cli.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'
import { probeLifecycleWithDsh } from '../src/oracles/dsh.ts'

const repoRoot = realpathSync(new URL('../../..', import.meta.url).pathname)
const harness = resolveHarness()
const modsTree = process.env.ANYPLUGIN_MODS_TREE ?? join(repoRoot, '.mods', DIFF_MOD_PIN.commit)
const pluginRoot = join(modsTree, 'mods', 'diff')
const skip =
  harness !== undefined && existsSync(join(pluginRoot, '.claude-plugin', 'plugin.json'))
    ? false
    : (harnessSkipReason() === undefined
        ? `the diff mod is not fetched: run \`node scripts/fetch-mod.mjs\` (expected ${pluginRoot})`
        : harnessSkipReason())

/** One streamed JSONL record: a chain, a warning, or a typed gap. */
function readTrace(traceFile) {
  return readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

function bashTool(calls) {
  return {
    name: 'Bash',
    description: 'run a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (input) => {
      calls.push(input)
      return 'ran'
    },
  }
}

test('the installed diff mod loads through the lock and its handler runs on runChain', { skip }, async () => {
  const box = mkdtempSync(join(tmpdir(), 'anyplugin-mods-installed-'))
  const home = join(box, 'home')
  const projectDir = join(box, 'project')
  const grantsFile = join(home, 'anyplugin', 'grants.yml')
  const traceFile = join(box, 'trace.jsonl')
  mkdirSync(home, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  const calls = []
  try {
    // 1. The tree is a real grant target: the dialect reads the entry, the
    //    trust layer pins the authored bytes, and the grant names both.
    const ir = readClaudePlugin(pluginRoot)
    const mod = (ir.mods ?? [])[0]
    assert.ok(mod, 'the pinned plugin declares one module')
    assert.equal(mod.entry, 'hooks/register.ts')
    assert.equal(mod.rootRelative, 'hooks')
    assert.equal(readFileSync(join(pluginRoot, 'hooks', 'register.ts')).byteLength, DIFF_MOD_PIN.entryBytes)

    writeGrants(grantsFile, grantFor(ir, emptyGrants(), 'mod:hooks/register.ts', { scope: 'user' }))

    // 2. Install through the product. The lock paragraph is the product's own
    //    writer output, then read back through the strict reader.
    const installed = installPlugin({ pluginDir: pluginRoot, home, projectDir })
    assert.equal(installed.ok, true)
    const recorded = installed.record.mods ?? []
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].entry, 'hooks/register.ts')
    assert.equal(recorded[0].rootRelative, 'hooks')
    assert.equal(recorded[0].mode, 'composite')
    assert.match(recorded[0].artifactHash, /^sha256:[0-9a-f]{64}$/)
    assert.ok(recorded[0].files.length > 500, 'the whole authored hooks/ tree is pinned')
    const lock = readInstalls(installed.lockFile)
    assert.deepEqual(lock.plugins[0].mods, recorded)

    // 3. Compile the lock exactly as the controller does: the mod reaches the
    //    hook row as data, with the manifest the grant pinned.
    const entries = compileEntries(lock, {
      materializers: defaultMaterializers(),
      home,
      projectDir,
      grants: readGrants(grantsFile),
    })
    const group = entries.find((entry) => entry.group === true)
    assert.ok(group, 'the lock compiles to one group entry')
    const hookChild = group.config.find((child) => String(child.id).endsWith('#hook'))
    assert.ok(hookChild, 'the mod rides the hook row')
    assert.equal(hookChild.config.mods?.length, 1)
    assert.equal(hookChild.config.mods[0].entry, 'hooks/register.ts')
    assert.equal(hookChild.config.mods[0].artifactHash, recorded[0].artifactHash)

    // 4. Boot. `traceFile` is instrumentation, not plugin data: the entry came
    //    from the lock; the materializer only writes what it did.
    hookChild.config.traceFile = traceFile
    await probeLifecycleWithDsh({
      harnessDir: harness.harnessDir,
      entry: group,
      expected: [],
      tool: bashTool(calls),
      toolCall: { id: 'call_bash', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
      timeoutMs: 30_000,
    })

    const trace = readTrace(traceFile)
    const loaded = trace.find(
      (record) => typeof record.warning === 'string' && /loaded \d+ registration\(s\)/.test(record.warning),
    )
    assert.ok(loaded, 'the materializer names the load it performed')
    assert.match(loaded.warning, /diff\/hooks\/register\.ts/)
    const loadedCount = Number(/loaded (\d+) registration\(s\)/.exec(loaded.warning)?.[1])
    assert.equal(loadedCount, 11, 'the whole graph registers, not a partial load')

    const starts = trace.filter((record) => record.event === 'session.start')
    assert.equal(starts.length, 1, 'session.start fires once for the load')
    const steps = starts[0].trace.filter((step) => step.source.startsWith('diff/hooks/register.ts#'))
    assert.equal(steps.length, 1, 'the mod registration is in the session.start chain')
    assert.equal(steps[0].status, 'ran', JSON.stringify(starts[0]))
    assert.equal(steps[0].plugin, 'diff', 'the row names the plugin, so the trace is attributable')
    assert.ok(
      starts[0].sources.some((source) => source.includes('diff/hooks/register.ts')),
      'the chain names the mod as a source',
    )
    // The handler awaits startedAtOf(), which reads $.session.usage(): the
    // served call is visible as its typed gap warnings, and the handler still
    // returns (status 'ran'), so the host-side call resolved rather than threw.
    assert.ok(
      trace.some(
        (record) =>
          typeof record.warning === 'string' &&
          record.warning.includes('diff/hooks/register.ts: $.session.usage()'),
      ),
      'an authored $ call was served and reported its gaps',
    )
    assert.equal(
      starts[0].trace.some((step) => step.status === 'error'),
      false,
      'every seated handler resolved its awaited $ calls',
    )
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})
