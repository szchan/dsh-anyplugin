# Installing `dsh-anyplugin`

`dsh-anyplugin@0.1.0` is the first published release. It is **one bundle** whose
patch inserts **one row** — the controller. Everything else (skills, commands,
MCP servers, hooks, agents, an activated output style) is created at runtime by
reconciling the lock file
`installs.yml`; the package writes no profile config and generates no code.

What 0.1.0 ships:

| surface | state in 0.1.0 |
| --- | --- |
| Skills | loaded into the harness skill registry |
| Slash commands | model face (`equivalent`); the human face is still `planned` |
| MCP servers | stdio and Streamable HTTP, Claude's tool names kept verbatim |
| Hooks | the events the host actually fires; `exec`-class hooks need a grant |
| Agents | one scoped tool per `agents/*.md` |
| Output styles | activated from `$DSH_HOME/anyplugin/output-styles.yml` (one style, `agent/created`); the `/<plugin>:<name>` command face stays `planned` (D42) |
| `mods` | **not shipped** in 0.1.0 (the mods kernel is v0.2) |
| Codex plugins | **not shipped** in 0.1.0 (v0.3) |

## Requirements and the version claim

- **Node.js ≥ 22.14** (`engines.node`).
- **DSH `^0.2.2-rc.2`** (`engines.dsh`). The bundle is tested against
  `0.2.2-rc.2` and `0.2.2-rc.5`; `engines.dsh` is what the harness's
  compatibility check enforces, so an incompatible runtime refuses the plugin
  instead of half-loading it. `@deepseek-ai/cordis` is a peer at `~4.1.0`, the
  version both pins ship.
- **Claude Code `2.1.329`** for the plugin format the compiler reads. Every
  record in `installs.yml` must carry `pin: "claude-code@2.1.329"`; a record
  naming a different pin is rejected rather than silently re-interpreted.
- A Claude Code plugin directory (one with `.claude-plugin/plugin.json`) on
  disk. 0.1.0 compiles from a local directory; it does not fetch plugins.

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
`dsh-anyplugin` and its five `dsh-anyplugin/materialize/*` subpaths, which is
exactly what `dsh plugin add` (pnpm in the profile) provides.

## 2. Tell the controller which plugins to run

The controller reads `$DSH_HOME/anyplugin/installs.yml` at boot. In 0.1.0 the
installer that usually writes this file ships as a library, not a CLI, so write
the canonical form by hand. A missing file means "no installs"; a malformed one
fails the boot with a line number — it never silently uninstalls anything.

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
```

`root` must be absolute and point at the plugin directory; `dataDir` is the
plugin's private data directory (created by you; the controller does not create
it in this release). `name` and `version` are the identity in the lock; the
model-facing ids are namespaced under `anyplugin.` and cannot collide with the
profile's own rows.

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

Installing a plugin is not enabling it: an install record that no enabled layer
mentions stays off. Enablement is layered, narrowest first — `local` overrides
`project`, `project` overrides `user` — and the controller only reconciles what
is enabled:

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
issuance is the installer's job; in 0.1.0 write the grant by hand only when you
have read the command line in the refusal log and accept it. A grant for a
different byte sequence does nothing.

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

To remove **one plugin** while keeping the bundle, delete its record from
`installs.yml` (or set `enabled: false` in the layer that enabled it). At the
next boot the reconciler removes that plugin's group and all of its children.

## 6. What is verified, not just claimed

`npm run verify` builds the tarball and runs an install smoke: it extracts the
packed tarball into a scratch profile, composes the published
`cordis.patch.yml` with the harness's own `composeEntries`, creates the row
through the real loader, reconciles a fixture lock, and asserts the fixture's
skill is listed by the harness skill registry. The smoke fails if `lib/` is
missing or a published subpath does not resolve, so a package that would not
install cannot be published. See [`README.md`](README.md) for the fidelity
contract and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.
