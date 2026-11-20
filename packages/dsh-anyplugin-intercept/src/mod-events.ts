/**
 * The mod-event → kernel-event mapping, as data (D13, D32).
 *
 * The specification is the pinned `claude-code.d.ts` written by Claude Code
 * 2.1.322 (tag v2.1.322, commit 6e1e44f6433bfa17d198e932bff53373aa229eea), not
 * the prose. (The file's own header says 2.1.277; the commit is the pin.) A
 * mod's `on()` names are exactly the keys of `EngineEventOf` plus the
 * `classic.<Event>` names of `ClassicEventOf` (d.ts:951-953); there is no
 * separate mod vocabulary.
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
export type ModEventPayload = 'classic' | 'tool-call-envelope' | 'engine'

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
 * The 16 live classic routes plus one loader point.
 *
 * The sixteen `classic.*` rows are the mod-side spellings of the classic hook
 * points; each shares the kernel event name (`ClassicEventOf` maps them
 * one-to-one, d.ts:938-953), so a mod and a classic hook on one point land in
 * one chain. `session.start` is the mod host's own load event, not session
 * creation: d.ts:3568-3578 fires it once per loaded plugin, before its first
 * prompt. It is not mapped to `agent/created`; that seam belongs to
 * `classic.SessionStart`, and conflating the two would fire a mod's load
 * handler on every new root agent.
 *
 * `session.start` is a loader point, not a live route: the adapter maps it so
 * the name is accounted for, but no loader front-end fires it yet. Wiring that
 * front-end is the follow-up; this PR must not imply the host already fires it.
 */
export const MOD_EVENT_ROUTES: readonly ModEventRoute[] = Object.freeze([
  {
    modEvent: 'classic.PreToolUse',
    kernelEvent: 'PreToolUse',
    hostSeam: 'tools/pre-execute',
    payload: 'tool-call-envelope',
    status: 'live',
    evidence:
      'classic.PreToolUse is the one ClassicEventOf variant whose `e` is ToolCallEnvelope (d.ts:951-953, 10081-10093); S8 confirms tools/pre-execute is a waterfall that may deny (docs/ARCHITECTURE.md:1218-1221).',
  },
  {
    modEvent: 'classic.PostToolUse',
    kernelEvent: 'PostToolUse',
    hostSeam: 'tools/post-execute',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic PostToolUse stdin payload (d.ts:951-953); S8/S9 confirm tools/post-execute is a waterfall that accepts additionalContexts (docs/ARCHITECTURE.md:1222-1229).',
  },
  {
    modEvent: 'classic.PostToolUseFailure',
    kernelEvent: 'PostToolUseFailure',
    hostSeam: 'tools/post-execute',
    hostFilter: "result.isError === true",
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms the failure filter on tools/post-execute (docs/ARCHITECTURE.md:1278).',
  },
  {
    modEvent: 'classic.SessionStart',
    kernelEvent: 'SessionStart',
    hostSeam: 'agent/created',
    hostFilter: 'agent.session.header.parentSession === undefined',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms agent/created with the root filter (docs/ARCHITECTURE.md:1274).',
  },
  {
    modEvent: 'classic.SessionEnd',
    kernelEvent: 'SessionEnd',
    hostSeam: 'agent/disposed',
    hostFilter: 'agent.session.header.parentSession === undefined',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms agent/disposed with the same root filter (docs/ARCHITECTURE.md:1275).',
  },
  {
    modEvent: 'classic.Stop',
    kernelEvent: 'Stop',
    hostSeam: 'agent/turn-stopping',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms agent/turn-stopping (docs/ARCHITECTURE.md:1276).',
  },
  {
    modEvent: 'classic.SubagentStart',
    kernelEvent: 'SubagentStart',
    hostSeam: 'subagent/start',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms subagent/start is an emit (docs/ARCHITECTURE.md:1279).',
  },
  {
    modEvent: 'classic.SubagentStop',
    kernelEvent: 'SubagentStop',
    hostSeam: 'subagent/end',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms subagent/end is an emit (docs/ARCHITECTURE.md:1280).',
  },
  {
    modEvent: 'classic.UserPromptSubmit',
    kernelEvent: 'UserPromptSubmit',
    hostSeam: 'agent/pre-step',
    hostFilter: 'step === 1',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms agent/pre-step, which fires once per model step and so needs step === 1 (docs/ARCHITECTURE.md:1273). Prompt identity is not asserted.',
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
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms approval/request, whose rejection is the deny (docs/ARCHITECTURE.md:1277).',
  },
  {
    modEvent: 'classic.PreCompact',
    kernelEvent: 'PreCompact',
    hostSeam: 'session/event compaction/start',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms session/event compaction/start, notification-only (docs/ARCHITECTURE.md:1281).',
  },
  {
    modEvent: 'classic.PostCompact',
    kernelEvent: 'PostCompact',
    hostSeam: 'session/event compaction/end',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms session/event compaction/end, notification-only (docs/ARCHITECTURE.md:1282).',
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
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms session/event approval/decided, notification-only (docs/ARCHITECTURE.md:1283).',
  },
  {
    modEvent: 'classic.CwdChanged',
    kernelEvent: 'CwdChanged',
    hostSeam: 'session/event working-directory/change',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms session/event working-directory/change, notification-only (docs/ARCHITECTURE.md:1284).',
  },
  {
    modEvent: 'classic.FileChanged',
    kernelEvent: 'FileChanged',
    hostSeam: 'fs/observed',
    hostFilter: "tool ∈ {write, edit} && kind === 'present'",
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms fs/observed with the write/edit and present filters (docs/ARCHITECTURE.md:1285).',
  },
  {
    modEvent: 'classic.ConfigChange',
    kernelEvent: 'ConfigChange',
    hostSeam: 'settings/document-updated',
    payload: 'classic',
    status: 'live',
    evidence:
      'ClassicEventOf keeps the classic payload (d.ts:951-953); S9 confirms settings/document-updated, notification-only and also fired on first read (docs/ARCHITECTURE.md:1286).',
  },
  {
    modEvent: 'session.start',
    kernelEvent: 'session.start',
    hostSeam: 'mod-host/load',
    payload: 'engine',
    status: 'loader-point',
    reason:
      'The loader front-end that fires session.start from mod-host/load is a follow-up; this row only reserves the loader point. It is not agent/created (that is classic.SessionStart).',
    evidence:
      'EngineEventOf session.start fires once per process for each loaded plugin, before the first prompt, then once per fresh load (d.ts:3568-3578). The mod host does not fire it yet: no production caller of the adapter or loader front-end exists in this PR.',
  },
])

/**
 * The pinned engine events, in d.ts order (EngineEventOf, d.ts:3267-3698).
 * Kept as a list so a test can prove that every name in the pin is either
 * routed or unmapped with a reason when the pin moves.
 */
export const MOD_ENGINE_EVENTS: readonly string[] = Object.freeze([
  'tool.call',
  'tool.check',
  'ui.render',
  'ui.resolve',
  'ui.press',
  'ui.input',
  'ui.select',
  'ui.message',
  'ui.scroll',
  'ui.focus',
  'agent.offer',
  'agent.spawn',
  'prompt.submit',
  'prompt.fill',
  'prompt.suggest',
  'prompt.edit',
  'prompt.section',
  'prompt.context',
  'prompt.compose',
  'prompt.attachment',
  'tool.describe',
  'command.run',
  'command.describe',
  'config.set',
  'config.describe',
  'skill.prompt',
  'attribution.text',
  'session.start',
  'session.receive',
  'session.append',
  'session.compact',
  'session.attach',
  'session.detach',
  'session.measure',
  'session.end',
  'plugin.register',
  'turn.start',
  'turn.step',
  'turn.complete',
  'engine.create',
])

/**
 * The pinned classic hook names, in HookInput order (d.ts:4329). `classic.` +
 * one of these is a mod event (ClassicEventOf, d.ts:951-953). The kernel's
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
    'Declared in the pin (d.ts:6355-6356) but not probed by S9 and absent from the classic payload fixtures; no confirmed host seam yet, so it stays unmapped rather than guessed.',
  'classic.PostToolBatch':
    'S9 refuted: there is no after-batch point; tools/execute is per-call pre-execution (docs/ARCHITECTURE.md:1340-1342).',
  'classic.PreModelSwitch':
    'S9 refuted: agent/request fires per request, not on a model switch, and is deprecated (docs/ARCHITECTURE.md:1326-1330).',
  'classic.Setup':
    'S9 refuted: no dispatch; agent/created with source startup is the closest lifecycle point, but it is not setup (docs/ARCHITECTURE.md:1334-1335).',
  'classic.StopFailure':
    'S9 unprobed: turn/end with an error reason is appended, but no failure-specific dispatch is established (docs/ARCHITECTURE.md:1311-1315).',
  'classic.TaskCreated':
    'S9 unprobed: team/task is appended, but no create-specific point was established (docs/ARCHITECTURE.md:1293-1297).',
  'classic.TaskCompleted':
    'S9 unprobed: the team/task record family exists, but the terminal record was not established or distinguished from creation (docs/ARCHITECTURE.md:1298-1301).',
  'classic.TeammateIdle':
    'S9 unprobed: team/member records exist, but no idle-transition point was established (docs/ARCHITECTURE.md:1302-1304).',
  'classic.UserPromptExpansion':
    'S9 refuted: expansion happens in the command layer before the prompt; agent/pre-step sees only the expanded messages (docs/ARCHITECTURE.md:1333-1334).',
  'classic.WorktreeCreate':
    'S9 unprobed: plugin:worktree/created is appended, but the record and its payload were not asserted (docs/ARCHITECTURE.md:1305-1308).',
  'classic.WorktreeRemove':
    'S9 unprobed: worktree/cleanup is emitted, but whether it fires per removal and what it carries was not asserted (docs/ARCHITECTURE.md:1309-1310).',
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
  'prompt.context',
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
  'tool.call':
    'Protocol mismatch: tools/pre-execute carries the classic PreToolUse protocol, while tool.call returns the engine result { deny } / { result } (d.ts:3270-3276). Routing it through that waterfall would translate one protocol into the other, not share one chain; leave the native engine event to its own subscription (D32).',
  'tool.check':
    'Runs after tool.call and PreToolUse, before the ask; it has no classic counterpart and no separate host listener (d.ts:3277-3286).',
  'agent.spawn':
    'The subagent spawn decision; subagent/start is emitted after the decision, so it cannot see or deny the spawn (d.ts:3380-3390; S9 1279).',
  'prompt.submit':
    'The engine prompt point before the turn; the classic point is classic.UserPromptSubmit (agent/pre-step, step === 1), and the host does not fire both for one prompt (d.ts:3395-3402; S9 1273).',
  'session.end':
    'Fires after the SessionEnd settings hooks; the classic point is classic.SessionEnd (agent/disposed). Routing it too would double-fire and invert the order (d.ts:3640-3652).',
  'plugin.register':
    'Gates a hooks module joining the chain; the host load itself is session.start, not a hook point (d.ts:3655-3662).',
  'turn.start': 'Model-turn start; no host listener and no classic counterpart.',
  'turn.step':
    'About to send a model request; streamable and rewritable, but no host listener and no classic counterpart (d.ts:3674-3684).',
  'turn.complete':
    'The end of a model turn, not the end of the agent turn: classic.Stop maps to agent/turn-stopping (d.ts:3685-3690; S9 1276).',
  'engine.create':
    'Constructs a `$`; there is no host event to attach it to, and D31 keeps the engine fold out of the mod adapter.',
})

/** Every pinned event name: the classic names plus the engine names. */
export const MOD_PINNED_EVENTS: readonly string[] = Object.freeze([
  ...MOD_CLASSIC_EVENTS.map((event) => `classic.${event}`),
  ...MOD_ENGINE_EVENTS,
])

/** Every pinned name that is not routed, with the S9/D31 reason it is not. */
export const MOD_UNMAPPED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  ...CLASSIC_UNMAPPED,
  ...ENGINE_UNMAPPED,
})

/**
 * Names that appeared in the ticket's prose but not in the pin. Kept as data
 * so the report can name the real spelling instead of inventing an alias.
 */
export const MOD_NONEXISTENT_GUESSES: Readonly<Record<string, string>> = Object.freeze({
  'post.tool.use': 'the pin names it `classic.PostToolUse` (ClassicEventOf, d.ts:951-953)',
  'pre.tool.use': 'the pin names it `classic.PreToolUse` (ClassicEventOf, d.ts:951-953)',
  'turn.stop': 'the classic point is `classic.Stop`; the engine names the model-turn end `turn.complete` (d.ts:3685-3690)',
  'subagent.start': 'the pin names it `classic.SubagentStart`; the engine names the spawn decision `agent.spawn` (d.ts:3380-3390)',
  'subagent.stop': 'the pin names it `classic.SubagentStop` (ClassicEventOf, d.ts:951-953)',
  'tool.use.failure': 'the pin names it `classic.PostToolUseFailure` (ClassicEventOf, d.ts:951-953)',
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
  return 'not an event in the pinned claude-code.d.ts (EngineEventOf/ClassicEventOf); plugin-declared noun events are not hostable yet (D32).'
}
