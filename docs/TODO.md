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

_(empty — the next item is chosen from Next.)_

## Next

- [ ] **Upstream mods as fixtures** (D14). Pull the seven mods under
      `mods/` from the pinned upstream revision into `fixtures/` (fetch at
      test time or from the installed tree; never vendored), starting with
      `diff` because it ships its own `hooks/` and `tests/`. Done when one
      real mod loads in the host and its own test expectations pass against us.
- [ ] **Agents.** Needs a catalog seam (`dsh-subagent` has a provider registry,
      not a discoverable directory). Done when `fixtures/claude-agents` matches
      and the persona is selectable by description.
- [ ] **Install / enable / uninstall.** `installs.yml` + three-layer scope
      replay, materialized through the loader; no runtime writes to profile
      config (AGENTS.md §3.4).

## Upstream proposals (union-only seams, T2)

Each is a small, independent change that never alters existing behavior. Listed
with the exact anchor so the proposal is reviewable without a checkout.

- [ ] `dsh-commands:32` and `:126` — let a command name contain `:`.
      (Without it, the human face of every command stays `planned`, D10.)
- [ ] `dsh-commands:76` + `dsh-client-ui-commands` — a `submit` result kind that
      sends expanded text as a user message.
- [ ] `dsh-mcp-client:51` — derived namespace budget instead of a flat 32.
      Optional since D12; no longer on the critical path.
- [ ] `dsh-subagent` — a named, described agent catalog.
- [ ] Hook events with no host today: `Notification`, `TaskCompleted`,
      `TeammateIdle`, `Interrupt`, `PostCompact`.
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

- S1 loader substrate — five findings written into ARCHITECTURE §10.1.
- S3 conformance rig, both halves: upstream oracle (`claude plugin details`)
  and the installed DSH oracle.
- S5 tool-name budget — the 32-character cap is one plugin's schema (D12).
- Interception kernel skeleton (`dsh-anyplugin-intercept`): ordering, matcher,
  decisions, budgets, trace, `observe`/`wrap` continuation modes.
- Skill argument engine: the documented rules ($N zero-based, $name,
  the trailer, escapes) implemented and tested against a recorded trace;
  waiting on the tool-schema seam (D17).
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
