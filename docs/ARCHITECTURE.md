# dsh-anyplugin — Architecture

> Status: baseline (decisions D1–D36 ratified by the owner — the log is
> `docs/DECISIONS.md`; §0.4 keeps the three that frame the design).
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
| **F1** Output style | `output-styles/*.md` | **carried** byte-identical as IR data; activation `equivalent` through the agent-scoped prompt seam (S11) on top-level agents and forks, selected by the profile activation record or `force-for-plugin`; the human `/<plugin>:<name>` half stays `planned` — D10's alias, and no `plugin details` inventory at 2.1.322 |
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

### 0.4 The framing decisions

D1–D3 shape every section below; the rest of the ratified log (D4–D37) is
`docs/DECISIONS.md`.

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

### Package layout (as built)

This is the as-built set, not a target: exactly the packages
`scripts/check-architecture.mjs` accepts. Anything the original design named but
that does not exist yet is under **Not yet built**, not in this table.

| Package | Role |
| --- | --- |
| `dsh-anyplugin-ir` | IR schema, normalizer, fidelity algebra, validators |
| `dsh-anyplugin-intercept` | the one interception kernel: event points, matcher grammar, decision protocol, tier ordering, budgets; consumed by classic hooks and, eventually, the mod host |
| `dsh-anyplugin-hook-runner` | runs a Claude-style command hook: payload in, verdict out; no host knowledge |
| `dsh-anyplugin-mod-scan` | static, non-executing scan of a mod: literal `on('event')` / `$.ns.method` sites, plus what the scanner cannot prove; feeds the capability list |
| `dsh-anyplugin-mod-host` | loads one authored mod in a per-mod `node:vm` realm: resolver, classic-pragma `.tsx` transform, in-memory type strip, `on()` and a per-handler `$` (D30, D34) |
| `dsh-anyplugin-skill-template` | Claude skill argument substitution as a pure function, waiting on the tool-schema seam (D17) |
| `dsh-anyplugin-command-template` | Claude command expansion (`$ARGUMENTS`, `$1..$9`, the trailer) as a pure function |
| `dsh-anyplugin-trust` | exec classify/authorize/gate + the canonical `grants.yml` store (D25) |
| `dsh-anyplugin-emit` | IR → `EntryTree` patch; emission is data |
| `dsh-anyplugin-install` | install lock + scope replay → loader entries; idempotent reconcile |
| `dsh-anyplugin-dialect-claude-code` | `.claude-plugin/` → IR, at a pinned host version |
| `dsh-anyplugin-dialect-codex` | Agent Plugins 1.0.0 / `.codex-plugin/` → IR (today's portable reader) |
| `dsh-anyplugin-materialize-skill` | IR → the skill registry |
| `dsh-anyplugin-materialize-command` | IR → the command registry under the exact colon names; reports each rejection |
| `dsh-anyplugin-materialize-hook` | IR → the tool and lifecycle waterfalls, through the one kernel (D19) |
| `dsh-anyplugin-materialize-mcp` | IR → the MCP client, with Claude Code's exact tool names (D12) |
| `dsh-anyplugin-materialize-agents` | one model-facing tool per agent file; the child is started through `ctx.subagents` (S10) |
| `dsh-anyplugin-materialize-output-style` | IR → the selected style body at `agent/created`, through `agent.ctx.systemPrompt.section`; profile-wide, one selection at a time (ticket #77) |
| `dsh-anyplugin-conformance` | fixtures + record/replay diff (first-class, not an afterthought) |

**Not yet built.** The original map also named `dsh-anyplugin-ui` (client half:
install list, fidelity report, trust grants), `dsh-anyplugin-dialect-portable`
(the shared `agent-plugins.org` reader; `dsh-anyplugin-dialect-codex` reads that
shape itself today), and
`dsh-anyplugin-materialize-{bin,theme,monitor,workflow}`. Themes are carried as
`planned` IR rows with no materializer; output styles are carried the same way
but do have one — `dsh-anyplugin-materialize-output-style` applies the selected
body through the agent-scoped prompt seam (S11). The host-controller surface the old row
called `dsh-anyplugin` — the `anyplugin` command family and an API for the UI —
is not built: the root package ships a controller row, not a command family, and
reconcile lives in `dsh-anyplugin-install`.

### The published package

The root package is `dsh-anyplugin` (0.2.0), and it is the one published artifact.
Since 0.2.0 the published `lib/materialize/hook.js` also carries the mods
kernel and the two Babel packages it needs for the one classic-pragma
transform (`D34`; §7.8).
`src/` remains the development entry: every workspace manifest keeps
`exports["."] = "./src/index.ts"` so tests and spikes run the sources directly.
`scripts/build.mjs` bundles each runtime entry to `lib/<name>.js` for a
consumer's Node; that build is packaging, not code generation — the compiler
still emits a pure-data `EntryTree` (`D1`), and nothing is written or evaluated
at install time.

`exports` publishes only what a patch row or the reconciler can name: `.` (the
controller) and `./materialize/{skill,mcp,hook,agents,output-style}`.
The other runtime modules are bundled into those entries rather than published
as separate subpaths, and the reconciler names materializers by published
subpath (never by file URL), so the tarball can move without rewriting config.
`cordis.patch.yml` inserts exactly one row; every other entry is created at
runtime from `installs.yml`.

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

Commands and skills collapse at the current pin: at Claude Code 2.1.329 a
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
schema: "dsh-anyplugin/installs@2"
plugins:
  - dialect: "claude-code"
    name: "skills-only"
    version: "0.0.1"
    root: "/…/artifacts/claude-code/skills-only/0.0.1"
    dataDir: "/…/data/claude-code/skills-only"
    pin: "claude-code@2.1.322"
    source: "{\"marketplace\":\"my-marketplace\",\"entry\":\"skills-only\",\"integrity\":\"git:9f1c2ab3d4e5f60718293a4b5c6d7e8f90123456\",\"resolvedAt\":\"2026-11-21T00:00:00Z\"}"
```

`source` is optional provenance (D23): a `plugin-dir:` label for a directory
install, or a JSON object inside the quoted string naming the marketplace and
entry a catalog install came from. A fetched entry adds the artifact's
`integrity` (`git:<commit>`, `npm:<sha512>` or `sha256:<bytes>`) and the
`resolvedAt` time it was first written. The two are recorded together inside
the same quoted value; the schema moved to `@2` for `mods`, not for this
field: every value is still one double-quoted JSON string, so a reader that
only requires `source` to be non-empty reads the file, while the fields are
validated like every other field.

The example above is an illustrative lock written at the 2.1.322 pin; the
live pin is `CLAUDE_CODE_PIN` in the conformance package.

`root` is versioned, `dataDir` is not. `pin` is the host version the artifact
was read against (AGENTS.md §3.8), so a build that reads a different version
rejects the record instead of silently reinterpreting it. The canonical writer
sorts, quotes and writes atomically; the reader accepts only these fields — the
six required above plus an optional `source` provenance line (D23) — and
rejects anything else with a line number rather than repairing it — "cannot
parse" must never become "uninstalled".

A record that installs a module carries `mods` (schema `@2`), one entry per
declared module entry:

```yaml
schema: "dsh-anyplugin/installs@2"
plugins:
  - dialect: "claude-code"
    name: "mods"
    version: "0.0.1"
    root: "/…/artifacts/claude-code/mods/0.0.1"
    dataDir: "/…/data/claude-code/mods"
    pin: "claude-code@2.1.329"
    mods:
      - entry: "hooks/register.ts"
        rootRelative: "hooks"
        mode: "composite"
        artifactHash: "sha256:19bc03c2d2ef64aec6959f9e2dc26f229cd80bcc10d555ecb7e473289e45d261"
        files:
          - path: ".claude-plugin/plugin.json"
            sha256: "sha256:0bf777bfa4bd02b725abf5740edb658b3f6b9b8688b1aee18e82adbf2cf5d5f5"
            bytes: "142"
          - path: "hooks/hooks.json"
            sha256: "sha256:939f03f60edc3527e5cf5165eeae78ecac8941d6fa56bd3122970ec0c85401a3"
            bytes: "115"
          - path: "hooks/register.ts"
            sha256: "sha256:0f8d95361739d5c3a427b75062d47220b5d5e7edf1682a0c02b83765f59a0b96"
            bytes: "310"
          - path: "hooks/support/note.ts"
            sha256: "sha256:7cbf2cb22612789feba769db254818e08c459dd0ba23bbcc7381be5426fd0002"
            bytes: "51"
```

`entry` is the authored entry file, plugin-relative; `rootRelative` is the
directory upstream resolves it from (`hooks`, the directory of `hooks.json`).
The artifact is the **plugin tree**, not that subdirectory: a mod can import any
file under its root, so every file under `pluginRoot` except `.git/`,
`node_modules/` and the plugin data directory is code-capable and is pinned.
`files` lists each one with its plugin-relative path, sha256 and byte length, so
the manifest does not depend on where the tree is checked out. The tree is
hashed as one artifact: `mode` is `file` for a one-file tree and `composite`
otherwise, `invocation` is `entry`, there is no command line, and the files are
framed **in ascending path order**. That order is a *derived* rule, not an
upstream one: D25 fixes a manifest as code and says order matters, and sorting
the plugin-relative paths is this layer's definition of a tree, so two checkouts
of the same bytes pin the same digest. A symlink whose real path leaves the
plugin root is refused when the tree is scanned, and a directory symlink is
refused outright: the loader would follow code the manifest cannot name. This
tree rule supersedes D25 **for mods only** (D25's "the program only" and "no
sorting" sentences); hooks keep D25's single-program manifest. `rig grant`
prints the entry and that digest before asking for `--yes`; `rig revoke` takes
the same `mod:<entry>` target and keeps working after uninstall.

The reader accepts `@1` (no `mods`): a 0.1.0 lock loads as if it had no mods,
and the next write normalizes it to `@2`. The other direction is refused rather
than ignored — a 0.1.0-only reader rejects a `@2` record's `mods` as an unknown
field with a line number, which is the downgrade story: no silent drop of the
paragraph that gates `loadMod`.

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

**Axis 3 — activation (profile-global, one selection).** Output styles are
prompt text, not a tool, so activating one is a selection rather than a
surface: at most one style is active for the profile. It lives in the same
profile anyplugin dir, read-only (AGENTS.md §3.4):

```yaml
schema: "dsh-anyplugin/output-styles@1"
outputStyles:
  active: "output-styles-activation:append-style"
```

`active` is `<plugin>:<style>`, where the style name is the one Claude
registers (frontmatter `name`, else the file stem). A missing file is "no
explicit activation". The syntax is the canonical subset D23 uses; anything
else is a load error with a line number — "cannot parse" never becomes "no
style". A record that exists but cannot be read (`EACCES`, `EISDIR`, …) is a
load error naming the code, never a silent fallback to force-for-plugin, and
`outputStyles: {}` followed by an `active` row is a contradictory record.
An empty or whitespace-only body is a typed `empty-style` refusal rather than
a silent no-op; the parser preserves bytes, only application is refused.
Resolution is typed too: `unknown-plugin`, `plugin-disabled`,
`plugin-unreadable`, `unknown-style`, `empty-style`. A refusal is reported on
`compileReport.activation` and is not a `problem`, so the rest of the lock
still compiles and a caller can show the reason; the install convenience path
(`compileEntries`) turns it into `OutputStyleActivationError` instead, so a
refused selection never compiles silently. An explicit record always wins,
including when it refuses; `force-for-plugin: true` applies only when its
plugin is enabled and no explicit record names a style, and the trace names
which rule won. A whitespace-only forced style is skipped in favour of a later
valid one and refused with the same `empty-style` code when it is the only
candidate. That precedence is deliberate: upstream documents
`force-for-plugin` as overriding the user's selection, but this layer has no
host `outputStyle` setting, so the profile record is the operator's explicit
statement and overriding it would invert the only control the operator has.
The selection is emitted as one `outputStyle` child on the owning plugin;
`dsh-anyplugin-materialize-output-style` registers an `agent/created` listener
and applies the body through `payload.agent.ctx.systemPrompt.section(...)` with
`interpolate: false`, and `complete: true` only when the frontmatter says
`keep-coding-instructions: false`. Anything else — including an absent key —
appends a section and keeps the host's coding instructions. The listener skips
agents whose origin is `subagent`: upstream applies styles to the main
conversation and forks, and a `complete` section on a child would replace its
whole prompt. The body is applied as authored. The activation face is
`equivalent`; the row's overall class stays `planned` because the human
`/<plugin>:<name>` command half is not reachable (D10).

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
depends on it yet).

**Landed (#36, consumed by #39):** `modRegistrationsToKernel` converts
`loadMod`'s frozen registrations into kernel registrations (`wrap` mode, source
`${plugin}/${entry}#index`, `continuation` left unset so a channel's classic
arm keeps fan-out) and reports every event it cannot seat instead of dropping
it. The production caller is the same materializer: its `mods` config loads
each mod once, adapts the registrations, and seats them **per agent** on the
`payload.agent.ctx` that `agent/created` carries (S9). That seat is
deliberate: a plugin-entry context is untagged, so `ctx.on` there would see
every agent's events and a mod's `$` could read a sibling's session;
`agent.ctx` is scoped to that agent, and events flow up the scope chain, never
down (`dsh-scope`). `createSeat` is idempotent per session id, and `apply`
sweeps `ctx.agents.list()` so a root that was already live when the plugin
loaded is seated too. A reload disposes the old seat with the plugin effect and
re-seats the live set; it does not replay `classic.SessionStart`. The seat
combines the mod registrations with the classic ones for the same event and
runs one `runChain`; the plugin-level classic mounts skip a call that has a
seat, so a hook is not run twice. A subagent is seated too (its parent's events
still reach the root seat, but its own tool calls do not leak to the parent);
`SessionStart`/`SessionEnd` remain root-only, matching S9's classic map. The
realm is owned by the plugin entry (`ctx.effect(() => handle.dispose())`), so
removal disposes it and later invocations fail with `ERR_MOD_HOST_LINK`
instead of reviving a dead module.

`session.start` fires while `apply` runs — once per loaded plugin, before the
first prompt of the process, never per agent and never at `agent/created`
(that is classic `SessionStart`). On a late enable or reload a root may
already be live, so the claim is "once per load, before the first prompt", not
"before any agent exists"; a reload is a new `apply`, which fires it again
with exactly that load's registrations. The payload is `{cwd}`: the live
root's cwd when one exists, otherwise the process working directory, never
`CLAUDE_PLUGIN_ROOT`. `surface` and `isInteractive` are host/session facts
`apply` cannot observe, so they are omitted and recorded as a field gap with
a reason — never filled with invented values.

`updatedInput` is applied at the seam the kernel already returns: the
pre-execute mount reads `ChainResult.event.data.tool_input` after the chain,
validates it as lossless JSON, clones and deep-freezes it, checks that the
execution object's `arguments` property is writable, and assigns it before
`next()`. A non-writable property, a non-JSON value, or a missing
`tool_input` is a typed `unsupported` (trace and warning), never a throw and
never a silent drop. The DSH `tools/pre-execute` waterfall has no value
channel — a non-`allow` decision is a denial — so this reuses the existing
mount and the existing `runChain` result; it does not add a second event path.
The trace and the classic arm see the same rewritten event because the classic
registration runs later in the same fan-out chain, and a `hooks.json` command
hook's own `updatedInput` is carried by its verdict into that same rewrite.

The mapping is data in `mod-events.ts`, one row per mod event with the host
seam and the pinned `claude-code.d.ts` line as evidence — claude-code
2.1.322, commit `6e1e44f6433bfa17d198e932bff53373aa229eea` (the d.ts file's own
header still says 2.1.277; the commit is the pin). It is **16 live `classic.*` routes,
the live `session.start` loader event, and the `tool.call` and `prompt.context`
engine routes**, 19 live routes. `tool.check` is a measured refusal: it is the
engine's permission verdict after `PreToolUse`, with `next.origin`, `trace`,
`settings.read`, `op`/`ceiling`/`approver` in its question, none of which the
pre-execute gate carries (D41 proposal in the #69 PR).

`on()`'s `Pattern` is first-class (d.ts:9447 at the 2.1.329 pin): `classic.*` expands to the 16
classic routes, `*` to all 19, and a negation (`!tool.*`) to the complement.
Selected names without a route keep their own reason (a classic event S9 leaves
unprobed or refutes, or an engine event with no shared protocol); a pattern
that cannot be expanded gets a pattern-shaped reason of its own.

The 16 `classic.*` names map one-to-one onto their classic kernel points and S9
seams; `classic.PreToolUse` is special-cased because the mod API hands it
`ToolCallEnvelope` (d.ts:17689 at the 2.1.329 pin), not the classic stdin payload, so the
adapter rebuilds the envelope and carries a rewrite back.
`classic.PermissionRequest` and `classic.PermissionDenied` record their partial
payloads at the S9 seam (no `tool_input`; no tool name or input).
`session.start` is the loader's per-plugin event, fired from `apply`, and maps
to the kernel's `session.start`, not to `agent/created` (that is classic
`SessionStart`). `tool.call` translates at the edge rather than widening the
classic PreToolUse result channel: the mod event is the `ToolCallEnvelope`
(d.ts:17689 at the 2.1.329 pin), so its structural matcher is evaluated against
that envelope, and its result is the engine's `ToolCallResult` (d.ts:17729 at the 2.1.329 pin).
`{ deny }` becomes the gate decision; `next()` projects the gate's
continuation, not a `ToolCallResult`, and an authored `{ allow: true }` is
refused as a non-pin field. `{ result }` and `{ isError }` are typed
`unsupported` with `hard: true`, and the pre-execute mount turns that into a deny plus a
trace record, because the seam has no value channel and executing the call
would silently drop the mod's answer. `prompt.context` maps to the agent-scoped
`system-prompt/assemble` waterfall: the route sees only the pin-named blocks
(`claudeMd`, `userEmail`, `attachedProject`, `currentDate`) plus blocks it owns,
so a mod cannot drop DSH's operational contexts; it runs once per seat until
`compaction/end` (the host re-read) and reads back a `{ blocks }` answer, while
`instructionFiles` is typed `unsupported` (the host projects instruction files
into a user-role message, not into the assembly contexts, and
`$.ui.invalidate` reaches the headless render sink: `ui.render` re-runs the
pane's render hook with no drawing, and `prompt.context`/`prompt.section` drop
this seat's cached assembly so the next draw asks again; a `/clear` starts a new
session and therefore a new seat).
The
adapter does not derive a tier from the event name: the host seats a plugin,
and `user` is only the fallback when a caller has no seating, never `core`
(d.ts:9899 at the 2.1.329 pin). Unmapped engine-native events (56, including the refused
`tool.check`) and classic events S9 leaves unprobed or refutes (17) stay on the
adapter's `unmapped` list with that reason; the ticket's guessed names (`post.tool.use`, `turn.stop`, …) are
reported as absent from the pin and point at their real spelling rather than
being aliased.

A mixed chain still runs one `runChain`: the classic registration declares
fan-out, so a `[mod, classic, mod]` chain with no explicit continuation runs
all three. In **fan-out** a mod's `next(e)` runs the rest of the chain as an eager trip
and that trip's decisions are collected, but the call resolves the kernel's
continue, not `ClassicResultOf` (D32 §6's return rule; the eager trip is the
#68 model change). A **mod-only** chain is
`first-decision`: `next(e)` runs the chain beneath and resolves that event's
`ClassicResultOf` (`{cwd}` for `session.start`). D13's "a mod that declines
`next()` owns the rest of the chain" is therefore a `first-decision` statement;
in fan-out the channel owns continuation. Classic return fields are translated,
not collapsed: `additionalContext` becomes the kernel's `text` channel,
`updatedInput` becomes an event rewrite, and fields with no carrier (`ask`,
`preventContinuation`, `stopReason`, `updatedToolOutput`, …) are a typed
`unsupported` with a reason.

The mod-visible `next` is that same continuation with the pinned members
projected onto it (`claude-code.d.ts:8289-8367 (2.1.329 pin)`, issue #68): `to(e, tier)` calls
the kernel `Next` with the tier argument the kernel already understands, so
tier order, matcher skipping and trace recording stay in one place. `next` is
eager and call-scoped: each call immediately continues the chain from the
calling link and returns that trip, with that call's `to` target. A hook that
calls `next` twice runs the remainder twice — our host contract, not a pin
guarantee: the pin only says `trace` describes "its latest next() call", and
we take it as the cited spec for this rule. The latest trip is the one the
return decides with and the one `trace` describes, and a sibling's later call
can never inherit or be blamed for someone else's jump. An unawaited `next` is
joined exactly once before the loop decides, so the remainder never runs
twice. Every call also joins the previous trip before it starts, so
`void next(e); await next(e)` runs the two trips sequentially — a call
supersedes ordering, not concurrency, and the trace boundary is the second
call's start. Both
continuations follow the same rule: fan-out runs an eager fan-out trip and
still collects its decisions, but a mod's `next` resolves the kernel's
continue, not the classic arm's result. This refines D32 §6's sentence "a
mod's next(e) only rewrites the event … it does not run the classic arm
itself": the eager trip now does run it, and the return rule is unchanged — the
chain collects the trip's decisions, the mod does not decide them. A jump is
computed by tier
rank, not by index: only links strictly between the caller's tier and the
target tier are passed over and recorded as `skipped` with
`bypassed by <plugin>`, while a same-tier sibling still runs. When that
sibling names its own target, the nested call's target wins over the outer
one: the outer target is never reached, and the passed-over links are recorded
once by the innermost call. The landing is
inclusive of the named target, including a direct jump with no link in
between; a named tier with no link left falls forward to the next tier that
has one rather than dropping the rest of the chain. `to` refuses a target tier
that has already run (the pin only moves outward, `claude-code.d.ts:8289-8367`).
`core` is a declared fidelity gap: the pin's `TargetTier` allows it, but this
chain has no core link, and naming it would skip the `builtin` tier without
running it, so the member refuses with a reason naming the gap instead of
resolving. `signal` is the handler's own
`AbortController`, fired by the handler's timeout and linked to
`ChainOptions.signal`; the materializer passes `ToolExecution.signal` for
PreToolUse/PostToolUse, so a host-abandoned call aborts the mod's signal too.
`event` and `is(pattern)` report the route the adapter selected; `origin` is
`{ plugin: "engine", tier: "core" }` because every route served today is
host-raised, not mod-raised; `budget` is live, counts the hook's own work and
stands still while `next` or a `$` call is in flight (the host wraps the dollar
namespace with `pauseWhilePending`, and the kernel meter is the single
accounting path), and classic hooks keep their entry snapshot so T3 holds.
`trace` maps the kernel's own steps beneath this link onto the pinned
`TraceEntry` subset (`index`, `plugin`, `tier`, `event`, `outcome`, `reason`;
`ms`, `chunks`, `received` and `returned` are not invented). `plugin` is a host
label: the owning plugin when the registration carries one, else the
registration source. The subset is the latest trip: every link that settled
beneath the call during it (first-decision and fan-out alike), plus the
pass-over entries a `to` recorded when it was called; a second `next` starts a
new slice, so the earlier trip's steps leave. A matcher skip never ran and is
not projected (it stays in the kernel trace as `skipped-matcher`); a throwing
link is `rejected` with the throw message as the reason. `TargetTier` is
enforced: `prepend` is refused because the pin's type excludes it; `user`,
`append` and `builtin` are served when they move outward from the caller, and
`core` refuses as the declared gap above.
Covered by `packages/dsh-anyplugin-intercept/test/mods.test.mjs` (`to` skip and
forward-only, direct-target and missing-tier landings, first-decision
`next`/`to` single-run, fan-out same-tier sibling, two same-tier jumps,
repeated-`next` trips in both continuations, backward-`to` refusal,
matcher-skip exclusion, `rejected`, budget arithmetic and pause across `next`
and `$`, classic budget snapshot, timeout abort, latest-trip subset, `signal`,
tier refusal).

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
assumption; the pinned `claude-code.d.ts` (d.ts:17636-17645 at the 2.1.329 pin) now confirms them
as the first four of five tiers — the fifth, `core`, is the engine's own seat
and never a plugin's (`PluginRegisterInput.tier` excludes it, d.ts:9899 at the 2.1.329 pin).

A classic hook has no `next`, so `classicHookRegistration` always produces
`observe` mode and declares `continuation: 'fan-out'`; a caller that passes no
option still gets fan-out, and an explicit option wins. The materializer never
sorts handlers, evaluates a matcher or decides continuation itself. Its per-hook budget is the command's own timeout
plus a 5 s grace window, and the chain deadline is exactly the sum of those
budgets, so a slow handler is cut off at its own budget instead of truncating a
healthy one or stretching the turn past the declared timeouts.

**Calibrated against payloads, not prose (D15).** `fixtures/hooks/` holds the
doc-extracted payloads at 2.1.329 plus the live captures from a 2.1.322 turn;
the set and its provenance are `fixtures/hooks/PROVENANCE.md` (`payloads/` and
`observed/`).
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
3. **element runtime** — *headless sink landed* (#75): the four pinned surface
   tables, each element's keys and required members, and the pinned prop
   allowlists are enforced before a tree is recorded, and the latest validated
   tree is kept per pane. `open/close/invalidate/log/status/resolve` are served
   through it; its `ui.render` and `ui.resolve` hooks are dispatched through the
   intercept kernel's `runChain` as sink-owned synthetic events (the sink names
   them, the kernel orders them — not a second path and not a host route); and
   one `mod_ui` tool, registered only while a pane is open, reads the panes
   back. The scope is stated plainly: the host synthesizes `ui.render` only for
   `component: 'Pane'` on `surface: 'terminal'`, and only for the mod's own
   panes; the pin's `ui.open` / `ui.close` hooks (`claude-code.d.ts:8875` /
   `:8880` @ 2.1.329) are declared but not dispatched (the adapter reports them
   unmapped), and `ui.render` for the other components (`ToolUse`,
   `ContextMenu`, …) is planned. `isPlaced: false` means open but never drawn
   (a first draw that produced no tree); a later invalid redraw keeps the last
   good tree and its revision. Drawing, host-owned layout, focus routing and
   `invalidate` throttling are still ahead. Two behaviours are `derived` because
   this host has no drawing engine: the refusal sentence is ours (the pin draws
   the engine's own component instead) and an invalid redraw keeps the last
   good tree;
4. **namespace bridges** — the measured `$` surface of a real mod first:
   clock / fs / store / settings / env / session / command / telemetry (10
   namespaces, 23 call sites, #46), with `process.run` and — until a
   host merged-snapshot reader exists — `settings.read` as typed refusals (the
   six `ui.*` members the ledger calls are served by the headless sink above);
   then http / mcp / model / agent / audio / theme … from the pinned
   `claude-code.d.ts`;
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

The measurement is `scripts/mod-coverage.mjs` plus the committed
`fixtures/mods/coverage.json` (#130). The script scans the pinned
`mods/types/claude-code.d.ts` with a declaration scanner (it does not import
the declaration) and calls the host's `$` factory to enumerate the runtime
namespaces, methods and properties. Surface elements are not exposed by `$`;
they come from `elementsForSurface` / `ELEMENT_TAGS` (`ui.ts:701-719`,
`935-953`) and are table coverage — what each surface declares it can draw —
not drawing coverage. Every declared member is classified **served** (callable under
the recorded bridge configuration), **refused** (callable, but always throws a
typed `ERR_MOD_HOST_*` refusal such as `process.run` or `vcs.status`),
**absent** (no runtime member), or **wrong shape** (present with the wrong
callable/property kind, recorded as `shapeMismatches` and the detailed
`wrongShape`). The refused set depends on configuration, so the ledger records
the bridge options — an attached session, a stub command registry, and no settings
source, which is why `$.settings.read` refuses — and `--update` rejects a
runtime member the pin does not declare instead of blessing it.

The ledger covers namespaces, methods, properties, events, elements, render
sites and matcher type aliases, and asserts a partition for every
runtime-comparable category: `served + refusedOnly + absent = declared` for
namespaces, `served + refused + absent + wrongShape = declared` for methods and
properties, and `served + absent = declared` for events, elements and render
sites. A namespace is served only when at least one of its members is served;
`process` and `settings` are present with every member refused, so the 24
declared namespaces — asserted by
`packages/dsh-anyplugin-conformance/test/mod-api-ledger.test.mjs` — are
**9 served / 2 refused-only / 13 absent**. Event keys
are counted in their
`classic.<Event>` spelling — the bare `ClassicHookEvent` union is the input to
those spellings and is not counted a second time. Served events are the live
host routes; `ui.render` and `ui.resolve` are sink-owned synthetic dispatches,
not host routes, and are not counted as served here. Elements are
surface-qualified (`vscode:Svg`), so dropping one surface's entry shows up as an
absent element rather than hiding in a flattened count; the 45/45 row is table
coverage, not a claim that the host draws all 45. The host draws only one
render site — it synthesizes `ui.render` for `component: 'Pane'` on terminal —
so render sites are **1 served / 19 planned**, not 20 served. Matchers are
counted as the declaration's internal `Matcher*`/`OpenMatcher` helper aliases
and are not partitioned: there is no runtime type surface to compare.

`node scripts/mod-coverage.mjs` prints the totals, the absent and refused names
grouped by namespace, the configuration, and the partition; `--update` rewrites
the ledger, and the conformance test fails when the ledger drifts. The
`wrongShape` check compares callable versus property only: arguments, return
types, sync versus `Promise`, and behaviour are not compared. This is a
denominator, not a fidelity claim: a served name says the member is reachable,
never that it behaves like the pin.

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
| `.tsx` / JSX mods | **host landed** (D34): a `.tsx` module declaring the classic pragma (`@jsxRuntime classic`, `@jsx h`, `@jsxFrag Fragment`) loads through one narrow in-memory transform with `h`/`Fragment` as realm globals; all 21 pinned `.tsx` load (S14, 122/122). No pragma, a foreign pragma/runtime, direct `.tsx` specifiers and rendering stay unsupported/`planned` |
| Authored specifier conventions (`'./ask'`, `'./reads-as-org-tool'` for the sibling `.ts`, `'./x.js'` for `x.ts`, `'.'` self-import) | **host landed** (`dsh-anyplugin-mod-host`, #33/#58) — extensionless imports try the file form (`<spec>.ts`, `<spec>.tsx`) before the directory form (`<spec>/index.ts`, `<spec>/index.tsx`), preserving `.js`→`.ts`, `.jsx`→`.tsx` and bare/dot→`index.ts`; our host obligation, not an upstream specification; stock Node ESM refuses these shapes; resolution changes no bytes (S13, D30, D39, §7.7) |
| Cross-mod pane ownership (`$.ui.open({id})` collisions) | must be reproduced, bug reports already exist upstream |
| Version drift (`$.ui.backdrop` removed in 2.1.319; `AbovePromptList` needs 2.1.323) | pin the release; regenerate the symbol table per pin |

The commitment, stated plainly: *no release may make mods harder.* Every design
choice that would need to be undone to support mods later is a defect now.

### 7.7 S13/S14: the authored graph loads; `.tsx` needs one declared classic transform (answered 2026-11-19)

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

At the 2.1.329 pin the fetched `diff` module is a larger tree: **11 sites / 9
unique events / 25 `$.` calls / 0 dynamic** (`fixtures/mods/diff/fixture.json`,
`claude-code@2.1.329`, commit `f9e4d1e5…`). The 10/8/23 figures above are the
S13 spike's 2.1.322 measurement and stay attributed to that pin.

**Resolution changes no bytes; type stripping is an in-memory, length-preserving
transform.** The graph uses four specifier shapes, which exercise three host
resolution behaviors: extensionless paths (`'./ask'`) and `'.'` self-imports
resolve to a directory `index.ts`; `.js` specifiers resolve to `.ts` files
(`'./array-of.js'`); `.jsx` specifiers resolve to `.tsx` files. The reachable
graph exercises 737 directory-index resolutions, 246 `.js`→`.ts` and 21
`.jsx`→`.tsx` against S13's `.tsx` stubs; S14, loading the real `.tsx`
modules, counts 795 directory-index resolutions, 246 and 21 (the extra 58 are
imports inside the `.tsx` modules the stubs did not have, not new modules). No
exact-file fallback is used at this pin, and the resolver carries no other
candidate branches. The 2.1.329 pin adds a fifth shape — extensionless sibling
file imports such as `./reads-as-org-tool` — that this graph does not contain;
D39 adds it with the same file-before-directory order. These are **our host
obligation**, not an upstream specification. `module.stripTypeScriptTypes(source, { mode: 'strip' })` is the
only transform applied to `.ts`; it replaces type syntax with whitespace, so
byte length and line numbers are preserved for `.ts` (the scanner's line
numbers remain the authored ones). A `.tsx` module goes through D34's classic
transform first and then the same strip; its positions are not preserved.
The only bare specifier is
`import type { ... } from 'claude-code'`; stripping erases it and the shim is
requested **0** times in both realms. The scanner reads the authored text, so
none of this is visible to it: §7.3 item 1 is unaffected.

**The `.tsx` wall (pre-D34).** There are 21 `.tsx` modules and 21 `.jsx`
specifiers that reach them. With the resolver in place, stock loading still
stops at
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
changes, performance, or containment. D30 fixed type stripping as the only
sanctioned transform and kept `.tsx` `planned`; #45/D34 replaced that with
one declared classic-pragma transform, and the host skeleton followed in #33.

**Host landed (#33); the pinned contract (#57).** `dsh-anyplugin-mod-host`
implements this section: `loadMod({ root, entry, host, pluginRoot?,
pluginOptions? })` creates one `node:vm` context per mod, resolves the entry
and every child through the three rules, strips `.ts` in memory, links once and
evaluates once, then calls the authored `register(on, options)` and returns
its registrations in source order. `$` is never a global: the host
wraps each registration as `handler(event, next)`; immediately before every
invocation it calls `host.dollar()` exactly once and passes the result to the
authored `handler($, event, next)`. The host never caches, clones or freezes
that namespace; `ModHost.dollar()` **must return the namespace for that one
invocation**. A host that returns the same object for two calls has reused it —
a `ModHost` bug, not host-side freshness. A caught invocation calls
`host.dollar()` a second time for the catch handler, which the pin also invokes
as `($, e, next)`. Evaluation happens
before `loadMod` resolves; `evaluate()` is an idempotent accessor, so a mod
cannot evaluate twice. `dispose()` makes the realm inert. The host reads
authored bytes and never writes them (the tests assert sha256 before and after).
The package has two load-time dependencies, pinned exactly (D34:
`@babel/core` `7.29.13` and `@babel/plugin-transform-react-jsx` `7.29.7`);
`npm test` runs Node with `--experimental-vm-modules`, because D30's realm
needs `SourceTextModule`.

**The pinned `Registration` (#57).** `on(event, hook)` returns the object the
pin declares (`claude-code.d.ts` 2.1.322 line 7480): frozen, with one member,
`.catch(handler)`. A registration without `.catch` behaves exactly as before —
a throw from the authored hook rejects the wrapper and the intercept kernel
records and skips it. With `.catch`, the host catches a throw from the hook,
calls `host.dollar()` a second time for the catch handler (the pin gives it a
`$` of its own) and invokes it with `$`, the event and the pinned `N & Caught`:
`error` is frozen `HookFailure` data (`kind: 'throw'`, the authored message,
`budget` 1,000 ms — the pin's `catchMs`), `called` reports whether the hook
invoked beneath it, and `next` replays the hook's last `next` result instead
of running the hooks beneath again. The host copies the rest of the `Next`
surface (`to`, `origin`, `trace`, ...) onto that `next`. `engine.create` has no
budget at the pin, so `.catch` on it is refused at registration time, as are a
second `.catch`, a `.catch` after `register` returned, and a non-function
handler (`ERR_MOD_HOST_REGISTRATION`). The host has no per-handler timeout
budget of its own yet, so it produces only `kind: 'throw'`; a kernel timeout is
still reported as a timeout, not as a catch.

**The pinned `PluginOptions` (#57).** `PluginOptions` is
`Readonly<Record<string, string | number | boolean | readonly string[]>>`
(line 6243), built from two facts: the manifest's `userConfig` declarations and
the activation's stored values (`pluginConfigs[<plugin>].options`, passed as
`pluginOptions`). The manifest is `<pluginRoot>/.claude-plugin/plugin.json`;
without `pluginRoot`, the host proves it at `root` or at the parent of `root`
(the complete pinned plugins keep it one level above `hooks/`). Every declared
field is served with its activation value or its default, validated against the
declared `type` before the module loads: a string field's declared `options`
list turns a stored value outside it into "unset", a required field with no
value refuses the load naming the field, and a declared type outside the pinned
value union is refused instead of guessed at (`ERR_MOD_HOST_OPTIONS`). A module
whose manifest declares no `userConfig` (synthetic fixtures included) receives
an empty frozen record: nothing was declared, so nothing is fabricated. The
pinned `PluginOptions` has no plugin-root or data-dir member; those remain host
facts (`root`, and the bridge's data dir), not fields added here.

Failures are `ModHostError`s with one of six codes: `ERR_MOD_HOST_TSX` (a
`.tsx` module lacks the classic pragma or declares a foreign `@jsx`,
`@jsxRuntime` or `@jsxFrag`, or a direct `.tsx` specifier is written),
`ERR_MOD_HOST_MISSING` (the root, entry or a named module is absent),
`ERR_MOD_HOST_UNSUPPORTED_EXT` (an extension D30/D34 does not load),
`ERR_MOD_HOST_LINK` (a specifier outside the three rules, a
read/strip/syntax failure, a link-time named-import mismatch, a missing or
misused `register(on, options)`, or use after `dispose()`),
`ERR_MOD_HOST_REGISTRATION` (a `Registration` member the pin declares but this
host cannot serve: `.catch` on `engine.create`, a second or late `.catch`, or a
non-function handler; the reason names the member) and `ERR_MOD_HOST_OPTIONS`
(a `PluginOptions` field that cannot be built: a malformed `userConfig`, a
declared type outside the pinned union, a wrong activation value, or a required
field with no value; the reason names the field). Authored errors are never
wrapped: a module-level `$` remains the realm's `ReferenceError`, and a throw
from `register` keeps the mod's own stack. No `.tsx` stub, override hook or
test-only escape hatch exists. The realm is not containment (D6/D30): `on` is
a host-realm function, so authored code can reach host globals with
`on.constructor('return process')()`; the host isolates the tested global
surface, nothing more.

**`.tsx` was the wall; S14/D34 remove it.** Before #45, `loadMod` on the pinned
`diff` mod threw `ERR_MOD_HOST_TSX` naming `views/pane-view.tsx`: `register.ts`
imports `./views`, `views/index.ts` contains `export * from
'./pane-view.jsx'`, and ESM links the whole graph before any hook can fire.
S13 reached the hook only by substituting `.tsx` stubs, which D30 forbids as a
host mechanism; the refusal was the pre-#45 acceptance. S14 now transforms
every one of the 21 `.tsx` modules through D34's classic-pragma transform,
type-strips them in memory, and links/evaluates them in one `node:vm` realm
whose only additions are `h` and `Fragment`: 505 `.ts` + 21 `.tsx` modules,
**122/122 checks**, registrations equal to the scanner's 10 sites/8 events
(23 `$.` calls/0 dynamic) at 2.1.322 — 11 sites/9 unique events/25 `$` calls at
2.1.329 — and `divider()` returns the `h` descriptor. The
fetched `diff` fixture therefore loads rather than refusing, and both the host
test and the conformance test assert its registrations. The synthetic fixture
is the `$` proof: `session.start` calls
`$.session.usage → $.command.register → $.session.messages`, or
`$.session.usage → $.clock.now → $.command.register → $.session.messages` when
`usage()` returns `undefined`, then returns `next(e)`. The returned
descriptors are validated against the pinned surface tables, element keys,
required members and prop types (allowlists and literal unions) and recorded by
the headless render sink (#75) — the refusal sentence and the keep-last-tree
fallback are `derived`, since the pin draws the engine's own component instead;
drawing them is still `planned`; D34 is a load-time transform, not an element
runtime.

**`$` bridged (#46).** The pinned `diff` graph now loads *and* its
`session.start` completes through the real bridge. The measured surface is 23
`$.` call sites across 10 namespaces: clock (`now`, `after`, `every`), fs
(`stat`, `list`, `read`), store (`get`, `set`), settings (`read`), env (`get`),
session (`messages`, `id`, `usage`), command (`register`), telemetry (`mark`,
`log`), plus `process.run` and `settings.read` (until a host merged-snapshot reader
exists) as **typed refusals**. The six `ui.*` members the ledger calls —
`invalidate`, `status`, `log`, `open`, `close`, `resolve` — are served by
the headless render sink (#75): each call records a validated tree or value
and returns; nothing draws. The sink dispatches the pin's `ui.render` and
`ui.resolve` hooks through the intercept kernel's `runChain` as synthetic
events it owns (the sink names them, the kernel orders them; they are not host
routes), and it validates a submitted tree against the pinned surface tables,
element keys, required members and prop types (allowlists and literal unions).
It synthesizes `ui.render` only for `component: 'Pane'` on `surface:
'terminal'`, and only for the mod's own panes; the pin's `ui.open`/`ui.close`
hooks (`claude-code.d.ts:8875`/`:8880` @ 2.1.329) are declared but not
dispatched, and the other render components are `planned`. Its refusal sentence
and its keep-last-tree policy are
`derived`: the pin draws the engine's own component on an invalid tree, which
this host cannot do. The static conformance ledger invokes the
scanner's 23 sites in source order: 21 served sites complete, and the two
refusal sites answer `ERR_MOD_HOST_EXEC_UNSUPPORTED` (D25's pinned-artifact /
dynamic-exec rule) or `ERR_MOD_HOST_SETTINGS_UNAVAILABLE` (this host exposes
no merged settings snapshot), never `undefined`. The ledger records the argument each row used:
only `session.usage`, `clock.now`, `command.register` and `session.messages`
are reached at load with diff's own arguments; the other served rows prove
method availability with a representative argument, because diff's fs/store
calls live in hook code the load does not run (`head-key-of.ts:52` is the
documented `gitDir/HEAD` read).

The bridge is built once per loaded mod and its `$` once per handler
invocation (D31/D32), so a mod cannot observe another mod's timers, command
registrations or report-once flags. `fs` follows the pinned d.ts: a relative
path resolves against the invocation session's working directory and an
absolute path is used as written, with no plugin-data confinement — the mod
runs in the user's session, under the same permission model as the user (D25).
`store` stays rooted at `config.pluginData` (the pinned store is
plugin-scoped): a lexical `..` or absolute path outside it, and a symlink whose
real path leaves it, are `ERR_MOD_HOST_PATH_OUTSIDE`, checked on `realpath`.
`store` is a JSON file in that data dir written atomically, so it survives a
reload. `settings.read` serves a host merged snapshot only when the host
supplies one; otherwise it is `ERR_MOD_HOST_SETTINGS_UNAVAILABLE`, never a
plugin-data file pretending to be settings. `env` reads the host environment
the materializer already builds (including the `CLAUDE_*`/`PLUGIN_*` names).

`session.messages()` is the agent's derived message list at that moment (`[]`
before the first turn is correct, and asserted). Tool results use the pinned
`SessionMessage` shape: a DSH `role: 'tool'` message becomes a user message
whose `toolResults` array carries the result, and the matching assistant
`toolUses` entry carries the observed `text`/`isError`; the host appends the
result after `tools/post-execute`, so PostToolUse sees the call without the
result and Stop sees the completed carrier. `session.usage()` emits
`context.tokens/window/percent` only when the session logged a window and all
three token counts, never a zeroed or partial block; `startedAt` comes from the
header and each missing field is reported once per load. `command.register`
reaches the host's real `ctx.commands` registry when the host context has one,
is disposed with the mod, and a duplicate names the colliding mod as
`ERR_MOD_HOST_COMMAND_DUPLICATE`; with no registry it refuses
`ERR_MOD_HOST_COMMAND_UNAVAILABLE` immediately rather than waiting for a
service that may never mount.

On a **fresh** load diff's `session.start` asks `$` for exactly four sites, in
this order: `session.usage` (there is no session yet, so the view is empty and
`startedAt` is absent), `clock.now` (the authored fallback), `command.register`
(`/diff`), and `session.messages` (the restore view, empty). It then returns
`next(e)`. A reload with a live root supplies `startedAt` from that session's
header, so the authored clock fallback is skipped: three calls,
`session.usage → command.register → session.messages`, against the live view.
The other scanned sites are declared capabilities that load does not reach —
`ui.render` is where `ui.*` and the `.tsx` descriptors are used: the pane's
tree is validated and recorded by the headless sink (#75), while drawing
remains `planned`. The conformance test asserts both the static
ledger and the ordered dynamic sequence against the fetched graph, and the
synthetic fixture asserts the ordered `ran` / `refused:<code>` ledger for
every row.

### 7.8 Packaging: the kernel ships inside the bundle (0.2.0)

The kernel is not a separate npm package; it is bundled into
`lib/materialize/hook.js`, the entry a hook row names. `scripts/build.mjs`
keeps `@babel/core` and `@babel/plugin-transform-react-jsx` external, so the
one classic-pragma transform (`D34`) resolves from the installed package's own
`dependencies`; every `@deepseek-ai/*` import stays external because the
harness provides it. The build records the kernel's share of the bundle in
`lib/kernel-size.json` (`bytesInOutput` for inputs under
`packages/dsh-anyplugin-mod-host/`) plus the entry's external imports (the
two Babel packages, never a copy), and `check:pack` asserts the exact runtime
dependency set, bounds the byte cost by the entry's own size and a named
ceiling, and refuses a tarball whose hook entry still contains the 0.1 stub's
refusal. The packaged README is also checked for the runtime flag below.

The kernel needs Node's `--experimental-vm-modules`: `node:vm` exposes
`SourceTextModule` only behind it (D30), and the Desktop's bundled Node starts
without the flag — the CLI form is `node --experimental-vm-modules …`, the
Desktop form is an inherited `NODE_OPTIONS=--experimental-vm-modules` in the
launch environment. The packaged docs therefore state the requirement, the
materializer says it once per process (not once per mod) and refuses each mod
into the trace when the flag is missing, and `check:pack` fails a tarball whose
README does not name it. Classic hooks still run in that state.

Using the existing hook entry rather than a new subpath **amends D43's
"mods need their own entry" consequence**: the entry a hook row already names
is where the kernel lands, so 0.2.0 adds no published subpath. A mod reaches
that row as data: the lock carries `mods` (§5, `dsh-anyplugin/installs@2`), the
compiler emits one entry per granted module tree, and reconcile passes it to the
materializer. Before `loadMod` the materializer re-lists the plugin tree and
refuses a tree whose file set or bytes moved since the grant; the scan returns
the bytes it hashed, and the loader and linker compile *that map*, never the
path, so the window between the gate and the load is closed rather than
narrowed (a tree over 64 MiB is refused with the same typed reason). The same
map bounds the linker, so a module that imports a file outside the manifest is
refused with `ERR_MOD_HOST_UNGRANTED` instead of evaluated. The grant bounds
**what the loader may evaluate**, not what a running mod may read: `$.fs.read`
still serves any path the process can read, including absolute paths, `../`
escapes and symlinks outside the plugin tree (`bridge.test.mjs` pins the
bridge's pass-through behaviour), so a granted mod can read outside its tree.
Read confinement is a separate capability: a named future decision (proposed
here as D53, `$.fs` read confinement) must define it; D52 does not claim it. A
hand-written `mods` entry without a pin is refused, never loaded (`D25`, fail
closed). A `mods` entry the lock does not record is refused the same way
(`not-recorded`): a grant alone does not boot a tree, and a `@1` lock boots
nothing until it is reinstalled as `@2`. That refusal
is a byte check, not a consent check: a hand-edited row that recomputes a
consistent pin is indistinguishable from the controller's, so the consent
boundary stays the grant store plus the lock's granted record; do not hand-edit
a hook row to add mods. A real
`npm install` of the tarball pulls the two declared Babel packages — 60
packages / ~35 MB for a tarball of about 99 KiB — while the smoke links the
checkout's copies and proves only that the packaged entry imports the declared
packages.

`scripts/smoke-install.mjs` boots the packed tarball (not the checkout)
against the pinned harness: it loads the pinned upstream `sec-default` (45
registrations) and the repository's mod fixtures, and observes a registration
count per mod, a `$` round-trip through the headless bridge, a `classic.*`
handler next to a classic hook in the same turn, and a mod deny at
`tools/pre-execute`, and a classic-pragma `.tsx` module through the Babel
path. The lock's `mods` paragraph is the install path for mods; the row-level
`mods` config remains the seam, but only reconcile writes it from a granted
record, and the materializer refuses any entry the record did not pin.

## 8. Seam capability matrix (P4)

Materializers probe before they plan. Missing seam ⇒ degrade with a diagnostic,
never assume. On a stock build several seams are absent (this machine lacks
`dsh-hooks-claude-code` and `dsh-lsp-stdio`), so the compatibility layer must
run degraded *by design*.

| Seam | Probe | If absent |
| --- | --- | --- |
| skill registry + filesystem provider | package present | commands-only fallback, `equivalent` |
| command registry (alias support) | accepts `alias` | drop alias, `equivalent` + UI note |
| hook interception (per event) | S9 confirms 9 listener seams: `agent/pre-step`, `agent/created`/`disposed`, `agent/turn-stopping`, `approval/request`, `tools/post-execute` (failure filter), `subagent/start`/`end`, `fs/observed`; 5 notification-only seams: durable records `compaction/start`/`end`, `approval/decided`, `working-directory/change`, plus the `settings/document-updated` emit. S8 wires `tools/pre-execute` and `tools/post-execute`; the S9 lifecycle ticket wires `agent/created` (SessionStart), `agent/turn-stopping` (Stop), `agent/disposed` (SessionEnd), `subagent/start` and `subagent/end` (SubagentStart/Stop). The seams ticket wires the remaining four listener seams — `agent/pre-step` (UserPromptSubmit, step 1 and the newest user-source message), `approval/request` (PermissionRequest, report-only), the failure slice of `tools/post-execute` (PostToolUseFailure) and `fs/observed` (FileChanged, mutation tools only) — and the five notification records as payload-only occurrences: `compaction/start`/`end` (PreCompact/PostCompact), `approval/decided` (PermissionDenied), `working-directory/change` (CwdChanged) and `settings/document-updated` (ConfigChange, revision 0 on the first read). Every one is proved by a line its handler wrote on one real headless turn (`claude-hooks-seams`, §10 S9 oracle). The mounts translate every hook into a `classicHookRegistration` and call the intercept kernel's `runChain` with fan-out continuation, so tier order, matcher skips and decision aggregation are the kernel's; the materializer keeps only the artifact re-hash, the spawn and the D20 verdict translation. Six events are unprobed, ten refuted (§10 S9); `agent/request` is deprecated and refuted for model switch | event `unsupported` **with reason**, visible in report |
| MCP client | package present | whole `mcp` node unsupported |
| subagent catalog | no catalog API at 0.2.2-rc.5 (S10); `dsh-tool-subagent` is one fixed tool per provider instance. A plugin can still register one tool per agent, scoped `<plugin>:<agent>` (Claude's Task convention) with the frontmatter description byte for byte, whose body is the first block of the child user message | catalog `exact`, invocation `equivalent`, per-key faces per §10 S16 (`skills` `equivalent` when the plugin ships a non-empty body, `isolation` `planned`, the rest `unsupported`); a late `ctx.tools` is awaited with a recorded warning, and without `ctx.subagents` the catalog registers but invocation names the missing seam (§10 S10) |
| per-plugin system-prompt section | reachable through the agent context: a command handler's `invocation.agent.ctx.systemPrompt.section({complete:true})` replaces that agent's prompt byte for byte; `createAgent(..., {setup})`, `agent/created`, `dsh-persona` and an agent preset reach the same scope (S11). The entry's own `apply(ctx)` is global and is not the seam. | output styles are carried byte for byte in the IR (`IrOutputStyle.body`) and applied at `agent/created` on the agent's own context (activation face `equivalent`), but the row stays `planned` overall because the `/<plugin>:<name>` command half still needs D10's alias; selection is explicit (profile record or `force-for-plugin`), never a global injection, and `keep-coding-instructions: false` is the only case that uses `complete: true` |
| shell env PATH | managed-env `register()` accepts a `PATH` key (S19: it does not) | `bin` planned: no managed-env contribution; only a divergent per-call `tools/pre-execute` rewrite |
| notification channel | present | `monitor` unsupported |
| theme `ctx.theme` | present | `theme` unsupported (F2) |
| dynamic package runner | present | `planned`/`mod` unavailable as well |

### The repository guard: a consumer of the two seams

The repository runs a first-party policy on itself (`packages/dsh-anyplugin-guard`,
issue #80). It is a plugin like any other — one package, `inject: ['tools']`, one
handler per seam, mounted at the app level and on each `agent.ctx` — and it
deliberately does **not** introduce a second event path (§3.6). The app-level
listener is the authoritative one: the loops dispatch both seams through the
agent's scope carrier (`dsh-agent/lib/index.js:385-386`,
`dsh-agent-loop/lib/index.js:551`), and the harness delivers those dispatches
to an app-level listener as well as to the agent's own scope. The per-agent
seat is therefore additive, never a replacement: it mounts only
`agent/pre-step`, so a child still receives the brief even if one delivery
path changes; a missing seat cannot make the `tools/pre-execute` judgment
silently disappear. It reads the same payloads the hook materializer reads and
returns the host's own verdict shape.

| seam | payload read at pin `0.2.2-rc.5` | what the guard does |
| --- | --- | --- |
| `tools/pre-execute` (waterfall, S8) | `{name, arguments, callId, agent, …}` | judges the call; `{kind: 'deny', reason}` ends the waterfall, otherwise `next()` |
| `agent/pre-step` (waterfall, S9) | `{messages, turn, step, agent}` | on a spawned worker's first step, appends one user message to the continuation the host returned |

The core rules, each with a positive and a near-miss case in the dry-run table:
a push is accepted only as `git push [-u|--force-with-lease] origin <one
refspec that is not main>`, so a destination of `main`/`master`, **every bare
`git push`**, a wildcard or range refspec, and `--receive-pack`/`--exec` are
refused (`remote.<name>.push` and `push.default` can retarget a bare push after
it was read); `gh pr merge` from a worker only (the root may merge); writes
outside the worker's recorded worktree, with the main checkout always
protected; and `docs/DECISIONS.md` / `docs/decisions.lock.json` through
anything but the sanctioned `node scripts/check-decisions.mjs --update`.
"Recorded" is the operative word: the worktree comes from an explicit path in
the spawn prompt or from a cwd that is itself a configured worktree. A branch
name in the prompt (the review prompt names the branch under review) never
implies a path; with no recorded worktree a worker's writes are refused rather
than checked against every configured worktree. The policy is a
**convention checker for honest mistakes, not a containment boundary**: the
real boundary is branch protection, the DSH file sandbox and CI.

The **tool layer is what sees a tool call**. A push is judged by shape,
not by a list of forbidden spellings: the only accepted form is
`git push [-u|--force-with-lease] origin <one refspec that is not main>`; a
force update of a ticket branch is ordinary work after a rebase, a force update
of main is not. A bare push, a second refspec, a wildcard or range refspec,
another remote, `--receive-pack`/`--exec`, `send-pack`, `update-ref` and any
config that can rewrite the shape are refused with their own rule
(`git-push-shape`, `git-push-bare`, `git-push-exec`, `git-push-plumbing`,
`git-config-write`). Config keys are an **inert allowlist, not a
denylist of names we happen to know**: workers may pass `-c`/`--config-env`
only for `user.name`, `user.email`, `user.signingkey`, `color.*`,
`core.quotepath`, `core.autocrlf`, `core.filemode`, `core.symlinks`,
`core.ignorecase`, `diff.noprefix`, `diff.mnemonicPrefix`, `diff.renames`,
`diff.context`, `diff.algorithm`, `diff.wsErrorHighlight` and
`i18n.commitEncoding`, and may read config (`--get`, `--get-all`,
`--get-regexp`, `--list`); they may not write config. The root uses the same
allowlist for `-c` and `git config` writes. Everything else is
`git-config-write`, lowercased before comparison so `Alias.p` is the same
key. The reason is that "does this key run a program" is not decidable by
name: `diff.<driver>.command`, `diff.<driver>.textconv`,
`merge.<driver>.driver`, `credential.<url>.helper` and
`remote.<name>.uploadpack` all execute something, and git keeps adding
drivers; an open "non-exec" set would be a promise we cannot keep. For a
worker, any leading `VAR=value` on a git segment is refused
(`git-env-prefix`), and unknown git subcommands are refused too (`git p`),
with a reason that names the alias hazard. The shell reader defaults to deny on syntax it cannot
model — grouping, a background `&`, command substitution, backticks,
here-strings, process substitution, `eval`/`source`/dot, `find -exec`, a shell
reading stdin, unknown commands, unquoted `$` expansion — and refuses a
worker's interpreter `-c`/`-e` payload that looks like a write
(`writeFileSync`, `renameSync`, `copyFileSync`, `cpSync`, `linkSync`, `symlinkSync`,
`truncateSync`, Python/Ruby/PHP equivalents) or contains a literal process-spawn
token (`exec`, `popen`, `spawn`, `system`, `subprocess`; `interpreter-exec`).
String literals are masked before the match, so `node -e 'console.log("exec(")'`
is ordinary code, not a spawn; a call written outside the quotes is still denied.
A worker may not run a **shell** script file either (`shell-script-unverified`):
the bytes are writable and the reader does not read them, so the script could be
rewritten to push main between the check and the run. Symlinks are resolved
before confinement. A worker cannot write inside `.git` through a modelled
write — shell redirects and write verbs, structured `write`/`edit`/`apply_patch`,
interpreter mutation literals (`interpreter-write`) and `tar -C <dir>` or GNU's
attached `tar -C<dir>` extraction (`git-dir-write`): appending a diff driver, a
filter or a hook to `.git/config` would run on the next git command, which no
command-line key check can see. `sudo` is refused for workers when it is the
command that runs, after the launchers we model (`env`, `command`, `exec`,
`nice`, `timeout`, `xargs`) and leading assignments: it is not parsed, and on a
host with passwordless sudo it would be root. The shell subset is deliberately narrow and is stated in the
brief: one command list per call; `&&`, `||`, `|` and redirections
(including `2>&1`) are modelled, everything else is refused.

The `$` rule is per quoting context, because the tokenizer alone loses it:

| form | example | verdict |
| --- | --- | --- |
| inside single quotes | `awk '{print $1}'`, `echo '$HOME'` | literal, allowed |
| `$` that cannot start an expansion | `cost$`, `$` before `/` or punctuation | literal, allowed |
| inside double quotes | `echo "$HOME"` | expansion, refused |
| `$` + name/digit/special | `$1`, `${HOME}`, `$?` | expansion, refused |
| `$(` / `$'` / backtick | `echo $(date)` | refused (`shell-unmodelled`) |

Because a shell layer can always be spelled around, `guard:install` also writes
a real git `pre-push` hook into the checkout's hooks directory, **as defence in
depth, not as the authority**: git resolves the refspec itself, the hook runs
after refs are discovered and before objects are sent, and a caller who passes
`--no-verify` skips it by design. The hook is what stops a push that reaches
git without passing through `tools/pre-execute`; the tool layer is what sees a
tool call. `guard:status` checks the hook (including the no-worktree case,
which reports the hook path instead of claiming a vacuous `current`) and
`--uninstall` removes it. Installation is transactional across the two writes:
a failed profile write restores the hook to its prior bytes, and a read-only
profile leaves both the hook and the block untouched. `core.hooksPath` is
followed by git, not overridden: install names the shadow path and `guard:status`
reports it, and the docs say that deleting that config orphans the installed
hook.

The guard is a **conventional-deterrent at the tool layer plus a pre-push hook
as defence in depth**. It is not containment. The authority over `main` is the
server: branch protection with `enforce_admins: true`, required `verify`, linear
history, no force-push and no deletion. A worker that evades the guard still
cannot push `main` to this repository; it can only fabricate a local branch and
open a PR, which is the workflow we want anyway. What the guard buys is that the
*accident* — the mistyped refspec, the copy-pasted force push, the rushed
`git config` — is caught at the call, before the network.

The residual holes are named rather than papered over: worker interpreter
payloads (only literal spawn spellings — including `exec` and `popen` — are
denied, and quoted spans are masked rather than analysed, so a spelling built at
runtime, or hidden behind `eval` of a string, remains possible),
`node scripts/*.mjs` and `npm run *` (both editable, so unverified), a
`--no-verify` inside a command the reader did not model, non-git file writes
from allowed tools, a root-run shell script, a root-written exec key that a host
later runs, config already present in the repository or written by a process
outside the guard (the guard models the tool call, not the filesystem),
`sudo` on a host where it succeeds without a password, a launcher spelling the
command-position skipper does not model, and any git feature outside the
modelled subcommands. The guard decision is recorded on merge; this
paragraph is its framing, not a second decision. Branch protection, the DSH
file sandbox and CI are the boundary.

The SubagentStart brief has no seam of its own: `subagent/start` is an emit with
no value channel, and `SubagentStartRequest` has no instructions field at this
pin (§10 S10). The only place text can reach the child before its first model
step is the `agent/pre-step` continuation, so the brief is appended there,
after `next()`, so the agent loop's own runtime-context section survives. The
message is built like the host's `createUserMessage` — a UUID `id` and
`source: {kind: 'user'}`. That shape is load-bearing: the loop reads
`message.source.kind` on every appended message (`dsh-agent-loop/lib/index.js:873`),
and `runtime-context` is the snapshot kind, not a prompt kind. It is context —
the worktree path, the coverage ratchet totals, the open rows and the shell
subset the policy accepts — not a file the worker is told to read.

Installation is data: `npm run guard:install` appends one marked block to the
profile's `cordis.patch.yml` containing a single `insert` entry whose `name`
is the absolute source path (the profile loader anchors inserted names). A patch
without `insert` only overrides an existing entry id, so the insert form is the
one that can add the plugin. The block records the file's pre-install state
(absent, empty, `[]`, or content), so `--uninstall` restores absence as absence
and emptiness as emptiness instead of leaving `[]` behind; a user row inside
the marked block, a duplicate id in either YAML quote style, and an unbalanced
marker are refused rather than silently rewritten. `--dry-run` composes the
same block, prints it and runs the payload→verdict table through the same judge,
writing nothing; `guard:status` re-composes and compares (ignoring the state
line), so a stale block is visible without loading the profile.

The installer's target checkout is the caller's, not the script's: `--worktree`
if given, else the git top level of the cwd, else the checkout the script lives
in. A linked worktree shares its hooks directory with the main checkout, so a
real install from one is refused before anything is written (the message names
the checkout); `--dry-run` still works because it writes nothing. This is what
keeps a review worktree from installing a hook into the checkout it is
reviewing.

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
       per plugin: resolve dialect (reader + pin) → read → gate(ir, grants)
                 → authorize + attach artifact
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

The lifecycle CLI (`rig install|list|enable|disable|uninstall`, plus
`rig marketplace list|install` over a local catalog) is a caller of
this pipeline, not a second implementation. `install` reads the plugin, builds
the record, and hands the complete lock to `writeInstalls`; `enable`/`disable`
hand one layer to `writeEnablements`. Both writers validate first and replace
by temp file + rename, so a typed refusal leaves the previous bytes untouched.
`list` re-runs `prepareInstalledRecord` + `buildTransplantReport` per record,
which is why its carry counts are the same rows `rig report` prints rather than
a second counter. Reporting needs the ungated IR: `PreparedRecord` keeps both
`ir` (gated, for emit) and `ungated` (for the report, which gates itself),
because gating an already-gated IR would turn every refusal into a skipped row.
`uninstall` removes the record and compares the desired entry tree before and
after; with no installed record the tree is empty, so the next reconcile removes
the group. Enablement and grants are deliberately not deleted: they are
workspace policy, and a reinstall picks them up again.

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
  back. `npm test` re-probes both sides; `coverage.test.mjs` owns the burn-down
  row totals and is the only place that asserts them. Both halves also
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
neither source a local run skips with a reason; under CI that is an error. Every
golden is therefore re-probed by CI, so the inventory gate does not
depend on the laptop.

What the rig already reports, at the pin it was captured on, is in §10.3.

### 10.3 What the first pin says (claude-code 2.1.322)

Every fixture with a golden is re-probed and re-verified on every `npm test`.
Two observations
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

Two dialects feed that pipeline. `.claude-plugin/plugin.json` selects
`dsh-anyplugin-dialect-claude-code`; any root `plugin.json` (the portable
layout, whose `$schema` must be
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`), or a
`.codex-plugin/plugin.json` when there is no Claude manifest, selects
`dsh-anyplugin-dialect-codex`. Both return the same `ClaudePluginIr`; the rig's
`report`, `grant` and `revoke` commands use the same detection, so a Codex
plugin is not silently read as a Claude one. The install compiler
(`packages/dsh-anyplugin-install/src/compile.ts`) resolves a lock row's
`dialect` through the same two-entry registry, and each row owns the pin the
reader stamps and the compiler checks (`claude-code@2.1.329`,
`agent-plugins@1.0.0`). Identity, gating and emission stay dialect-agnostic:
the registry decides which reader runs, and nothing after it branches on the
dialect. `packages/dsh-anyplugin-conformance/test/codex-e2e.test.mjs` compiles
the portable fixture through `compileEntries` and boots the result in the same
`probeWithDsh` oracle. The Codex fixture's golden is
**hand-authored** from the 1.0.0 schemas and the Codex hook documentation —
there is no offline `codex plugin details` to capture from — so it is excluded
from the upstream-observed totals below and carries that provenance in its
`notes`. Portable 1.0.0 discovers skills only under `skills/`; the root
`SKILL.md` this dialect still reads is a ticket/Claude-layout compatibility
extra, not portable evidence.

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

Coverage is owned by `coverage.test.mjs`: `EXPECTED_ROWS` pins the exact row set
per fixture and the closing `assert.deepEqual(totals, …)` pins the total the
project reports. CI measures the same rows against both `0.2.2-rc.5` and
`0.2.2-rc.2`; a skipped row is a failed job there. Most fixtures boot the loader
with `probeWithDsh`. Two have no registry face at all:
`claude-hooks-lifecycle` boots a real turn graph with `probeLifecycleWithDsh`,
and `claude-hooks-seams` boots the full approval/filesystem/settings/compaction
stack from `test/lifecycle.test.mjs` (§10 S9), because their rows exist only as
lines the handlers wrote. The turn graph is part of the fetched
union (`HARNESS_PACKAGES` in `scripts/fetch-harness.mjs`), so one fetch is
enough before `verify`; CI fetches each pin once and installs nothing else.

`EXPECTED_ROWS` is the authoritative row list. The table below is not a
scoreboard: it explains what the non-obvious rows require, and deliberately
carries none of the numbers the test asserts.

| Fixture | What its row needs |
| --- | --- |
| `claude-skills-only` | — |
| `claude-root-skill` | — |
| `claude-command-nested` | — (host loads nothing; we emit nothing) |
| `claude-commands-flat` | model face done; human face needs the two seams in D10 |
| `claude-agents` | one tool per agent; description byte for byte, body as the first user block (S10; invocation `equivalent`) |
| `claude-hooks-mcp` | hook mounted on `tools/post-execute` and observed on a real call (D20) |
| `claude-hooks-lifecycle` | the lifecycle handlers ran on one real headless turn (root start/stop/end + one child); SessionStart/Stop/SessionEnd root-only, SubagentStart/Stop child-only (§10 S9) |
| `claude-hooks-seams` | the listener seams and notification records ran on one real turn: one prompt line per prompt (not per step), one PermissionRequest (matcher), one failure (a denied call is excluded), one FileChanged (the read is filtered out), compaction start before end, one denial, one cwd change, settings revision 0 then 1 (§10 S9) |
| `claude-mcp-http` | streamable-http arm; the server is started by the test (D12) |
| `claude-mcp-tool-budget` | one fitting tool registers, one over-budget tool is skipped |
| `claude-mcp-budget` | prefix alone is 66 characters; refused at plan time (D11) |

The Codex fixture is not in that matrix because its golden is a declaration,
not an upstream observation; its rows are asserted in
`packages/dsh-anyplugin-conformance/test/codex.test.mjs`, and the install path
is asserted end to end in
`packages/dsh-anyplugin-conformance/test/codex-e2e.test.mjs`. Adding them to the
Claude totals would make a hand-authored surface look observed.

`claude-commands-flat` moved on its **model face alone**. A command
is one artifact with two observable faces — the catalog entry the model sees,
and the `/plugin:name args` typing surface — so its IR node carries
`faces.model` / `faces.human`; the count moves on the model face, while the
component's overall fidelity stays `planned` (D10). Reporting the model-face
matches without that distinction would claim a win that a user still cannot
type.

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
components above them. It does not consult `installs.yml` (the controller does,
at boot), so its output is labelled `preview only` and `not-recorded` is not
enforced there. The report is a reader, not a second fidelity claim: the
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
agents + theme. `bin/` is a `planned` annotation row (S19), not a fixture.

### 10.5 S15 result: what the five pinned mods demand on one real turn

**Question.** Which events and which `$` members do the five upstream mods
actually use, and which of those does the host serve? Measured first at
`6e1e44f6433bfa17d198e932bff53373aa229eea` (claude-code `2.1.322`) and re-run
at `f9e4d1e5753ccffcffdd832f047d72be000396a6` (claude-code `2.1.329`; the seven-mod table in
`fixtures/mods/upstream.json` adds two mods at that pin, but S15 keeps the
original five so the comparison is like for like). The S9 turn is the vehicle: the stub `LlmAdapter` (no network,
no key), one real `Bash` call, one real fork subagent, one `session.start` per
plugin load.

**Method.** Five materializer children (one plugin root each), the real
`loadMod`, the real `createModBridge` table, the real materializer and kernel.
The recording `$` is a `Proxy` over the table the real `dollar()` returns,
installed once around the real factory; a second wrapper attributes each call
to the authored handler through `AsyncLocalStorage`. Only the materializer's two
package imports are redirected, to shims that re-export the real modules. No
namespace is reimplemented, no event or decision is altered, and no second
dispatcher is added (AGENTS §3.6). Argument and payload **key names** are
recorded; values are not. `spikes/s15-mod-demand/REPORT.md` carries the tables,
the sites and the command.

**Outcome at 2.1.322 (baseline).** 11 handler invocations and 5 `$` calls
on the turn. The `$` surface authored by all five mods is 50 call sites across
27 `namespace.method` pairs in 10 namespaces: **16 served**, **8 typed
refusals** (all six `ui.*` methods, `process.run`, `settings.read`) and **3
absent** (`session.identity`, `session.root`, `fs.ancestors`). The event surface
is the larger gap: only `session.start` and the 16 classic routes are live at this baseline, so
four events authored by **two of the five mods each** — `tool.check`,
`tool.call`, `prompt.context`, `agent.spawn` — never reach a handler; eight of
the 16 classic events were not exercised by this turn. The load-time
`session.start` has no session: `usage()`/`messages()` return empty shapes and
`session.id()` would refuse `ERR_MOD_HOST_SESSION_UNAVAILABLE`.

**Outcome at 2.1.329 (current pin).** All five seat after the D39 resolver fallback: `sec-default` loads with 45 registrations (its `./reads-as-org-tool` sibling-file import is now served), so the turn has **17 handler invocations**, **22 `$` calls**, and **0 handler errors** (the same counts at DSH `0.2.2-rc.5` and `0.2.2-rc.2`); its `classic.*` guard runs on all eight routed classic events, with `next.to` served by the kernel's own continuation (#68). The authored demand rises to **69 call sites / 30 `namespace.method` pairs / 11 namespaces**: with the headless render sink (#75) **24 served**, **3 typed refusals**, **3 absent**. The six `ui.*` members are served by the sink (trees validated against the pinned surface tables, latest revision recorded, nothing drawn; `ui.render`/`ui.resolve` hooks ride `runChain` as sink-dispatched synthetic events, not host routes); the refusals are `process.run`, `settings.read` and `ui.ask` (declared at `claude-code.d.ts:2856 @ 2.1.329`, but it answers through a person); the absent members are `session.identity`, `session.root` and `fs.ancestors`. `vcs.detect`/`vcs.diff` (cited at `mods/diff/hooks/register.ts:962-963`) are served read-only for git by the bridge (#119); `vcs.isolate`/`vcs.list`/`vcs.status`/`vcs.release` are typed refusals (`ERR_MOD_HOST_VCS_UNSUPPORTED`), because DSH fires no vcs event and the host makes no copy.

**Host bug found, now fixed (#68).** `next.to`, declared by the pin
(2.1.322 pin: `Next` at `claude-code.d.ts:5271-5352`, `GlobNext` at `:4236`; 2.1.329 pin: `Next` at `8289-8367` with `to` at
`8306`, `GlobNext` at `6660-6685` with `to` at `6666`) and claimed by the
host's `copyNextSurface`
(`dsh-anyplugin-mod-host/src/index.ts:214`), was absent from the mod-visible
continuation: the kernel's `Next` had no `to`; `runModHandler` built a fresh
bare function. `sec-default`'s `classic.*` handler therefore threw
`TypeError: next.to is not a function` on all eight routed classic events, and
the kernel recorded `error` and continued — the `undefined` D36 forbids.

The member is now served by the kernel's own continuation (tier order, matcher
skipping and trace stay in one place), and a tier jump records every link it
passes as `skipped` with `bypassed by <plugin>`. The measured turn is
reproduced in `packages/dsh-anyplugin-conformance/test/mods.test.mjs`: with
sec-default seated at `prepend`, a user-tier classic deny hook is skipped
(`PreToolUse#0`, `bypassed by sec-default`), the chain decision is
`continue`, and the tool call executes; with the mod unloaded, that hook runs
and denies the call. The member semantics are pinned in
`packages/dsh-anyplugin-intercept/test/mods.test.mjs`, and the deny/unloaded
contrast for a mod that actually denies a tool is
`packages/dsh-anyplugin-mod-host/test/kernel-bridge.test.mjs` (fixture
`fixtures/mods/guard/`).

Pin correction carried by the fix: sec-default's `classic.*` guard
(`mods/sec-default/hooks/register.ts:30`) is `next.to(e, 'append')` — it
bypasses the `user` tier so org policy keeps user-installed hooks out. It does
not deny a tool call; its deny paths ride unmapped engine events. The
issue's "a tool call it should block is blocked" is therefore the wrong
direction for this mod; the guard assertion is the bypass above, and the direct
deny/unloaded contrast uses the synthetic guard fixture.

The first implementation of the member had the projection right but five
continuation rules wrong, found in review and now pinned by tests: a
first-decision continuation was re-entered after `next`/`next.to` (links ran
twice), the pass-over was computed by index rather than tier rank (a same-tier
sibling was labelled skipped), a matcher skip was projected without a reason, a
throwing link was reported as `skipped` instead of `rejected`, and the per-hook
timer kept running while `next` was in flight. A second review round found four
more, all now fixed and named in the unit tests: a deferred jump to a direct
target returned the following link instead of the target (and a named tier with
no link left dropped the rest of the chain — it now falls forward), a second
`next` silently returned the first result instead of starting the latest call
(it is now refused by name), the budget reported the entry snapshot after the
hook's own work (the kernel meter is now the single accounting path, so own
work counts and `next`/`$` still pause), and `next.to` accepted a target tier
that had already run (a backwards jump is now refused with the direction and
the pin's line). `next.budget` now pauses during `next` and `$` (the host wraps
the dollar namespace with `pauseWhilePending`), while classic hooks keep their
entry snapshot so T3 holds; `next.signal` is linked to `ChainOptions.signal`,
and the materializer passes `ToolExecution.signal` for
PreToolUse/PostToolUse, so a host-abandoned call aborts the mod's signal too.
The `next.trace` subset is continuation-specific: first-decision sees the
settled links beneath the call, fan-out is empty after `await next(e)` and holds
the pass-over after `next.to` — the tests named above pin that shape.

**What it does not prove.** One turn, one stub model: eight routed classic
events (failure, permission, compaction, cwd, file, config) are unexercised;
only literal scanner sites are counted; no values or return shapes are claimed;
the real-install caveat is the five-plugin/five-materializer shape (one
`pluginRoot` per `apply`), and at 2.1.329 all five seat after the D39 resolver fallback. S15
does not measure `easel` or `hipaa-default`; their registrations are recorded
in `fixtures/mods/upstream.json`. It does not settle the other `$` methods or
the unmapped engine events beyond the sites measured here.

### S16 — agent frontmatter faces

**Question.** S10 answered the catalog question: one model-facing tool per
persona, `<plugin>:<agent>`, body as the child's first user block. S16 asks the
remaining one per *face*. The host exposes exactly one per-activation seam,
`ctx.subagents.startActivation`; does it carry the key, and — the only part that
counts — does the child observe the effect? A value present in our own emitted
config is not evidence.

**Method.** `spikes/s16-agent-faces/run.mjs` boots the pinned `0.2.2-rc.5`
harness (real agent loop, subagent runtime, fork provider; a recording
`LlmAdapter`, so no network and no key) and runs three activations against a
child-side observation: every frontmatter key passed as an unknown top-level
field, the `agentOptions` escape, and `maxTurns: 1` against a child that keeps
calling a tool. What is read is the child's first model request, its session
header's `cwd`, and the number of requests it made. The source check parses
`SubagentStartRequest` and requires its exact nine fields, so a regex that
cannot match is red rather than vacuously green. The spike reports **10/10**
checks and writes `spikes/s16-agent-faces/out/report.json`; reverting the
source-check regex to its first (non-matching) form reports **9/10** with that
check `FAIL`. Claude's documented semantics are read from the pinned client at
`2.1.329` (https://code.claude.com/docs/en/sub-agents.md), not inferred from
this layer. `packages/dsh-anyplugin-conformance/test/agent-faces.test.mjs`
repeats the observable faces through the materializer's public tool:
`probeAgentInvocationWithDsh` (`packages/dsh-anyplugin-conformance/src/oracles/dsh.ts`)
boots the pinned harness, invokes `<plugin>:<agent>` through `ctx.tools.execute`,
and returns the request the child actually sent. Two checks are CI-gated from
the child's side: the `skills` preload (the whole first user message is
compared, persona and task included, and the envelope is rendered by the pinned
host `renderSkillContent`, so a divergence or an inserted block reddens) and
`maxTurns: 1` with a two-tool-call loop, which observes three child requests
and `stopReason: 'completed'`.

| face | state | evidence (test + observation) | reason |
| --- | --- | --- | --- |
| `model` | `unsupported` | S16 A: a top-level `model: sonnet` is accepted and ignored — the child request model is `fake-1`. S16 B: `agentOptions.model: 'sonnet'` reaches the provider as the **raw id** `sonnet`, with no alias resolution. `agent-faces.test.mjs` asserts the annotation. | A Claude alias names no provider model id, and DSH providers take ids, not aliases. Translating `sonnet` would guess a model the host does not serve. The escape layer (`docs/TODO.md`, "Escape layer"; delegate to the real client) is the only path. |
| `effort` | `unsupported` | S16 A: top-level `effort: high` → no `reasoningEffort` on the child request. S16 B: `agentOptions.reasoningEffort: 'high'` passes only because the recording adapter advertises `high`; without advertising it the child turn dies `UNSUPPORTED_REASONING_EFFORT`. | The id space belongs to the provider (`LlmModelReasoningInfo.efforts`), not to Claude; there is no provider-neutral spelling, so any mapping would be a guess. Escape layer only. |
| `tools` / `disallowedTools` | `unsupported` | S16 A: a child declared `tools: [Read, Grep]` and `disallowedTools: [Bash]` still sees `echo` in its request. | `SubagentStartRequest` has no tool filter. `ctx.tools.restrict()` is agent-scoped, takes DSH global tool names, refuses unknown names and `run_code`, and denies whole tools; the only composition hook is `agentPreset`, which needs a host-registered preset, not emitted data. Claude names (`Read`, `Grep`, `mcp__*`) and specifiers (`Bash(git push *)`) have no one-to-one mapping, so forwarding the list would restrict the wrong set. |
| `maxTurns` | `unsupported` | S16 C: `maxTurns: 1` child makes three requests (two tool calls and an answer) and ends `completed`, not partial. | Neither `SubagentStartRequest` nor the agent loop has a turn cap; the host has no "partial at the limit" outcome to map onto. |
| `isolation` | `planned` | S16 A: `isolation: worktree` is ignored — the child header `cwd` equals the root's. | Named seam: add `isolation` to `SubagentStartRequest`, handled in `dsh-subagent` child composition by creating a `ctx.worktrees` checkout as the child cwd and reclaiming it at disposal. Today `worktrees.create` re-points the *calling* session, so using it from the materializer would move the parent, not isolate the child. |
| `skills` | `equivalent` / `planned` (absent or empty body) | `agent-faces.test.mjs`: the child's first user request carries the persona body, then the host's exact envelope for `s16-preload` (rendered by the pinned `renderSkillContent`, byte-set equal), then the task, in that order; one request, `stopReason: 'completed'`. A frontmatter-only or zero-byte `SKILL.md` is `planned` and the child request carries no empty skill block. | Implemented: the dialect resolves plugin-local skill names at compile time and the materializer emits the host's `renderSkillContent` shape at the pin (`<skill_content>`, the `<skill_resources>` provider note, `<skill_instructions>`). The body bytes match Claude's startup injection, but the `Base directory for this skill:` hint, the skill's resource files and provider-managed loading are **not** carried; that is why this is `equivalent`, not `exact`. A name the plugin does not ship, or ships with an empty body, is `planned` (the seam is resolving it against `ctx.skills` at activation time); an empty body is never preloaded and never claims `equivalent`. |
| `memory` | `unsupported` | S16 A: the key is ignored; no memory text reaches the child. | DSH has no per-agent memory store or directory, and none of the session's persistence is keyed by agent name. Adding one is a new persistence surface and a new trust question, not a pass-through. |
| `background` | `unsupported` | S16 A: the key is ignored; the tool still returns at activation. | The materializer's tool is caller-facing and returns when `startActivation` resolves; DSH has no field to keep a child running detached while the parent waits, and the "smaller tool set" half is the `tools` face. `background: true` happens to match the shape DSH already has, `false` is unexpressible, so the key is not honoured. |
| `omitClaudeMd` | `unsupported` | S16 A: the key is ignored; the child receives the host's baseline instructions. | `dsh-agent-instructions` loads a session-scoped instructions baseline; there is no per-activation suppression and the child is a new session that inherits it. |
| `color` | `unsupported` | S16 A: the key is ignored. | A display colour has no channel: the tool schema carries name, description and arguments, and the host's inventory records no colour. Inventing one would put a value in our config that no host surface reads. |
| `autoCompactWindow` | `unsupported` | S16 A: the key is ignored. | Compaction is session/engine configuration (`dsh-compaction*`), not a per-activation window; a child cannot lower it without a new request field. |

`limits` is gone as a composite face: the dialect now emits one annotation per
key above, and `report.ts` prints one row per declared face. `IrAgentFaces.limits`
remains only as a deprecated union field for an IR producer that still writes the
old shape.

**What this does not prove.** One stub adapter, one pin: `equivalent` for
`skills` claims the body the child reads, not that a real model behaves the
same. The skill envelope is the host's, but the `Base directory for this skill:`
hint, the skill's resource files and provider-managed loading are not carried;
the body travels as prompt text. The resolved set is the plugin's own `skills/`
directory; a skill from a user or project directory is not preloaded, and
Claude's ability to invoke an unlisted skill through its Skill tool is not
measured here. The `unsupported` states are facts about `0.2.2-rc.5`, not
eternal impossibilities: `isolation` is the one with a named seam; it is
`planned` rather than faked.
The spike must be re-run when the pin moves; the table, the annotations and
`agent-faces.test.mjs` carry the pin's name.


### S17 — the shipped bundle mounts from a profile, not from a test boot

**Question.** `check:pack` and the install smoke boot the packed tarball, but
they compose the published patch row themselves (`composeEntries`, then
`loader.create`). Does the bundle mount when the **host** reads a profile — its
`package.json` `dsh.profile.bundles`, the bundle's `cordis.patch.yml`, the
profile root's `cordis.yml` — and does the controller that comes up resolve out
of the profile's `node_modules`, not out of this checkout? A test that
hand-feeds the row cannot answer that; the row is the input under test.

**Method.** `packages/dsh-anyplugin-conformance/test/profile-mount.test.mjs`
packs the tarball the way `check:pack` does (`node scripts/build.mjs` then
`npm pack --ignore-scripts`), creates a scratch home and profile with the
host's own `initProfile`, and installs the tarball into the profile by
extraction plus the two runtime scopes from this checkout (offline). The spike
that preceded the test measured the real-installer path with pnpm 10.28.1
(`pnpm add <tarball>` into the same `initProfile` layout: 57 packages, hoisted,
the bundle a real directory, its declared scopes present, the `~4.1.0` cordis
peer left out because `autoInstallPeers` is false — the case the launcher's
runtime interception exists for). Corepack's pnpm 12.21.0 cannot open a store
lock in this sandbox, which is why the test does not shell out to pnpm.

The test then performs the boot steps `@deepseek-ai/dsh`'s `runProfile`
performs: `loadProfile('dsh', 'profile-mount', installAnchor, home)` (manifest
bundles → `resolveBundleDir` → patch paths), write `<profile>/cordis.yml` as an
empty root, `readProfilePatches`, `createRuntimeResolution`, then
`boot('dsh', rootConfig, patches, prepare)` with `prepare` providing
`profileContext`, an exporter and the `SkillRegistry` — the profile lists only
`dsh-anyplugin`, so these are the test's host services, as the launcher's
`prepare` provides its own. It does not supply the launcher's application
object (`app.current`), its launch environment or command line, or the stock
base bundle. It supplies the real `PluginPackages` when the Node under test can
initialize it (measured by probing the addon at boot, not inferred from a
version), and otherwise catches exactly that error and links the scope (the
patch boundary below, and S18); the host path it actually used is the
diagnostic the Answer reports.
`module.registerHooks({resolve})` records the URL each `dsh-anyplugin`
resolution returns. There are five top-level tests — the valid lock, the three
failure modes, and a boundary control that re-runs the valid profile with its
package replaced by a link to this checkout. They are top-level rather than
one parent with subtests so a Node without `registerHooks` reports five skips
instead of a link-time failure.

**Answer (pinned `0.2.2-rc.5`, `claude-code@2.1.329`; measured on the CI Node
24.22.3 and the local gate Node 24.22.2; one positive test carrying five
positives, three negative tests and one boundary control — all green; on Node
older than 22.15 the five skip with a reason naming the version, and the
package's published engine floor stays 22.14).**
The same five tests also pass on the Desktop's Node 24.21.0, where
`PluginPackages` initializes and the host path is `PluginPackages` (S18). On a
Node that initializes `PluginPackages`, the positive test also asserts the
interception's effect — no scope link, and the group entry's URL under the
installation tree — so the gate's result is closure, not the scope-link
stand-in.
The harness boots; the controller entry
`dsh-anyplugin` is active; the controller creates exactly one root group entry
`anyplugin.claude-code…skills-only` with one active
`dsh-anyplugin/materialize/skill` child; `ctx.skills.list()` contains the
fixture's `hello` and `greet`; `renderSkillContent(await ctx.skills.get('hello'))`
contains the fixture body; and every observed module URL is
`file://<profile>/node_modules/dsh-anyplugin/lib/index.js` — inside the
scratch profile, never `file:///…/dsh-anyplugin/lib/index.js` in the checkout.
Negatives: no lock → boot succeeds, controller active, zero groups, debug log
`no lock at <home>/anyplugin/installs.yml`; corrupt lock → boot succeeds, the
**controller entry** is the failed entry (state 3), zero groups, and the typed
`InstallsFileError` names the file and line (`installs.yml:2: expected
plugins:`); `enabled: false` → controller active, zero groups.

Three mutations were run and reverted, and the two boundary ones are stated
with their outcomes because a future pin bump must know which assertion carries
the claim: M1 `patches.length = 0` (skip the profile's bundle patch) → all five
tests fail, the positive one on "the profile patch must insert the controller
entry"; M2 replace the profile's `node_modules/dsh-anyplugin` with a link to
the checkout → only the positive fails, on the module-URL assertion, reporting
`file:///tmp/anyplugin-wt/ticket-112/lib/index.js` (the boundary control passes
by design — that is what makes the URL assertion non-vacuous); M3 point the
row's `config.installs` at another file → the positive and the boundary control
mount zero groups, the missing-lock scenario loses its `no lock at
<installs.yml>` log, and the corrupt scenario stays active instead of failing.

**Patch boundary (measured, not assumed).** On Nodes where the addon's x64
getter prologue does not match, `PluginPackages` — the launcher's runtime
interception, which resolves the bundle's `@deepseek-ai/*` imports from the
installation — cannot initialize: its constructor fails in
`installRuntimeInterception` with `node-addon-require-builtin unsupported:
Unsupported/no-getter (x64 sysv getter is not a recognized this->field accessor
…)`, target `internal/modules/esm/loader`. `boot` turns that into `dsh: host
preparation failed: …`. The test catches exactly that error, links the harness
`@deepseek-ai` scope into the profile as the install smoke does, and reports
`host path: scope-link (PluginPackages unsupported)`. The boundary is a Node
patch, not the harness pin: 24.12.0 and 24.22.2 fail, while 24.22.3 (what CI's
`node-version: '24'` resolves to today; run 44955431971's S17 logs show
`host path: PluginPackages` at both pins) and the Desktop's 24.21.0 initialize
and let the test assert closure (S18). On a capable Node the positive test
probes the addon at boot and requires three effects: `host path:
PluginPackages`, no `@deepseek-ai` scope link in the profile, and the group
entry's module URL under `<installation>/node_modules/@deepseek-ai/`. A capable
Node that falls back fails the test, and under `CI=true` a Node that cannot
initialize fails it too, so the gate cannot silently stop asserting closure.
The controller itself imports only Node builtins (its cordis dependency is
type-only), which is why the rest of the path does not need the interception.
The controller can also log `failed 1` while the group it created settles
active in the same boot, because the include's load pass runs after
`loader.await()` collected its tasks; the test asserts the settled tree, not
that count.

**What this does not prove.** Closure on Nodes where the binding fails: with
the scope link, an `@deepseek-ai/*` import succeeds because the scope is
present, not because the installation resolved it, and S17 does not run the
closure assertions there. CI's Node is on the working side, so the gate asserts
closure; a CI Node that moves to the failing side fails the test rather than
silently keeping the diagnosis. It is not a template profile — the stock base
application bundle is not in the fetched harness union, so the controller is
the profile's only bundle and a base bundle's rows mounting before/after it are
not exercised. The pnpm install path is the spike's measured comparison, not
the test's install step. What is proven is the profile row's contract: profile
manifest → bundle patch → root include → boot → controller resolved from the
profile → one active group → its skill child serving the fixture's skills, with
the three failure modes the docs declare. The decision this earns — the profile
path, not a hand-composed row, is the claim for the profile row — is **D50**.
D49 is the lifecycle CLI's contract, ratified as #116; D50 does not change it.
Installation closure is asserted on the Node CI runs (S18): D50's install
claim holds on that Node, and the install row names the patch condition.


### S18 — installation closure is asserted on the Node CI runs

**Question.** S17 mounts the packed bundle through a real profile but falls back
to a scope link when `PluginPackages` cannot initialize. Can the pinned harness
be booted with `PluginPackages` actually intercepting the bundle's
`@deepseek-ai/*` imports on a Node this repo can run its gate on — and if so,
does that turn S17's fallback into a closure check?

**Method.** `spikes/s18-install-closure/run.mjs` creates a scratch home with the
host's `initProfile`, writes a child probe **inside** `<home>/profiles/s18/`
(the launcher's `ResolutionRouter` only intercepts importers in the profiles
tree; a probe outside it sees `ERR_MODULE_NOT_FOUND` in both directions), and
runs it under each Node binary. The child probes the addon first
(`requireBuiltin` for the five internal modules `internalModules()` needs), then
the negative/positive pair: `import('@deepseek-ai/cordis-plugin-group')` must
fail before `new PluginPackages(context, { resolution })` and must resolve
**from the installation** after it, with no scope link in the profile. The
spike also boots the five tests in
`packages/dsh-anyplugin-conformance/test/profile-mount.test.mjs` under each
binary and records the `host path` diagnostic, so the minimal probe and the
profile boot cannot disagree without showing up in the table.

The verdict is derived from the rows, not hardcoded: a row proves closure only
when all five builtins load, the constructor succeeds, the import is unresolved
before and resolved from the installation after, and S17's five tests pass with
`host path: PluginPackages`. The spike asserts every row is wholly on one side,
the known failing patches (24.22.2, 24.12.0) and working patches (24.22.3,
24.21.0) when those rows are present, the gate row's own side, the absence of a
separate `@deepseek-ai/dsh-plugin-packages` package, and — on the gate Node — the
default plus seven options (`--jitless`, `--no-sparkplug`, `--no-maglev`,
`--no-turbofan`, `--interpreted-frames-native-stack`, `--no-opt`,
`--no-concurrent-recompilation`). The spike clears ambient `CI` before it
spawns S17, so the incapable rows exercise S17's local fallback instead of its
CI guard.

Reproduce the boundary with the CI Node and a failing Node named explicitly:

```
node scripts/fetch-harness.mjs 0.2.2-rc.5
DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
DSH_HARNESS_VERSION=0.2.2-rc.5 \
DSH_NODE_EXECUTABLE=<desktop node 24.21> \
S18_EXTRA_NODES=/path/to/node-24.22.3:/path/to/node-24.12 \
  env -u CI node spikes/s18-install-closure/run.mjs
```

**Answer (pinned `0.2.2-rc.5`, `claude-code@2.1.329`; measured 2026-11-21;
the same rows were re-run at `0.2.2-rc.2`).**

| Node | source | `requireBuiltin` | `PluginPackages` | group import | S17 host path |
| --- | --- | --- | --- | --- | --- |
| 24.22.3 | official tarball, named by `S18_EXTRA_NODES`; CI's `node-version: '24'` today | 5/5 | initializes | fails before, resolves from the installation after | `PluginPackages` (S17 5/5) |
| 24.21.0 | Desktop `$DSH_NODE_EXECUTABLE` | 5/5 | initializes | fails before, resolves from the installation after | `PluginPackages` (S17 5/5) |
| 24.22.2 | system `node` (the local gate) | 0/5 `Unsupported/no-getter` | throws | unresolved both ways | `scope-link (…)` (S17 5/5) |
| 24.12.0 | nix store, named by `S18_EXTRA_NODES` | 0/5 `Unsupported/no-getter` | throws | unresolved both ways | `scope-link (…)` (S17 5/5) |

The interception is not a separate package at this pin: there is no
`@deepseek-ai/dsh-plugin-packages` directory; `PluginPackages` is a top-level
export of `@deepseek-ai/dsh-app-boot` (`src/profile-resolution/service.ts:60`).
Its constructor calls `installRuntimeInterception` synchronously
(`service.ts:70`), which calls `internalModules()` (`resolver.ts:733`) and
requires the five builtins; the only config key is `resolution` (an early
return when it is absent, `service.ts:67`), and `src/profile-resolution` reads
no `process.env`. Ordering another plugin first cannot help: `ctx.plugin(…)`
constructs the service immediately, before any registration, and the failure is
the constructor's first act. The addon is
`node-addon-require-builtin` (declared as `^0.1.9` by `dsh-app-boot`; the
fetched trees used here resolve `0.1.10`, and the declared range is all the
harness pin fixes); the failure is in its x64 getter
prologue for `internal/modules/esm/loader`, and none of the seven options
measured changes it. `.harness/<pin>` ships no Node binary.

**Patch boundary.** 24.22.2 fails and 24.22.3 works: the same minor, one patch
apart. The difference is in the addon's access to the Node internal getter
(`Unsupported/no-getter` from the x64 sysv getter prologue), not in the harness
pin, the profile, or this repository's code. CI's `actions/setup-node@v4` with
`node-version: '24'` resolved to 24.22.3 in run 44955431971 (both pins' S17 logs
already printed `host path: PluginPackages`); the spike's 24.22.3 row was run
from the official `node-v24.22.3-linux-x64.tar.xz`
(sha256 `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb`,
matching `SHASUMS256.txt`). No pin moved: CI still floats `24`, and the test
probes the capability instead of reading a version.

**Decision (closure asserted; D54 proposed in the PR).** On the Node CI runs,
`PluginPackages` initializes and S17 asserts installation closure: the positive
test probes the addon at boot, then requires `host path: PluginPackages`, no
scope link in the profile, and the group entry's module URL under
`<installation>/node_modules/@deepseek-ai/`. A capable Node that falls back
fails the test, and a CI Node (`CI=true` or `CI=1`) that cannot initialize fails
it too, so the gate cannot silently stop asserting closure. The claim is conditional and stated:
it holds on the Node the gate actually runs; a Node change to the failing side
of the patch boundary fails the gate rather than downgrading the claim. The
install row in `docs/FEATURES.md` names the condition and S18. The TODO line
that asked for the proof is deleted. D54 records the decision (proposed in the
PR; this file is not edited here).

**What this does not prove.** Every import shape the launcher intercepts: the
minimal probe covers one bare `@deepseek-ai/*` package import plus S17's boot of
the controller and its group entry. Node platforms other than linux-x64 are
not measured. The spike is not a CI job; CI's evidence is the S17 assertion on
whatever `node-version: '24'` resolves to, and the spike's boundary table is
the reproduction. If the addon or harness pin moves the boundary, the spike's
per-version assertions fail and D54 must be revisited rather than silently
kept.


### S19 — a plugin `bin/` reaches the model shell PATH only through a per-call rewrite

**Question.** Claude Code appends `<plugin>/bin` to the PATH of the shell its
model calls, after the user's own entries. Does a plugin `bin/` reach DSH's
model shell PATH without a core change — and if not, what exactly can carry it?

**Method.** `spikes/s19-path/run.mjs`, 19 checks. Nine read the installed source
at the pin (the registry API and its validation, both model-facing shell tools,
the local executor's env merge, the scrub). Ten boot the primitives the oracle's
tool probes boot — `SessionStore`, `SessionProjections`, `SystemPrompt`,
`ToolsService`, `dsh-tool-executor-native`, `dsh-fs-local`, `WorkingDirectory`,
`ShellEnv`, `dsh-subprocess-local`, `dsh-bash-local`, `dsh-tool-bash` — and call
`bash` the way the model does: a `tool-call` batch through
`ctx.tools.execute`, never `process.env` directly. A probe contributor is the
positive control (a registered `DSH_*` value must be visible in the child);
then `PATH` is declared, then smuggled from `resolve()`; then a probe `bin/` with
`probecmd` and `ls` is exercised by bare name; then a synthetic
`tools/pre-execute` listener rewrites the `bash` command to prepend that bin,
which proves the per-call route runs a command and that disposing the listener
returns the call to 127. The spike never mutates `process.env.PATH` — the gate
in issue #131; the scrub check sets and restores three ordinary names, never
`PATH`. Run at both pins, each in CI:

```
DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
  node spikes/s19-path/run.mjs
```

**Answer (pinned `0.2.2-rc.5` and `0.2.2-rc.2`, 19/19 checks each).** Not
through the managed environment. The only registration API is
`ctx.shellEnv.register(contributor)` (`dsh-shell-env/src/index.ts:122`), and its
key grammar is `DSH_` plus `/^[A-Z][A-Z0-9_]*$/` (`:91`), checked at
registration (`:133-135`); the key type is a compile-time template,
``DshEnvironmentKey = `DSH_${string}` `` (`dsh-subprocess/src/types.ts:16`).
Declaring `PATH` throws, verbatim, `bash env contributor "s19-path" declared
invalid key "PATH"`. A resolver that declares `DSH_S19_SMUGGLE` but returns
`PATH` is refused inside the model call with `bash env contributor "s19-smuggle"
returned undeclared key "PATH"`, `ShellEnvError` code
`SHELL_ENV_CONTRIBUTION_INVALID` (`:188`). The model-facing tools send only the
collected overlay (`dsh-tool-bash/src/index.ts:515-521`,
`dsh-tool-pwsh/src/index.ts:542`) and expose no `env` parameter — the bash
schema offers `description`, `command`, `timeoutMs`, `workdir`, and an `env`
member added to the arguments is ignored. The child environment is
`{ ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }`
(`dsh-bash-local/src/index.ts:172`) over `scrubbedParentEnv()`
(`dsh-subprocess-local/src/spawn.ts:45-46`), which keeps `PATH` from the harness
process (`dsh-subprocess/src/index.ts:76`). Measured on the model side: `$PATH`
is byte-equal to `process.env.PATH`; `DSH_S19_PROBE=hello-s19` from a registered
contributor **is** visible (so the registry is applied to real calls); the probe
bin is absent from every PATH entry, `probecmd` exits 127 "not found", and a
probe file named `ls` does not shadow `/nix/store/…-coreutils-9.12/bin/ls`.

But `bin/` is not `unsupported`: a second host path exists and S19 exercises
it. `tools/pre-execute` runs before dispatch with the execution object, and a
listener may replace `exec.arguments`; the pipeline freezes the argument
*value*, not the execution object (`dsh-tools/src/pipeline.ts:154-158`). This
repository already relies on that for `updatedInput`
(`packages/dsh-anyplugin-materialize-hook/src/index.ts:224-257`, applied at
`:1716`), and the conformance test `a classic command hook updatedInput follows
the same chain rewrite`
(`packages/dsh-anyplugin-conformance/test/mods.test.mjs:371`) proves a rewritten
command reaches the bash tool at both pins. The spike's rewrite check does the
same with a synthetic listener: it prepends the probe bin to the `bash`
command, `probecmd` runs (exit 0), and disposing the listener returns the call
to 127. So the surface is expressible without a core change.

It is still `planned`, not `equivalent`, because that route diverges and we
decline it for now. Later hooks and the hook trace see the rewritten command as
`tool_input`; the session transcript still carries the model's original
(`packages/dsh-anyplugin-conformance/test/mods.test.mjs:591-635` asserts
`use.input` is `{ command: 'ls' }`). pwsh syntax differs, so one rewrite grammar
cannot serve both shells; and Claude's "plugin bins after the user's entries"
ordering becomes a choice inside the rewrite — a prepend wins where Claude
loses. The dialect reason names both measured refusals and these divergences. The union-only PATH contribution in `docs/TODO.md` is the shape
that would make the row `equivalent` without them; until it lands, the row
stays `planned`. Exec classification is unchanged: D25 pins `bin` files and the
grant shows the command line; nothing here injects a PATH silently.

**What this does not prove.** The rewrite check proves a command runs under a
listener that prepends the probe bin; it does not reproduce Claude's ordering,
and S19 does not ship that listener. The transcript statement rests on the
conformance test at `packages/dsh-anyplugin-conformance/test/mods.test.mjs:591-635`
(the stored `use.input` is the model's original), not on a new spike check.
pwsh was source-read only on Linux, never booted, so its rewrite grammar is an
argument from its source, not a measurement. A future PATH contribution must
append after the inherited entries rather than prepend, and the row moves to
`equivalent` only with a probe of that order. It also does not prove the
proposal in `docs/TODO.md` is the right shape.


### S20 — the packed tarball mounts from a profile npm installed it into

**Question.** S17 mounts the packed bundle through a profile, but its
`extractPackage` copies the tarball into `node_modules` and links the runtime
scopes from this checkout; the install smoke composes the packed patch itself.
Does the artifact a user installs — a tarball in a profile whose `package.json`
names it in `dependencies` and `dsh.profile.bundles`, installed by npm — boot
through the host's own profile loader with the controller entry active, the
bundle patch applied and a materializer child live? Does its module resolve
inside the profile's `node_modules`, and does the gate redden when the patch is
missing from the tarball, when the profile does not list the bundle, or when the
package resolves from this checkout?

**Method.** `check:pack` runs `node scripts/profile-boot.mjs <tarball>` after
its install smoke. The script creates a scratch `$DSH_HOME`, asks the host's own
`initProfile` for a profile, adds `"dsh-anyplugin": "file:<tarball>"` to the
profile `dependencies`, copies the repository's `package-lock.json` so npm can
resolve the tarball's closure offline (the cache `npm ci` leaves holds tarballs,
not packuments), and runs
`npm install --no-audit --no-fund --offline --ignore-scripts --legacy-peer-deps`.
It then boots through `mountProfile`, the same helper
`packages/dsh-anyplugin-conformance/test/profile-mount.test.mjs` calls, so S17
and the pack gate share one implementation of `loadProfile` →
`readProfilePatches` → `boot`. The boot asserts what it observes, not what the
install returned: the composed patch contains the `dsh-anyplugin` row, the
controller entry is active, exactly one root group
`anyplugin.claude-code…skills-only` is active with its
`dsh-anyplugin/materialize/skill` child active, the fixture's `hello` and
`greet` skills load and render, the controller reads the scratch
`installs.yml`, and every recorded module URL is under
`<profile>/node_modules/dsh-anyplugin/lib/index.js`, never this checkout. On a
Node where `PluginPackages` initializes, the boot requires that path, no profile
`@deepseek-ai` link and group-entry URLs under the installation; where it cannot
(the boundary S18 measured), S17's scope-link fallback is allowed locally and is
a failure under CI.

**Mutations.** The ticket's three failures are produced by
`--mutation=no-patch|no-bundle|checkout` and kept as a test in
`profile-mount.test.mjs`; each must fail for its own message, and the test
asserts the three are pairwise distinct:

| mutation | how | observed message |
| --- | --- | --- |
| no-patch | repack the tarball without `package/cordis.patch.yml` | `bundle skipped: "dsh-anyplugin": … failed to read overlay …/cordis.patch.yml: … ENOENT` |
| no-bundle | `initProfile` with an empty `dsh.profile.bundles` | `the profile's dsh.profile.bundles does not list dsh-anyplugin (no bundle layer was loaded)` |
| checkout | replace the installed package with a link to this checkout | `dsh-anyplugin resolved outside the profile node_modules: file:///…/lib/index.js` |

**Real profile.** The boot fingerprints `$DSH_HOME` and `$DSH_PROFILE_DIR`
before and after — per-entry kind, mode, size and mtime, plus sha256 of every
regular file up to 64 KiB — and fails naming the changed paths if either moved;
the success line prints both digests. The running Desktop host writes its own
session state under `$DSH_HOME/sessions` and `$DSH_HOME/storages` while the boot
runs, so those two host-owned subtrees are excluded from the home fingerprint
only, and the exclusion is printed; the profile fingerprint has no exclusion. A
boot that appends to both `$DSH_HOME/sessions/live.txt` and
`$DSH_PROFILE_DIR/sessions/live.txt` passes the home comparison only because of
that scope and fails naming the profile (`profile-mount.test.mjs`, the `guard:`
test). A root that does not exist is reported absent, not as an unreadable
empty tree; on CI, where neither a real home nor a real profile exists, the boot
prints `real home: absent; real profile: absent`.

**Answer.** At pins `0.2.2-rc.5` and `0.2.2-rc.2` (claude-code@2.1.329) the
npm-installed tarball mounts: controller `dsh-anyplugin` active, patch row
applied, the `anyplugin.claude-code…skills-only` group active with its skill
child active, skills `greet,hello`, and the module URL inside the scratch
profile. Locally the boot was green on both pins under Node 24.22.2
(scope-link, the failing side of S18's bindings boundary) and on `0.2.2-rc.5`
under the Desktop's Node 24.21.0 (`PluginPackages`, no scope link, group URLs
under the installation tree). CI's `node-version: '24'` resolves to 24.22.3,
the capable side of that boundary, and `npm run verify` runs per pin and
requires 0 skipped.

**What this does not prove.** Dependency *metadata* resolution: the profile
install reads the repository lockfile, so a `dependencies` range in the tarball
that the lock already satisfies is not re-resolved against a registry; a range
the lock cannot satisfy fails the install offline rather than producing a
verdict about the range. The installer is npm, not the pnpm the host's profile
template names. The profile lists only `dsh-anyplugin`, not the stock base
bundle `normalizeShippedProfile` would add. `PluginPackages` closure on a
capable Node is asserted only the way S17 asserts it (the addon probe plus the
group-entry URL); no new Node is measured, and S18 owns that boundary. The live
Desktop host's `sessions/` and `storages/` writes are excluded rather than
frozen, so "untouched" is scoped to every other path. Reconcile counts are not
asserted (S17's note applies).


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
| v0.3 | Codex dialect via portable IR; LSP; output-styles (body carried in the IR; activation waits on D10's command alias, at-start provenance and the `keep-coding-instructions` rule); bin (planned: needs the union-only PATH contribution; the per-call rewrite is declined in S19) |
| v0.4 | agents (per-agent tools or prompt template); themes (F2 ANSI seam); monitors; workflows |
| v0.5 | `dsh-mod-host` alpha: static scanner + chain engine + fs/store/http/session bridges + `AbovePrompt` render site |
| v0.6 | mod host beta: headless element sink (#75: validated trees recorded, panes served, one reader tool), drawing + redraw scheduler, guard layer (sec-default equivalent) |
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
- ~~Do materializer packages ship inside the anyplugin bundle, or as
  profile-level dependencies?~~ **Resolved** (ticket #79; decision proposed as
  D43): one bundle. The materializers are subpath entries of `dsh-anyplugin`,
  so they are resolved from the profile's `node_modules` like any dependency
  while staying one install unit.
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
  The `.ts` spine loads. **Resolved by D34 (#45):** the host transforms a
  `.tsx` module that declares the classic pragma, so the pinned `diff` graph
  loads (S14, 122/122); rendering and foreign pragmas remain separate
  `planned` surfaces (see §7.7).
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
  exists for all fourteen: the five lifecycle events, the four listener seams and
  the five notification records are `equivalent`, and their coverage rows are log
  lines from real turns (`claude-hooks-lifecycle`, `claude-hooks-seams`; §10.3). Nothing
  here adds a second event path: every row is a listener on the existing host
  bus. The mod front-end reuses the same carrier: `agent/created` seats
  each agent's mod and classic registrations on `payload.agent.ctx`, and
  `apply` sweeps `ctx.agents.list()` so a root already live at load is seated
  too; a reload disposes the old seats and re-seats the live set without
  replaying `classic.SessionStart`. `session.start` is the loader's per-plugin
  point fired during `apply` (D32 §4; §7.2), before the first prompt of the
  process; its payload is `{cwd}` (the live root's cwd or the process cwd,
  never `CLAUDE_PLUGIN_ROOT`), and `surface`/`isInteractive` are recorded as
  an unbridged field gap. The real-turn test drives a mod rewrite through
  `tools/pre-execute`, asserts the executing tool received it, and checks the
  guard turns a non-writable `arguments` or a lossy rewrite into a typed
  unsupported rather than a throw or a silent drop.

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
  provider as the raw model id `sonnet` with the parent's provider, so a Claude
  alias names no route this deployment has; `agentOptions.reasoningEffort` is
  validated against the provider's advertised ids, so a Claude level can die
  with `UNSUPPORTED_REASONING_EFFORT`. §10 S16 therefore records `model`,
  `effort`, `tools` and `maxTurns` `unsupported`, `isolation` `planned` behind a
  child-composition seam, and `skills` `equivalent` (resolved bodies prepended
  to the child's first user message). The escape layer (`docs/TODO.md`,
  "Escape layer") remains the only path for model identity.

  **What this buys, and what it does not.** Catalog face `exact` (name and
  description are what the model sees), invocation `equivalent` (N tools vs
  one `Task` tool with `subagent_type`), per-key faces per §10 S16.
  The DSH oracle learns `agents:<name>` only from a schema it observes in
  `ctx.tools.schemas()` whose scoped name and description equal the **emitted
  declaration** byte for byte — never from the IR skeleton. `agents.test.mjs`
  is the independent fixture anchor: it reads the description from the
  fixture's frontmatter bytes and the body from the emitted `agents` child, so
  the two sides cannot drift together. A tool cannot put the body in its
  description (we forbid it), cannot set the child's fresh system prompt,
  cannot filter the child's tools or cap its turns per activation, and cannot
  resolve a Claude model alias. `fixtures/claude-agents` therefore matches
  `agents:reviewer:match` in `coverage.test.mjs`. The goldens declare the rows,
  and the nested `agents/deep/planner.md` is not loaded at the pin, so it is not
  a declared row — the matrix, not an issue's arithmetic, is the scoreboard.
  (The S9 lifecycle and seam wiring that follows is what moves the totals;
  §10.3.)

  Reproduce:

  ```bash
  node scripts/fetch-harness.mjs 0.2.2-rc.5
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

  **4. What this does not settle.** Four gaps remain before activation:
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

  **5. Activated (ticket #77).** The gap list above is the state at the S11
  answer; activation has since closed (i), (iii) and (iv) without changing the
  row's class. Provenance is the profile activation record's plugin name (the
  record is read at load, so an unreadable record or plugin is a typed load
  error/refusal rather than a guess); the oracle is a composed-prompt probe
  that boots the pinned harness, loads the entry, runs one turn on a stub
  adapter and returns the system prompt the model received; composition is the
  split the ticket specified — `keep-coding-instructions: false` maps to
  `complete: true`, any other value (including absent) appends a section, and
  the activation face's reason names that divergence from Claude's documented
  default explicitly. The materializer skips agents whose origin is
  `subagent`; upstream applies a style to the main conversation and a fork,
  and a complete section on a child would replace its whole prompt. An empty
  or whitespace-only body is refused as `empty-style` (a whitespace-only
  forced style is skipped in favour of a later valid one, and refused when it
  is the only candidate), and a refused selection makes `compileEntries`
  throw `OutputStyleActivationError` instead of compiling silently. (ii)
  remains, so the command face stays `planned`.
  `output-styles-activation.test.mjs` asserts the appended bytes
  (`baseline + "\n\n" + body`), the replaced bytes (`prompt === body`), the
  forced selection, an absent keep-coding key appending, an inactive style's
  absence, an unknown-style refusal that leaves the prompt byte-identical to
  the baseline, and one test per role — main, sibling and fork receive the
  style, a subagent does not.

  **What this buys, and what it does not.** Each flat `output-styles/*.md` is
  an `IrOutputStyle` row in `ir.outputStyles`, carrying its body byte for
  byte (`output-styles-carry.test.mjs` hashes the IR body against the file).
  Its annotation splits into two faces: activation `equivalent` (reachable
  through the agent-scoped prompt seam and now materialized) and command
  `planned` (D10), so the overall row stays `planned` and the report keeps
  printing `class=planned carry=skipped`. A nested file, and a
  `manifest:outputStyles` declaration, remain `pending`: the flat surface is
  the only one this dialect reads. The upstream CLI's inventory still has no
  output-style line, so both fixtures are hand-authored and carry no
  `.inventory` golden: `fixtures/claude-output-styles` is asserted by the body
  hash, and `fixtures/claude-output-styles-activation` by the composed prompt
  bytes. No fidelity total changes: an absent golden adds no oracle row.

  Reproduce:

  ```bash
  node scripts/fetch-harness.mjs 0.2.2-rc.5
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
  host skeleton landed separately in #33 — §7.7 — and S14/D34 later removed the
  `.tsx` refusal, so "load a real mod" is no longer gated on the JSX decision.)

  **Load.** All 579 `.ts` files strip with 0 failures; the stripped entry stays
  33,891 bytes / 1342 lines and `on('session.start')` stays line 938. Stock ESM
  refuses four specifier shapes that exercised three host resolution behaviors
  at the 2.1.322 pin — extensionless/`'.'` to `index.ts`, `.js`→`.ts`, `.jsx`→`.tsx` — so a host
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
  realms, lines 938–1294. At the 2.1.329 pin the fixture measures 11 sites / 9
  unique events / 25 `$.` calls (`fixtures/mods/diff/fixture.json`); the
  numbers here are the 2.1.322 measurement.

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
