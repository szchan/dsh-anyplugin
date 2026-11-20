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
| `dsh-anyplugin-mod-scan` | static mod scanner: literal `on` / `$` sites, capability list, `dynamic` for what it can see but cannot prove |
| `dsh-anyplugin-dialect-claude-code` | `.claude-plugin/` → IR |
| `dsh-anyplugin-dialect-codex` | portable `plugin.json` / `.codex-plugin/` → IR |
| `dsh-anyplugin-dialect-portable` | `agent-plugins.org` 1.0 → IR (shared by Codex and future sources) |
| `dsh-anyplugin-materialize-{skill,command,hook,mcp,agent,bin,theme,output-style,monitor,workflow}` | IR → one seam each |
| `dsh-anyplugin-trust` | exec classify/authorize/gate + the canonical `grants.yml` store (D25) |
| `dsh-anyplugin-emit` | IR → `EntryTree` patch |
| `dsh-anyplugin-install` | lock + scope replay → loader entries; idempotent reconcile |
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

Commands and skills collapse at the current pin: at Claude Code 2.1.322 a
`commands/*.md` file is reported under **Skills**, and a nested
`commands/<dir>/*.md` is not loaded at all (§10.3). The dialect therefore
resolves this mapping through a **pin profile** (D8) rather than the prose
docs, and the command materializer is used only when the profile says the host
still separates the two surfaces.

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

The lock is `installs.yml` under the profile's anyplugin dir, one record per
installed plugin (D23):

```yaml
schema: "dsh-anyplugin/installs@1"
plugins:
  - dialect: "claude-code"
    name: "skills-only"
    version: "0.0.1"
    root: "/…/artifacts/claude-code/skills-only/0.0.1"
    dataDir: "/…/data/claude-code/skills-only"
    pin: "claude-code@2.1.322"
```

`root` is versioned, `dataDir` is not. `pin` is the host version the artifact
was read against (AGENTS.md §3.8), so a build that reads a different version
rejects the record instead of silently reinterpreting it. The canonical writer
sorts, quotes and writes atomically; the reader accepts only this subset and
rejects anything else with a line number rather than repairing it — "cannot
parse" must never become "uninstalled".

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
  claude-code:my-plugin: { enabled: true }
  claude-code:other:     { enabled: false }
```

Grants are written to `grants.yml`, not to this line (D25); an older
`grants: […]` field is parsed and ignored. No mention = installed but inert.
Disabling at project scope beats enabling at
user scope — the narrower scope has the final word, which is the only rule that
behaves sanely in a shared repo.

`compileEntries(installs, { projectDir, enablements, grants })` replays those
files into one group entry per enabled plugin **that has an emittable surface**, with
children from `emitPlugin`. A plugin that is installed but not enabled — or
enabled but with nothing to emit — contributes no entry. The group's own fiber
ignores `disabled`; child entries inherit it (S1). Disabling is therefore
expressed by absence, and "inert" is the absence of a fiber, not a disabled
one. A UI that wants to show "installed, disabled" joins `installs.yml` with
the scope layers; there is no loader entry to read a flag from.

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

Content classes are emitted without a grant. Exec-class artifacts are **default
off**: `emitPlugin` only places a hook whose target is in its `trusted` list,
and that list is empty unless the caller passed an authorized decision. A
refused hook is not dropped silently — `gate` moves it to the IR's `pending`
list as `planned` with a reason, and the report marks the component
`refused:<capability>` from that decision, not by inferring it after emission.
`emitPlugin` also reports `refused` for any carried surface whose target was
not trusted, so a caller that skips the gate is still default-off. The refusal
carries the exact command line (`command`, `args`), so the prompt can show what
would run without re-reading the plugin. If the plugin has no other emittable
surface, there is no group entry at all: the refused hook does not reach the
loader as a disabled or inert child, because it does not reach the loader.

### 6.1 The store

`grants.yml` lives next to `installs.yml` in the profile's anyplugin dir and
uses the same canonical YAML subset as D23 (D25):

```yaml
schema: "dsh-anyplugin/grants@1"
grants:
  - plugin: "claude-code:my-plugin"
    capability: "exec"
    target: "hook:PostToolUse#0"
    artifactHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    grantedAt: "2026-11-19T00:00:00.000Z"
    scope: "user"
revokes: []
```

The canonical writer sorts records, quotes every value, writes fixed field
order, and replaces the file through a same-directory temp file plus rename.
It also holds an `O_EXCL` `grants.yml.lock` (bounded retry) across the write;
`updateGrants` keeps that lock across read-modify-write, so two concurrent
granting actions cannot silently lose one record to last-rename-wins. The
reader accepts only that subset: unknown fields, missing fields, unquoted
values, duplicate records, an unknown schema, a malformed hash, or a
capability outside `exec` are rejected with a `file:line` reason and the file
is left untouched. A missing file is an
empty store — which is also the safe state, because exec is default-off. A
malformed file is an error, never an empty store: "cannot parse" must not
become "everything is revoked" or "everything is granted".

Scope is a property of the record, not of the file's location. `grants.yml` is
one profile file; each grant and revoke names `local`, `project`, or `user`.
Resolution takes the **narrowest scope that mentions** a given
`(plugin, capability, target)` — `local` beats `project` beats `user` — and
within that scope a revoke beats a grant. A narrower refusal does not fall
back to a broader grant, otherwise a stale user grant would revive an artifact
after a local revoke. D23's statement that grants live in the enablement scope
layers is superseded by this store; an enablement line that still carries
`grants: […]` parses, but the field is ignored, because a capability name is
not a hash pin.

### 6.2 What is pinned

A row is one exec artifact, named within its plugin. `index` is flat per event
across matcher groups, so two groups under `PostToolUse` are `#0` and `#1`,
not two `#0`s:

| Target | Artifact |
| --- | --- |
| `hook:<event>#<index>` | one command handler in `hooks/hooks.json` |
| `bin:<path>`, `monitor:<path>`, `mod:<path>` | one file under `bin/`, `monitors/`, `mods/` |

A grant is keyed by `(plugin, capability, target)` and matches only when the
current `artifactHash` also equals the granted one. `plugin` is
`<dialect>:<plugin>`, so identical bytes in two plugins are two artifacts. A
hash mismatch refuses and reports both the pinned and the current hash in the
refusal; it never re-grants, because that is the caller's prompt to show.

`artifactHash` is `sha256:<64 lowercase hex>` over a **manifest resolved once**,
at classify/grant time:

```
artifact = { mode: "file" | "text" | "composite",
             invocation,                        // exact text or argv; hashed
             command,                           // eval payload, else ""; hashed
             files: [{ path, sha256, bytes }] } // the program only; hashed
hash     = sha256(mode, invocation, command, then each file's path + sha256, in order)
```

The boundary is **code versus data**. A hook's program is code and its bytes
are pinned; everything else is data and only its text is hashed.

- The program is `command[0]` when it resolves to a file inside the root. For
  a known interpreter (`node`, `sh`, `bash`, `zsh`, `python*`, `deno`,
  `bun`, `ruby`, `perl`, `pwsh`), it is the first non-flag operand that
  resolves to a file inside the root. For `node fmt.js data.txt` that is
  `fmt.js`, not `data.txt`.
- A pure program (`command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"`, or
  `bin/…`) is `mode: "file"`: one file path and its bytes.
- A command with no program inside the root (`echo …`, `sh -c '…'`,
  `node -e '…'`, `cat data.txt`) is `mode: "text"`: the exact invocation is
  the artifact. Interpreter eval payloads are code and are never mistaken for
  a flag; editing `node -e '…'` invalidates the grant.
- A program plus other words (`node …/fmt.js data.txt`, `…/hook.sh --out
  …/out.txt`) is `mode: "composite"`: the exact invocation plus the
  program's bytes.
- Data operands — positional inputs, `--out` values, redirect targets — are
  not read and not pinned. Editing `data.txt` does not invalidate a formatter
  hook; editing `fmt.js` does. A data operand outside the root, or a relative
  one, is allowed: the hook's cwd decides what it means. Only a **program**
  outside the root or named relatively is refused, because hashing it against
  the plugin root while executing it in the project would pin one file and run
  another. The refusal names the fix (`use ${CLAUDE_PLUGIN_ROOT}/…`). A
  missing program is refused too.
- `invocation` is hashed word for word: order, duplicates, flags, and data
  names are part of what was approved. A changed flag or a renamed data operand
  is a new artifact; changed data bytes are not. This keeps `cp a b` distinct
  from `cp b a` without turning output files into artifacts.

The path is not identity by itself: it is one field of the manifest hash, so a
byte-identical copy does **not** keep a grant when the command names a
different path. mtime is never used. A symlink inside the root that points
outside pins the outside file's bytes (conservative: the bytes that run are
what matters), not the link target string.

`classify` reports a row for every hook with a command and every file in the
three exec directories. `authorize` gates the rows it can emit today — command
hooks that are `exact`/`equivalent`. A `planned` hook was not going to run, so
it is not reported as refused, and `bin`/`monitor`/`mod` rows have no
materializer yet, so nothing runs; they are classified for the UI and for the
mod host, not silently executed.

### 6.3 The check at spawn

A hash checked only at reconcile time is a TOCTOU hole: the loader keeps the
child config, and the script can change before the next tool call. The gate
attaches the resolved manifest and `artifactHash` to the IR hook; emit copies
them verbatim into the child — it never resolves the command a second time. A
trusted hook with no attached artifact fails closed (no child, recorded
refusal). The emitted child carries the full `artifact` manifest plus
`artifactHash`, `artifactMode` (`file`, `text`, or `composite`), `artifactRoot`,
and the flat `index`. The materializer never re-parses the command at spawn:
it re-reads exactly `artifact.files[].path`, re-hashes the same
`mode`/`invocation`/`command`/files order, and checks that the config still
names the same invocation and mode. On
a mismatch, `PreToolUse` returns `deny` without spawning, and `PostToolUse`
warns and adds the reason (both hashes and the command line) to
`additionalContexts` without spawning. One file read per matched hook call is
acceptable; the call is about to spawn a process anyway. A re-grant followed by
reconcile re-emits the child config with the new manifest, and the next call
runs the new bytes. The guarantee is therefore at the manifest boundary: the
inside-root file bytes, inline text, and interpreter payloads that were pinned
are exactly what the next spawn checks, at the moment it would run.

### 6.4 What a grant does not cover

An exec grant is not install authority, not enablement, and not a network
decision. It does not cover an MCP server or any content-class artifact. It
does not pin the `matcher`, `timeout`, or environment. It pins the exact
invocation text (including flags, order, and data names) and the program's
bytes; it does not pin the bytes a positional input, output path, or redirect
target points at. It does not pin the interpreter binary found on `PATH` or
files a script reads at run time. A relative or outside-root **program** is
refused, never silently treated as pinned; a relative or outside-root **data**
operand is allowed and is only invocation text. It does not re-grant a changed
program, and it does not transfer to another plugin. There is a small
unavoidable window between the spawn-time re-read and `exec`; the guarantee is
that the bytes checked are the bytes named by the manifest, not that no process
can ever race the check. Those limits are deliberate; a grant is one artifact's
manifest at one scope, and anything broader would be a capability the user did
not approve.

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

**Landed and consumed (v0.1–v0.2):** `packages/dsh-anyplugin-intercept` —
`runChain`, `resolveOrder`, `compileMatcher`, the `Decision` union, per-handler
budgets and a deterministic trace. The first consumer is
`dsh-anyplugin-materialize-hook`: every mount translates its hook entries into
`classicHookRegistration`s (`user` tier, `observe` mode) and calls `runChain`
with fan-out continuation, so tier order, matcher skips, fan-out and the trace
belong to the kernel. The materializer keeps only the host wiring, the artifact
re-hash, the spawn and the D20 verdict translation; an optional `onTrace` sink
exposes the kernel trace to a caller (a diagnostic hook; nothing in the rig
depends on it yet). The mod front-end's adapter has landed (#36); the loader
wiring that would call it remains v0.5+.

**Landed (#36):** `modRegistrationsToKernel` converts `loadMod`'s frozen
registrations into kernel registrations (`wrap` mode, source
`${plugin}/${entry}#index`, `continuation` left unset so a channel's classic
arm keeps fan-out) and reports every event it cannot seat instead of dropping
it. It has no production caller yet: the loader front-end that would call it is
the follow-up ticket, and `session.start` is that loader point, not a live host
event. The mapping is data in `mod-events.ts`, one row per mod event with the
host seam and the pinned `claude-code.d.ts` line as evidence — claude-code
2.1.322, commit `6e1e44f6433bfa17d198e932bff53373aa229eea` (the d.ts file's own
header still says 2.1.277; the commit is the pin). It is **16 live `classic.*`
routes plus one loader point**, not 17 live routes.

`on()`'s `Pattern` is first-class (d.ts:6101): `classic.*` expands to the 16
classic routes, `*` to all 17, and a negation (`!tool.*`) to the complement.
Selected names without a route keep their own reason (a classic event S9 leaves
unprobed or refutes, or an engine event with no shared protocol); a pattern
that cannot be expanded gets a pattern-shaped reason of its own.

The 16 `classic.*` names map one-to-one onto their classic kernel points and S9
seams; `classic.PreToolUse` is special-cased because the mod API hands it
`ToolCallEnvelope` (d.ts:10081-10093), not the classic stdin payload, so the
adapter rebuilds the envelope and carries a rewrite back.
`classic.PermissionRequest` and `classic.PermissionDenied` record their partial
payloads at the S9 seam (no `tool_input`; no tool name or input).
`session.start` is the loader's per-plugin event and maps to the kernel's
`session.start`, not to `agent/created` (that is classic `SessionStart`). The
adapter does not derive a tier from the event name: the host seats a plugin,
and `user` is only the fallback when a caller has no seating, never `core`
(d.ts:6253-6265). Unmapped engine-native events (39) and classic events S9
leaves unprobed or refutes (17) stay on the adapter's `unmapped` list with that
reason; the ticket's guessed names (`post.tool.use`, `turn.stop`, …) are
reported as absent from the pin and point at their real spelling rather than
being aliased.

A mixed chain still runs one `runChain`: the classic registration declares
fan-out, so a `[mod, classic, mod]` chain with no explicit continuation runs
all three. In **fan-out** a mod's `next(e)` only rewrites the event for later
registrations; it does not run the classic arm itself, and it resolves the
kernel's continue, not `ClassicResultOf`. A **mod-only** chain is
`first-decision`: `next(e)` runs the chain beneath and resolves that event's
`ClassicResultOf` (`{cwd}` for `session.start`). D13's "a mod that declines
`next()` owns the rest of the chain" is therefore a `first-decision` statement;
in fan-out the channel owns continuation. Classic return fields are translated,
not collapsed: `additionalContext` becomes the kernel's `text` channel,
`updatedInput` becomes an event rewrite, and fields with no carrier (`ask`,
`preventContinuation`, `stopReason`, `updatedToolOutput`, …) are a typed
`unsupported` with a reason.

The skeleton had to add two orthogonal choices beyond the plan. The first is a
**mode**: the two front-ends need opposite continuation rules, and encoding only
one would have forced the other to bypass the kernel (exactly what §7.2
forbids):

| Mode | Used by | Semantics |
| --- | --- | --- |
| `observe` (default) | classic hooks | the handler has no `next`; returning nothing means it ran, and the chain continues |
| `wrap` | mods | the handler owns continuation: not calling `next()` and returning nothing **ends** the chain |

Decision flow is a second, orthogonal choice. `first-decision` is the default
and the mod contract: the first non-continue decision ends the chain. `fan-out`
is the classic-hook contract, measured against the pinned 2.1.322: **every
matching handler runs** (the client dispatches them concurrently; the kernel
walks them in registration order for a reproducible trace), a decision is
recorded and collected rather than used to skip a sibling, and the materializer
aggregates afterwards. In
practice: `PreToolUse` denies if any hook denies (the first denial by order is
the reason); `PostToolUse` appends every `additionalContext` and turns a denial
into feedback text instead of a block; a lifecycle decision is reported and not
applied. A timeout or throw still skips only the handler that produced it.
`fixtures/claude-hooks-fanout` drives two matching `PostToolUse` hooks on a real
turn and asserts both markers and both contexts.

Both flows share: a matcher miss is skipped, a throwing handler is skipped and
recorded, an over-budget handler is aborted and recorded, one trace step per
handler run. `TIER_ORDER` (`prepend → user → append → builtin`) is a single
table with `builtin` innermost. D13 recorded its values as a prose-derived
assumption; the pinned `claude-code.d.ts` (d.ts:10022-10039) now confirms them
as the first four of five tiers — the fifth, `core`, is the engine's own seat
and never a plugin's (`PluginRegisterInput.tier` excludes it, d.ts:6253-6265).

A classic hook has no `next`, so `classicHookRegistration` always produces
`observe` mode and declares `continuation: 'fan-out'`; a caller that passes no
option still gets fan-out, and an explicit option wins. The materializer never
sorts handlers, evaluates a matcher or decides continuation itself. Its per-hook budget is the command's own timeout
plus a 5 s grace window, and the chain deadline is exactly the sum of those
budgets, so a slow handler is cut off at its own budget instead of truncating a
healthy one or stretching the turn past the declared timeouts.

**Calibrated against payloads, not prose (D15).** `fixtures/hooks/` holds 32
payloads extracted from the pinned docs plus 3 captures from a live 2.1.322.
Two corrections came out of running them through the kernel:

- The event vocabulary is **32 events, not the 10 we had guessed**. The table is
  now derived from the fixture set, and a fixture/test mismatch fails the build.
- `observe` mode used to record a handler that returned nothing as
  `not-called`. That is the *wrap* semantic. An observing hook has no `next`;
  not calling it is not declining, so the trace now says `ran`. `not-called`
  is reserved for a wrapper that ended the chain.

Matchers read the subject from the event's own field through the single
`CLASSIC_SUBJECT_FIELD` table: `classicEvent` builds the kernel event from a
classic payload and records `null` when the field is absent, so a
matcher-bearing handler is skipped and reported instead of matching the empty
string. `compileClassicMatcher` is the kernel's classic grammar: the authored
text is kept as is (whitespace is significant) and a malformed pattern matches
nothing (D20) rather than throwing mid-turn. Events whose matcher semantics are
still unknown have no field in the table — a recorded gap, because a plugin's
matcher then cannot narrow anything instead of narrowing wrongly.

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

1. **static scanner** — *landed* in `dsh-anyplugin-mod-scan`: recognize literal
   `on('event')` / `$.ns.method()` and emit the capability list, with every
   visible capability-shaped site it cannot prove in `dynamic` (D21). It names
   its invisible categories in `SCAN_CAVEAT`; it is not a completeness claim.
   This is also the trust UI's data source, and it does not run a mod;
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
scan produces the literal capability list *before* install. That list feeds
§6's grant UI directly — we show `hooks: tool.call, prompt.submit` and
`calls: fs.write, process.run, env.get` and pin the grant to the artifact hash.
The scanner has landed in `dsh-anyplugin-mod-scan`; it is literal-only, reports
the capability-shaped sites it can see but cannot prove, and names the
categories it cannot see at all (`SCAN_CAVEAT`, D21). The grant prompt must show
that report and that caveat, not the list alone.

### 7.6 Known portability limits (declare them, do not discover them)

| Limit | Classification |
| --- | --- |
| Terminal-only elements (`Raster`, `Image`, `AbovePrompt` band on terminal) | `derived` — DSH renders web; terminal panel only |
| `Client` second file (animation / pointer half) — bundling and props are undocumented | `planned`, needs hands-on probing |
| `.tsx` / JSX mods — type-stripping parses `.ts`, never JSX | **`planned`**: S13: 20 of 21 `.tsx` modules fail `stripTypeScriptTypes` in both modes (19 `Expected '>', got 'ident'`, one `Expected ',', got '.'`); the one JSX-free module strips, but stock Node still refuses the `.tsx` extension; a JSX transform is a decision, not a licence (see §7.7) |
| Authored specifier conventions (`'./ask'`, `'./x.js'` for `x.ts`, `'.'` self-import) | **host landed** (`dsh-anyplugin-mod-host`, #33) — three behaviors only, no candidate fallbacks; our host obligation, not an upstream specification; stock Node ESM refuses the four shapes; resolution changes no bytes (S13, D30, §7.7) |
| Cross-mod pane ownership (`$.ui.open({id})` collisions) | must be reproduced, bug reports already exist upstream |
| Version drift (`$.ui.backdrop` removed in 2.1.319; `AbovePromptList` needs 2.1.323) | pin the release; regenerate the symbol table per pin |

The commitment, stated plainly: *no release may make mods harder.* Every design
choice that would need to be undone to support mods later is a defect now.

### 7.7 S13: the authored `.ts` spine loads; `.tsx` is the wall (answered 2026-11-19)

`spikes/s13-mod-load/run.mjs` (**89/89**) fetched the pinned artifact —
claude-code `2.1.322`, commit `6e1e44f6433bfa17d198e932bff53373aa229eea`,
`mods/diff/hooks/register.ts`, 33,891 bytes, sha256
`cce8adf7b3218f33347707ffbfb25ff3294c184d440dfb49fa540656146debab` — and loaded
it without editing a byte. The four questions:

| Question | Answer | Evidence |
| --- | --- | --- |
| Can Node load it? | **Yes for the 505 reachable `.ts` modules**, with a host resolver; no for stock Node ESM | 579/579 `.ts` strip; the stripped entry stays 33,891 B / 1342 lines; `on('session.start')` stays line 938 |
| Which realm? | **`node:vm` `SourceTextModule`** in a per-mod context | context has no `process`, `URL` or `$`; a same-thread import exposes Node globals |
| Registration? | **10 sites / 8 unique**, equal to the scanner's 10/8 and 23 `$.` calls / 0 dynamic | both realms, source order |
| Can one hook fire? | `session.start` calls `$.session.usage`, `$.command.register`, `$.session.messages`, then returns `next(e)`; if `usage()` has no timestamp, `$.clock.now` is inserted first | 3 calls with a `startedAt`; 4 with `usage()` returning `undefined`; that handler binds 22 `$` methods |

**Resolution changes no bytes; type stripping is an in-memory, length-preserving
transform.** The graph uses four specifier shapes, which exercise three host
resolution behaviors: extensionless paths (`'./ask'`) and `'.'` self-imports
resolve to a directory `index.ts`; `.js` specifiers resolve to `.ts` files
(`'./array-of.js'`); `.jsx` specifiers resolve to `.tsx` files. The reachable
graph exercises 737 directory-index resolutions, 246 `.js`→`.ts` and 21
`.jsx`→`.tsx`; no exact-file fallback is used, and the resolver carries no other
candidate branches. These are **our host obligation**, not an upstream
specification. The only transform applied is
`module.stripTypeScriptTypes(source, { mode: 'strip' })`; it replaces type
syntax with whitespace, so byte length and line numbers are preserved (the
scanner's line numbers remain the authored ones). The only bare specifier is
`import type { ... } from 'claude-code'`; stripping erases it and the shim is
requested **0** times in both realms. The scanner reads the authored text, so
none of this is visible to it: §7.3 item 1 is unaffected.

**The `.tsx` wall.** There are 21 `.tsx` modules and 21 `.jsx` specifiers that
reach them. With the resolver in place, stock loading still stops at
`ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx" for .../views/detail/detail-view.tsx`.
`stripTypeScriptTypes` refuses **20 of the 21** modules in both `strip` and
`transform` modes: 19 fail with
`ERR_INVALID_TYPESCRIPT_SYNTAX: Expected '>', got 'ident'`, and one
(`views/prelude-of/prelude-of.tsx`) with `Expected ',', got '.'`. The single
JSX-free module, `views/body/list-block-of.tsx`, strips in both modes, but the
`.tsx` extension is still not loadable by stock Node (a direct import probe
returns the same `ERR_UNKNOWN_FILE_EXTENSION`). S13 substitutes a
name-preserving stub for each `.tsx` leaf *only* to evaluate the `.ts` spine;
the stubs are probe scaffolding, not a host design. So a mod that draws
anything is not runnable end-to-end at this pin, and the fix is a second
transform (JSX → `h`/`Fragment`), not a resolution rule. That is a decision,
not a licence under "type stripping" (§3.7).

**Realm.** `vm.SourceTextModule` is the only route that gives the environment
the `.d.ts` declares — *"an environment of its own: no DOM, no Node"* — because
a same-thread `import()` shares `globalThis` and sees `process` and `URL`. The
vm route needs `--experimental-vm-modules`, creates every module first, calls
`entry.link(linker)` once, then evaluates (linking children from inside the
linker throws `ERR_VM_MODULE_LINK_FAILURE`). It isolates the tested global
surface, not timers, promises or memory: it is a fidelity and layering choice,
not yet a security boundary.

**`$` at load time provides nothing.** It is not a global: module-level code is
imports plus `export function register(on)`, and `$` first appears as each
handler's first parameter. The same-thread route installs a counting getter for
`$` around `import()` and `register()`; it records **0 reads** and would throw
`ReferenceError` on a read. The vm context has no `$` binding at all, and a
direct `$` evaluation throws `ReferenceError`. When `session.start` fires with
`usage()` returning `{ startedAt }`, the handler calls 3 `$` methods; when
`usage()` returns `undefined`, the authored `startedAt() ?? engine.now()`
fallback inserts `$.clock.now` before `$.command.register`, for 4. The bridge
table (`register.ts:938–970`) declares 22 `$` methods; the 23rd `$.` call site
is `$.ui.resolve` at line 1008, inside `ui.render`. The host should pass `$`
per handler and resolve methods lazily, not build all 22 at load.

**What S13 changes here.** §7.3's five dependencies stand; the host gains a
prerequisite — a resolver and a linker — rather than a new subsystem. `.tsx`
moves from "open question" to a declared `planned` gap with a named cause.
What it did not settle at S13 time: a host, a materializer, an emit path, IR
changes, performance, or containment. D30 fixes type stripping as the only
sanctioned transform and keeps `.tsx` `planned` pending an explicit JSX
decision; the host skeleton followed in #33.

**Host landed (#33).** `dsh-anyplugin-mod-host` implements this section:
`loadMod({ root, entry, host })` creates one `node:vm` context per mod,
resolves the entry and every child through the three rules, strips `.ts` in
memory, links once and evaluates once, then calls the authored `register(on)`
and returns its registrations in source order. `$` is never a global: the host
wraps each registration as `handler(event, next)`; immediately before every
invocation it calls `host.dollar()` exactly once and passes the result to the
authored `handler($, event, next)`. The host never caches, clones or freezes
that namespace; `ModHost.dollar()` **must return the namespace for that one
invocation**. A host that returns the same object for two calls has reused it —
a `ModHost` bug, not host-side freshness. Evaluation happens
before `loadMod` resolves; `evaluate()` is an idempotent accessor, so a mod
cannot evaluate twice. `dispose()` makes the realm inert. The host reads
authored bytes and never writes them (the tests assert sha256 before and after).
The package has no runtime dependencies; `npm test` runs Node with
`--experimental-vm-modules`, because D30's realm needs `SourceTextModule`.

Failures are `ModHostError`s with one of four codes: `ERR_MOD_HOST_TSX` (the
graph reaches a `.tsx`), `ERR_MOD_HOST_MISSING` (the root, entry or a named
module is absent), `ERR_MOD_HOST_UNSUPPORTED_EXT` (an extension D30 does not
load) and `ERR_MOD_HOST_LINK` (a specifier outside the three rules, a
read/strip/syntax failure, a link-time named-import mismatch, a missing or
misused `register(on)`, or use after `dispose()`). Authored errors are never
wrapped: a module-level `$` remains the realm's `ReferenceError`, and a throw
from `register` keeps the mod's own stack. No `.tsx` stub, override hook or
test-only escape hatch exists. The realm is not containment (D6/D30): `on` is
a host-realm function, so authored code can reach host globals with
`on.constructor('return process')()`; the host isolates the tested global
surface, nothing more.

**The refusal is the upstream acceptance.** `loadMod` on the pinned `diff` mod
throws `ERR_MOD_HOST_TSX` naming `views/pane-view.tsx`: `register.ts` imports
`./views`, `views/index.ts` contains `export * from './pane-view.jsx'`, and ESM
links the whole graph before any hook can fire. S13 reached the hook only by
substituting `.tsx` stubs, which D30 forbids as a host mechanism. Therefore
**no upstream mod that re-exports views is loadable at this pin** — the JSX
decision gates the diff acceptance (and any mod whose graph reaches a `.tsx`),
not just drawing. The
synthetic fixture is the `$` proof: `session.start` calls
`$.session.usage → $.command.register → $.session.messages`, or
`$.session.usage → $.clock.now → $.command.register → $.session.messages` when
`usage()` returns `undefined`, then returns `next(e)`. The fetched `diff` test
asserts the refusal instead of a fired hook.

## 8. Seam capability matrix (P4)

Materializers probe before they plan. Missing seam ⇒ degrade with a diagnostic,
never assume. On a stock build several seams are absent (this machine lacks
`dsh-hooks-claude-code` and `dsh-lsp-stdio`), so the compatibility layer must
run degraded *by design*.

| Seam | Probe | If absent |
| --- | --- | --- |
| skill registry + filesystem provider | package present | commands-only fallback, `equivalent` |
| command registry (alias support) | accepts `alias` | drop alias, `equivalent` + UI note |
| hook interception (per event) | S9 confirms 9 listener seams: `agent/pre-step`, `agent/created`/`disposed`, `agent/turn-stopping`, `approval/request`, `tools/post-execute` (failure filter), `subagent/start`/`end`, `fs/observed`; 5 notification-only seams: durable records `compaction/start`/`end`, `approval/decided`, `working-directory/change`, plus the `settings/document-updated` emit. S8 wires `tools/pre-execute` and `tools/post-execute`; the S9 lifecycle ticket wires `agent/created` (SessionStart), `agent/turn-stopping` (Stop), `agent/disposed` (SessionEnd), `subagent/start` and `subagent/end` (SubagentStart/Stop), each proved by a line its handler wrote on a real headless turn (§10 S9 oracle). The mounts translate every hook into a `classicHookRegistration` and call the intercept kernel's `runChain` with fan-out continuation, so tier order, matcher skips and decision aggregation are the kernel's; the materializer keeps only the artifact re-hash, the spawn and the D20 verdict translation. Six events are unprobed, ten refuted (§10 S9); `agent/request` is deprecated and refuted for model switch | event `unsupported` **with reason**, visible in report |
| MCP client | package present | whole `mcp` node unsupported |
| subagent catalog | no catalog API at 0.2.2-rc.5 (S10); `dsh-tool-subagent` is one fixed tool per provider instance. A plugin can still register one tool per agent, scoped `<plugin>:<agent>` (Claude's Task convention) with the frontmatter description byte for byte, whose body is the first block of the child user message | catalog `exact`, invocation `equivalent`, model/tools/limits `planned`; a late `ctx.tools` is awaited with a recorded warning, and without `ctx.subagents` the catalog registers but invocation names the missing seam (§10 S10) |
| per-plugin system-prompt section | reachable through the agent context: a command handler's `invocation.agent.ctx.systemPrompt.section({complete:true})` replaces that agent's prompt byte for byte; `createAgent(..., {setup})`, `agent/created`, `dsh-persona` and an agent preset reach the same scope (S11). The entry's own `apply(ctx)` is global and is not the seam. | output styles `planned` per style with the seam and gaps named; activation waits on D10's command alias; no global injection |
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

Implemented in `packages/dsh-anyplugin-install` (v0.1). The pipeline is:

```
installs.yml + scope layers
  → compileReport(installs, { projectDir, enablements, grants })
       per plugin: read → gate(ir, grants) → authorize + attach artifact
                 → emitPlugin(attached, { trusted })
       → { entries, decisions, problems }   (compileEntries fails closed on problems)
  → one group per enabled plugin with an emittable surface, children from emitPlugin
  → reconcile(loader, entries, { decisions, onRefused })
       create (absent) · update (options changed) · keep (equal)
       remove (present but no longer desired) — capture fibers, remove, await settle
       after removals/updates: refused ← decisions (tagged with plugin)
  → { created, updated, removed, kept, failed, refused }
```

The trust gate runs before emit, not after reconcile: a hook with no matching
grant is moved to `pending` as `planned` with a reason naming the missing
grant, and `emitPlugin` never puts it in the child's `hooks` config. If that
leaves no children, the plugin contributes no group. Reconcile therefore cannot
"keep" a previously trusted hook after its hash changes: the next desired set
simply does not contain it, and the entry is removed or updated like any other
desired-state change. A hash mismatch never mutates the store; the refusal
carries the new hash for the UI to prompt with.

The install path needs the same refusals that the report shows. `compileReport`
returns every per-plugin `TrustDecision` alongside the entry list;
`compileEntries` is the reduced form and throws if any per-record problem was
collected, so a caller cannot silently lose a plugin. `compileReport` itself
keeps a malformed or unsupported lock row as a per-record `problems` entry,
not an abort of every other plugin. A refused hook has no loader entry to attach to, so `reconcile`
does not invent one: the caller passes the decisions, and the result carries
`refused` (tagged with plugin identity) after removals and updates have settled.
`onRefused` fires in that same phase, so a UI cannot show a refusal while an old
trusted child is still mounted. A refusal is a compile decision, not a loader
failure, and is not reported as `failed`.

Ids are dialect-qualified and mangled (D7): group
`anyplugin.<mangleId("<dialect>:<plugin>")>`, child
`anyplugin.<mangleId("<dialect>:<plugin>")>#<mangleId(surface)>` (`skill`,
`mcp`, `hook`). The colon-separated form is stored but unaddressable (S1 id
grammar), and group children share the root store, so the bare surface id must
be qualified or two plugins collide. The separator is `#`, which `mangleId`
can never emit: its alphabet is `[A-Za-z0-9_.@-]` plus `~` and two hex
digits. A dot would not be injective — plugin `x` with surface `skill` would
collide with plugin `x.skill` — and any character in the safe alphabet has the
same problem. The `anyplugin.` prefix on children matters twice: it keeps them
inside the namespace this layer owns, and `reconcile` ignores top-level
non-group entries there (a child id is never mistaken for a managed group).

`reconcile` touches only top-level **group** entries whose id starts with
`anyplugin.`; every other entry is left alone. It compares the loader's stored
options with the desired ones using deep structural equality
(`isDeepStrictEqual`); there is no normalization, and the loader's key sorting
does not affect the comparison. A second call with the same desired set
therefore writes nothing: `created`, `updated` and `removed` are empty and the
ids are reported as `kept`. A converged set also reports no `failed`; a
half-applied group is re-verified on the second call, still writes nothing, and
reports the same `failed` entry — "kept" is a verified no-op, not a claim that
the group is healthy. It is safe to run on every boot, after every install, and
on file watch events.

Three substrate obligations are part of the result, not hidden (S1). After each
apply, the group and every child fiber must be active; otherwise the id is
reported in `failed` (with the child id) and removed from
`created`/`updated`/`kept` — group entries are not atomic, so "applied" has to
be checked rather than assumed. A desired child whose existing entry is
parented somewhere other than the group it would be applied to — or a group id
held by a non-group entry — is refused before apply, including when the options
already match, so a `kept` result cannot launder an adoption. The parent is
read from the store, not inferred from ids: two groups can both name the same
child, and `EntryGroup.create` would reuse the slot (`??=`), reparent the
other group's entry and later dispose its fiber. Removal captures the group and subtree fibers before `loader.remove`,
then waits for them to settle at state 4; state 5 is unloading, not done. The
same wait applies to children an `update` drops: `EntryGroup.update` removes
them without awaiting their disposers, and `loader.await()` no longer sees
them. `removed` therefore means the subtree was actually torn down, not merely
dropped from `entries()`.

## 10. Verification plan

- **S1 — emission substrate.** ✅ **Answered 2026-11-18** by `spikes/s1-loader`
  (21/21 checks, cordis 4.1.0 / cordis-plugin-loader 1.1.0 /
  cordis-plugin-group 1.1.0). See §10.1 for the findings and what they force.

### 10.1 S1 result: the substrate works, but it hands us obligations

A foreign plugin can be one group entry — `name: '@deepseek-ai/cordis-plugin-group'`,
`group: true`, `config: EntryOptions[]` — and its children are ordinary entries
that apply, address and dispose like any other. What the loader does **not**
give us, and what the emitter therefore owes:

| Property | What actually happens |
| --- | --- |
| **Atomicity** | Not provided. `EntryGroup.update()` `.catch()`es each child's `create()`, so one failing child leaves the healthy siblings applied; the failure surfaces only as a non-active fiber plus a log line. Reconcile therefore checks every child's fiber state and reports the group in `failed` instead of calling it created; it does not pretend the group can be rolled back to a state that never existed. |
| **Rollback** | Removing the group after a failure does leave no orphans — proven, but it is our call, not the loader's. |
| **Identity** | `ensureId` reuses an existing id, so materializing the same tree twice takes the `update` path instead of duplicating. Ids are the identity, exactly as the reconcile design assumes. |
| **Id grammar** | `EntryTree.sep = ':'` and `resolve()` splits on it, so an id containing `:` is stored but **unaddressable**. Foreign ids must be mangled (D7). |
| **Teardown** | `remove()` returns void and drops the entry from `entries()` immediately, so `loader.await()` can return before disposers ran. Deterministic teardown = capture the fiber references, `remove()`, observe state 5 (unloading), then wait for state 4 (disposed, `uid === null`). `dispose()` is void for some fiber kinds and is not reliably awaitable, so never rely on its return value. |
| **Plugin cleanup** | cordis has no `'dispose'` event. Cleanup is `ctx.effect(execute)` where `execute` returns the disposer — a materializer that registers teardown any other way silently never cleans up. |

Consequences, all of which are now constraints on the emitter: a failed apply
is reported, never rolled back; ids are mangled and namespaced before they
reach the loader, and an id already owned outside the group is refused; every
materializer registers cleanup through `ctx.effect`; reconcile captures fiber
references before removing or updating anything.

- **S2 — mod surface.** ✅ **Answered 2026-11-18** (§7): the mod API is a large
  but fully specified surface with a machine-readable declaration file, so it
  is a second subsystem (D3), not a materializer.
- **S3 — conformance rig.** 🟡 **Both halves live 2026-11-18**
  (`packages/dsh-anyplugin-conformance`). The upstream half (§10.2) probes
  `claude --plugin-dir <dir> plugin details <name>` under a throwaway `$HOME`
  and commits the result as a golden per pin. The DSH half (§10.4) materializes
  the emitted entry into the *pinned* harness and reads the same inventory
  back. `npm test` re-probes both sides; `coverage.test.mjs` is the burn-down
  table: 16 declared rows, 15 matched, 0 missing, 1 refused. Both halves also
  run in CI, with the pinned Claude CLI fetched from npm (D24).
  This landed *before* the translator could lie, because it is the only honest
  scoreboard.

### 10.2 S3 first layer: the upstream oracle is the real loader

The rig never parses plugin directories on the upstream side. It asks the host:

```
claude --plugin-dir <dir> plugin details <name>
```

That prints a component inventory (skills, agents, hooks, MCP servers, LSP
servers) plus a projected token cost, which makes the installed loader the
ground truth instead of our reading of its docs. Two consequences:

- **Determinism is engineered, not assumed.** Every probe runs with `HOME` and
  `CLAUDE_CONFIG_DIR` pointed at a fresh temp dir, so it cannot see the user's
  own installation and two runs are byte-comparable. Inventories are
  normalized (sorted, deduped, notes for anything unrecognized) before diffing.
- **The pin is part of the comparison.** A diff against a golden captured on a
  different version fails on the pin alone; passing across versions is never
  allowed to look like a pass (§3.8).

The binary is resolved, not assumed (D24):

```
CLAUDE_BIN    an explicit executable; CI sets it to the fetched pin
claude        PATH lookup
```

`scripts/fetch-claude.mjs` installs the pinned npm package into
`.claude-code/<version>/` and prints the platform-native binary; the tests and
the workflow guard assert `claude --version` against `CLAUDE_CODE_PIN`. With
neither source a local run skips with a reason; under CI that is an error. The
same nine goldens are therefore re-probed by CI, so the inventory gate does not
depend on the laptop.

What the rig already reports, at the pin it was captured on, is in §10.3.

### 10.3 What the first pin says (claude-code 2.1.322)

Six fixtures, captured and re-verified on every `npm test`. Two observations
contradict the prose documentation and are now the reason surface mapping is
pin-gated (D8):

| Observation | Consequence |
| --- | --- |
| `commands/*.md` is reported under **Skills** (a command-only plugin shows `Skills (1) migrate`) | at this pin a command and a skill share one surface; the command materializer is only used when a pin profile says the host still separates them |
| `commands/<dir>/*.md` is **not loaded** (`Skills (0)`) | nested command namespacing described in the docs does not exist at this pin; the dialect must record the drop as an explicit annotation, not silence |
| `agents/<dir>/*.md` is **not loaded** either (`Agents (1)` for a flat+nested fixture) | same treatment: drop with a reason |
| hooks and MCP servers carry a parenthetical cost note (`PostToolUse  (harness-only — no model context cost)`) | the note is a component detail, not part of the name |
| a plugin with no manifest and a root `SKILL.md` loads under the directory name | no-manifest loading is real, and worth a fixture |

### 10.4 S3 second layer: the DSH oracle boots a pinned harness

The DSH side is not a re-implementation of the registry, because a
re-implementation would agree with itself. The oracle boots the packages a real
DSH installation runs — the Desktop bundle or a released npm harness fetched
into `.harness/<version>` — and imports `cordis`, `cordis-plugin-loader` and
`dsh-skill` straight out of that tree (`4.1.0` / `1.1.0` / the pinned
version). D22 owns the resolution order:

```
DSH_HARNESS_DIR      install root printed by scripts/fetch-harness.mjs <version>
DSH_INSTALL_DIR      the Desktop installation's @deepseek-ai/dsh package dir
.harness/<version>   for DSH_HARNESS_VERSION, inside this checkout
```

The first source that is named and usable wins; a named-but-unusable directory
is an error. Nothing named means nothing resolves locally and the oracle tests
skip with a reason; CI resolves in a guard step and fails before the suite runs if
it cannot.

The enabling discovery: `$(dirname "$DSH_INSTALL_DIR")` is a **plain
directory**, not an `asar` archive — 338 `@deepseek-ai` packages that ordinary
Node can `import()`. A fetched tree has the same shape: its
`node_modules/@deepseek-ai` holds only the packages the oracle and
materializers import, which is enough because the oracle imports each package by
absolute path. (The original text said the oracle "never touches npm"; D22
explains why that was wrong — rc.2 from npm is byte-identical, and the
real rule is that the tree must be *pinned*.)

```
dialect → IR → emit (group entry, pure data) → Loader → materializer
        → ctx.skills.register → ctx.skills.list() → inventory
```

The loader anchors entry-name resolution at its `baseUrl`: the `dsh` package in
a Desktop tree, the install root in a fetched tree (whose `package.json` is
written by `fetch-harness.mjs` so the loader's scope resolver finds a manifest).
Both trees are booted by the same `probeWithDsh({ harnessDir, entry })`.

Two traps that cost real time and are now load-bearing:

- **One cordis, or none.** The oracle must import `Context` from the harness
  tree too. A `Context` from our devDependency with services from the booted
  `dsh-skill` would give two `Service` base classes, and the registry would
  never see the context that owns it.
- **The fiber is the teardown handle.** `Loader` has no `stop()` — its own
  prototype is `constructor, commit, showLog, locate, exit, unwrapExports` and
  `stop` is simply undefined on an instance. A probe that calls
  `loader.stop?.()` therefore tears nothing down: an MCP transport keeps its
  child process alive and the test runner never exits. The handle is the fiber
  returned by `ctx.plugin(Loader, …)`; disposing it runs every entry's effect
  disposers, which is what closes the transport.
- **Registration is lifecycle-scoped.** `ctx.skills.register()` returns a
  disposer, and cordis has no `dispose` event (S1 finding 3), so the
  materializer wraps it in `ctx.effect`. A materializer that forgets this leaks
  the skill after the entry is removed — invisible in a green test, visible in
  a reload.

Measured coverage across the ten fixtures (declared components from the
goldens, matched by the DSH oracle). CI measures the same rows against both
`0.2.2-rc.5` and `0.2.2-rc.2`; a skipped row is a failed job there. The other nine
fixtures boot the loader with `probeWithDsh`; the lifecycle fixture
boots a real turn graph with `probeLifecycleWithDsh` (§10 S9), because its rows
exist only as lines the handlers wrote. The turn graph needs the extra pins
from the S9 recipe above; CI installs them at each fetched version before
`verify`:

| Fixture | Declared | Matched | Missing | Refused | What the gap needs |
| --- | --- | --- | --- | --- | --- |
| `claude-skills-only` | 2 | 2 | 0 | 0 | — |
| `claude-root-skill` | 1 | 1 | 0 | 0 | — |
| `claude-command-nested` | 0 | 0 | 0 | 0 | — (host loads nothing; we emit nothing) |
| `claude-commands-flat` | 2 | 2 | 0 | 0 | model face done; human face needs the two seams in D10 |
| `claude-agents` | 1 | 1 | 0 | 0 | one tool per agent; description byte for byte, body as the first user block (S10; invocation `equivalent`) |
| `claude-hooks-mcp` | 2 | 2 | 0 | 0 | hook mounted on `tools/post-execute` and observed on a real call (D20) |
| `claude-hooks-lifecycle` | 5 | 5 | 0 | 0 | five handlers ran on one real headless turn (root start/stop/end + one child); SessionStart/Stop/SessionEnd root-only, SubagentStart/Stop child-only (§10 S9) |
| `claude-mcp-http` | 1 | 1 | 0 | 0 | streamable-http arm; the server is started by the test (D12) |
| `claude-mcp-tool-budget` | 1 | 1 | 0 | 0 | one fitting tool registers, one over-budget tool is skipped |
| `claude-mcp-budget` | 1 | 0 | 0 | 1 | prefix alone is 66 characters; refused at plan time (D11) |
| **total** | **16** | **15** | **0** | **1** | |

`claude-commands-flat` moved from 0 to 2 on its **model face alone**. A command
is one artifact with two observable faces — the catalog entry the model sees,
and the `/plugin:name args` typing surface — so its IR node carries
`faces.model` / `faces.human`; the count moves on the model face, while the
component's overall fidelity stays `planned` (D10). Reporting 6/8 without that
distinction would claim a two-component win that a user still cannot type.

**Refused** is a third outcome, not a softer `missing`. It means we read a
component, judged it unrepresentable, and said so with a reason — the
over-budget MCP fixture is the first case: every tool name from it would start
with 65 characters before the tool's own name, so nothing it exposes can fit the
64-character limit both hosts share (D11). Counting it as `missing` would show a
failure we chose; counting it as `match` would be a lie.

A **hook** is the one component a registry cannot testify for. A hook that was
parsed, emitted and mounted but never ran leaves the same inventory as one that
works. So the oracle fires one real call at the tool its matcher targets and the
row flips only if the hook's own text came back on that result — the same rule
as MCP (a server counts when it contributes a tool, not when a config names it).
`dsh-anyplugin-hook-runner` is tested separately, without a harness: payload in,
verdict out.

The number the project reports is `matched / declared`, never a percentage of
"things we tried". `coverage.test.mjs` pins every row: closing a gap is a
reviewable edit to that matrix, and a regression fails on the same line.

One compile-side row needs no oracle. `rig report <plugin-dir>` reads the plugin
with the dialect, emits in memory and prints what the transplant would do: per
component its surface, name, class and reason, its `model` / `human` faces where
the IR models more than one, and whether emit carried or skipped it. The trailing
totals aggregate those rows — `declared` from the IR's entry list, `emitted` /
`skipped` from each component's carry decision — so they cannot disagree with the
components above them. The report is a reader, not a second fidelity claim: the
classes and reasons come from the IR annotations and `carried` is emit's
`considered` set minus its `skipped` set, which is why it runs in CI without the
installed harness. `validateIr` problems make it exit non-zero and are labelled
`validation:`, not passed off as a transplant verdict; `report --ir <file>`
exists so that path is reachable from a compiled IR, without planting a broken
plugin.

Still open on this layer: the inventory says *what* loaded, not *how it
behaves*. Invocation semantics (is a flat command auto-invocable like a skill?
does `disable-model-invocation` change it?) need the behavior arm —
`claude plugin eval` or a transcript diff — which is the layer after the DSH
oracle.
- **S4 — dialect extensibility.** Add the `cursor` stub dialect; if it needs a
  materializer change, the IR has leaked and must be fixed.
- **S5 — tool-name budget.** ✅ **Answered 2026-11-18** by `spikes/s5-tool-names`
  (6/6): the 32-character cap is `dsh-mcp-client`'s config schema, not the
  runtime — a 42-character namespace registers through `ctx.tools.register` and
  the projected schema carries the name byte for byte. Nothing locally enforces
  the 64-character contract either (a 95-character name is accepted), so that
  budget must be self-imposed and the over-budget case annotated, not renamed.
  Consequence: the MCP materializer owns its connection (D12).

- **S6 — hook payload shapes.** ✅ **Answered 2026-11-18** by
  `spikes/s6-hook-payloads`, partially: `SessionStart`, `UserPromptSubmit` and
  `SessionEnd` capture without a login (hooks fire before the API call), which
  produced 3 verbatim payloads. `PreToolUse`/`PostToolUse`/`Stop` need a model
  turn and this machine is not logged in (`claude auth status` → `loggedIn:
  false`), so those stay doc-shaped until a capture replaces them. Two findings:
  the real payload carries `prompt_id`, which the doc examples omit; and a doc
  example is a *variant*, not a schema (the `SessionStart` example is a resume
  payload carrying five fields the startup capture does not). Consequence:
  payload fixtures, not prose, own the event table (D15).

  **A DeepSeek backend removes the model confound.** `claude` speaks the
  Anthropic Messages API and DeepSeek serves it at `/anthropic`, so the real
  client can run here with the *same model* our side uses. Two hosts, one model:
  a behavioral difference is then attributable to the harness — which is the
  only thing we claim to preserve. This turns the behavior face from "open"
  into measurable, and it is the precondition for the escape layer: delegating
  a component to a real client is only honest if both sides run the same
  weights.

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
| v0.3 | Codex dialect via portable IR; LSP; output-styles (carry unblocked; activation waits on the D10 command alias); bin |
| v0.4 | agents (per-agent tools or prompt template); themes (F2 ANSI seam); monitors; workflows |
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
  **S13:** type strip refuses 20 of the 21 `.tsx` modules in both modes (19
  `Expected '>', got 'ident'`, one `Expected ',', got '.'`); the JSX-free
  `views/body/list-block-of.tsx` strips but stock Node still refuses the `.tsx`
  extension, and a resolver alone reaches only `ERR_UNKNOWN_FILE_EXTENSION`.
  The `.ts` spine loads, but a drawing mod is not runnable until this is
  decided (see §7.7 and the proposed decision in #30).
- How does Claude bundle and serve a mod's `Client` second file? Undocumented;
  needs hands-on probing before it can be classified as anything but `planned`.
- Which execution realm do we give a mod (`node:vm` like the dynamic-package
  runner, a worker, or the host thread)? It is a fidelity question *and* the
  security question, since mods can approve tool calls and read credentials.
  **S13 answered the realm half:** `node:vm` `SourceTextModule`, because a
  same-thread import shares `globalThis` and exposes Node globals (§7.7). The
  containment half — timers, promises, memory — remains open; the spike proves
  a global surface, not a sandbox.

- **S7 — behavior face.** ✅ **Answered 2026-11-19** by `claude plugin eval` on
  the DeepSeek backend: the fixture suite scores 1.0 and each run writes
  `out/trace.jsonl`, the stream of tool calls, tool results and model-visible
  messages. Two things came out of the first trace. The skill envelope is not
  a bare body (D16), which moved every skill with arguments from `exact` to
  `equivalent`. And the trace's `system:init` tool list is filtered by the
  case's `allowed_tools` — the recorded case offers seven tools and no `Bash`
  — so the list is a property of the case, not of the host (D18).
  `normalizeTrace`/`diffTraces` and `rig trace` turn a trace into an ordered,
  positionally diffed event stream. **Still open:** DSH has no recorder for
  what reaches the model, so `rig trace` currently diffs two upstream traces;
  the cross-host behavioral diff waits on that recorder.

- **S8 — do hooks have a host?** ✅ **Answered 2026-11-19** by
  `spikes/s8-hook-waterfalls` (installed harness, 10/10), and the answer
  corrects §8's "hook interception absent": the tool pipeline already exposes
  the two waterfalls classic hooks need.
  - `tools/pre-execute` (waterfall) sees `{callId, name, arguments, agent}` for
    a pending call and may return `{kind:'deny', reason}`; the model then reads
    a failed result whose text is `Error: <reason>`. That is PreToolUse's
    `permissionDecision: deny` / exit 2.
  - `tools/post-execute` (waterfall) sees the normalized result and may return
    `{kind:'accept', value}` (replace the projection) plus
    `additionalContexts: UserMessage[]` (inject text the model reads next
    turn). That is PostToolUse's `additionalContext` and output rewriting.
  - Two contracts the spike pinned: a **failed** result cannot have its value
    replaced (`tools/post-execute cannot replace the value of a failed
    result`), and a standalone `ctx.tools.execute` call carries no `agent`, so
    the payload's agent-derived fields are absent rather than invented.
  - Consequences: the hook arm maps to these waterfalls instead of
    `ctx.tools.guard` (guard is monotonic denial only, no result, no
    injection), the interception kernel's `observe` mode matches the waterfall
    contract exactly (`next()` = continue), and the missing-event list shrinks
    to the events that are not tool-scoped (`SessionStart`, `UserPromptSubmit`,
    `Stop`, `Notification`, …). See D19.

- **S9 — do the other 30 hook events have a host?** ✅ **Answered 2026-11-19** by
  `spikes/s9-host-events/run.mjs` against the pinned `0.2.2-rc.5` harness
  (66/66 checks). The sweep covers
  `emit`/`waterfall`/`serial`/`parallel`/`bail` and the carrier-first
  `ctx.waterfall(carrier, "name", …)` shape. In the rc.5 tree it found 97
  dispatch sites and 57 host event names; the full 338-package `0.2.2-rc.2`
  Desktop tree was swept separately as a cross-check. A name in a bundle is not
  evidence: every confirmed row booted the harness and a listener received the
  event. **Fourteen seams are confirmed, six events are unprobed, and ten are
  refuted with the reason recorded here.**

  **Rule used below.** A classic event is *confirmed* when a listener on the
  existing host bus runs at the classic lifecycle point — a cordis
  `waterfall`/`serial`/`emit`, or a `session/event` observer for the durable
  record appended at that point. A record row is **notification-only**: the
  hook can log or relay, but the record is already committed and the hook
  cannot veto. *Unprobed* means a durable record or emit plausibly exists but no
  probe established that it corresponds to the classic lifecycle; the entry
  says what would settle it. *Refuted* means neither a dispatch nor a record
  exists at that point, or the only candidate fires at a different lifecycle.
  Influence cells are tagged `[observed]` or `[source]`; `[source]` was read
  from the implementation and has not been exercised by the spike. The last
  column also names the filter the *wiring ticket* must apply. The filters the
  spike exercises are asserted; prompt identity, `apply_patch` and the
  permission correlation are explicitly marked as wiring work.

  **The spike itself moved no coverage row** — a hook counts only when it runs
  (D20), so wiring the confirmed events was a separate ticket. That wiring now
  exists for the lifecycle five: their `planned` annotations became
  `equivalent` and their five coverage rows are log lines from a real turn
  (§10.3), while the four remaining listener seams stay `planned`. Nothing
  here adds a second event path: every row is a listener on the existing host
  bus.

  | classic event | host seam (site) | dispatch | observed at runtime | payload keys | influence [observed]/[source]; filter the wiring ticket must apply |
  | --- | --- | --- | --- | --- | --- |
  | UserPromptSubmit | `agent/pre-step` (`@deepseek-ai/dsh-agent-loop/lib/index.js:698`) | waterfall | yes — injected text reached the model | `messages, turn, step, signal, modelSelection, agent` | return `{kind:'enter', messages}` injects text [observed]; `{kind:'reject'}` aborts the step [source]. Fires once per **model step**: a 3-request turn produced 3 pre-steps (asserted), so filter `step === 1`. Prompt identity is **not** asserted: the claimed messages also contain runtime-context/system-reminder user messages, so the wiring ticket must establish the user-prompt test. |
  | SessionStart | `agent/created` (`@deepseek-ai/dsh-agent/lib/index.js:705`) | serial, scoped | yes — source `startup` (the only source the probe produced) | `agent, source, signal`; `source: startup \| resume \| clear \| compact` | none [observed]; a throwing listener rejects creation [source]. Asserted filter: `agent.session.header.parentSession === undefined` (without it the probe sees 2 creations, the parent and the child). |
  | SessionEnd | `agent/disposed` (`@deepseek-ai/dsh-agent/lib/index.js`, dynamic dispatch) | emit, agent-scoped | yes — on registry detach (`ctx.agents.detachEntered`), and the subagent dispose path also fired it | `agent` | none [observed]. Same `parentSession` filter; the probe disposes a child activation, so the child event is non-vacuous. Fiber-level disposal is not proven. |
  | Stop | `agent/turn-stopping` (`@deepseek-ai/dsh-agent-loop/lib/index.js:804`) | serial | yes | `turn, signal, agent` | none at dispatch [observed]; steering the turn open is documented only [source]. |
  | PermissionRequest | `approval/request` (`@deepseek-ai/dsh-user-approval/lib/index.js:201`) | waterfall | yes — the listener verdict became `rejected`; the audit pair was recorded | `agent, toolName, callId, signal` (no `tool_input`) | deny by returning `rejected` [observed]; `allowed-once` allows [source]. A hook that inspects `tool_input` must correlate `callId` with the already-presented call (`dsh-user-approval/lib/types/index.d.ts:65-66`). The probe entered at the service; a real demand begins at `dsh-tools/lib/pipeline.js:628`. |
  | PostToolUseFailure | `tools/post-execute` (`@deepseek-ai/dsh-tools/lib/pipeline.js:668`) | waterfall | yes — success **and** failure | exec `token, callId, rootCallId, name, signal, agent, toolSet, deferContext, concludeTurn, arguments`; result `isError, error, content` | inject `additionalContexts` [observed; complete messages with `source` required]; replacing a failed value is forbidden [source]. Asserted filter: `result.isError === true` (without it the probe counts 2 calls, one success and one failure). |
  | SubagentStart | `subagent/start` (`@deepseek-ai/dsh-subagent/lib/index.js:2015`) | emit, scoped | yes — provider `fork` | `runId, provider, parentSessionId, id, local` | none [observed]. |
  | SubagentStop | `subagent/end` (`@deepseek-ai/dsh-subagent/lib/index.js:2172`) | emit, scoped | yes — `stopReason: completed` | `runId, provider, parentSessionId, id, local, stopReason, lastAssistantMessage` | none [observed]. |
  | PreCompact | `session/event` `compaction/start` (`@deepseek-ai/dsh-compaction-basic/lib/index.js:469-474`, appended before summarization) | durable record | yes — observed before `compaction/summary` | `compactionId, turn` | notification-only [observed]; there is no pre-compaction waterfall, so a hook cannot veto. |
  | PostCompact | `session/event` `compaction/end` (`@deepseek-ai/dsh-compaction-basic/lib/index.js:484,495`, appended after summary) | durable record | yes — observed after `compaction/summary` | `compactionId, turn` (+ `error` on failure) | notification-only [observed]. |
  | PermissionDenied | `session/event` `approval/decided` | durable record | yes — `{id, outcome}` observed | `id, outcome` | notification-only [observed]. The record carries no tool name or input; a hook can only correlate `id` with an `approval/asked` it kept (`{id, toolName, callId}`). |
  | CwdChanged | `session/event` `working-directory/change` | durable record | yes — `{cwd}` observed | `cwd` | notification-only [observed]. Do **not** use `working-directory/access`: it is a pre-access check that also fires with `path:null` (probe) and carries no old/new cwd. The record carries only the new cwd, and only service-driven `set()`/`ensure()` produce it. |
  | FileChanged | `fs/observed` (`@deepseek-ai/dsh-tool-fs/lib/index.js:199,354,495,822,841,860,887,892,1869`) | emit | yes — `write`, `read` and `edit` observations | `(target {displayPath}, {kind, version?}, exec)` | none [observed]. Asserted filter: `tool ∈ {write, edit}` and `kind === 'present'` (without it the probe counts 3 observations, including `read`). `apply_patch` was not exercised; the wiring ticket must confirm it. There is no content delta. |
  | ConfigChange | `settings/document-updated` (`@deepseek-ai/dsh-settings/lib/index.js:419-436`) | emit | yes — first read `revision 0`, unchanged second read emits nothing, changed document `revision 1` | `(ns, revision)` | notification-only [observed]; it is a settings-document revision, not the profile config replay, and carries no changed values. It **also fires on first read**, so a hook must not treat every event as a change. |

  **Unprobed (6).** Each has a plausible durable record or emit, but the spike
  did not establish that it runs at the classic lifecycle point. Marking these
  confirmed without a probe would repeat the error that made `TaskCreated` look
  refuted.

  - `TaskCreated` — `team/task` is appended at
    `@deepseek-ai/dsh-agent-team/lib/index.js:93`. To settle: mount
    `TeamService` with an agent loop, create a task through the team service or
    its tool, and assert the record type/payload and whether a create-specific
    point exists. Not probed here.
  - `TaskCompleted` — same record family; to settle, drive a task to completion
    and assert the terminal record (and whether it is distinguishable from a
    creation record). Not probed here.
  - `TeammateIdle` — `team/member` records exist; to settle, transition a
    teammate to idle and assert a record at that transition. Not probed here.
  - `WorktreeCreate` — `plugin:worktree/created` is appended at
    `@deepseek-ai/dsh-experimental-worktree/lib/index.js:898`. To settle: mount
    the worktree service, create a session worktree, and assert the record and
    its payload. Not probed here.
  - `WorktreeRemove` — `worktree/cleanup` is emitted at
    `@deepseek-ai/dsh-experimental-worktree/lib/index.js:112,127`. To settle:
    remove a worktree and assert whether cleanup fires per removal and what it
    carries. Not probed here.
  - `StopFailure` — `turn/end` with an error reason is appended at
    `@deepseek-ai/dsh-agent-loop/lib/index.js:832`. To settle: drive a turn to an
    error ending and assert the reason and whether any failure-specific
    dispatch exists. Not probed here.

  **Refuted (10), with the reason.** A refuted row is a lifecycle the host does
  not expose as a listener seam, not a claim that the corresponding data is
  absent from the session log.

  - `Notification` — no host event carries a notification `message`, `title` or
    `notification_type`. `approval/asked` is a permission-prompt record with
    `{id, toolName, callId}` — a different lifecycle and payload; mapping it to
    Notification would let a hook see only permission prompts, never the
    informational classes. Refuted for the hook as a notification seam.
  - `PreModelSwitch` — `agent/request` (`dsh-agent-loop/lib/index.js:1007`)
    fires per request, not on a model switch. Returning a different model after
    step preparation throws `agent/request proposed "…" after step preparation
    fixed "…"; use agent.model.select() before step preparation` (probe), and
    reasoning effort is guarded the same way. The waterfall is deprecated; only
    non-model controls remain rewritable, which is not a switch signal.
  - `InstructionsLoaded` — no dispatch. `dsh-agent-instructions` is itself a
    listener on `agent/pre-step` and `session/event`; there is no load-time
    event.
  - `DirectoryAdded` — no dispatch site anywhere in the swept tree.
  - `Setup` — no dispatch. `agent/created` with source `startup` is the closest
    lifecycle point, but it is not setup.
  - `UserPromptExpansion` — no dispatch. Expansion happens in the command layer
    before the prompt; `agent/pre-step` sees only the expanded messages.
  - `MessageDisplay` — no dispatch. `assistant/message` is a generation record;
    display is a client concern, so there is no display-time listener.
  - `PostToolBatch` — no after-batch point. `tools/execute`
    (`dsh-tools/lib/pipeline.js:501`) is per-call pre-execution
    (`token, callId, rootCallId, name, arguments, …`), not a batch.
  - `Elicitation` / `ElicitationResult` — MCP JSON-RPC protocol notifications,
    not cordis host events.

  Two sweep caveats for the next prober: `agent/disposed` is dispatched by a
  helper with a computed name, so a literal `.emit("…")` scan misses it (the
  runtime probe catches it); and only `startup` was observed for
  `agent/created` — `resume`, `clear` and `compact` are read from the type.

  Reproduce:

  ```bash
  node scripts/fetch-harness.mjs 0.2.2-rc.5
  npm install --prefix .harness/0.2.2-rc.5 --no-save --ignore-scripts \
    --cache "$PWD/.npm-cache" @deepseek-ai/dsh-agent-loop@0.2.2-rc.5 \
    @deepseek-ai/dsh-subagent@0.2.2-rc.5 \
    @deepseek-ai/dsh-subagent-fork-in-process@0.2.2-rc.5 \
    @deepseek-ai/dsh-tool-subagent@0.2.2-rc.5 \
    @deepseek-ai/dsh-compaction-basic@0.2.2-rc.5 \
    @deepseek-ai/dsh-agent-team@0.2.2-rc.5 \
    @deepseek-ai/dsh-working-directory@0.2.2-rc.5 \
    @deepseek-ai/dsh-tool-fs@0.2.2-rc.5 \
    @deepseek-ai/dsh-fs-local@0.2.2-rc.5 \
    @deepseek-ai/dsh-fs-observation-policy@0.2.2-rc.5 \
    @deepseek-ai/dsh-user-questions@0.2.2-rc.5 \
    @deepseek-ai/dsh-settings@0.2.2-rc.5 \
    @deepseek-ai/dsh-experimental-worktree@0.2.2-rc.5 \
    @deepseek-ai/dsh-agent-instructions@0.2.2-rc.5 \
    @deepseek-ai/dsh-tool-fs-search@0.2.2-rc.5
  DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
    npm run spike:s9
  ```

  A bare fetched harness prints `0/0 checks passed` and exits non-zero; a
  skipped required probe is a failed run. `spikes/s9-host-events/out/` (including
  `out/settings-profile/`) is report output only and gitignored. CI runs the
  spike after installing the same pins (`.github/workflows/verify.yml`).

  **Observed by the oracle — the headless turn.** The lifecycle wiring does not
  emit host events: it runs one real turn with a stub model and reads what the
  plugin's handlers wrote. `probeLifecycleWithDsh`
  (`packages/dsh-anyplugin-conformance/src/oracles/dsh.ts`) boots one cordis
  context with this composition, in this order:

  | # | Service / plugin | Package |
  | --- | --- | --- |
  | 1 | `Loader` (kept as a fiber; the entry is created through it) | `cordis-plugin-loader` |
  | 2 | `SkillRegistry` | `dsh-skill` |
  | 3 | `SessionStore` | `dsh-session` |
  | 4 | `SessionProjections` | `dsh-session-projection` |
  | 5 | `SystemPrompt` | `dsh-system-prompt` |
  | 6 | `ToolsService` | `dsh-tools` |
  | 7 | `AgentRegistry` | `dsh-agent` |
  | 8 | native tool executor | `dsh-tool-executor-native` |
  | 9 | `FileSystem` + `WorkingDirectory` | `dsh-fs-local`, `dsh-working-directory` |
  | 10 | `SubagentRuntime` + `ForkProvider` | `dsh-subagent`, `dsh-subagent-fork-in-process` |
  | 11 | `LlmRuntime` | `dsh-llm` |
  | 12 | `AgentLoop` | `dsh-agent-loop` |

  The stub provider is a subclass of `LlmAdapter` registered as `['fake']`:
  `resolveModel` returns a context window and token cap, `stream` yields one
  text block and finishes `stop`. No network, no key, no model. The call
  sequence is the recipe — every step is a host call, not an emit:

  1. `await ctx.loader.create(entry)`, then **`await ctx.loader.await()`** — a
     trap that cost a debugging session: `create` resolves before the entry's
     import/apply lifecycle tasks settle, and a root agent created immediately
     after misses a listener the entry just registered. `EntryTree.await()`
     waits for the tree's pending tasks and is load-bearing in the oracle (a
     live host has the same gap after an install).
  2. `root = await ctx.agentLoop.create('anyplugin-lifecycle-root', {provider:
     'fake', model: 'fake-1'})` → `agent/created` with `source: startup`
     (SessionStart).
  3. `root.followup(createUserMessage({content: [...], source: {kind:
     'user'}}))`, wait for `session/event` `turn/end` with `turn === 1` →
     `agent/turn-stopping` (Stop).
  4. `activation = await ctx.subagents.startActivation({provider: 'fork',
     parent: root, prompt: [...], delivery: 'caller', label: ...})` →
     `subagent/start` (SubagentStart); wait for `subagent/end` with
     `parentSessionId === root.id` → SubagentStop; `await activation.dispose()`.
  5. Find the root's registry entry and call `ctx.agents.detachEntered(entry)`
     → `agent/disposed` (SessionEnd).

  The fixture's five handlers wrote exactly one line each. Their *set* is fixed;
  their total order is not. `subagent/end` and `agent/disposed` are independent
  emits, so under CPU contention the child's completion and the root's disposal
  can interleave: the oracle once saw `SessionStart, Stop, SubagentStart,
  SessionEnd, SubagentStop` on two cores. The only chains the host guarantees,
  and the only ones asserted, are `SessionStart < Stop < SessionEnd` and
  `SubagentStart < SubagentStop`; the test compares the label set and those
  two orders, never a three-way interleaving. The child's own `agent/created`
  and `agent/turn-stopping` also fire; the root-only
  `parentSession === undefined` filter keeps them from duplicating
  SessionStart/Stop, while SubagentStart/Stop require `parentSessionId !==
  undefined` so the root's delegation is the only source.

  The oracle reads the child's `pluginData` directory out of the emitted entry
  and removes the log and payload files before the run, so a stale line cannot
  pass for a fired handler. It then polls until every expected label exists, up
  to the caller's 10 s deadline; a label that never arrives fails with the lines
  that did. It never waits for the file to stop growing: the host dispatches
  emits without awaiting async listeners, and handlers are `sh` spawns, so a
  slow handler is still a valid run while a quiet file can still be missing its
  last line. The fixture writes `payloads/<Event>.json` **before** the log line,
  making the line the completion marker; the test then pins the exact payload
  keys: SessionStart carries `hook_event_name`, `cwd`, `session_id`,
  `source` and `model`; Stop and SessionEnd carry
  `hook_event_name`, `cwd` and `session_id`; SubagentStart adds `agent_id`
  with the parent as `session_id`; SubagentStop adds `last_assistant_message`.
  The root is created with `cwd` metadata — the third `create` argument,
  `{cwd: dataDir}` — so its immutable header really carries one, and the probe
  deliberately seeds the data directory rather than the process cwd: a payload
  that fell back to the process directory would fail the assertion
  `start.cwd === dataDir` instead of matching by accident. (The rc.2 pin
  accepts the same third argument; both verify lines exercise it.)

  Every field the dialect's reasons call absent is absent.

- **S10 — can a plugin make its `agents/*.md` personas model-selectable?**
  ✅ **Answered 2026-11-19** by `spikes/s10-agents/run.mjs` against the pinned
  `0.2.2-rc.5` harness (16/16 checks). Yes, without a new seam — but not through
  a catalog. `dsh-subagent` registers no tool at all (it is a named-provider
  registry), and `dsh-tool-subagent` registers **one fixed tool per provider
  instance**, not one per agent. A plugin can register **its own tool per
  agent**: the tool name is `<plugin>:<agent>` — Claude's Task convention — the
  description is the frontmatter description byte for byte, and invoking it
  starts a child through `ctx.subagents.startActivation`. The body cannot be the child's system prompt
  at this pin: `SubagentStartRequest.prompt` is explicitly "Content delivered as
  the child's user message" and there is no instructions field. So the body is
  the first block of the child's initial user message, ahead of the task. That
  carries Claude's *effect* (`equivalent` invocation) with a different tool
  shape: N named tools instead of one `Task` tool with a `subagent_type` enum.

  **1. What the model sees.** `@deepseek-ai/dsh-subagent` mounts a service
  (`super(ctx, 'subagents')`, `src/index.ts:210`) and exposes
  `registerProvider` (`src/index.ts:522`, wrapped by `ctx.effect` at
  `:540`); it never calls `ctx.tools.register`. The consumer,
  `@deepseek-ai/dsh-tool-subagent`, registers exactly one tool per instance in
  `mount(provider)`, with a description built from
  `providerWording(provider.inheritsParentContext)` — fixed per provider, not
  per agent. The spike mounts two instances named `subagent` and `delegate`
  and observes two tools with the **same** description, both free of the agent
  text. `ctx.tools.schemas()` is the model-visible list. The spike registers the
  materializer from `fixtures/claude-agents`, observes the scoped tool
  `agents-fixture:reviewer` with description `Reviews a diff for defects.` byte
  for byte, and calls it through `ctx.tools.execute` with a live parent; the
  colon is accepted by `dsh-tools` (the charset rule that rejects it lives in
  the MCP client, not the tool registry), so cross-plugin name collisions are
  gone and the body does not appear in the description.

  **2. Where the body goes.** `SubagentStartRequest.prompt: ContentBlock[]`
  carries the JSDoc "Content delivered as the child's user message"
  (`dsh-subagent/src/types.ts:155-156`); the interface has no
  `instructions`/`systemPrompt` field (asserted lexically in the spike).
  `SubagentManager.startLocal` submits exactly that prompt through
  `submitMaterialized(..., { source: { kind: 'user' } })`
  (`dsh-subagent/src/manager.ts:409-410`). At runtime the child is a real agent
  (`agent/created` with `session.header.parentSession === parent.id`, settling
  through `subagent/end` with `completed`); its system prompt is the composed
  deployment/agent-loop prompt and does **not** contain the body; its first
  user message starts with the body, then the task, then the manager's delivery
  guidance. The only fresh-start route to the system prompt is an Agent Preset:
  `applyChildComposition` calls `presets.mount(childCtx, agentPreset)`
  (`dsh-subagent/src/child-agent.ts`) and `dsh-persona` contributes the
  `deployment:persona-prefix` section inside such a composition. That is a
  preset id, not a description-driven catalog, and it requires the
  `agentPresets` service (`dsh-agent-preset-registry`, whose own README says
  its Model Experience is "Nothing directly"); `dsh-tool-subagent`'s
  `agent_preset` parameter is an enum of allowed **ids** with one fixed
  sentence, not per-agent descriptions (`src/preset-selection.ts`).

  **3. The other frontmatter keys.** `model`, `effort`, `tools`,
  `disallowedTools`, `maxTurns` and `isolation` are not fields of
  `SubagentActivationSpec`. Passing them anyway is silently ignored — the
  harness neither maps nor refuses them (probe: an activation with all six
  still runs and the child still sees the parent toolset). `agentOptions` is the
  only per-activation escape: `agentOptions.model: 'sonnet'` reaches the
  provider as the raw model id `sonnet` with the parent's provider, so Claude's
  aliases would need the §9 escape layer to name a real provider model; model
  identity therefore stays `planned`. `tools`/`disallowedTools` stay `planned`:
  `startActivation` has no per-activation tool filter, and
  `childCtx.tools.restrict` is only reachable from a preset or a cold-resume
  descriptor (`dsh-subagent/src/child-agent.ts:218`). `maxTurns`/`isolation`
  would need the child loop, reachable only through a preset; `effort` exists
  on `AgentOptions` as `reasoningEffort` but the frontmatter value has no
  provider-neutral spelling. All six are recorded in the IR with reasons,
  never invented.

  **What this buys, and what it does not.** Catalog face `exact` (name and
  description are what the model sees), invocation `equivalent` (N tools vs
  one `Task` tool with `subagent_type`), model/tools/limits `planned`.
  The DSH oracle learns `agents:<name>` only from a schema it observes in
  `ctx.tools.schemas()` whose scoped name and description equal the **emitted
  declaration** byte for byte — never from the IR skeleton. `agents.test.mjs`
  is the independent fixture anchor: it reads the description from the
  fixture's frontmatter bytes and the body from the emitted `agents` child, so
  the two sides cannot drift together. A tool cannot put the body in its
  description (we forbid it), cannot set the child's fresh system prompt,
  cannot filter the child's tools or cap its turns per activation, and cannot
  resolve a Claude model alias. `fixtures/claude-agents` therefore moves to
  `agents:reviewer:match`; the truthful totals became **11 declared / 10
  matched / 0 missing / 1 refused** at this ticket — the goldens declare 11
  rows in total, and the nested `agents/deep/planner.md` is not loaded at the
  pin, so it is not a declared row, and the issue text's "12/10/1/1" counts a
  row the host does not have. (The S9 lifecycle wiring that follows moves the
  totals to 16/15/0/1; §10.3.)

  Reproduce:

  ```bash
  node scripts/fetch-harness.mjs 0.2.2-rc.5
  npm install --prefix .harness/0.2.2-rc.5 --no-save --ignore-scripts \
    --cache "$PWD/.npm-cache" @deepseek-ai/dsh-agent-loop@0.2.2-rc.5 \
    @deepseek-ai/dsh-subagent@0.2.2-rc.5 \
    @deepseek-ai/dsh-subagent-spawn-in-process@0.2.2-rc.5 \
    @deepseek-ai/dsh-tool-subagent@0.2.2-rc.5 \
    @deepseek-ai/dsh-session-persistence-jsonl@0.2.2-rc.5 \
    @deepseek-ai/dsh-working-directory@0.2.2-rc.5 \
    @deepseek-ai/dsh-fs-local@0.2.2-rc.5
  DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
    npm run spike:s10
  ```

  An explicitly configured but incomplete harness exits 2 naming the missing
  packages; the spike never falls back to another install and never calls a
  missing package a pass. `spikes/s10-agents/out/` is report output only and
  gitignored.

- **S11 — can a plugin contribute system-prompt text that is active only for
  the agents it creates?** ✅ **Answered 2026-11-19** by
  `spikes/s11-prompt-scope/run.mjs` against the pinned `0.2.2-rc.5` harness
  (16/16 checks). Yes. The seam is the agent-scoped system-prompt layer, and a
  plugin reaches it through the agent context it is handed. The earlier "no
  seam" answer was wrong: it tested only a Loader entry's own `apply(ctx)`
  registration, which is global, and concluded the agent scope was host-only.

  **1. The four reachable paths.** The spike dumps `options.messages[0]` — the
  composed system prompt the model actually receives — from a fake adapter:

  | path | what the spike does | observed |
  | --- | --- | --- |
  | `createAgent(..., { setup })` | registers `anyplugin:output-style:terse` on `agentCtx` in setup | present in that agent's dump, absent from a sibling, absent after `dispose()` |
  | command handler | `ctx.commands.register({ name: 's11-style', handler })`, then `/s11-style` on one agent; the handler calls `invocation.agent.ctx.systemPrompt.section({ ..., complete: true })` | the agent's next dump is byte-for-byte `S11-COMPLETE: terse.`; a sibling is untouched; the second turn is still exactly that text |
  | `agent/created` | listener filters `payload.agent.id === 's11-created'` and registers on `payload.agent.ctx` | present in that agent's dump, absent from its sibling |
  | declarative | `dsh-persona` mounted on `agentCtx`; an agent preset registered with `dsh-agent-preset-registry` and mounted in setup | both persona sections present in the respective dump |

  The command path is the exact activation shape of `/<plugin>:<name>`: the
  handler runs without a model turn and acts on the invoking agent. The
  section is registered on the agent's own scope, so a sibling sees nothing
  and the agent's later turns keep it.

  **2. Scoping is the agent, not the entry.** `SystemPrompt.section()` registers
  through `this.layers.effect(this.ctx, ...)`, and Cordis hands the service a
  per-caller view, so the layer is the calling context's scope. `agentCtx`,
  `invocation.agent.ctx`, `payload.agent.ctx` and a mounted preset are all agent
  scopes. A Loader entry's `apply(ctx)` is not: that registration lands in the
  root layer and changes every agent's prompt. The difference is which context
  the entry acts through, not whether a plugin may act at all.

  **3. Compaction.** The prompt is re-assembled from the scope's sections on
  every request. The spike forces compaction (`compaction/start`,
  `compaction/summary`, `compaction/end`) and the scoped style is still in the
  request after `compaction/end`: compaction rewrites history, not the section
  layer.

  **4. What this does not settle.** Four gaps remain before a carry:
  (i) **provenance** — `agent/created` carries the agent but no plugin id, so an
  at-start contribution needs an id filter or a plugin-created agent;
  (ii) **activation name** — `/<plugin>:<name>` needs D10's additive
  command-alias seam, because a command name cannot contain `:` at this pin (an
  alias would be new additive work, not an existing equivalent);
  (iii) **oracle anchor** — `claude plugin details` does not inventory output
  styles at 2.1.322, so the inventory oracle cannot see the row and a fixture
  would have to compare a dumped composed prompt;
  (iv) **composition** — `keep-coding-instructions: true` keeps Claude's
  built-in coding instructions, which a `complete` section cannot express
  because it replaces the whole prompt. An output style also replaces (rather
  than augments) the Claude prompt, and `force-for-plugin` applies it
  session-wide while the plugin is enabled; a DSH carry must choose an explicit
  activation path rather than inject at load.

  **What this buys, and what it does not.** Each `output-styles/*.md` is one
  `planned` row (`outputStyles:<name>`) whose reason names the reachable seam
  and the four gaps; a `manifest:outputStyles` row records a custom directory.
  It does not carry the style: no materializer, no coverage row, no fixture.
  The upstream CLI's inventory has no output-style line, so a golden would be
  empty and could not anchor the row. The totals stay **16 declared / 15
  matched / 0 missing / 1 refused**; this ticket moves no fixture row.

  Reproduce:

  ```bash
  node scripts/fetch-harness.mjs 0.2.2-rc.5
  npm install --prefix .harness/0.2.2-rc.5 --no-save --ignore-scripts \
    --cache "$PWD/.npm-cache" \
    @deepseek-ai/dsh-agent-loop@0.2.2-rc.5 \
    @deepseek-ai/dsh-subagent@0.2.2-rc.5 \
    @deepseek-ai/dsh-subagent-fork-in-process@0.2.2-rc.5 \
    @deepseek-ai/dsh-fs-local@0.2.2-rc.5 \
    @deepseek-ai/dsh-working-directory@0.2.2-rc.5 \
    @deepseek-ai/dsh-llm@0.2.2-rc.5 \
    @deepseek-ai/dsh-session@0.2.2-rc.5 \
    @deepseek-ai/dsh-session-projection@0.2.2-rc.5 \
    @deepseek-ai/dsh-agent@0.2.2-rc.5 \
    @deepseek-ai/dsh-commands@0.2.2-rc.5 \
    @deepseek-ai/dsh-compaction-basic@0.2.2-rc.5 \
    @deepseek-ai/dsh-token-meter@0.2.2-rc.5 \
    @deepseek-ai/dsh-persona@0.2.2-rc.5 \
    @deepseek-ai/dsh-agent-preset@0.2.2-rc.5 \
    @deepseek-ai/dsh-agent-preset-registry@0.2.2-rc.5
  DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
    npm run spike:s11
  ```

  An explicitly configured but incomplete harness exits 2 naming the missing
  packages; the spike never falls back to another install. The report is
  `spikes/s11-prompt-scope/out/report.json`, with the prompt dumps beside it;
  `out/` is report output only and gitignored.

- **S12 — do classic hooks fan out, or does a decision stop the rest?**
  ✅ **Answered 2026-11-19** by `spikes/s12-hook-fanout/run.mjs` against the
  pinned Claude Code 2.1.322 (7/7 checks; the model turn runs on the DeepSeek
  Anthropic-compatible backend, key read from the environment or
  `~/.config/dsh-anyplugin/deepseek.key`, never printed). This spike is
  local-only and key-gated; it is **not a CI step** (a step that always skips
  would be worse than no step). Without a key it records a named skip and exits
  0; every other failure exits non-zero. Two hooks per event.
  In the deny run the first `PreToolUse` exits 2 and the second still writes its
  marker; the tool call is blocked (no `PostToolUse` fires). In the allow run
  both hooks of `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` and
  `SessionEnd` write markers, including when the first `PostToolUse` reports a
  denial and the first `Stop` exits 2 once. So a decision is **collected**, not
  a chain stop: every matching handler runs. The pinned client dispatches the
  matching hooks concurrently, so arrival order is not stable; the kernel still
  walks registrations in deterministic order for a reproducible trace (D13),
  and the materializer aggregates the collected decisions afterwards. This is
  the `fan-out` continuation in §7.2; `fixtures/claude-hooks-fanout` asserts the
  two-context case on a real DSH turn.

  Run:

  ```bash
  node spikes/s12-hook-fanout/run.mjs
  ```

  `spikes/s12-hook-fanout/out/` is report output only and gitignored.

- **S13 — can an authored mod be loaded unmodified and one of its hooks fire?**
  ✅ **Answered 2026-11-19** by `spikes/s13-mod-load/run.mjs` against
  claude-code `2.1.322` (commit
  `6e1e44f6433bfa17d198e932bff53373aa229eea`; `mods/diff/hooks/register.ts`,
  33,891 bytes, sha256
  `cce8adf7b3218f33347707ffbfb25ff3294c184d440dfb49fa540656146debab`;
  **89/89 checks**). Yes for the `.ts` graph; no for `.tsx`. The spike fetches
  the artifact and a sparse `mods/diff/hooks` tree at run time, asserts size
  and sha256 before and after, and never edits or commits them.

  **Proven.** The authored `.ts` spine loads (505 reachable modules, no source
  rewrite); `register(on)` reaches exactly the scanner's events; `session.start`
  runs with a per-handler `$`; the vm context lacks `process`, `URL` and `$`.
  **Not proven by this spike.** A host, materializer, emit path or IR change;
  `.tsx` or JSX support; the element runtime; `$.ui` (its call site is
  `register.ts:1008`, outside the fired hook); hooks longer than
  `session.start`; containment (timers, promises, memory, permissions). (The
  host skeleton landed separately in #33 — §7.7 — but `.tsx` remains the
  refusal, so "load a real mod" is still gated on the JSX decision.)

  **Load.** All 579 `.ts` files strip with 0 failures; the stripped entry stays
  33,891 bytes / 1342 lines and `on('session.start')` stays line 938. Stock ESM
  refuses four specifier shapes that exercise three host resolution behaviors
  — extensionless/`'.'` to `index.ts`, `.js`→`.ts`, `.jsx`→`.tsx` — so a host
  resolver is required; with it both realms load 505 `.ts` modules plus 21
  `.tsx` stubs. The reachable graph exercises 737 directory-index, 246
  `.js`→`.ts` and 21 `.jsx`→`.tsx` resolutions; no other fallback is used. The
  only bare specifier is `import type { ... } from 'claude-code'`, erased by
  stripping; a `claude-code` shim is requested 0 times. Type strip refuses 20
  of the 21 `.tsx` modules in both modes (19 `Expected '>', got 'ident'`, one
  `Expected ',', got '.'`); the JSX-free `views/body/list-block-of.tsx` strips
  but the `.tsx` extension is still refused by stock Node. The stubs are probe
  scaffolding only (see §7.7).

  **Realm.** `node:vm` `SourceTextModule` (`--experimental-vm-modules`;
  create → `link()` once → `evaluate()`), because the context has no
  `process`, `URL` or `$`, while a same-thread import exposes Node globals.
  `$` is not a global: a counting getter around the same-thread load and
  registration records 0 reads, and evaluating `$` in the vm context throws
  `ReferenceError`.

  **Registration.** `register(on)` has arity 1 and reaches exactly the
  scanner's 10 sites / 8 unique events (23 `$.` calls, 0 dynamic) in both
  realms, lines 938–1294.

  **Fire.** With `usage()` returning a `startedAt`, `session.start` calls
  `$.session.usage`, `$.command.register` (`{ name: 'diff', ... }`) and
  `$.session.messages`, then returns `next(e)` unchanged. With `usage()`
  returning `undefined`, the authored `?? engine.now()` fallback inserts
  `$.clock.now` before `$.command.register`: 4 calls. The handler binds 22 `$`
  methods; the host must provide `$` per handler, lazily.

  Reproduce:

  ```bash
  npm run spike:s13
  ```

  `spikes/s13-mod-load/out/` is report/cache output only and gitignored; the
  fetched artifact is never committed.
