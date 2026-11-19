# dsh-anyplugin — Architecture

> Status: baseline (decisions D1–D3 ratified by the owner, see §0.4).
> Scope: make DSH able to install and faithfully run plugins written for other
> agents — Claude Code first, then Codex, then Cursor and others.

## 0. The contract first

### 0.1 Fidelity is measured against a declared observable surface

| Surface | Content | Bar |
| --- | --- | --- |
| **A** Input | strings the user types (`/my-plugin:review`, agent mentions) | byte-identical |
| **B** Context | tokens the model sees: skill bodies, command expansion, hook-injected text, agent system prompts | byte-identical |
| **C** Effects | tool-call arguments, file writes, spawned processes, exit codes, stdio protocol traffic | byte-identical |
| **D** Control flow | allow / deny / block decisions (`exit 2`, `decision:"block"`, `continue:false`, permission results) | equivalent |
| **E** Trust | approval prompts, grant records, scope of effect | equivalent |
| **F1** Output style | `output-styles/*.md` | byte-identical |
| **F2** Terminal palette | `themes/<slug>.json` → terminal panel ANSI | every declared color |
| **F3** GUI chrome | cards, overlays, charts, shadows | **derived** — not in the denominator; Claude has no such artifact to translate |
| **F4** Assets | icons / complete SVGs | byte-identical |

### 0.2 Fidelity classes (attached to every IR node, never computed after the fact)

| Class | Meaning | Counts toward 100% |
| --- | --- | --- |
| `exact` | bytes preserved | yes |
| `equivalent` | same observable effect, different bytes (e.g. command alias) | yes |
| `derived` | we made a design decision the source does not specify | no (declared) |
| `unsupported` | cannot be expressed on a stock build, **and** no plan | must be empty for GA |
| `planned` | reserved slot, explicitly scheduled (see `ROADMAP`) | no, but must be named |

**Rule:** a node may never be `unsupported` without a `reason`; a node may never
be `planned` without a roadmap entry; a node may never silently change class.

### 0.3 The 100% statement

> For a pinned `claude-code-plugin@<version>`, over the declared fixture set,
> A/B/C/F1/F4 are byte-identical, D/E are equivalent, F2 is complete, and the
> `unsupported` set is empty. F3 is declared derived. Anything else is a diff,
> and a diff is a bug.

Corollary: **100% is a claim about a pinned version**, not a permanent state.
CI pins the source-agent version and re-runs conformance on every bump.

### 0.4 Ratified decisions

- **D1 — Emission is pure data.** No code generation, no `eval`, no generated
  TS packages. A foreign plugin compiles to a declarative `EntryTree` patch.
- **D2 — Two scope axes.** Installation is profile-global; *enablement* is
  user-scope **and** project-scope, both supported, chosen by the user (§5).
- **D3 — `mods` are in scope, eventually.** Not in the first releases, but the
  architecture reserves the slot and the roadmap commits to it (§7).
  It must never be architected out.

## 1. Why a layer, not a runtime

DSH already ships the three pieces a compatibility layer needs. We do not build
a plugin runtime; we build a compiler and glue.

| Needed | Already in DSH | Consequence |
| --- | --- | --- |
| Runtime plugin tree with atomic update/remove | `@cordisjs/plugin-loader` — `loader.create/update/remove/resolve`, `EntryTree`, nested `a:b` ids, `group` entries whose config is a child entry list | reconcile is a loader operation, not a filesystem hack |
| In-process ephemeral plugins + UI halves | `dsh-cordis-host-runner` (host half in a `node:vm` realm, `vmTimeoutMs`), `dsh-cordis-client-runner`, `dsh-client-ui-cordis` (inventory announcements `cordis/dynamic-package` / `cordis/dynamic-retract` / `cordis/request-run*`) | we inherit a sandbox boundary, a run-control UI, and per-definition identity |
| Persistence | `dsh-plugin-manager` (install/remove/select bundles, enable/disable entries, profile recomposition) | our bundle is the install unit; the runtime tree is disposable |
| Seams to target | skill registry, command registry, MCP client, hook interception, subagent providers, shell env, theme, workflow | each becomes a *materializer*, independently testable |

**The dynamic-package runner is a reference implementation, not our runtime.**
Verified from `dsh-cordis-host-runner`: definitions are session-scoped and
process-local (other sessions read them as absent), restart clears them, a
browser half suspends until a person approves on a connected page and has no
timeout, and the sandbox "isolates globals but is not a security boundary —
treat a dynamic package like bash access". None of that survives contact with a
profile-global install. So reconcile targets the **profile loader**
(`ctx.loader.create/update/remove`), and the dynamic-package runner is kept as
the *prototype* for the future mod host (§7).

The load-bearing observation: **DSH itself splits "persistent bundle" from
"runtime definition"** (`dsh-cordis-host-runner` states agents install
persistent bundles through Plugin Manager, dynamic definitions vanish on
restart). dsh-anyplugin sits exactly on that split, on the persistent side.

## 2. Layering

```
foreign plugin sources
  Claude Code · Codex · Cursor · portable (agent-plugins.org)
        │
        │ ① dialogs: detect → parse → normalize        (source → IR)
        ▼
   AgentPlugin IR            lossless + fidelity-annotated   ← single hub
        │
        │ ② plan: probe seams → mapping decisions → FidelityReport
        ▼
   Compiled Plan             IR + decisions + degradation reasons
        │
        │ ③ emit: IR → EntryTree patch (group + children, pure data)
        ▼
   DSH Loader                cordis loader / dynamic packages / materializers
        │
        │ ④ reconcile: desired (lock) vs actual (inventory), idempotent
        ▼
   Surfaces                  anyplugin UI: one row per foreign plugin
```

**N×M → N+M.** Adding a source agent means adding one dialect package and no
mapping code. This is the architectural reason the project can grow from
Claude Code to Codex to Cursor without rewrite; §9 makes it an acceptance test.

### Package layout (one bundle)

| Package | Role |
| --- | --- |
| `dsh-anyplugin` | host controller: reconcile loop, `anyplugin` command family, API for UI |
| `dsh-anyplugin-ir` | IR schema, normalizer, fidelity algebra, validators |
| `dsh-anyplugin-dialect-claude-code` | `.claude-plugin/` → IR |
| `dsh-anyplugin-dialect-codex` | portable `plugin.json` / `.codex-plugin/` → IR |
| `dsh-anyplugin-dialect-portable` | `agent-plugins.org` 1.0 → IR (shared by Codex and future sources) |
| `dsh-anyplugin-materialize-{skill,command,hook,mcp,agent,bin,theme,output-style,monitor,workflow}` | IR → one seam each |
| `dsh-anyplugin-emit` | IR → `EntryTree` patch |
| `dsh-anyplugin-ui` | client plugin: install list, fidelity report, trust grants |
| `dsh-anyplugin-conformance` | fixtures + record/replay diff (first-class, not an afterthought) |

## 3. AgentPlugin IR

```ts
interface AgentPlugin {
  id: string;                 // "<dialect>:<plugin>"            stable identity
  version: string;            // source version, or "local"
  dialect: DialectId;
  root: string;               // ${CLAUDE_PLUGIN_ROOT}-equivalent, versioned
  dataDir: string;            // ${CLAUDE_PLUGIN_DATA}-equivalent, survives updates
  vars: { projectDir?: string; userConfig?: Record<string, unknown> };
  manifest: unknown;          // raw bytes, never normalized away
  components: Component[];
  diagnostics: Diagnostic[];  // parse ambiguity, ignored frontmatter, etc.
}

type Component =
  | { kind: 'skill';   name; path; frontmatter; body; fidelity; reason? }
  | { kind: 'command'; name; alias; path?; inline?; input; body; fidelity; reason? }
  | { kind: 'hook';    event; matcher?; handler: HookHandler; trust; fidelity; reason? }
  | { kind: 'mcp';     serverName; transport; command?; url?; fidelity; reason? }
  | { kind: 'lsp';     serverName; command; args; extensionToLanguage; fidelity }
  | { kind: 'agent';   name; description; model?; effort?; tools?; fidelity; reason? }
  | { kind: 'bin';     name; path; fidelity }
  | { kind: 'theme';   slug; ansi?; tokens?; fidelity }
  | { kind: 'outputStyle'; name; path; fidelity }
  | { kind: 'monitor'; name; command; when; fidelity }
  | { kind: 'workflow'; name; path; fidelity }
  | { kind: 'mod';     name; hostHalf; clientHalf; fidelity: 'planned' };
```

Two rules that make the contract enforceable:

1. **Translation decisions are written back into the IR** (`alias`,
   `serverName`, palette derivation) and from there into the lockfile. If we
   cannot say what `/my-plugin:review` became, the contract is not auditable.
2. **`reason` is mandatory for any non-`exact` class**, and a non-empty
   `reason` is required or the emitter refuses to plan.

## 4. Emission: a group entry per foreign plugin

```yaml
# compiled entry tree (illustrative)
- id: anyplugin:claude-code:my-plugin
  name: '@deepseek-ai/dsh-anyplugin-emit'      # group carrier
  config:
    version: 1.2.3
    children:
      - name: '@deepseek-ai/dsh-anyplugin-materialize-skill'
        config: { roots: ['.../my-plugin/skills'], normalize: true }
      - name: '@deepseek-ai/dsh-anyplugin-materialize-command'
        config:
          commands:
            - { name: my-plugin-review, alias: 'my-plugin:review', path: '...' }
      - name: '@deepseek-ai/dsh-anyplugin-materialize-hook'
        config:
          bindings:
            - { event: PostToolUse, matcher: 'write|edit', handler: { type: command, command: '...', args: [] } }
      - name: '@deepseek-ai/dsh-anyplugin-materialize-mcp'
        config: { serverName: plugin_my-plugin_srv, transport: stdio, command: npx }
```

Why this shape:

- **Idempotent update.** Stable ids mean a version bump is `loader.update`, not
  `remove` + `create`; no window where the plugin is half-registered.
- **Isolation.** One subtree per foreign plugin: independent start/stop,
  independent disposal, independent crash domain, one UI row each.
- **Diffable.** The compiled tree is JSON-ish data; a reviewer can read what a
  third-party plugin will do before granting it.
- **No trust black hole.** Nothing is generated that gets executed later.

Risk to manage: emitted entries reference materializer packages by specifier, so
they must resolve from the profile's `node_modules`. The reconciler verifies
resolution up front and reports a diagnostic instead of failing mid-start.

## 5. Scope model (D2)

Two axes, deliberately separated.

**Axis 1 — installation (profile-global).** Cached once, deduplicated by
`<dialect>:<plugin>@<version>`, stored under the anyplugin data dir with the
source-agent cache layout reproduced (versioned `root`, stable `dataDir`) so
`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` keep their semantics.

**Axis 2 — enablement (user or project, user's choice).**

```
local   <workspace>/.dsh/anyplugin.local.yml     (gitignored)
project <workspace>/.dsh/anyplugin.yml           (committed)
user    $DSH_HOME/anyplugin/enabled.yml          (per machine/user)
```

Resolution for a plugin in a given workspace: first layer that mentions it wins
(`local` → `project` → `user`), each layer tri-state:

```yaml
plugins:
  claude-code:my-plugin: { enabled: true,  grants: [exec:hooks] }
  claude-code:other:     { enabled: false }
```

No mention = installed but inert. Disabling at project scope beats enabling at
user scope — the narrower scope has the final word, which is the only rule that
behaves sanely in a shared repo.

Consequences we surface in the UI: "installed, enabled in 2 of 5 projects",
and a per-workspace badge. The reconciler is workspace-aware: it materializes
the project's resolved set, so switching workspaces changes the runtime tree.

## 6. Trust model

Capabilities, not plugins, are granted.

| Class | Components | Default |
| --- | --- | --- |
| content (safe) | skill, command, output-style, theme, icons, workflow | auto |
| network | mcp, lsp | prompt: show exact command / URL |
| exec (full user privileges) | hook, monitor, bin, **mod** (later) | prompt: show exact command line; off by default |
| model identity | agent `model:`/`effort:` | prompt: show substitution or delegate cost |

A grant records `{ capability, target, artifactHash, grantedAt, scope }` and is
**pinned to the artifact hash**: edit the hook script and the grant is void, so
the next reconcile re-prompts. Revocation is one UI action and one lockfile
line. Because hooks run as `sh -c` with the user's privileges, "install" is
never sufficient authority for `exec`.

## 7. `mods`: a second subsystem, not a materializer (D3)

Spike **S2** is done, and it inverted our assumption. Mods are **not** a
one-paragraph feature: they are a large but *fully specified* framework with a
machine-readable spec.

| Measured fact | Value |
| --- | --- |
| Docs subtree | `plugins/mods/{overview,api,reference,interface,create,events,test,troubleshoot,admin,gallery}` |
| Generated declarations | `mods/types/claude-code.d.ts`, **873,553 bytes**, byte-identical to the declarations embedded in the engine |
| Events | **~60** + wildcard `*` + a `classic.*` bridge that re-exposes settings hooks |
| `$` API | **~21 namespaces**, ~60–80 methods (`fs`, `process`, `http`, `store`, `env`, `settings`, `session`, `mcp`, `model`, `ui`, `command`, `tool`, `clock`, `agent`, `telemetry`, `audio`, `theme`, …) |
| UI | **14+ render sites**, **~17 elements**, a validated component-tree DSL (`Box`, `Text`, `Button`, …), host-owned layout/focus, 10/s redraw throttle |
| Reference implementations | six Anthropic built-ins; `mods/diff` alone is a 35 KB `register.ts` + ~30 helper dirs |
| Real third-party mods | `anthropics/claude-code-playground` (3), `xobotyi/cc-foundry`, `davila7/claude-code-templates` (24), `baselane-mods` |
| Load contract | `.js/.ts/.tsx` loaded **directly, no build step**; one bare import (`claude-code`); `$` may not be aliased; event and method names must be **string literals** so a static scan can list capabilities |

### 7.1 Consequence: two subsystems sharing one spine

```
                      ┌──────────── dsh-anyplugin ────────────┐
  compile path        │  dialects → IR → emit → DSH seams      │  v0.1–v0.4
  (declarative)       └────────────────────────────────────────┘
                      ┌────────────────────────────────────────┐
  kernel path         │  mod API adapter → DSH mod ABI → host  │  v0.5+
  (in-process)        └────────────────────────────────────────┘
        shared: IR · trust grants · interception kernel · conformance rig · UI
```

The compile path never needs the kernel, and the kernel never needs the
emitter. But they share four things, and those four must be built once:
the IR node (`kind:'mod'`), the trust model (a mod is the highest capability
class), the **interception kernel**, and the conformance rig.

### 7.2 The interception kernel is shared with hooks — build it once

The hook materializer needs interception to answer *allow / deny / block /
inject* (surface D). A mod needs interception to **rewrite** the event, answer
outright, or draw (surfaces D + F). Same event points, same matcher grammar,
same decision protocol — different richness.

Therefore: **one `dsh-anyplugin-intercept` kernel** — event points, matcher,
decision protocol, ordering tiers, per-event timeout and abort — with two
consumers: the classic-hook front-end and the mod front-end. Building the hook
bridge as a one-off would guarantee rebuilding it for mods, and would leave mods
architected out by construction. This is the single most important structural
decision in this section, and it is why the kernel's skeleton must land early
(§12) even though full mod support is late.

### 7.3 The mod host must be generic, so it is its own package

`dsh-mod-host` provides a **DSH-native mod ABI** (chain engine with tiers, `$`
bridges, element runtime, redraw scheduler) and knows nothing about Claude.
dsh-anyplugin supplies the *adapter* that maps `claude-code`'s mod API onto that
ABI. Reasons:

- mods are an ecosystem in their own right and will outlive the compat layer;
- the fidelity contract stays honest: the ABI is DSH-native, the adapter is the
  compat surface, and "what is not covered" is exactly the adapter's gap;
- it lets us ship the ABI incrementally without pretending the Claude API is done.

What a faithful host needs, in dependency order:

1. **static scanner** — recognize literal `on('event')` / `$.ns.method()` and
   emit the capability list (this is also the trust UI's data source);
2. **chain engine** — `next(e)` re-entry, tiers (`prepend|user|append|builtin`),
   `next.to`, `next.budget`, `next.signal`, `.catch`, per-event timeouts;
3. **element runtime** — ~17 elements with validated prop schemas, render sites,
   host-owned layout, focus routing, `invalidate` throttling;
4. **~21 bridges** — fs / process / http / store / env / settings / session /
   mcp / model / clock / agent / telemetry / audio / theme …;
5. **type generation** — a per-install `claude-code.d.ts`, because real mods
   typecheck against it.

Items 3 and 4 are where DSH will fight back: the element runtime needs a
terminal-grade layout model, and the session/model/tool bridges need the
deepest interception points we have.

### 7.4 The denominator makes "no matter the cost" governable

Because `claude-code.d.ts` is generated and byte-identical to the engine's
declarations, mods are the one surface with a **finite, enumerable, pinnable
spec**. So mods' 100% is defined as:

> Every symbol in the pinned `claude-code.d.ts` is either **implemented** or
> **`planned` with a roadmap entry**, and every fixture mod runs with **0 diff**
> on its declared surfaces.

This yields a cheap objective metric — `covered / total` symbols, rising
monotonically — instead of an unbounded promise. That is what makes D3's
commitment survivable.

### 7.5 Security inverts, and the static scan is the gift

Claude says plainly: *"Mods aren't sandboxed"* and *"A mod is code that runs
with your permissions"*. A mod can approve tool calls, rewrite prompts, read
API keys, spend usage, and start processes outside the bash sandbox. Only
ordering tiers plus guard mods (`sec-default`, `hipaa-default`) hold it back.

So a mod host must ship an **equivalent guard layer** or it is strictly less
safe than the thing it emulates. The mitigation that comes for free: the static
scan produces the exact capability list *before* install. That list feeds §6's
grant UI directly — we show `hooks: tool.call, prompt.submit` and
`calls: fs.write, process.run, env.get` and pin the grant to the artifact hash.

### 7.6 Known portability limits (declare them, do not discover them)

| Limit | Classification |
| --- | --- |
| Terminal-only elements (`Raster`, `Image`, `AbovePrompt` band on terminal) | `derived` — DSH renders web; terminal panel only |
| `Client` second file (animation / pointer half) — bundling and props are undocumented | `planned`, needs hands-on probing |
| `.tsx` / JSX mods — JSX is sugar, but it needs a transform while `.ts/.js` load directly | open question: Node type-stripping covers `.ts`, not `.tsx` |
| Cross-mod pane ownership (`$.ui.open({id})` collisions) | must be reproduced, bug reports already exist upstream |
| Version drift (`$.ui.backdrop` removed in 2.1.319; `AbovePromptList` needs 2.1.323) | pin the release; regenerate the symbol table per pin |

The commitment, stated plainly: *no release may make mods harder.* Every design
choice that would need to be undone to support mods later is a defect now.

## 8. Seam capability matrix (P4)

Materializers probe before they plan. Missing seam ⇒ degrade with a diagnostic,
never assume. On a stock build several seams are absent (this machine lacks
`dsh-hooks-claude-code` and `dsh-lsp-stdio`), so the compatibility layer must
run degraded *by design*.

| Seam | Probe | If absent |
| --- | --- | --- |
| skill registry + filesystem provider | package present | commands-only fallback, `equivalent` |
| command registry (alias support) | accepts `alias` | drop alias, `equivalent` + UI note |
| hook interception (per event) | event registered | event `unsupported` **with reason**, visible in report |
| MCP client | package present | whole `mcp` node unsupported |
| subagent catalog | catalog API present | agent → prompt template, `derived` |
| shell env PATH | non-`DSH_*` key accepted | `bin` unsupported |
| notification channel | present | `monitor` unsupported |
| theme `ctx.theme` | present | `theme` unsupported (F2) |
| dynamic package runner | present | `planned`/`mod` unavailable as well |

### Why dynamic packages cannot be the reconcile substrate

Measured, not assumed:

| Property | Dynamic package (`dsh-cordis-host-runner`) | What reconcile needs |
| --- | --- | --- |
| Lifetime | session-scoped, process-local, cleared on restart | profile-global, durable across restarts |
| Visibility | other sessions read it as absent | every session sees the same plugin |
| Approval | a page must be connected; no timeout on a suspended run | unattended boot must converge |
| Headless | a browser-half package suspends | headless must work |
| Trust | sandbox isolates globals, explicitly *not* a security boundary | grants + artifact-hash pinning (§6) |

Hence: **the loader is the runtime; the runner is the prototype for the mod
host.** Conflating them would have produced a layer that cannot boot headless.

This is why the architecture scales to 100% **without changing shape**: every
gap is an optional seam, each shipped as an independent PR that is valuable to
DSH on its own.

## 9. Reconcile

```
read desired (installs.yml + scope layers)
  → resolve per workspace
  → parse sources (cached by content hash)
  → plan (probe seams, annotate fidelity)
  → diff against loader inventory
  → loader.create / loader.update / loader.remove (stable ids)
  → publish inventory + FidelityReport
```

Ids: group `anyplugin:<dialect>:<plugin>`, child
`anyplugin:<dialect>:<plugin>:<kind>`. Version lives in config, not the id, so
updates restart in place. Reconcile is safe to run on every boot, after every
install, and on file watch events; it converges and does nothing when state
already matches.

## 10. Verification plan

- **S1 — emission substrate.** ✅ **Answered 2026-11-18** by `spikes/s1-loader`
  (21/21 checks, cordis 4.1.0 / cordis-plugin-loader 1.1.0 /
  cordis-plugin-group 1.1.0). See §10.1 for the findings and what they force.

### 10.1 S1 result: the substrate works, but it hands us four obligations

A foreign plugin can be one group entry — `name: '@deepseek-ai/cordis-plugin-group'`,
`group: true`, `config: EntryOptions[]` — and its children are ordinary entries
that apply, address and dispose like any other. What the loader does **not**
give us, and what the emitter therefore owes:

| Property | What actually happens |
| --- | --- |
| **Atomicity** | Not provided. `EntryGroup.update()` `.catch()`es each child's `create()`, so one failing child leaves the healthy siblings applied; the failure surfaces only as a non-active fiber plus a log line. The emitter must check every child's fiber state and roll the group back itself. |
| **Rollback** | Removing the group after a failure does leave no orphans — proven, but it is our call, not the loader's. |
| **Identity** | `ensureId` reuses an existing id, so materializing the same tree twice takes the `update` path instead of duplicating. Ids are the identity, exactly as the reconcile design assumes. |
| **Id grammar** | `EntryTree.sep = ':'` and `resolve()` splits on it, so an id containing `:` is stored but **unaddressable**. Foreign ids must be mangled (D7). |
| **Teardown** | `remove()` returns void and drops the entry from `entries()` immediately, so `loader.await()` can return before disposers ran. Deterministic teardown = `Promise.resolve(fiber.dispose())` plus waiting for `fiber.state === 5`; `dispose()` is void for some fiber kinds, so never rely on its return value. |
| **Plugin cleanup** | cordis has no `'dispose'` event. Cleanup is `ctx.effect(execute)` where `execute` returns the disposer — a materializer that registers teardown any other way silently never cleans up. |

Consequences, all of which are now constraints on the emitter: rollback is
explicit; ids are mangled before they reach the loader; every materializer
registers cleanup through `ctx.effect`; reconcile captures fiber references
before removing anything.

- **S2 — mod surface.** ✅ **Answered 2026-11-18** (§7): the mod API is a large
  but fully specified surface with a machine-readable declaration file, so it
  is a second subsystem (D3), not a materializer.
- **S3 — conformance rig.** Record golden traces from the real agent runtime,
  replay in DSH under a temporary `$HOME`, normalize, diff per surface A–F.
  This lands *before* the translator, because it is the only honest scoreboard.
- **S4 — dialect extensibility.** Add the `cursor` stub dialect; if it needs a
  materializer change, the IR has leaked and must be fixed.

Fixtures: skills-only; hook-heavy (blocking + injection); MCP + commands;
agents + bin + theme.

## 11. Non-goals

- Running Claude Code's JavaScript runtime to interpret plugins. (Mods are the
  one narrow, deliberate exception, and even there we adapt an API, not host a
  runtime.)
- Reverse export: emitting Claude/Codex plugins from DSH packages.
- Guaranteeing fidelity for a plugin that sniffs its host and branches on it.
  Contract covers the declared surfaces; adversarial host detection is out of
  scope and is documented as such.
- Treating "delegate to a real Claude Code subagent" as the default path for
  agents. It exists as an escape hatch for model identity only.

## 12. Roadmap

| Release | Content |
| --- | --- |
| v0.1 | S1 + S3 rig; **`dsh-anyplugin-intercept` skeleton**; skills + commands materializers; Claude Code dialect read-only; fidelity report |
| v0.2 | MCP; classic hooks on the shared kernel (command handler, event subset); exec trust grants; project/user scope |
| v0.3 | Codex dialect via portable IR; LSP; output-styles; bin |
| v0.4 | agents (catalog or prompt template); themes (F2 ANSI seam); monitors; workflows |
| v0.5 | `dsh-mod-host` alpha: static scanner + chain engine + fs/store/http/session bridges + `AbovePrompt` render site |
| v0.6 | mod host beta: element runtime (~17 elements), panes, redraw scheduler, guard layer (sec-default equivalent) |
| v0.7 | Claude mod API adapter; symbol coverage tracked from the pinned `.d.ts`; `.tsx` and `Client` resolved |
| v1.0 | full A–F contract green on the fixture set, mod coverage complete per declaration, pinned source versions, CI conformance |

The kernel skeleton moves into v0.1 on purpose: hooks (v0.2) and mods (v0.5+)
consume the same interception points, and a hook bridge written without the
kernel would have to be rewritten — and would make mods structurally impossible.

## 13. Open questions

- ~~Where does the emitted tree live during reconcile?~~ **Resolved:** created at
  runtime through the profile loader only; the profile config file stays
  untouched, and durability comes from `installs.yml` + the scope layers being
  replayed on boot. (Verified necessary: the dynamic-package registry is
  session-scoped, so anything written only there cannot be a source of truth.)
- Do materializer packages ship inside the anyplugin bundle, or as profile-level
  dependencies? Resolution from the profile's `node_modules` argues for the
  latter; bundle ergonomics argue for the former.
- Should a project scope be able to *pin* a version, or only enable the
  profile's installed version? (Pinning makes shared repos reproducible.)
- Do we vendor the pinned `claude-code.d.ts` into this repo to drive the mod
  symbol-coverage metric? (Proposed: yes, one file per pinned release, tagged.)
- `.tsx` mods: Node type-stripping covers `.ts` but not JSX. Do we add a JSX
  transform to the mod host, or require authors to ship `.js/.mjs`? Claude
  loads `.tsx` directly, so "no transform" would be a declared fidelity gap.
- How does Claude bundle and serve a mod's `Client` second file? Undocumented;
  needs hands-on probing before it can be classified as anything but `planned`.
- Which execution realm do we give a mod (`node:vm` like the dynamic-package
  runner, a worker, or the host thread)? It is a fidelity question *and* the
  security question, since mods can approve tool calls and read credentials.
