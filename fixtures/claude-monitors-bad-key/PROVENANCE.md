# claude-monitors-bad-key — provenance

The client's own bytes, not the docs.

| Tool | Pin | Evidence |
| --- | --- | --- |
| `claude` | `2.1.329` | `spikes/s22-monitors/captures/loader/plugin-list.txt` (bad-extra: `unrecognized_keys`, `keys: ["trigger"]`) |
| `claude` | `2.1.329` | directory form re-probe: `plugin details` exits 0 and lists `Skills (1) innocent`; `plugin list` says `✘ loaded with errors` |

Declaration: one monitor with an extra `trigger: "always"` next to the four
accepted keys (`name`, `command`, `description`, `when`). The client's schema is
strict, so it reports the monitor load as failed; it still serves the plugin's
skill. This fixture proves this layer carries the declaration as `unsupported`
and installs the skill the directory client serves.

Golden: captured with `node packages/dsh-anyplugin-conformance/src/rig.ts
capture --plugin fixtures/claude-monitors-bad-key` at the pin above; the
components are exactly the ones `plugin details` lists.
