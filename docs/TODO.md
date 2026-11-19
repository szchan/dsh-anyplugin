# TODO

The burn-down list. Every line names an outcome that can be checked, and every
item is finished the same way (AGENTS.md §7): code, test, doc, and the coverage
row moving in one commit.

The design lives in `docs/ARCHITECTURE.md`; the reasons live in
`docs/DECISIONS.md`. This file only orders the work. If a line here disagrees
with those two, they win and this file is wrong.

Pins for everything below: DSH `0.2.2-rc.2` (installed harness, D9),
claude-code `2.1.322`.

## Now

- [ ] **MCP materializer, stdio arm** (D12). Own the connection; register
      `mcp__plugin_<plugin>_<server>__<tool>` byte for byte. Done when
      `fixtures/claude-hooks-mcp`'s `probe` server reports as `mcp:probe:match`
      and the tool is callable end to end.
- [ ] **MCP name budget.** Reject `> 64` characters and names outside
      `[A-Za-z0-9_-]` as `unsupported` with a reason — never truncate, never
      hash (D11). Done when a fixture with an over-budget name reports
      `unsupported` and no `_[0-9a-f]{12}$` suffix can appear in an inventory.
- [ ] **Oracle learns MCP.** The DSH oracle currently reads `ctx.skills` only;
      it must project connected servers out of `ctx.tools` names. Done when
      coverage moves `8 / 5 / 3 → 8 / 6 / 2`.
- [ ] **Interception kernel skeleton** (AGENTS.md §3.6). Event points, matcher
      grammar, decision protocol, tier ordering — one module, no consumers yet.
      Done when a unit test drives a synthetic event through the chain twice and
      gets identical ordering both times.

## Next

- [ ] **Hooks, classic arm.** Command handlers on the kernel; events that have
      a host today. Done when `fixtures/claude-hooks-mcp`'s `PostToolUse` row
      matches.
- [ ] **Agents.** Needs a catalog seam (`dsh-subagent` has a provider registry,
      not a discoverable directory). Done when `fixtures/claude-agents` matches
      and the persona is selectable by description.
- [ ] **FidelityReport wiring.** `rig report` prints per-face verdicts from an
      emit run, not from a stale JSON blob.
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
- Skills: skills-dir, root `SKILL.md`, and the command model face materialize
  with 0 diff against the pinned goldens.
- D7 id escaping, D8 pin-gated surface mapping, D9 installed-oracle-only,
  D10 two faces for commands, D11 name budget arithmetic, D12 owned MCP path.
