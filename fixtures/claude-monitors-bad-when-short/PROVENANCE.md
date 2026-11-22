# claude-monitors-bad-when-short — provenance

The client's own bytes, not the docs.

| Tool | Pin | Evidence |
| --- | --- | --- |
| `claude` | `2.1.329` | `spikes/s22-monitors/captures/loader/plugin-list.txt` (bad-when-short: custom `on-skill-invoke:` error on `when`) |
| `claude` | `2.1.329` | directory form re-probe: `plugin details` exits 0, no component rows; `plugin list` says `✘ loaded with errors` |

Declaration: `when: "on-skill-invoke:"` with no skill name. The prefix alone is
the string the client rejects with a custom message; this fixture proves this
layer carries it as `unsupported` with that message rather than as an unnamed
gate.

Golden: captured with `node packages/dsh-anyplugin-conformance/src/rig.ts
capture --plugin fixtures/claude-monitors-bad-when-short` at the pin above.
