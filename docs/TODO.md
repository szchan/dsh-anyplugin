# TODO

The burn-down list. Every line names an outcome that can be checked, and every
item is finished the same way (AGENTS.md §7): code, test, doc, and the coverage
row moving in one commit.

The design lives in `docs/ARCHITECTURE.md`; the reasons live in
`docs/DECISIONS.md`. This file only orders the work. If a line here disagrees
with those two, they win and this file is wrong.

Pins for everything below: DSH `0.2.2-rc.2` (Desktop install) and
`0.2.2-rc.5` / `0.2.2-rc.2` (npm-fetched harnesses, D22), claude-code `2.1.322`.

## Now

Nothing claimed.

## Next

- [ ] **Hook lifecycle events.** Wire the S9-confirmed session/turn seams
      (`agent/created`, `agent/disposed`, `agent/turn-stopping`) plus
      `subagent/start`/`subagent/end` into `materialize-hook`, with a fixture
      plugin whose hooks leave a marker the oracle can observe. Done when a new
      fixture's `hooks:SessionStart`, `hooks:Stop`, `hooks:SessionEnd`,
      `hooks:SubagentStart`, `hooks:SubagentStop` rows are `match` because the
      handlers ran, and the matrix grows rather than staying at 11.
- [ ] **Upstream mods as fixtures** (D14). Pull the seven mods under
      `mods/` from the pinned upstream revision into `fixtures/` (fetch at
      test time or from the installed tree; never vendored), starting with
      `diff` because it ships its own `hooks/` and `tests/`. Done when one
      real mod loads in the host and its own test expectations pass against us.

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
- [ ] Hook events with no host today (S9): `PreModelSwitch`, `InstructionsLoaded`,
      `DirectoryAdded`, `Setup`, `UserPromptExpansion`, `MessageDisplay`,
      `PostToolBatch`, `Notification`, `Elicitation`, `ElicitationResult` are
      refuted; `TaskCreated`, `TaskCompleted`, `TeammateIdle`,
      `WorktreeCreate`, `WorktreeRemove`, `StopFailure` are unprobed. The 14
      confirmed S9 events (9 listener seams and 5 notification-only) are wired
      next.
- [ ] `dsh-shell-env` — `PATH` contribution for plugin `bin/`.
- [ ] Monitor notifications: a background process's stdout reaching the model.
- [ ] Terminal ANSI palette (F2).

## Later

- [ ] **Mod host** (D3, ARCHITECTURE §7), in dependency order: static scanner →
      chain engine → element runtime → ~21 namespace bridges → type generation
      from the pinned `claude-code.d.ts`. Coverage is `covered / total` against
      that file, and it only moves up.
- [ ] **Codex dialect** (portable `plugin.json`), reusing the IR.
- [ ] **Escape layer** for model identity: `agents/*.md` naming `sonnet`/`opus`
      cannot be reimplemented on this runtime; delegate to the real host or
      annotate `unsupported`.

## Done

- CLI consent surface (D27): grant/revoke with all-or-nothing writes,
  re-consent on changed bytes, explicit `--replace-revoke`, and revocation that
  reads the record rather than the artifact.
- S1 loader substrate — five findings written into ARCHITECTURE §10.1.
- S3 conformance rig, both halves: upstream oracle (`claude plugin details`)
  and the installed DSH oracle.
- Upstream oracle in CI: the pinned `claude-code@2.1.322` is fetched from npm
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
- Interception kernel skeleton (`dsh-anyplugin-intercept`): ordering, matcher,
  decisions, budgets, trace, `observe`/`wrap` continuation modes.
- Skill argument engine: the documented rules ($N zero-based, $name,
  the trailer, escapes) implemented and tested against a recorded trace;
  waiting on the tool-schema seam (D17).
- S10 agents (D26) — one tool per `<plugin>:<agent>`, description byte for
  byte, body as the first block of the child user message; `fixtures/claude-agents`
  matches on a denominator of 11 (the nested planner is not loaded at the pin),
  and model/tools/limits stay `planned` with reasons.
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
  profile config.
- The upstream oracle runs in CI (D24): `@anthropic-ai/claude-code@2.1.322` is
  fetched, resolved through `CLAUDE_BIN`/PATH, version-guarded; a decoy in the
  fixtures test proves the probe uses the binary it was handed.
- Mod capability scanner (`dsh-anyplugin-mod-scan`): a lexical read of a mod's
  `register.ts` yields the event sites and `$.` calls an install grant would
  display, without vendoring or executing the mod (D21).
- Hook payload fixtures: 32 doc-derived payloads plus 6 live captures from
  2.1.322 (DeepSeek backend), run through `runChain`; the event table and
  matcher subject are derived from them (D15).
- MCP name budget, enforced at both moments: an over-budget prefix refuses the
  server at plan time (`claude-mcp-budget`) and an over-budget tool is skipped
  while its sibling registers (`claude-mcp-tool-budget`). The rig counts a
  deliberate refusal as `refused`, not `missing` (D11).
- MCP: stdio and streamable-http servers connect under the materializer and
  expose `mcp__plugin_<plugin>_<server>__<tool>` byte for byte (11 declared / 8 matched / 2 missing / 1 refused).
  The HTTP fixture carries `${ANYPLUGIN_MCP_URL}`, so the materializer resolves
  the URL from the environment at attach time instead of pinning a port.
- Skills: skills-dir, root `SKILL.md`, and the command model face materialize
  with 0 diff against the pinned goldens.
- D7 id escaping, D8 pin-gated surface mapping, D9 installed oracle, D22 version-resolved harnesses,
  D10 two faces for commands, D11 name budget arithmetic, D12 owned MCP path,
  D13 one owner for the chain's tier table and continuation modes, D15
  payloads own the event table, D16 the trace is the standard answer, D17 the
  skill argument rules and the missing channel, D18 the behavioral unit.
