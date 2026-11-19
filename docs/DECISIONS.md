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
