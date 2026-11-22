# TODO

The burn-down list. Every line names an outcome that can be checked, and every
item is finished the same way (AGENTS.md §7): code, test, doc, and the coverage
row moving in one commit.

The design lives in `docs/ARCHITECTURE.md`; the reasons live in
`docs/DECISIONS.md`. This file only orders the work. If a line here disagrees
with those two, they win and this file is wrong.

Pins for everything below: DSH `0.2.2-rc.2` (Desktop install) and
`0.2.2-rc.5` / `0.2.2-rc.2` (npm-fetched harnesses, D22), claude-code `2.1.329`.

## Now

## Next

- [ ] Publish `dsh-anyplugin-ui`, the optional panel (D61, #170). `npm run
      pack:ui` produces the tarball and `npm run check:ui` holds its 64 KiB
      ceiling; the first npm publish needs a one-time 2FA approval from a
      maintainer, and until then the release workflow publishes only the root
      package.

## Upstream proposals (union-only seams, T2)

Each is a small, independent change that never alters existing behavior. Listed
with the exact anchor so the proposal is reviewable without a checkout.

- [ ] `dsh-commands:32` and `:126` — let a command name contain `:`.
      (Without it, the human face of every command stays `planned`, D10.)
- [ ] `dsh-commands:76` + `dsh-client-ui-commands` — a `submit` result kind that
      sends expanded text as a user message.
- [ ] `dsh-mcp-client:51` — derived namespace budget instead of a flat 32.
      Optional since D12; no longer on the critical path.
- [ ] `dsh-subagent` — a named, described agent catalog whose one
      `Task`-shaped tool carries the name/description pair. Optional since S10:
      S10 already makes agents selectable as one tool per agent (`catalog`
      exact, `invocation` equivalent); a catalog would restore Claude's
      single-tool shape and let a preset own the child system prompt, but it is
      no longer on the critical path.
- [ ] Hook events with no host today (S9, S23): `PreModelSwitch`,
      `InstructionsLoaded`, `DirectoryAdded`, `Setup`, `UserPromptExpansion`,
      `MessageDisplay`, `PostToolBatch`, `Notification`, `Elicitation`,
      `ElicitationResult` are refuted; `TeammateIdle` reaches `agent/status`
      idle but the pin records no `team/member`, so it needs host support.
      The nine listener seams are wired; the five S23 records are routed
      notification-only by the classic hook mount (D70), so they are no longer
      in this list. What remains for the refuted and idle events is host
      support above.
- [ ] `dsh-shell-env` — an ordered external-PATH contribution for plugin
      `bin/`. Anchor (S19, pinned 0.2.2-rc.5 and 0.2.2-rc.2): `register()` throws
      `bash env contributor "X" declared invalid key "PATH"` at
      `dsh-shell-env/src/index.ts:133-135`; the key type is `` `DSH_${string}` ``
      (`dsh-subprocess/src/types.ts:16`); the model-facing shell request has no
      `env` field (`dsh-tool-bash/src/index.ts:515-521`,
      `dsh-tool-pwsh/src/index.ts:542`); the child PATH is the inherited process
      PATH (`dsh-bash-local/src/index.ts:172`,
      `dsh-subprocess-local/src/spawn.ts:45-46`). A per-call
      `tools/pre-execute` rewrite can prepend the directory (S19 proves it runs
      a command), but it diverges: later hooks and the hook trace see the
      rewritten `tool_input`, while the session transcript still carries the
      model's original; pwsh syntax differs, and the ordering rule becomes an
      in-rewrite choice. Proposal: an append-only `extraPath` (or
      equivalent) on `ShellExecRequest`/`ShellEnvRegistry`, applied *after* the
      inherited PATH so the user's own entries still win (Claude's order),
      owned by plugin scope, and gated by the `bin/` files' exec grant (D25).
      Until it exists, `bin/` is `planned` (S19).
- [ ] Monitor notifications: a background process's stdout reaching the model.
      S22 answered the observation half: the pinned client (2.1.329) validates a
      plugin `monitors` declaration and never spawns it headless — 0 spawns and
      0 monitor bytes in the model traffic — so there is no observable parity
      target. The declaration half closed with D64 (#159): a manifest-shaped
      violation is fatal, a file-shaped one is carried as one `unsupported` row
      quoting the client's captured text, and a valid declaration stays
      `planned`. What remains is a product decision about the runtime channel,
      not a fidelity gap.
- [ ] Terminal ANSI palette (F2).

## Later

- [ ] **Mod host** (D3, ARCHITECTURE §7), in dependency order: static scanner →
      chain engine → element runtime → the remaining namespace bridges.
- [ ] **Author-facing mod types** (ARCHITECTURE §7.3) — `planned`. The generated
      `types/mod.d.ts` is an internal shape guard, not a consumer surface.
      Shipping types needs a ratified choice: either redistribute Anthropic's
      `claude-code.d.ts` (D14 forbids vendoring the artifact, and the licence
      does not grant redistribution) or derive an inline subset whose shapes are
      no longer copied verbatim (a different claim under D57).
      Blocked on: D14 (read the pin, do not vendor it), D57 (a served shape is
      copied verbatim), and a decision entry for the inline-subset path (D59
      proposed in #150; #144 generated the internal file).
- [ ] **Escape layer** for model identity: `agents/*.md` naming `sonnet`/`opus`
      cannot be reimplemented on this runtime; S16 annotates the faces
      `unsupported`, and delegating the component to the real host is the only
      path to honouring them.

## Done

- The installer is the published `bin` (ticket #146):
  `dsh-anyplugin` to `lib/cli.js`, which the build emits from the conformance
  rig's own `cli.ts`; `npx dsh-anyplugin install <dir> --dry-run` needs no DSH
  installation, and `check:pack` runs the extracted bin with no DSH environment,
  fails if a conformance-gate marker reaches shipped `lib/`, and holds the
  tarball under its 180 KiB ceiling.

- Mod type surface (ticket #144): `scripts/gen-mod-types.mjs` reads the pinned
  `mods/types/claude-code.d.ts` and `fixtures/mods/coverage.json` (D55) and
  writes `packages/dsh-anyplugin-mod-host/types/mod.d.ts` — the 9 served
  namespaces (`fixtures/mods/coverage.json` `totals.namespaces`) and their 26
  served members (`fixtures/mods/coverage.json` `totals.methods`) with the pin's
  own signature text (so
  `$.session.cwd` is `() => Promise<string>`, #138), and the 7 refused members
  (`fixtures/mods/coverage.json` `totals.methods`) as one closed
  `ERR_MOD_HOST_*` union. It imports the named helper types from
  the pin instead of vendoring them, names no absent member, and fails naming
  the member when a signature cannot be copied rather than guessing one. The
  generator verifies the ledger's pin and the declaration's sha256 before
  writing; `types.test.mjs` regenerates into a temp directory, compares (never
  rewrites), and asserts the served set, the absent set and the refused union
  against the ledger. Two runs are byte-identical. The file is an internal shape
  guard, not a shipped or author-facing surface: `check:pack` asserts the
  tarball contains no `types/` path, and shipping the real surface needs the
  choice in Later (redistribute the pin, which D14 forbids, or derive an inline
  subset that is a different claim under D57). Author-facing types are
  `planned`.

- Mod coverage ledger (ticket #130): `scripts/mod-coverage.mjs` scans the pinned
  `mods/types/claude-code.d.ts` by declaration and classifies every declared
  symbol against the runtime `$` table as `served`, `refused` (a typed
  `ERR_MOD_HOST_*` refusal under the recorded bridge configuration), `absent`, or
  `wrongShape`. It commits `fixtures/mods/coverage.json` with those sets for
  namespaces, methods, properties, events, surface-qualified elements, render
  sites and matcher type aliases, and asserts each runtime-comparable
  category's partition (matchers are counted by name only, not partitioned).
  Namespace rows count service, not presence: `process` and `settings` are
  refused-only (every member is refused), so the 24 declared namespaces are 9
  served / 2 refused-only / 13 absent (`fixtures/mods/coverage.json`
  `totals.namespaces`).
  `--update` rewrites it and rejects a runtime member the pin does not declare;
  `mod-api-ledger.test.mjs` fails on drift, and a served method removed from
  `bridge.ts` reddens it. Render sites are 1 served and 19 absent
  (`fixtures/mods/coverage.json` `totals.renderSites`), all planned except
  `Pane` on terminal. The ledger is a denominator, not a fidelity claim. The rest of
  the **Mod host** line (static scanner, chain engine, element runtime, remaining
  bridges) is still Later.
- Codex install end to end (ticket #101): `compile.ts` resolves a lock row's
  `dialect` through a two-entry registry (`claude-code` → `readClaudePlugin` +
  `claude-code@2.1.329`; `codex` → `readCodexPlugin` +
  `agent-plugins@1.0.0`), so a codex record reconciles into the same
  dialect-qualified group shape and runs in the pinned DSH oracle. The
  `codex@1.0.0` golden is hand-authored because there is no upstream Codex
  oracle (D33); `codex-e2e.test.mjs` diffs it, exercises the over-budget
  refusal and a bad-manifest compile problem, and the coverage matrix is
  unchanged.
- `$` bridge (ticket #46; measured by S15): across the five pinned mods the
  bridge is asked for 69 call sites / 30 `namespace.method` pairs in 11
  namespaces. Twenty-two methods are served; the six `ui.*` members
  `open/close/invalidate/log/status/resolve` are served through the headless
  render sink (#75): a submitted tree is checked against the pin's surface
  tables, element keys, required members and prop types (allowlists and literal
  unions) before it is recorded, the latest revision is kept per pane, `ui.render`
  and `ui.resolve` hooks are dispatched through the intercept kernel's
  `runChain` as sink-owned synthetic events (not host routes), `ui.invalidate`
  redraws on `ui.render`, drops the seat's prompt cache on
  `prompt.context`/`prompt.section` and refuses the other cached events it owns
  no cache for, and one `mod_ui` tool — registered only while a pane is open —
  reads the panes back. The host synthesizes `ui.render` only for
  `component: 'Pane'` on `surface: 'terminal'` and only for the mod's own panes;
  the pin's `ui.open`/`ui.close` hooks (`claude-code.d.ts:8875`/`:8880`
  @ 2.1.329) are declared but not dispatched, and `isPlaced: false` means open
  but never drawn. Two behaviours are `derived`, because this host has no
  drawing engine: the refusal sentence is ours (the pin draws the engine's own
  component instead) and an invalid redraw keeps the last good tree.
  `process.run`, `settings.read` and `ui.ask` are typed refusals (`ui.ask` is
  declared at `claude-code.d.ts:2856 @ 2.1.329`, but it answers through a
  person, which this host has no interaction for); `session.identity`,
  `session.root` and `fs.ancestors` are absent. `vcs.detect`/`vcs.diff` are
  served read-only for git (#119); the other four `vcs` members refuse
  `ERR_MOD_HOST_VCS_UNSUPPORTED`. `fs` resolves against the
  invocation session's cwd (absolute as written), `store` is rooted at the
  plugin data dir and confined on `realpath`, and `settings.read` serves only a
  host merged snapshot. `session.messages()` carries the tool-result turn in
  the pinned `toolResults` shape and `session.usage()` omits incomplete token
  context; `command.register` uses the real registry when present and refuses
  immediately when absent. `session.start` on a fresh `diff` load completes
  through four recorded calls (`session.usage → clock.now → command.register →
  session.messages`); the static, dynamic and transcript ledgers live in
  `packages/dsh-anyplugin-conformance/test/mods.test.mjs`. On the S15 turn only
  five calls are reached, all served; `session.usage()` returns empty shapes
  because the load-time event has no session. `tool.call` and `prompt.context`
  are routed (#69); the remaining measured gap is `tool.check` (refused: it is
  the engine's post-`PreToolUse` permission verdict, not the pre-execute gate)
  and `agent.spawn`, each authored by two of the five mods. `next.to` was absent
  from the mod continuation (fixed by #68; ARCHITECTURE §10.5).

- Mod `next` surface (ticket #68; pins DSH 0.2.2-rc.5 and mods commit
  `6e1e44f` / claude-code 2.1.322): the mod-visible continuation now serves the
  pinned seven members (`to`, `signal`, `is`, `event`, `origin`, `trace`,
  `budget`) as a projection over the kernel's own `Next`. `to(e, tier)` reuses
  the kernel's tier arithmetic and records every passed link as `skipped` with
  `bypassed by <plugin>` (by tier rank, so a same-tier sibling still runs);
  `ChainOptions.signal` aborts running handlers and the materializer passes
  `ToolExecution.signal` into the chain; `budget` pauses during `next` and `$`
  while classic hooks keep their snapshot; `trace` serves the pinned subset
  (`index`, `plugin`, `tier`, `event`, `outcome`, `reason`) without inventing
  `ms`/`chunks`/`received`/`returned`, excludes matcher skips, and reports a
  throwing link as `rejected`. Review corrections pinned by tests: a continuation is eager and call-scoped,
so a hook that calls `next` twice runs the remainder twice (our host contract;
the pin only says `trace` describes the latest call) and the latest trip is the
one its return and `trace` describe; an unawaited `next` is joined exactly once
and a later call joins the previous trip first (sequential, not concurrent);
when a same-tier sibling names its own target, the nested target wins over the
outer call's; pass-over is tier-ranked; fan-out
lands direct targets and falls forward when the named tier is empty; a
backwards `next.to` is refused by name; `core` is a declared fidelity gap
(pin allows it, this chain has no core link); and the meter counts the hook's
own work while `next`/`$` still pause.
  Pre-fix S15 reproduction: `TypeError: next.to is not a function` ×8, kernel
  `error` then `continue`. Post-fix sec-default end-to-end: seated at
  `prepend`, its guard skips a user-tier deny hook (tool runs, skip traced);
  unloaded, the same hook denies the call. Tests:
  `packages/dsh-anyplugin-intercept/test/mods.test.mjs`,
  `packages/dsh-anyplugin-mod-host/test/kernel-bridge.test.mjs` (synthetic
  guard `fixtures/mods/guard/`), and
  `packages/dsh-anyplugin-conformance/test/mods.test.mjs`. Pin correction:
  sec-default's `classic.*` guard bypasses user hooks; it does not deny a
  tool call. At 2.1.329 the D39 resolver fallback seats the same mod (45
  registrations), and the guard behavior above is the measured behavior at
  that pin too. The pre-fix defect was reported at the 2.1.322 line numbers
  (`claude-code.d.ts:4236` at the 2.1.322 pin); at 2.1.329 `GlobNext.to` is line 6666.

- Kernel bridge (ticket #36): `modRegistrationsToKernel` turns a loaded mod's
  `register(on)` registrations into kernel registrations (`mode: 'wrap'`,
  caller-supplied seating, source order preserved) so mods and classic hooks
  share one chain. `mod-events.ts` pins the mapping as data (24 live routes:
  21 classic, `session.start`, `tool.call` and `prompt.context`; 143 unmapped names with reasons and
  categories (`missing bridge` / `no host event` / `not in spec`; the table
  also enumerates `EngineEventOf`, `ClassicEventOf`, and `OpEventOf`)
  from S9), `on()` patterns (`classic.*`, `*`, negations) expand instead of
  being dropped, classic results are translated (`additionalContext`,
  `updatedInput`) or typed `unsupported`, and the fan-out `next()` divergence
  is stated and tested by default (D32).

- Mod host skeleton (ticket #33): `dsh-anyplugin-mod-host` loads an authored
  mod's `.ts` graph into a per-mod `node:vm` context under D30 (three
  resolution behaviors, in-memory type strip, no source rewrite), hands every
  registration a fresh `$` as the handler's first argument, and returns
  `register(on)`'s registrations. The synthetic fixture fires `session.start`
  with both measured sequences (`usage → command.register → session.messages`,
  and `clock.now` inserted when `usage()` returns `undefined`). The fetched
  `diff` mod loads through D34's classic transform (S14): the graph reaches
  `.tsx` through `views/index.ts`, and the host now transforms only JSX syntax
  under the file's own pragma. Before D34 that graph was refused at
  `views/pane-view.tsx` — the same refusal that blocked this item.
- CLI consent surface (D27): grant/revoke with all-or-nothing writes,
  re-consent on changed bytes, explicit `--replace-revoke`, and revocation that
  reads the record rather than the artifact.
- S1 loader substrate — five findings written into ARCHITECTURE §10.1.
- S3 conformance rig, both halves: upstream oracle (`claude plugin details`)
  and the installed DSH oracle.
- Upstream oracle in CI: the pinned `claude-code@2.1.329` is fetched from npm
  (D24), resolved through `CLAUDE_BIN`/`PATH`, and version-guarded, so both
  halves of the rig run on every `verify` job.
- Exec trust gate: `grants.yml` with hash-pinned grants, scope precedence
  (local revoke beats user grant), un-granted hooks moved to `planned` and
  absent from the entries handed to the loader, and `rig report` carrying
  `refused:exec` (D25).
- CLI grant/revoke (ticket #17): `rig grant` prints every ungranted exec
  artifact's target, mode, hash and exact command, writes only with `--yes`,
  is all-or-nothing unless `--partial` is explicit, and requires
  `--replace-revoke` to clear a same-scope revoke; `rig revoke` names the
  record that decides and exits non-zero while a narrower grant still allows
  the artifact.
- S5 tool-name budget — the 32-character cap is one plugin's schema (D12).
- Interception kernel (`dsh-anyplugin-intercept`), adopted by the classic hook
  materializer (ticket #25): ordering, matcher, decisions, budgets, trace,
  `observe`/`wrap` modes and `first-decision`/`fan-out` decision flows.
  `materialize-hook` registers every tool and lifecycle handler through
  `runChain` with fan-out, so the kernel owns tier order, matcher skips and
  decision collection; there is one `CLASSIC_SUBJECT_FIELD` table.
  `fixtures/claude-hooks-fanout` proves on a real turn that two matching
  `PostToolUse` hooks both run, which is the measured 2.1.322 behavior.
- Skill argument engine: the documented rules ($N zero-based, $name,
  the trailer, escapes) implemented and tested against a recorded trace;
  waiting on the tool-schema seam (D17).
- S10 agents (D26) — one tool per `<plugin>:<agent>`, description byte for
  byte, body as the first block of the child user message; `fixtures/claude-agents`
  matches its row in `coverage.test.mjs` (the nested planner is not loaded at
  the pin). Every frontmatter face is now answered per S16 (§10): `skills`
  `equivalent` when the plugin ships a non-empty body, `isolation` `planned`,
  the rest `unsupported` with reasons, never silently passed through.
- S8: hooks ride the tool waterfalls (`tools/pre-execute` deny →
  `Error: <reason>`, `tools/post-execute` value + `additionalContexts`); the
  guard list is denial-only and is not used (D19).
- Classic hook arm: command handlers run with an honest payload, exit-code and
  JSON verdicts translate, and a PostToolUse hook's text is observed on a real
  call — the row flipped because the hook ran, not because a listener existed
  (D20).
- Trace oracle (`rig trace`): a recorded turn normalizes into an ordered
  event stream and diffs positionally; upstream-only until DSH can record what
  reaches the model (D18).
- Hook lifecycle events (S9): `agent/created`, `agent/turn-stopping`,
  `agent/disposed`, `subagent/start` and `subagent/end` now mount
  SessionStart, Stop, SessionEnd, SubagentStart and SubagentStop through the
  same matcher/verdict path as the tool hooks; a real headless turn plus one
  delegated child made every handler write its line, so every row is `match`
  in `coverage.test.mjs` (oracle recipe in ARCHITECTURE §10 S9).
- Behavior oracle: `claude plugin eval` runs upstream suites and yields
  per-run traces; the skill envelope and its missing argument substitution were
  found there (D16).
- Fidelity report from a live emit run (`rig report <plugin-dir>`): every
  component prints `carry=emitted|skipped|refused` beside its face annotations,
  and `carried` is computed from what emit actually *considered*, not from what
  the IR happened to contain (`EmitResult.considered`).
- The harness comes from npm, and CI fails when it cannot (D22):
  `resolveHarness()` prefers `DSH_HARNESS_DIR`, then the Desktop install, then
  `.harness/<version>`; `scripts/fetch-harness.mjs` is the explicit, idempotent
  fetch; the `verify` job runs both `0.2.2-rc.5` and `0.2.2-rc.2`, and a skip
  is a failed job.
- Install + reconcile (D23): `installs.yml` is the lock, three scope layers
  decide enablement (narrower wins), and `reconcile` converges loader entries
  by stable id — created, updated, removed, kept, failed — without writing
  profile config. The lifecycle CLI writes that lock through the one canonical
  writer (`dsh-anyplugin install|list|enable|disable|uninstall`; in a checkout
  `npm run rig --` takes the same flags), enables without inventing a scope,
  and reports the same carry rows as `dsh-anyplugin report`; every mutating
  command has a byte-checksummed `--dry-run`.
- The upstream oracle runs in CI (D24): `@anthropic-ai/claude-code@2.1.329` is
  fetched, resolved through `CLAUDE_BIN`/PATH, version-guarded; a decoy in the
  fixtures test proves the probe uses the binary it was handed.
- Upstream mods at 2.1.329 (D14; closes the 2.1.322-pin item): the table now
  carries all seven mods, with `easel` and `hipaa-default` measured, and all
  seven load. `sec-default`'s author added extensionless *file* imports; the
  D39 resolver fallback (file before directory) serves them, so the table
  records 45 registrations and no refusal. Its eight classic invocations are
  live; after #70 the continuation serves `next.to`, and S15 reports 0 handler
  errors at this pin.
- Mod capability scanner (`dsh-anyplugin-mod-scan`): a lexical read of a mod's
  `register.ts` yields the event sites and `$.` calls an install grant would
  display, without vendoring or executing the mod (D21).
- Hook payload fixtures: 32 doc-derived payloads at 2.1.329 plus 6 live
  captures from 2.1.322 (DeepSeek backend), run through `runChain`; the event
  table and matcher subject are derived from them (D15).
- MCP name budget, enforced at both moments: an over-budget prefix refuses the
  server at plan time (`claude-mcp-budget`) and an over-budget tool is skipped
  while its sibling registers (`claude-mcp-tool-budget`). The rig counts a
  deliberate refusal as `refused`, not `missing` (D11).
- MCP: stdio and streamable-http servers connect under the materializer and
  expose `mcp__plugin_<plugin>_<server>__<tool>` byte for byte; the row set and
  totals are asserted in `coverage.test.mjs`, not restated here.
  The HTTP fixture carries `${ANYPLUGIN_MCP_URL}`, so the materializer resolves
  the URL from the environment at attach time instead of pinning a port.
- Skills: skills-dir, root `SKILL.md`, and the command model face materialize
  with 0 diff against the pinned goldens.
- D7 id escaping, D8 pin-gated surface mapping, D9 installed oracle, D22 version-resolved harnesses,
  D10 two faces for commands, D11 name budget arithmetic, D12 owned MCP path,
  D13 one owner for the chain's tier table and continuation modes, D15
  payloads own the event table, D16 the trace is the standard answer, D17 the
  skill argument rules and the missing channel, D18 the behavioral unit.
