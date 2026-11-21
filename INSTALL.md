# Installing `dsh-anyplugin`

`dsh-anyplugin@0.2.0` is this release. It is
**one bundle** whose
patch inserts **one row** — the controller. Everything else (skills, including
commands on their model face, MCP servers, hooks, agents, an activated output
style) is created at runtime by reconciling the lock file
`installs.yml`; the package writes no profile config and generates no code.

What 0.2.0 ships:

| surface | state in 0.2.0 |
| --- | --- |
| Skills | loaded into the harness skill registry |
| Slash commands | land as **skills** on their model face (`equivalent`); the human `/…` face is still `planned` (D10) |
| MCP servers | stdio and Streamable HTTP; DSH namespaces the callable name (`mcp__plugin_<plugin>_<server>__<tool>`), keeping Claude's as the suffix |
| Hooks | the events the host actually fires; `exec`-class hooks need a grant |
| Agents | one scoped tool per `agents/*.md` |
| Output styles | activated from `$DSH_HOME/anyplugin/output-styles.yml` (one style, `agent/created`); the `/<plugin>:<name>` command face stays `planned` (D42) |
| `mods` | **kernel shipped** in `lib/materialize/hook.js` (D30/D31/D34), but **not lock-reachable**: a hand-written hook row may carry `mods: [{ entry }]`, while `installs.yml` has no `mods` field, so `dsh plugin add` does not install mods |
| Codex plugins | **not shipped** in 0.2.0 (v0.3) |

## Requirements and the version claim

- **Node.js ≥ 22.14** (`engines.node`).
- **Mods need `--experimental-vm-modules`.** D30 loads each mod in a `node:vm`
  realm, and Node exposes `SourceTextModule` only behind that flag. CLI:
  `node --experimental-vm-modules …`. Desktop: export
  `NODE_OPTIONS=--experimental-vm-modules` before launching `dsh` — a shell
  export is enough, the environment is inherited by the bundled Node. Without
  it each mod is refused with `ERR_MOD_HOST_LINK` ("node:vm SourceTextModule
  is unavailable; run Node with --experimental-vm-modules (D30)"), classic
  hooks still run, and the kernel logs the flag once rather than once per mod.
- **DSH `0.2.2-rc.2 || 0.2.2-rc.5`** (`engines.dsh`): exactly the two pins the
  suite boots. Any other runtime — including `0.2.2-rc.3`, `0.2.2-rc.4`,
  `0.2.2-rc.6` and `0.2.2` — is refused until it is tested. The harness's
  compatibility check enforces `engines.dsh`, so a runtime outside the set
  refuses the plugin instead of half-loading it. To try an untested exact
  version, read the warning and grant the exact-version exemption
  (`dsh plugin allow-version`); nothing else changes. `@deepseek-ai/cordis` is
  a peer at `~4.1.0`, the version both pins ship.
- **Claude Code `2.1.329`** for the plugin format the compiler reads. Every
  record in `installs.yml` must carry `pin: "claude-code@2.1.329"`; a record
  naming a different pin is rejected rather than silently re-interpreted.
- A Claude Code plugin directory (one with `.claude-plugin/plugin.json`) on
  disk. 0.2.0 compiles from a local directory; it does not fetch plugins.

## 1. Install the bundle into a profile

A DSH profile is a directory under `$DSH_HOME/profiles/<name>` that lists the
bundles it stacks. Add the package to that profile's dependencies:

```bash
dsh plugin --profile <profile> add dsh-anyplugin
```

Then enable it in the profile's bundle list. The Web Plugins page toggles this
for you; by hand it is one entry in `<profile>/package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-anyplugin"] } }
}
```

The order matters: later bundles patch over earlier ones. The next boot reads
`dsh.bundle.patch` (`cordis.patch.yml`), which inserts:

```yaml
- insert:
    - id: dsh-anyplugin
      name: dsh-anyplugin
```

That row is the whole bundle. It needs the profile's package scope to resolve
`dsh-anyplugin` and its five `dsh-anyplugin/materialize/*` subpaths — `skill`,
`mcp`, `hook`, `agents`, `output-style` — which is exactly what
`dsh plugin add` (pnpm in the profile) provides.

Commands are not a sixth subpath: a slash command lands as a **skill** on its
model face (`equivalent`). The human `/…` face is still `planned` and needs
the host command-name seam (D10); wiring it is not part of 0.2.0.

## 2. Install and enable a plugin

The installer is the conformance rig in this checkout (`packages/dsh-anyplugin-conformance/src/rig.ts`);
it is not a separate published executable yet. From the repository root:

```bash
npm run rig -- install <plugin-dir> [--scope user|project|local] [--name <name>] [--dialect claude-code|codex] [--force] [--allow-empty] [--dry-run] [--json]
npm run rig -- list [--json]
npm run rig -- enable <plugin> [--scope user|project|local] [--dry-run] [--json]
npm run rig -- disable <plugin> [--scope user|project|local] [--dry-run] [--json]
npm run rig -- uninstall <plugin> [--dry-run] [--json]
```

`install` reads `<plugin-dir>` with the dialect detected from its manifest
(`.claude-plugin/plugin.json` → `claude-code`; a root `plugin.json` or
`.codex-plugin/plugin.json` → `codex`, overridable with `--dialect`), compiles
it through the same report path as `rig report`, and writes exactly one record
to `$DSH_HOME/anyplugin/installs.yml` through the canonical lock writer. It
then enables the plugin in the layer named by `--scope` (default `user`), but
only if that layer does not already mention it — a previous `disable` is never
silently flipped. `<plugin>` in `enable`/`disable`/`uninstall` is
`<dialect>:<name>`, or a bare name that is unique in the lock.

The command is idempotent: installing the same directory twice exits 0 and
rewrites nothing. `--force` is the explicit override when the record's root or
version changed. `--config <file>` re-points the lock (grants and data follow
it), and `--project <dir>` selects the workspace whose scope layers are read.
Paths resolve against the current directory: `<plugin-dir>` and a relative
`--config` are cwd-relative, while the record stores `root` and `dataDir`
absolutely. A command that needs an existing lock, given a relative
`--config` that does not exist, refuses with `unreadable-lock` instead of
reporting an empty lock from the wrong directory.
Every mutating command accepts `--dry-run`, which prints the exact `-`/`+`
lines and writes no byte. `--json` prints typed refusals as
`{ok:false, refusals:[{code, reason, hint?}]}` and exits 1; the reason is the
parser's own message, never a paraphrase.

What `install` does **not** do:

- It does not touch `PATH`; a plugin is data the controller reconciles, not an
  executable shim.
- It does not write profile config. Adding the bundle to a profile is still
  `dsh plugin add` in §1; the installer only writes `installs.yml`, the scope
  layer named by `--scope`, and (through the controller) `grants.yml`.
- It does not seat mods. `installs.yml` has no `mods` field (D43/D46); the mod
  kernel is reachable only from a hand-written hook row carrying `mods`, and
  that is not an install path.
- It does not grant `exec` artifacts. Hooks stay `refused:exec` until a
  hash-pinned grant exists (D27); a plugin whose compile yields only refusals
  is refused by default and can be recorded with `--allow-empty`, which
  installs an inert-but-listed plugin and names the refusals in `list`.
- `uninstall` removes the record and leaves the enablement layer and grants in
  place, so a workspace's policy survives a reinstall; it prints which scopes
  still mention the plugin and how many hash-pinned grants remain
  (`grants: N retained`, also printed by `list`).

A missing lock means "no installs"; a malformed one fails every lifecycle
command with the parser's line number — it never silently uninstalls anything.
At boot the controller reports the same parse error as a typed
`InstallsFileError` on its own entry and mounts nothing; the rest of the
harness still boots.

The lock is still the contract, so here is the record `install` writes:

```yaml
# $DSH_HOME/anyplugin/installs.yml
schema: "dsh-anyplugin/installs@1"
plugins:
  - dialect: "claude-code"
    name: "my-plugin"
    version: "1.2.3"
    root: "/absolute/path/to/my-plugin"
    dataDir: "/absolute/path/to/dsh-anyplugin-data/my-plugin"
    pin: "claude-code@2.1.329"
    source: "plugin-dir:plugins/my-plugin"
```

`root` must be absolute and point at the plugin directory; `dataDir` is the
plugin's private data directory. It is created by the hook materializer when
at least one hook is emitted (a hook needs a grant first); the controller only
reads the record, so a plugin with no emitted hooks and a missing directory is
not an error. `name` and `version` are the identity in the lock; the
model-facing ids are namespaced under `anyplugin.` and cannot collide with the
profile's own rows.

The lock schema is strict. It has no `mods` field in 0.2.0: a record carrying
`mods` (or any unknown field) fails with `unknown field "mods"` and a line
number. The kernel is shipped, but it is reachable **only** from a hand-written
hook row (`mods: [{ entry }]`) until the lock gains that field; this is not an
install path, and a lock record never loads mods silently.

To point the controller at a different lock (a project-local file, CI, a test
fixture), override the row in your profile's own `cordis.patch.yml`:

```yaml
- id: dsh-anyplugin
  config:
    installs: /absolute/path/installs.yml
    projectDir: /absolute/path/to/workspace
```

`grants` defaults to `grants.yml` next to the lock; `home` defaults to the
harness `dshHomePath`; `projectDir` defaults to the process working directory.

## 3. Enable the plugin

Installing a plugin does not by itself enable it: an install record that no
enabled layer mentions stays inert. `install` enables it at `--scope` in the
same run; `enable` and `disable` edit one existing layer:

```bash
npm run rig -- enable claude-code:my-plugin --scope project
npm run rig -- disable claude-code:my-plugin --scope project
```

Without `--scope`, the command edits the narrowest layer that already mentions
the plugin, and falls back to `user`. `disable` writes `enabled: false`; it
never deletes the record. If a narrower layer still decides the other way, the
command prints a warning naming that layer, because `list` reports the
*effective* state, not the line just written:

```bash
npm run rig -- list        # name, dialect, root, version, pin, enabled scopes, carry counts
```

Enablement is layered, narrowest first — `local` overrides `project`, `project`
overrides `user` — and the controller only reconciles what is enabled:

| scope | file |
| --- | --- |
| user (all projects) | `$DSH_HOME/anyplugin/enabled.yml` |
| project | `<project>/.dsh/anyplugin.yml` |
| local (this checkout) | `<project>/.dsh/anyplugin.local.yml` |

```yaml
# $DSH_HOME/anyplugin/enabled.yml
plugins:
  claude-code:my-plugin: { enabled: true }
```

The id is `<dialect>:<name>`, the same identity as in the lock. Setting
`enabled: false` disables an install for that scope without editing the lock.
On the next boot the controller compiles every enabled plugin and reconciles the
loader: created rows are logged, removed rows are disposed, and unchanged rows
are kept without writing.

## 4. Trust gate for `exec` artifacts

Hooks (and any future `monitor`, `bin`, or `mod`) are `exec`-class: they run
commands, so they are **off by default**. Compiling such a plugin without a
grant leaves the hook out and records a refusal with the exact command line; the
rest of the plugin still loads. Grants are pinned to the artifact's SHA-256, so
editing the hook invalidates the grant and asks again.

Grants live in `$DSH_HOME/anyplugin/grants.yml` (canonical form, keyed by
`plugin`, `capability`, `target`, `artifactHash`, `grantedAt`, `scope`). Grant
issuance is `rig grant`'s job: it prints the target, mode, hash and exact
command line before writing with `--yes`, and `install` never grants one for
you. A hand-written grant is only acceptable when you have read the command
line in the refusal log and accept it. A grant for a different byte sequence
does nothing.

## 5. Remove it

Removing the bundle and removing a plugin are different operations:

```bash
# remove the bundle from the profile
dsh plugin --profile <profile> remove dsh-anyplugin
# and delete "dsh-anyplugin" from dsh.profile.bundles (or toggle it off in the UI)
```

On the next boot the controller is gone, so no `anyplugin.` rows are created;
the `anyplugin.` entries from the previous boot are not part of the profile and
are not loaded. Deleting `$DSH_HOME/anyplugin/` removes the lock, grants and
enablement layers together.

To remove **one plugin** while keeping the bundle, run
`npm run rig -- uninstall <plugin>` (it prints the record it removes, the
scopes that still mention it, and the entry-tree group it no longer wants), or
set `enabled: false` in the layer that enabled it. The entry disappears on the
next reconcile — `uninstall` itself does not talk to a live loader, so it
reports the desired-tree diff and the boot applies it. On the next boot the
reconciler removes that plugin's group and all of its children. Deleting the
record from `installs.yml` by hand has the same effect; the writer is only
canonical, not privileged.

## 6. What is verified, not just claimed

`npm run verify` needs a harness tree, like the rest of the suite: fetch one
with `node scripts/fetch-harness.mjs 0.2.2-rc.5` and point `DSH_HARNESS_DIR`
at it (or use `DSH_INSTALL_DIR`). Without one the smoke fails instead of
skipping, which is the same rule the rest of `verify` follows.

It builds the tarball and runs an install smoke: it extracts the
packed tarball into a scratch profile, composes the published
`cordis.patch.yml` with the harness's own `composeEntries`, creates the row
through the real loader, reconciles a fixture lock, and asserts the fixture's
skill is listed by the harness skill registry. The smoke fails if `lib/` is
missing or a published subpath does not resolve, so a package that would not
install cannot be published.

The profile path has its own test:
`packages/dsh-anyplugin-conformance/test/profile-mount.test.mjs` boots a scratch
profile through the host's `loadProfile` → `readProfilePatches` → `boot` (the
launcher's primitives, in the launcher's order, including the profile's
`package.json`, the bundle's `cordis.patch.yml` and an empty profile root
`cordis.yml`) and asserts the controller's resolved module URL is inside the
profile's `node_modules`, never this checkout. It also pins the three negatives
the smoke cannot: no lock and a disabled plugin mount nothing, and a corrupt
lock is a typed controller failure while the harness still boots. Where the
host's `PluginPackages` interception cannot initialize (Node 24.12.0 and
24.22.2 in this sandbox), the test links the harness scope into the profile and
reports that in its diagnostic; `docs/ARCHITECTURE.md` §10 S17 records the
limitation and the evidence. The test needs Node 22.15 for
`module.registerHooks` (the published engine floor stays 22.14) and skips with
that reason otherwise.

The same smoke then loads real mods through the **packaged** hook entry, so the
kernel is proven from the tarball and not only from `lib/`: it needs
`ANYPLUGIN_MODS_TREE` (fetch it with `node scripts/fetch-mod.mjs`; the smoke
never reaches the network) and the Node flag above. It runs one real turn per
proof — the pinned upstream `sec-default` (45 registrations) beside a classic
hook, a `$` round-trip through the headless bridge (including a classic-pragma
`.tsx` module), and a mod deny at `tools/pre-execute`. A real `npm install` of
the tarball also pulls the kernel's two declared Babel packages (60 packages,
~35 MB); the smoke links the checkout's copies so its proof stays offline, and
its dependency claim is narrow — the packaged hook entry imports the declared
packages at the declared versions. Publishing itself is gated the same way: the
release workflow accepts only a `v*` tag whose commit is an ancestor of
`origin/main`, runs `npm run verify` against both DSH pins, and only then
calls `npm publish`. A tag on a branch commit cannot publish.

See [`README.md`](README.md) for the fidelity
contract and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.
