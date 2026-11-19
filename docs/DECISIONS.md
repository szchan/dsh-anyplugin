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
