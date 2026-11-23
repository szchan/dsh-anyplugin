# Installing `dsh-anyplugin`

`dsh-anyplugin@0.3.0` is this release. It is
**one bundle** whose
patch inserts **one row** — the controller. Everything else (skills, including
commands on their model face, MCP servers, hooks, agents, an activated output
style) is created at runtime by reconciling the lock file
`installs.yml`; the package writes no profile config and generates no code.

What 0.3.0 ships:

| surface | state in 0.3.0 |
| --- | --- |
| Skills | loaded into the harness skill registry |
| Slash commands | land as **skills** on their model face (`equivalent`); the human `/…` face is still `planned` (D10) |
| MCP servers | stdio and Streamable HTTP; DSH namespaces the callable name (`mcp__plugin_<plugin>_<server>__<tool>`), keeping Claude's as the suffix |
| Hooks | the events the host actually fires; `exec`-class hooks need a grant |
| Agents | one scoped tool per `agents/*.md` |
| Output styles | activated from `$DSH_HOME/anyplugin/output-styles.yml` (one style, `agent/created`); the `/<plugin>:<name>` command face stays `planned` (D42) |
| `mods` | loadable through the lock: a `mods` entry pins the authored module tree (`dsh-anyplugin/installs@2`), `dsh-anyplugin install` writes it, `dsh-anyplugin list` names the entry and tree digest, and the tree runs only under a hash-pinned grant (D25/D30/D31/D34). Node's `--experimental-vm-modules` is required |
| Codex plugins | `equivalent`: `plugin.json` 1.0.0 + `skills/` + `mcp.json`, installed from a local directory like a Claude plugin; there is no Codex oracle, so the fixture is the specification (D33) |

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
  disk. 0.3.0 compiles from a local directory; it does not fetch plugins.

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

The same row also serves the panel (D77). When the profile has a web server,
the browser loads `lib/client.js` from this install and Settings → AnyPlugin
lists and installs plugins over the loopback routes, through the same
`installPlugin` the CLI calls. There is no second package to add or publish.

Commands are not a sixth subpath: a slash command lands as a **skill** on its
model face (`equivalent`). The human `/…` face is still `planned` and needs
the host command-name seam (D10); wiring it is not part of 0.3.0.

## 2. Install and enable a plugin

The installer ships in this package as the `dsh-anyplugin` command: the
published `lib/cli.js` is the conformance rig's own CLI
(`packages/dsh-anyplugin-conformance/src/rig.ts`), so the npm artifact and the
checkout run one command surface. Nothing here needs a DSH installation —
`--help` and `install <dir> --dry-run` need only Node. The conformance gates
(`capture`, `verify`, `diff`, `trace`) are the exception: they read a pinned
harness and name `CLAUDE_BIN`, and the Claude oracle and trace differ are not
shipped, so the published bin refuses them with `needs the repository
checkout` and points at `npm run rig --` from a clone. Run the published
command with `npx` (the examples name the command, not the version; pin it as
`npx dsh-anyplugin@0.3.0 …` when the run must be reproducible):

```bash
npx dsh-anyplugin install <plugin-dir> [--scope user|project|local] [--name <name>] [--dialect claude-code|codex] [--force] [--allow-empty] [--dry-run] [--json]
npx dsh-anyplugin list [--json]
npx dsh-anyplugin enable <plugin> [--scope user|project|local] [--dry-run] [--json]
npx dsh-anyplugin disable <plugin> [--scope user|project|local] [--dry-run] [--json]
npx dsh-anyplugin uninstall <plugin> [--dry-run] [--json]
```

When the package is installed (globally, or in the profile's `node_modules`),
the same command is the installed binary: `dsh-anyplugin install …`. The second
option is for development in this repository, where the source entry needs no
build and takes the identical flags:

```bash
npm run rig -- install <plugin-dir> [--scope user|project|local] [--dry-run] [--json]
npm run rig -- list [--json]
```

`install` reads `<plugin-dir>` with the dialect detected from its manifest
(`.claude-plugin/plugin.json` → `claude-code`; a root `plugin.json` or
`.codex-plugin/plugin.json` → `codex`, overridable with `--dialect`), compiles
it through the same report path as `dsh-anyplugin report`, and writes exactly
one record to `$DSH_HOME/anyplugin/installs.yml` through the canonical lock
writer. It then enables the plugin in the layer named by `--scope` (default `user`), but
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

A mod is granted before it is installed. `dsh-anyplugin report <plugin-dir>` (or
an install that refuses) names the entry and the tree digest, e.g.
`mods/hooks/register.ts refused:exec (entry: hooks/register.ts (606 files, tree
sha256:…))`; `dsh-anyplugin grant --plugin <plugin-dir> --grants
$DSH_HOME/anyplugin/grants.yml` prints the same entry and digest and writes only
with `--yes`; the next `dsh-anyplugin install <plugin-dir>` records the tree in
`installs.yml`. `dsh-anyplugin revoke ...` with
`--target mod:hooks/register.ts` works after `uninstall` too.

What `install` does **not** do:

- It does not touch `PATH`; a plugin is data the controller reconciles, not an
  executable shim.
- It does not write profile config. Adding the bundle to a profile is still
  `dsh plugin add` in §1; the installer only writes `installs.yml`, the scope
  layer named by `--scope`, and (through the controller) `grants.yml`.
- It does not rewrite a mod. The tree is loaded as authored (D30; `.tsx` is the
  one declared transform, D34), and the lock pins every file under the plugin
  root except `.git/`, `node_modules/` and the plugin data directory. A later
  edit moves the tree hash and the old grant no longer applies; a file added
  later changes the file set, so the materializer refuses the load instead of
  running a tree the grant never saw.
- It does not seat an ungranted mod. A plugin whose only surface is a refused
  module is refused by default (the refusal names the entry and tree digest) and
  can be recorded with `--allow-empty`; nothing reaches `loadMod` without the
  pinned grant.
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
schema: "dsh-anyplugin/installs@2"
plugins:
  - dialect: "claude-code"
    name: "my-plugin"
    version: "1.2.3"
    root: "/absolute/path/to/my-plugin"
    dataDir: "/absolute/path/to/dsh-anyplugin-data/my-plugin"
    pin: "claude-code@2.1.329"
    source: "plugin-dir:plugins/my-plugin"
    mods:
      - entry: "hooks/register.ts"
        rootRelative: "hooks"
        mode: "composite"
        artifactHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        files:
          - path: "hooks/register.ts"
            sha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
            bytes: "33891"
          - path: "hooks/views/pane.ts"
            sha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
            bytes: "1024"
```

`root` must be absolute and point at the plugin directory; `dataDir` is the
plugin's private data directory. It is created by the hook materializer when
at least one hook is emitted (a hook needs a grant first); the controller only
reads the record, so a plugin with no emitted hooks and a missing directory is
not an error. `name` and `version` are the identity in the lock; the
model-facing ids are namespaced under `anyplugin.` and cannot collide with the
profile's own rows.

A `mods` entry is the plugin tree, hashed as one artifact. `entry` is the
plugin-relative loader entry and `rootRelative` the directory Claude resolves
it from (`hooks/` at this pin); `files` lists every file under the plugin root
except `.git/`, `node_modules/` and the plugin data directory, with its
plugin-relative path, sha256 and byte count, so the digest does not depend on a
checkout location. `mode` is `file` when the tree holds exactly one file and
`composite` otherwise; the invocation is the entry and there is no command line.
The files are framed in ascending plugin-relative path order before hashing — a
*derived* rule: D25 fixes code-as-manifest and says order matters, and sorted
paths are our definition for a tree, not an upstream one. A symlink whose real
path leaves the plugin root, or a directory symlink, is refused when the tree is
scanned. `dsh-anyplugin grant` prints the entry and the tree digest before
writing with `--yes`; without that grant the tree stays `refused:exec`.

The lock schema is strict, and it is versioned. `dsh-anyplugin/installs@2` adds
`mods` as a first-class field with the shape above; an unknown field (including
a mis-shaped `mods` entry) fails with an `unknown field`/validation message and
a line number. A `@1` file still loads — it has no mods, so it reads as one with
`mods` absent, and the next write normalizes it to `@2`. That is the downgrade
story stated rather than hidden: a 0.1.x reader given a `@2` file carrying
`mods` refuses it with `unknown field "mods"` and the line, instead of silently
dropping the module.

### Installing by name from a marketplace

Both ecosystems describe a catalog of plugins; one normalizer reads both. A
`local` source installs from the catalog tree; `url`, `git-subdir` and `npm`
sources are fetched into a content-addressed cache under a per-fetch `network`
grant:

```bash
npx dsh-anyplugin marketplace list --from <file> [--json]
npx dsh-anyplugin marketplace install <entry> --from <file> [--scope user|project|local] [--yes] [--dry-run] [--json]
```

`--from` accepts Claude's `<root>/.claude-plugin/marketplace.json`, Codex's
`<root>/.agents/plugins/marketplace.json` (and the Claude file as Codex's
legacy-compatible fallback), or any file that holds the same document: one
normalizer reads both, so a catalog does not declare which ecosystem wrote it.
`list` prints name, description, source kind, target and policy per entry, and
names every malformed entry by index, name and line — one bad entry does not
take the catalog down. Unknown fields are reported as notes, not dropped
silently and not fatal. A malformed entry makes `list` exit 1 after printing
the readable entries; a remote entry is a valid row, not a malformed one.

`install` resolves a `local` source (`"./"`-relative, or `"."` for the catalog
root; `.agents/plugins/` catalog paths resolve from the marketplace root, not
from the catalog's own directory), refuses any target that resolves outside
that root — including through a symlink — and then calls the same
`installPlugin` path as `dsh-anyplugin install <dir>`. The lock record, the
enablement decision, the refusals and `--dry-run` are therefore byte-for-byte
the ones a directory install produces, except for the record's `source`:

```yaml
    source: "{\"marketplace\":\"my-marketplace\",\"entry\":\"my-plugin\",\"version\":\"1.2.3\"}"
```

A structured provenance lives inside the canonical double-quoted JSON string,
because D23 already defines every value that way: the grammar does not move (the
schema moved to `@2` for `mods`, not for this field), so a reader that only
requires `source` to be a non-empty string still reads the file. A fetched entry also
records what it resolved to, so a later install can tell the pin moved:

```yaml
    source: "{\"marketplace\":\"my-marketplace\",\"entry\":\"git-plugin\",\"version\":\"1.2.3\",\"integrity\":\"git:<40-hex commit>\",\"resolvedAt\":\"2026-11-21T12:00:00.000Z\"}"
```

`integrity` is `git:<commit>`, `npm:<sha512 of the packed tarball>` or
`sha256:<sha256 of the downloaded bytes>`; `resolvedAt` records when the bytes
were first fetched. Two installs of the same resolved commit or tarball produce
the same `integrity`, and re-installing the same bytes keeps the lock
byte-identical. The pair must appear together, and the field needs no schema
change of its own — the object lives inside the existing canonical string
(`@2` exists for `mods`).

`github`, `archive` and `command` entries are valid catalog rows but are
refused as `unsupported-marketplace-source`: each names the missing piece and
points at the follow-up slice.

`policy.installation` is enforced, not just printed: an entry declaring
`"NOT_AVAILABLE"` is refused by `install` with a typed
`marketplace-entry-not-available` naming the file, the entry and the policy,
even when its source is local. The other Codex values (`AVAILABLE`,
`INSTALLED_BY_DEFAULT`) install by name. An entry name the catalog declares
twice is refused rather than resolved to the first match: `list` reports the
duplicate and exits 1, and `install` refuses with
`ambiguous-marketplace-entry`.

The catalog's `version` is provenance, not the record's version: when the entry
and the artifact's `plugin.json` disagree, the record keeps the artifact's
`version`, `source.version` keeps the catalog's, and `install` prints a note
naming both.

### Remote entries: fetch, integrity, consent

`url`, `git-subdir` and `npm` sources are fetched, never read from the catalog
tree. Fetching is `network`-class (D27): the exact command is printed and the
install refuses with `network-consent-required` unless passed `--yes`:

```
refused (network-consent-required): entry "my-marketplace:git-plugin" is
fetched, not read: git fetch --depth=1 https://example.invalid/plugin.git main
  hint: re-run with --yes to fetch it and record a network grant pinned to the
  resolved bytes; this grant never authorizes exec/mod
```

`--yes` records a `network` grant in `grants.yml` whose target is the exact
source spec and whose `artifactHash` is the resolved integrity. A later run
without `--yes` uses that grant. The grant is written only after the install
succeeds, so a fetch followed by a refused install leaves no standing network
authorization. The URL in a grant target drops credentials and the query; a
query string is represented by an opaque fingerprint (`#q=<16 hex>`), so
`?token=a` and `?token=b` are different grants and consent for one never
fetches the other. `dsh-anyplugin revoke --grants <file> --plugin-id
<marketplace:entry> --target <target> --capability network [--scope <s>]`
revokes one record by target. When a floating `ref` (for example `main`)
resolves to a new commit, or a tarball's bytes change, the install refuses with
`network-pin-moved` naming both the recorded and the resolved identity before
anything new is installed, and exits 1; passing `--yes` accepts the new pin,
updates the grant and reinstalls. A revoke at the install's scope is final:
`--yes` does not override `network-consent-revoked`. A `network` grant is
capability-scoped — it never authorizes `exec`, `hook`, `monitor`, `bin` or
`mod`, which still go through the ordinary trust gate.

`--dry-run` fetches nothing: it prints the exact command, the consent state and
the target, writes no lock, layer, grant or cache entry, and exits 0. The tests
assert the cache directory does not exist afterwards. Because no fetch happens,
the preview cannot know the current bytes: it prints `integrity: unknown` (plus
the hash an existing grant pins) rather than claiming the pin still matches.

Grant records are scope-ranked, not scope-filtered: `--scope` does not narrow
which record applies. The narrowest matching record decides, so a project-scope
network grant also authorizes a `--scope user` install, and a project-scope
revoke blocks a user-scope `--yes`. Keep marketplace grants and revokes at one
scope when both directions must be predictable.

Fetch rules:

- `https://` and `file://` only; `http://` is a typed
  `insecure-marketplace-source` refusal before any request is made. A URL that
  carries credentials is refused, and every printed URL drops userinfo and
  query strings. A redirect must stay on the origin the catalog named (same
  scheme, host and port); a cross-origin hop is refused before the second
  request, because consent names an origin and an artifact, not whatever host a
  redirect picks.
- `git-subdir` runs a shallow `git fetch` with a fixed argv (no submodules, no
  terminal prompts) and a literal `--` before the repository and ref, checks
  out the resolved commit or the requested `sha`, and refuses a `path` that
  escapes the repository or is absent. `source.ref` must be a plain git ref
  (no leading `-`, no `..`, `@{`, control characters or `.lock` suffix);
  `git fetch` passes a local transport's `upload-pack` through a shell, so an
  option-shaped ref would be code execution. When both `sha` and `ref` are
  present, `sha` is the pin and `ref` is advisory: the fetch checks out `sha`,
  and `ref` is not verified for ancestry.
- A git checkout that contains a symbolic link is refused
  (`marketplace-fetch-refused`): the tar extractor already refuses links, and
  the same artifact should not be trusted differently because of its transport.
- `npm` packs with `--ignore-scripts`, so a `prepare` or `postinstall` in the
  package never runs; a registry spec must pin an exact `version` (no
  `latest`, no ranges), and a package with no plugin manifest after extraction
  is refused.
- `url` must return a gzipped tarball; the download is capped at 20 MiB and
  five redirects, hashed before extraction, and extracted with the same
  traversal checks as the other kinds. Tar members are refused when they are
  absolute, contain `..`, a backslash (win32's separator), a NUL, a drive
  prefix, or a path component ending in a dot or space (win32 drops those), and
  a duplicate file name is refused rather than last-wins. CI runs on ubuntu
  only, so the Windows-shaped traversal cases are tested on POSIX but the
  win32 path itself is unexercised.
- A fetched artifact is cached under
  `<lock-dir>/marketplace-cache/<marketplace>/<entry>@<resolved>/` with the
  metadata `kind`, `integrity`, `resolved`, `resolvedAt` and `version`. The
  cache directory is written only after the bytes were verified; a pinned sha
  or exact npm version can be reinstalled from it without touching the network.
  The sidecar also records a `contentHash` over the extracted files, and a
  reuse re-hashes the directory against it: a tampered cache is re-fetched (a
  pinned artifact) rather than trusted on its metadata alone.

The fetched directory then goes through the same `installPlugin` path as a
local one — the same dialect detection, report, refusals, enablement decision
and `--dry-run` — so there is still one install writer.

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
npx dsh-anyplugin enable claude-code:my-plugin --scope project
npx dsh-anyplugin disable claude-code:my-plugin --scope project
```

Without `--scope`, the command edits the narrowest layer that already mentions
the plugin, and falls back to `user`. `disable` writes `enabled: false`; it
never deletes the record. If a narrower layer still decides the other way, the
command prints a warning naming that layer, because `list` reports the
*effective* state, not the line just written:

```bash
npx dsh-anyplugin list  # name, dialect, root, version, pin, enabled scopes, carry counts
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

Hooks, `monitor`/`bin` files and `mods` are `exec`-class: they run code, so
they are **off by default**. Compiling such a plugin without a grant leaves the
artifact out and records a refusal with the exact command line (for a mod: the
resolved entry, the file count and the tree digest); the rest of the plugin
still loads. Grants are pinned to the artifact's SHA-256, so editing the hook —
or any file under a granted module tree — invalidates the grant and asks again.
The materializer re-lists the plugin tree and reads the pinned files once,
then hands those bytes to the loader as a snapshot; the loader and linker
compile the snapshot, never the path, so a change between the gate and the load
cannot run (a tree over 64 MiB is refused). The same snapshot bounds the
linker: a module that imports a file outside the manifest is refused
(`ERR_MOD_HOST_UNGRANTED`) rather than evaluated.

Grants live in `$DSH_HOME/anyplugin/grants.yml` (canonical form, keyed by
`plugin`, `capability`, `target`, `artifactHash`, `grantedAt`, `scope`). Grant
issuance is `dsh-anyplugin grant`'s job: it prints the target, mode, hash and
exact command line — or, for a mod, the resolved entry and tree digest —
before writing with `--yes`, and `install` never grants one for you. A hand-written
grant is only acceptable when you have read the entry in the refusal log and
accept it. A grant for a different byte sequence does nothing. The hook row's
`mods` config is written by the controller from the granted lock record; a row
the lock does not record is refused as `not-recorded` even when a grant
exists (a `@1` lock boots no mod until it is reinstalled as `@2`), and a row
edited by hand is refused unless it carries a pin that matches on re-read. That
is a byte check, not a consent check: a hand-edited row that recomputes a
consistent pin is indistinguishable from the controller's, so the consent
boundary is the grant store plus the lock record, and you should not hand-edit a
hook row to add mods.

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
`npx dsh-anyplugin uninstall <plugin>` (it prints the record it removes, the
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
lock is a typed controller failure while the harness still boots. On a Node
where the host's `PluginPackages` interception initializes, the test asserts
that path instead: the profile has no harness scope link, the group entry's
module URL is under the installation tree, and a fallback fails the assertion.
Where it cannot initialize (Node 24.12.0 and 24.22.2 in this sandbox), the test
links the harness scope into the profile and reports that in its diagnostic;
under CI that fallback is a failure, so the gate cannot silently stop asserting
closure. `docs/ARCHITECTURE.md` §10 S17/S18 record the patch boundary (24.22.2
fails, 24.22.3 works) and the evidence. The test needs Node 22.15 for
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

`check:pack` also boots the artefact a user installs through a profile the way a
user's does: a scratch `$DSH_HOME` gets a profile whose `dependencies` name the
freshly packed local tarball, `npm install` (offline, from the cache `npm ci`
primed) installs it, and the same `mountProfile` the S17 test calls boots it
through `loadProfile` → `readProfilePatches` → `boot`. The gate asserts what the
boot saw: the controller entry active, the bundle patch applied, the
`anyplugin.claude-code…skills-only` group and its skill child active, and the
controller's module URL inside the scratch profile's `node_modules`. It fails
when the tarball lacks `cordis.patch.yml`, when `dsh.profile.bundles` does not
list the bundle, or when the package resolves from this checkout — each with its
own message, and those three mutations are tests in `profile-mount.test.mjs`.
The real `$DSH_HOME` and `$DSH_PROFILE_DIR` are fingerprinted before and after
(the Desktop host's own `$DSH_HOME/sessions/` and `$DSH_HOME/storages/` trees are
excluded from the home fingerprint only, and the exclusion is printed; a write
under `$DSH_PROFILE_DIR` is a violation), so a boot that touched the user's
profile fails. A root that does not exist is reported absent, which is what CI
prints for both. The install reads the repository lockfile to stay offline, so
this proves npm's install of this tarball into a profile, not registry metadata
resolution for its declared ranges; `docs/ARCHITECTURE.md` §10 S20 records both
sides.

See [`README.md`](README.md) for the fidelity
contract and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.
