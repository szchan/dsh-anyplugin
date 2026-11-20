# S15 — what the five pinned mods demand on one real turn

**Pins.** DSH `0.2.2-rc.5` (`DSH_HARNESS_DIR`), upstream mods
`6e1e44f6433bfa17d198e932bff53373aa229eea` / claude-code `2.1.322`
(`UPSTREAM_MODS_PIN`). **Question.** Which events and which `$` members do the
five pinned mods actually use, and which of those does the host serve?

This is a measurement spike, not a fix. It changes no refusal, annotation,
materializer, kernel or host behavior. The one host defect it found is reported
in §6 and left in place (measure, do not fix).

## 1. Run it

The mod tree is fetched once, explicitly; the spike never fetches and never
touches the network or a model key:

```bash
export DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5
export DSH_HARNESS_VERSION=0.2.2-rc.5
export CLAUDE_BIN=$PWD/.claude-code/2.1.322/node_modules/@anthropic-ai/claude-code-linux-x64/claude
node scripts/fetch-harness.mjs 0.2.2-rc.5
node scripts/fetch-claude.mjs
export ANYPLUGIN_MODS_TREE=$(node scripts/fetch-mod.mjs)
node --experimental-vm-modules spikes/s15-mod-demand/run.mjs
```

With `ANYPLUGIN_MODS_TREE` unset it prints
`s15-mod-demand: skipped (ANYPLUGIN_MODS_TREE is unset); see spikes/s15-mod-demand/REPORT.md`
and exits 0. It is deliberately **not** in `npm test`: the five-mod tree is a
fetched artifact (D14) and a test must not fetch it. `--experimental-vm-modules`
is required by D30's `SourceTextModule`; without it every mod load is refused
with the same warning and the spike exits 1.

Outputs are written under `spikes/s15-mod-demand/out/` (gitignored):
`observed.json` is the value-free ledger; `data/trace.jsonl` is the real
materializer's kernel trace, one line per chain plus its warnings.

## 2. The turn

The S9 headless-turn recipe (`probeLifecycleWithDsh` in
`packages/dsh-anyplugin-conformance/src/oracles/dsh.ts:385-640`; the S9 entry
is §13 of `docs/ARCHITECTURE.md`), unchanged:

- a stub `LlmAdapter` returns, in order, one **real** `Bash` call and then a
  final text block; the `Bash` tool is a real registered tool;
- the root agent is created **after** the plugin entry loads, so the load-time
  `session.start` has no session (the D32 consequence);
- one user prompt drives the turn; a **real** `fork` subagent is started and
  disposed; the root is detached at the end.

That produces one `session.start` per loaded plugin, `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`,
`SubagentStop`, and `SessionEnd`. Five mods are installed as five materializer
children (one plugin root each — `apply()` resolves all of a materializer's
`mods[]` from a single `config.pluginRoot`), with a shared `traceFile`, a
`commands` child so `$.command.register` reaches the real registry, and a
distinct plugin name per mod so the kernel trace names the mod.

`session.start` is fired once per materializer apply (D32 §4): five applies
here, and exactly one handler invocation for each of the three mods that
registers it (`agents-md`, `diff`, `telemetry`). No handler sees it twice.
The event is load-time, so `$` has no session at that point.

## 3. How the observation works (and what it does not add)

The recording `$` is the **real** bridge, wrapped once:

- `packages/dsh-anyplugin-mod-host/src/bridge.ts` builds the real namespace
  table. A spike-local `createModBridge` shim calls the real factory and returns
  the same bridge with `dollar()` replaced by a `Proxy` over the table the real
  `dollar()` just returned. Every namespace, method, value and refusal is the
  real one; only the read/call is recorded. No namespace is reimplemented and no
  method is stubbed.
- A second shim wraps `loadMod`/`modRegistrationsToKernel` with an
  `AsyncLocalStorage` attribution record (`mod`, `on()` line, kernel event,
  route) so a `$` call is attributed to the exact authored handler. It runs the
  real loader, the real materializer, the real dispatch and the real kernel.
- Two ESM resolve hooks redirect only the materializer's imports of
  `../dsh-anyplugin-mod-host/src/index.ts` and
  `../../dsh-anyplugin-intercept/src/index.ts` to the shims. The shims
  `export *` the real modules. This is observation scaffolding, not a second
  dispatcher (AGENTS §3.6): the entry tree, the materializer's seating, the
  kernel chain and the host payloads are all the real ones.

Recorded shape, per invocation: mod, authored event and line, kernel event,
route, payload **key names**, status, `$` groups and calls. A call records
`namespace`, `method`, argument **key names only** (`{event,props}`,
`{description,name}`, `()`) and an outcome: `returned`, `resolved`,
`refused:<CODE>`, `threw:<Name>`, `missing`, or `read`. No argument value, no
event value and no return value is written. `trace.jsonl` is the materializer's
own trace, so it contains the real payloads; it stays in `out/`.

## 4. Per mod, per handler

The authored sites are the scanner's literal `on()`/`$.ns.method` sites
(`packages/dsh-anyplugin-mod-scan/src/index.ts`), with exact
`mods/<name>/hooks/register.ts:<line>` positions. "received" lists the kernel
events that actually invoked the handler; the payload-key column lists the key
names the handler saw.

| mod | authored `on()` | line | received | handler | `$` calls observed | outcome |
| --- | --- | ---: | --- | --- | --- | --- |
| agents-md | `session.start` | 50 | `session.start` ×1 | `ran` | `$.telemetry.log({event,props})` | returned |
| agents-md | `prompt.context` (matcher) | 75 | — | never called | — | unmapped (no route) |
| agents-md | `prompt.context` | 99 | — | never called | — | unmapped |
| agents-md | `agent.spawn {fork:true}` | 169 | — | never called | — | unmapped |
| agents-md | `tool.call {tool:'Read'}` | 181 | — | never called | — | unmapped |
| diff | `session.start` | 938 | `session.start` ×1 | `ran` | `$.session.usage()`; `$.clock.now()`; `$.command.register({description,name})`; `$.session.messages()` | resolved ×4 |
| diff | `ui.render {PromptHint}` | 982 | — | never called | — | unmapped |
| diff | `ui.render {Pane}` | 1003 | — | never called | — | unmapped |
| diff | `command.run {diff}` | 1057 | — | never called | — | unmapped |
| diff | `ui.close` | 1116 | — | never called | — | unmapped |
| diff | `ui.focus` | 1158 | — | never called | — | unmapped |
| diff | `ui.scroll` | 1180 | — | never called | — | unmapped |
| diff | `command.run {clear,resume}` | 1201 | — | never called | — | unmapped |
| diff | `tool.call {editing,shell}` | 1276 | — | never called | — | unmapped |
| diff | `prompt.submit` | 1294 | — | never called | — | unmapped |
| privacy | `tool.check {tool}` | 14 | — | never called | — | unmapped |
| sec-default | `classic.*` | 30 | 8 classic events (below) | **`error` ×8** | none — `next.to` throws first | `TypeError: next.to is not a function` |
| sec-default | `prompt.section` | 34 | — | never called | — | unmapped |
| sec-default | `prompt.context` | 35 | — | never called | — | unmapped |
| sec-default | `prompt.attachment` | 39 | — | never called | — | unmapped |
| sec-default | `prompt.compose` | 40 | — | never called | — | unmapped |
| sec-default | `skill.prompt` | 41 | — | never called | — | unmapped |
| sec-default | `attribution.text` | 42 | — | never called | — | unmapped |
| sec-default | `session.append` ×5 | 44/47/50/53/56 | — | never called | — | unmapped |
| sec-default | `session.compact` | 63 | — | never called | — | unmapped |
| sec-default | `settings.read` | 65 | — | never called | — | unmapped |
| sec-default | `tool.describe` | 71 | — | never called | — | unmapped |
| sec-default | `command.describe` | 72 | — | never called | — | unmapped |
| sec-default | `agent.offer` | 73 | — | never called | — | unmapped |
| sec-default | `agent.spawn` | 74 | — | never called | — | unmapped |
| sec-default | `tool.register` | 76 | — | never called | — | unmapped |
| sec-default | `tool.list` | 101 | — | never called | — | unmapped |
| sec-default | `tool.check` | 113 | — | never called | — | unmapped |
| sec-default | `ui.log` | 162 | — | never called | — | unmapped |
| sec-default | `env.get` | 170 | — | never called | — | unmapped |
| sec-default | `env.set` | 177 | — | never called | — | unmapped |
| sec-default | `plugin.register {tier:'user'}` | 211 | — | never called | — | unmapped |
| telemetry | `telemetry.*` | 27 | — | never called | — | route pattern matches no event |
| telemetry | `telemetry.log` | 31 | — | never called | — | unmapped |
| telemetry | `telemetry.mark` | 37 | — | never called | — | unmapped |
| telemetry | `session.start` | 41 | `session.start` ×1 | `ran` | none | — |
| telemetry | `session.end` | 47 | — | never called | — | unmapped |
| telemetry | `engine.create` | 53 | — | never called | — | unmapped |

**Events actually received, with payload key names.** The eight classic events
reach sec-default's handler; all eight then throw in the handler (see §6). The
`session.start` payload is only `cwd`; the `$` for those three invocations has
`sessionId: null`.

| event | mod(s) | payload keys (mod-visible) | handler result |
| --- | --- | --- | --- |
| `session.start` | agents-md, diff, telemetry | `cwd` | ran ×3 (one per mod) |
| `SessionStart` | sec-default (`classic.SessionStart`) | `cwd, hook_event_name, model, session_id, source` | error |
| `UserPromptSubmit` | sec-default | `cwd, hook_event_name, prompt, session_id` | error |
| `PreToolUse` | sec-default | `command, tool, tool_use_id` — the pinned `ToolCallEnvelope` (tool arguments spread beside `tool`/`tool_use_id`) | error |
| `PostToolUse` | sec-default | `cwd, hook_event_name, tool_input, tool_name, tool_response, tool_use_id` | error |
| `Stop` | sec-default | `cwd, hook_event_name, session_id` | error |
| `SubagentStart` | sec-default | `agent_id, cwd, hook_event_name, session_id` | error |
| `SubagentStop` | sec-default | `agent_id, cwd, hook_event_name, last_assistant_message, session_id` | error |
| `SessionEnd` | sec-default | `cwd, hook_event_name, session_id` | error |

The real turn produced one `Bash` call and one child agent, and the traces show
one chain per event; `SessionStart`, `PreToolUse`, `PostToolUse`,
`SubagentStart`/`Stop` and `SessionEnd` all fired at their real seams. Eight of
the sixteen routed classic events were **not** exercised by this turn:
`PostToolUseFailure`, `PermissionRequest`, `PreCompact`, `PostCompact`,
`PermissionDenied`, `CwdChanged`, `FileChanged`, `ConfigChange`.

**Tool results.** `toolCalls: 1` (one `Bash` invocation; the argument key is
`command`). The stub adapter then returned its final text, `Stop` fired, the
child was disposed and the root detached.

## 5. Typed refusals and missing members on this turn

- Typed refusals returned on the executed path: **0**. The paths that would
  refuse were not reached because their handlers never ran.
- Typed refusals the bridge declares, unexercised on this turn:
  `$.ui.*` → `ERR_MOD_HOST_UI_UNSUPPORTED` (six methods); `$.process.run` →
  `ERR_MOD_HOST_EXEC_UNSUPPORTED`; `$.settings.read` →
  `ERR_MOD_HOST_SETTINGS_SOURCE` (with a `source`), or
  `ERR_MOD_HOST_SETTINGS_UNAVAILABLE` without a merged reader.
- Missing bridge members, which would be `undefined` if the handler ran:
  `$.session.identity`, `$.session.root`, `$.fs.ancestors`.
- Served, but with a recorded omission: `$.session.usage()` returns the session
  usage shape with `startedAt`, `context`, `rateLimits` and `cost` omitted —
  four warnings, never zeroed. On this load-time call there is no session at
  all, so it returns the empty usage shape.
- Served and exercised: `$.telemetry.log`, `$.session.usage`,
  `$.clock.now`, `$.command.register`, `$.session.messages`.
  `$.command.register` used the real `dsh-commands` registry (the `commands`
  child was loaded); a later duplicate name would name the mod that collided.

## 6. Host bug found: `next.to` was absent from the mod continuation (fixed by #68)

**Severity: the only routed handler in this turn that gets a continuation
throws, and the kernel fails open.** This was the most valuable finding of the
spike. The measurement below is what the turn recorded before the fix; #68 now
serves the member from the kernel's own continuation, and the tests named at the
end of this section assert the semantics.

What the pin declares (canonical `Next`, `.mods/<commit>/mods/types/claude-code.d.ts:5271-5352`;
the same seven members appear as `GlobNext` at `:4236`):

- `readonly to: { <T>(e: Args<N> & ToolNamed<T>, tier: TargetTier): Promise<NextResultFor<N, O, T>>; (e: Args<N>, tier: TargetTier): Promise<O> }`
  (`TargetTier` is `append | builtin | core`, `claude-code.d.ts:9938`).

What the host gives a mod:

- `packages/dsh-anyplugin-mod-host/src/index.ts:101`:
  `export type ModNext = (event?: unknown) => unknown` — no `to`.
- `packages/dsh-anyplugin-mod-host/src/index.ts:214` (`copyNextSurface`) says
  it carries `to`/`origin`/`trace`/`budget` from the host continuation, but the
  kernel continuation it is copying from does not have `to`.
- `packages/dsh-anyplugin-intercept/src/index.ts:182`:
  `Next = (event?, tier?) => Promise<Decision>` — no `to`; the second argument
  is the *tier* parameter, not a member.
- `packages/dsh-anyplugin-intercept/src/index.ts:739` (`runModHandler`, at :732) builds a
  **fresh bare** `modNext` and passes it to the handler; it never attaches the
  pinned surface. The `.catch` copy path is therefore also empty.
- `packages/dsh-anyplugin-intercept/src/index.ts:1069` (`record(…, 'error')`): when a mod handler
  throws, the kernel records `error` and `continue`s. The chain's decision above
  sec-default was `{"kind":"continue"}` on all eight events.

Evidence from the turn: `sec-default/hooks/register.ts:30` is
`on('classic.*', ($, e, next) => next.to(e, 'append'))`. Its handler was
invoked for exactly the eight classic events in §4, made **zero `$` calls**
(the throw is before any `$` use), and failed with
`TypeError: next.to is not a function` eight times. Because the kernel continues,
the built-in managed-tier guard enforces nothing: a security mod that is meant
to append its policy to every classic event has no effect, silently (the error
is in the trace, not in the decision).

This is not a declared refusal. D36's principle is explicit: a member the host
cannot serve must refuse at registration time, naming the member, "never an
`undefined` that explodes at the mod's first call." `next.to` is an `undefined`
that explodes at the first call. The host `ModNext` type and the kernel `Next`
type need to agree on the pinned `Next` surface (or the host must refuse the
member at load); the kernel's error path also needs a decision — "fail open"
is a deliberate behavior for some events, but it makes this bug invisible unless
the trace is read.

**Fixed after the spike (#68).** The mod-visible `next` is now the kernel's own
continuation with the pinned seven members projected onto it: `to` reuses the
kernel's tier order and records every passed-over link as `skipped` with
`bypassed by <plugin>`; a jump is computed by tier rank, so a same-tier sibling
still runs, the landing is inclusive of the named target (a direct jump runs
it), a named tier with no link left falls forward, and a first-decision
continuation is returned rather than re-entered. A second `next` or a
backwards `next.to` is refused by name instead of silently reusing the first
result or resolving without running. `signal` is the handler's controller, fired by its timeout and
linked to `ChainOptions.signal` (the materializer passes `ToolExecution.signal`
for PreToolUse/PostToolUse); `origin` is the host raiser `{plugin:"engine",
tier:"core"}`; `budget` is live and pauses during `next` and `$` (via
`pauseWhilePending`), while classic hooks keep their entry snapshot; `trace`
serves the pinned `TraceEntry` subset (`index`, `plugin`, `tier`, `event`,
`outcome`, `reason` — `ms`/`chunks`/`received`/`returned` are not invented).
A throwing link is `rejected` with the throw as its reason; a matcher skip never
ran and is not projected. The subset is continuation-specific: first-decision
sees the settled links beneath the call, whereas fan-out is empty after
`await next(e)` and holds the pass-over after `next.to`. The `TargetTier`
contract is enforced: `prepend`/`user` refuse, and `core` refuses with a reason
because this chain's innermost link is `builtin`.

Tests: `packages/dsh-anyplugin-intercept/test/mods.test.mjs` pins the member
semantics (skip + forward-only, direct-target and missing-tier landings,
first-decision `next`/`to` single-run, fan-out same-tier sibling,
repeated-`next` refusal, backward-`to` refusal, matcher-skip exclusion,
`rejected`, budget arithmetic and pause across `next` and `$`, classic budget
snapshot, timeout abort, empty fan-out subset, signal,
`is`/`event`/`origin`/`budget`, tier refusal);
`packages/dsh-anyplugin-mod-host/test/kernel-bridge.test.mjs` pins the
deny-only guard/unloaded contrast with `fixtures/mods/guard/`; and
`packages/dsh-anyplugin-conformance/test/mods.test.mjs` reproduces this turn
with sec-default seated at `prepend` — the user-tier deny hook is skipped
(`PreToolUse#0`, `bypassed by sec-default`), the tool call executes, and with
the mod unloaded the same hook denies.

Pin correction recorded by the fix: sec-default's guard is
`next.to(e, 'append')` — org policy keeps user-installed classic hooks out of
its chain. It does not deny a tool call; its deny paths ride unmapped engine
events. So the turn proves the bypass, and the direct deny/unloaded contrast
uses the synthetic guard fixture rather than sec-default.

## 7. Demand we do not serve, ranked by how many of the five mods hit it

Ranking is the number of the five mods that author the demand, then severity.
"Status" is what the host would do *if the handler ran*; "observed" is what this
one turn actually reached. The static scanner proves every site; a site in a
handler that never runs is demand we cannot see on this turn, not proof that it
would fail.

| # | demand | mods | authored sites | status | observed on this turn |
| ---: | --- | :---: | --- | --- | --- |
| 1 | `$.ui.*` (6 methods, all refused) | **3/5** | `mods/agents-md/hooks/register.ts:57,151`; `mods/diff/hooks/register.ts:956,957,958,959,960,1008`; `mods/sec-default/hooks/register.ts:140,218` | `ERR_MOD_HOST_UI_UNSUPPORTED` (declared) | 0 calls; no routed handler reached a `ui.*` site |
| 2 | `session.start` has no session: `$.session.*` degraded/refused | **3/5** | `mods/agents-md/hooks/register.ts:50`; `mods/diff/hooks/register.ts:938`; `mods/telemetry/hooks/register.ts:41` | event served; `session.id` refuses `ERR_MOD_HOST_SESSION_UNAVAILABLE`; `usage`/`messages` empty | `usage`, `messages` resolved; 4 omitted-field warnings |
| 3 | `tool.check` event never routed | **2/5** | `mods/privacy/hooks/register.ts:14`; `mods/sec-default/hooks/register.ts:113` | unmapped by D32 | privacy: 0 invocations; sec-default: registration unmapped |
| 4 | `tool.call` event never routed | **2/5** | `mods/agents-md/hooks/register.ts:181`; `mods/diff/hooks/register.ts:1276` | unmapped | 0 invocations |
| 5 | `prompt.context` event never routed | **2/5** | `mods/agents-md/hooks/register.ts:75,99`; `mods/sec-default/hooks/register.ts:35` | unmapped | 0 invocations |
| 6 | `agent.spawn` event never routed | **2/5** | `mods/agents-md/hooks/register.ts:169`; `mods/sec-default/hooks/register.ts:74` | unmapped | 0 invocations |
| 7 | `$.settings.read` | **2/5** | `mods/diff/hooks/register.ts:952`; `mods/sec-default/hooks/register.ts:86,103,120,155,186,214` | `ERR_MOD_HOST_SETTINGS_SOURCE` / `_UNAVAILABLE` (declared) | 0 calls |
| 8 | `next.to` on the mod continuation | 1/5 | `mods/sec-default/hooks/register.ts:30` (one handler, all classic events) | **`TypeError`**; kernel fails open (fixed by #68) | **8 errors**; no `$` calls (pre-fix measurement) |
| 9 | `$.session.root` | 1/5 | `mods/agents-md/hooks/register.ts:108,194` | missing member | unobservable (host not routed) |
| 10 | `$.fs.ancestors` | 1/5 | `mods/agents-md/hooks/register.ts:116,126,206,214,215` | missing member | unobservable |
| 11 | `$.session.identity` | 1/5 | `mods/privacy/hooks/register.ts:27` | missing member | unobservable |
| 12 | `$.process.run` | 1/5 | `mods/diff/hooks/register.ts:944` | `ERR_MOD_HOST_EXEC_UNSUPPORTED` (declared) | 0 calls (bound as a thunk, not invoked) |
| 13 | `ui.render` event (PromptHint, Pane) | 1/5 | `mods/diff/hooks/register.ts:982,1003` | unmapped | 0 invocations |
| 14 | `command.run` event (diff, clear/resume) | 1/5 | `mods/diff/hooks/register.ts:1057,1201` | unmapped | 0 invocations |
| 15 | `telemetry.*` / `session.end` / `engine.create` events | 1/5 | `mods/telemetry/hooks/register.ts:27,31,37,47,53` | unmapped | 0 invocations; `telemetry.*` matches no event at the pin |

The `$` surface as a whole, measured over all five mods (not just this turn):
**50 call sites, 27 distinct `namespace.method` pairs, 10 namespaces.** Of the
27: **16 served**, **8 typed refusals** (the six `ui.*` methods, `process.run`,
`settings.read`), **3 absent** (`session.identity`, `session.root`,
`fs.ancestors`). Only five calls are reached on this one turn; the rest are
authored in handlers the event router never seats (or, for `diff`, bound as lazy
thunks that this path does not invoke). The full per-method list with every
site is in `out/observed.json`, and the run prints it with its surface status.

**Top five rows of the demand table:** ui (3/5), `session.start` without a
session (3/5), `tool.check` (2/5), `tool.call` (2/5), `prompt.context` (2/5).
`agent.spawn` and `settings.read` tie at 2/5 immediately after them.

## 8. The exact command and its output tail

```console
$ cd /tmp/anyplugin-wt/ticket-62
$ DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
  DSH_HARNESS_VERSION=0.2.2-rc.5 \
  ANYPLUGIN_MODS_TREE=$PWD/.mods/6e1e44f6433bfa17d198e932bff53373aa229eea \
  node --experimental-vm-modules spikes/s15-mod-demand/run.mjs
```

```console
s15-mod-demand: five mods × one real headless turn (harness 0.2.2-rc.5, mods 6e1e44f6433b)
tree:     .../.mods/6e1e44f6433bfa17d198e932bff53373aa229eea
commands: anyplugin.s15-mod-demand (5 materializer children)
tool:     1 Bash call; child agent: started
session.start: 3 handler invocation(s) — agents-md ×1, telemetry ×1, diff ×1; load-time, no session in $

per mod / handler:
  agents-md    session.start → session.start (session.start) × 1
    session.start [ran] $.telemetry.log({event,props}) → returned
  diff         session.start → session.start (session.start) × 1
    session.start [ran] $.session.usage → resolved; $.clock.now → resolved; $.command.register({description,name}) → resolved; $.session.messages → resolved
  privacy      — no handler ran (registrations are not routed by D32)
  sec-default  classic.* → SessionStart (classic.SessionStart) × 1
  ...
  sec-default  classic.* → SessionEnd (classic.SessionEnd) × 1
    classic.* [error: next.to is not a function] (no $ calls)   [×8]
  telemetry    session.start → session.start (session.start) × 1
    session.start [ran] (no $ calls)

trace: 82 lines; invocations: 11; $ groups: 11; $ calls: 5
handler errors: 8 (sec-default: TypeError: next.to is not a function)
$ refusals on the executed path: 0

authored $ demand (scanned from all five mods; status is the bridge surface):
  3/5 ui.log                 refused:ERR_MOD_HOST_UI_UNSUPPORTED    agents-md, diff, sec-default
  2/5 env.get                served                                 agents-md, diff
  2/5 settings.read          refused:ERR_MOD_HOST_SETTINGS_SOURCE   diff, sec-default
  2/5 telemetry.log          served                                 agents-md, diff
  2/5 telemetry.mark         served                                 agents-md, diff
  1/5 clock.after            served                                 diff
  ...
  1/5 session.identity       missing                                privacy
  1/5 session.root           missing                                agents-md
  ...
result: OK (turn assertions passed; handler errors are recorded above)
```

`trace: 82 lines` is 11 chain lines, 69 warnings (65 unmapped/surface reasons
and 4 `session.usage` omissions) and 2 `unsupported` payload lines. The `...`
elisions are only repeated rows; the
full output is ~90 lines. Exit status 0: the turn itself is the assertion
(one `session.start` per mod, one real tool call, one real child, all eight
classic events), and handler errors are recorded as data, not swallowed.

## 9. What this does not prove

- **One turn, one model stub.** No second user turn, no compaction, no
  permission request, no tool failure, no cwd/settings/file change: eight of
  the sixteen routed classic events were not exercised. Their payload keys are
  therefore not evidenced here.
- **Only literal sites.** The scanner reads `on('…')` and `$.ns.method` call
  sites; a computed event name or `$` access is `dynamic` and is counted as
  such by the scanner, not measured. `SCAN_CAVEAT` in
  `packages/dsh-anyplugin-mod-scan/src/index.ts` applies.
- **No values, by construction.** The report can say a handler called
  `$.command.register({description,name})`, not what it registered. Return
  shapes are inferred only from the bridge code and the recorded warnings.
- **One install shape.** Five plugins, five materializer children. A real
  install with one materializer holding five `mods[]` is not the same shape:
  `apply()` uses one `config.pluginRoot` for all of them, so it cannot load five
  different plugin roots. A single `session.start` dispatch per *plugin* is the
  D32 contract; this report does not claim a single process-wide dispatch.
- **Observation-only shims.** The two ESM shims exist only for this spike. They
  preserve the real factory, loader, materializer and kernel, but module
  identity across the shim boundary is not exercised (nothing in these five
  mods compares `instanceof` across it). The turn is key-less and network-less;
  no real model behavior is claimed.
- **No classic-only harness wiring.** In mods mode the materializer mounts the
  mod registrations; the classic hook fixtures are not part of this turn. The
  eight classic events above reached the mod's `classic.*` registration, not a
  classic `.mjs` hook.

## 10. Verification

Run with both pins (`0.2.2-rc.5` harness, `2.1.322` CLI) and the fetched mod
tree; output tail:

```console
$ DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
  CLAUDE_BIN=$PWD/.claude-code/2.1.322/node_modules/@anthropic-ai/claude-code-linux-x64/claude \
  ANYPLUGIN_MODS_TREE=$PWD/.mods/6e1e44f6433bfa17d198e932bff53373aa229eea \
  ANYPLUGIN_MOD_TREE=$PWD/.mods/6e1e44f6433bfa17d198e932bff53373aa229eea \
  npm run verify
> dsh-anyplugin@0.0.0 check:arch
> node scripts/check-architecture.mjs
architecture: 18 packages / 46 files, no violations

> dsh-anyplugin@0.0.0 test
> node --experimental-vm-modules --test 'packages/**/*.test.mjs'
...
ℹ tests 414
ℹ suites 0
ℹ pass 414
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38673.595052
```

Both pins are explicit: the DSH tree is `0.2.2-rc.5`, `CLAUDE_BIN` is the
fetched `2.1.322` native binary (the suite asserts `claude-code@2.1.322`). The
two mod-tree variables are both needed: the upstream-mods test reads
`ANYPLUGIN_MODS_TREE` (plural), the fetched-diff fixture reads
`ANYPLUGIN_MOD_TREE` (singular). With only the plural set, the run is 412 pass
/ 0 fail / **2 skip**, and both skips say
`ANYPLUGIN_MOD_TREE is unset; run the fetch-mod script` — the documented
mod-tree skip. With both set, there are no skips. The spike is intentionally not
part of `npm test`: it needs the fetched tree and must not fetch at test time.
`check:arch` is clean because no package changed.
