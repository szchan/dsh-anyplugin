# Decision log

Ratified decisions. Treat each entry as a constraint on new work until it is
explicitly superseded by a later entry. Format: id, status, decision,
rationale, date.

---

## D1 — Emit pure data, ship as a bundle

**Status:** ratified 2026-11-18.

Foreign plugins are compiled into an `EntryTree` patch and handed to DSH's own
loader. The project ships as a bundle (host controller + packages), not as one
large plugin.

**Why:** data can be diffed, audited and replayed, and stable ids make a
version bump a `loader.update` instead of a remove-and-recreate. Code
generation would make every install a small compiler project and every review a
security review.

---

## D2 — Two scope axes: install is global, enable is layered

**Status:** ratified 2026-11-18.

Installation is profile-global, with the versioned cache-directory semantics of
the source ecosystem reproduced (root and data dir separated). Enabling is
three layers, narrowest wins: `local` > `project` > `user`. A project-level
disable beats a user-level enable.

**Why:** plugins arrive per project, but a bundle is an installation unit.
Refusing project scope would make the layer unusable in shared repos; treating
install as project-local would duplicate downloads and break global commands.

---

## D3 — `mods` are a required subsystem, measured by symbol coverage

**Status:** ratified 2026-11-18.

`mods` will be supported, no matter the cost, and their 100 % is defined as:
every symbol in the pinned `claude-code.d.ts` is **implemented** or
**planned-with-roadmap**, and every fixture mod diffs to zero on its declared
surfaces. Coverage is reported as `covered / total` and must rise
monotonically.

**Why:** the specification is generated and byte-identical to the engine's
declarations, so it is the one surface with a finite, enumerable denominator.
Without it, "support mods" is an unbounded promise. See
`ARCHITECTURE.md` §7.4.

---

## D4 — One interception kernel, shared by hooks and mods

**Status:** ratified 2026-11-18.

`dsh-anyplugin-intercept` owns event points, matcher grammar, decision
protocol, tier ordering, per-event budgets and abort. The classic-hook
materializer and the mod front-end are two consumers of it. The kernel skeleton
lands in v0.1, before either consumer is complete.

**Why:** hooks need interception to answer allow/deny/block/inject; mods need
the same points to rewrite events, answer outright and draw. Building the hook
bridge first as a one-off would force a rewrite and would leave mods
structurally impossible. See `ARCHITECTURE.md` §7.2.

---

## D5 — The mod host is generic and lives in its own package

**Status:** ratified 2026-11-18.

`dsh-mod-host` provides a DSH-native mod ABI (chain engine with tiers, `$`
bridges, element runtime, redraw scheduler) and knows nothing about Claude.
`dsh-anyplugin` supplies the `claude-code` → ABI adapter.

**Why:** mods are an ecosystem that will outlive this compatibility layer.
Keeping the ABI native keeps the fidelity contract honest — the adapter's gap
is exactly "what is not covered". See `ARCHITECTURE.md` §7.3.

---

## D6 — We accept hosting unsandboxed in-process code

**Status:** ratified 2026-11-18 by the project owner.

Upstream states plainly that mods are not sandboxed and run with the user's
permissions (approve tool calls, read credentials, spend usage). We accept
carrying that capability class, on the condition that we ship an **equivalent
guard layer** (`sec-default` / `hipaa-default` semantics) and make it at least
as safe as the system we emulate — never looser. The static capability scan
feeds the grant UI, and grants are pinned to the artifact hash.

**Why:** fidelity to the ecosystem is the whole point, and a numerically lower
capability ceiling would silently change what plugins can do. The risk is taken
knowingly, with a guard layer as the mitigation.

---

## D7 — Loader ids are mangled; display names are kept separately

**Status:** ratified 2026-11-18, forced by S1.

`EntryTree.sep` is `:` and `resolve()` splits ids on it, so an id containing
`:` is stored but unaddressable. Every id that reaches the loader is therefore
escaped: characters outside `[A-Za-z0-9_.@-]` (including `:` and `~` itself)
become `~` + the UTF-8 hex of the byte, which is reversible in one pass. The
original string — the thing a user or a fidelity report must see — lives in the
plugin's display metadata, never in the loader id.

**Why:** foreign ids come from ecosystems that use `:` as a namespace
separator (`plugin:skill`, `my-plugin@marketplace`). Mangling is the only
option that keeps reconcile addressable *and* keeps the display name exact.
Ids are internal identity, so mangling them costs no observable fidelity;
mangling a display name would.

---

## D8 — Surface mapping is pin-gated, and the host's own report beats the docs

**Status:** ratified 2026-11-18, forced by the S3 rig's first captures.

The dialect does not derive its component mapping from prose documentation. It
resolves a **pin profile** (today `claude-code@2.1.322`) and, inside a profile,
maps according to what the host itself reported — captured as fixtures plus
committed goldens and re-probed by `npm test`.

What that means at the current pin (see ARCHITECTURE §10.3):

- `commands/*.md` maps to the **skill** surface; the host reports it as a skill.
- `commands/<dir>/*.md` and `agents/<dir>/*.md` are **not loaded** by the host,
  so the dialect records them as dropped with a reason, never as components.
- Parenthetical cost annotations on hooks and MCP servers become component
  details, never part of a component name.

**Why:** the docs describe nested command and agent namespacing that the
installed loader does not implement, and the command/skill boundary the docs
draw is not one the host's inventory makes. A doc-faithful dialect would claim
components the host does not have — 100 % wrong precisely where fidelity is
measured. When the pin moves, `npm run capture:fixtures` re-captures and the
golden diff is reviewed like code; a changed golden without a new pin profile
is a bug, not an upgrade.

---

## D9 — The DSH oracle runs the installed harness, never npm

**Status:** ratified 2026-11-18, forced by the first transplant.

The rig's actual side boots the harness from
`$(dirname "$DSH_INSTALL_DIR")` — a plain directory of 338 `@deepseek-ai`
packages — and imports `cordis`, `cordis-plugin-loader` and `dsh-skill` from
there via `pathToFileURL`. One `Context`, created by that cordis, owns both the
loader and the registries.

**Why:** the products differ. npm publishes `dsh-skill@0.0.1-rc.1` while the
desktop installation runs `0.2.2-rc.2`, and some packages the harness uses
(`dsh-command`) are not published at all. A comparison against npm would
measure a different product and could pass while the real harness fails. The
claim is about what the user runs.

**Consequences:**

- The DSH-side tests require a local installation and **skip** without
  `DSH_INSTALL_DIR`; they are not meaningful in a bare checkout.
- Tests assert the exact installed version (`0.2.2-rc.2` today), because the
  pin is part of the claim (AGENTS §3.8). A harness upgrade is a deliberate
  re-baseline, not a green run that silently moved.
- If the Desktop bundle ever ships as a real `asar` archive again, the oracle
  must switch to the `ELECTRON_RUN_AS_NODE=1` access path; that is the only
  place the access mode is allowed to matter.

---

## D10 — A command has two faces, and its human face needs two additive seams

**Status:** ratified 2026-11-18, forced by the command materializer.

A Claude command is one artifact with two observable surfaces:

1. **model face** — at pin 2.1.322 the host lists `commands/*.md` in the same
   `Skills` inventory as `SKILL.md`, with the same name, description and body;
2. **human face** — typing `/plugin:name args`, which expands `$ARGUMENTS` /
   `$1…$9` and submits the result as the next user message.

The IR models this as `IrSkill.faces: { model, human }`, the emitter decides
emittability on the **model face**, and `annotation` is the weakest face (the
ir validator enforces the ordering). The command dialect sets
`model: equivalent`, `human: planned`, overall `planned`.

**Why the human face is `planned` and not `unsupported`:** two *additive* DSH
seams close it completely, and both are union changes (AGENTS §3.2):

- **colon in command names** — `dsh-commands/src/index.ts:32` validates with
  `/^[a-z][a-z0-9_-]*$/u` and `:126` parses with the same class, so
  `/skills-only:migrate` is never even a candidate;
- **a `submit` result kind** — `dsh-commands/src/index.ts:76` says a handler
  executes "without sending the command to the model", and
  `dsh-client-ui-commands` states "a command line is never silently downgraded
  to a plain prompt". A Claude command handler must be able to do exactly that
  downgrade, deliberately.

**Consequences:**

- The expansion engine (`dsh-anyplugin-command-template`) and the materializer
  (`dsh-anyplugin-materialize-command`) already exist and are tested against
  both registry shapes — today's strict one and a seamed one. Nothing is
  rewritten when the seams land; `probeColonSeam` simply starts returning
  `{supported: true}` and the rig flips the human face to `equivalent`.
- Coverage counts components (8/5/3 as of this commit); the human-face gap for
  `claude-commands-flat` is pinned separately in `coverage.test.mjs`, so the
  improved count cannot be reported as if users could type the command.
- On a harness without the seams the materializer registers **nothing** and
  logs one line per command. A half-registered `/plugin:name` that only fails
  when invoked would be worse than an honest absence.

---

## D11 — The MCP name budget is 64 characters, and DSH hashes instead of failing

**Status:** ratified 2026-11-18, probed before writing the MCP materializer.

Two different limits were being conflated; only one of them is ours to fix.

**DSH's own cap.** `dsh-mcp-client/src/index.ts:51-52`:

```ts
/** Valid `serverName`, kept below the public tool-name budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
```

**The real budget is on the assembled name.** `dsh-mcp-client/src/tools.ts:publicToolName`
builds `mcp__${serverName}__${rawName}` and, when the result is longer than 64
characters or contains invalid characters, **truncates it and appends
`_<12-hex sha256>`**. It never fails. The comment states the contract: "the
DeepSeek function-name contract (64 chars, `[A-Za-z0-9_-]`)".

**Claude Code 2.1.322 has no server-name length limit.** Its validation is
`pa = /^[A-Za-z0-9_-]+$/` plus a ban on prototype-pollution keys
(`constructor`, `prototype`, `__proto__`, …), and a 40-character server name
loads: `claude --plugin-dir … plugin details` lists it. What binds on that side
is the tool-name rule found in the same bundle, `^[a-zA-Z0-9_-]{1,64}$`, applied
to the full `mcp__plugin_<plugin>_<server>__<tool>`.

**Consequences:**

- Byte-identical tool names require both
  `15 + plugin + server + tool ≤ 64` (i.e. `plugin + server + tool ≤ 49`) and
  DSH's `plugin_<plugin>_<server>` ≤ 32 (i.e. `plugin + server ≤ 24`). The
  second is the binding one; the first still binds per tool once the second
  holds (a 32-character server name leaves 57, a 24+24 split leaves 25).
- An over-long name is **silently renamed**, which is worse for us than a
  rejection: the tool exists, so a smoke test passes, and only the name differs.
  The MCP materializer validates at install time; the conformance rig asserts no
  emitted name matches `_[0-9a-f]{12}$`.
- Raising DSH's 32 is an additive (T2) change — every currently valid name stays
  valid — and widens `plugin + server` to `49 − tool`. It is an upstream
  proposal, not something this repo can land, and it is not required for the
  small majority of plugins that fit in 24.

---

### Enforcement, added with the first over-budget fixture

The budget binds two moments, so it is checked twice and never repaired:

- **Plan time** (dialect): the prefix `mcp__plugin_<plugin>_<server>__` is
  knowable without connecting. If `prefix.length + 1 > 64`, the server is
  `unsupported` and the reason carries the arithmetic — `claude-mcp-budget` has
  65 characters before a one-character tool.
- **Attach time** (materializer): a single tool's name is only known after
  `tools/list`. An over-budget tool is skipped and logged while its siblings
  register — `claude-mcp-tool-budget` registers `ok` and drops its
  46-character tool.

The rig counts a refused declared component as `refused`, never `missing` and
never `match`; the coverage table states all three.

## D12 — The MCP materializer owns its connection

**Status:** ratified 2026-11-18, on S5.

**Question:** how do we produce byte-exact `mcp__plugin_<plugin>_<server>__<tool>`
names when DSH's client caps the namespace at 32 characters?

**S5 answer:** the cap is not in the runtime. `ToolsService.register()` validates
the output shape, duplicate names and the reserved `run_code` name — nothing
else. A 42-character namespace (60-character tool name) registers, and the
projected schema carries the name byte for byte. Even a 95-character name is
accepted, so the 64-character contract is not enforced locally either.
`SERVER_NAME_PATTERN` rejects that same namespace, which locates the cap in
`dsh-mcp-client`'s config schema.

**Decision:** `dsh-anyplugin-materialize-mcp` connects to the plugin's MCP
servers itself — over `@modelcontextprotocol/sdk`, which the harness already
ships — and registers tools on `ctx.tools` under Claude's exact name. It does
not configure `dsh-mcp-client`, and it never patches the installation.

Rules we impose on ourselves, because the runtime will not:

- Names must match `[A-Za-z0-9_-]+` and stay ≤ 64 characters — the same
  contract Claude's tool layer uses. Over budget is `unsupported` with a
  reason, never a runtime rename.
- No truncation, no hash suffix: a silently renamed tool is a passing smoke
  test and a broken claim (D11).
- Scope: stdio and streamable-http first. OAuth/credential wiring, resources and
  prompts are `planned` until implemented, each with its own annotation.

**Consequences:**

- Lifecycle, reconnect, cancellation and server-instruction injection are ours
  now. That is real cost, and it is covered by our tests instead of inherited
  from `dsh-mcp-client`'s.
- `dsh-mcp-client` stays in use for MCP servers the user configures directly
  (profile or agent config). Our materializer serves only plugin-declared
  servers, so the two can never fight over one namespace.
- Raising DSH's 32-character cap upstream (D11) is no longer on the critical
  path. It stays a proposal, not a dependency.

## D13 — The kernel is the only owner of the tier table and the continuation rule

**Decided:** `dsh-anyplugin-intercept` owns `TIER_ORDER`
(`prepend → user → append → builtin`, `builtin` innermost) and a per-handler
`mode` (`observe` for classic hooks, `wrap` for mods). No consumer may sort
handlers, compile a matcher, or decide "does the chain continue" on its own.

**Why:** the ordering literally encodes which code runs before the tool call,
so two implementations would diverge silently and only under combination. And
the two front-ends need opposite continuation rules — after a settings hook
several matching hooks still run, while a mod that declines `next()` has taken
ownership of the rest of the chain. One engine with an explicit mode keeps both
honest; two engines would make mods structurally impossible (§7.2).

**Known assumption (recorded so it can be corrected once, not everywhere):**
the tier names and their order are taken from the Claude mod *prose*. They
become `exact` only when checked against the pinned `claude-code.d.ts` (v0.5).
The table is one line, and every consumer reads it.

**Consequences:**

- A handler that throws is skipped and recorded; a handler that overruns its
  budget is aborted and recorded. Neither is ever propagated into a tool call.
- `describeTrace` output is the report's evidence; a step exists for every
  handler run, including `skipped-matcher` and `not-called`.
- The classic-hook front-end (v0.2) is a translation of `hooks.json` into
  `HandlerRegistration`s, nothing more.

## D14 — Reuse the spec and the artifacts, never the implementation

**Status:** ratified 2026-11-18.

`anthropics/claude-code` is a GitHub repository, not an open-source codebase.
Its `LICENSE.md` is one sentence — "© Anthropic PBC. All rights reserved. Use
is subject to Anthropic's Commercial Terms of Service" — and the installed CLI
is a single `341,918,224`-byte executable bundle with no module boundary and no
exports. There is nothing to link against, and redistribution is not granted.
So the compatibility layer reuses **specifications and real artifacts**, never
Claude Code's own code.

**What we reuse, and why it is the cheap half:**

| Artifact | Use | Saves |
| --- | --- | --- |
| `mods/types/claude-code.d.ts` (873,553 bytes, byte-identical to the engine's declarations) | the mod API *specification* (D3) | all of "guess the API semantics"; it is the only enumerable, pinnable denominator |
| `mods/` — sec-default, diff, easel, telemetry, privacy, agents-md, hipaa-default (7 real mods; `diff` ships `hooks/` and `tests/`) | fixtures and acceptance targets, **not code we compile** | writing our own test mods, and the only convincing proof that the host runs somebody else's real code |
| `plugins/`, `.claude-plugin/marketplace.json`, `examples/hooks` | format samples and hook payload shapes | reverse-engineering payload shapes |
| `claude plugin details` / `claude plugin eval` (already wired in the rig, D8) | oracles | a hand-written recording protocol |

**Why the implementation would not have helped anyway:** the three most
expensive items on our ledger — the hook event points, the named-agent catalog,
and the mod host's element runtime — do not exist in that repository. They are
seams *our* host must grow. The upstream code answers "what does it mean"; our
gap is "where does it attach". Reading their source could only ever replace the
cheap half, while the `.d.ts` plus a running binary as an oracle answers the
semantics question more reliably than source ever would.

**Where delegation is legitimate, and where it is a lie:** handing a component
to a real `claude` subprocess is valid when the component is semantics we cannot
reimplement and does not claim our session — model identity is the example, and
it is already the escape layer. It is **not** valid for mods: a mod intercepts
events inside *its own* session, so a delegated mod would observe a different
agent, and its UI would be drawn in a terminal DSH cannot show. That is two
agents running side by side, not fidelity.

**Consequences:**

- Never vendor upstream code or declarations into this repository. Read them
  from the installed tree (D9) or fetch them at test time.
- Fixtures derived from upstream keep their provenance and their pin in the
  fixture, and their license stays upstream's.
- The licensing question is settled once: if a future component can only be
  obtained by copying code, it is `unsupported` with a reason, not a shortcut.

## D15 — Classic hook payloads are fixtures, and they own the event table

**Decided.** `fixtures/hooks/` holds the payload corpus: `payloads/` extracted
from the pinned docs page by `scripts/extract-hook-payloads.mjs`, and
`observed/` recorded from a live `claude` 2.1.322 by
`spikes/s6-hook-payloads` (the raw `captured/` drop zone stays git-ignored). `CLASSIC_HOOK_EVENTS` and `CLASSIC_SUBJECT_FIELD`
in `dsh-anyplugin-intercept` are derived from that corpus, and
`test/payloads.test.mjs` fails when the table and the fixtures disagree.

**Why.** We had hand-guessed 10 events; the pinned docs carry 32. A hand-typed
vocabulary silently drops two thirds of the surface, and a hand-typed matcher
subject silently narrows on the wrong field. Running real payloads through
`runChain` also exposed a semantic error the prose hid: `observe` mode was
recording a handler that returned nothing as `not-called`, which is the *wrap*
semantic — an observing hook has no `next` to decline.

**Consequences.**

- Adding an event is a fixture change plus a table change in one commit.
- The capture is the authority where a doc example and a capture disagree; doc
  examples are variants, never schemas. A test must not assert an exact key set.
- Unknown matcher semantics leave the subject empty and are listed as a gap:
  a matcher that cannot narrow is better than one that narrows wrongly.
- Payloads derived from docs keep `__provenance` (`source`, `url`, `pin`) in the
  file; recordings keep the command that produced them.

## D16 — The behavior face is graded upstream, and its trace is ground truth

**Decided.** Behavioral checks run through `claude plugin eval` against the
plugin's own suite, on the DeepSeek backend, pinned to 2.1.322. The run's
`trace.jsonl` — not the score — is the artifact we keep: it is the only
byte-level record of what the model saw.

**Why.** Scores tell us whether a plugin "worked"; they do not tell us what the
harness delivered. The first trace settled a question we would otherwise have
guessed at, and guessed wrong. A skill invocation produces two model-visible
messages:

```text
tool_result  "Launching skill: <plugin>:<skill>"
user         "Base directory for this skill: <dir>\n\n<body, arguments substituted>"
```

Our skills materializer registers the body and lets DSH wrap it in
`<skill_content name="…"><skill_resources>…</skill_resources>
<skill_instructions>…</skill_instructions></skill_content>`, and does not
substitute `arguments:` placeholders. That is not "exact", it is "the same
body in a different envelope, with a substitution missing" — which is why the
skill annotation is now `equivalent` with both gaps written down.

**Consequences.**

- Probe with `--runs 1 --max-cost-usd` (a case defaults to three runs and three
  judge votes; ≈ $0.05 + $0.005 per run at deepseek-flash). Keep the trace with
  `--keep-temp`; its directories are sealed `mode 000` by design.
- Behavior runs are opt-in (they need network and money) and are excluded from
  the default `npm test`. When they run, the report names the pin and backend.
- A passing suite is not a security claim; upstream says so and so do we.
- The trace oracle (normalize `trace.jsonl`, diff against a DSH run) is the
  next gap, not this decision.

## D17 — Skill arguments need a tool-schema seam; the engine is already theirs

**Decided.** The substitution engine lives in `dsh-anyplugin-skill-template` and
follows the pinned skills documentation, proven against a recorded trace. Wiring
it needs one additive change to `dsh-tool-skill` — an optional `args` on the
`skill` tool, substituted where `renderSkillContent` runs. Until that seam
exists, a skill that declares `arguments` stays `equivalent` with this reason.

**Why.** The 2.1.322 trace shows the model's tool call as
`{"skill":"skills-only:greet","args":"Ada"}`. DSH's `skill` tool declares
`parameters: { name }` and nothing else (`dsh-tool-skill/src/index.ts`), and
`renderSkillContent` takes a finished string. So the gap is the **channel**, not
the rules — and the rules are unusually precise, which is exactly why they are
implemented and tested now:

| Rule | Behaviour |
| --- | --- |
| `$N` | zero-based: `$0` is the first argument (commands are one-based — two engines, two specs) |
| `$ARGUMENTS[N]` | same position as `$N` |
| `$name` | declared in `arguments:` (YAML list or space-separated string), mapped in order |
| missing indexed | stays literal, does not count as received |
| missing named | expands to `''`, **does** count as received |
| nothing received | the body gains a blank line and `ARGUMENTS: <raw>` |
| one backslash before the token | the backslash is dropped and the token stays literal |
| two backslashes before the token | both stay and the token still expands |
| inserted value containing a placeholder | inserted literally, never re-expanded |

**Consequences.**

- `substituteSkillArguments` is tested against the trace line (`Greet $name.`
  plus `Ada` gives `Greet Ada.`) and against every row above; it is not wired.
- `IrSkill.argumentNames` carries the declaration so the materializer needs no
  second parse when the seam lands.
- `${CLAUDE_*}` substitution happens after arguments upstream and is out of
  scope here; treat it as a separate gap if a fixture needs it.

## D18 — A trace is the behavioral unit, and normalization is part of the contract

**Decision.** The rig compares hosts on a normalized event stream derived from
each host's turn trace, not on raw transcripts and not on prose judgments.

`normalizeTrace()` (`packages/dsh-anyplugin-conformance/src/trace.ts`) keeps
only what a host controls, in order:

| Kept | Source record |
| --- | --- |
| `init` with the offered tool names | `system:init` |
| `tool-call` name and input | assistant `tool_use` blocks |
| `tool-result` text | user `tool_result` blocks |
| `user-text` injected into the model's context | user `text` blocks |
| `assistant-text` the model's own prose | assistant `text` blocks |

Erased before comparison: the plugin root (becomes `<plugin>`), eval sandbox
paths (`<sandbox>`), UUIDs and session ids (`<uuid>`), tool ids and tool_use
ids (`<tool-id>`), ISO timestamps (`<ts>`), thinking blocks, and the result
record. Those differ per run and per machine; leaving them in makes every diff
red for reasons that are not behavior.

**Why.** D16 established that load-time inventory cannot see the difference
that matters most: a skill can load perfectly and still be *delivered*
differently. Only the message stream shows `Launching skill: …`, the
`Base directory …` prefix, and the substituted body. The comparison has to be
positional too — order is part of the behavior, so `diffTraces` aligns by index
and reports `match` / `differ` / `only-left` / `only-right`. A single insertion
cascades into `differ` rows, which is a signal, not noise.

**Consequences.**

- The recorded trace is stored raw under `fixtures/traces/<pin>/` with its
  provenance; the normalizer is applied at read time so a stricter scrub is a
  code change, not a re-capture.
- `system:init`'s tool list is the *offered* set, and it is filtered by the
  case's `allowed_tools` (the recorded case offers `Glob`, `Grep`, `Read`,
  `Skill`, `Task`, `TaskStop`, `ToolSearch` — no `Bash` despite the prompt).
  It is therefore a property of the case, not a universal claim about the host.
- The rig can run this comparison today only on the upstream side: DSH has no
  equivalent recorder yet, so `rig trace` diffs two recorded traces (a pin bump
  or a second host) but cannot yet diff DSH against Claude Code. Closing that
  loop needs a DSH-side source for model-visible messages; until then the trace
  half is a regression oracle plus a written spec for that recorder.

## D19 — Classic hooks ride the tool waterfalls, not the guard list

**Status:** ratified 2026-11-19, from S8.

`PreToolUse` maps to the `tools/pre-execute` waterfall and `PostToolUse` to
`tools/post-execute`. `ctx.tools.guard` is not used for hooks.

**Why:** the guard seam is monotonic denial only — it returns a reason, produces
no result to inspect, and cannot inject context. The waterfalls carry exactly
the two decisions a classic hook expresses: deny before dispatch (`{kind:'deny',
reason}` becomes `Error: <reason>` for the model) and enrich or replace after it
(`{kind:'accept', value, additionalContexts}`). A hook implementation on guards
would have had to invent a second path for PostToolUse, which is how the
"one interception kernel" rule (AGENTS §3.6) dies.

**Consequences:**

- The kernel's `observe` mode is the waterfall contract: `next()` continues,
  and a handler that returns a decision does not stop its siblings.
- Two facts are payload shape, not policy: a failed result's value cannot be
  replaced, and a standalone call has no `agent`, so agent-derived payload
  fields stay absent rather than guessed.
- Events that are not tool-scoped still have no host; the missing-event list
  shrinks to those, and each stays `planned` with a reason until it has one.

## D20 — A hook counts when it runs, and its payload is honest about what we lack

**Status:** ratified 2026-11-19, with the classic arm.

`dsh-anyplugin-hook-runner` runs a command handler with a payload carrying only
fields this host owns; `dsh-anyplugin-materialize-hook` mounts `PreToolUse` and
`PostToolUse` on the tool waterfalls (D19); the coverage row for a hook flips
only after one real call shows its effect.

**Why:** a hook is the one surface no registry can testify for. A handler that
was parsed, emitted, mounted and then never executed leaves exactly the same
inventory as one that works — a listener existing is not evidence that anything
listened. The honest test is a call that goes through the pipeline and comes
back carrying the hook's text.

**Consequences:**

- The payload omits `session_id`, `transcript_path`, `permission_mode` and
  `effort`. A hook that branches on them takes the absent branch, and the IR
  annotation says so; inventing plausible values would make a plugin pass its
  own checks for the wrong reason.
- Verdict translation is fixed: exit 2 denies with stderr as the reason; exit 0
  JSON may deny (`decision: "block"` or `permissionDecision: "deny"`) or add
  `additionalContext`; any other non-zero exit is a warning, never a block;
  `continue: false` and `permissionDecision: "ask"` have no equivalent and are
  reported, not obeyed.
- A `PostToolUse` denial is feedback, not a block: the call already ran, so the
  text joins `additionalContexts` instead of denying anything.
- A matcher that is not a valid regular expression matches nothing. Failing open
  would run a hook its author never addressed to that tool.
- Handler types other than `command` (`http`, `mcp_tool`, `prompt`, `agent`)
  stay `planned`; each needs its own decision about where it executes.

## D21 — The mod scan is lexical, and what it cannot prove is a `dynamic` site

**Status:** ratified 2026-11-19, with the scanner (v0.5 prep).

`dsh-anyplugin-mod-scan` reads a mod's source as text and returns literal
`on('event', matcher?)` sites, literal `$.namespace.method` call sites, and a
`dynamic` list for every capability-shaped construct it can see but cannot
prove. It never imports or evaluates the module, and it does not know Claude's
event vocabulary: event names are whatever the source says. `capabilityList`
returns the sorted, deduplicated `hooks:` and `calls:` lines Claude prints
before install; the trust prompt must show `scan.dynamic` and `SCAN_CAVEAT`
alongside them.

**The limit is part of the claim.** A lexical scan cannot see a capability that
leaves no literal site. The scanner exports a fixed, two-sentence `SCAN_CAVEAT`
naming the invisible categories: aliases (`const fs = $.fs`), imported helpers,
`eval`/`new Function`, and unrecognised syntax. A trust prompt that shows only
`scan.dynamic` would still imply the list is exhaustive, so it must display the
caveat too.

**Why:** a mod body is arbitrary JavaScript, and the pre-install review is only
worth anything if the reviewer sees both the capabilities that were found and
the ones the scan can see but could not prove. A scanner that silently skipped
computed access would make a computed namespace look like no capability at all,
which is worse than no scan. A scanner that transpiled or imported the mod to
inspect it would violate §3.7 and execute untrusted code before install. So:
extract the literal sites faithfully, report the visible-but-unprovable ones
with reasons, keep the invisible categories written down, and never present the
result as complete.

**Consequences:**

- The scanner is lexical, not a parser. It skips comments, strings, regex
  literals and template bodies; it recognizes direct identifiers only. A call
  through an alias (`const fs = $.fs; fs.read(...)`), an imported helper, a call
  of a `$` returned from another function, `eval`/`new Function`, and syntax the
  scanner does not recognize are invisible: no `events`, `calls` or `dynamic`
  entry is produced. `SCAN_CAVEAT` names those categories, and the trust prompt
  must display it. Computed access and template interpolations are visible at
  the site, so they are reported as `dynamic`. A local function named `on`, or a
  local `$` shadowing the mod API, is indistinguishable without type
  information; the scan reports the literal site rather than guessing, so it can
  over-report a capability that is not the mod API. It is a literal inventory,
  not an exhaustive one.
- Event names are source-derived, never checked against `CLASSIC_HOOK_EVENTS`.
  The two vocabularies are different surfaces (mod events vs settings hooks),
  and a scanner that normalized one into the other would invent a mapping the
  spec has not ratified.
- `line` points at the `on`/`$` token, so a reviewer can open the exact call
  site; for a multi-line call the arguments may be on later lines.
- The test fetches the pinned upstream `mods/diff/hooks/register.ts` at run
  time. Offline it skips with the URL in the reason. Upstream is all rights
  reserved, so the file is never vendored (D14); `fixtures/mods/PROVENANCE.md`
  records the pin and the real path.
- This is the scanner only. The mod host is v0.5 (D3); nothing here runs a mod.

---

## D22 — The harness under test is resolved by version, not by the machine

**Status:** ratified 2026-11-19, superseding D9's "never npm" clause. D9's
desktop-first probe and its `asar` consequence stand.

D9 inferred from npm's `@deepseek-ai` `latest` dist-tag (`0.0.1-rc.1`) and from
unpublished packages (`dsh-command`) that the published tree was a different
product. That inference was wrong: `0.0.1-rc.1` is a stale placeholder tag, not
the package list. npm carries `0.2.2-rc.1` … `0.2.2-rc.5`, and
`@deepseek-ai/dsh-skill@0.2.2-rc.2` has the same `src/index.ts` sha256
(`af4fad67fb086c3f5c93aed4604830718b4535e7e59a60d680404b07ea08477c`) as the
copy inside the Desktop app. A *pinned* npm tree is the same product D9 was
protecting; the hazard was an *unpinned* install.

The oracle now resolves the harness in this order, first match wins:

1. `DSH_HARNESS_DIR` — an install root made by
   `scripts/fetch-harness.mjs <version>`;
2. `DSH_INSTALL_DIR` — the Desktop installation's `@deepseek-ai/dsh` package
   directory;
3. `.harness/<DSH_HARNESS_VERSION>` — a fetched pin inside this checkout.

A named-but-unusable source is an error, never a silent fall-through. With no
source named, a local run skips the oracle tests with a reason; in CI that is
an error and the job fails before the suite runs. Fetching is an explicit,
idempotent step; the tests themselves are offline.

**Consequences:**

- CI fetches `0.2.2-rc.5` and `0.2.2-rc.2` and runs the suite against each; a
  failure to fetch or test either pin fails the job, and one pin's failure does
  not prevent the other from running. A skipped DSH-side test on CI is a bug,
  not a green run.
- Tests compare against `HarnessLocation.version` — the tree actually booted —
  rather than a hardcoded installed version. A `DSH_HARNESS_VERSION` that
  disagrees with the tree on disk is an error.
- The fetched tree contains the packages the oracle and materializers import
  plus pinned `cordis` 4.1.0, `cordis-plugin-loader` 1.1.0,
  `cordis-plugin-group` 1.1.0 and `@modelcontextprotocol/client` 2.2.0. It
  deliberately omits `@deepseek-ai/dsh` (the application), so the version comes
  from `dsh-skill`; when both packages exist they must agree.
- Direct dependencies are pinned exactly. npm still re-resolves their
  transitive ranges at fetch time (for example `@deepseek-ai/schemastery
  ~3.19.0`), so the fetched tree is reproducible at the direct-package level,
  not byte-for-byte; do not cite it as a lockfile claim.
- The Desktop install remains a first-class source and the pre-push evidence.
  D9's `asar` consequence stands: a truly archived bundle must be read with
  `ELECTRON_RUN_AS_NODE=1`.

---

## D23 — `installs.yml` is a canonical YAML subset, and the reader never repairs it

**Status:** ratified 2026-11-19, with `dsh-anyplugin-install` (v0.1).

The profile-global lock is a file the install layer owns, not profile config
(AGENTS.md §3.4):

```yaml
schema: "dsh-anyplugin/installs@1"
plugins:
  - dialect: "claude-code"
    name: "skills-only"
    version: "0.0.1"
    root: "/…/artifacts/claude-code/skills-only/0.0.1"
    dataDir: "/…/data/claude-code/skills-only"
    pin: "claude-code@2.1.322"
```

One record per installed plugin. Identity is `dialect:name`; `version` is
metadata. `root` is the versioned artifact the dialect reads on every compile,
`dataDir` is stable across updates (D2). `pin` is the host version the artifact
was read against (AGENTS.md §3.8). `source` is optional provenance. Everything
is a double-quoted JSON string, one field per line, records sorted by identity.

**Why:** we need persistence, but DSH's profile config belongs to DSH — writing
`cordis.patch.yml` at runtime would create a second writer and lose the
loader's actual state. A lock we own can be replayed through the loader and
compared against inventory. The file is machine-written and human-audited, so a
deliberately small, canonical subset is enough; it needs no YAML dependency. JSON
quoting removes YAML's implicit-typing traps (`1.2.3` stays a string, `no` is
not a boolean). The strict reader is the safety property: the only alternative
to parsing a malformed lock is guessing, and guessing "zero plugins" silently
uninstalls everything while guessing a path could point `root` at the wrong
artifact. `pin` makes a newer dialect fail loudly instead of reinterpreting an
old record.

**Consequences:**

- A missing file is an empty lock. An existing file that does not parse is an
  error — never an empty set.
- Unknown keys, missing required fields, duplicate identities, relative paths,
  unquoted values and non-canonical list forms are rejected with
  `InstallsFileError.reason` and a line. `writeInstalls` validates before
  writing and replaces the file via a same-directory temp file + rename.
- The writer emits fields in the fixed schema order and sorts records by
  identity, so the audit diff is stable even though the file is generated.
- `grants` live in the scope layers (D2), not here. Enabling a plugin that the
  lock lists but the layers do not mention is inert.
- Disabled plugins stay in the lock and produce no loader entry. The group's
  own fiber ignores `disabled`; child entries inherit it (S1). "Inert" is
  therefore represented by absence, and a UI shows "installed, disabled" by
  joining the lock with the scope layers. Uninstall means removing the record
  and reconciling, not writing a disabled flag.

---

## D24 — The upstream oracle runs the pinned Claude CLI from npm

**Status:** ratified 2026-11-19, forced by ticket #10 (the upstream half of the
rig did not run in CI).

The oracle's `claude` is the npm package `@anthropic-ai/claude-code` at the
golden's pin (`2.1.322`, `CLAUDE_CODE_PIN` in
`packages/dsh-anyplugin-conformance/src/pin.ts`), not whatever Desktop or
personal installation happens to be on the machine.
`scripts/fetch-claude.mjs` installs exactly that version into
`.claude-code/<version>/`, idempotently and with `--ignore-scripts`, and prints
the native binary's absolute path. The oracle resolves `CLAUDE_BIN` first, then
`claude` on `PATH`.

**Why npm, and not the desktop install.** The upstream half only runs
`claude --plugin-dir <dir> plugin details <name>`, which needs no login, no
network and no Desktop app — only a writable `HOME`, which the probe already
provides as a throwaway. CI has no Desktop installation, and "the binary on the
runner" is not a version. A pinned npm package gives CI the same observable
loader as the laptop without making the gate depend on the laptop. This is the
same reasoning as D22 for the DSH harness: the pin is the claim, the install
method is an implementation detail. D9's "never npm" clause was about the DSH
harness and is already superseded by D22; it says nothing about this client.

**Why `--ignore-scripts`.** At 2.1.322 the package's `postinstall` copies the
platform-native binary over the `bin/claude.exe` stub, and the package's
optional dependencies already ship that binary
(`@anthropic-ai/claude-code-linux-x64/claude`, `…-darwin-arm64/claude`, and so
on). Fetching runs no lifecycle scripts and points `CLAUDE_BIN` at the platform
binary directly. The alternative — letting an install script choose the binary
— would put unreviewed code in the path that produces the goldens.

**Resolution and failure.** The decision table is D22's, applied to a client:

| `CLAUDE_BIN` | `claude` on PATH | result |
| --- | --- | --- |
| set, executable | anything | that binary, source `CLAUDE_BIN` |
| set, non-empty but unusable | anything | error, never a fall-through |
| unset, empty, or whitespace-only | found | that binary, source `PATH` |
| unset, empty, or whitespace-only | missing | local: skip with a reason; `CI=true`/`1`: throw |

An empty or whitespace-only `CLAUDE_BIN` counts as unset: `CLAUDE_BIN= npm test`
is how a shell clears a variable, not a request for an executable named `""`.
Only a non-empty value that names something unrunnable is an error.

`CI` is read exactly as D22 reads it. The skip reason names
`scripts/fetch-claude.mjs` and the pin. A skipped upstream test on CI is a
failed job.

**The version is asserted, from one place.** `CLAUDE_CODE_PIN` is the only
literal: the fetch script imports it, the tests compare `claude --version`
against it, and the workflow's guard repeats the comparison before the suite. A
mismatch fails with both strings (`claude-code@2.1.999` vs
`claude-code@2.1.322`). A bump is one constant edit plus
`npm run capture:fixtures` and a reviewed golden diff (D8), never a workflow
edit.

**Consequences:**

- CI caches `.claude-code/`, keyed on `pin.ts` and the fetch script; a cache
  hit still goes through the version guard. The install is a one-time large
  platform package, so the cache matters.
- The resolved binary is recorded on `ClaudeProbeResult.bin`; the inventory
  keeps the `pin` (`tool` plus the observed `version`). The machine-specific
  path is deliberately not written into a golden, which must stay reproducible.
- The behavior face (`claude plugin eval`) and the Desktop-specific DSH paths
  remain local evidence: CI holds the inventory gate, not the money gate.

---

## D25 — Exec grants are pinned to artifact bytes in `grants.yml`

**Status:** ratified 2026-11-19, making AGENTS.md §3.5 true for the compile
path (ticket #11).

An `exec` artifact (`hook`, `monitor`, `bin`, `mod`) runs only when a grant
for its current bytes exists. The grant store is `grants.yml` next to
`installs.yml`, not a capability list inside an enablement line. A grant is
`{plugin, capability, target, artifactHash, grantedAt, scope}`; a revoke is
`{plugin, capability, target, scope}`. `plugin` is the install identity
(`<dialect>:<plugin>`), because `hook:PostToolUse#0` is only unique inside a
plugin and identical bytes in another plugin are a different artifact.

**The store is a canonical subset, like D23.** The file starts with
`schema: "dsh-anyplugin/grants@1"`, then `grants:` and `revokes:` lists, one
field per line, every value a double-quoted JSON string. The writer sorts records, quotes
values, writes fixed field order, and replaces the file through a
same-directory temp file plus rename. The reader refuses unknown or missing
fields, unquoted values, duplicate records, an unknown schema, a malformed
hash, or a capability outside `exec` with a `file:line` reason and leaves the
file alone. A missing file is an empty store; a malformed file is an error.
"Cannot parse" must never become "everything is granted" or "everything is
revoked". The writer takes an `O_EXCL` `grants.yml.lock` with a bounded retry,
and `updateGrants` holds it across read-modify-write; concurrent granting
actions must not lose one record to last-rename-wins.

```yaml
schema: "dsh-anyplugin/grants@1"
grants:
  - plugin: "claude-code:my-plugin"
    capability: "exec"
    target: "hook:PostToolUse#0"
    artifactHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    grantedAt: "2026-11-19T00:00:00.000Z"
    scope: "user"
revokes: []
```

**Scope is a record field, not a file location.** The install identity is
profile-global, so one file is the lock; each grant and revoke names `local`,
`project`, or `user`. Resolution takes the narrowest scope that mentions a
`(plugin, capability, target)` — `local` > `project` > `user` — and at that
scope a revoke beats a grant. A narrower refusal never falls back to a broader
grant: after a local revoke, an old user grant must not revive the artifact.
This supersedes the sentence in D23 that grants live in the enablement scope
layers (D2). An existing enablement line carrying `grants: […]` still parses
and the field is ignored; it cannot pin bytes, so it cannot authorize.

**A grant pins a manifest, not a promise to re-discover operands later.**
The manifest is resolved once, at classify/grant time:

```
artifact = { mode: "file" | "text" | "composite",
             invocation,                        // exact text or argv; hashed
             command,                           // eval payload, else ""; hashed
             files: [{ path, sha256, bytes }] } // the program only; hashed
hash     = sha256(mode, invocation, command, then each file's path + sha256, in order)
```

The boundary is **code versus data**. The program is code and its bytes are
pinned; every other operand is data and only the exact invocation text is
hashed. A program is `command[0]` when it resolves to a file inside the root,
or, for a known interpreter (`node`, `sh`, `bash`, `zsh`, `python*`,
`deno`, `bun`, `ruby`, `perl`, `pwsh`), the first non-flag operand that
resolves to a file inside the root. `node fmt.js data.txt` pins `fmt.js`;
`data.txt` is data.

`artifactHash` is `sha256:<64 lowercase hex>`. There is no sorting and no
`Set`: the invocation keeps order and duplicate words, so `cp a b` and
`cp b a` differ. At spawn the materializer re-reads exactly `files[].path`
and never re-parses the command. Editing `data.txt` does not invalidate a
formatter hook; editing `fmt.js` does. An output file cannot turn into a false
artifact on the second run.

- A program named by an absolute `${CLAUDE_PLUGIN_ROOT}/…` path, by an
  exec-form `args` entry, or by shell words is pinned. A **relative or
  outside-root program** is refused, because hashing it against the plugin
  root while executing it in the project would pin one file and run another.
  The reason names the fix (`use ${CLAUDE_PLUGIN_ROOT}/…`). Refused
  artifacts are `unsupported`: they cannot be granted at all.
- A **relative or outside-root data operand** is allowed. The hook's own cwd
  decides what it means; it is invocation text, not a pinned file.
- Flags, `--out` values, redirect targets, and positional inputs are data.
  Their **text** is in the invocation hash, so renaming a data operand or
  changing a flag is a new artifact; their **bytes** are not pinned, so
  editing the data does not re-prompt. `--out …/out.txt` can therefore be
  written twice without refusing itself.
- A command with no program inside the root (`echo …`, `sh -c '…'`,
  `node -e '…'`, `cat data.txt`) is `mode: "text"`: the exact invocation is
  the artifact. Interpreter eval payloads are code and are never mistaken for a
  flag; editing the payload invalidates the grant.
- A program plus other words is `mode: "composite"`: the exact invocation
  plus the program's bytes. A pure program is `mode: "file"`.
- Files under `bin/`, `monitors/`, and `mods/` are `mode: "file"` and pin
  their bytes.

Path is not identity by itself, but it is part of the manifest hash: a
byte-identical copy at another path does **not** match when the command names
the new path. mtime is never used. A symlink inside the root that points
outside pins the outside file's bytes — conservative, because those are the
bytes that run.

A hook target is `hook:<event>#<index>`, where `index` is flat per event
across matcher groups (two `PostToolUse` groups are `#0` and `#1`); a
directory artifact is `bin:<path>`, `monitor:<path>`, or `mod:<path>`.
Renaming a directory artifact changes its target (and therefore needs a grant
for the new target). Renaming a hook's script keeps the target but changes the
manifest path, so the grant refuses with the new hash; it is a re-prompt, not a
silent re-grant.

`grantFor`/`revokeFor` are the UI path: they validate the target against the
plugin's classification and reject an unknown or unpinnable target. `grant`/
`revoke` remain the low-level store operations for tests and for callers that
have already resolved a row.

**Default-off, and refused is not skipped.** `authorize(plugin, grants)`
returns allowed targets and refusals. A missing grant is `no-grant`, a matching
revoke is `revoked`, and a matching grant with different bytes is
`hash-mismatch`; the last carries both hashes so a UI can prompt, and it
never silently re-grants. Every refusal also carries the exact `command` (and
`args`, when the exec form has them). `gate` moves refused hooks out of the emittable
`hooks` list into `pending` as `planned` with a reason. `emitPlugin` takes a
`trusted` list (default empty); for a caller that skips the gate it reports a
carried-but-untrusted hook in `refused`, not `skipped`. The conformance report
marks `carry=refused:<capability>` from the gate decision, not by inferring it
from the emitter, and its totals line counts it separately. A plugin whose only
surface was refused contributes no group entry, so the hook does not reach the
loader as a disabled child or "not run"; it does not reach the loader.
`compileReport` returns the same per-plugin decisions for the install path, and
`reconcile` returns `refused` after removals/updates settle, without inventing
an entry.

**The pin is checked again at spawn.** The emitted hook child carries the full
`artifact` manifest plus `artifactHash`, `artifactMode`, `artifactRoot`, and its
flat `index`. The materializer re-reads exactly the manifest's files and
re-hashes the same mode/invocation/command/files order immediately before every
spawn; a
mismatch or a missing file does not run. `PreToolUse` denies with both hashes
and the command line, `PostToolUse` warns and skips the spawn. A re-grant plus
reconcile re-emits the new manifest, after which the new bytes run. Without
this, a grant checked only at reconcile time would claim more than it delivers:
the loader keeps the child config while the script can change underneath it.
There remains an unavoidable window between the re-read and `exec`; the claim is
about the manifest boundary, not about making the filesystem immutable.

**Consequences:**

- The conformance totals are unchanged: the hook fixture is granted explicitly
  in the DSH oracle tests, so `11 declared / 9 matched / 1 missing / 1 refused`
  still holds. A refused hook is a new row only when a fixture exercises refusal
  — none does yet.
- `bin`/`monitor`/`mod` rows are classified today but not gated, because no
  materializer emits them and nothing runs. When the mod host lands (§7) it
  must consume `authorize`, not invent a second gate.
- An exec grant is not install authority, enablement, a network decision, or a
  blanket `--yes`. It does not cover MCP or content-class artifacts, `matcher`,
  `timeout`, environment, the interpreter binary found on `PATH`, or files a
  script reads at run time. It pins the exact invocation text (including flags,
  order, and data names) and the program bytes; it does not pin the bytes of
  positional inputs, output paths, or redirect targets. It is one artifact's
  manifest at one scope. A relative or outside-root **program** is refused
  rather than pinned, so a plugin that relies on one loses fidelity until it
  uses `${CLAUDE_PLUGIN_ROOT}`; relative and outside-root **data** operands
  are allowed and are only invocation text.
- The claim is against claude-code `2.1.322` and the DSH pins in D22; a pin
  bump that changes hook semantics must revisit the hash rules, not just the
  goldens.

## D26 — An agent persona is a scoped tool, and the body is a user message

**Status:** ratified 2026-11-19 (ticket #19, S10).

`agents/*.md` personas are model-selectable in DSH as **one tool per agent**,
registered by our own materializer, because the host has no catalog: `dsh-subagent`
is a named-provider registry that registers no tool, and `dsh-tool-subagent`
registers one tool per provider with fixed wording whose `agent_preset` enum
carries ids but no per-agent description. Registering our own tool is the only
way the frontmatter description can reach the model.

**The name is `<plugin>:<agent>`, and the colon is accepted by `dsh-tools`.**
This reverses an assumption recorded earlier in this project: the
`[A-Za-z0-9_-]` charset rule belongs to `dsh-mcp-client`'s `serverName` (D11),
not to the tool registry. `ToolsService.register` accepts `agents-fixture:reviewer`,
`ctx.tools.schemas()` returns it unchanged, and `ctx.tools.execute` runs it.
So the model sees the same string Claude's `Task` tool exposes as
`subagent_type`. The consequence is structural: two plugins can declare the
same agent name without colliding, because the name carries the plugin. A
namespacing scheme of our own would have broken the `catalog` face to solve a
problem we do not have.

**The description is byte-equal; the body is never model-visible metadata.**
The tool description is the frontmatter `description` verbatim. The body is not
in the description, the parameter schema, or any other field the model reads —
a persona whose body leaked into its description would be a prompt-injection
surface by design. An agent with no description is `unsupported` with a reason;
a nested `agents/**/*.md` file is `unsupported` because the host reports
`Agents (0)` for a nested-only tree at this pin.

**Invocation is `equivalent`, not `exact`, and the gap is named.** The tool
calls `ctx.subagents.startActivation` with the body as the **first text block of
the child's initial user message**, followed by the caller's task. There is no
instructions field on `SubagentStartRequest` at the pin, so a true system-prompt
position is not expressible; a preset plus `dsh-persona` could move it later,
which is why the face is `equivalent` rather than `unsupported`. `model`
(`sonnet`/`opus`/`haiku` aliases), `tools`/`disallowedTools`, `effort`,
`maxTurns`, and `isolation` are `planned` per key: the child inherits the
parent's toolset and no per-activation filter or turn cap exists. The escape
layer (§9) is the only path to model identity.

**Seam-adaptive (P4).** Without `ctx.subagents` the catalog still loads,
`apply` records one warning, and each invocation rejects naming
`@deepseek-ai/dsh-subagent`; without `ctx.tools` the materializer warns and
applies nothing. Neither path throws at load.

**The oracle compares the registry against the emitted declaration, and a
fixture test is the independent anchor.** `agents:<name>` is emitted only when
`ctx.tools.schemas()` actually contains that name with the declared
description; the IR alone never adds a row. That proves registration, not
provenance, so `agents.test.mjs` reads the raw fixture bytes for the description
and the emitted `agents` child for the body. The commit message and comments
must not claim more than that pair.

**Consequences:**

- `fixtures/claude-agents` matches `agents:reviewer`. The denominator is **11
  declared / 10 matched / 0 missing / 1 refused**; the earlier "12" counted
  `agents/deep/planner.md`, which the host does not load at this pin and which
  remains an `unsupported` declaration rather than a declared row.
- The upstream "named, described agent catalog" proposal becomes optional: it
  would restore Claude's single-`Task` shape with a `subagent_type` enum, not
  add capability.
- Tool names are now the first place where our emitted identifiers can contain
  a character other than `[A-Za-z0-9_-]`. Anything that pattern-matches tool
  names (hooks, matchers, approval rules) must treat `:` as data. The command
  registry is unaffected: `dsh-commands` still has its own regex (D10).

## D27 — Consent is explicit, and a refusal is never erased by convenience

**Status:** ratified 2026-11-19 (ticket #17).

The grant/revoke CLI is the human consent surface for `exec` artifacts (D25).
These rules are the surface's contract, not preferences:

- **Effective trust is decided by the narrowest scope with any record; inside
  one scope a revoke beats a grant; a narrower record never falls back to a
  broader one.** A grant is consent, a revoke is refusal, and refusal wins
  where both exist. The CLI prints which record decided, at which scope.
- **`grant --yes` is all-or-nothing by default.** If any artifact is unpinnable
  or any same-scope revoke would be erased, it exits 1 and writes nothing.
  `--partial` is the explicit opposite: write the pinnable rows, name every
  skipped artifact, and still exit 1. `revoke` never needs `--partial`; it is
  one record.
- **Changing an artifact re-prompts; it does not silently re-grant.** Same
  scope plus different bytes is `pending` with `old hash → new hash`, and
  `--yes` replaces that record. A changed artifact never inherits consent.
- **Consent never erases a refusal.** A same-scope revoke is cleared only by
  `--replace-revoke`, which clears exactly the targets being granted and prints
  each one. The failure mode this prevents is real: without it, granting a
  newly added third hook silently re-enabled a hook the person had refused.
- **Revocation reads the record, not the artifact.** `revoke --target` succeeds
  when the plugin directory is gone, when the hook declaration was removed, or
  when the pinned program no longer exists; the output then says
  `artifact: unavailable` (JSON `null`) with the hasher's reason, instead of
  printing a declaration hash as if it were the artifact. If the old bytes
  reappear, the revoke still refuses them. A revoke for a classified target
  with no grant is allowed and records a pre-emptive refusal; it is not a
  no-op and is documented as such.
- **The surface must not lie, in either direction.** A write run never prints
  "not granted" after granting; `alreadyRevoked` is false on the write that
  revoked; TOCTOU guards re-plan under the write lock and name the actual cause
  (plugin bytes vs grants store) rather than a generic one; `pluginRead:false`
  with a reason when the directory is missing.

**Consequences:**

- Exit 1 now means "nothing was written" for `grant` without `--partial`; a
  script that needs partial writes must pass `--partial` and treat exit 1 as
  "some rows were refused".
- The default scope is `user`, the broadest one, and every output prints it.
  The CLI never infers a scope from cwd; it reads no project file.
- `bin`, `monitor`, and `mod` rows are classified and can be granted, but
  nothing gates them yet because no materializer emits them. When one lands it
  must consume `authorize` rather than invent a second gate.
- A grant is one artifact's manifest at one scope. It does not cover data bytes,
  `matcher`, `timeout`, environment, the interpreter on `PATH`, or files read at
  run time (D25).

## D28 — Classic hooks fan out; the kernel owns the continuation rule

**Status:** ratified 2026-11-19 (ticket #25, spike S12).

Measured against `claude-code@2.1.322`, not inferred: a plugin with two hooks
on the same event, the first exiting 2 (deny) and the second writing a marker —
**the second still ran**. The same held for `PostToolUse` and `Stop`. The
upstream client dispatches matching hooks concurrently, so marker arrival order
varies; what is stable is that every matching hook runs. A decision therefore
does not stop its siblings (this is the rule D19 stated for classic hooks, now
measured rather than asserted).

Our encoding:

- `runChain` has two continuation modes. `first-decision` is the mod front-end
  default (a mod that returns a decision ends its chain). **`fan-out`** runs
  every matching registration, records every trace step, and returns the
  collected decisions. `classicHookRegistration` declares `fan-out`, so a
  caller cannot register classic hooks and silently get `first-decision`.
- We run handlers sequentially in registration order. That is a deliberate
  divergence for a deterministic trace; we do **not** claim the upstream
  concurrent interleaving.
- Aggregation belongs to the front-end, because only it knows the host channel:
  `PreToolUse` denies if any handler denies (reason = the first denying
  handler's text, by order) and keeps every `additionalContext`;
  `PostToolUse` appends every context and treats a denial as feedback, never as
  a chain stop; lifecycle events report decisions without skipping siblings.
- A handler that throws or exceeds its budget is skipped in the trace and does
  not silence the rest. Timeouts are per handler, never per chain.

**Consequences:**

- Any future consumer of the kernel picks a continuation mode explicitly; the
  disagreement case (registrations declaring different modes with no option)
  is an error, not a guess.
- The upstream concurrency is a declared divergence, recorded in
  `ARCHITECTURE.md` §7.2/§10. If a plugin depends on hook ordering between
  siblings, we cannot reproduce it.
- Evidence: `spikes/s12-hook-fanout` (local-only, key-gated),
  `fixtures/claude-hooks-fanout`, and the kernel-on-path tests.

## D29 — Output styles are `planned`: the agent-scoped prompt seam is reachable

**Status:** ratified 2026-11-19 (ticket #26, spike S11).

Earlier in the same ticket the project recorded output styles as `unsupported`
on the claim that DSH had no seam. That claim was **wrong** and is withdrawn.
What is true:

- There is no plugin-*keyed* prompt layer, but there is an **agent-scoped** one:
  a section registered through an agent's `ctx.systemPrompt.section()` belongs
  to that agent and unwinds with it. A plugin can reach that scope in four
  proved ways: `agentLoop.createAgent(ownerCtx, { setup(agentCtx) })` for an
  agent it creates; an `agent/created` listener using `payload.agent.ctx`
  (filtered by id — the event carries no plugin id); a command handler using
  `invocation.agent.ctx` for the agent that invoked it; or `dsh-persona` /
  agent-preset mounting on the agent scope.
- `complete: true` makes the style body the sole prompt section byte for byte;
  without it the section appends. A setup section survives compaction.
- A direct `section()` from a Loader entry's own `apply(ctx)` lands in the root
  layer and reaches every agent. That is the one form we must not use.

So each `output-styles/*.md` is one `planned` row, and `manifest:outputStyles`
is a `planned` row. Four gaps keep it from being carried today:

1. **Provenance.** `agent/created` carries the agent but no plugin id; an
   at-start contribution needs an id filter or a plugin-created agent.
2. **Activation.** `/<plugin>:<name>` needs D10's additive command-alias seam;
   `COMMAND_NAME` rejects `:`, and no non-colon alias mapping exists — an alias
   would be new additive work, not an existing equivalent.
3. **Oracle.** `claude plugin details` at 2.1.322 does not inventory output
   styles, so a carry fixture must compare a dumped composed prompt rather than
   a golden component list.
4. **Composition.** `keep-coding-instructions: true` retains Claude's built-in
   coding instructions, which a `complete` section cannot express;
   `force-for-plugin` is session-wide, so applying a style to the whole session
   is an explicit user choice, never an automatic global injection.

**Consequences:**

- `unsupported` is reserved for a style that cannot be represented even per
  agent; none is. No fixture is added until the carry exists; the coverage
  matrix stays at 16 declared / 15 matched / 0 missing / 1 refused, and no row
  moves until a dumped prompt shows the style text.
- The upstream ask is D10's command alias, not a new prompt-seam proposal.
- Evidence: `spikes/s11-prompt-scope` (18 checks, in CI) dumping
  `options.messages[0]` for each path, including the exact `complete` prompt
  and sibling isolation.

## D30 — Mods load as authored; type stripping is the only sanctioned transform; `.tsx` remains `planned`

**Status:** ratified 2026-11-19 (ticket #30, spike S13).

A mod's `.ts`/`.js`/`.mjs` source is loaded without transpilation, bundling,
minification or rewriting, and the static scanner must continue to see the
authored `on('event')` / `$.ns.method` call sites. For `.ts`,
`module.stripTypeScriptTypes(source, { mode: 'strip' })` is the only sanctioned
transform. It is in-memory and position-preserving; it does not edit the
artifact or feed the scanner. The name-preserving `.tsx` stubs used by S13 are
probe scaffolding, not a host mechanism and not a sanctioned transform.

The host **must** resolve the authored graph's specifier conventions:
extensionless directory imports (including `'.'`) via `index.ts`, `.js`
specifiers to `.ts` files, and `.jsx` specifiers to `.tsx` files. These are
resolution rules, not source rewrites; they change no on-disk bytes. They are
our host obligation, not an upstream specification. The pinned graph exercises
three resolution behaviors (four specifier shapes); the resolver's other
candidate fallbacks are probe-only. `.jsx`→`.tsx` reaches a `.tsx` module but
does not make JSX runnable.

`.tsx` remains `planned`. Stock Node refuses the extension with
`ERR_UNKNOWN_FILE_EXTENSION`. At this pin, 20 of 21 `.tsx` modules fail
`stripTypeScriptTypes` in both modes: 19 with `Expected '>', got 'ident'`, one
with `Expected ',', got '.'`. The one JSX-free module
(`views/body/list-block-of.tsx`) strips, but the extension is still not
loadable by stock Node. JSX is not type stripping: it is a second transform
producing a different program and needs a factory (`h`/`Fragment`) and a
separate decision. A module that reaches JSX is not claimed runnable.

**Amended by D34 (2026-11-19):** `.tsx` is no longer `planned`; a `.tsx`
module that declares the classic pragma loads through one narrow transform,
and D31's `.tsx` refusal is superseded for exactly that case. The rest of
D30 — authored bytes, the scanner's view, and type stripping as the only
transform for `.ts` — stands.

The mod host will evaluate each mod in a per-mod `node:vm`
`SourceTextModule` context, requiring `--experimental-vm-modules` (create →
`link()` once → `evaluate()`), because it is the tested route whose context
lacks `process`, `URL` and `$`; a same-thread import exposes Node globals.
This is a fidelity and layering choice, **not a security boundary**: it does
not contain timers, promises, memory, or the mod's permissions. D6 is
unchanged: mods are hosted in-process and unsandboxed, with the equivalent
guard layer and hash-pinned grants. `$` is passed to each handler as its first
argument, not installed as a global; module-level code that touches `$` fails.

S13 proves the `.ts` spine loads, the registration surface matches the
scanner, and `session.start` runs with a per-handler `$`; it does not establish
a host, materializer, emit path, IR change, `.tsx` or JSX support, element
runtime, `$.ui`, longer hooks, or containment. No artifact is vendored (D14);
the fetched tree lives under `out/` and is gitignored.

**Consequences:**

- The host ships a resolver and a linker before any mod can be loaded; they are
  prerequisites, not new subsystems (§7.3 is unchanged).
- A JSX transform, if ever adopted, needs its own decision entry; it cannot be
  smuggled in as "type stripping".
- Any mod whose reachable graph contains JSX is `planned`, not `unsupported`:
  the blocking transform is named and scoped.
- The spike's evidence contract is the citation for "0 checks exits 1"
  (`docs/ARCHITECTURE.md` §10, S9 note), not D19.

## D31 — Mod-host skeleton: one authored mod per vm realm; strip in memory; three resolver rules; `.tsx` refused

**Status:** ratified 2026-11-19 (ticket #33).

`loadMod({ root, entry, host })` loads one authored mod and resolves to a frozen
`{ registrations, evaluate(), dispose() }`. `registrations` are the
`{ event, matcher, handler }` records declared by the mod's
`export function register(on)`, in source order. The returned handler is called
as `handler(event, next)`; the authored handler it wraps is called as
`($, event, next)`, where `$` comes from `host.dollar()`.

`$` is never a global. The host calls `host.dollar()` exactly once immediately
before each handler invocation and never caches the result. `ModHost.dollar()`
must return the namespace for that invocation; the host does not clone, freeze
or reuse it, and a host that returns the same object for two calls has reused
it. Module-level code that reads `$` fails with the realm's own
`ReferenceError`.

`loadMod` evaluates the entry once before resolving. `evaluate()` is an
idempotent accessor that never evaluates twice and rejects after `dispose()`.
`dispose()` makes the realm inert: `evaluate()` and every returned handler
reject with `ERR_MOD_HOST_LINK`, and no new `on()` calls are accepted. It does
not destroy the vm context (Node has no such API); the returned registrations
keep the realm reachable while they are held.

The host applies no transform except
`module.stripTypeScriptTypes(source, { mode: 'strip' })` in memory and writes
no authored bytes. It resolves only extensionless/`'.'` imports to
`<dir>/index.ts`, `.js` to `.ts`, and `.jsx` to `.tsx`; no fallbacks, no stubs.
`.tsx` is refused, not emulated. Each mod gets one `node:vm`
`SourceTextModule` context (create → link once → evaluate), which requires
`--experimental-vm-modules` and exposes neither `process` nor `URL` nor `$`.
This is a fidelity/layering boundary, not a security boundary; D6 stands. The
realm is not containment: `on` is a host-realm function, so
`on.constructor('return process')()` reaches host globals.

Load failures are `ModHostError`s with one of four codes:

- `ERR_MOD_HOST_TSX`: the reachable graph reaches a `.tsx`; the message names
  the module; there is no stub.
- `ERR_MOD_HOST_MISSING`: the root, entry or a named module is absent, or the
  entry is absolute, outside `root`, or not a file.
- `ERR_MOD_HOST_UNSUPPORTED_EXT`: an entry extension other than
  `.ts`/`.js`/`.mjs`, or a specifier extension with no D30 rule. Direct `.ts`
  and `.mjs` specifiers are refused; `.js` specifiers resolve only to `.ts`;
  a direct `.tsx` is `ERR_MOD_HOST_TSX`.
- `ERR_MOD_HOST_LINK`: a non-relative/bare/URL specifier, a graph
  read/strip/link/syntax failure (including a missing named export), a missing
  or misused `register(on)`, or use after `dispose()`.

Authored errors are never wrapped: a module-level `$` remains the realm's
`ReferenceError`, and a throw from `register` or a handler keeps the mod's own
stack.

At the pin (claude-code 2.1.322, commit
`6e1e44f6433bfa17d198e932bff53373aa229eea`), `diff`'s `register.ts` reaches
`./views` → `views/index.ts` → `export * from './pane-view.jsx'`; ESM links the
whole graph before a hook can fire, so `loadMod` throws `ERR_MOD_HOST_TSX`
naming `views/pane-view.tsx`. Therefore no mod whose reachable graph reaches or
re-exports a `.tsx` is loadable at this pin; the JSX decision gates that class,
not only drawing. The refusal is the upstream acceptance; S13's fired hook
depended on `.tsx` stubs, which D30 forbids as a host mechanism. This does not
claim that every upstream mod is blocked: only graphs that reach a `.tsx` are.

**Consequences:**

- The `diff` fixture's nail is the *refusal*, not a fired hook; "a real mod
  loads" stays blocked until the JSX decision, and that decision is deliberately
  separate from this one.
- `$` freshness is a `ModHost` contract, not host-enforced; the isolation test
  runs a host that would violate it if the wrapper cached.
- The host is inert after `dispose()` but does not free the realm; callers must
  drop the registrations to let it be collected.

## D32 — Mod events ride the one kernel; the mapping is data

**Status:** ratified 2026-11-19 (issue #36, PR #37); amended 2026-11-19 (issue #39, PR #44).

**Context.** `loadMod` (D31) returns a mod's `register(on)` registrations, and
`dsh-anyplugin-intercept` already owns tier ordering, matchers, continuation
and trace for classic hooks (D13, D28). AGENTS §3.6 forbids a second event path,
so mod registrations must become kernel registrations — not a parallel
dispatcher. The mapping from a mod's `on('…')` name to a host seam is the
fidelity claim, so it is data with evidence, not code with comments.

**Decision.**

1. **One kernel, one chain.** `modRegistrationsToKernel` emits
   `HandlerRegistration`s with `mode: 'wrap'`, `continuation` left unset, source
   order preserved, and no per-mod tier table. A mixed chain is one `runChain`;
   the classic arm's `fan-out` declaration owns continuation (D28). `tier` is
   the host's seating, passed by the caller; `user` is a **fallback** for a
   caller with no seating, never a derivation, and `core` is rejected (it is
   the engine's own seat).
2. **The mapping is data, pinned to the spec.** `mod-events.ts` holds one row
   per mod event with its host seam and its `claude-code.d.ts` evidence. Pin:
   claude-code 2.1.322, commit `6e1e44f6433bfa17d198e932bff53373aa229eea` (the
   file's own header still says 2.1.277 — cite the commit, not the header).
   `on()` names are exactly `EngineEventOf` plus `classic.${ClassicHookEvent}`
   (d.ts:941-953); there is no separate mod vocabulary. The names guessed in
   the ticket — `post.tool.use`, `pre.tool.use`, `turn.stop`, `subagent.start`,
   `subagent.stop`, `tool.use.failure` — do not exist at the pin; each is
   reported absent and points at its real spelling (`classic.PostToolUse`,
   etc.), never aliased.
3. **Patterns are first-class.** `on()` takes `EventName | Glob | Negation`
   (d.ts:6101, 4211, 5256). A pattern expands to the routed names it selects
   (`classic.*` → 16, `*` → 17, `!tool.*` → the complement with tool routes
   excluded); a selected-but-unrouted name keeps its own S9/D31 reason, and an
   unexpandable pattern gets a `pattern` reason. Nothing is dropped as "not an
   event".
4. **`session.start` is live per load, before the first prompt.** The
   materializer fires it from the same `apply` that loads the mods (Cordis
   awaits `apply`), once per loaded plugin — not per session, not per
   `agent/created`, not after `/clear`. A reload is a new `apply` and fires
   again with exactly that load's registrations. A second agent or session in
   the same process does not fire it. On a late enable or reload a root may
   already be live, so "before any agent exists" is false for that path; the
   claim is "once per load, before the first prompt of the process". At the fire
   there may be no session: `$.session.id` is absent and `messages()` is `[]`;
   `$.command.register` reaches the host's command registry when one is mounted
   (without one it is `ERR_MOD_HOST_COMMAND_UNAVAILABLE`, not a silent
   `undefined`), while `$.tool.register` still throws — it is not bridged.
   Command registrations are visible for the load's lifetime and disposed with
   it. The pin's payload is
   `{cwd, surface, isInteractive}`; `cwd` is the live root's cwd when one
   exists, otherwise the process working directory, never
   `CLAUDE_PLUGIN_ROOT`; `surface` and `isInteractive` are host/session facts
   `apply` cannot observe, so they are omitted and reported as an unbridged
   field gap with a reason — never filled with invented values. The first-load
   guarantee that a `$.tool.register` is visible to turn one is not claimed
   until `$` registration is bridged. **(Amended 2026-11-19 by #51:**
   `command.register` is bridged; the original sentence said both threw.)**

   A seat is per agent, on `payload.agent.ctx`: created for every agent already
   live when `apply` runs (`ctx.agents.list()`) and for every
   `agent/created`; `createSeat` is idempotent per session id. A reload
   disposes the old seat with the plugin effect and re-seats the live set,
   without replaying `classic.SessionStart`. `agent/disposed` disposes the
   seat. The plugin-entry context is never used for agent events. One seat runs
   `[mod registrations, classic registrations]` in one fan-out `runChain`; a
   mod that returns without `next` does not skip the classic arm, and later
   arms see the rewritten event. `classic.SessionStart`/`SessionEnd` are
   root-only; `SubagentStart`/`SubagentStop` ride the root carrier. The
   plugin-level classic mounts remain only for agentless calls; a live agent
   reaching them is a bug, not a fallback.

5. **What stays unmapped, and why.** 17 classic names: six S9-unprobed
   (`TaskCreated`, `TaskCompleted`, `TeammateIdle`, `WorktreeCreate`,
   `WorktreeRemove`, `StopFailure`), ten S9-refuted with a per-name reason
   (`Notification`, `PreModelSwitch`, `InstructionsLoaded`, `DirectoryAdded`,
   `Setup`, `UserPromptExpansion`, `MessageDisplay`, `PostToolBatch`,
   `Elicitation`, `ElicitationResult`), and `PostModelSwitch` declared but
   unprobed. 39 engine names: the UI/element, prompt-element and session
   families. `tool.call` is unmapped for **protocol mismatch** —
   `tools/pre-execute` carries the classic `PreToolUse` protocol while
   `tool.call` returns engine `{deny}`/`{result}` — not because routing it would
   double-fire. `PermissionRequest`/`PermissionDenied` record that their S9
   payloads are partial (no `tool_input`; no tool name/input).
6. **Continuation divergence is explicit.** A mod-only chain is
   `first-decision`: `next(e)` runs the chain beneath and resolves that event's
   `ClassicResultOf` (`{cwd}` for `session.start`). In **fan-out**, a mod's
   `next(e)` only rewrites the event for later registrations; it does not run
   the classic arm and resolves the kernel's continue, not `ClassicResultOf`.
   D13's "a mod that declines `next()` owns the rest of the chain" is therefore
   a `first-decision` statement; in a fan-out channel the channel owns
   continuation.
7. **Classic results are translated, never collapsed — inside the adapter.**
   A mod's `classic.PreToolUse` `updatedInput` becomes the chain event rewrite
   and is applied by §9; a `hooks.json` command hook's `updatedInput` is carried
   by `HookVerdict` and routed through the same rewrite, and a value that is not
   lossless JSON is a typed unsupported naming the field, never a silent
   continue. `ask`, `preventContinuation`, `stopReason`, `updatedToolOutput`,
   `updatedMCPToolOutput`, `decision`, and unknown fields stay typed
   unsupported. Classic events return `ClassicResultOf`, not engine verbs.

8. **`$` stays per invocation.** The adapter never receives `$`; D31's host
   wrapper calls `host.dollar()` once immediately before each invocation and
   never caches it. The proof through the adapter is transitive — two kernel
   runs build two namespaces; caching in the wrapper turns both the adapter and
   the host isolation test red.
9. **`updatedInput` is applied by the materializer, through one guard.**
   `modRegistrationsToKernel` has a production caller: the materializer.
   `updatedInput` is applied by the same pre-execute mount after the chain: the
   final `tool_input` is validated as lossless JSON, cloned and deep-frozen; the
   execution object's `arguments` property is checked writable (own data
   property writable, or a setter); then it is assigned before `next()`. A
   non-writable property, a non-JSON value, or a missing `tool_input` is a typed
   `unsupported` (trace/warn), never a silent no-op. This is a private-API
   mutation: `ToolExecutionInput.arguments` is readonly, the published contract
   says arguments are already logged/presented and input rewriting is excluded,
   and `PreToolDecision` has no value channel (`{kind:'accept', value}` is a
   denial). It is recorded because it is the only seam available today; a host
   change that freezes `exec` earlier must produce the typed unsupported, not a
   crash or a dropped rewrite. Later pre-execute handlers see the rewritten
   `exec.arguments`; that side effect is tested. The pin requires schema
   validation of `updatedInput`; if the host cannot validate, that is a typed
   unsupported too. No second dispatcher or parallel event path is added.

**Remaining (amended 2026-11-19 by #51).** `$` breadth: the 23 measured sites
across 10 namespaces are bridged (fs resolves in the session working directory
and accepts absolute paths, store confines to plugin data, settings serves only
a host merged snapshot), while `tool.register`, `ui.*`, `process.run` and
`settings.read` without a merged host snapshot remain typed refusals. Also
remaining: the unmapped engine and classic events, the element/UI runtime,
`session.start` surface facts, and classic command-hook `updatedInput`. `.tsx`
loads under D34, not a refusal. The fixture matrix stays 16 declared / 15
matched / 0 missing / 1 refused while `mods` is planned for those gaps — not
because the mod is unseated.

**Evidence.** 375 tests passed on both pins when this decision was ratified;
the amended scope is covered by 391 on both pins (#51: `0.2.2-rc.5`,
`0.2.2-rc.2`), `check:arch` clean (18 packages / 45 files). Mutations: dropping the
`session.start` fire reddens both mod tests; removing the live-agent sweep
leaves a pre-existing root and a reloaded root unrevised (`ls`, not
`ls-first`); routing a second agent's call through the first seat's `$` reds
the cross-seat test; ignoring a command hook's `updatedInput` leaves the tool
at `ls-first`; dropping the writable guard throws on a read-only execution
object; skipping the lossless-JSON check runs `undefined`; and taking
`session.start`'s cwd from `CLAUDE_PLUGIN_ROOT` reds the live-root payload.

**Consequences.**

- Mod registrations now have exactly one path into execution, and adding a
  route is a table edit with a `d.ts` line — reviewable without reading the
  adapter.
- The ticket's wrong event names are recorded here so the next ticket inherits
  the corrected vocabulary instead of repeating the guess.
- A live agent is seated at load and re-seated on reload; an agentless call
  still uses the plugin-level classic mounts, and a seated call never does.
- `updatedInput` rewrites execute; the remaining `$` breadth is an adapter
  limit with a recorded reason, not a silent drop.

## D33 — The Codex/portable dialect claims only what it can state; its budgets and caveats are Codex's.

**Status:** ratified 2026-11-19 (issue #40, PR #43).

The Codex dialect targets Agent Plugins 1.0.0 and the Codex compatibility layout. It is a compile-path dialect and adds no DSH host seam. Its guarantee is limited to the declared portable surface: skills under `skills/`, `mcp.json` servers, and command hooks that have an established S9/D32 host seam and a pinned exec grant. Everything else is `planned` or `unsupported` with a reason naming the surface or event.

There is no offline `codex plugin details` oracle. The `codex-portable` golden is hand-authored from the 1.0.0 schemas and the Codex hook documentation; it is a declaration, not an observation, and is excluded from totals described as upstream-observed. The DSH side remains an observation.

The published 1.0.0 `mcp.json` schema requires the top-level `mcpServers` wrapper; a flat map is treated only as a recorded non-portable compatibility extension. Before a server is carried, its entry is checked against the closed 1.0.0 variants: `command` is a bare token or `./`-relative and contained in the root; `cwd` is `./`, `${PLUGIN_ROOT}`- or `${PLUGIN_DATA}`-rooted and contained after expansion; unknown fields (including a documented `extensions["com.openai"].auth` block) are recorded as unsupported and not carried; `http` is accepted only from the `.mcp.json` compatibility location, never in portable `mcp.json`; `sse` is schema-valid but has no DSH materializer and is refused with a reason. A root `SKILL.md` is read only as a compatibility extra; it is not a 1.0.0 component and is not counted as one.

Codex names tools `mcp__<server>__<tool>`. The budget is `5 + len(server) + 2 + len(tool) <= 64`, i.e. `len(server) + len(tool) <= 57`; with a one-character tool this is `len(server) <= 56`. The dialect refuses a server whose shortest possible name exceeds 64, stating the prefix length, the shortest name and the limit, and never truncates or renames. There is no `plugin` segment and no DSH server-name budget in this path: the MCP materializer connects directly rather than through `dsh-mcp-client` (D12), so the 32-character `plugin_<plugin>_<server>` constraint that binds Claude does not apply. The prefix is carried as data on `IrMcpServer.toolNamePrefix`; absent means Claude's composition, and no Claude path sets it.

Replacement is not merge: an object `extensions.com.openai` is the sole source of OpenAI settings and the overlay's equivalents are recorded as replaced; an explicit `extensions.com.openai.hooks` replaces default `hooks/hooks.json` discovery, and the shadowed file is recorded. The overlay fallback applies only when the object is absent; a malformed value is recorded and does not resurrect the overlay.

Hook faithfulness reuses the single S9/D32 seam table; no second route is introduced. `equivalent` is claimed with each seam's own caveats, not a generic "same contract": the materializer feeds the Claude-shaped payload, so fields the host lacks are omitted and reported with a warning; `Stop` and `SubagentStop` cannot continue a turn or child, so a block is reported with a warning instead of obeyed; `SessionEnd` is advisory; `SubagentStart` cannot stop the child; `SessionStart` `additionalContext` is reported, not delivered. `matcher` is dropped only for the five events Codex ignores; undeclared timeouts use Codex's 600 s default (1 s for `SessionEnd`/`Interrupt`, capped at 3 s); a `${PLUGIN_DATA}` command is `planned` because trust cannot pin host-created data; `${PLUGIN_ROOT}` is stored as `${CLAUDE_PLUGIN_ROOT}` because trust resolves only that spelling, and the hook materializer exports both names at spawn.

A manifest whose `$schema` is missing or foreign, or whose `name` is invalid, is recorded as unsupported and the file is still read for diagnosis. This differs from spec §5.2, which makes a required-schema violation fatal; components read from such a file are diagnostic, not evidence that the plugin is 1.0.0-conformant. Because the IR has no dialect field, the plugin `source` records `codex:<root>`.

The dialect is not yet wired into `compileReport` (install remains Claude-only); that is a follow-up, not a claim made here.

## D34 — `.tsx` loads through one narrow classic-pragma transform; `h`/`Fragment` are realm globals, not a renderer

**Status:** ratified 2026-11-19 (issue #45, spike S14).

**Context.** D30 kept `.tsx` `planned`: JSX is a second transform producing a
different program, and stock Node refuses the extension. At the pin
(claude-code `2.1.322`, commit
`6e1e44f6433bfa17d198e932bff53373aa229eea`) all 21 `.tsx` modules under
`mods/diff/hooks` declare the three classic pragma comments (`@jsxRuntime
classic`, `@jsx h`, `@jsxFrag Fragment`) and none imports `h` or `Fragment`.
The graph reaches them through `views/index.ts`, so `diff` could not load and
the TODO item "Upstream mods as fixtures" was blocked on exactly that refusal.
S14 answers the question: all 21 transform, type-strip, link and evaluate in
one `node:vm` realm; the whole graph registers 10 `on()` sites over 8 unique
events, and the scanner still reports its 10/8/23 `$.` calls/0 dynamic.

**Decision.**

1. **One transform, `.tsx` only, gated.** The host reads only each file's
   leading comment block. It must declare `@jsx h` (the identifier `h`, not a
   path, member expression or alias); if `@jsxRuntime` is present it must be
   `classic`; if `@jsxFrag` is present it must be `Fragment`. A missing or
   foreign pragma is `ERR_MOD_HOST_TSX` with a reason naming the file and no
   `.tsx` module is loaded. A direct `.tsx` import specifier is still refused:
   authored JSX imports spell `.jsx` (D30).
2. **The transform is Babel's classic JSX transform, used narrowly.**
   `@babel/plugin-transform-react-jsx` with `runtime: 'classic'`, `pragma: 'h'`
   and `pragmaFrag: 'Fragment'`, over a parser that already understands JSX and
   TypeScript. It runs once per `.tsx` at load time, in memory, and rewrites
   JSX syntax only; D30's `stripTypeScriptTypes(..., { mode: 'strip' })` follows
   it over the same in-memory text. No bundler, preset, module transform,
   minifier or source map is involved, and the authored file is never edited.
3. **`h` and `Fragment` are realm globals.** `h(type, props, ...children)`
   returns a plain `{ type, props, children }` descriptor. `Fragment` is a
   unique symbol. The realm adds nothing else: no `$`, no `process`, no `URL`,
   no element runtime, no renderer and no `$.ui`. A host that draws descriptors
   is a separate, still `planned` surface; S14 and the host tests assert the
   descriptor, not a rendered string.
4. **What "as authored" now excludes.** For `.tsx`, Babel reprints the module,
   so the earlier byte/position-preservation claim does not extend to JSX
   modules: source positions and source maps are not claimed, and bytes need
   not match. The semantic claim is narrower — only JSX syntax is rewritten
   and nothing else is transformed. The scanner still reads the authored text
   and never sees the transform's output; the `.ts` path (in-memory strip,
   preserved positions) is unchanged. This is the only exception to D30's
   "no transpile" rule, and it is declared here rather than implied.
5. **The dependency and why.** The host pins `@babel/core` `7.29.13` and
   `@babel/plugin-transform-react-jsx` `7.29.7` exactly (the lockfile records
   the resolved tree). Babel is a real JSX parser and transform rather than a
   regular-expression rewrite, it runs synchronously in plain Node at test
   time and at load time, and only the JSX plugin is enabled, so the package
   gains a load-time transform without gaining a compiler pipeline. This is
   the mod-host package's first runtime dependency.
6. **What is still not supported.** Rendering and the element runtime
   (`h()` builds descriptors only); the automatic runtime and any
   `@jsxRuntime` other than `classic`; any `@jsx` other than `h`; any
   `@jsxFrag` other than `Fragment`; a `.tsx` module with no pragma; JSX in a
   `.ts` file; direct `.tsx` specifiers; source-position preservation for
   `.tsx`. These refuse with a typed reason or stay `planned`; none is
   silently degraded.

**Consequences:**

- `fixtures/mods/diff` loads from the fetched pin and asserts the scanner's
  10/8 and 23/0 counts against the loaded graph; the synthetic fixture keeps
  its minimal JSX and pragma-refusal cases.
- The TODO item "Upstream mods as fixtures" is unblocked for `diff`; the other
  six upstream mods remain to be fetched and asserted the same way.
- D30's and D31's `.tsx` refusal is superseded only by this declared path. A
  `.tsx` graph that does not follow the pragma convention is still refused,
  not emulated.
- The host needs `--experimental-vm-modules` and now also a JSX-capable parser
  at load time; both are load-time costs, not changes to DSH behavior.

**Evidence.** S14 at the pin: 122/122 checks, 21/21 `.tsx` transformed,
stripped, linked and evaluated (505 `.ts` + 21 `.tsx` modules), registration
order equal to the scanner's 10 sites/8 events, and `divider()` returns the
`h` descriptor. The mod-host tests cover the minimal graph, the Fragment
descriptor and the three refusals; `fixtures/mods/diff` and the conformance
mods test cover the fetched graph and the kernel mapping.

---

## D35 — A per-step watermark stands in for a prompt event; a notification is reported, not obeyed

**Date:** 2026-11-19. **Status:** ratified. **Supersedes nothing; completes S9's
installable half.**

**Decision.** Four more classic hook events and five notification records ride
host events that S9 observed on a real headless turn. Three rules make the
translation honest:

1. **`UserPromptSubmit` rides `agent/pre-step` with a watermark.** That
   waterfall fires once per model step; the mount runs the hook only when
   `step === 1` and the newest message whose `source.kind` is `user` yields
   text. The filter lives in the mount because the kernel sees a chain event,
   not a conversation. A turn that begins without a user message — a
   compaction step, for example — fires no `UserPromptSubmit`, matching
   upstream.
2. **A notification-only record is reported, not obeyed.** `compaction/start`,
   `compaction/end`, `approval/decided`, `working-directory/change` and
   `settings/document-updated` have no decision channel. The hook runs for its
   side effects after the operation committed; a `decision` or
   `additionalContext` is reported with a warning and never applied.
3. **A gate denial is not a tool failure.** A call denied at the gate is
   excluded from the `PostToolUseFailure` slice by `callId`, so one call
   produces at most one of `PermissionDenied` or `PostToolUseFailure`, as
   upstream does.

`PermissionRequest` is **report-only by construction**: `approval/request`
carries `{agent, toolName, callId, signal}` and no `tool_input`, and the mount
never returns a decision, so it cannot approve or deny. A field the host event
does not carry is omitted and reported once through `reportUnsupported`; no
field is ever synthesized.

**Why this and not a new seam.** Each of the nine rows already has a host
event that fires at the right moment (S9); what was missing was a consumer.
Adding nine synthetic event points would have created a second event path
(AGENTS §3.6) and would still not have carried the missing fields.

**Why `equivalent` and not `exact`.** The host event carries less than Claude's
payload — no `transcript_path` or `permission_mode` on the prompt seam, no
`tool_input` on the approval seam, no `is_interrupt`/`duration_ms` on the
failure seam, no `add`/`change`/`unlink` on the file seam, no `old_cwd`/`new_cwd`
on the directory seam, no `source`/`file_path` on the settings seam — and four
of the nine have no decision channel. Every dialect reason names the seam, the
fields that survive, and each field or channel that does not.

**Consequences:**

- Nine rows in `fixtures/claude-hooks-seams` are earned by the log lines one
  real turn produced, not by a registration table. A row counts only when its
  handler's own text came back; the fixture's upstream inventory is captured
  from `claude --plugin-dir … plugin details` at the pin.
- `apply_patch` is wired (the host emits for it) but no fixture turn exercises
  it: that is declared, not claimed.
- A `FileChanged` `event` matcher and a `PreCompact` `trigger` matcher cannot be
  evaluated, so they are skipped with a warning rather than guessed.
- Compaction is host-driven (two operations on the probe turn), so "once per
  operation" is asserted as `compaction/start`/`end` pairing per
  `compaction_id`, not as a fixed line count.

**Evidence.** `fixtures/claude-hooks-seams` on `0.2.2-rc.5`: one turn, three
prompts, one gated-allow and one gated-reject call, one failing tool, one write
and one read of the same path, two compactions, one settings change. Marker
order asserted; mutation counts with and without each filter (3 vs 8 steps for
the prompt seam, 1 vs 2 approval demands, 1 vs 2 failed results, 1 vs 2 present
observations). Coverage: 25 declared / 24 matched / 0 missing / 1 refused.

---

## D36 — Serve the pinned mod call contract: `register(on, options)`, `Registration.catch`, six host codes

**Date:** 2026-11-20. **Status:** ratified. **Amends D31's `$`-count sentence.**

**Decision.** The host calls the authored entry point the way the pinned type
declares it, not the way that was convenient before three real mods needed it:

1. **`register(on, options)` takes two arguments.** `options` is the pinned
   `PluginOptions`, built from the manifest's `userConfig` plus the values the
   activation stored, validated **before** the realm is created. The host adds
   no plugin-root or data-dir member the pin does not declare; those stay
   `loadMod` and bridge facts.
2. **`on()` returns the pinned frozen `Registration`,** whose `.catch` is
   available during `register` only — not on `engine.create`. A caught throw
   reaches the handler as a frozen `HookFailure` (`kind: 'throw'`, message,
   budget) with a replay-safe `next` and a second `$`.
3. **`ModHostErrorCode` has six members,** adding `ERR_MOD_HOST_REGISTRATION`
   and `ERR_MOD_HOST_OPTIONS`. A member the host cannot serve refuses at
   registration time, naming the member — never an `undefined` that explodes at
   the mod's first call.
4. **D31's `$`-count sentence is amended** from "exactly once per authored
   invocation" to "once per authored handler invocation, **plus once for a
   catch handler**". Nothing else about `$` changes.

**Why.** PR #56 put every pin-era mod through the host and three of five died
in the host's own gaps: `agents-md` read `options.instructionFiles` from an
`undefined` second argument, and `sec-default`/`telemetry` called
`on(...).catch`, which `void` does not have. A patched-host experiment loaded
all five, so this was never an authored refusal. A host that claims "loaded as
authored" (D30) must serve the authored call shape.

**What is still not claimed.** The host has no per-handler timeout budget, so a
caught failure is only ever `kind: 'throw'`; routing a kernel timeout through
`.catch` is a follow-up, not a silent deduction. `catchMs` is carried as
`HookFailure.budget` but not enforced.

**Consequences:**

- All five mods at the pin are `loaded` in `fixtures/mods/upstream.json`, with
  measured registration counts (4/10/1/25/6), and the table stays
  bidirectionally asserted: a mod that stops loading, or one added without a
  row, fails the suite.
- `ERR_MOD_HOST_REGISTRATION` and `ERR_MOD_HOST_OPTIONS` are part of the
  observable surface, so a mod author can distinguish "the host will not serve
  this" from "the mod is broken".
- `PluginOptions` is frozen and validated before the realm exists, which keeps
  the "no fabrication" rule of D30 checkable: every served field traces to the
  manifest or the pin.

**Evidence.** Both pins (`0.2.2-rc.5`, `0.2.2-rc.2`) 402/402 with zero skips;
`check:arch` 18 packages / 46 files. Mutations: returning `void` from `on()`
reddens four contract tests; omitting `options.instructionFiles` reddens three.

---

## D37 — An oracle-invisible face is carried, hashed, and premise-tested — never given a golden

**Date:** 2026-11-20. **Status:** ratified. **Narrows how D1's `planned` rows are proven.**

**Decision.** `output-styles/*.md` is carried into the IR as `outputStyles`
rows (`class: planned`), and the way it is proven sets the rule for every face
the pinned upstream cannot inventory:

1. **Carried, not emitted.** The row holds the frontmatter-derived name (stem
   fallback) and description plus the style body. Body bytes equal the authored
   file's body; nothing is re-serialised.
2. **No golden row, ever.** The pinned `claude plugin details` prints no
   output-style line at 2.1.322. A row in an `.inventory` golden would be an
   observation nobody made — the same reason hand-authored Codex rows say
   `Hand-authored, not observed`.
3. **Byte evidence instead of inventory evidence.** A test hashes the authored
   body against the carried body, including CRLF, a mid-body `---`, and a body
   with no trailing newline. A drifted body is a bug even though the row is
   `planned`.
4. **The premise is tested too.** A test asserts that the pinned CLI prints no
   output-style line for the fixture. A pin bump that starts inventorying
   styles therefore fails, and the exclusion has to be re-reviewed rather than
   silently outliving its justification.

**Why.** Three ways exist to be honest about a face we cannot diff: refuse to
carry it (loses the component), fake a golden (invents an observation), or carry
it with evidence about *what we can actually check*. The third keeps the ledger
complete without letting an unverifiable row look verified.

**Consequences:**

- `rig report` lists `outputStyles/<name>` rows as `planned` with `carry=skipped`
  and a reason naming all four activation gaps: the `/<plugin>:<name>` alias
  (D10), at-start provenance, the composition rules (`keep-coding-instructions`,
  `force-for-plugin`), and the missing inventory.
- Fidelity totals do not move: an oracle-invisible face never enters the
  declared/matched/refused matrix, so it cannot pad the number it cannot
  support.
- The rule generalises: any future face without an upstream oracle (Codex
  `interface.logo`, F2 palettes) must ship with (a) carried rows, (b) a
  byte-level assertion where bytes exist, and (c) a premise test that fails
  when the oracle grows the surface.

**Evidence.** `fixtures/claude-output-styles` (two styles, one whose frontmatter
name differs from the stem), `packages/dsh-anyplugin-conformance/test/output-styles-carry.test.mjs`,
the frontmatter parser tests in the dialect package, and the live probe test
that prints the pin's component lines. Merge `6d02fcc`.

## D38 — the mod-visible `next` is the kernel's own continuation

`runModHandler` wraps the same continuation every handler gets; `to` forwards its
tier to the kernel, so tier order, matchers and trace stay owned by one chain
(D13). `next` is eager and call-scoped: each call runs the remainder from the
calling link immediately, with that call's target, and returns that trip.

A hook that calls `next` twice runs the remainder twice — the author's choice,
and our host contract rather than a pin statement: the pin only says `trace`
describes "its latest next() call", and we cite it as the spec for this rule. The
latest trip is the one the handler's return decides with and the one `trace`
describes. This refines D32 §6's sentence "a mod's next(e) only rewrites the
event … it does not run the classic arm itself": the eager trip now runs it,
while the return rule is unchanged (the chain collects the trip's decisions; the
mod does not decide them).

An unawaited `next` is joined exactly once before the loop decides, so it cannot
run the remainder twice. Every call joins the previous trip before it starts, so
`void next(e); await next(e)` runs sequentially — a call supersedes ordering, not
concurrency.

A `to` target belongs to the call that named it: a same-tier sibling still runs
and keeps its own jump, so a pass-over is never attributed to another link; when
that sibling names its own target, the nested target wins over the outer target,
which is never reached. A jump is by tier rank, not index: only links strictly
between the caller's tier and the target are passed over, recorded `skipped` with
`bypassed by <plugin>`. Landing is inclusive of the named target (a direct jump
runs it); a named tier with no link left falls forward to the next tier that has
one rather than dropping the chain. A target tier at or above the caller is
refused with the direction and the pin's line.

Both continuations share the rule; fan-out collects the eager trip's decisions
but resolves the kernel's continue, not `ClassicResultOf` (D32 §6's return rule).

`budget` is live for mod handlers, counts the hook's own work and pauses while
`next` or `$` is in flight; classic hooks keep the entry snapshot (T3). A
throwing link is `rejected` with the throw as its reason; a matcher skip never
ran and is not projected. `trace` describes the latest trip in both
continuations.

`core` stays a **declared fidelity gap**: the pin's `TargetTier` allows it, this
chain has no core link, and naming it would skip the `builtin` tier without
running it, so `to` refuses with a reason (D36) — our gap, not a pin
prohibition.

`origin` is the dispatch's raiser, so host-raised dispatches read
`{plugin:"engine", tier:"core"}` for every hook of that dispatch.

**Why now.** S15 measured a real security mod whose guard hook called `next.to`
and threw `TypeError: next.to is not a function`; the kernel recorded `error` and
continued, so the guard enforced nothing. The pin's `Next` declares seven members
and we handed the mod a bare function.

**Consequences.**

- No second dispatcher: the mod surface is a projection of the kernel's
  continuation, so tier order, matcher grammar and trace remain single-owned
  (AGENTS §3.6).
- The classic arm is unchanged: classic registrations still get no `next`, and
  their budget remains the entry snapshot (T3).
- The subset of `TraceEntry` we serve is explicit: `index`, `tier`, `event`,
  `plugin`, `outcome`, `reason`; `ms`, `chunks`, `received`, `returned` and an
  engine entry are not served and say so.

**Evidence.** `packages/dsh-anyplugin-intercept/test/mods.test.mjs` (rounds 3–5),
`probe-r4-unawaited-file.mjs`, `probe-r5-mixed.mjs`, the mutation table in PR #70,
and `packages/dsh-anyplugin-mod-host/test/kernel-bridge.test.mjs` with
`fixtures/mods/guard/`. Merge `5fcfb60`.

## D39 — the resolver serves extensionless sibling files, file before directory

A mod at the 2.1.329 pin imports `./reads-as-org-tool`, an extensionless sibling
`.ts` file (D30 §3 had served extensionless specifiers only as
`<spec>/index.ts`). Our refusal was a host obligation unmet, not an upstream
refusal — the same class as D30's three resolved behaviours.

The order for an extensionless relative specifier is:

1. `<spec>.ts`
2. `<spec>.tsx`
3. `<spec>/index.ts`
4. `<spec>/index.tsx`

File before directory is **Node's own order, observed upstream at this pin**. It
is *not* justified by the D34 shadowing argument: under file-first a sibling
`views.tsx` would in fact win over `views/index.tsx`. The pinned
`mods/diff/hooks/views/` still resolves to its directory only because no sibling
`views.ts(x)` exists today. A synthetic fixture where both forms exist pins the
order so it cannot silently flip.

**Consequences.** `sec-default` loads again, with 45 registrations; its eight
classic invocations run with zero handler errors once D38's continuation supplies
`next.to`. A new resolver rule is always a **host** rule: it is recorded here,
tested against a fixture that fails if the order flips, and never claimed as
upstream spec.

**Evidence.** `packages/dsh-anyplugin-mod-host/src/resolve.ts`,
`test/mod-host.test.mjs` (`an extensionless import tries the file form before the
directory form`), the both-exist fixture, and the directory-first mutation that
reddens exactly that test. Merge `ac46bf2`.

## D40 — the mod event vocabulary is pinned, and every unmapped name carries a category

At 2.1.329 `EventOf` is **167** names (engine 59, op 75, classic 33), up from 129
at 2.1.322. Our routing table stayed at 40 engine names while the mod artifacts
moved, so `sec-default`'s newer registrations were warned as "not an event in the
pinned `claude-code.d.ts`" — which was false and read as the mod's fault.

The table now enumerates all 167. Seventeen names are routed to host seams; the
other **150** carry one of three categories:

- `missing bridge` (6): `vcs.detect`, `vcs.diff`, `vcs.isolate`, `vcs.list`,
  `vcs.status`, `vcs.release` — `createModBridge` has no `vcs` namespace, so the
  call is an absent member, not a typed refusal.
- `no host event` (144): the engine additions and all 75 op hooks whose host
  point does not exist yet (the S9 vocabulary).
- `not in spec` (0): every `OpEventOf` name is in `EventOf`; the earlier bucket
  was a false classification.

Warnings name the spec label and the category, so a reader can tell *our* gap
from the mod's mistake. Adding a host seam means moving names between
categories, not rewriting the table.

`sec-default` maps to **16 routed + 61 unmapped** (55 no host event + 6 missing
bridge); the 61 exceeds 45 authored registrations because its one `classic.*`
wildcard expands to 33 rows.

**Consequences.** The pin move and the event vocabulary can no longer diverge
silently: a pin bump that adds events shows up as new rows in the enumerated
test, and a mod's warning names a category. `not in spec` is asserted to be
empty, so a typo in a mod is the only way it can reappear.

**Evidence.** `packages/dsh-anyplugin-intercept/src/mod-events.ts` (167 names,
17 routes, 150 categorized), `test/mods.test.mjs` (deep-equal to the 59-name
engine table, 75/167/150 counts, category totals), the `vcs.detect` removal
mutation that reddens three tests, and the S15 run reporting 11 invocations /
16 `$` calls / 0 handler errors. Merge `ac46bf2`.

## D41 — A tool result we cannot install fails the call closed, and says why

A `tool.call` handler may answer with `{deny}`, `{result}`, or `{isError}`
(`claude-code.d.ts`, `ToolCallResult`, 2.1.329 pin). The host seam it maps onto —
`tools/pre-execute` — has a denial channel and a rewrite channel for the
*arguments*, but no channel that installs a replacement **result**: that value
arrives only after execution (`tools/post-execute`'s `{kind:'accept', value}`),
which is too late to be the mod's answer to "what will this call return".

So `{result}` and `{isError}` are typed `unsupported` with `hard: true`, and the
mount converts that into a real deny instead of running the call with the mod's
answer dropped.

**Why deny, and not "run the call and report the gap".** Both alternatives were
measured on the pinned `tool-call-result` fixture (PR #74 body):

- *Deny*: the Bash call does not execute (`calls: []`), the trace records
  `unsupported.field: 'result'`, and the model receives the deny text naming the
  gap.
- *Proceed*: the call executes and the model receives the **raw** tool output
  (`{content:[{type:'text',text:'ran'}], isError:false}`) while the mod's
  replacement exists only on the trace.

Proceed is rejected because the plausible use of a returned result is output
sanitisation or redaction — the mod is the only party that knows what the
replacement means — and a silent proceed delivers the unsanitised output to the
model and to the transcript, where nobody can detect the omission afterwards. A
deny is visible, names its reason, and is recoverable by the user; an
unsanitised result is not.

**Consequences.** A `tool.call` mod that only *annotates* output now blocks the
call on this seam; that is the accepted cost, and the reason string says so.
`{deny}` remains a plain deny, unaffected. If DSH ever grows a pre-execute value
channel, the same code path switches from deny to "replacement served" and this
entry is superseded, not rewritten.

`tool.check` stays a **measured refusal** (not this rule): it is the engine's
post-`PreToolUse` permission verdict, and `next.origin`, `trace`, `settings`,
`op` and `ceiling` are not representable at `tools/pre-execute`; the load path
warns with that difference and no `tool.check` invocation occurs.

**Evidence.** `packages/dsh-anyplugin-intercept/src/index.ts` (the `unsupported`
decision), `packages/dsh-anyplugin-materialize-hook/src/index.ts` (the deny
conversion and its model-facing text), `test/mods.test.mjs` (deny text asserted,
run-unchanged measured), the two route-rename mutations, and 463/463 with zero
skips on both DSH pins. Merge `c42b234`.

---

## D42 — Output-style activation is a profile record, and an explicit record outranks `force-for-plugin`

**Status.** Ratified 2026-11-21. Pins: DSH `0.2.2-rc.5` / `0.2.2-rc.2`,
claude-code `2.1.329`.

**What was decided.** The activation record is
`$DSH_HOME/anyplugin/output-styles.yml`, schema `dsh-anyplugin/output-styles@1`,
read-only. It is validated when entries are materialized. An unknown plugin, a
disabled plugin, an unreadable plugin, an unknown style, or an empty or
whitespace-only body is a typed refusal reported on `compileReport.activation`,
never a silent no-op — and a refusal is final: it does not fall back to a
plugin's `force-for-plugin` declaration. A record that exists but cannot be read
is a load error naming the errno (`EACCES`, `EISDIR`), not "no style", and
`outputStyles: {}` followed by an `active` row is contradictory. Without an
explicit record, the first enabled plugin in name order declaring
`force-for-plugin: true` with a non-empty body applies, and the trace names it;
force is never injected as a hidden default, and a whitespace-only forced body is
skipped in favour of a later valid one, or refused when it is the only candidate.
`compileEntries` throws `OutputStyleActivationError` on a refusal, so only
`compileReport`'s caller can choose to continue.

The body is applied as authored (untrimmed) through the agent-scoped
`SystemPrompt.section(..., { complete: keep-coding-instructions === false,
interpolate: false })` seam at `agent/created`. An absent
`keep-coding-instructions` appends, which is stated because Claude's documented
default is `false`. The section is applied to top-level agents and forks; a
`subagent` child is skipped, because upstream scopes styles to the main
conversation and forks ("Other subagents run their own system prompt, so styles
don't change how they respond").

**Why this diverges from Claude Code.** Claude documents that
`force-for-plugin` overrides the user's `outputStyle` setting
(<https://code.claude.com/docs/en/output-styles> @ 2.1.329). This layer has no
host setting to override: the profile record is the operator's explicit
statement, and the only alternative would be a hidden activation channel. So an
explicit record outranks force, and the trace always names which rule won.

**Consequences.** The row stays `planned` overall because the `/<plugin>:<name>`
command face is blocked by D10; the two faces are `activation: equivalent` and
`command: planned`. The `agent/created` listener is scoped to the created
agent's context, so it cannot mutate another agent's prompt, and the section
unwinds when that agent is disposed. A subagent therefore observes the host's
own prompt, which is the upstream behaviour and the reason we skip it rather
than treat it as an unrelated sibling.

**Evidence.** `packages/dsh-anyplugin-install/src/output-styles.ts` (parser,
refusals, errno-named load error, forced selection), `src/compile.ts`
(`OutputStyleActivationError`), `packages/dsh-anyplugin-materialize-output-style`
(the seam and the subagent skip), the activation suite in
`packages/dsh-anyplugin-conformance/test/output-styles-activation.test.mjs`
(18 tests, including main/sibling/fork/subagent and the forced-empty cases),
mutations M1–M8 each reddening a named test, and 481/481 with zero skips on both
DSH pins. Merge `62238bf`.

---

## D43 — A published build is packaging-only, and the package is one bundle with subpath entries

**Status.** Ratified 2026-11-21. Pins: DSH `0.2.2-rc.2`, `0.2.2-rc.5`; claude-code `2.1.329`.

`dsh-anyplugin@0.1.0` is one published package. `src/` stays the development entry: every workspace manifest keeps `exports["."] = "./src/index.ts"`, so tests and spikes run sources directly. `scripts/build.mjs` bundles each runtime entry into `lib/<name>.js` for a consumer's Node. That build is a packaging step, not runtime code generation: the compiler still emits a pure-data `EntryTree` (D1), and install and boot write or evaluate no generated JavaScript.

`exports` publishes only entries a patch row or the reconciler names: `.` (the controller) and one subpath per materializer (`./materialize/skill`, `./materialize/mcp`, `./materialize/hook`, `./materialize/agents`, `./materialize/output-style`). `ir`, `emit`, `trust`, `install`, `intercept`, `hook-runner` and the template packages are bundled into those entries and are not separate subpaths. There is no `./materialize/command` subpath: command files land as skills on their model face, and publishing an entry nothing emits would freeze a surface that does not exist.

`cordis.patch.yml` inserts exactly one row (`id` and `name` `dsh-anyplugin`); every other loader entry is created at runtime by the reconciler from `installs.yml`. The controller names materializers by published subpath, never by file URL, so the tarball can move. `engines.dsh` is the version claim and names only the two pins the suite boots (`0.2.2-rc.2 || 0.2.2-rc.5`); when present, app-boot's compatibility check decides on it alone.

**Why.** A consumer's Node cannot run a TypeScript development entry, and the workspace manifests are private, so something has to produce importable JavaScript; doing it at publish time keeps the development loop unchanged. Subpath entries give the loader bare specifiers resolved from the profile's `node_modules` — the same path any dependency uses — instead of absolute file URLs that pin a checkout. Publishing only named entries keeps the public surface equal to the contract: a module the loader is never told to import is implementation detail, and exporting it would freeze it.

**Consequences.** `check:pack` is the gate: it builds, packs, asserts the lib/no-`.ts`/exports-resolve/no-undeclared-import/no-`@babel` invariants, checks that every local image a README names is in the tarball, and runs a real-loader install smoke over all five materializers, so the artifact and its declaration cannot drift apart. The mods kernel (v0.2) needs its own entry and the `@babel/*` dependencies; the 0.1 tarball deliberately ships neither and refuses a `mods` row with a recorded warning, while classic hooks in the same row still run. The ARCHITECTURE §13 question about bundle-versus-profile-dependency is answered by the bundle, with the profile's resolution model kept through subpaths.

**Evidence.** `packages/dsh-anyplugin-install/src/controller.ts`, `scripts/build.mjs`, `scripts/check-pack.mjs`, `scripts/smoke-install.mjs`, `.github/workflows/release.yml` (tag == version, tag on `origin/main` via `merge-base --is-ancestor`, both pins verified with zero skips, then publish), `INSTALL.md`, and the 14-entry tarball exercised by the smoke. Merge `3083596`.

---

## D44 — `$ui` is a headless render sink, and its render hooks ride the one kernel

**Status.** Ratified 2026-11-21. Pins: DSH `0.2.2-rc.2`, `0.2.2-rc.5`; claude-code `2.1.329` (mods tree `f9e4d1e`).

The mod host owns one UI sink per plugin load. Every submitted tree is validated against the pinned surface table: declared elements per surface, element keys, required members, and prop types and literal unions (including the `ImageSource` object union). The sink records the latest valid revision per pane id and serves `open`, `close`, `invalidate`, `log`, `status` and `resolve`. `ui.ask` stays a typed refusal until the host has a person-interaction surface.

`ui.render` and `ui.resolve` are **not** host events and are deliberately absent from the mod-events host table. The sink selects the authored registrations and dispatches them through `runChain` as synthetic events (`mode:'wrap'`, tier `user`), so matchers, ordering, timeouts, traces and the continuation rules stay the kernel's. `ui.resolve` runs at load once per surface and component, because the pin does and pinned mods read that table synchronously at import time.

**Scope, stated rather than assumed.** The sink synthesizes `ui.render` only for `component:'Pane'` on `surface:'terminal'`, and only for the mod's own panes. The other components, and the pin's `ui.open`/`ui.close` hooks, are not dispatched. An invalid tree is recorded and the last validated tree is kept; `isPlaced:false` is reserved for a pane that has never drawn. The refusal wording, keep-last-tree and press recording are `derived`: the pin draws the engine's own component and this host has no drawing engine.

**Why.** A sink is the only way to make stored trees observable without inventing a renderer: `ui.render` becomes a recorded revision, and a pinned turn can assert the tree a mod submitted. Routing the hooks through `runChain` is D13's rule applied to a surface whose events the host does not emit; the alternative, a `uiRenderChain`, would be the second event path AGENTS §3.6 forbids.

**Consequences.** Six `$` ledger rows move from `refused` to `ran`; `ui.ask`, `$.process.run` and `$.settings.read` (with no merged snapshot) remain typed refusals. `mod_ui` is registered only while a pane is open. A regression in the sink's invalidation of `prompt.context` / `prompt.section` is now a test failure rather than an unobserved path.

**Evidence.** `packages/dsh-anyplugin-mod-host/src/ui.ts` (surface tables and validator, 21 tests), `packages/dsh-anyplugin-mod-host/src/bridge.ts` (sink wiring), `packages/dsh-anyplugin-materialize-hook/src/index.ts` (synthetic dispatch), `packages/dsh-anyplugin-conformance/test/mods.test.mjs` (the pinned-turn revision-2 assertion), `packages/dsh-anyplugin-materialize-hook/test/prompt-cache.test.mjs`. Mutations for each MUST were run and reverted. 509/509 with zero skips on both pins after rebasing onto the release bundle. Merge `4b6cb5c`.

---

## D45 — Codex is a dialect selected by the record, and its proof is declared

**Status:** ratified 2026-11-21. Merged with `#103`. Granularity: dialect selection,
tool naming, and what counts as proof for a second upstream.

`installs.yml` names its dialect, and `compileEntries` resolves that name through a
registry of installed dialects (`claude-code`, `codex`). The lookup is an **own-key**
lookup: `Object.hasOwn(DIALECTS, record.dialect)`. A record naming `constructor` (or
any other `Object.prototype` member) produces the shaped refusal that names the
installed dialects; a prototype member is not a dialect. The same own-key rule applies
to every table keyed by user input — enablement ids are gated by the `:` split,
`FIELDS` gates installs keys, `SCOPES` is a fixed list.

The Codex dialect reads the portable 1.0.0 manifest
(`agent-plugins.org/schemas/1.0.0/plugin.schema.json`), accepts `.mcp.json` and
`plugin.json` as compatibility fallbacks, and treats `extensions.com.openai` as
replacing `.codex-plugin/plugin.json` rather than merging it. Portable MCP servers
register tools as `mcp__<server>__<tool>` — no plugin segment — which is why D33's
budget is `5 + server + 2 + tool ≤ 64` with no 24-character server constraint of the
Claude shape. An over-budget tool is skipped with a warning and its server row
survives; it is never truncated, renamed, or hashed.

The Codex golden is **hand-authored** (`hand-authored: the portable spec is the
oracle`), and by D37 and #102 it never enters the observed ratchet: `EXPECTED_ROWS`
has no Codex entry and the totals stay whatever the observed fixtures say. A Codex
oracle later is a new decision and a second, independent ratchet — never a merge into
this one.

The DSH oracle's child matching accepts both bare and install-qualified ids
(`mcp`, `anyplugin.<scope>#mcp`, and likewise `hook`, `agents`, `outputStyle`).
Install-qualified ids were previously never matched, so an MCP tool emitted into an
install-shaped entry was invisible to the oracle; that is the bug this decision
records as fixed, not a new convention.

**Consequences.** The `docs/FEATURES.md` row for Codex says
"equivalent … no upstream oracle; fixtures are the spec" and nothing stronger;
`dsh-anyplugin-dialect-codex` may only import `dsh-anyplugin-ir`; a Codex plugin whose
per-tool name exceeds the shared budget is *skipped*, not refused, because its server
still works; and D33's closing sentence ("not yet wired into `compileReport`") is
superseded by this entry.

---

## D46 — The kernel ships inside the hook entry, and the flag is part of the contract

**Status:** ratified 2026-11-21. Merged with `#104`. Granularity: packaging shape,
the runtime flag, the dependency set, and the cost the artifact states.

`0.1.0` shipped the compile path only, and D43 said the mods kernel (v0.2) "needs
its own entry and the `@babel/*` dependencies". `0.2.0` puts the kernel in the
existing `lib/materialize/hook.js` and adds no subpath: one controller row and one
materializer set per profile are simpler to reconcile than two entries, and a
separate entry would have duplicated the same controller shape. **This amends D43's
"mods need their own entry" consequence**; the rest of D43 stands — the artifact is
built, the dependency set is asserted, and `check:pack` is the gate.

The runtime dependency set is exactly three packages: `@babel/core@7.29.13`,
`@babel/plugin-transform-react-jsx@7.29.7` (the one transform D34 allows) and
`@modelcontextprotocol/client@2.2.0`. `cordis` stays a peer. Babel stays **external**
in the bundle — `hook.js` imports it rather than inlining 11 MB — and `check:pack`
fails on any drift: a removed package, a widened range, or an undeclared import.

Mods require Node's `--experimental-vm-modules`. D30's realm is `node:vm`'s
`SourceTextModule`, which is flag-gated, and the Desktop spawns the harness under
its bundled Node without that flag; nothing in the harness adds it for the main
process. This is a property of the runtime, not a choice we can hide, so the
artifact states it: `README.md`, `README_cn.md` and `INSTALL.md` name the flag, and
`check:pack` asserts it against the **extracted tarball** (not the checkout), so the
packaged documentation cannot drift from the packaged code. At runtime, a profile
with mod rows and no `SourceTextModule` warns **once per process** naming
`NODE_OPTIONS`, while each mod still records its own refusal trace; classic hooks
continue.

The artifact states what it costs. The kernel is 84.6 KiB of a 203.9 KiB entry, the
tarball is about 99 KiB, and a real `npm install` of that tarball pulls 60 packages /
35 MB (Babel is 11 MB of it). A 128 KiB kernel ceiling is asserted, so the packaged
size cannot grow silently in a release.

The lock still cannot express `mods`: the installs schema is unchanged, so the kernel
is reachable only from a hand-written hook row configuration until the lock gains the
field, which is a separate decision.

**Evidence (mutations, each red before revert):** removing `@babel/core`; widening
its range to `^7.29.13`; inflating the recorded kernel size to 3×; deleting each of
the three install-smoke probes (sec-default, kernel-probe, guard); passing
`plugins: []` to the JSX transform; stripping the flag from the packaged
`INSTALL.md`, from `README_cn.md`, and from `README.md`; re-adding a `0.1.0` sentence
to the packaged `INSTALL.md`; resetting the once-per-process warning at the top of
`apply()`. Both pins: 510 tests, 0 skipped.

**Consequences:** a default Desktop launch refuses mods and keeps classic hooks
running, and says so once; the packaged `INSTALL.md` may not discuss `0.1.0`, because
it ships inside `0.2.0`; the numbers in this entry are asserted by `check:pack`, not
remembered by prose.

---

## D47 — The guard is a convention checker at the tool seam; the hook is defence in depth

**Status:** ratified 2026-11-21 (ticket #80, PR #89).

Two seams carry the working rules:

- `tools/pre-execute` sees every tool call (name, arguments) and may deny it
  before anything runs. This is the authoritative layer for everything the
  model does through a tool;
- `agent/pre-step` appends one briefing block at the first step of a worker.

The pre-push hook is **not** authoritative. It is installed only by
`npm run guard:install`, it runs after the refs are discovered and before the
objects are sent, `--no-verify` skips it, and `guard:status` reports when
`core.hooksPath` has moved it. It exists for the paths that reach git without a
tool call the tool layer can read — and for nothing else.

**Rules, as shipped and asserted by the 109-row table:**

- worker pushes must be exactly `git push [-u] origin <one refspec that is not
  main>`; bare pushes, extra refspecs, other remotes, `--receive-pack`,
  `send-pack`, `update-ref`, wildcards and `--no-verify` are refused;
- workers may not write git config (`git config`, `-c`, `--config-env`); the
  `-c` allowlist is a closed set of inert keys (identity, `color.*`, `core.quotepath`,
  `core.autocrlf`, `core.filemode`, `core.symlinks`, `core.ignorecase`, a set of
  `diff.*` presentation keys, `i18n.commitEncoding`), lowercased before matching,
  and root passes through the same table;
- workers may not write inside `.git` for modelled writes: shell redirection,
  `tee`, `cp`, `mv`, `sed -i`, structured `write`/`edit`/`apply_patch`, the
  interpreter file-mutation verbs (`writeFileSync`, `renameSync`, `copyFileSync`,
  `cpSync`, `linkSync`, `symlinkSync`, `truncateSync`), and `tar -C` (separate or
  attached) into `.git`; writes outside the worktree are refused for the
  modelled forms;
- workers may not `sudo`: the token is matched at command position, after
  `env`, `command`, `exec`, `nice`, `timeout` and `xargs`;
- unmodelled shell shapes (`shell-unmodelled`), worker script files
  (`shell-script-unverified`) and a sentence that names a remotes refspec onto
  main are refused rather than guessed.

**Masking is lexical, not semantic.** Quoted literals are replaced with
position-preserving spaces before tokens are matched, so `console.log("exec(")`
allows while a real call beside a string denies. Comments are not masked, so
`node -e '// exec("git push")'` is a false positive; it is harmless, and masking
comments is left as a possible refinement.

**Residuals, named so no document claims more than the table proves:**

1. interpreter dynamic code — `node -e 'eval("…execSync(\"git push --no-verify
   origin HEAD:main\")")'`, `String.fromCharCode(...)`, `globalThis['pro'+'cess']`,
   downloaded code;
2. editable entry points whose bytes are not verified — `node scripts/*.mjs`,
   `npm run *`;
3. `--no-verify` inside an unmodelled shape (a script, an alias, a string);
4. file writes in shapes not in the write vocabulary, including the eval-wrapped
   forms of (1);
5. root-run shell scripts (`bash scripts/x.sh`) — allowed for root, bytes unverified;
6. root-written exec keys through the filesystem (`appendFileSync(".git/config", …)`)
   and a later `git diff --ext-diff`;
7. git features outside the modelled subcommands (root `git update-ref`); the
   server remains the authority for `main`;
8. config already present, or written outside the guard, with a diff driver that
   a later allowed `git diff --ext-diff` executes;
9. a `sudo` launcher spelling outside the modelled set, or a host where `sudo`
   succeeds without a password.

**Consequences:** the guard is described as a convention checker everywhere;
sentences like "a worker cannot write inside `.git`" are scoped to modelled
writes, because the unmodelled route is residual 4; the tool layer, not the hook,
is what the documentation calls authoritative; a rule that cannot be expressed
in the table does not get a doc sentence that implies it. D47 records the code
one merge behind it, as D43–D46 did, because a PR may not edit this file.

---

## D48 — every agent face is either observed or refused; the host has no turn cap

**Date:** 2026-11-21 · **Status:** ratified · **Supersedes:** D26's per-key
`planned` for the frontmatter fields it listed (D26's catalog and invocation
clauses stand)

S16 (`docs/ARCHITECTURE.md` §10, `spikes/s16-agent-faces/run.mjs`) drives a real
child through the installed harness and records what each `agents/*.md`
frontmatter key actually does here. The rule, applied per key and never in
bulk: a face is `equivalent` only when the child is observed to receive the
effect, `planned` only when a named host field would carry it, `unsupported`
when the host has no field at all — and the reason says what is missing.

| key | class | why (S16 evidence) |
| --- | --- | --- |
| `skills` | `equivalent`, qualified | the child's first user message is exactly persona → host `renderSkillContent` envelope (`provider: anyplugin`, `resourceBase: undefined`) → task → host closing note; the body inside the envelope is the plugin's `SKILL.md` body. Not carried: the `Base directory for this skill:` hint, the skill's resource files, and provider-managed loading. A declared name that is absent or has an empty body is `planned` with "ship a SKILL.md with no body", and the child receives no `<skill_content>`. |
| `isolation` | `planned` | ignored: the child header `cwd` equals the root's. Named seam: an `isolation` field on `SubagentStartRequest`, handled in child composition with `ctx.worktrees`, because `worktrees.create` today re-points the calling session — calling it from the materializer would move the parent. |
| `model` | `unsupported` | a top-level `model: sonnet` is accepted and ignored (child model is the provider's); `agentOptions.model: 'sonnet'` reaches the provider as the raw id, with no alias resolution. A Claude alias names no provider model id; translating it would guess. Escape layer is the only path. |
| `effort` | `unsupported` | no `reasoningEffort` from frontmatter; `agentOptions.reasoningEffort` works only when the provider advertises that effort, otherwise `UNSUPPORTED_REASONING_EFFORT`. The id space belongs to the provider, not to Claude. Escape layer is the only path. |
| `tools` / `disallowedTools` | `unsupported` | the child still sees the caller's tool set. `SubagentStartRequest` has no filter; `ctx.tools.restrict` is agent-scoped over DSH global names, and Claude names/specifiers have no one-to-one mapping, so forwarding the list would restrict the wrong set. Escape layer is not applicable — only `ctx.tools.restrict` or an `agentPreset` composition can express this. |
| `maxTurns` | `unsupported` | `maxTurns: 1` makes three requests and ends `completed`, because neither `SubagentStartRequest` (nine fields) nor the agent loop has a turn cap, and there is no "partial at the limit" outcome to map onto. |
| `memory`, `background`, `omitClaudeMd`, `color`, `autoCompactWindow` | `unsupported` | each key is ignored and the host has no surface that reads an equivalent value; the per-key reasons in §10 S16 are the text a report must reuse. No escape layer exists for these values either. |

**The pin.** The child's first user message is asserted exactly, including the
host's closing note. That note is a copied literal at the pin
(`dsh-subagent/lib/index.js:422 @ 0.2.2-rc.5`): when the host changes it the
test reddens and must be updated deliberately. Only the envelope is rendered by
the host module. S16 does **not** run Claude; "the body bytes are what Claude
would inject" is a claim from the pinned `claude-code 2.1.329` client and docs,
not an observation. Equivalence is claimed for what DSH does with the bytes.

**Consequences:** no sentence may say DSH honours a key the table calls
`unsupported`; a key that gains a host field is a new decision and a new S16
row, not an edit here; `model`/`effort` are the only faces whose fidelity route
is the escape layer, and `tools` names its two composition routes; the S16
spike runs in CI beside S10/S11 and a missing harness fails the job (D22); and
`isolation` is the one remaining face that a T2 seam can promote without
touching this table's other rows.

---

## D49 — the lifecycle CLI is a caller; a mention owns its layer; an empty install is a refusal

**Date:** 2026-11-21 · **Status:** ratified · **Depends on:** D2, D23, D27

1. **One writer per store.** `rig install` reads a plugin directory, builds one
   `InstallRecord`, and hands the whole lock to `writeInstalls`; it never
   formats `installs.yml`. A lifecycle command's only other write is one
   enablement layer through `writeEnablements`. Both validate first, then write
   a temp file and rename, so a typed refusal leaves the previous bytes.
2. **`--scope` on `install` is enablement, not a record field** (D2 keeps the
   record profile-global). `install` adds a mention only where the layer has
   none; **a layer that already mentions the id owns the decision** and is left
   byte-identical, with a warning naming the deciding layer. A reinstall is not
   an enable: `--force` is scoped to root/version/dataDir and does not flip a
   `disable`.
3. **`enable`/`disable` edit exactly one layer.** With no `--scope` the target
   is the narrowest layer that already mentions the id, else `user`; the CLI
   never invents a narrower scope. If a narrower layer still decides against
   the request, the command exits 0 with a warning naming that layer (D2).
4. **`disable` never deletes the record; `uninstall` removes only the record.**
   Layers and grants stay, because a workspace's policy outlives a reinstall;
   `uninstall` reports the scopes that still mention the id, the desired
   entry-tree difference, and `grants: N retained`. That count is grants, not
   effective grants — a revoked grant is still retained, and the same output
   names the refusal.
5. **An empty install is a refusal.** A plugin that declares nothing is
   `nothing-declared` (not bypassable by `--allow-empty`); a plugin whose
   components all refuse is `nothing-emitted`, naming them, exit 1, unless
   `--allow-empty`. The record then exists and `list` names the same refusals.
   Recording an inert plugin silently would make "installed" mean two things.
6. **Options are closed per command.** An unknown, misspelled or `--flag=value`
   option exits 2 before any read or write, printing that command's allowed
   set. This is what makes `--dry-run` a promise rather than a convention.
7. **Same identity, same root, unchanged fields is a no-op exit 0.** A different
   root, or a changed version/pin/dataDir, is a typed refusal; `--force` is the
   only override. `--name` asserts identity and fails on mismatch rather than
   renaming.
8. **`--dry-run` runs the same plan**, prints the exact canonical `+`/`-` lines,
   performs both reads, and skips only the `write*` calls; every target's
   checksum is unchanged.

**Consequences:** `list` re-runs `prepareInstalledRecord` and
`buildTransplantReport` rather than counting anything of its own, so a refusal
row cannot differ between `list` and `report`; `PreparedRecord` keeps the
ungated IR beside the gated one because gating twice turns refusals into
skipped; refusals are a stable `code` and `--json` prints
`{ok:false, refusals:[{code,reason,hint?}]}`; paths (`<plugin-dir>`,
`--config`, `--project`) resolve against the current directory and a missing
relative `--config` is a typed error for commands that need an existing lock;
`install` never grants exec (D27) and never writes profile config (D23);
`rig --help` with no command still exits 2 — a known rough edge, not a claim.

---

## D50 — A bundle's install claim is the host's profile path

**Ratified 2026-11-21.** Supersedes nothing; D43 (packaging) and D49 (lifecycle
CLI) stand. Evidence: S17, `packages/dsh-anyplugin-conformance/test/profile-mount.test.mjs`.

**Decision.** A packed `dsh-anyplugin` is "installed" only when the host mounts
it from a profile: the profile `package.json` lists it in `dsh.profile.bundles`,
the host reads the bundle's `cordis.patch.yml`, merges it into the profile root
`cordis.yml`, and `boot`'s include loads the entry. A tree composed with
`composeEntries` + `loader.create` — what `check:pack`'s install smoke does —
remains a **packaging check**, not profile evidence. The two answer different
questions: the smoke says the tarball's entries are expressible; the profile
path says the host will actually run them.

**What S17 proves** (pin: DSH `0.2.2-rc.5` and `0.2.2-rc.2`, harness from
`.harness/<pin>`):

- one positive: a temp profile listing the package in `dsh.profile.bundles`
  mounts the `anyplugin.claude-code…skills-only` group with its
  `dsh-anyplugin/materialize/skill` child active, `greet` + `hello` present, and
  the body renders as `Say hello to the user.`;
- the bundle's module URL resolves **inside the profile's**
  `node_modules/dsh-anyplugin/lib/index.js`, including a boundary control where
  that path is a symlink to the checkout — a host resolving to the checkout
  would mean the profile was not what ran;
- three negatives (no lock, corrupt lock, disabled plugin) mount nothing.

**What it does not prove, and must never be read as proving.**

- The launcher's `PluginPackages` install-closure interception was **not**
  exercised. On this machine it does not initialize
  (`node-addon-require-builtin … Unsupported/no-getter` against
  `internal/modules/esm/loader`, Nodes 24.12.0 and 24.22.2), so the harness
  scope is *linked* into the profile's `node_modules` as a stand-in. Install
  closure remains unproven.
- A real template profile with the stock base application bundle: the fetched
  harness union contains no base bundle, so the profile lists only
  `dsh-anyplugin` and the test supplies the host services.
- pnpm as the install step: the test installs by offline extract + link; pnpm
  was only compared in a spike.
- The controller's reconcile **count**: the include's load pass can run after
  `loader.await()` collected its tasks, so the same boot can log
  `group fiber is 1, expected active (2)` and still settle the tree active. The
  test asserts the settled tree, not that count, and a future change must not
  turn the count into a claim.

**Consequences.**

- Anything that claims "installable" in README/INSTALL must be backed by S17 or
  quietly say it is smoke-tested. The packaging smoke alone is not enough.
- The suite's Node floor for this test is 22.15 (`module.registerHooks`), while
  the published package's `engines` floor stays 22.14; the test skips with a
  reason naming Node 22.15 rather than failing to link.
- If `PluginPackages` becomes exercisable in CI, that is a new decision with its
  own evidence, not a silent upgrade of this one.

## D51 — The vcs bridge reads git, and the event table has no "missing bridge" left

`$.vcs.detect` and `$.vcs.diff` are served; the other four pinned members
(`isolate`, `list`, `status`, `release`) are typed refusals, because their pinned
semantics are writes or bulk operations the read-only path cannot express. The
refusal is a member that throws with a named reason, never `undefined`.

`detect` records the real repository root from the caller's `cwd`. `diff` accepts
`{path}` only for a root that a prior `detect` recorded in the same seat, after
realpath confinement. That deliberately grants read over the **whole ancestor
repository**, not just the session subdirectory: it is what the `diff` mod's
`vcs-backend-of.ts` call graph does (`detect()` then `diff({path: copy.root})`),
and narrowing it would break the plugin. A relative `path` resolves against the
caller's cwd — the pinned prose at `claude-code.d.ts:4451-4453` @ 2.1.329 — and
must still land inside a detected root. The allowed set is host-side and exact;
a caller cannot widen it.

Every git invocation is `execFile` with a fixed argv: `--no-ext-diff`,
`--no-textconv`, no `--git-dir`/`--work-tree`, no network transport flag, a 10 s
timeout, a 32 MiB output cap, and `GIT_*` stripped from the environment.

`--no-ext-diff` and `--no-textconv` are **not** sufficient. A repository-local
`filter.<driver>.clean` still runs under them, which is arbitrary code execution
during a *read*. The bridge therefore enumerates `filter.` keys and overrides
each one through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`,
applied to the stat, `ls-files`, untracked and patch invocations, after the
environment is stripped. The `-c key=value` form was rejected: git splits it at
the first `=`, so a driver whose key contains `=` escaped the override. Both
escapes are pinned by regressions with a raw-git control that shows the driver
does run when the override is removed.

**D40's counts are superseded.** At the 2.1.329 pin the enumerated table has 167
names, **19 routed**, **148** unmapped, and **0 `missing bridge`**: the six `vcs`
names are no longer absent from the bridge. D40's `17 routed / 150 / 6 missing
bridge` and its `sec-default 16 routed + 61 unmapped` split are history; the
split is no longer quoted anywhere, because it moves with the table.

**Evidence.** `packages/dsh-anyplugin-mod-host/src/bridge.ts` (vcs section and
the override environment), `packages/dsh-anyplugin-mod-host/test/vcs.test.mjs`
(tracked, untracked and `filter=a=b` regressions plus the raw-git control),
the mutation that empties `vcsFilterEnv` and reddens both filter tests, and
`spikes/s15-mod-demand/run.mjs`, which prints `111 lines; invocations 17; $
groups 17; $ calls 22` and `24 served + 3 typed refusals + 3 absent`.

**Consequences.**

- A new `vcs` member needs its own entry here, not a quiet widening of the
  read-only path.
- A pin bump that changes `filter.` semantics must re-run the filter
  regressions; the override set is derived at runtime, not hard-coded.
- The bridge is not a sandbox for mods. It removes one execution channel from a
  read; a mod already runs with the authority its grant records (D25).

## D52 — A mod is a tree, a digest and a grant; the lock records the tree it booted

**Date:** 2026-11-21. **Supersedes D25 for mods only** on two sentences — “files:
the program only” and “There is no sorting”. Hooks keep D25 unchanged.

A mod is an artifact of its whole plugin tree, not of its entry file. A tree is
framed in sorted plugin-relative path order (`.git/`, `node_modules/` and the
data directory excluded), so one digest survives a different checkout location.
Every file under the root is part of the artifact: a mod may import any of them.

- **Dialect.** `hooks/hooks.json`'s `modules` become `IrMod {entry,
  rootRelative, annotation}`. A module is `equivalent` only when the host could
  load that tree (D30, D34); otherwise it is `unsupported` with the refusal it
  would hit named in the reason.
- **Lock.** `installs@2` records `mods` as plugin-relative paths in sorted order
  with `{mode, invocation, files}`. An `@1` lock reads as “no mods” and
  normalizes on write; a `@2` lock replayed as `@1` is refused with
  `unknown field "mods"` and a line number, so a downgrade cannot silently drop
  the record.
- **Trust.** Mods are `exec`-class (D25). The grant's artifact is the tree
  digest. Install refuses before evaluation without a grant; boot refuses
  without the lock record (`not-recorded`) even when a grant exists;
  `--drop-mods` is the only path that drops the block, and `--force` never does.
- **Load.** The materializer requires an absolute, real `pluginRoot`, compares
  the file set and bytes against the grant, and hands the scan's **byte map** to
  `loadMod` and the linker. No path is re-opened after the check, and an import
  the grant does not name is `ERR_MOD_HOST_UNGRANTED`. This closes the
  gate/load window rather than narrowing it.
- **Churn.** Touching any file in the tree — a README, a fixture — changes the
  digest and invalidates the grant. That is the cost of the whole-tree framing
  and is deliberate.

**What D52 does not claim.** Each item below is a named gap, not an oversight:

- **Runtime reads are unconfined.** `$.fs.read` still serves absolute paths,
  `../` escapes and symlinks outside the tree; `bridge.test.mjs` pins that
  pass-through. Read confinement is proposed as **D53** and must not be read
  into this entry.
- `.tsx` entries stay `planned` in the dialect (D34 defines the transform, not
  a bundler).
- `modules` declared outside `hooks/hooks.json` are out of scope.
- A file added after the grant is caught at the next load, not by a watcher.
- A hand-edited lock row with a recomputed, self-consistent digest is
  indistinguishable from the controller's; the consent boundary is
  `grants.yml` plus the lock.
- The 64 MiB snapshot cap has no over-cap fixture.

**Evidence.** `packages/dsh-anyplugin-dialect-claude-code/src/index.ts` (modules
to `IrMod`), `packages/dsh-anyplugin-install/src/installs.ts` (`@2` reader and
normalizer), `packages/dsh-anyplugin-materialize-hook/src/index.ts` (real root,
digest comparison, byte-map hand-off), `packages/dsh-anyplugin-mod-host/src/
loader.ts` (`ERR_MOD_HOST_UNGRANTED`), `install-cli.test.mjs` (symlinked root
records the real path and boots), `pinned.test.mjs` (both digests; added file)
and the mutations that redden the controller flag, the linker bound and the
snapshot hand-off.

**Consequences.**

- A new mod surface is a new record shape here, not a quiet widening of the
  tree.
- Any tool that rewrites a plugin tree invalidates its grant; the installer
  reports the digest change, it does not re-grant.
- Read confinement is its own decision (D53); until then a mod reads what its
  process can read, and the grant must not be described as content
  confinement.

## D53 — Remote marketplace fetches are network-class and pinned to the resolved artifact

**Date:** 2026-11-21.

A marketplace install may fetch `url`, `git-subdir` and `npm` sources only under
a `network` grant in the existing grants store (no second store). The grant is
keyed by `{plugin: <marketplace>:<entry>, capability: network, target:
<kind>:<spec>, artifactHash: <integrity>}`, where `artifactHash` is
`git:<commit>`, `npm:<sha512 of the packed tarball>` or `sha256:<downloaded
bytes>`, at the install scope, and is written only after a successful install.

- **Identity.** A URL's query string is bound into the target as an opaque
  `#q=<16 hex>` fingerprint while output stays redacted; a changed query or
  changed bytes is a different grant and asks again.
- **Lock.** The lock's optional `source` may carry `integrity` + `resolvedAt`,
  always together, inside the canonical quoted string. `dsh-anyplugin/installs@2`
  does not move for this field, and grants stay `@1` with the hash grammar
  widened to the three integrity kinds.
- **Pins.** A floating ref records the commit it resolved to. A later install
  resolving a different artifact refuses (`network-pin-moved`) before any new
  bytes run; `--yes` accepts the move by updating the grant. A revoke is not
  overridden by `--yes` and is expressible through
  `rig revoke --capability network`.
- **Dry run.** `--dry-run` fetches nothing and writes no cache, grant or lock.
  Because it fetches nothing it cannot see a moved pin, so its preview reports
  the integrity as unknown rather than asserting consent it could not check.
- **Transport.** `https:` and `file:` only (`http:` refused before any request);
  redirects must stay same-origin and must not add userinfo. Git arguments are
  passed after `--`, and `ref` must be a plain ref (no leading `-`, no `..`,
  `@{`, `//`, trailing `.`/`.lock`, control characters), because a ref is an
  argv element that git can read as an option.
- **Containment.** Fetched artifacts are cached content-addressed at
  `<lock-dir>/marketplace-cache/<marketplace>/<entry>@<resolved>/`, must be plain
  files (no symlinks), and go through the same single `installPlugin` writer as
  directory installs. Archive members are refused for `..`, absolute paths,
  backslashes, drive letters, duplicates and file/directory collisions, and the
  decompressed size is capped. A `network` grant never authorizes an
  `exec`-class artifact.

**What D53 does not claim.**

- The Windows tar path is validated by name only; CI runs `ubuntu-latest`.
- Source credentials are refused, not stored; private repositories are out of
  scope.
- `url` sources must be gzipped tarballs.
- `resolveGrant` picks the narrowest matching record without checking the
  requested `--scope`, so a project-scope network grant also authorizes a
  user-scope install, and a project revoke sticks against a user `--yes`. Both
  directions fail closed; neither is a confinement claim.
- `sha` wins over `ref` with no ancestry check.

**Evidence.** `packages/dsh-anyplugin-conformance/src/marketplace-fetch.ts`
(ref grammar, `--`, origin-equal redirects, redaction, integrity), `tar.ts`,
`packages/dsh-anyplugin-trust/src/authorize.ts`, `marketplace.test.mjs`,
`tar.test.mjs`, the 27-row mutation table in the PR, and the gate at both pins.

**Consequences.**

- A new fetch kind is a new grant key here, not a widening of an existing one.
- A new integrity computation must be added to the hash grammar and to the
  grant table together.
- `network` and `exec` stay separate classes; a fetch never implies execution.
## D54 — Installation closure is asserted on the Node CI runs

**Date:** 2026-11-21. **Supersedes** the "install closure remains unproven"
bullet of D50.

D50 made the bundle's "installed" claim rest on the host profile path and
recorded one piece as unproven: whether the harness installs the
`PluginPackages` interception, or only finds packages through a scope-link
stand-in. This entry closes that piece with an assertion instead of a note.

**Decision.**

- S17 asserts closure at boot: the host reports `hostPath === 'PluginPackages'`,
  the profile carries no `@deepseek-ai` scope-link stand-in, and every group
  entry's module URL resolves inside the installation tree (realpath).
- On a Node that cannot initialize the interception, the local gate takes the
  disclosed `scope-link` branch and says so in its diagnostic. Under CI — one
  predicate, `CI === 'true' || CI === '1'` (`harness.ts`) — it fails with a
  message that names the closure rather than falling back.
- S18 measures the boundary and derives its answer from the measured rows:
  Node 24.12.0 and 24.22.2 initialize 0/5 builtins and throw
  `Unsupported/no-getter`; Node 24.21.0 (Desktop) and 24.22.3 (what CI's
  `setup-node '24'` resolves to today) initialize 5/5. The boundary is a Node
  patch, not a harness pin.

**Evidence.** `profile-mount.test.mjs` (closure assertions), `harness.ts`
(`isCI`), `spikes/s18-install-closure/` (four-row measurement, answer derived
from rows), CI logs showing `host path: PluginPackages` at both pins. The
assertion is not vacuous: a pre-created profile scope link, a forced
`scope-link` host path, a group entry symlinked outside the installation, and
an inert `PluginPackages` class each redden it with its own message; faking the
probe in either direction reddens the agreement check. `CI=1` on an incapable
Node fails with the closure message (a prior spelling of the predicate only
checked `CI=true` and passed — that is why `isCI` is now shared and unit-tested).

**Consequences.**

- Any "installable" claim in docs or release notes must cite S17, and S17's
  headline says "on the Node CI runs", not "on the gate's Node" — the local
  gate may be incapable and then takes the disclosed weaker branch.
- CI's Node floats with `'24'`. A future patch that loses the interception
  fails the gate loudly instead of silently passing through a scope link.
- Unclaimed here: Nodes outside the measured set when the gate runs off CI;
  non-linux-x64 platforms; import shapes the three assertions do not observe.
  A harness whose installation mechanism works but is invisible to these
  assertions is a new decision, not a silent widening of this one.
- `node-addon-require-builtin` is a dependency of `dsh-app-boot`
  (`^0.1.9`); the fetched trees used here resolve `0.1.10`, and the harness
  pin does not fix the addon patch.

---

## D55 — The mod API is measured against the pinned declaration

Ratified 2026-11-21.

The mods subsystem gets a denominator instead of a vibe. `scripts/mod-coverage.mjs`
parses the generated `claude-code.d.ts` of the pinned `claude-code` release and
compares it with what our runtime actually exposes; the result is
`fixtures/mods/coverage.json`, a reviewed artifact with the pin and the
declaration's sha256.

**What is declared.** At `claude-code@2.1.329` (`f9e4d1e5…`, d.ts sha256
`c5b4d944…418cf`): 24 `$` namespaces, 100 namespace methods, 2 namespace
properties, 167 event names, 45 surface-qualified elements (14 unique), 20 render
sites, and 10 `Matcher*` type aliases. The event count is the union of engine, op
and `classic.*` names at that pin; it is not the number of events the host fires.

**What is "served".** A member is served only if the runtime surface reaches it
and it is not a typed refusal: served sets are derived by calling
`createModBridge(...).dollar()` and enumerating the returned table (elements come
from `elementsForSurface`/`ELEMENT_TAGS`, events from `MOD_EVENT_ROUTES`), never
by grep. A typed refusal is its own class with its reason code, because "present
but refuses" is not "served". A namespace counts as served only if at least one
member is; `process` and `settings` are refused-only. A member we expose with a
different shape (`session.cwd` is a method at the pin, a string for us) is a
`wrongShape`, counted in no other class.

**Partitions.** Every category partitions: namespaces = served + refused-only +
absent; methods and properties = served + refused + absent + wrongShape; events,
elements and render sites = served + absent. Matchers are counted by name only —
there is no runtime type surface to compare, and saying they were "served" would
be a category error. Elements are table coverage, not drawing coverage: 45/45
says the surface tables mention every declared element, not that a pane rendered
it. Render sites are 1 served / 19 absent, because the sink dispatches only
`Pane` on `terminal` (D44).

**The gate.** `--update` accepts drift in the declaration (a new upstream member
appears as absent) and refuses members our runtime exposes but the declaration
does not name. Two runs produce byte-identical output. The ledger never enters
the fidelity ratchet: it is a denominator, and it never says "mods are 100 %".

**Consequences.** Closing a gap means moving a name from `absent`/`refused` to
`served` in the same commit that changes the runtime, and the ledger is the only
place that number is written. Shape mismatches are bugs against the pin and get
their own ticket (#134 for `session.cwd`). A new pin means re-deriving the
declaration, not editing the ledger by hand.

---

## D56 — `bin/` is `planned`: the managed environment cannot carry PATH

Ratified 2026-11-21.

S19 answered the question the TODO had been assuming. The model shell's PATH is
built from the managed environment overlay plus the host process environment; at
`0.2.2-rc.5` and `0.2.2-rc.2` on Linux:

- `dsh-shell-env` accepts declared `DSH_*` keys only — registering a contributor
  that declares `PATH` throws `bash env contributor "…" declared invalid key "PATH"`;
- a resolver that declares a `DSH_*` key but returns `PATH` is refused inside the
  model call with `bash env contributor "…" returned undeclared key "PATH"`
  (`SHELL_ENV_CONTRIBUTION_INVALID`);
- the model-facing bash and pwsh tools send only that overlay and expose no `env`
  parameter (pwsh is source-read on Linux, not booted);
- a probe `bin/` is therefore unreachable: `probecmd` exits 127, and a probe `ls`
  does not shadow the system one.

So `bin/` stays **`planned`**, not `unsupported`: it is expressible another way.
`tools/pre-execute` can rewrite `exec.arguments` before the call (the same seam
classic `updatedInput` hooks use), and S19 check 19 demonstrates it — prepending
the probe directory makes the command run, and disposing the listener returns the
call to 127. We decline it for now because it diverges:

- later hooks and the hook trace see the rewritten command as `tool_input`; the
  session transcript keeps the model's original (asserted in
  `mods.test.mjs`, transcript case);
- pwsh grammar differs, so a rewrite is shell-specific;
- Claude's rule "plugin bins follow the user's entries" becomes an ordering
  decision inside the rewrite rather than a property of the environment.

**The plan** is the union-only contribution proposed upstream: an `extraPath`
shape in `dsh-shell-env` that appends declared directories to the child PATH,
which would make the face `equivalent` without rewriting any command. Until that
exists, the dialect reason says all of the above, names both pins, and does not
claim that no seam exists.

**Consequences.** The v0.3 roadmap keeps `bin` as pending that seam, not as
shipped work. A future per-call rewrite would be a new decision with its own
divergence list, not a silent use of D56. The S19 spike and both CI steps stay
green so the claim cannot rot.

---

## D57 — The declared shape is the contract, and `wrongShape` is a bug queue

**Decided** 2026-11-21. **Supersedes the present-tense example in D55.**

D55 introduced a `wrongShape` class so the mod coverage ledger could say, without
lying, that we serve a member with a different type than the pinned declaration.
The class was never meant to be a resting place, and the one member in it is now
gone: `$.session.cwd` is `() => Promise<string>` at the pin and `#138` made it the
same promise-returning method here, with the async contract asserted (a hybrid
that returns a string on the attached path reddens both the pinned-turn test and
the bridge test).

**The rule now.** A member whose shape disagrees with the pinned declaration is a
bug with a ticket, not an accepted category. `wrongShape` stays in the ledger
because a future pin can produce one, but it must trend to zero, and the ledger
says so (`shapeMismatches` and `wrongShape` are printed, currently empty). No
materializer may mark a member `served` on the strength of a callable existing:
the class the runtime actually exposes is asserted, not the name.

**Consequences.** D55's sentence "`session.cwd` is a method at the pin, a string
for us" is historical; the classification rule it states is unchanged. A pin bump
that reintroduces a shape mismatch reopens a ticket — it does not inherit an
allowance.

---

## D58 — The kernel's lifecycle ordering guarantee is per materializer load

**Decided** 2026-11-21, with `#140`/`#141`.

The host's `createLifecycleEmitter` dispatches each listener but only contains its
promise (`Promise.resolve(returned).catch(...)`); dispatch order is guaranteed and
completion order is not. That surfaced as a CI red: `SubagentStart` logged after
`SubagentStop`.

**Decided.** The materializer owns a per-child pair gate: the `SubagentStart`
chain is recorded and the same child's `SubagentStop` chain awaits it, in both the
classic mount and the mods-mode seat. `SubagentStart < SubagentStop` is therefore a
**kernel** guarantee, not a host one, and it is scoped to one materializer load:
a reload that begins while a start chain is in flight starts a fresh apply with an
empty map and does not hold that child's stop. `SubagentStop < SessionEnd` stays
unclaimed, because `agent/disposed` is an independent emit.

**Stated bounds, not hidden costs.** A normal start settles within 65 s (60 s hook
timeout plus grace; the process is SIGKILLed at 60 s); the stop chain then runs its
own 65 s chain, so a stop listener may take ~130 s end to end. A mod that pauses in
`next`/`$` has no bound and can starve the stop. The pending map is not cleared on
disposal, so a start that never settles retains its entry; that was chosen over
changing the shutdown path, and it is written in the Risk section rather than
papered over.

## D59 — The packaged artifact has its own budget

**Decided** 2026-11-21, with `#148`.

D46's 128 KiB ceiling bounds the mods kernel bytes inside the bundle. The npm
tarball is a different object and needed its own number: before this decision it
had no gate at all, and the same PR that shipped the installer CLI grew it from
136.6 KiB to 223.4 KiB by bundling conformance-gate code that no command needs.

**Decided.** `check:pack` asserts the compressed tarball is at most 180 KiB and
prints `tarball: N KiB / ceiling 180 KiB`. It also asserts that the shipped
`lib/` carries none of `resolveClaudeBinary`, `claude --version`, `diffTraces`
or `INVENTORY_SCHEMA`; that `SourceTextModule` appears only in
`lib/materialize/hook.js`; and that `lib/cli.js` keeps one literal
`import("./<module>")` per conformance-gate module, so a module that stops being
lazy fails twice. The gate list lives in `scripts/shipped-gates.mjs`, and
`scripts/build.mjs` derives its externals from the same list — one source for
both sides.

**Numbers, as measured.** The tarball is 178,608 B compressed (174.4 KiB, ~3 %
under the ceiling) and 719,364 B unpacked; the kernel stays at 115,532 B across
7 files. A build that bundles a gate module fails with
`lib/chunk-*.js carries conformance-gate code: INVENTORY_SCHEMA`, not with a
size warning.

**Consequences.** The installer is a thin front door, not a second copy of the
rig: the published bin refuses `capture`/`verify`/`diff`/`trace` by name and
tells the reader to run the same command from a checkout. Raising either ceiling
— this one or D46's kernel ceiling — requires a new decision entry, and a size
number in prose must say which of the two it is measuring.

## D60 — The generated mod type surface is internal; shipping types is a separate decision

**Decided** 2026-11-21, with `#150`. Extends D55 and D57.

`#144` made `packages/dsh-anyplugin-mod-host/types/mod.d.ts` a generated served
subset of `$`: the 9 served namespaces and their 26 members, with the pin's own
signature text (so `$.session.cwd` is `() => Promise<string>`, D57), and the 7
refused members folded into one closed `ERR_MOD_HOST_*` union. It names no absent
member and refuses to guess a signature it cannot copy, including method-form
parameters, constraints and type predicates.

**Decided.** That file is internal. It is not shipped, has no package export, and
is not an author-facing surface; it exists so the ledger and the pin cannot drift
silently. `check:pack` asserts the tarball contains no `types/` path, and shipping
the real surface is a separate decision.

**Why not ship it.** Shipping means putting Anthropic's generated
`claude-code.d.ts` (895,875 B, © Anthropic PBC) into the published tarball. D14
says the pin is a specification to read, not an artifact to vendor, and the
licence grants no redistribution right. The alternative — an inlined helper
subset — is a real option but a different claim: those shapes are our
re-derivation, so they are `equivalent`/`derived`, not the verbatim copy D57
requires. Author-facing mod types are therefore `planned`, and `docs/TODO.md`
names the blockers (D14, D57, this entry, `#144`) instead of implying they ship.

**Consequences.** The generator and its tests stay, because they are what turns
pin drift into a red test. Any future "mod authors get types" work starts here:
either negotiate redistribution, or publish a derived subset under a new decision
that says so — never by quietly adding `types/` to `files`.

## D61 — The published package exposes `./install` as its programmatic installer

**Decided** 2026-11-21, with `#155`. Amends D43.

The panel is a separately published optional package, but it must not grow a
second install writer (D23, D49): the CLI, the panel and any future consumer all
go through `installPlugin`. D43 closed the published surface to `.` and
`./materialize/{skill,mcp,hook,agents,output-style}`, so the panel had nothing
published to call.

**Decided.** The root package additionally exports `./install` → `lib/install.js`,
re-exporting `installPlugin`, `listPlugins` and `InstallCliError`. It is subject to
the same shippability rules as every other entry: `check:pack` scans it for
`resolveClaudeBinary`, `claude --version`, `diffTraces` and `INVENTORY_SCHEMA`
and refuses `SourceTextModule` outside `lib/materialize/hook.js` (D59), so the
installer cannot quietly drag the conformance rig into the tarball. It must not
import the oracle, trace or harness modules.

The rest of D43 stands: no other subpath is added, and `demonstrating` a new one
is a new decision rather than a `package.json` edit.

**Consequences.** An optional package can be published on its own and still use
exactly one install path. A consumer that needs install semantics cites this
subpath instead of copying `install-cli.ts`, which is what D49 exists to prevent.

## D62 — The panel is a separate, loopback-only bundle that writes only through the install API

**Decided** 2026-11-21, with `#155` (issue `#147`). Related: D49, D59, D61, D27.

The panel lets a user install a foreign plugin from a directory without a
terminal. Every part of that sentence needed a decision, because each one is a
new way to make the harness write.

**Decided.**

1. **It is a second bundle, not part of the root package.** The root tarball is
   capped at 180 KiB by D59 and the client half did not fit. The panel therefore
   ships as `packages/dsh-anyplugin-ui` with its own `cordis.patch.yml`, its own
   64 KiB ceiling in `check:ui`, and `private: true` until a one-time npm
   approval exists for the name (`docs/TODO.md`). A ceiling is not raised to fit
   a feature; the feature moves.
2. **It writes only through `installPlugin`.** The server half calls the
   `dsh-anyplugin/install` export (D61) and passes the path; it does not parse
   the lock itself, does not accept `scope`, `grants`, `dialect` or `force` from
   the client, and does not become a second writer (D23, D49). The only scope it
   may set is the user layer.
3. **Both routes are loopback-only.** `Host` is client-supplied, so an
   `Origin`-equals-`Host` comparison is self-satisfying: a page reached through
   DNS rebinding sends its own name in both, and can write `installs.yml` and
   read it back. Both the install and list routes require a normalized loopback
   host (`127.0.0.1`, `localhost`, `::1`); a deliberate non-loopback bind must
   name itself in `allowedHosts`.
4. **Reachable mutations are guarded on the request, not the UI.** The install
   route requires `application/json` (415), rejects a foreign `Origin` or a
   cross-site `Sec-Fetch-Site` (403), caps the body by declared bytes before
   reading it (413), and closes the connection on any 4xx. The client is not the
   security boundary: a `fetch` from devtools or a script has to face the same
   checks.
5. **No foreign code in the server process, and refusals stay visible.** The
   panel never imports an installed plugin; a refusal is reported with the
   command or file it concerns, and the client renders `installed <plugin>; N
   components refused` rather than a bare success.

**Consequences.** The panel cannot be published without an explicit release
decision (it is `private` and the release workflow publishes only the root
package). Adding a host to `allowedHosts` is a configuration change with the same
threat model as binding off loopback. The mutation audit lives in
`packages/dsh-anyplugin-ui/test/mutations.mjs`: eleven single-property breaks,
each required to redden a named test, so the guards cannot be deleted quietly.

## D63 — The process audit is a separate, gated role

**Status:** ratified 2026-11-22 (audit baseline).

Agent throughput was never the bottleneck; repeated mistakes were. The same
review comments recur across PRs — a claim stronger than its proof, a doc that
promises more than the code, a field that is silently dropped — and the fix
lives in the process, not in the ticket that happened to expose it.

**Decided.**

1. **A separate role, on a schedule.** The auditor runs daily, reads the
   transcripts, the queue and the gates, and writes `docs/audits/<date>.md`. It
   is not a worker and does not implement tickets; its write scope is audit
   tooling, process docs, the audit skill, and a gate/test that is the finding's
   own fix.
2. **Findings are a ledger, not prose.** `docs/AUDIT.md` carries one entry per
   recurring mistake with the mechanism that prevents it (`hook`, `ci`, `lint`,
   `skill`, `reviewer`, `docs`, `schedule`) and an honest status. `enforced`
   requires a machine mechanism and a proof file; `dormant` says the mechanism
   is tested but not installed. A finding that cannot be machine-prevented is
   `reviewed` by two independent reviewers, or documented with the reason.
3. **The ledger is gated.** `npm run check:audit` runs inside `verify` and fails
   on a missing artifact/proof, a weak `enforced`, a report without the four
   headings, or a ledger older than its latest report. A list that cannot redden
   a PR is a diary.
4. **Role breadth is audited.** The evidence digest reports the largest
   sessions, their working directory and their write paths. A root session over
   roughly 1,500 tool calls is a finding with a proposed split, not a badge.
5. **A mechanism change gets two reviewers, and the master merges it.** The
   auditor never merges. A reviewer verdict is `Claim | Proof | Verdict` with
   `file:line`; `weaker` and `not proven` block the merge until the proof grows
   or the claim shrinks.

**Consequences.** `verify` now includes `check:audit`; a daily schedule exists
outside the repository and a fresh checkout recreates it. The guard's push rule
is `dormant` until the pre-push hook is installed (F1/F2), and the merge-head pin
(#163) and structured denial log (#164) remain open. The first baseline is
`docs/audits/2026-11-22.md`.

## D64 — A monitors declaration the client rejects is loaded with an error, not fatal

**Status:** ratified 2026-11-22 (#159, S22).

At `claude-code@2.1.329` the client's verdict on a `monitors` declaration depends
on **where the declaration lives**, not only on its shape, and this layer mirrors
that split instead of averaging it:

- A **manifest-shaped** violation — an invalid entry in the inline `monitors`
  array, a `monitors` value that is not an array, or a path string that does not
  start with `"./"` — makes the manifest invalid: the plugin is not loaded and
  `plugin details` does not list it. We keep the fatal `CompileReport` path and
  emit nothing.
- A **file-shaped** violation — bad JSON or an invalid entry in
  `monitors/monitors.json` (or in a `"./"`-declared file), a duplicate monitor
  name, or a `"./"` target that is missing, is not a regular file, or is
  unreadable — is printed by `claude plugin list` as `Status: ✘ loaded with
  errors`, while the plugin stays registered and `plugin details` still serves
  its other components (`fixtures/claude-monitors-bad-key` lists
  `Skills (1) innocent`). We therefore compile the plugin, emit its siblings,
  and carry the declaration as one `unsupported` row. The marketplace load path
  printed `Status: ✘ failed to load` for the same declarations; the two paths
  diverge at this pin, this layer mirrors the directory path that
  `rig install <dir>` corresponds to, and the carried reason states the
  divergence.

Precedence and validation: the manifest `monitors` key (array or `"./"`-relative
path) overrides `monitors/monitors.json` entirely; a missing file, a plain
`monitors` file, or ENOENT/ENOTDIR counts as no declaration; names are unique and
case-sensitive; `name`, `command` and `description` are non-empty strings; `when`
is `always` or `on-skill-invoke:<name>` with a non-empty name; unknown keys are
rejected. A valid declaration stays one `planned` row and is carried, never
materialized (D37, S22: the client validates it and never runs it headless).

Every quoted client string, including the `plugin list` status, comes from
`MONITOR_CLIENT_TEXT`, generated from `fixtures/claude-monitors-errors/observed/`
by `scripts/capture-monitor-errors.mjs` at the pin. File-shaped shapes also
capture the `Status: ✘ loaded with errors` line; manifest-shaped shapes print no
status line, so none is invented or quoted for them. The tests compare the
emitted row with the captured files exactly, including the client's typographic
quotes, and reject our own fs codes and Node position details. `capture-monitor-errors.mjs
--check` rebuilds the corpus and diffs it byte-for-byte inside `npm run verify`,
so a pin bump that rewords the client reddens the gate with the changed file's
name and produces a reviewable corpus diff instead of a silent drift.

**Consequences.** A rejected declaration no longer fails a plugin the client
still serves; the price is that "the plugin loaded" and "its monitors work" are
now separate claims, and only the first is observable. R14 checks that the named
owner test file exists, not that the test reads the fixture — deleting
`monitors.test.mjs` produces the expected violations, but the link is
file-existence, not semantics. The runtime notification channel a monitor would
feed is still open in `docs/TODO.md`; that is a product decision, not a fidelity
gap, because there is no observable spawn target at the pin.
## D65 — The marketplace catalog's path selects its parser; the Claude and Codex entry shapes never mix

**Decided 2026-11-22** (#161, #167). Claude's `.claude-plugin/marketplace.json`
and Codex's `.agents/plugins/marketplace.json` look alike and are not the
same catalog.

1. The format comes from the catalog path, never from sniffing the document.
   `.claude-plugin/marketplace.json` parses as Claude and
   `.agents/plugins/marketplace.json` as Codex; an entry that disagrees with
   its file's shape is a problem naming the field. `parseMarketplace` takes an
   explicit format for unit callers only.
2. Codex `policy` and `category` are required per entry. On a Claude entry
   `policy` is a note. `policy.installation` is required but its value is a
   hint: only `NOT_AVAILABLE` is refused, before the source is resolved and
   before a copy.
3. `--from` takes a catalog file or a root. A root is looked up at both paths;
   when both exist they are merged for listing, each row names its format, and
   the format selects the install dialect unless `--dialect` overrides. A name
   declared in both is `ambiguous-marketplace-entry`; the reader never picks
   the first.
4. Every install passes the catalog name as `installPlugin`'s `name`
   assertion, so a catalog/artifact disagreement is `name-mismatch` before any
   write. A fetched artifact is checked against **the manifest the selected
   dialect reads**, resolved the way the reader resolves it: the first existing
   dialect manifest, its non-empty `name`, else the directory basename; a
   shadowed manifest is never read. Dialect and version refusals are install-time
   decisions and may leave the artifact cached; the pre-commit check covers the
   name mismatch. No catalog is `marketplace-not-found`; an existing file at
   neither path is `unknown-marketplace-format`.
5. The Codex page is the authority (no offline Codex client);
   `fixtures/marketplace-codex/PROVENANCE.md` records the URL and read date.
   D33 covers the portable plugin manifest and is silent on this file.
6. Remote `url`/`git-subdir`/`npm` entries keep D53 unchanged: `list` makes no
   network call, `install` needs the network grant, pins the resolved content
   address, and refuses a moved pin until `--yes`.

**Consequences.** Codex `ref`/`sha` and a named `registry` are typed refusals:
supporting either is a new fetch kind under D53, not a parser change. The shipped
CLI grows to 182.0 KiB compressed, so **D59's 180 KiB ceiling moves to 184 KiB**
(`check:pack` enforces it). D59's text stays as the historical record — the log
is append-only — so the new number lives here.

---

## D66 — A modelled merge must name the reviewed head, and the pin is what makes omission visible

**Decided 2026-11-22** (#163, #171). The guard's push rules made the root's
merge path the one action a worker could not take, but a root merge could omit
the head entirely, leaving GitHub nothing to check.

1. Every modelled `gh pr merge` must carry `--match-head-commit <40-hex>`, for
   every role. A bare merge, `--auto` without a pin, a short (7-character) or
   41-character sha, a non-hex 40-character value, a flag with no value, and a
   flag hidden after `--` are refused before the tool runs. Workers remain
   refused outright by `gh-pr-merge-worker`; `gh-pr-merge-pin` is the root-facing
   check and sits before the unconditional root allow.
2. **The pin prevents omission; it is not review verification.** The guard can
   see that a merge names a head; it cannot know that head was the one a
   reviewer read. GitHub refuses a moved head when the pin is the reviewed sha,
   which is the value added — a merge cannot silently skip the check.
3. A pin cannot be smuggled or swallowed. A URL fragment or query keeps the raw
   `gh api …/pulls/<n>/merge` route live, so **any** method, query or fragment
   on that path is refused — a raw `gh api` can never carry the pin. The value
   flags `-b/--body`, `-F/--body-file`, `-t/--subject`, `-A/--author-email`
   and `-R/--repo` consume their values (both the long and short sets), so a
   pin-shaped token in value position is not a pin. `gh pr -R o/r merge` is
   judged as a merge, and a backslash-newline cannot split `gh pr \` / `merge`
   or `m\` / `ain`.
4. Two false positives are explicitly exempt: `gh pr merge --help` performs no
   merge, and for the root `--disable-auto` / `--disable-auto=true` cancels
   auto-merge rather than merging. Their merging forms (`--disable-auto=false`,
   `--auto=false`) still require the pin.
5. The status of finding F12 is **dormant**: the mechanism is implemented and
   tested, and it is enforced on the modelled merge paths wherever the guard is
   installed, but the guard is not installed on this machine (F1). Installation
   is a separate step, not part of this decision.

**Consequences.** This amends D47's rule table (109 rows to 123) and supersedes
D63's "the merge-head pin (#163) remains open" sentence. Named residuals, none
closed here: `curl` and other non-gh clients, a root-run script, inline
interpreters (`node -e`, `python3 -c`), a `gh` alias or wrapper, **a
pre-existing git alias** (`git config alias.pm '!gh pr merge --squash'; git pm 82`
— root-only, named rather than refused), raw GraphQL `mergePullRequest`, and
GitHub's own deferred evaluation of `--auto` even with a valid pin.

---


---

## D67 — The guard installs from the real git layout, and the block says what it can and cannot attest

**Decided 2026-11-22** (#166, #172). The install block used to be written from
the installing *worktree* and a static list of twenty-two paths. That mixed two
different things — where the installer happened to stand, and where worktrees
will exist — and it could name a directory the plan never intended.

1. **Layout comes from git, not from the process.** The install root is derived
   from `git rev-parse --path-format=absolute --git-common-dir` (its parent),
   and a tree whose `--git-dir` differs from `--git-common-dir` is a **linked
   worktree**: install refuses there, before any write, and names the main
   checkout (or says git cannot name it, for a submodule or a
   `--separate-git-dir` repository). `--dry-run` still writes nothing.
2. **The block carries three lists, each with a job.** `worktrees` holds the
   derived pattern (see 3); `protectedRoots` holds the main working tree and a
   common git dir that differs from it; `gitDirectories` holds the real git
   directory identities. A worker write anywhere inside a git directory is
   `git-dir-write` whether the directory is called `.git` or `sep-gitdir`; a
   root write there stays allowed, because the root is the one who installs the
   hook.
3. **The pattern is a namespace matcher, and that is a caveat, not an
   attestation.** `<stem>-*` admits future ticket worktrees without a reinstall.
   It therefore also admits a sibling that merely shares the prefix
   (`ticket-notes` next to `ticket-*`). The guard cannot tell them apart: the
   block stores no worktree identity list, and git cannot attest a future
   namespace. The `ticket-notes` test names the behaviour so it is a known
   property rather than a surprise; a stricter mode would be a new decision.
4. **`-*` is the whole grammar.** Only an entry ending in exactly `-*` is a
   pattern; `ticket*` and `ticket-**` are literal paths. A live worktree whose
   name contains `*` therefore makes the installed block unsafe to honour: the
   status is `refused` (not `current`), and the remedy is to rename the checkout
   rather than to silently reinterpret the entry. Entries written by the old
   installer are read as the literals they are, and a missing one reports
   `installed-with-stale-paths`.
5. **Four statuses, four meanings.** `not-installed` (no block), `current`
   (every listed path exists), `stale` (a listed path is gone), and
   `installed-with-stale-paths` (a path that *was* a worktree is gone while the
   rest are fine), plus `refused` for 4. Each is a distinct exit code, so a
   script can tell "not installed" from "installed and drifted".

**Consequences.** Installation is from the main checkout or a scratch clone;
`--dry-run` prints the block and writes nothing. Residual: when the stem cannot
be derived, the block keeps an exact list, so a worktree created later is
refused (with a message naming it) until `guard:refresh` or a reinstall —
recorded rather than hidden. This does not change D47's rule table or the
dormant status of F12; it changes where the block gets its paths and what the
guard can claim about them.

---

## D68 — The guard's denial log is an observability record, not an enforcement boundary

**Decided 2026-11-22** (#164, #181). F16 found that guard refusals existed only
as `DENY` prose in a tool result, so the audit could not count them except by
matching transcripts where the guard's own test matrix also matches.

1. **One JSON object per denial.** Every `tools/pre-execute` denial appends a
   record with `ts`, `role` (`root`/`worker`), `rule`, `tool`, `cwd`, `worktree`,
   `session` and `subject`. `cwd`/`worktree`/`session` are `null` when the call
   does not expose them; `subject` is the judged command or path capped at 300
   characters. The arguments blob is never written.
2. **Redaction is a trade-off, not a guarantee.** Credential shapes (`ghp_`,
   `github_pat_`, `sk-`/`xsk-`, `Bearer`/`Basic`, both `--token` spellings) and
   long hex/base64/base64url runs become `[redacted]`. A 40-hex git sha is
   likewise redacted because it is indistinguishable from a short key at this
   length; that is documented in `denials.ts`.
3. **The default path follows the repository, not the module.** The log is
   `<checkout>/.audit/guard-denials.jsonl`, where the checkout is the one owning
   the `.git` common dir (`mainCheckout`, D66); `DSH_ANYPLUGIN_AUDIT_DIR`
   overrides. The reader (`scripts/audit-checkout.mjs`) mirrors that derivation so
   linked worktrees, `--separate-git-dir` and submodules read what the guard
   wrote; a test asserts the two agree in all four layouts.
4. **Best-effort, never load-bearing.** One `O_APPEND` on
   `O_NOFOLLOW|O_NONBLOCK`, a non-regular file is refused, a failure prints once
   per process and never changes the verdict. In-process dedupe on
   `session + callId` (last 512) keeps two app-level plugin loads from double
   counting one call; two sessions sharing an id remain two refusals.
5. **Nothing fails on the log's absence.** `audit:evidence` aggregates totals, by
   rule, by role and the last five records, and reports "no structured log" or
   "log unreadable" — but no gate may fail because the file is missing. The log
   observes the guard; branch protection, the DSH sandbox and CI remain the
   boundary.

**Consequences.** F16 moves to `enforced`. The guard's test matrix is hermetic
(every test sets its own `mkdtemp` directory), so a `verify` run writes zero
lines to an external audit directory; one real denial under the override writes
one line, asserted against a byte-identical checkout log.

---

## D69 — Performance is a paired ratio against the base tree, not a millisecond count

**Decided 2026-11-22** (#177, #187). Milliseconds do not survive a different
machine, a busy host or a different Node patch; a ratio measured twice in the
same run mostly does. `scripts/perf.mjs` therefore compares the working tree
against a base tree and reports `head / base`.

1. **Ratios are the claim; milliseconds are description.** Each probe times both
   trees in one run and reports the ratio. The table also prints absolute
   numbers, but nothing compares them across runs or machines.
2. **Pairing is the sampling unit.** P1/P3/P4 import both trees into one child
   per repeat. P2 discards one warm-up pair, then boots one base child and one
   head child **adjacent in time** with the order alternating; a boot log whose
   pairs are not adjacent fails to parse (`pairBootLog`) instead of being
   averaged as two blocks. The reported number is the **median of the per-pair
   ratios**; the per-side medians sit next to it as description, and a test
   pins that a side-median ratio cannot be reported in its place.
3. **`--check` gates P1, P3 and P4 at 1.5×.** P2 (boot + reconcile) and P5
   (size/RSS) are informational. P2's same-code ratio spans roughly 0.9–1.2, so
   a 1.5× gate would read a real 1.5× regression as a 0.885× pass; P5 is a
   budget, not a duration. The verdict sentence says "all **gated** ratios" and
   names that P2 was not checked, so `all` can never be read as covering it.
4. **The bar is an observation, not a guarantee.** Five consecutive same-code
   runs must each land inside 0.85–1.18 for a gated probe on this machine; the
   measured values are in `docs/PROFILING.md`. A run outside the band is a
   reason to re-measure the band, not by itself evidence of a regression.
5. **Not in CI.** `--check` is deliberately not wired to `verify`: it needs a
   base tree, repeats of short-lived children and a quiet host — none of which a
   two-core runner gives. CI runs the probe tests; a human runs the comparison
   before a release and whenever a change claims "no regression".
6. **A regression claim names the probe, the threshold and the repeat count.**
   "Faster" or "no regression" without those three is not a measurement.

**Consequences.** #187 lands P1–P5 with the pairing rules and the mutation
matrix M1–M8. Acceptance pins the pair-median report and the gated-only
wording. No gate in `verify` reads perf numbers, so a red perf run can block a
release decision but never a merge.

---

## D70 — The five S23 classic events ride records and emits, once per real occurrence

**Decided 2026-11-22** (#197, S23). `TaskCreated`, `TaskCompleted`,
`WorktreeCreate`, `WorktreeRemove` and `StopFailure` were the five S9-unprobed
classic events with a host emitter at the `0.2.2-rc.5` pin. They are now
routes in `packages/dsh-anyplugin-intercept/src/mod-events.ts` and payloads
in the classic hook mount
(`packages/dsh-anyplugin-materialize-hook/src/index.ts`), notification-only.
The classic names and payload shapes do not move (D32).

1. **A durable record or an emit is the occurrence, not a turn.** The task and
   worktree events are service calls; `StopFailure` is a failed model turn.
   No route waits for a model step that may not happen.
2. **One handler invocation per real occurrence.** `TaskCreated` fires on
   `task.revision === 1`; `TaskCompleted` on `task.status === 'completed'`.
   `WorktreeRemove` fires only on the settled `worktree/cleanup` record with
   `cleanup.status === 'removed'`, keyed by session, path and
   `cleanup.revision`; the `scheduled` record is an intent, and `retained` /
   `failed` are not removals. `StopFailure` fires once per root session and
   turn (key session/`turn`), whichever of the error-shaped `turn/end` record
   and the `agent/error` emit arrives first; child sessions are excluded
   because `SubagentStop` owns them. The host emits twice in two of the five
   cases, so dedupe is part of the route, not an optimisation.
3. **Missing fields are reported gaps, never invented values.** The mount
   reports `team_name` for both task events (`teamId` is the root session id
   branded as a Team identity, not a display name), `teammate_name` for
   `TaskCreated` (a revision-one task is unowned), and `error` plus
   `last_assistant_message` for `StopFailure` (the host failure code has no
   ratified mapping to Claude's class enum, and a failed turn commits no
   `assistant/message`). `TaskCompleted` takes `teammate_name` from
   `ownerName`; `StopFailure` takes `error_details` from the host message.
   No DSH field is renamed into a Claude name.
4. **Notification-only means no veto.** A `deny` or `block` from one of these
   handlers is a typed unsupported/ignored warning, as for
   `PreCompact`/`CwdChanged`; it cannot stop a turn, a removal or a task.
5. **Counts move with the route.** 24 live routes (21 classic, plus
   `session.start`, `tool.call` and `prompt.context`) and 143 unmapped names
   supersede D51's 19/148. `TeammateIdle` stays unmapped with its S23
   host-gap reason: the pin records no `team/member`, and a listener cannot
   create that seam.

**Consequences.** `fixtures/claude-hooks-seams` drives a real headless run and
asserts one log line per routed event, the payload key sets, and the two
dedupe cases; the coverage ratchet moves to 32 declared / 31 matched, and
`fixtures/mods/coverage.json` is regenerated in the same commit.

---

## D71 — The registry tarball ceiling moves to 188 KiB

**Decided 2026-11-22** (#197). Routing the five S23 events adds the record
translation to the shipped classic hook mount, so `npm pack` measures the
registry tarball at **190257 bytes (185.8 KiB)**, above D65's 188416-byte
(184 KiB) ceiling. The ceiling moves to **188 KiB (192512 bytes)**, leaving
2.2 KiB of headroom; D46's separate 128 KiB kernel ceiling is unchanged.

1. **The tarball is the shipped surface, not the source tree.** The five
   routes live in `packages/dsh-anyplugin-materialize-hook/src/index.ts`, which
   ships; trimming comments or moving the translation to another module would
   hide the code without shrinking the payload materially.
2. **A budget raise is a decision, not a silent drift.** The next raise cites
   the measured byte count and the feature that caused it, as D65 and this
   entry do.
3. **The kernel ceiling stays the fidelity budget.** D46's 128 KiB limit was
   not touched; this entry only bounds the registry tarball the CLI serves.

**Consequences.** `scripts/check-pack.mjs` carries the new constant and points
at this entry. The measured size is from the same build CI runs; no dependency,
pin, workflow or kernel limit moved.

---

## D72 — D70's field sentence is superseded: the gaps are named and the translations are separated

**Decided 2026-11-22** (#197, review of PR #201). D70 rule 3 ends "No DSH
field is renamed into a Claude name" three lines after naming
`ownerName → teammate_name`, and while `WorktreeCreate` maps `branch → name`
and `StopFailure` maps the host failure message into `error_details`. The
claim is false as written, and the gap list omits `transcript_path`,
`permission_mode` and `WorktreeRemove.cwd`. This entry supersedes that
sentence and that list; D70's routing, dedupe and notification-only rules
stand unchanged.

1. **Gaps stay named.** The mount reports `transcript_path` for all five
   events (the host keeps no transcript path, and this mount does not read the
   session log), `permission_mode` for `TaskCompleted` (session-level at the
   pin and absent from `team/task`), `team_name` for both task events,
   `teammate_name` for `TaskCreated`, and `error` plus `last_assistant_message`
   for `StopFailure`.
2. **`WorktreeRemove.cwd` is the host process directory.** The
   `worktree/cleanup` record carries `sessionId`, `path` and `cleanup` only; it
   has no session header. The mount emits `process.cwd()` and reports the
   `cwd` gap, so `cwd` and `worktree_path` remain two distinct classic fields.
   It does not read the removed checkout into `cwd`.
3. **Three translations are one value each.** `TaskCompleted` takes
   `teammate_name` from `task.ownerName`; `WorktreeCreate` takes `name` from
   `branch`; `StopFailure` takes `error_details` from the host failure
   message. No value is synthesized from a different concept.
4. **The double emitters are named.** `WorktreeRemove` emits a `scheduled`
   intent and a settled `removed` record; `StopFailure` emits an error-shaped
   `turn/end` record and an `agent/error` emit. Those are the two cases D70
   rule 2 dedupes.
5. **Evidence.** `spikes/s23-unprobed-events/run.mjs` located the emitters and
   their fields at the pin. `packages/dsh-anyplugin-conformance/test/lifecycle.test.mjs`
   drives real team, worktree and failing-turn paths (root and child) on
   `fixtures/claude-hooks-seams` and asserts one line per event, the exact
   payload key sets, and `cwd !== worktree_path`. The materializer's
   `packages/dsh-anyplugin-materialize-hook/test/lifecycle.test.mjs` pins the
   dedupe keys and gap warnings; its mutation set (drop `turn`, drop
   `cleanup.revision`, force `isRootSession`, drop the gap calls, set `cwd` to
   the removed path) turns a named test red.

## D73 — The integration runner is a worker, and F18's alarm is per window

**Decided 2026-11-22** (#199, audit finding F18). The daily audit's role check
found the root session at 2,991 tool calls (1,112 inside the 1-day window) and
proposed splitting merge mechanics into a dedicated integrator session that
would itself merge. Two facts make that shape wrong here.

1. **Merge authority stays with the master.** The guard refuses `gh pr merge`
   to every worker (`isWorker` is `origin === 'subagent' || parentSession !== undefined`,
   `packages/dsh-anyplugin-guard/src/index.ts:64`), and that is the rule D66
   hardened. Teaching it a third identity would be a privilege widening, and a
   child session that merges is exactly what the pin rule exists to prevent.
   An "integrator" that cannot merge is the only shape consistent with the
   guard.
2. **The expensive part of integration is waiting, not merging.** A merge
   cycle in the root is twelve CI polls plus a branch update plus one pinned
   `gh pr merge`; the merge call itself is one. So the split is: an
   **integration runner** child (`integrator-*`) owns CI polling, `origin/main`
   merges into the ticket branch, push to the ticket branch, PR-body assembly
   and worktree cleanup; the master issues the single pinned merge call after
   the runner reports a green head. The guard needs no change: every action the
   runner takes is already a worker-allowed action.

The alarm is then read the way the evidence is reported. A lifetime count
measures how long a root has lived, not how much it did; a lead session that
runs for a month will always exceed 1,500. The master alarm is evaluated on the
window the pass reports (**~1,500 tool calls in the window**, 1 day for the
daily pass), while the lifetime number stays printed in the evidence and in
`## Findings`. A pass that flags either number must still name the remedy; the
runner is the remedy for integration volume and the audit's own session is the
remedy for audit volume.

**Evidence.** `docs/audits/2026-11-22.md` and `.audit/evidence-2026-11-22.json`
(report output, gitignored) carry both counts; #199 carries the proposal this
entry amends; `docs/AUDIT.md` §7 carries the role table.

---

## D74 — F2 is `planned`: the theme seam stops at CSS aliases and the ANSI 16 are the host gap

**Decided 2026-11-22** (#216, S24). The last open question in
`ARCHITECTURE.md` §0's F2 row was whether a plugin — not the host bootstrap —
can register a terminal palette and express every colour in a Claude
`themes/<slug>.json`. S24 answers it at `0.2.2-rc.2` and `0.2.2-rc.5`: the
plugin seam is real but partial, and the terminal's ANSI 16 remain outside it.
F2 is a scheduled slot, not an `unsupported` surface.

1. **The plugin theme seam is real, and it is alias CSS.** The pinned theme
   package's README documents “A composition can register a third-party theme
   id with alias-token overrides through `ctx.theme`”; `ThemeRuntime.register`
   accepts a `ThemeDefinition` and `apply` provides the service.
   `ThemeTokens` is `Record<string, string>`; the 14 inspector tokens are a
   curated list, not a registration limit. `ThemeDefinition.tokens` are
   “Alias-layer overrides applied as inline CSS variables over the base
   palette”. The S24 runtime probe registers a theme including a new
   `--dsw-alias-s24-probe` token, activates it, and reads the CSS tokens back
   from the active snapshot.
2. **Two of Claude's 72 roles reach the terminal through that seam.**
   `text` maps to `--dsw-alias-label-primary` and `background` to
   `--dsw-alias-bg-base`. `dsh-client-ui-layout/src/client/theme-presenter.ts:85-89`
   writes every active token to `document.body`;
   `dsh-client-ui-sidebar-terminal/src/client/terminal.module.css:1-4` consumes
   the two aliases; `terminal.tsx:142` passes the computed
   `style.backgroundColor`/`style.color` to xterm. That is a real, observable
   destination for 2 of 72 roles.
3. **The terminal has no ANSI-16 palette input; that is the named host gap.**
   The anchor is
   `@deepseek-ai/dsh-client-ui-sidebar-terminal/src/client/terminal-theme.ts:57-64`:
   `update(background: string, foreground: string)` sets only background,
   foreground, cursor, cursor-accent and selection fields. ANSI 16 are written
   only from `this.indexed` (`:72-79`), which only the xterm OSC 4 handler
   fills and OSC 104 clears/deletes. The other 70 roles have no DSH terminal
   counterpart, and `ansi:<name>`/`ansi256(n)` values have no host palette.
   There is no direct ANSI-16/palette output API; the only palette writer is
   OSC 4/104. F2 cannot be complete until DSH exposes a palette channel, or a
   decision formally removes this sub-surface from the declared set.
4. **The class is `planned`; no `unsupported` or `derived` escape.**
   `readOptionalSurfaces` keeps `themes` as one `planned` row, with
   `THEME_REASON` naming the 2-role mapping, the 70 unserved roles, the
   `ansi:*` values with no host palette, and the OSC-only ANSI 16. The row
   stays one row; it is not split per sub-surface. The v0.4 roadmap keeps the
   F2 slot, narrowed to mapping the two alias roles while the ANSI-16 host gap
   remains. `engines.dsh` stays `"0.2.2-rc.2 || 0.2.2-rc.5"`: both pins have
   the same partial seam and no version-specific channel, so there is nothing
   to gate on.
5. **No fixture, no materializer yet.** The pinned CLI has no non-interactive
   `theme` command or `--theme` flag; `/theme` is TUI-only. No
   `themes/<slug>.json` was captured or invented. A fixture and a materializer
   follow when the terminal exposes a palette; a captured file alone would
   reach only the two CSS roles.

**Consequences.** F2 stays outside the 100 % statement as a `planned` row, and
the declared surface does not count the 70 unserved roles as matched. The
roadmap keeps the F2 slot, and `docs/FEATURES.md` §7 names the partial seam and
the ANSI-16 anchor. The dialect test pins the `planned` class and the 2/70/ANSI
reason. The ANSI-16 half is the named host gap and the GA condition: F2 becomes
complete only when DSH exposes a palette channel or a decision formally removes
that sub-surface from the declared set. A future plugin-writable palette must
reopen this decision rather than silently turning F2 into `complete`.

**Evidence.** `spikes/s24-theme-seam/run.mjs` (65 assertions, both pins) and
`spikes/s24-theme-seam/README.md`; CI runs `npm run spike:s24` at rc.5 and
rc.2. The spike enumerates the real theme bundle's exports/prototype, executes
the real `TerminalTheme` with a fake xterm parser, reads the layout presenter
and terminal CSS, and checks the pinned Claude binary's six bases and 72 roles.
It exits non-zero on a palette mutation: a `registerTerminalPalette` prototype
member reddens two assertions, and a `palette` field plus ANSI write reddens
four. `scripts/fetch-harness.mjs` now includes `dsh-client-ui-theme`,
`dsh-client-ui-layout` and `dsh-client-ui-sidebar-terminal` for S24.

---

## D75 — F2's closure condition is not a GA condition, and the two halves close separately

**Decided 2026-11-22** (#218 review). D74's consequences call the ANSI-16
half "the named host gap and the GA condition". That reading is wrong on the
contract's own terms and is corrected here:

1. **It is not a GA condition.** §0.2's GA condition is an empty
   `unsupported` set. F2 is `planned` and sits outside the 100 % statement
   (§0.3), and D74 adds no `unsupported` row, so F2 neither blocks nor unblocks
   GA. The sentence is "the condition for F2 to become complete", not a GA
   gate.
2. **The two halves close on different work.** The two alias roles
   (`text` → `--dsw-alias-label-primary`, `background` → `--dsw-alias-bg-base`)
   need a captured `themes/` fixture and a materializer, and that work does not
   depend on the ANSI-16 gap — it is the v0.4 F2 slot. The other 70 roles and
   the 16 ANSI slots need a host palette channel, or a decision that formally
   removes that sub-surface from the declared surface. Waiting for the palette
   before carrying the two mapped roles would stall work the host can already
   hold.
3. **The spike grew to 68 assertions.** A plugin never constructs the runtime
   itself; it receives whatever `apply()` provided, so prototype and own-key
   checks miss a member attached to the instance after `ctx.provide`. The spike
   now inspects the real `apply()` body: it must provide the constructed
   runtime itself, add no member to it, and name no palette/ANSI API. A
   service-level `theme.registerTerminalPalette = …` mutation now exits 1 with
   two failures.

D74's class, anchors and evidence stand; only the GA framing and the ordering
of the remaining work are superseded.

---

## D77 — One package, one install: the panel ships inside `dsh-anyplugin`

**Decided 2026-11-22**, with `#224` (from `#170`). Supersedes D61's
"separately published optional package" sentence and D62 item 1 plus the parts
of D62's consequences about a second bundle, a second `cordis.patch.yml`, the
`check:ui` 64 KiB ceiling, and the `packages/dsh-anyplugin-ui/test/mutations.mjs`
path. D62 items 2–5 stand unchanged.

The maintainer rejected the two-package split: a user who installs
`dsh-anyplugin` must get the panel. The panel was never separately publishable
anyway (D62 made it `private`), and its 64 KiB budget only existed because the
root tarball was capped for the kernel, not because the panel needed its own
artifact.

**Decided.**

1. **One artifact, one version.** The panel is internal source of the install
   package, not a package: `packages/dsh-anyplugin-install/src/panel.ts` is the
   server half and `packages/dsh-anyplugin-install/src/client/panel.js` is the
   browser half. `scripts/build.mjs` bundles the server half into `lib/index.js`
   and emits the browser half as `lib/client.js`. There is no
   `dsh-anyplugin-ui` manifest, version, patch file, tarball, publish step or
   workspace entry.
2. **One row, one client row.** `cordis.patch.yml` still inserts exactly one
   loader row, `id: dsh-anyplugin`. The root manifest declares
   `dsh.client = { platform: "web" }` and `exports["./client"]`, and the bundle
   registers itself as `dsh-anyplugin`. This is forced by the host:
   dsh-client-modules keys graph rows by the manifest name and refuses two
   active Loader sources for one package, while a subpath-shaped loader name
   composes no client row at all. The controller mounts the panel with
   `ctx.inject(['webServer'], …)` *before* the missing-lock early return, so a
   fresh profile can install its first plugin from the panel; a profile with no
   web server simply leaves the child inactive.
3. **The ceiling is a build constraint owned by `check:pack`.** The root
   tarball ceiling in `scripts/check-pack.mjs` covers both halves. `check:pack`
   asserts the `dsh.client` declaration, `exports["./client"]`, the presence of
   `lib/client.js`, its `window.__ModuleLoader__.load({ id: 'dsh-anyplugin' })`
   registration and `settings.section`, the `/anyplugin/installs` route in
   `lib/index.js`, and that no shipped file still names `dsh-anyplugin-ui`.
   `pack:ui`/`check:ui` do not exist; the publish workflow publishes one
   package. This decision authorizes raising the root ceiling for the panel;
   the measured byte count lives in the `check-pack` comment and in PR `#224`,
   not in this entry, so the number cannot drift from the script. Any future
   raise still needs its own decision — D62's "a ceiling is not raised to fit a
   feature" rule stands for everything except this moved boundary.
4. **The install writer is unchanged.** The panel still reaches
   `dsh-anyplugin/install` (D61) through the package's own exports map and never
   becomes a second writer over `installs.yml`. The mutation audit moves to
   `packages/dsh-anyplugin-install/test/panel-mutations.mjs`; its eleven
   single-property breaks still have to redden `test/panel.test.mjs`.

**Why.** One install is the product claim; a second package made the panel an
opt-in artifact with its own release problem, while the host gives exactly one
client row per package name. The two halves already shared one install writer,
one lock and one test box, so the package boundary bought nothing the tarball
ceiling could not express.

**Consequences.** `npm pack` on the root package now carries the panel entry
and its assets; the tarball is larger by the measured amount in
`docs/ARCHITECTURE.md` §2. The panel cannot be updated independently of the
loader — the bundle id *is* the package name — so panel changes are package
changes. A future external panel would have to be a different package with a
different row id, not a second install of this one.

## D81 — The panel's pack gate proves the server, and D61's subpath clause

D77 shipped the panel inside `dsh-anyplugin`, and the review found the pack gate
proving less than the decision said. Three corrections, ratified separately
because D77 is append-only:

1. **The route check reads server chunks only.** `check:pack` joined every
   `lib/` file, so `lib/client.js`'s own `/anyplugin/installs` fetch satisfied
   the "the server serves the panel" assertion even with the server route
   deleted. The check now excludes the client bundle (`lib/client.js` and any
   `lib/client-*`/`lib/client/` chunk), requires the server's route-registration
   label, and still requires the `dsh-anyplugin/install` reference. The client
   half stays proven by its own assertions (`dsh.client`, the bundle's
   registration id, `settings.section`).
2. **D61's "no other subpath is added" sentence is superseded as far as
   `exports["./client"]`.** That subpath is the client half of the same
   package, not a second bundle; D61's other guarantees (path-only install
   input, loopback-only serving, no foreign code imported by the server) stand.
3. **The code and the manifest are scanned, and the size is printed in bytes.**
   `check:pack` looks for the removed `dsh-anyplugin-ui` name in every `lib/`
   file and in the packed manifest, and prints the tarball size in bytes next to
   the KiB reading, so D77's "the measured byte count lives in the script" is a
   fact a reader can check without a failing run. `INSTALL.md` keeps one mention
   on purpose: it tells a development profile that linked the old bundle to
   remove that entry, which is the opposite of a stale id.

Evidence: `scripts/check-pack.mjs` (the `isClient` exclusion, the whole-tree
scan, `notes.push` with bytes); `packages/dsh-anyplugin-install/test/panel.test.mjs`
now states what the mount test proves (the controller asks for `webServer` and
the panel registers both routes in the pin's documented `register` shape; no
test boots a real web server).

---

## D80 — The guard is scoped to this checkout and its ticket worktrees

The guard is installed into a *user* profile, so DSH loads it for every session
on the machine. `#221` named the consequence: the maintainer opened an
unrelated project and the guard denied it. A layer that polices the whole host
is not a layer anyone keeps installed.

1. **Territory, not configuration.** The scope is derived from what the
   installer already composes: `protectedRoots` (this checkout; the `.git`
   entry is a write target, not a session cwd), `worktrees` (exact ticket
   paths, or `<stem>-*` namespaces) and `gitDirectories` (the common dir).
   Any *working tree of this repository* is inside the territory — a review or
   verify worktree as much as a ticket one — because its `.git` points into
   that common dir, and a directory inside a working tree is inside that tree
   (a subdirectory has no .git of its own; the nearest one above it decides).
   Write permission stays the ticket list: a review tree is judged and
   unwritable. A fresh install with no ticket worktree writes the
   documented namespace (`$ANYPLUGIN_WORKTREE_ROOT/ticket-*`, default
   `/tmp/anyplugin-wt/ticket-*`) so the first worktree needs no reinstall.
2. **Inert outside.** For a session whose canonical `header.cwd` is outside
   the territory, both seams call `next()` before judging: no denial, no brief,
   no denial record. A symlink is resolved first, so a link into the checkout is
   the checkout, and a relative `gitdir:` pointer resolves against the
   working tree's own directory (git 2.56 `--relative-paths`). Delegation is
   not modelled: a child started with a chosen
   `cwd` is judged by that path, and a child pointed outside is outside. The guard does not *observe* other projects either — a
   dormant mechanism that still logs is a surveillance tool, not a guard.
3. **Unknown cwd is outside.** With a territory configured, a session without
   `header.cwd` is treated as outside rather than guessed at: the guard's own
   view of a session is one path from the pin, and inventing a default would
   police whatever directory the host happened to start in. An *unconfigured*
   policy (a hand-written config, a unit test) keeps the previous global
   behaviour, because silently switching an unconfigured guard off is the worse
   failure.
4. **Workers stay governed.** The worktree pattern is matched segment-wise
   (`/tmp/anyplugin-wt/ticket-*` covers `/tmp/anyplugin-wt/ticket-225/…`, not
   `/tmp/anyplugin-wt/notes`), and a worker whose cwd is a ticket worktree is
   judged even though that path is outside the checkout.

Evidence: `packages/dsh-anyplugin-guard/src/scope.ts` (unit table in
`test/scope.test.mjs`), and two apply-level tests — one session outside the
territory is accepted with no brief and no record, one inside a real ticket
worktree is denied and recorded.
