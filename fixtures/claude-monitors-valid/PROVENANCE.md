# claude-monitors-valid — provenance

Observed, not invented. The `.inventory` golden was captured at
`claude-code@2.1.329` with the pinned binary:

```bash
CLAUDE_BIN=.claude-code/2.1.329/node_modules/@anthropic-ai/claude-code-linux-x64/claude \
  node packages/dsh-anyplugin-conformance/src/rig.ts capture \
  --plugin fixtures/claude-monitors-valid
```

`claude --plugin-dir fixtures/claude-monitors-valid plugin details monitors-valid`
prints `Skills (1)  greet` and **no** Monitors row: the client validates the
declaration but never inventories it. That is the S22 finding
(`spikes/s22-monitors/REPORT.md`, D37), so the golden deliberately contains one
`skills/greet` component and nothing for `monitors/`. Adding a monitor row here
would invent an observation the client does not make.

The declaration is valid under the client's own schema: one entry with `name`,
`command`, `description` and `when: on-skill-invoke:greet` — the skill this
fixture also carries, so the `on-skill-invoke` form is exercised end to end.

| Tool | Pin | Source of the claim |
| --- | --- | --- |
| `claude` | `2.1.329` | `spikes/s22-monitors/captures/loader/plugin-list.txt`, re-probed for this capture |
