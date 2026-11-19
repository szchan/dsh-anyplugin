# Provenance — `claude-code-2.1.322`

Recorded behavior traces, one JSONL file per case. Each file is the stream a
host produced for one run; `normalizeTrace()` in
`packages/dsh-anyplugin-conformance/src/trace.ts` turns it into the event
sequence the rig diffs.

## `skills-only-greet.jsonl`

| | |
| --- | --- |
| Host | `claude` 2.1.322 |
| Case | `fixtures/claude-skills-only` — skill `greet`, body `Greet $name.\n`, `arguments: [name]` |
| Command | `claude plugin eval . --trust-plugin --ablation none --runs 1 --keep-temp --max-cost-usd 0.20` |
| Model | `deepseek-flash` via `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` |
| Captured | 2026-11-19 |
| Plugin root in the trace | `/tmp/evalprobe` (pass `--root /tmp/evalprobe` to the rig) |

The trace is the standard answer for D16: what "using a skill" means on this
host is a `Skill` tool call with `{skill, args}`, a `Launching skill: …`
tool result, and then one user message carrying the base directory plus the
already-substituted body. It is stored raw (paths and ids included) so a future
normalizer can re-derive a stricter scrub; only the reviewed, non-secret fields
matter, and the file contains no credentials.

Nothing under `fixtures/**/captured/` is ever committed — that path is the raw
drop zone for a fresh capture, and only reviewed recordings move here.
