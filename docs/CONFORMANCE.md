# The conformance rig

The scoreboard. Nothing here is a translation feature; everything here exists so
"100 %" is a number a machine can produce.

## What it answers

> Given the same foreign plugin, does DSH expose the same observable surface as
> the host the plugin was written for?

It answers by comparing **inventories**: a normalized list of the components a
host reports for a plugin, captured from each host separately and diffed.

## Layering

```
foreign plugin dir
   ├─ upstream oracle   → claude --plugin-dir <dir> plugin details <name>
   └─ DSH oracle        → materialize via the compiler, then read the registries
                          (not built yet; the upstream half is live)
                       ↓
                normalized Inventory  →  diff  →  DiffReport
```

The upstream oracle never parses plugin directories. If we parsed them
ourselves we would be testing our reading of the documentation against itself.
Asking the installed host is the only way to catch documentation that has
drifted from behavior — which it already has (§ARCHITECTURE 10.3).

## Inventory

`src/inventory.ts`. JSON, `$schema: dsh-anyplugin/inventory@1`:

```json
{
  "$schema": "dsh-anyplugin/inventory@1",
  "plugin": { "name": "hooks-mcp", "version": "0.0.1" },
  "pin": { "tool": "claude-code", "version": "2.1.322" },
  "components": [
    { "surface": "hooks", "name": "PostToolUse", "details": { "note": "harness-only — no model context cost" } },
    { "surface": "mcpServers", "name": "probe", "details": { "note": "tool schemas resolved at runtime; not counted" } }
  ],
  "tokens": { "alwaysOn": { "value": 0 } }
}
```

`normalizeInventory` trims, dedupes by `(surface, name)`, sorts by
`(surface, name)` and sorts `details` keys, so the JSON is stable enough to
commit and diff. Classification is **not** stored here: fidelity classes
(`exact` / `equivalent` / …) belong to the IR, where a reason is mandatory.

## Diff rules

- `missing` — the golden has it, the observation does not.
- `extra` — the observation has it, the golden does not.
- `changed` — same `(surface, name)`, different `details`.
- A **pin mismatch fails on its own**, even with identical components.
  Comparing across versions must never look like a pass.

## Fixtures

`fixtures/claude-*/`, one behavior per directory, with the golden under
`.inventory/<tool>@<version>.json`. Current set: skills-only, flat commands,
nested command (drift), root skill without a manifest, flat + nested agents
(drift), hooks + MCP.

## Commands

```bash
npm run rig -- capture --plugin fixtures/claude-skills-only   # write a golden
npm run rig -- verify  --plugin fixtures/claude-skills-only \
                        --golden fixtures/claude-skills-only/.inventory/claude-code@2.1.322.json
npm run rig -- diff    --expected <file> --actual <file> --verbose
npm run capture:fixtures                                      # re-capture all, review the JSON diff
npm test                                                      # every golden is re-probed
```

Probes run with a throwaway `HOME` and `CLAUDE_CONFIG_DIR`, so they cannot read
or write the user's own Claude installation.
