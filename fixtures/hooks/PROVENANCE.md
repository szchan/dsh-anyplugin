# Hook payload fixtures

Two kinds of fixture live here, and they do not have the same authority.

| Directory | Source | Authority |
| --- | --- | --- |
| `payloads/` | The canonical examples on the pinned docs page, extracted by `scripts/extract-hook-payloads.mjs` | Illustrative. The harness sends more fields than the examples show, and shows optional ones as present. |
| `observed/` | Six real `claude` 2.1.322 payloads recorded by `spikes/s6-hook-payloads` on a DeepSeek backend | Verbatim, minus `session_id` and `transcript_path`. |

Pin: **claude-code 2.1.322**. Re-run `node scripts/extract-hook-payloads.mjs`
when the pin moves, then review the diff — a removed event or a renamed field is
a compatibility break, not a doc cleanup.

## Why `payloads/` is not a schema

Compare the two `SessionStart` fixtures:

- The doc example is a **resume** variant: it carries `source: "resume"` plus
  `model`, `seconds_since_last_response`, `context_tokens`,
  `prompt_cache_likely_expired`, `estimated_cache_write_usd`.
- The real startup capture carries `source: "startup"` and none of those fields.

So a payload is a **union over variants**, not a fixed record. Consumers must
treat unknown fields as present-sometimes and missing fields as absent-at-this-
variant; a test that asserts an exact key set is wrong.

Two fields exist in captures and are absent from the doc examples:
`prompt_id` on `UserPromptSubmit` and `SessionEnd`. That direction is the one to
pay attention to — the capture is the authority where both exist.

## What the recordings settled

Six events are recorded: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`, `SessionEnd`. Five shape facts came out of them, and
each one is a rule for whoever writes the classic arm:

1. **`tool_response` is tool-specific and not a schema.** Bash sends
   `{stdout, stderr, interrupted, isImage, noOutputExpected}`; the doc example for
   `PostToolUse` is a Write response, `{filePath, type}`. Never assume a shape.
2. **`tool_use_id` differs by backend** — `call_00_…` here, `toolu_01…` in the
   docs. It is an opaque string; do not parse it, do not pin its format.
3. **`effort: {level}`** rides on turn-interior events and appears in no doc
   example. Same lesson as `prompt_id`: the payload grows.
4. **A documented field can still be absent.** The `PreToolUse` doc example has
   `scratchpad_dir`; the recording does not. Documentation is a union of
   variants, in both directions.
5. **`stop_hook_active`** is `false` in a normal turn. `true` means the turn was
   itself started by a `Stop` hook — the guard against a Stop hook looping.

## Re-capturing

```bash
DEEPSEEK_API_KEY=sk-... node spikes/s6-hook-payloads/run.mjs --deepseek
```

The spike prints each payload and writes a record (payload, plugin-root env
vars, hook cwd) under a temp directory. Copy the interesting ones into
`observed/` with the same scrubbing and update the provenance block.

## Running the client at all: the DeepSeek backend

`claude` speaks the Anthropic Messages API, and DeepSeek serves that format at
`https://api.deepseek.com/anthropic` (its docs map `claude-opus*` to
`deepseek-v4-pro` and `claude-sonnet*`/`claude-haiku*` to `deepseek-flash`).
The spike wires that up with `--deepseek`, using `DEEPSEEK_API_KEY` from the
environment; the key is never printed or written to a fixture.

```bash
DEEPSEEK_API_KEY=sk-... node spikes/s6-hook-payloads/run.mjs --deepseek
```

`--deepseek` implies an isolated `HOME`, so the run cannot touch a real
`~/.claude`. Captures made this way are the same shape as Anthropic-backed ones
for everything a plugin observes (which events fire, payload fields, expansion
text) — but not for model choices, so they are still only evidence about the
*harness*, never about which tool a model picks.

## What this buys the kernel

`packages/dsh-anyplugin-intercept/test/payloads.test.mjs` runs every payload
through `runChain`. That is how the event table, the matcher subject, and the
rewrite path stay calibrated against upstream shapes instead of our reading of
the prose.
