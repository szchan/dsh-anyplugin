# marketplace-local

Hand-authored fixture for `rig marketplace list|install` (ticket #117).

**Provenance (D14):** every file here was written by hand for this repository.
Nothing is copied from an upstream marketplace, plugin or documentation page.
The catalog only borrows the *shape* both ecosystems document (Claude's
`.claude-plugin/marketplace.json`, Codex's `.agents/plugins/marketplace.json`),
which is a specification, not an artifact.

It is deliberately three entries, one per outcome this slice has to get right:

| entry | source | outcome |
| --- | --- | --- |
| `local-hello` | `./plugins/local-hello` | installable; a skill plugin that emits one skill |
| `remote-helper` | `{ "source": "url", … }` | listed, then refused as unsupported (fetch + hash pin + consent, D27) |
| `broken-entry` | none | a recorded problem with a line number, never a crash |

The catalog also carries two fields this slice does not consume — the top-level
`owner` and `local-hello`'s `author` — so `list` has to record them as notes
rather than pretend they do not exist or fail on them.
