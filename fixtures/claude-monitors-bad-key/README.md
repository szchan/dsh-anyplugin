# claude-monitors-bad-key

Observed at `claude-code@2.1.329`, through the directory load path that
`rig install <dir>` mirrors. `claude --plugin-dir fixtures/claude-monitors-bad-key
plugin list` reports

```
Status: ✘ loaded with errors
Error: monitors load failed from .../monitors/monitors.json: [ { "code": "unrecognized_keys", "keys": [ "trigger" ], "path": [ 0 ], "message": "Unrecognized key: \"trigger\"" } ]
```

while `plugin details` exits 0 and still serves the sibling skill
(`Skills (1)  innocent`). The `.inventory` golden records what that path serves;
there is no Monitors component because `plugin details` never lists one (S22).

The S22 marketplace capture (`spikes/s22-monitors/captures/loader/plugin-list.txt`)
prints `Status: ✘ failed to load` for the same declaration. The two load paths
diverge at this pin and this layer mirrors the directory form: the declaration
becomes one `unsupported` row and the skill still compiles, which
`packages/dsh-anyplugin-dialect-claude-code/test/monitors.test.mjs` and
`packages/dsh-anyplugin-install/test/compile.test.mjs` assert.
