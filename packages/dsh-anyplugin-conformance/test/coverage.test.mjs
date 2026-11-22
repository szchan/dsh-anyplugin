// Coverage ratchet: how much of each fixture's declared surface survives the
// transplant today.
//
// This test is deliberately *allowed* to be red for a while — it is the visible
// burn-down for "100 % fidelity". Each fixture states its exact row set, so
// closing a gap means editing this file (a reviewable act) and a regression
// fails immediately. The totals are the number the project reports: matched
// components over declared components, never a percentage of "things we tried".

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { startHttpServer } from '../../../fixtures/claude-mcp-http/http-server.mjs'
import { defaultMaterializers, emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import {
  classify,
  emptyGrants,
  gate,
  grant,
  pluginIdentity,
} from '../../dsh-anyplugin-trust/src/index.ts'
import { diffInventories, emptyInventory } from '../src/inventory.ts'
import { CLAUDE_CODE_PIN } from '../src/pin.ts'
import { probeLifecycleWithDsh, probeWithDsh } from '../src/oracles/dsh.ts'
import { probeSeams } from './lifecycle.test.mjs'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harness = resolveHarness()
const materializers = defaultMaterializers()

/**
 * What the transplant produces per fixture, as of this commit. Closing a gap
 * must move rows from `missing` to `match` here — in the same commit that makes
 * it true.
 */
const EXPECTED_ROWS = {
  'claude-agents': ['agents:reviewer:match'],
  'claude-command-nested': [],
  'claude-commands-flat': ['skills:migrate:match', 'skills:review:match'],
  'claude-hooks-lifecycle': [
    'hooks:SessionEnd:match',
    'hooks:SessionStart:match',
    'hooks:Stop:match',
    'hooks:SubagentStart:match',
    'hooks:SubagentStop:match',
  ],
  'claude-hooks-mcp': ['hooks:PostToolUse:match', 'mcpServers:probe:match'],
  'claude-hooks-seams': [
    'hooks:ConfigChange:match',
    'hooks:CwdChanged:match',
    'hooks:FileChanged:match',
    'hooks:PermissionDenied:match',
    'hooks:PermissionRequest:match',
    'hooks:PostCompact:match',
    'hooks:PostToolUseFailure:match',
    'hooks:PreCompact:match',
    'hooks:StopFailure:match',
    'hooks:TaskCompleted:match',
    'hooks:TaskCreated:match',
    'hooks:UserPromptSubmit:match',
    'hooks:WorktreeCreate:match',
    'hooks:WorktreeRemove:match',
  ],
  'claude-mcp-budget': ['mcpServers:a-server-name-that-is-long-enough:refused'],
  'claude-mcp-http': ['mcpServers:http-probe:match'],
  'claude-mcp-tool-budget': ['mcpServers:probe:match'],
  // A monitors declaration never contributes a monitor row: the pinned client
  // prints no Monitors line (S22/D37). A valid declaration contributes nothing
  // on its own; a file-shaped rejection is carried as an 'unsupported' IR row
  // and still loads the plugin, so the row measured here is the sibling
  // component the directory client serves. The two fixtures without a sibling
  // expose no component at all and are listed in FIXTURE_EXCLUSIONS instead of
  // owning an empty row.
  'claude-monitors-valid': ['skills:greet:match'],
  'claude-monitors-bad-key': ['skills:innocent:match'],
  'claude-root-skill': ['skills:rooty:match'],
  'claude-skills-only': ['skills:greet:match', 'skills:hello:match'],
}

/**
 * The numbers `docs/FEATURES.md` repeats. `scripts/count-owners.mjs` reads this
 * object and compares every doc claim against it; the totals test below asserts
 * the live matrix produces exactly these values, so the doc and the suite move
 * together. Closing a row moves this object in the same commit.
 */
export const EXPECTED_COUNTS = { declared: 32, matched: 31, missing: 0, refused: 1, rows: 13 }

/**
 * Hooks are the one surface whose presence is not readable from a registry:
 * a hook that is mounted and one that is not both leave no trace. So the
 * fixture with a hook gets one real call through the pipeline, and its row is
 * reported as matched only when the hook's own text came back on the result.
 */
const HOOK_PROBES = {
  'claude-hooks-mcp': { tool: 'Write', marker: 'anyplugin-hook: PostToolUse fired', component: 'hooks:PostToolUse' },
}

/**
 * Lifecycle hooks are not readable from any registry either, and unlike a tool
 * hook there is no result to carry their text. The fixture's handlers append
 * one line per event to `$CLAUDE_PLUGIN_DATA/events.log`, so the row is the log
 * line itself: one real root turn plus one delegated child must produce exactly
 * these five lines. The host dispatches `subagent/start` before `subagent/end`
 * but does not await the listener; the hook materializer holds the stop chain
 * for the same child until the start chain settles, so the asserted
 * SubagentStart-before-SubagentStop order is a kernel guarantee within one
 * materializer load (S9). SessionEnd remains an independent emit and is
 * compared as a set member, not an order.
 */
const LIFECYCLE_PROBES = {
  'claude-hooks-lifecycle': {
    events: ['SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd'],
  },
}

/**
 * The four listener seams and the five notification records have no registry
 * face: their rows are the lines the handlers wrote on one real turn. The probe
 * lives in `lifecycle.test.mjs` because the oracle's fixed composition has no
 * approval, filesystem or compaction service; importing it here keeps the
 * matrix measured rather than guessed.
 */
const SEAMS_PROBES = {
  'claude-hooks-seams': {
    events: [
      'UserPromptSubmit',
      'PermissionRequest',
      'PostToolUseFailure',
      'FileChanged',
      'PreCompact',
      'PostCompact',
      'PermissionDenied',
      'CwdChanged',
      'ConfigChange',
      'TaskCreated',
      'TaskCompleted',
      'WorktreeCreate',
      'WorktreeRemove',
      'StopFailure',
    ],
  },
}

/**
 * Fixtures that cannot answer without a live process. Keeping them in the same
 * ratchet matters: "declared" is what the golden says, and excluding the HTTP
 * arm would quietly shrink the denominator.
 */
const PREPARE = {
  async 'claude-mcp-http'() {
    const server = await startHttpServer()
    const previous = process.env.ANYPLUGIN_MCP_URL
    process.env.ANYPLUGIN_MCP_URL = server.url
    return () => {
      if (previous === undefined) delete process.env.ANYPLUGIN_MCP_URL
      else process.env.ANYPLUGIN_MCP_URL = previous
      return server.close()
    }
  },
}

async function inventoryFor(fixture) {
  const dir = join(repoRoot, 'fixtures', fixture)
  const ir = readClaudePlugin(dir, { source: `plugin-dir:fixtures/${fixture}` })
  // The inventory measures behaviour, so the hooks in it must be granted the
  // way an install would: mint a store from the current classification, gate,
  // and emit only the authorized targets.
  let grants = emptyGrants()
  for (const row of classify(ir)) {
    grants = grant(grants, { plugin: pluginIdentity(ir), ...row }, { scope: 'user' })
  }
  const gated = gate(ir, grants)
  const lifecycle = LIFECYCLE_PROBES[fixture]
  const seams = SEAMS_PROBES[fixture]
  let dataDir
  try {
    if (lifecycle !== undefined || seams !== undefined) dataDir = mkdtempSync(join(tmpdir(), `anyplugin-${fixture}-`))
    const { entry } = emitPlugin(gated.ir, {
      materializers,
      sdkRoot: harness?.modulesDir,
      trusted: gated.decision.allowed,
      ...(dataDir === undefined ? {} : { dataDir }),
    })
    const refused = new Set((ir.unsupported ?? []).map((item) => `${item.surface}:${item.name}`))
    if (!entry) {
      const inventory = emptyInventory({ name: ir.plugin.name, source: `dsh:${harness.version}` })
      inventory.pin = { tool: 'dsh', version: harness.version }
      return { inventory, refused }
    }
    if (lifecycle !== undefined) {
      const observed = await probeLifecycleWithDsh({
        harnessDir: harness.harnessDir,
        entry,
        expected: lifecycle.events,
        timeoutMs: 10_000,
      })
      // One line each: a duplicate is a mount that fired twice, and a missing
      // label was already failed by the probe with the lines it did see.
      assert.deepEqual(
        [...observed.events].sort(),
        [...lifecycle.events].sort(),
        `${fixture}: every handler wrote exactly one line`,
      )
      // Only the two partial orders S9 claims are asserted: the root chain
      // (SessionStart/Stop/SessionEnd) and the kernel-enforced subagent pair
      // (see the note above). The child's end and the root's disposal may
      // interleave.
      const position = (name) => observed.events.indexOf(name)
      const before = (first, second) =>
        assert.ok(
          position(first) >= 0 && position(second) > position(first),
          `${first} must be written before ${second}; log: ${observed.events.join(', ')}`,
        )
      before('SessionStart', 'Stop')
      before('Stop', 'SessionEnd')
      before('SubagentStart', 'SubagentStop')

      // The payload the handler saw, not just the event: this pins the fields
      // the host really carries and records the gaps the dialect names.
      const payload = (name) => JSON.parse(readFileSync(join(observed.dataDir, 'payloads', `${name}.json`), 'utf8'))
      const keys = (name) => Object.keys(payload(name)).sort()
      const start = payload('SessionStart')
      assert.deepEqual(keys('SessionStart'), ['cwd', 'hook_event_name', 'model', 'session_id', 'source'])
      assert.equal(start.hook_event_name, 'SessionStart')
      assert.equal(start.source, 'startup')
      assert.equal(start.session_id, 'anyplugin-lifecycle-root')
      assert.equal(start.model, 'fake-1')
      // The oracle seeds the root header with its data directory, which is not
      // the process cwd: a payload built from the fallback would fail here.
      assert.equal(start.cwd, observed.dataDir)
      assert.deepEqual(keys('Stop'), ['cwd', 'hook_event_name', 'session_id'])
      assert.equal(payload('Stop').session_id, 'anyplugin-lifecycle-root')
      assert.deepEqual(keys('SessionEnd'), ['cwd', 'hook_event_name', 'session_id'])
      assert.equal(payload('SessionEnd').session_id, 'anyplugin-lifecycle-root')
      assert.deepEqual(keys('SubagentStart'), ['agent_id', 'cwd', 'hook_event_name', 'session_id'])
      assert.equal(payload('SubagentStart').session_id, 'anyplugin-lifecycle-root')
      assert.equal(typeof payload('SubagentStart').agent_id, 'string')
      assert.deepEqual(keys('SubagentStop'), [
        'agent_id',
        'cwd',
        'hook_event_name',
        'last_assistant_message',
        'session_id',
      ])
      assert.equal(payload('SubagentStop').agent_id, payload('SubagentStart').agent_id)
      assert.equal(payload('SubagentStop').session_id, 'anyplugin-lifecycle-root')
      assert.equal(payload('SubagentStop').last_assistant_message, 'stub answer')

      const inventory = emptyInventory({ name: ir.plugin.name, source: `dsh:${harness.version}` })
      inventory.pin = { tool: 'dsh', version: harness.version }
      // Only a line the handler wrote is a matched row: a mount that fired into
      // a missing seam would leave the log short and the row missing.
      inventory.components = observed.events.map((name) => ({ surface: 'hooks', name }))
      return { inventory, refused }
    }
    if (seams !== undefined) {
      const observed = await probeSeams({ harnessDir: harness.harnessDir, entry, dataDir })
      // A single line is not enough: the notification records must appear once
      // per operation, and the settings first read (revision 0) is an event.
      assert.deepEqual(
        [...new Set(observed.lines)].sort(),
        [...seams.events].sort(),
        `${fixture}: every seam fired: ${observed.lines.join(', ')}`,
      )
      const compactions = observed.lines.filter((line) => line === 'PreCompact' || line === 'PostCompact')
      for (let index = 0; index < compactions.length; index += 2) {
        assert.equal(compactions[index], 'PreCompact', 'each compaction opens with start')
        assert.equal(compactions[index + 1], 'PostCompact', 'and closes with end')
      }
      assert.equal(observed.count('PermissionDenied'), 1, 'the allowed demand is not a denial')
      assert.equal(observed.count('CwdChanged'), 5, 'each working-directory set is one record')
      assert.equal(observed.count('ConfigChange'), 2, 'first read (0) and one change (1)')
      assert.equal(observed.count('TaskCreated'), 1, 'one creation record, one run')
      assert.equal(observed.count('TaskCompleted'), 1, 'one completed revision, one run')
      assert.equal(observed.count('WorktreeCreate'), 1, 'one created record, one run')
      assert.equal(observed.count('WorktreeRemove'), 1, 'scheduled and removed collapse to one run')
      assert.equal(observed.count('StopFailure'), 1, 'agent/error and turn/end collapse to one run')
      assert.equal(observed.payload('ConfigChange').revision, 1, 'the read-before-change order held')

      const inventory = emptyInventory({ name: ir.plugin.name, source: `dsh:${harness.version}` })
      inventory.pin = { tool: 'dsh', version: harness.version }
      // One row per declared component: a seam that fired twice still matches
      // the one hook the golden declares, but a seam that never fired leaves
      // the row missing.
      inventory.components = [...new Set(observed.lines)].map((name) => ({ surface: 'hooks', name }))
      return { inventory, refused }
    }
    const hookProbe = HOOK_PROBES[fixture]
    const probe = await probeWithDsh({
      harnessDir: harness.harnessDir,
      entry,
      ...(hookProbe === undefined ? {} : { behavior: { tool: hookProbe.tool }, timeoutMs: 10_000 }),
    })
    const inventory = probe.inventory
    if (hookProbe !== undefined && (probe.behavior?.text ?? '').includes(hookProbe.marker)) {
      const [, name] = hookProbe.component.split(':')
      inventory.components.push({ surface: 'hooks', name })
    }
    return { inventory, refused }
  } finally {
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
  }
}

test(
  'fixture coverage matches the recorded matrix',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const totals = { declared: 0, matched: 0, missing: 0, refused: 0 }
    for (const fixture of Object.keys(EXPECTED_ROWS).sort()) {
      assert.ok(existsSync(join(repoRoot, 'fixtures', fixture)), `${fixture} exists`)
      const golden = JSON.parse(
        readFileSync(join(repoRoot, 'fixtures', fixture, '.inventory', `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}.json`), 'utf8'),
      )
      const cleanup = await PREPARE[fixture]?.()
      try {
        const { inventory, refused } = await inventoryFor(fixture)
        assert.equal(inventory.pin?.tool, 'dsh', 'the actual side is DSH')
        const report = diffInventories(golden, inventory, { allowPinMismatch: true })
        // A declared component we refuse on purpose is not a gap: D11 says we
        // report the budget instead of renaming a tool into existence.
        const statusOf = (row) =>
          row.status === 'missing' && refused.has(`${row.surface}:${row.name}`) ? 'refused' : row.status
        assert.deepEqual(
          report.rows.map((row) => `${row.surface}:${row.name}:${statusOf(row)}`),
          EXPECTED_ROWS[fixture],
          `${fixture}: the transplant result changed`,
        )
        for (const row of report.rows) {
          totals.declared += 1
          if (statusOf(row) === 'match') totals.matched += 1
          else if (statusOf(row) === 'refused') totals.refused += 1
          else totals.missing += 1
        }
      } finally {
        await cleanup?.()
      }
    }
    assert.equal(
      Object.keys(EXPECTED_ROWS).length,
      EXPECTED_COUNTS.rows,
      'the coverage-row count matches the docs',
    )
    // S9 turned the lifecycle row set into matches: the golden declares five
    // hook components and the fixture's handlers wrote all five lines on a real
    // headless turn, so declared grows by five and every new row matches. The
    // S10 comment below still applies to the pre-existing eleven.
    assert.deepEqual(totals, {
      declared: EXPECTED_COUNTS.declared,
      matched: EXPECTED_COUNTS.matched,
      missing: EXPECTED_COUNTS.missing,
      refused: EXPECTED_COUNTS.refused,
    })
  },
)

// The inventory counts *components*, and a command matches there because its
// model face is emitted. Recording that as a bare 5/8 would read as progress on
// the human face too, which is exactly the lie D10 exists to prevent — so the
// missing face is asserted right next to the count it improves.
test('command components match on the model face only; the human face stays planned', () => {
  const ir = readClaudePlugin(join(repoRoot, 'fixtures', 'claude-commands-flat'), {
    source: 'plugin-dir:fixtures/claude-commands-flat',
  })
  const commands = ir.skills.filter((skill) => skill.origin === 'commands-dir')
  assert.equal(commands.length, 2)
  for (const command of commands) {
    assert.equal(command.annotation.fidelity, 'planned', `${command.name}: overall fidelity is the weakest face`)
    assert.equal(command.faces?.model.fidelity, 'equivalent')
    assert.equal(command.faces?.human.fidelity, 'planned')
    assert.match(command.faces.human.reason, /D10/)
  }
})
