# Provenance: the Codex marketplace fixtures

Hand-authored from the Codex (Agent Plugins 1.0.0) marketplace specification at:

- <https://developers.openai.com/plugins/build/plugins> — read 2026-11-21
- <https://developers.openai.com/plugins/build/plugins.md> — the Markdown rendition of the same page, read 2026-11-21

No upstream JSON file is vendored here. Every catalog and plugin in this
directory is hand-authored to the field list below, so a change to an upstream
fixture cannot silently change what these tests assert (D45's hand-authored
golden rule).

## Fields implemented

The page's field list, quoted from the fetched Markdown (2026-11-21):

- top level: `name`, `interface.displayName`, `plugins[]`
- entry: `name`, `source`, `policy.installation`, `policy.authentication`, `category`
- `source` object kinds: `local` (`path`), `url` (`url`), `git-subdir`
  (`url`, `path`, and optionally `ref` or `sha`), `npm` (`package`, and
  optionally `version` and `registry`)
- a local entry's `source` may also be a plain string: "For local entries,
  `source` can also be a plain string path such as `"./plugins/my-plugin"`."
- `policy.installation` is, for example, `AVAILABLE`,
  `INSTALLED_BY_DEFAULT` or `NOT_AVAILABLE`; `policy.authentication` is `ON_INSTALL` or first use.
  The page says to always include both, plus `category`.
- `source.path` is relative to the marketplace root (not to `.agents/plugins/`)
  and must start with `./` and stay inside the root.
- the file lives at `$REPO_ROOT/.agents/plugins/marketplace.json` (repo) or
  `~/.agents/plugins/marketplace.json` (personal); the Claude catalog at
  `$REPO_ROOT/.claude-plugin/marketplace.json` is the legacy-compatible one.

`fixtures/marketplace-codex/.agents/plugins/marketplace.json` exercises the
object-local, string-local, `url`, `git-subdir` (with `sha`) and `npm` (with an
exact `version`) shapes, `policy.installation: NOT_AVAILABLE`, a local path that
escapes the root, and three entries that do not match the Codex shape
(`github` — a Claude kind; `description` — a Claude entry field; and a policy
missing `authentication`). The page says to include `policy.installation`,
`policy.authentication` and `category` on every entry, so a Codex entry that
omits `policy` or `category` is refused too; the tests cover both refusals and
a malformed declaration that duplicates a name across the two files. `fixtures/marketplace-codex/both/` carries one
catalog of each format in one root, with the name `shared` declared in both, so
the ambiguity rule is a fixture and not only a unit test.

## What this slice does not carry

- A Codex `url` source is carried as the same `url` kind the Claude slice
  fetched before D53: an HTTPS/file tarball with a `sha256:` content address.
  The page describes git-backed `url` entries and permits `ref`/`sha` on them;
  this slice's `url` fetch does not, so a Codex `url` entry with `ref` or `sha`
  is refused naming `source.ref`/`source.sha` rather than silently fetching the
  default branch. `git-subdir` carries both selectors.
- `npm.registry` is a documented source field and is not carried by the fetch
  slice (it would let the catalog choose a non-default registry); a Codex entry
  that declares it is refused naming `source.registry`.
- `interface.displayName` is carried and printed; the rest of `interface` is
  not, and is a note because it is display-only.

## Page versus D33

D33 ratifies the portable *plugin manifest* at Agent Plugins 1.0.0 (schema URL,
MCP budget, the `extensions.com.openai` replacement). It does not describe the
marketplace catalog, so it does not disagree with the page here. There is no
Codex client in this repository and none available offline: unlike the Claude
dialect (whose client is the oracle), this reader has only the published page
and the hand-authored fixture, and says so (D37/S22's docs-are-data rule, with
no client to prefer over the page).
