# claude-monitors-bad-when-short

Observed at `claude-code@2.1.329`, through the directory load path that
`rig install <dir>` mirrors. `claude --plugin-dir fixtures/claude-monitors-bad-when-short
plugin list` reports

```
Status: ✘ loaded with errors
Error: monitors load failed from .../monitors/monitors.json: [ { "code": "custom", "path": [ 0, "when" ], "message": "on-skill-invoke: must specify a skill name" } ]
```

while `plugin details` exits 0 with no component inventory. The `.inventory`
golden therefore has `components: []` and no Monitors row (S22).

The S22 marketplace capture prints `Status: ✘ failed to load` for the same
declaration; this layer mirrors the directory form, records the declaration as
one `unsupported` row with the client's error text, and does not fail the
plugin (`packages/dsh-anyplugin-dialect-claude-code/test/monitors.test.mjs`).
