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
   └─ DSH oracle        → boot the pinned harness, materialize via the
                          compiler, then read the registries
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
npm run rig -- report  fixtures/claude-commands-flat           # what the transplant would do, compile-side
npm run rig -- report  fixtures/claude-commands-flat --json    # the same report for tooling
npm run rig -- report  fixtures/claude-hooks-mcp --grants <file>  # authorize exec hooks (D25)
npm run capture:fixtures                                      # re-capture all, review the JSON diff
node scripts/fetch-claude.mjs                                 # install the pinned Claude CLI, print the binary
npm test                                                      # every golden is re-probed
```

Probes run with a throwaway `HOME` and `CLAUDE_CONFIG_DIR`, so they cannot read
or write the user's own Claude installation.

`report` is the exception: it asks no host. It reads the plugin with the dialect,
gates exec artifacts with the grant store, emits in memory, and prints the
annotations the IR already carries — class, reason and each face — next to
emit's carry decision and a totals line aggregated from those rows.
`declared` comes from the gated IR; `emitted` means a child carries it;
`refused` is an exec artifact the IR would carry but trust withheld, with the
capability after the colon (`refused:exec`); `skipped` is everything else the
emitter could not place (`planned`, no seam, no materializer). The four counts
partition the components, so they do not overlap.

A refusal is not a validation failure: without `--grants` the default store is
empty, so every command hook reports `refused:exec` and no hook child is
emitted. `--grants <file>` reads a `grants.yml` (D25) and passes it to the same
authorizer the installer uses; a malformed store exits 2 with the
`file:line` reason. That makes `report` runnable where neither `claude` nor DSH
is installed. It exits non-zero with `validation: FAIL` when `validateIr`
refuses the IR (`report --ir <file>` reaches that path without a deliberately
broken plugin on disk).

## The upstream side of the rig, and CI

The upstream half asks Claude Code. Its binary resolves in D24's order, first
match wins:

```
CLAUDE_BIN    an explicit executable (CI sets this to the fetched pin);
              empty or whitespace-only counts as unset
claude        PATH lookup
```

With neither, a local run skips with a reason that names
`scripts/fetch-claude.mjs`; in CI (`CI=true` or `CI=1`) it throws, because a
skipped upstream test is a failed job. A `CLAUDE_BIN` that is set to a
non-empty but unusable value is an error, never a fall-through. An empty or
whitespace-only `CLAUDE_BIN` is treated as unset, so `CLAUDE_BIN= npm test` is
the normal way to fall back to `PATH` rather than a typo to punish.

`node scripts/fetch-claude.mjs` (or `npm run fetch:claude`) installs the pinned
`@anthropic-ai/claude-code@2.1.322` into `.claude-code/2.1.322/` with
`--ignore-scripts`, and prints the platform-native binary. The version lives
only in `CLAUDE_CODE_PIN` (`packages/dsh-anyplugin-conformance/src/pin.ts`);
the fetch, the CI guard and the tests all read it. `--verify <path>` checks an
already-resolved binary against the pin without installing anything. The
workflow caches `.claude-code/` keyed on `pin.ts` and
`scripts/fetch-claude.mjs`, so a pin bump is one edit and one cold cache.
Probes still run under a throwaway `HOME` and `CLAUDE_CONFIG_DIR`, so the
fetched client never reads a real installation.

**Can CI hold this gate now?** Yes, for the inventory gate: the `verify` job
fetches the pin and runs the same nine golden probes the laptop runs, and the
upstream CLI's version is asserted before the suite. What CI still cannot hold
is local by nature — the Desktop `DSH_INSTALL_DIR` path, the `asar` read path,
and the behavior face (`claude plugin eval`, which costs money). Those remain
PR evidence, not workflow steps.

## The DSH side of the rig

The upstream oracle asks Claude Code what it loaded. The DSH oracle asks DSH the
same question, and it does so by booting a **pinned harness tree** rather than a
copy of it:

```
dialect → IR → emit (group entry, pure data) → Loader → materializer
        → ctx.skills.register → ctx.skills.list() → inventory
```

The tree is either the Desktop installation or a released npm harness. D22 owns
the resolution order:

```
DSH_HARNESS_DIR      install root printed by scripts/fetch-harness.mjs <version>
DSH_INSTALL_DIR      the Desktop installation's @deepseek-ai/dsh package dir
.harness/<version>   for DSH_HARNESS_VERSION, inside this checkout
```

`node scripts/fetch-harness.mjs 0.2.2-rc.5` installs the packages the oracle
and materializers import (plus pinned `cordis`/`cordis-plugin-loader`/
`cordis-plugin-group` and `@modelcontextprotocol/client`) and prints the
directory; it is idempotent and never runs during `npm test`. The directory is
a plain `node_modules/@deepseek-ai` — not an asar archive — so `import()` of the
real `cordis`, `cordis-plugin-loader` and `dsh-skill` works from ordinary
Node. See D22 for why rc.2 from npm is the same product as the Desktop copy, and
ARCHITECTURE §10.4 for the two traps (one cordis only; registration is
`ctx.effect`-scoped).

`probeWithDsh({ harnessDir, entry })` takes the emitter's group entry,
materializes it, waits for `ctx.skills.list()` to be stable for three polls, and
returns an inventory whose pin is `dsh@<version of the tree that booted>`.

### Coverage, not pass/fail

`coverage.test.mjs` runs every fixture through both sides and pins the exact row
set per fixture. Today (CI re-runs it against `0.2.2-rc.5` and `0.2.2-rc.2`):

| Fixture | Declared | Matched | Missing | Refused |
| --- | --- | --- | --- | --- |
| `claude-skills-only` | 2 | 2 | 0 | 0 |
| `claude-root-skill` | 1 | 1 | 0 | 0 |
| `claude-command-nested` | 0 | 0 | 0 | 0 |
| `claude-commands-flat` | 2 | 2 | 0 | 0 |
| `claude-agents` | 1 | 0 | 1 | 0 |
| `claude-hooks-mcp` | 2 | 2 | 0 | 0 |
| `claude-mcp-http` | 1 | 1 | 0 | 0 |
| `claude-mcp-tool-budget` | 1 | 1 | 0 | 0 |
| `claude-mcp-budget` | 1 | 0 | 0 | 1 |
| **total** | **11** | **9** | **1** | **1** |

A test that only went green would tell you nothing about the missing
components. A ratchet tells you the distance to 100 % on every run, and closing
one gap is a one-line reviewable edit in the matrix. "Refused" is a third
outcome: the component was read, judged unrepresentable, and annotated (D11).

### Running one layer

```bash
node --test packages/dsh-anyplugin-conformance/test/transplant.test.mjs  # 0-diff proof
node --test packages/dsh-anyplugin-conformance/test/coverage.test.mjs     # burn-down matrix
node --test                                                               # everything
```

Without a resolved Claude CLI the upstream tests skip with a reason that names
`fetch-claude.mjs`; without any resolved harness the DSH-side tests skip with a
reason that names `fetch-harness.mjs`. On CI either is a failure, not a skip:
the workflow resolves the CLI and both harness pins in guard steps before
`npm test`.

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

## The trace half

Inventory says what loaded. A trace says what the host did with it. The rig
reads a JSONL turn trace, normalizes it, and diffs two normalized streams
positionally.

```bash
node packages/dsh-anyplugin-conformance/src/rig.ts trace \
  --left  fixtures/traces/claude-code-2.1.322/skills-only-greet.jsonl \
  --right fixtures/traces/claude-code-2.1.322/skills-only-greet.jsonl \
  --root /tmp/evalprobe
```

`--root` is the plugin directory used in the trace; it is replaced with
`<plugin>` so a rerun on another machine still matches. Exit code is 0 only
when every row matches.

Kept, in order: the `system:init` tool list, each `tool_use` (name and input),
each `tool_result` text, text the host injects as a user message, and the
assistant's own prose. Dropped: thinking, thinking-token telemetry, the result
record, and — through the scrubber — paths, ids, and timestamps (D18).

Alignment is by index, deliberately: one insertion shifts the rest into
`differ`, which is the honest signal when order is part of the behavior.
