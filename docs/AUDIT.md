# AUDIT.md — auditing the agent process, not just the product

`npm run verify` answers "is the code what it claims?". This file answers a
different question: **is the process that produces the code learning from its
own mistakes?**

The repository is built by agents. Agents repeat mistakes unless the
environment makes the mistake hard: a hook that refuses the command, a gate
that fails the PR, a skill line that names the trap, or a reviewer who asks for
the missing evidence. An error that is only discussed is an error that returns.

This audit exists because that loop had no owner. It is deliberately small: one
daily pass over evidence, one ledger, independent reviewers, and a gate so the
audit itself cannot rot. It does not replace review; it looks for the *pattern*
behind review comments.

## 1. What is audited

Five surfaces, in this order of value:

1. **Prevention mechanisms** — hooks, lint, CI gates, skills, reviewer briefs.
   Does each one exist, fire, and teach? Is it installed on this machine?
2. **Roles** — is any role too broad or over-permissioned? The master plans,
   integrates, reviews and merges; a worker owns one ticket; a reviewer is
   read-only. The audit asks whether a session exceeds its role, not whether
   the role sounds reasonable.
3. **Commands** — what agents actually type. Repeated commands are either
   missing tooling (turn them into a script), missing skill lines (turn them
   into instructions), or waste (`cd <dir> &&` prefixed to 86 % of bash calls
   in the 2026-11-22 baseline: the harness already has `workdir`).
4. **Work quality** — claims stronger than their proof, docs promising more
   than the code does, silently dropped inputs. These are the errors review
   finds one PR at a time; the audit looks for the recurring shape.
5. **The audit itself** — if a finding's mechanism never fires, or the audit
   only produces prose, it is a finding too. §9 is the gate; §10 is the limit.

## 2. Cadence

| When | What | Where |
| --- | --- | --- |
| daily, 09:00 America/Los_Angeles | the full pass in §4, one report and its PR | `docs/audits/YYYY-MM-DD.md` |
| weekly (the Monday pass) | mechanism effectiveness: mutate one enforced rule and confirm the gate fails | same report, `## Actions` |
| on demand | after an incident (a bad merge, a regression, a review that found a pattern), or when a human asks | same |
| monthly | retire/refresh ledger entries; split the schedule if §8 says so | `docs/AUDIT.md` |

A missed day is not backfilled with a fabricated report. The next pass uses the
window since the last report and says so in `## Evidence` (the digest prints
the window; the auditor passes `--days N` and records `N`). The schedule lives
outside the repository (`~/.dsh/storages/schedule.json`); the digest prints its
rrule, target and last delivery. A fresh checkout recreates it with
`schedule_create` (daily 09:00 `America/Los_Angeles`, `new_once`, main
checkout; the prompt carries the full step list from the audit skill §2,
including "always write the report and open a PR" and the Monday mutation
check), then confirms the task appears in the next digest.

Every pass publishes its report as a pull request. There is no side branch or
comment-only channel for a daily report: the PR is what the review and merge
process sees, and a finding that is not in that PR did not enter the process.
The report-only PR goes through the same review and merge path as any other
change; "report-only" changes what the PR contains, not whether it is reviewed.

## 3. Evidence

```bash
npm run audit:evidence -- --days 1 --github
```

`scripts/audit-evidence.mjs` is deterministic and read-only. It writes
`.audit/evidence-<date>.json` (gitignored) and prints a digest. It reads:

- git: branch, head, recent commits, worktrees;
- decisions, feature rows, TODO open items, gates and test entry points;
- session transcripts under `~/.dsh/sessions/--<repo>--/`, streamed (never
  buffered: one session can exceed 1 MB);
- guard status (`scripts/guard-status.mjs`), schedules, and — with `--github` —
  the PR/issue queue through `scripts/gh-bot.mjs`.

The JSON is the record; the report quotes it. A claim in the report must be
traceable to a field or a transcript sample. "Felt slow" is not evidence.

Transcripts are local machine state. They are never committed. A report may
quote a command, a rule name, or a count; it may not paste a transcript line
that contains a token, an email, or a customer path.

## 4. The daily pass

1. **Read the previous report's `## Open`** and the ledger's `open` entries.
   The first job of a pass is to check whether last pass's actions happened.
2. Run the evidence script for the window since the previous report.
3. Check the three recurring shapes against the window:
   - **claim > proof** — a PR body or comment asserting behavior its test does
     not observe;
   - **doc > code** — a doc saying "refuses", "never", "zero-write" where the
     code falls through;
   - **silent drop** — a field, matcher, result, or error that is accepted and
     not forwarded.
4. Check mechanisms: did any gate fail? Did a hook fire? Is the guard still
   installed? Is the schedule still running? A mechanism that is installed but
   never fires is either unnecessary or broken; say which.
5. Check roles: the eight largest sessions, their `cwd`, the root/child ratio,
   and whether a session wrote outside its role. Flag every root session above
   the ~1,500 cap and name the split (a scheduled audit, an integrator, a
   narrower ticket). F18 is the recorded miss.
6. Write the report (§5), add or update ledger entries, run `npm run
   check:audit`, and open the PR in the same pass. A report-only PR is docs; a
   PR that changes a mechanism also carries the code and its test. Every
   finding gets an action in this pass: the fix in the PR, a tracking issue, or
   an explicit accepted risk with an owner and a review date. A finding with no
   action is a plan, not a finding; it does not become next pass's backlog.
7. Open the PR and hand it to the master. The review path in §6 belongs to the
   master; the auditor's part ends at the PR.

The daily pass may write `docs/AUDIT.md`, `docs/audits/`, the audit skill,
audit tooling (`scripts/audit-*`, `scripts/check-audit*`), and a gate or test
that is the finding's fix. It does not push to a ticket branch, does not
approve or merge its own PR, and does not edit a feature file. A finding that
needs product code gets an issue or a separate worker.

## 5. The report

`docs/audits/YYYY-MM-DD.md`, with exactly these headings (the gate checks them):

```markdown
# Audit YYYY-MM-DD

## Evidence
window, commands run, what was read; numbers from the evidence JSON.

## Findings
F<n> — one line, then what was observed, with a path or a count.

## Actions
what changed in this pass, with the finding id. An issue or PR opened in the
same pass is an action; "investigate later" is not.

## Open
only findings that are genuinely blocked or deferred, each with a tracking
issue, an owner, and the condition that reopens it. `Open` is not a backlog.
```

A report is not a diary. If nothing new was found, the report says which
mechanisms were re-checked and which numbers moved; "no findings" is only
credible with evidence.

## 6. Independent reviewers

The audit author is also an agent, and an agent reviewing its own mechanism is
the failure mode this repository already knows (`docs/WORKFLOW.md`: the master
may not review its own feature code). For any change to a **mechanism** — a
hook, a gate, a skill that changes behavior, this file's ledger schema — run two
reviewers before the PR:

```text
subagent { agent_preset: "readonly", description: "review audit mechanism", prompt: <brief> }
```

If the tool instance rejects `agent_preset` ("selection is disabled for this
tool instance"), run two plain subagents whose brief says **read-only**: do not
edit, do not push, do not install. Record in the report which form was used; a
reviewer that *could* write is a weaker independence claim, not the same one.

The brief is the same for both, and it is adversarial:

- Give the diff and the repository rules (`AGENTS.md` §3, `docs/WORKFLOW.md`
  review rubric), **not** the author's conclusion.
- Ask for a table: `Claim | Proof | Verdict` where `Verdict` is `proven`,
  `weaker`, or `not proven`.
- Ask specifically: where does this mechanism fail open? What does it claim to
  prevent that it cannot see? Which test would still pass if the behavior were
  removed?
- Require `file:line` citations. A reviewer that returns "looks good" has not
  reviewed.

At least one reviewer must not have worked on the change. The reviewers are
read-only; their output is a comment on the PR, not an edit. The author
addresses each `weaker`/`not proven` verdict in the PR body: either the proof
improves or the claim shrinks.

### Reviewer brief: claims (`#reviewer-brief-claims`)

Use this for a normal PR, not only a mechanism change. Paste it into the
reviewer's prompt with the diff:

```text
You are reviewing a PR in dsh-anyplugin. Do not edit files.
Read AGENTS.md §3 (non-negotiables) and docs/WORKFLOW.md (review rubric).
For each behavioral claim in the PR body, commit messages, and changed docs:
1. Find the assertion that would fail if the claim were false.
2. If there is none, verdict "not proven"; if the assertion tests a weaker
   property than the claim, verdict "weaker".
3. Check whether a doc now promises more than the code does ("refuses",
   "never", "always", "zero-write", "atomic").
4. Check for silently dropped inputs: an accepted field, matcher, result, or
   error that is not forwarded.
Return a table Claim | Proof file:line | Verdict | Why, then a short list of
the highest-risk gaps. Cite file:line for every row.
```

### Reviewer independence (`#independent-reviewers`)

- Two reviewers for a mechanism change, one for a normal PR.
- Neither reviewer is the author. At least one has not touched the change.
- The reviewers get the same brief; disagreement is signal, not noise.
- A reviewer verdict is a PR comment from the bot account, with the
  `<!-- dsh-anyplugin-agent -->` marker; it is not a GitHub review. F12's
  guard rule requires `--match-head-commit <40-hex>` on every modelled merge
  (`--help` and `--disable-auto` perform none); that is omission prevention, not review verification, and it is
  dormant on this machine until the guard is installed (F1).

## 7. Roles, and what "too broad" means

`docs/WORKFLOW.md` already says the master may not write feature code. The audit
adds measurable caps:

| Role | May write | May not | Alarm |
| --- | --- | --- | --- |
| master | docs, integration fixes, `docs/DECISIONS.md`, merges after the §6 verdicts with a pinned head (dormant until the guard is installed, F1) | feature code; merging with unresolved `weaker`/`not proven` verdicts | a root session over ~1,500 tool calls, or one that both authors and approves the same change |
| integration runner | merges `origin/main` into a ticket branch, pushes that branch, polls CI, assembles PR bodies, cleans worktrees | merge, approve, push `main`, author feature code, edit another ticket | a runner that merges or approves, or one that touches `main` |
| worker | one ticket's `Touches`, its worktree | merge, push `main`, edit another ticket | a worker touching files outside `Touches`, or two tickets in one session |
| reviewer | nothing (read-only) | edit, merge, approve its own work | a reviewer that returns no `file:line` |
| architecture reviewer | one daily pass reading the design against the tree; finding issues and docs-only PRs | merge, approve or close its own issue/PR, push `main`, feature code, ticket branches, `docs/DECISIONS.md`, `docs/FEATURES.md` coverage rows or totals, a contract change in `docs/ARCHITECTURE.md` §0/§2/§7 without a decision | an issue without file:line at a commit; a run that edits code, merges, or moves coverage/contract |
| auditor | audit tooling, process docs, the audit skill, and a gate/test that is the finding's fix; issues and PRs | feature code, ticket branches, `docs/DECISIONS.md`, approve, merge, close an issue or PR; it proposes a decision and the master writes it | an audit PR the auditor approved, merged, or closed itself |

The auditor's "no approve, no merge, no close" rule is a convention first: the
auditor opens the issue or PR, comments with evidence, and hands it to the
master's review and merge path. It does not close the issue it filed, approve
its own PR, or merge the PR it authored, even after the fix lands.
Permission-layer enforcement (branch protection, the `gh-bot` allowlist, and a
separate merger identity) is deliberately deferred; until it lands this is
conventional behavior, not a guard check, and a report must say so if it relied
on the convention.

The caps are heuristics, not gates. The evidence script reports the eight
largest sessions with their `cwd`; a pass that sees a root session above the
cap says so in `## Findings` and proposes a split (a scheduled audit session, a
narrower ticket, or an integration runner that polls CI and updates branches —
never a session that merges; merge authority with the pinned head stays in the
master, D73). The master alarm is evaluated on the window the pass reports
(one day for the daily pass); the lifetime count stays printed but is context,
not the verdict: a lead that runs for a month always exceeds a lifetime cap.

## 8. Splitting the audit

One daily pass is enough while a report fits in ~10 findings and the evidence
script runs in under a minute. Split when one of these is true:

- the pass cannot finish reading the previous `## Open` plus the new window;
- two consecutive reports have findings in disjoint areas (e.g. rig vs.
  process) and each needs a different evidence source;
- the audit starts editing code to make its own findings true.

A split is a new scheduled task with a narrow brief and its own report prefix
(`docs/audits/rig-YYYY-MM-DD.md`); the ledger stays single so a finding cannot
hide in a second schedule. This is a decision to record in `docs/DECISIONS.md`
if it changes who may merge.

## 9. The audit's own gate

`npm run check:audit` (wired into `verify`) checks:

- the ledger block parses, has version 1, and every entry has the required
  fields and a known mechanism/status;
- every `artifact`/`proof` path is a **file** (an anchored path checks the
  file, not the anchor), `proof` is not the artifact itself, and a
  `enforced`/`dormant` proof is a `.test.mjs` file;
- `enforced` has a machine mechanism (hook/ci/lint); `dormant` has the same
  proof but says it is not installed; `open` has a tracking issue; ids are
  unique and `F<number>`; docs cannot be `enforced`;
- the identity fields (`id`, `title`, `mechanism`, `artifact`) are pinned in
  `docs/audit.lock.json`: a new finding needs `--update`, and a locked finding
  cannot be deleted or renamed in place (retire it and add a new one);
- at least one report exists (`YYYY-MM-DD.md` or `rig-YYYY-MM-DD.md`), each
  required heading is a real heading with a body (not inside a fence), every
  finding id in a report is in the ledger, no report is dated in the future, and
  the ledger's `updated` date is not older than the latest report.

It does **not** check that the mechanism works. That is the reviewer's job and
the weekly mutation check. A green `check:audit` means the ledger is honest
about its own shape, not that the process is fixed.

## 10. Limits

- Transcripts are this machine's. A CI-only agent cannot reproduce them.
- GitHub evidence needs the bot token; without it the pass uses git only and
  says so.
- The audit cannot see a human's intent. A finding that depends on one is
  `open` with a `maintainer-question` issue, not a silent assumption.
- The audit does not enforce itself: the daily schedule is a task, not a hook.
  If it stops, the ledger's `open` entries are what a human reads first.
- A mechanism can be green and useless. The weekly mutation check is the only
  defense; a pass that skips it says so.

## 11. Ledger

Append-only history: an entry is never deleted. A mechanism that is replaced
gets `status: "retired"` and a new entry; a finding that is no longer true is
retired with the reason in `rationale`, not removed. `reviewed` means a
recorded check exists; a mechanism change needs two independent verdicts, while
a schedule that only reports status is reviewed by the daily pass. `documented`
means prose only. `dormant` means the mechanism is implemented and tested but
not active on this machine (F1); it is not a synonym for `enforced`. The
`updated` date moves on every edit.

<!-- audit-ledger:start -->
```json
{
  "version": 1,
  "updated": "2026-11-22",
  "entries": [
    {
      "id": "F1",
      "title": "A push to main is refused by the guard's push whitelist",
      "mechanism": "hook",
      "status": "dormant",
      "artifact": "packages/dsh-anyplugin-guard/src/policy.ts",
      "rationale": "The most expensive single mistake is a direct push to main. The rule is tested against nine push shapes, including force and multi-refspec, and applies to root and worker sessions. On 2026-11-22 the guard was implemented but not installed (no pre-push hook), so the rule is dormant, not enforced; F2 watches the installation.",
      "evidence": [
        "D47 authority table",
        "guard.test.mjs push matrix",
        "2026-11-22 guard:status not-installed"
      ],
      "proof": "packages/dsh-anyplugin-guard/test/guard.test.mjs"
    },
    {
      "id": "F2",
      "title": "The guard can be dormant without anyone noticing",
      "mechanism": "schedule",
      "status": "reviewed",
      "artifact": "scripts/audit-evidence.mjs",
      "rationale": "On 2026-11-22 the guard reported not-installed, its pre-push hook was missing, and 23 worktrees were stale. A daily digest reports guard status so dormancy is visible the next morning; installing it remains an operator action, so this is reviewed, not enforced.",
      "evidence": [
        "2026-11-22 evidence: guard not-installed, pre-push missing, 23 worktrees",
        "docs/audits/2026-11-22.md"
      ],
      "proof": ".dsh/skills/dsh-anyplugin-audit/SKILL.md"
    },
    {
      "id": "F3",
      "title": "A ratified decision is edited in place",
      "mechanism": "ci",
      "status": "enforced",
      "artifact": "scripts/check-decisions.mjs",
      "rationale": "Each entry is hashed into docs/decisions.lock.json; a changed hash fails verify and the only accepted move is a new superseding entry.",
      "evidence": [
        "docs/decisions.lock.json",
        "WORKFLOW review rubric: decisions are append-only",
        "check-decisions.test.mjs edited/duplicate/new cases"
      ],
      "proof": "scripts/check-decisions.test.mjs"
    },
    {
      "id": "F4",
      "title": "Two decisions share an id",
      "mechanism": "ci",
      "status": "enforced",
      "artifact": "scripts/check-decisions.mjs",
      "rationale": "Parallel workers picked the same next number for D51/D52/D53 and again for D59/D60. The append-only hash does not catch an id collision, so the gate now rejects duplicate ids before the report is written.",
      "evidence": [
        "2026-11-22 baseline: 62 ids, 0 duplicates",
        "PR #89/#120 decision renumbering comments",
        "check-decisions.test.mjs duplicate case"
      ],
      "proof": "scripts/check-decisions.test.mjs"
    },
    {
      "id": "F5",
      "title": "A claim is stronger than the test that proves it",
      "mechanism": "reviewer",
      "status": "reviewed",
      "artifact": "docs/AUDIT.md#reviewer-brief-claims",
      "rationale": "A test can execute the happy path while the PR promises a contract (accepted callable, refused before apply, atomic). The reviewer brief asks for the assertion that would fail if the claim were false, and for the claim to shrink when the proof is weaker.",
      "evidence": [
        "PR #89 review: callable accepted but promise not tested",
        "S19 verdict 'too strong'",
        "2026-11-22 PR comment scan"
      ]
    },
    {
      "id": "F6",
      "title": "A doc promises behavior the code does not have, or an input is silently dropped",
      "mechanism": "reviewer",
      "status": "reviewed",
      "artifact": "docs/AUDIT.md#reviewer-brief-claims",
      "rationale": "The recurring shapes are 'refuses before apply' where the code falls through, and accepted fields (updatedInput, toolResults, matcher, next(e)) that are not forwarded. Both are cheap to see in review and expensive to find in production, so the brief names them explicitly.",
      "evidence": [
        "2026-11-22 evidence: 36 tool errors across 121 sessions",
        "PR #120 mods install",
        "2026-11-22 evidence: 33 tool errors across 118 sessions"
      ]
    },
    {
      "id": "F7",
      "title": "A count claim is bound to an owner that does not own it",
      "mechanism": "ci",
      "status": "enforced",
      "artifact": "scripts/check-features.mjs",
      "rationale": "A coverage row can name the right number and the wrong owner family. R15 requires the count claim to be bound to its owner, so the row cannot drift while the gate stays green.",
      "evidence": [
        "check-features R15",
        "PR #154",
        "gate-rules.test.mjs R15 counter-examples",
        "features-rules.test.mjs gate call-site"
      ],
      "proof": "packages/dsh-anyplugin-conformance/test/gate-rules.test.mjs"
    },
    {
      "id": "F8",
      "title": "A fixture row or fixture directory disappears from the ratchet",
      "mechanism": "ci",
      "status": "enforced",
      "artifact": "scripts/check-architecture.mjs",
      "rationale": "R14 rejects an orphan fixture directory and a fixture row whose directory is missing. It does not count fixtures, so deleting a fixture and its row together would pass; F8 covers the orphan/missing-row half and does not claim a full count ratchet.",
      "evidence": [
        "check-architecture R14",
        "fixture-ratchet.mjs counter-examples",
        "architecture-rules.test.mjs orphan-fixture case"
      ],
      "proof": "scripts/architecture-rules.test.mjs"
    },
    {
      "id": "F9",
      "title": "A fidelity claim does not name a pin",
      "mechanism": "ci",
      "status": "enforced",
      "artifact": "scripts/check-architecture.mjs",
      "rationale": "R12 requires the literal claude-code.d.ts:<line> (pin <version>) label on the cited line. It checks that the pin is named, not that the line resolves or that the fetched type surface contains it, so an invented line with a real pin still passes; F9 records the naming half.",
      "evidence": [
        "check-architecture R12",
        "architecture-pin-labels.test.mjs pin cases"
      ],
      "proof": "packages/dsh-anyplugin-conformance/test/architecture-pin-labels.test.mjs"
    },
    {
      "id": "F10",
      "title": "Emission grows a code-generation path",
      "mechanism": "ci",
      "status": "enforced",
      "artifact": "scripts/check-architecture.mjs",
      "rationale": "R3 forbids eval/new Function/loaded generated JS. Emission is pure data (AGENTS.md §3.3); a generated loader would bypass the trust and scan story, so the gate rejects the shape rather than reviewing it case by case.",
      "evidence": [
        "check-architecture R3",
        "AGENTS.md §3.3",
        "architecture-rules.test.mjs eval case"
      ],
      "proof": "scripts/architecture-rules.test.mjs"
    },
    {
      "id": "F11",
      "title": "A skip hides a missing environment instead of naming it",
      "mechanism": "ci",
      "status": "enforced",
      "artifact": "scripts/check-architecture.mjs",
      "rationale": "A skip without a reason is a silent loss of coverage; in CI a skip is a failure (D22/D24). R13 requires the reason, including the script that would fix the environment.",
      "evidence": [
        "check-architecture R13",
        "D22/D24",
        "architecture-rules.test.mjs literal-skip case"
      ],
      "proof": "scripts/architecture-rules.test.mjs"
    },
    {
      "id": "F12",
      "title": "The master merges a head that was not the head reviewed",
      "mechanism": "hook",
      "status": "dormant",
      "artifact": "packages/dsh-anyplugin-guard/src/policy.ts",
      "tracking": "#163",
      "rationale": "The guard refused gh pr merge only for workers; a master could merge an unpinned head. The rule now requires --match-head-commit <40-hex> for every role, including --auto, and refuses a malformed sha, a pin swallowed by a value flag, a merge hidden behind -R/--repo or a line continuation, and any-method gh api .../merge. --disable-auto is allowed because it performs no merge. Dormant on this machine because the guard is not installed (F1); enforced on the modelled gh merge paths wherever the guard is installed, proven by guard.test.mjs. A merge through an unmodelled client remains a residual outside the guard, including a pre-existing git/client-side alias, which root may run.",
      "evidence": [
        "2026-11-22 evidence: 100 PRs, 99 merged; #89 11 comments",
        "guard:status not-installed; pre-push hook missing (F1/F2)",
        "guard.test.mjs merge-pin matrix and installed-mount test; 123-row dry-run table"
      ],
      "proof": "packages/dsh-anyplugin-guard/test/guard.test.mjs"
    },
    {
      "id": "F13",
      "title": "Every bash call repeats a leading cd into the worktree",
      "mechanism": "skill",
      "status": "documented",
      "artifact": ".dsh/skills/dsh-anyplugin-audit/SKILL.md",
      "rationale": "86 % of 25,772 bash calls in the baseline prefix cd <dir> && although the harness has workdir. The skill tells the daily pass and workers to pass workdir instead; this is documentation because a hook cannot see the intent behind a cd.",
      "evidence": [
        "2026-11-22 evidence: 22,111/25,772 cd prefixes; 1,272 workdir"
      ]
    },
    {
      "id": "F14",
      "title": "verify is run many times per session where one gate would do",
      "mechanism": "skill",
      "status": "documented",
      "artifact": ".dsh/skills/dsh-anyplugin-audit/SKILL.md",
      "rationale": "950 npm run verify vs 325 narrow check runs in the window. The skill gives the narrow-first order (check:decisions, check:arch, a single test file) and keeps verify for the pre-push gate; a script cannot know whether the edit touched a gate.",
      "evidence": [
        "2026-11-22 evidence: 950 verify, 325 check:*",
        "AGENTS.md §5 verify is the gate"
      ]
    },
    {
      "id": "F15",
      "title": "Agents use sed/grep/cat on files instead of read/grep tools",
      "mechanism": "skill",
      "status": "documented",
      "artifact": ".dsh/skills/dsh-anyplugin-audit/SKILL.md",
      "rationale": "sed 5,966 and grep 4,951 calls against read 1,148. The shell forms evade the file-access sandbox and the read tool line discipline, and they cost more tokens for the same context. The skill states the tool mapping.",
      "evidence": [
        "2026-11-22 evidence: sed 5,966, grep 4,951, read 1,148"
      ]
    },
    {
      "id": "F16",
      "title": "Guard denials are not observable",
      "mechanism": "hook",
      "status": "dormant",
      "artifact": "packages/dsh-anyplugin-guard/src/policy.ts",
      "proof": "packages/dsh-anyplugin-guard/test/denials.test.mjs",
      "rationale": "Denials used to exist only as DENY text in a tool result, indistinguishable from the guard's own test matrix. Every denial now appends one redacted JSONL record to <checkout>/.audit/guard-denials.jsonl and audit:evidence aggregates it; nothing fails on the log's absence (D68). The code and its test exist (#181, #164), but on this machine the guard is not installed (F1): no pre-push hook, 0 installed worktrees, and no log file. Under §11 that is the definition of dormant, not enforced — the baseline's `enforced` read a merged mechanism as an active one. Activation is tracked by F1, not by a separate ticket.",
      "evidence": [
        "2026-11-22 09:00 evidence: guard not-installed, 1 desired / 0 installed, pre-push missing, no .audit/guard-denials.jsonl",
        "2026-11-22 D68: structured log merged in #181; digest counts total/by-rule/by-role and last five",
        "denials.test.mjs: one record per denial, dedupe by session+callId, four checkout layouts"
      ]
    },
    {
      "id": "F17",
      "title": "The audit grades its own homework",
      "mechanism": "reviewer",
      "status": "reviewed",
      "artifact": "docs/AUDIT.md#independent-reviewers",
      "rationale": "One agent writing the audit, the mechanism, and the verdict is the same self-review failure the workflow forbids for feature code. Mechanism changes get two independent reviewers with an adversarial brief; at least one has not touched the change. The sandboxed `readonly` preset was unavailable in this instance, so the two reviews were read-only by brief, not by sandbox; F17 records that weaker form.",
      "evidence": [
        "2026-11-22 review threads: audit-reviewer-a and audit-reviewer-b",
        "docs/audits/2026-11-22.md F17",
        "AUDIT.md #independent-reviewers"
      ]
    },
    {
      "id": "F18",
      "title": "A root session runs far past the role cap and nothing proposes a split",
      "mechanism": "reviewer",
      "status": "reviewed",
      "artifact": "docs/AUDIT.md",
      "rationale": "The largest root session in the 14-day window ran 2,470 tool calls and the 2026-11-22 pass did not flag it; the cap existed only as prose. The audit role step now compares every largest session against the ~1,500 cap, names the split (a scheduled audit, an integrator, a narrower ticket), and F18 records the miss. The next daily pass found the same root at 2,991 calls (1,112 inside the 1-day window) with the next child at 1,073, so the check fired again and the split is now named in #199: an integrator session owns merge mechanics and PR-body assembly; the root keeps dispatch, decisions, and verdicts.",
      "evidence": [
        "2026-11-22 00:20 evidence: root session-522222a9 2,470 tools, next child 1,073",
        "2026-11-22 09:00 evidence: same root 2,991 lifetime (1,112 in window), next child 1,073; split proposal #199",
        "docs/AUDIT.md §7 role caps"
      ]
    }
  ]
}
```
<!-- audit-ledger:end -->
