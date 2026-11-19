# Hook payload fixtures

Two kinds of fixture live here, and they do not have the same authority.

| Directory | Source | Authority |
| --- | --- | --- |
| `payloads/` | The canonical examples on the pinned docs page, extracted by `scripts/extract-hook-payloads.mjs` | Illustrative. The harness sends more fields than the examples show, and shows optional ones as present. |
| `captured/` | A real `claude` 2.1.322 writing its own stdin (`spikes/s6-hook-payloads`) | Verbatim, minus `session_id` and `transcript_path`. |

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

## Capturing the rest (needs a login)

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`,
`PermissionRequest`, and every other turn-interior event require a model turn,
and this machine is not logged in to `claude`. They stay doc-shaped until
someone runs the spike with an authenticated `claude`:

```bash
node spikes/s6-hook-payloads/run.mjs          # uses your real config
node spikes/s6-hook-payloads/run.mjs --isolated   # temp HOME; captures only
                                                  # the auth-free events
```

The spike writes one JSON record per event (payload, plugin-root env vars, and
the hook's cwd) under a temp directory; move the interesting ones into
`captured/` with the same scrubbing.

## What this buys the kernel

`packages/dsh-anyplugin-intercept/test/payloads.test.mjs` runs every payload
through `runChain`. That is how the event table, the matcher subject, and the
rewrite path stay calibrated against upstream shapes instead of our reading of
the prose.
