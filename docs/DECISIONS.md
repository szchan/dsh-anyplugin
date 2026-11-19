# Decision log

Ratified decisions. Treat each entry as a constraint on new work until it is
explicitly superseded by a later entry. Format: id, status, decision,
rationale, date.

---

## D1 — Emit pure data, ship as a bundle

**Status:** ratified 2026-11-18.

Foreign plugins are compiled into an `EntryTree` patch and handed to DSH's own
loader. The project ships as a bundle (host controller + packages), not as one
large plugin.

**Why:** data can be diffed, audited and replayed, and stable ids make a
version bump a `loader.update` instead of a remove-and-recreate. Code
generation would make every install a small compiler project and every review a
security review.

---

## D2 — Two scope axes: install is global, enable is layered

**Status:** ratified 2026-11-18.

Installation is profile-global, with the versioned cache-directory semantics of
the source ecosystem reproduced (root and data dir separated). Enabling is
three layers, narrowest wins: `local` > `project` > `user`. A project-level
disable beats a user-level enable.

**Why:** plugins arrive per project, but a bundle is an installation unit.
Refusing project scope would make the layer unusable in shared repos; treating
install as project-local would duplicate downloads and break global commands.

---

## D3 — `mods` are a required subsystem, measured by symbol coverage

**Status:** ratified 2026-11-18.

`mods` will be supported, no matter the cost, and their 100 % is defined as:
every symbol in the pinned `claude-code.d.ts` is **implemented** or
**planned-with-roadmap**, and every fixture mod diffs to zero on its declared
surfaces. Coverage is reported as `covered / total` and must rise
monotonically.

**Why:** the specification is generated and byte-identical to the engine's
declarations, so it is the one surface with a finite, enumerable denominator.
Without it, "support mods" is an unbounded promise. See
`ARCHITECTURE.md` §7.4.

---

## D4 — One interception kernel, shared by hooks and mods

**Status:** ratified 2026-11-18.

`dsh-anyplugin-intercept` owns event points, matcher grammar, decision
protocol, tier ordering, per-event budgets and abort. The classic-hook
materializer and the mod front-end are two consumers of it. The kernel skeleton
lands in v0.1, before either consumer is complete.

**Why:** hooks need interception to answer allow/deny/block/inject; mods need
the same points to rewrite events, answer outright and draw. Building the hook
bridge first as a one-off would force a rewrite and would leave mods
structurally impossible. See `ARCHITECTURE.md` §7.2.

---

## D5 — The mod host is generic and lives in its own package

**Status:** ratified 2026-11-18.

`dsh-mod-host` provides a DSH-native mod ABI (chain engine with tiers, `$`
bridges, element runtime, redraw scheduler) and knows nothing about Claude.
`dsh-anyplugin` supplies the `claude-code` → ABI adapter.

**Why:** mods are an ecosystem that will outlive this compatibility layer.
Keeping the ABI native keeps the fidelity contract honest — the adapter's gap
is exactly "what is not covered". See `ARCHITECTURE.md` §7.3.

---

## D6 — We accept hosting unsandboxed in-process code

**Status:** ratified 2026-11-18 by the project owner.

Upstream states plainly that mods are not sandboxed and run with the user's
permissions (approve tool calls, read credentials, spend usage). We accept
carrying that capability class, on the condition that we ship an **equivalent
guard layer** (`sec-default` / `hipaa-default` semantics) and make it at least
as safe as the system we emulate — never looser. The static capability scan
feeds the grant UI, and grants are pinned to the artifact hash.

**Why:** fidelity to the ecosystem is the whole point, and a numerically lower
capability ceiling would silently change what plugins can do. The risk is taken
knowingly, with a guard layer as the mitigation.

---

## D7 — Loader ids are mangled; display names are kept separately

**Status:** ratified 2026-11-18, forced by S1.

`EntryTree.sep` is `:` and `resolve()` splits ids on it, so an id containing
`:` is stored but unaddressable. Every id that reaches the loader is therefore
escaped: characters outside `[A-Za-z0-9_.@-]` (including `:` and `~` itself)
become `~` + the UTF-8 hex of the byte, which is reversible in one pass. The
original string — the thing a user or a fidelity report must see — lives in the
plugin's display metadata, never in the loader id.

**Why:** foreign ids come from ecosystems that use `:` as a namespace
separator (`plugin:skill`, `my-plugin@marketplace`). Mangling is the only
option that keeps reconcile addressable *and* keeps the display name exact.
Ids are internal identity, so mangling them costs no observable fidelity;
mangling a display name would.

---

## D8 — Surface mapping is pin-gated, and the host's own report beats the docs

**Status:** ratified 2026-11-18, forced by the S3 rig's first captures.

The dialect does not derive its component mapping from prose documentation. It
resolves a **pin profile** (today `claude-code@2.1.322`) and, inside a profile,
maps according to what the host itself reported — captured as fixtures plus
committed goldens and re-probed by `npm test`.

What that means at the current pin (see ARCHITECTURE §10.3):

- `commands/*.md` maps to the **skill** surface; the host reports it as a skill.
- `commands/<dir>/*.md` and `agents/<dir>/*.md` are **not loaded** by the host,
  so the dialect records them as dropped with a reason, never as components.
- Parenthetical cost annotations on hooks and MCP servers become component
  details, never part of a component name.

**Why:** the docs describe nested command and agent namespacing that the
installed loader does not implement, and the command/skill boundary the docs
draw is not one the host's inventory makes. A doc-faithful dialect would claim
components the host does not have — 100 % wrong precisely where fidelity is
measured. When the pin moves, `npm run capture:fixtures` re-captures and the
golden diff is reviewed like code; a changed golden without a new pin profile
is a bug, not an upgrade.

---

## D9 — The DSH oracle runs the installed harness, never npm

**Status:** ratified 2026-11-18, forced by the first transplant.

The rig's actual side boots the harness from
`$(dirname "$DSH_INSTALL_DIR")` — a plain directory of 338 `@deepseek-ai`
packages — and imports `cordis`, `cordis-plugin-loader` and `dsh-skill` from
there via `pathToFileURL`. One `Context`, created by that cordis, owns both the
loader and the registries.

**Why:** the products differ. npm publishes `dsh-skill@0.0.1-rc.1` while the
desktop installation runs `0.2.2-rc.2`, and some packages the harness uses
(`dsh-command`) are not published at all. A comparison against npm would
measure a different product and could pass while the real harness fails. The
claim is about what the user runs.

**Consequences:**

- The DSH-side tests require a local installation and **skip** without
  `DSH_INSTALL_DIR`; they are not meaningful in a bare checkout.
- Tests assert the exact installed version (`0.2.2-rc.2` today), because the
  pin is part of the claim (AGENTS §3.8). A harness upgrade is a deliberate
  re-baseline, not a green run that silently moved.
- If the Desktop bundle ever ships as a real `asar` archive again, the oracle
  must switch to the `ELECTRON_RUN_AS_NODE=1` access path; that is the only
  place the access mode is allowed to matter.
