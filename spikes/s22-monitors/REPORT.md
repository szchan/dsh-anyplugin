# S22 — what a plugin `monitor` does in the pinned client

**Question (issue #157).** A Claude plugin may declare `monitors` (a
`monitors/monitors.json`, or an inline array in `plugin.json`). Our dialect
carries the surface as `planned` because no one has observed the client run one.
What does the pinned client do with a monitor: when does it start, how often,
what does its stdout do to the model context, what does `when` change, how does
it order against hooks and the transcript, what ends it, and what environment
does it inherit?

**Answer.** At `@anthropic-ai/claude-code@2.1.329` the client **loads and
validates** the declaration, **lists it nowhere**, and **never spawns it** — in
headless `-p`, inline via `--plugin-dir` or installed from a marketplace,
`when: "always"` or `when: "on-skill-invoke:<skill>"`, turn 1, turn 2, or after
`--resume`. It is not a refusal: the client prints no error, no warning and no
debug line. Across four sessions with 19 hook records and nine model requests
totalling 560292 request bytes there are **0 monitor start records** and **0**
`S22_MON` bytes in the model traffic, the hooks, or the session transcript.

The consequence for the seven questions is that **six are `[not observable]`**
— there is no running monitor to observe — and **one (Q4) is `[observed]`**,
because the declaration surface (accepted keys, `when` grammar, the client's
error bytes) is validated before the client goes quiet. Under D37 this is an
oracle-invisible surface: carry the declaration, hash its bytes, premise-test
that the client still validates it; do not invent a golden for a process that
never ran.

## Pin and environment

| item | value |
| --- | --- |
| client | `claude` from `.claude-code/2.1.329/` (native linux-x64 binary) |
| `claude --version` | `2.1.329 (Claude Code)` |
| model route | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_MODEL=deepseek-flash` (real model turns: results carry `"result": "s22-one"` etc.) |
| isolation | throwaway `HOME`/`CLAUDE_CONFIG_DIR`; a **separate** HOME for the loader stage and the model runs, so only the plugin under test is loaded |
| proxy | a local recording proxy in front of the DeepSeek endpoint; it logs request count, bytes, sha256 and `S22_MON`/`task_notification` counts, never headers |
| host | Linux, node v24.22.2; **no PTY** in this sandbox (`/dev/ptmx` is `EACCES`), so the interactive TUI could not be exercised at all |

## Method

`run.mjs` does three things, in this order:

1. **Loader stage** (`captures/loader/`): stages seven fixtures, publishes them
   through a generated marketplace, `claude plugin marketplace add`, `claude
   plugin install`, then captures `plugin list` and `plugin details` per valid
   plugin.
2. **Standalone control** (`captures/standalone-*`): runs `monitor.mjs`
   directly, proving the fixture emits beats and the spike would see them.
3. **Model stage** (`captures/{one,two,gated,resume}/`): four headless sessions
   driven through `-p --input-format stream-json --output-format stream-json
   --verbose`, two user messages each (one for `resume`), the plugin supplied
   with `--plugin-dir`. A local proxy forwards `/anthropic/*` to
   `https://api.deepseek.com`.

The spike **exits 1** when no monitor start record exists, and prints

```
s22: REFUSED — the pinned client never spawned a plugin monitor.
```

That exit code is the answer, not a defect: a run that "passes" with zero
observed monitors would be a lie about the surface.

### Fixtures

| fixture | what it declares |
| --- | --- |
| `one-monitor` | `monitors/monitors.json`, one monitor `beat`, `when` defaulted |
| `two-monitors` | the same file, two monitors (`beat`, `beat2`) |
| `gated-skill` | one monitor with `when: "on-skill-invoke:s22-skill"`, plus a skill `s22-skill` whose body is `S22_SKILL_OK` |
| `inline-array` | the same array inline in `plugin.json` under `"monitors"` |
| `bad-extra-key` | a monitor with `"trigger": "always"` (unknown key) |
| `bad-when-short` | `"when": "on-skill-invoke:"` (no skill name) |
| `bad-when-enum` | `"when": "sometimes"` (not `always`, not the prefix) |

Every fixture also installs `SessionStart`, `PreToolUse` (Bash), `PostToolUse`,
`Stop`, `SessionEnd` hooks that log their stdin to `$S22_LOG`, and the transcript
size plus a count of `S22_MON` occurrences in it at hook time.

The committed fixtures carry only the declaration files; the driver
copies `monitor.mjs` and `hook.mjs` into each staged plugin, and substitutes the
`__NODE__`/`__PLUGIN_ROOT__` placeholders in `hooks.json` so the same two
scripts trace every fixture into one file.

`monitor.mjs` logs `start` (with `cwd`, `argv`, `ppid`, and
`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`/`CLAUDE_PROJECT_DIR`), `tick`,
`beats-done`, `signal`, `exit`; it writes one `S22_MON <label> <n> <ISO>
pid=<pid>` line to stdout and one `S22_MON_STDERR …` line to stderr every 250 ms,
and filters environment names matching `TOKEN|KEY|SECRET|AUTH|PASSWORD` so the
API key cannot be traced.

## The seven answers

Each row carries the marker the issue asks for, and the exact bytes/timestamps
from `captures/`. Marker meanings here: `[observed]` = the client's behaviour
was captured; `[refused]` = the client rejected the declaration and said so;
`[not observable]` = the client accepted the declaration and then did nothing,
so there is nothing to watch.

| # | question | marker | evidence |
| --- | --- | --- | --- |
| 1 | When does the monitor start, relative to session start / first model request / first tool call? Does it start at all under headless `-p`? | **[not observable]** | It never starts: 0 monitor records in all four sessions. The first `SessionStart` hook is `2026-11-22T06:47:18.275Z`; the first model `PreToolUse` (Bash) is `2026-11-22T06:47:19.660Z`; no spawn precedes, separates, or follows them. A monitor that never runs has no start time to place. |
| 2 | How many spawns per session and per turn; any more after `/clear` or `--resume`? | **[not observable]** | `one-monitor` and `two-monitors`: two turns in one session each, 0 spawns (`"sessionId":"a4871fcc-…"` and `"d770a79a-…"` twice, then closed). `--resume a4871fcc-…`: `SessionStart` at `2026-11-22T06:47:29.709Z` already reports `transcript=191028` (the resumed history) and 0 spawns. `/clear` was **not** exercised (no non-interactive way to send it); the count after a clear is therefore untested, not zero. |
| 3 | Do the monitor's stdout/stderr lines reach the model? In what role, under what wrapper, exact bytes? | **[not observable]** | The fixture provably emits: `S22_MON standalone 1 2026-11-22T06:47:14.877Z pid=1571027` and `S22_MON standalone 2 2026-11-22T06:47:14.978Z pid=1571027` (`captures/standalone-stdout.txt`). In the sessions, the proxy counted **9 requests / 560292 request bytes** with **0** `S22_MON` occurrences, and the **197541-byte** transcript has **0** (`captures/one/events.jsonl`, `captures/transcript.jsonl`, `captures/model-requests.jsonl`). No wrapper bytes exist to quote because no bytes were delivered; the `<task-notification>` token appears in the client's own Task tool description in the transcript, never as a delivered message. |
| 4 | Does `when` change the trigger, and which keys does the client's own error output accept? | **[observed]** | Accepted shape: `name`, `command`, `description` (all required strings), `when` optional, defaulting to `"always"`; `when` must be `"always"` or `"on-skill-invoke:<name>"`, and the whole string must be longer than `"on-skill-invoke:"` (16 characters), so the skill name may not be empty. Unknown keys are **rejected**, not ignored. (The client prints these errors with `”` as its quote glyph; the bytes below are its bytes.) Exact bytes from `captures/loader/plugin-list.txt`: `Error: monitors load failed from <tmp>/marketplace/plugins/s22-bad-extra/monitors/monitors.json: [ { ”code”: ”unrecognized_keys”, ”keys”: [ ”trigger” ], ”path”: [ 0 ], ”message”: ”Unrecognized key: \”trigger\”” } ]`; for `when: "sometimes"`: `[ { ”origin”: ”string”, ”code”: ”invalid_format”, ”format”: ”starts_with”, ”prefix”: ”on-skill-invoke:”, ”path”: [ 0, ”when” ], ”message”: ”Invalid string: must start with \”on-skill-invoke:\”” }, { ”code”: ”custom”, ”path”: [ 0, ”when” ], ”message”: ”on-skill-invoke: must specify a skill name” } ]`. Both `monitors/monitors.json` and the inline `"monitors"` array load (`Status: ✔ enabled`). The **effect** of `when` stays unobservable: `gated-skill` was invoked through the slash command `/s22-gated:s22-skill`, the assistant replied `S22_SKILL_OK` (so the skill body ran), and still nothing armed. |
| 5 | Ordering against hooks and the transcript: is a line visible to the next PreToolUse, the same step, or the next turn? | **[not observable]** | Hook records report transcript sizes `120284`, `123261`, `181682`, `187039`, `191028` with `monitorMentions=0` at every point, and the `Stop` payload carries `"background_tasks": []` on both turns. With no line ever written there is no ordering to place. |
| 6 | What ends it: turn end, session end, SIGTERM, TTL, nothing? | **[not observable]** | It never started, so nothing ended it. The only termination observed is the spike's own `SIGTERM` to the standalone control (`captures/standalone-events.jsonl`: `start, tick, tick, beats-done, signal:SIGTERM, exit`), which says nothing about the client. |
| 7 | Does it inherit `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`, and which cwd? | **[not observable]** | No `start` record exists, so there is no `cwd` or environment to read. The declaration itself is accepted with `${CLAUDE_PLUGIN_ROOT}/monitor.mjs` as `command`, so substitution is not refused at load time; whether it happens at spawn is unanswerable while no spawn happens. |

## What the client does with the declaration

The silence is not an absence of code. In the same 2.1.329 binary the loader
reads `monitors/monitors.json` (or the inline array, or the manifest's path
string), parses it with a zod schema, records `component-load-failed` for a
bad shape, and surfaces nothing in any inventory:

- `claude plugin details s22-one` prints `Skills (0) / Agents (0) / Hooks (5)
  SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd / MCP servers (0) /
  LSP servers (0)` — there is **no Monitors row** (`captures/loader/details-s22-one.txt`).
- `claude plugin list` marks a malformed declaration `✘ failed to load` with the
  exact error bytes above, and a well-formed one `✔ enabled`.
- The arming code exists (`mme()` and the `fme()` effect, called from the REPL
  component `zJ`), but its call site is the interactive REPL, which `-p` does
  not mount; there is no second, headless call site. This is consistent with the
  observation, and the spike does not claim it as proof — the proof is the four
  sessions above.

Because the interactive TUI could not be started here (`/dev/ptmx` is denied in
this sandbox), "monitors never run" is claimed for headless `-p` only. The
interactive behaviour remains unobserved.

## What this means for the layer

- `packages/dsh-anyplugin-dialect-claude-code/src/index.ts` keeps the surface
  `planned` with its existing reason; nothing observed here licenses a
  materializer, and D37 forbids a golden for an oracle-invisible face. What the
  layer may carry is the declaration (bytes + hash) and this premise: the pinned
  client validates the same keys and still declines to run it.
- `docs/TODO.md` loses the "find out" half of the monitor line: the question is
  answered; what remains is the product decision, not an observation.
- A future spike that ships a PTY (S22b) would be the first to observe a monitor
  at all; until then, six of these seven rows stay `[not observable]` by
  construction.

## Reproducing

```bash
CLAUDE_BIN=$PWD/.claude-code/2.1.329/node_modules/@anthropic-ai/claude-code-linux-x64/claude \
DEEPSEEK_API_KEY=… node spikes/s22-monitors/run.mjs --deepseek
```

`--publish` rewrites `spikes/s22-monitors/captures/` from the run (`<tmp>` and
`<model-home>` substitutions; the key is never written). The spike needs the
network for the model turns and a real key; it is deliberately not wired into
CI. Exit code 1 with the `REFUSED` banner is the expected outcome at this pin.

Artifacts:

| path | what it holds |
| --- | --- |
| `run.mjs` | the driver; 24 checks, four of which are the monitor-start assertions that fail by design |
| `monitor.mjs`, `hook.mjs` | the fixture programs |
| `captures/loader/` | `plugin-list.txt`, `details-*.txt`, `marketplace-add.txt` |
| `captures/{one,two,gated,resume}/` | `stream.jsonl`, `events.jsonl`, `stderr.txt`, `debug-monitor-lines.txt` |
| `captures/transcript.jsonl` | the one-monitor session transcript (197541 bytes) |
| `captures/model-requests.jsonl` | per-request bytes, sha256, mention counts, roles |
| `captures/standalone-*` | the control run's exact stdout and events |
| `captures/checks.json`, `captures/summary.json` | every assertion with its detail, and the run summary |
