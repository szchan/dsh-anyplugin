# claude-monitors-bad-when-enum — provenance

The client's own bytes, not the docs.

| Tool | Pin | Evidence |
| --- | --- | --- |
| `claude` | `2.1.329` | `spikes/s22-monitors/captures/loader/plugin-list.txt` (bad-when-enum: `invalid_format` + custom `on-skill-invoke:` error on `when`) |
| `claude` | `2.1.329` | directory form re-probe: `plugin details` exits 0, no component rows; `plugin list` says `✘ loaded with errors` |

Declaration: `when: "sometimes"`. The client's union accepts only `always` or
`on-skill-invoke:<non-empty skill>`; this fixture proves this layer reports the
same value as `unsupported` with the field path and the client's error, instead
of refusing the plugin the directory client still loads.

Golden: captured with `node packages/dsh-anyplugin-conformance/src/rig.ts
capture --plugin fixtures/claude-monitors-bad-when-enum` at the pin above.
