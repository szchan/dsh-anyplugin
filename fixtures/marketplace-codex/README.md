# marketplace-codex

Hand-authored Codex (Agent Plugins 1.0.0) marketplace fixture; see
[PROVENANCE.md](./PROVENANCE.md) for the page, the date it was read, and the
implemented field list. Nothing here is copied from an upstream repository.

- `.agents/plugins/marketplace.json` — the Codex catalog. Local entries resolve
  from this directory (the marketplace root), not from `.agents/plugins/`.
- `plugins/hello/plugin.json` — a portable root manifest, so the `hello` entry
  installs under `dialect: codex`.
- `both/` — one root with a Claude catalog and a Codex catalog; used to prove
  that `list` labels each row's format and `install` refuses a name declared in
  both instead of picking one.
