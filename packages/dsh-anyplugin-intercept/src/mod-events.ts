/**
 * The mod-event → kernel-event mapping, as data (D13, D32).
 *
 * The specification is the pinned `claude-code.d.ts` written by Claude Code
 * 2.1.329 (tag v2.1.329, commit f9e4d1e5753ccffcffdd832f047d72be000396a6), not
 * the prose. (The file's own header says 2.1.277; the commit is the pin.) A
 * mod's `on()` names are the keys of `EventOf`: `EngineEventOf` (59 at this pin,
 * d.ts:4940-5939 at the 2.1.329 pin), the `classic.<Event>` names of `ClassicEventOf`
 * (d.ts:1656-1658 at the 2.1.329 pin), and the `$`-op names of `OpEventOf`
 * (75, d.ts:8646 at the 2.1.329 pin), plus each plugin's own `NounEventOf`
 * (per-plugin, so not enumerable here).
 *
 * A route is a mod name that the host can fire today, the kernel event it
 * shares with the classic front-end, the S9 host seam, and the payload shape
 * at that seam. Everything else is listed in `MOD_UNMAPPED_REASONS` or, for a
 * name that is not in the pin at all, reported by `modUnmappedReason`. The
 * list is deliberately exhaustive: a mod event may not disappear silently.
 *
 * This file has no imports. It is re-exported by `index.ts`, and the adapter
 * there reads it; keeping the data separate keeps the kernel's exports in one
 * place without a cycle.
 */

/** How the host event at `hostSeam` carries a mod handler's `e`. */
export type ModEventPayload = 'classic' | 'tool-call-envelope' | 'prompt-context' | 'engine'

/** Why a pinned event is not adapted, in the report's own vocabulary. */
export type ModUnmappedCategory = 'missing bridge' | 'no host event' | 'not in spec'

/** The spec a warning names. Kept here so no warning can drift from the pin. */
export const MOD_SPEC_LABEL = 'claude-code 2.1.329 (f9e4d1e)'

export interface ModEventRoute {
  /** The name a mod passes to `on()`. */
  readonly modEvent: string
  /** The name the kernel chain uses; classic hooks on this point share it. */
  readonly kernelEvent: string
  /** The S9-confirmed host seam, or `mod-host/load` for the loader event. */
  readonly hostSeam: string
  /** The filter the mount must apply before the chain sees the event. */
  readonly hostFilter?: string
  /** The shape the adapter hands the mod as `e`. */
  readonly payload: ModEventPayload
  /** Where the mod name and the seam are defined/probed. */
  readonly evidence: string
  /**
   * `live` when the host can fire this row today; `loader-point` when the
   * name only marks a place the loader will fire once its front-end exists.
   */
  readonly status: 'live' | 'loader-point'
  /** Required for a loader point: what is still missing for it to fire. */
  readonly reason?: string
  /** Where the classic payload is partial at the host seam (S9 caveat). */
  readonly caveat?: string
}

/**
 * The 24 live routes: twenty-one classic routes (sixteen S9 routes and
 * five S23 notification records), `session.start`, `tool.call` and
 * `prompt.context`.
 *
 * The twenty-one `classic.*` rows are the mod-side spellings of the classic hook
 * points; each shares the kernel event name (`ClassicEventOf` maps them
 * one-to-one, d.ts:1656-1658 at the 2.1.329 pin), so a mod and a classic hook
 * on one point land in one chain. `session.start` is the mod host's own load
 * event, not session creation: d.ts:5766 at the 2.1.329 pin fires it once per
 * loaded plugin, before its first prompt. It is not mapped to
 * `agent/created`; that seam belongs to `classic.SessionStart`, and
 * conflating the two would fire a mod's load
 * handler on every new root agent.
 *
 * `session.start` is live: the materializer fires it from the same `apply`
 * that loads the mods, once per loaded plugin and before the first prompt of
 * the process (D32 §4). A reload is a new `apply` and fires it again with
 * exactly that load's registrations.
 */
export const MOD_EVENT_ROUTES: readonly ModEventRoute[] = Object.freeze([
  {
    modEvent: 'classic.PreToolUse',
    kernelEvent: 'PreToolUse',
    hostSeam: 'tools/pre-execute',
    payload: 'tool-call-envelope',
    status: 'live',
    evidence:
      'classic.PreToolUse is the one ClassicEventOf variant whose `e` is ToolCallEnvelope (d.ts:1656-1658 at the 2.1.329 pin; ToolCallEnvelope at d.ts:17689); S8 confirms tools/pre-execute is a waterfall that may deny (docs/ARCHITECTURE.md:1218-1221).',
  },
  {
    modEvent: 'classic.PostToolUse',
    kernelEvent: 'PostToolUse',
    hostSeam: 'tools/post-execute',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic PostToolUse stdin payload (d.ts:1656-1658 at the 2.1.329 pin); S8/S9 confirm tools/post-execute is a waterfall that accepts additionalContexts (docs/ARCHITECTURE.md:1222-1229).',
  },
  {
    modEvent: 'classic.PostToolUseFailure',
    kernelEvent: 'PostToolUseFailure',
    hostSeam: 'tools/post-execute',
    hostFilter: "result.isError === true",
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms the failure filter on tools/post-execute (docs/ARCHITECTURE.md:1278).',
  },
  {
    modEvent: 'classic.SessionStart',
    kernelEvent: 'SessionStart',
    hostSeam: 'agent/created',
    hostFilter: 'agent.session.header.parentSession === undefined',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms agent/created with the root filter (docs/ARCHITECTURE.md:1274).',
  },
  {
    modEvent: 'classic.SessionEnd',
    kernelEvent: 'SessionEnd',
    hostSeam: 'agent/disposed',
    hostFilter: 'agent.session.header.parentSession === undefined',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms agent/disposed with the same root filter (docs/ARCHITECTURE.md:1275).',
  },
  {
    modEvent: 'classic.Stop',
    kernelEvent: 'Stop',
    hostSeam: 'agent/turn-stopping',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms agent/turn-stopping (docs/ARCHITECTURE.md:1276).',
  },
  {
    modEvent: 'classic.SubagentStart',
    kernelEvent: 'SubagentStart',
    hostSeam: 'subagent/start',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms subagent/start is an emit (docs/ARCHITECTURE.md:1279).',
  },
  {
    modEvent: 'classic.SubagentStop',
    kernelEvent: 'SubagentStop',
    hostSeam: 'subagent/end',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms subagent/end is an emit (docs/ARCHITECTURE.md:1280).',
  },
  {
    modEvent: 'classic.UserPromptSubmit',
    kernelEvent: 'UserPromptSubmit',
    hostSeam: 'agent/pre-step',
    hostFilter: 'step === 1',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms agent/pre-step, which fires once per model step and so needs step === 1 (docs/ARCHITECTURE.md:1273). Prompt identity is not asserted.',
  },
  {
    modEvent: 'classic.PermissionRequest',
    kernelEvent: 'PermissionRequest',
    hostSeam: 'approval/request',
    payload: 'classic',
    status: 'live',
    caveat:
      'S9 approval/request carries no tool_input; the classic payload is partial at this seam (docs/ARCHITECTURE.md:1277).',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms approval/request, whose rejection is the deny (docs/ARCHITECTURE.md:1277).',
  },
  {
    modEvent: 'classic.PreCompact',
    kernelEvent: 'PreCompact',
    hostSeam: 'session/event compaction/start',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms session/event compaction/start, notification-only (docs/ARCHITECTURE.md:1281).',
  },
  {
    modEvent: 'classic.PostCompact',
    kernelEvent: 'PostCompact',
    hostSeam: 'session/event compaction/end',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms session/event compaction/end, notification-only (docs/ARCHITECTURE.md:1282).',
  },
  {
    modEvent: 'classic.PermissionDenied',
    kernelEvent: 'PermissionDenied',
    hostSeam: 'session/event approval/decided',
    payload: 'classic',
    status: 'live',
    caveat:
      'S9 approval/decided carries no tool name or tool input; the classic payload is partial at this seam (docs/ARCHITECTURE.md:1283).',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms session/event approval/decided, notification-only (docs/ARCHITECTURE.md:1283).',
  },
  {
    modEvent: 'classic.CwdChanged',
    kernelEvent: 'CwdChanged',
    hostSeam: 'session/event working-directory/change',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms session/event working-directory/change, notification-only (docs/ARCHITECTURE.md:1284).',
  },
  {
    modEvent: 'classic.FileChanged',
    kernelEvent: 'FileChanged',
    hostSeam: 'fs/observed',
    hostFilter: "tool ∈ {write, edit} && kind === 'present'",
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms fs/observed with the write/edit and present filters (docs/ARCHITECTURE.md:1285).',
  },
  {
    modEvent: 'classic.ConfigChange',
    kernelEvent: 'ConfigChange',
    hostSeam: 'settings/document-updated',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S9 confirms settings/document-updated, notification-only and also fired on first read (docs/ARCHITECTURE.md:1286).',
  },
  {
    modEvent: 'classic.TaskCreated',
    kernelEvent: 'TaskCreated',
    hostSeam: 'session/event team/task',
    hostFilter: 'task.revision === 1',
    payload: 'classic',
    status: 'live',
    caveat:
      'team_name and teammate_name have no host source: teamId is the Team identity (the root session id at this pin), not a display name, and a revision-one task is unowned. Both are reported gaps, never synthesized.',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S23 confirms session/event team/task, revision 1 status pending, notification-only (docs/ARCHITECTURE.md §10 S23).',
  },
  {
    modEvent: 'classic.TaskCompleted',
    kernelEvent: 'TaskCompleted',
    hostSeam: 'session/event team/task',
    hostFilter: "task.status === 'completed'",
    payload: 'classic',
    status: 'live',
    caveat:
      'team_name has no host source (teamId is a session identity, not a display name); it is a reported gap. teammate_name comes from task.ownerName.',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S23 confirms the terminal team/task revision, status completed with ownerId/ownerName, notification-only (docs/ARCHITECTURE.md §10 S23).',
  },
  {
    modEvent: 'classic.WorktreeCreate',
    kernelEvent: 'WorktreeCreate',
    hostSeam: 'session/event plugin:worktree/created',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S23 confirms the plugin:worktree/created record (path, branch, baseCommit, repositoryRoot), notification-only (docs/ARCHITECTURE.md §10 S23).',
  },
  {
    modEvent: 'classic.WorktreeRemove',
    kernelEvent: 'WorktreeRemove',
    hostSeam: 'worktree/cleanup',
    hostFilter: "cleanup.status === 'removed'",
    payload: 'classic',
    status: 'live',
    caveat:
      'The cleanup emit fires twice per removal; only the settled removed record is routed, deduped by sessionId/path/cleanup.revision. The scheduled record is an intent, and retained/failed are not removals.',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S23 confirms worktree/cleanup (scheduled then final), notification-only (docs/ARCHITECTURE.md §10 S23).',
  },
  {
    modEvent: 'classic.StopFailure',
    kernelEvent: 'StopFailure',
    hostSeam: 'session/event turn/end + agent/error',
    hostFilter: "reason.kind === 'error' / agent/error",
    payload: 'classic',
    status: 'live',
    caveat:
      'The host carries a failure code and message, not Claude’s error class enum, and the failed turn commits no assistant/message record. error and last_assistant_message are reported gaps; error_details is the host message.',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:1656-1658 at the 2.1.329 pin); S23 confirms the error-shaped turn/end record plus the agent/error emit, notification-only (docs/ARCHITECTURE.md §10 S23).',
  },
  {
    modEvent: 'session.start',
    kernelEvent: 'session.start',
    hostSeam: 'mod-host/load',
    payload: 'engine',
    status: 'live',
    evidence:
      'EngineEventOf session.start fires once per process for each loaded plugin, before the first prompt, then once per fresh load (d.ts:5766 at the 2.1.329 pin). The materializer fires it from apply, once per loaded plugin, before the first prompt; a reload is a new apply. It is not agent/created (that is classic.SessionStart).',
  },
  {
    modEvent: 'tool.call',
    kernelEvent: 'PreToolUse',
    hostSeam: 'tools/pre-execute',
    payload: 'tool-call-envelope',
    status: 'live',
    evidence:
      'EngineEventOf tool.call hands the hook ToolCallInput, the classic ToolCallEnvelope plus the loop and request meta (d.ts:4940-4959 at the 2.1.329 pin; ToolCallInput at d.ts:17697, built on ToolCallEnvelope at d.ts:17689). Its result is ToolCallResult: `{ deny }`, `{ result }` or `{ isError: true, result }` (d.ts:17729-17831 at the 2.1.329 pin). S8 confirms tools/pre-execute is the pre-execution waterfall and `PreToolDecision.deny` materializes a model-facing reason (docs/ARCHITECTURE.md:1218-1221). The route is a gate-only projection: deny is the kernel deny, and the result-bearing verbs are hard `unsupported` because this seam has no value channel (see modResultToKernel).',
    caveat:
      'A handler that awaits next() sees the gate projection (a continuation, not a native ToolCallResult); an authored { allow: true } is refused as a non-pin field. diff\'s afterTool reads result.result through that call, so its post-edit pane refresh is degraded on this route. agents-md\'s Read handler calls $.session.root()/$.fs.ancestors(), which the mod bridge lacks, so it errors and the chain fails open (the call still runs).',
  },
  {
    modEvent: 'prompt.context',
    kernelEvent: 'PromptContext',
    hostSeam: 'system-prompt/assemble',
    payload: 'prompt-context',
    status: 'live',
    evidence:
      'EngineEventOf prompt.context fires once per conversation while the engine computes the context blocks of the first user message; next(e) resolves to PromptContextResult { blocks } (d.ts:5282-5288 at the 2.1.329 pin; PromptContextBlock at d.ts:11332-11357, PromptContextInput at d.ts:11359, PromptContextResult at d.ts:11379-11410). The agent-scoped system-prompt/assemble waterfall owns the contexts that agent-loop renders into the user-role runtime-context message at each step (S9 395-423; dsh-system-prompt PromptContext). The route projects only the pin-named blocks (claudeMd, userEmail, attachedProject, currentDate) plus blocks the mod itself added; DSH operational contexts are never exposed to the mod and cannot be dropped by it. `instructionFiles` has no host projection and is reported unsupported at the mount; agents-md\'s handler no-ops without instruction files and needs $.session.root/$.fs.ancestors, which the bridge lacks.',
    caveat:
      'The answer is cached once per seat until compaction/end (the host re-read); a /clear starts a new session and seat. $.ui.invalidate("prompt.context") now drops that cached answer through the headless render sink (#75), so the next assembly re-runs the hooks on the same seat.',
  },
])

/**
 * The pinned engine events, in d.ts order (EngineEventOf, d.ts:4940-5939 (2.1.329 pin),
 * 59 names at 2.1.329). Kept as a list so a test can prove that every name in
 * the pin is either routed or unmapped with a reason when the pin moves.
 */
export const MOD_ENGINE_EVENTS: readonly string[] = Object.freeze([
  'tool.call',
  'tool.check',
  'tool.judge',
  'tool.run',
  'ui.render',
  'ui.resolve',
  'ui.press',
  'ui.input',
  'ui.select',
  'ui.message',
  'ui.fault',
  'ui.pointer',
  'ui.scroll',
  'ui.focus',
  'agent.offer',
  'agent.spawn',
  'agent.report',
  'prompt.submit',
  'prompt.fill',
  'prompt.suggest',
  'prompt.edit',
  'prompt.change',
  'prompt.autocomplete',
  'prompt.section',
  'prompt.context',
  'prompt.compose',
  'prompt.attachment',
  'prompt.mention',
  'tool.describe',
  'tool.offer',
  'command.run',
  'command.describe',
  'config.set',
  'config.describe',
  'telemetry.log',
  'telemetry.mark',
  'skill.prompt',
  'attribution.text',
  'vcs.detect',
  'vcs.diff',
  'vcs.isolate',
  'vcs.list',
  'vcs.status',
  'vcs.release',
  'session.start',
  'session.receive',
  'session.append',
  'session.send',
  'session.compact',
  'session.attach',
  'session.detach',
  'session.measure',
  'session.stop',
  'session.end',
  'plugin.register',
  'turn.start',
  'turn.step',
  'turn.complete',
  'engine.create',
])

/**
 * The `$`-op hook names in `OpEventOf` (d.ts:8646 at the 2.1.329 pin), sorted. `On` accepts them
 * because `EventName = keyof EventOf`, and `EventOf` is `CoreEventOf` (engine,
 * classic, op) intersected with the per-plugin nouns. A mod can hook an op even
 * though DSH's bridge has no op-hook route; the table records that rather than
 * calling the name absent from the spec.
 */
export const MOD_OP_EVENTS: readonly string[] = Object.freeze([
  'agent.call',
  'agent.limits',
  'agent.list',
  'agent.register',
  'audio.play',
  'audio.speak',
  'clock.after',
  'clock.every',
  'clock.now',
  'clock.sleep',
  'command.list',
  'command.register',
  'config.list',
  'env.get',
  'env.set',
  'fs.ancestors',
  'fs.exists',
  'fs.list',
  'fs.read',
  'fs.stat',
  'fs.write',
  'http.fetch',
  'mcp.call',
  'mcp.connect',
  'model.classify',
  'model.complete',
  'model.fork',
  'process.hookEnv',
  'process.run',
  'process.spawn',
  'prompt.paint',
  'prompt.read',
  'session.authorize',
  'session.cwd',
  'session.id',
  'session.identity',
  'session.info',
  'session.machine',
  'session.messages',
  'session.model',
  'session.repo',
  'session.root',
  'session.surface',
  'session.surfaces',
  'session.turns',
  'session.usage',
  'session.version',
  'settings.read',
  'state.get',
  'state.set',
  'store.delete',
  'store.get',
  'store.keys',
  'store.set',
  'theme.clear',
  'theme.set',
  'tool.list',
  'tool.register',
  'turn.abort',
  'ui.blit',
  'ui.cancelNotify',
  'ui.close',
  'ui.copy',
  'ui.invalidate',
  'ui.log',
  'ui.notice',
  'ui.notify',
  'ui.open',
  'ui.panes',
  'ui.place',
  'ui.selection',
  'ui.status',
  'ui.toast',
  'ui.view',
  'wasm.compile',
])

/**
 * The pinned classic hook names, in HookInput order (d.ts:6762 at the 2.1.329 pin). `classic.` +
 * one of these is a mod event (ClassicEventOf, d.ts:1656-1658 at the 2.1.329 pin). The kernel's
 * `CLASSIC_HOOK_EVENTS` has 32 of these; `PostModelSwitch` is declared in the
 * pin but has no host seam yet (S9 did not probe it), so it is unmapped here
 * rather than added to the kernel in this ticket.
 */
export const MOD_CLASSIC_EVENTS: readonly string[] = Object.freeze([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionDenied',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'PermissionRequest',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'InstructionsLoaded',
  'WorktreeCreate',
  'WorktreeRemove',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
])

const CLASSIC_UNMAPPED: Readonly<Record<string, string>> = Object.freeze({
  'classic.DirectoryAdded':
    'S9 refuted: no host dispatch site anywhere in the swept tree (docs/ARCHITECTURE.md:1335).',
  'classic.Elicitation':
    'S9 refuted: an MCP JSON-RPC protocol notification, not a cordis host event (docs/ARCHITECTURE.md:1343-1344).',
  'classic.ElicitationResult':
    'S9 refuted: an MCP JSON-RPC protocol notification, not a cordis host event (docs/ARCHITECTURE.md:1343-1344).',
  'classic.InstructionsLoaded':
    'S9 refuted: no load-time dispatch; dsh-agent-instructions is itself a listener on agent/pre-step and session/event (docs/ARCHITECTURE.md:1331-1333).',
  'classic.MessageDisplay':
    'S9 refuted: display is a client concern; assistant/message is a generation record, so there is no display-time listener (docs/ARCHITECTURE.md:1337-1339).',
  'classic.Notification':
    'S9 refuted: no host event carries a notification message/title/notification_type; approval/asked is permission-only with a different payload (docs/ARCHITECTURE.md:1320-1325).',
  'classic.PostModelSwitch':
    'Declared in the pin (d.ts:10569) but not probed by S9 and absent from the classic payload fixtures; no confirmed host seam yet, so it stays unmapped rather than guessed.',
  'classic.PostToolBatch':
    'S9 refuted: there is no after-batch point; tools/execute is per-call pre-execution (docs/ARCHITECTURE.md:1340-1342).',
  'classic.PreModelSwitch':
    'S9 refuted: agent/request fires per request, not on a model switch, and is deprecated (docs/ARCHITECTURE.md:1326-1330).',
  'classic.Setup':
    'S9 refuted: no dispatch; agent/created with source startup is the closest lifecycle point, but it is not setup (docs/ARCHITECTURE.md:1334-1335).',
  'classic.TeammateIdle':
    'S23: driving a fork teammate through activation to idle produced only agent/status (status idle, agent id) and no team/member record at 0.2.2-rc.5, so the transition and teammate_name cannot be built. Not fired at the pin — a host gap, not an unprobed point (docs/ARCHITECTURE.md §10 S23).',
  'classic.UserPromptExpansion':
    'S9 refuted: expansion happens in the command layer before the prompt; agent/pre-step sees only the expanded messages (docs/ARCHITECTURE.md:1333-1334).',
})

function reasons(events: readonly string[], reason: string): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(events.map((event) => [event, reason])))
}

const UI_EVENTS = ['ui.render', 'ui.resolve', 'ui.press', 'ui.input', 'ui.select', 'ui.message', 'ui.scroll', 'ui.focus']
const PROMPT_ELEMENT_EVENTS = [
  'prompt.fill',
  'prompt.suggest',
  'prompt.edit',
  'prompt.section',
  'prompt.compose',
  'prompt.attachment',
]
const NO_SEAM_EVENTS = [
  'agent.offer',
  'tool.describe',
  'command.run',
  'command.describe',
  'config.set',
  'config.describe',
  'skill.prompt',
  'attribution.text',
]
const SESSION_NO_SEAM_EVENTS = [
  'session.receive',
  'session.append',
  'session.compact',
  'session.attach',
  'session.detach',
  'session.measure',
]

const VCS_EVENTS = ['vcs.detect', 'vcs.diff', 'vcs.isolate', 'vcs.list', 'vcs.status', 'vcs.release']

/**
 * Engine events added by the 2.1.329 pin that have no DSH event firing at their
 * point. Each reason names the absent host event or bridge member, so the
 * warning can distinguish "we have no seam" from "this is not in the spec".
 */
const NEW_NO_HOST_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  'tool.judge':
    'No DSH host event fires at the auto-mode classifier point; the bridge also exposes no tool.judge member.',
  'tool.run':
    'No DSH host event fires after an allowed call is about to run; tools/pre-execute is the pre-execution seam, not this run boundary.',
  'ui.fault':
    'No DSH UI channel fires for a client fault; the element runtime is out of scope (D31).',
  'ui.pointer':
    'No DSH UI channel fires for a backdrop pointer event; the element runtime is out of scope (D31).',
  'agent.report':
    'No DSH host event fires before an agent report reaches its parent, and the bridge has no agent.report member.',
  'prompt.change':
    'No DSH host event fires when the interactive prompt box changes; the bridge has no prompt-box channel.',
  'prompt.autocomplete':
    'No DSH host event fires for interactive prompt typeahead; the bridge has no prompt-box channel.',
  'prompt.mention':
    'No DSH host event fires when a prompt mentions a path; the bridge has no prompt-box channel.',
  'tool.offer':
    'No DSH host event fires when a tool is offered to a loop model, and the bridge has no tool.offer member.',
  'telemetry.log':
    'The bridge serves $.telemetry.log as a call, but DSH fires no telemetry.log event for a mod to observe; there is no host seam.',
  'telemetry.mark':
    'The bridge serves $.telemetry.mark as a call, but DSH fires no telemetry.mark event for a mod to observe; there is no host seam.',
  'session.send':
    'No DSH host event fires for an outbound session message, and the bridge session surface has no send member.',
  'session.stop':
    'No DSH host event fires for the person pressing Stop; the classic Stop point maps to agent/turn-stopping (D32).',
})

const NEW_ENGINE_CATEGORIES: Readonly<Record<string, ModUnmappedCategory>> = Object.freeze({
  ...Object.fromEntries(Object.keys(NEW_NO_HOST_EVENTS).map((event) => [event, 'no host event' as const])),
})

const ENGINE_UNMAPPED: Readonly<Record<string, string>> = Object.freeze({
  ...reasons(
    UI_EVENTS,
    'UI lifecycle; the host has no UI channel for a mod to drive (D31 and D32 keep the element runtime out of scope).',
  ),
  ...reasons(
    PROMPT_ELEMENT_EVENTS,
    'Interactive prompt editing; the host has no UI channel, and the classic prompt point is classic.UserPromptSubmit (agent/pre-step, step === 1).',
  ),
  ...reasons(NO_SEAM_EVENTS, 'No S9 host seam exists for this engine point; it is not a classic hook point either.'),
  ...reasons(
    SESSION_NO_SEAM_EVENTS,
    'No S9 host seam. session.compact is the engine’s compaction point; the classic PreCompact/PostCompact records are the notification-only seam (S9 1281-1282).',
  ),
  ...reasons(
    VCS_EVENTS,
    'DSH fires no vcs event at these points. The bridge serves $.vcs.detect and $.vcs.diff as read-only git calls (bridge.ts, ticket #119), and $.vcs.isolate/list/status/release are typed refusals (ERR_MOD_HOST_VCS_UNSUPPORTED) because the host makes no copy and keeps no worktree trust record; a mod observes those calls, not events, at the 2.1.329 pin.',
  ),
  ...NEW_NO_HOST_EVENTS,
  'tool.check':
    'Refused (not routed) because it is the engine\'s own permission verdict, not the pre-execution gate: it runs after tool.call and PreToolUse, and next(e) resolves to the engine\'s { decision } (rules, mode, the tool\'s own check, PreToolUse\'s decision) without running a tool (d.ts:4961-4977 at the 2.1.329 pin; ToolCheckResult at d.ts:17950-18010). tools/pre-execute is the PreToolUse stage itself: it cannot see or answer that later verdict, cannot attribute an `ask` to a person or plugin, and cannot carry next.origin/trace/settings or the engine-set `op`/`ceiling` facts that the three real registrations read. Mapping allow/ask/deny onto PreToolDecision.allow/ask/deny would make the mod answer a different question at the wrong point, so it stays a measured refusal.',
  'agent.spawn':
    'The subagent spawn decision; subagent/start is emitted after the decision, so it cannot see or deny the spawn (d.ts:5162 (2.1.329 pin); S9 1279).',
  'prompt.submit':
    'The engine prompt point before the turn; the classic point is classic.UserPromptSubmit (agent/pre-step, step === 1), and the host does not fire both for one prompt (d.ts:5204 (2.1.329 pin); S9 1273).',
  'session.end':
    'Fires after the SessionEnd settings hooks; the classic point is classic.SessionEnd (agent/disposed). Routing it too would double-fire and invert the order (d.ts:5879 at the 2.1.329 pin).',
  'plugin.register':
    'Gates a hooks module joining the chain; the host load itself is session.start, not a hook point (d.ts:5894 at the 2.1.329 pin).',
  'turn.start': 'Model-turn start; no host listener and no classic counterpart.',
  'turn.step':
    'About to send a model request; streamable and rewritable, but no host listener and no classic counterpart (d.ts:5913 at the 2.1.329 pin).',
  'turn.complete':
    'The end of a model turn, not the end of the agent turn: classic.Stop maps to agent/turn-stopping (d.ts:5925 (2.1.329 pin); S9 1276).',
  'engine.create':
    'Constructs a `$`; there is no host event to attach it to, and D31 keeps the engine fold out of the mod adapter.',
})

/** Every pinned event name: classic, engine, and the `$`-op hooks. */
export const MOD_PINNED_EVENTS: readonly string[] = Object.freeze([
  ...MOD_CLASSIC_EVENTS.map((event) => `classic.${event}`),
  ...MOD_ENGINE_EVENTS,
  ...MOD_OP_EVENTS,
])

const OP_UNMAPPED: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    MOD_OP_EVENTS.map((event) => [
      event,
      'OpEventOf hook: the bridge exposes this as a $ call where it is served, but DSH fires no event at the op and has no op-hook route; recorded missing, not refused (D32/D39).',
    ]),
  ),
)

/** Every pinned name that is not routed, with the S9/D31 reason it is not. */
export const MOD_UNMAPPED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  ...CLASSIC_UNMAPPED,
  ...ENGINE_UNMAPPED,
  ...OP_UNMAPPED,
})

/**
 * The category that goes into a warning. Pinned names have a host-side reason
 * (`no host event`) unless the report already classified them more precisely
 * (`missing bridge`); names outside the pin are `not in spec` so a typo in a
 * mod does not read like a host gap.
 */
export const MOD_UNMAPPED_CATEGORIES: Readonly<Record<string, ModUnmappedCategory>> = Object.freeze({
  ...Object.fromEntries(Object.keys(CLASSIC_UNMAPPED).map((event) => [event, 'no host event' as const])),
  ...Object.fromEntries(Object.keys(ENGINE_UNMAPPED).map((event) => [event, 'no host event' as const])),
  ...Object.fromEntries(MOD_OP_EVENTS.map((event) => [event, 'no host event' as const])),
  ...NEW_ENGINE_CATEGORIES,
})

/** Classify an event for the report and the runtime warning. */
export function modUnmappedCategory(event: string): ModUnmappedCategory {
  const explicit = MOD_UNMAPPED_CATEGORIES[event]
  if (explicit !== undefined) return explicit
  return 'not in spec'
}

/**
 * Names that appeared in the ticket's prose but not in the pin. Kept as data
 * so the report can name the real spelling instead of inventing an alias.
 */
export const MOD_NONEXISTENT_GUESSES: Readonly<Record<string, string>> = Object.freeze({
  'post.tool.use': 'the pin names it `classic.PostToolUse` (ClassicEventOf, d.ts:1656-1658 at the 2.1.329 pin)',
  'pre.tool.use': 'the pin names it `classic.PreToolUse` (ClassicEventOf, d.ts:1656-1658 at the 2.1.329 pin)',
  'turn.stop': 'the classic point is `classic.Stop`; the engine names the model-turn end `turn.complete` (d.ts:5925 at the 2.1.329 pin)',
  'subagent.start': 'the pin names it `classic.SubagentStart`; the engine names the spawn decision `agent.spawn` (d.ts:5162)',
  'subagent.stop': 'the pin names it `classic.SubagentStop` (ClassicEventOf, d.ts:1656-1658 at the 2.1.329 pin)',
  'tool.use.failure': 'the pin names it `classic.PostToolUseFailure` (ClassicEventOf, d.ts:1656-1658 at the 2.1.329 pin)',
})

/**
 * The reason an event is not adapted: a pinned-but-unmapped reason, the real
 * name for a guess from the ticket prose, or the pin's own boundary.
 */
export function modUnmappedReason(event: string): string {
  const guess = MOD_NONEXISTENT_GUESSES[event]
  if (guess !== undefined) {
    return `not an event at the pin: ${guess}.`
  }
  const pinned = MOD_UNMAPPED_REASONS[event]
  if (pinned !== undefined) {
    return pinned
  }
  return 'not an event in EngineEventOf/ClassicEventOf at the 2.1.329 pin; plugin-declared noun events are not hostable yet (D32).'
}
