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

## The DSH side of the rig

The upstream oracle asks Claude Code what it loaded. The DSH oracle asks DSH the
same question, and it does so by booting the **installed** harness rather than a
copy of it:

```
dialect → IR → emit (group entry, pure data) → installed Loader → materializer
        → installed ctx.skills.register → ctx.skills.list() → inventory
```

`$(dirname "$DSH_INSTALL_DIR")` is a plain directory (not an asar archive), so
`import()` of the real `cordis`, `cordis-plugin-loader` and `dsh-skill` builds
works from ordinary Node. See D9 for why npm is not used, and ARCHITECTURE
§10.4 for the two traps (one cordis only; registration is `ctx.effect`-scoped).

`probeWithDsh({ installedDir, entry })` takes the emitter's group entry,
materializes it, waits for `ctx.skills.list()` to be stable for three polls, and
returns an inventory whose pin is `dsh@<installed version>`.

### Coverage, not pass/fail

`coverage.test.mjs` runs every fixture through both sides and pins the exact row
set per fixture. Today:

| Fixture | Declared | Matched | Missing |
| --- | --- | --- | --- |
| `claude-skills-only` | 2 | 2 | 0 |
| `claude-root-skill` | 1 | 1 | 0 |
| `claude-command-nested` | 0 | 0 | 0 |
| `claude-commands-flat` | 2 | 2 | 0 |
| `claude-agents` | 1 | 0 | 1 |
| `claude-hooks-mcp` | 2 | 0 | 2 |
| **total** | **8** | **5** | **3** |

A test that only went green would tell you nothing about the five missing
components. A ratchet tells you the distance to 100 % on every run, and closing
one gap is a one-line reviewable edit in the matrix.

### Running one layer

```bash
node --test packages/dsh-anyplugin-conformance/test/transplant.test.mjs  # 0-diff proof
node --test packages/dsh-anyplugin-conformance/test/coverage.test.mjs     # burn-down matrix
node --test                                                               # everything
```

Both DSH-side tests skip when `DSH_INSTALL_DIR` is unset; they are meaningless
without an installation to measure.

## The behavior face

`claude plugin eval` grades a plugin's own suite (`evals/**/case.yaml`, or
`prompt.md` + `graders/*.md`) and, with `--ablation with-without`, reports the
delta against a no-plugin baseline arm. Run it on the DeepSeek backend so both
hosts share one model:

```bash
cd <plugin> && ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  ANTHROPIC_AUTH_TOKEN=… ANTHROPIC_MODEL=deepseek-flash \
  claude plugin eval . --trust-plugin --ablation with-without \
  --runs 1 --keep-temp --json result.json --max-cost-usd 0.20
```

Each run writes `out/trace.jsonl` (kept only with `--keep-temp`; the kept
directories are sealed `mode 000`). The trace is the useful half: it records
the tool calls, the tool results and every model-visible message. What a skill
invocation looks like there:

```text
assistant    tool_use  Skill {skill: "skills-only:greet"}
tool_result            "Launching skill: skills-only:greet"
user          text     "Base directory for this skill: <dir>\n\nGreet Ada."
```

That is a byte-level statement about the context face, and it is the first one
we have. DSH delivers the same body inside `<skill_content>` and does not
substitute `arguments:`, so the skill annotation is `equivalent`, with reasons
(D16).
