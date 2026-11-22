---
name: dsh-anyplugin-audit
description: Run the daily process audit for dsh-anyplugin — collect evidence, find recurring agent errors, update the finding ledger, and push hooks/lint/CI/skill fixes. Use for the scheduled audit, after a bad merge or regression, or when asked why agents keep making the same mistake.
---

# The dsh-anyplugin process audit

The product gate is `npm run verify`. This skill runs the other gate: **is the
process learning?** The full charter, ledger schema, and role caps are in
`docs/AUDIT.md`; this file is the procedure.

An audit pass produces evidence, at most a few findings, and an action for each.
It is not a diary and not a code sprint.

## 1. Open last pass

Read `docs/audits/` (latest report) and the `open` entries in the
`docs/AUDIT.md` ledger. Each open finding names a tracking issue; check whether
it moved. Last pass's actions are this pass's first question.

Completion: every prior `open` entry is either still open with a note, or closed
with a link to the commit/PR that did it.

## 2. Collect the window

```bash
npm run audit:evidence -- --days 1 --github
```

The script prints a digest and writes `.audit/evidence-<date>.json`. It resolves
the main checkout, streams session transcripts, and reads the queue through the
bot. Read the JSON for the numbers you will quote; the digest is the summary.

Use the window since the previous report, not a fixed day: compare today with
the latest report filename and pass that many days (at least 1). Say the window
in `## Evidence`. If GitHub is unavailable, record that and use git only.

The digest prints the schedule's rrule, target and last delivery. If the daily
task is missing, recreate it: daily 09:00 `America/Los_Angeles`, target
`new_once`, prompt "fetch `origin/main`, create/reuse
`.agents/worktrees/audit-daily`, run the audit skill". Confirm the task in the
next digest.

For PR detail, the digest only counts comments. Read the bodies and comments:

```bash
npm run gh-bot -- pr list --state merged --limit 20
npm run gh-bot -- pr view <n> --comments
npm run gh-bot -- issue view <n> --comments
```

Completion: you can name the window, the session count, the bash count, the
verify/check counts, the guard status, the schedule's last delivery, and the
PR/issue counts.

## 3. Look for the three shapes

For the window, check the shapes that review keeps finding one PR at a time:

- **claim > proof** — a PR body or comment promises a contract; the test
  observes a weaker property.
- **doc > code** — a doc says "refuses", "never", "always", "atomic",
  "zero-write"; the code falls through or the branch is untested.
- **silent drop** — an accepted field, matcher, result, or error is not
  forwarded (`updatedInput`, `toolResults`, `next(e)`, a skipped matcher).

Also check the mechanisms themselves: a gate that failed, a hook that fired, the
guard's install status, the schedule's last run. A mechanism that is installed
and never fires is either unnecessary or broken; say which.

Then check **roles**, which is its own surface (§1.2 of the charter): take the
eight largest sessions with their `cwd`, compare the roots with the ~1,500
tool-call cap, and check the top write paths for a session writing outside its
role. A root over the cap is a finding even when the work succeeded; name the
split (a scheduled audit, an integrator, a narrower ticket).

Completion: each shape is either "no instance in this window" with the search you
ran, or a finding with a path or a count; every root over the cap has a finding
or a recorded "under cap" line.

## 4. Write the report

Create `docs/audits/YYYY-MM-DD.md` with exactly:

```markdown
# Audit YYYY-MM-DD

## Evidence
window; commands read; the numbers.

## Findings
F<n> — title. Observation with path/count. Why it recurs.

## Actions
finding → what changed, or the issue/PR that tracks it.

## Open
each still-open finding and its tracking issue.
```

Number new findings after the highest `F<n>` in the ledger. A finding that
already exists gets its entry updated, not a second id. New ledger entries quote
this report in `evidence`; the report quotes the JSON.

Completion: every sentence in `## Findings` has a path, a count, or a quoted
sample; no sentence relies on memory.

## 5. Update the ledger, then gate it

Edit the JSON block in `docs/AUDIT.md` between the audit-ledger markers:

- `mechanism` ∈ `hook`, `ci`, `lint`, `skill`, `reviewer`, `docs`, `schedule`;
- `status` ∈ `enforced`, `reviewed`, `documented`, `dormant`, `open`, `retired`;
- `artifact`/`proof` are files that exist, and `proof` is not the artifact;
  `open` carries `tracking: "#<issue>"`;
- `enforced` means a hook/ci/lint mechanism with a proof file; a reviewer or a
  schedule is `reviewed`; `dormant` means implemented and tested but not
  installed (F1);
- move `updated` to today; never delete an entry (retire it with the reason).

```bash
npm run check:audit
```

Completion: `check:audit` prints the entry/report counts and exits 0.

## 6. Review a mechanism change

A report-only PR needs no reviewer beyond the normal PR. A change to a hook,
gate, skill that changes behavior, or the ledger schema needs **two** read-only
reviewers before the PR: one who did not touch the change, both with the
adversarial brief in `docs/AUDIT.md` §6. The brief asks for
`Claim | Proof | Verdict` with `file:line`; "looks good" is not a review.
Address every `weaker`/`not proven` by improving the proof or shrinking the
claim.

Use `agent_preset: "readonly"` when the tool accepts it. If it rejects the
preset ("selection is disabled for this tool instance"), run two plain
subagents whose prompt says **read-only** and record that fallback in the
report; it is a weaker independence claim, so do not describe it as sandboxed.

## 7. Ship the pass

```bash
npm run verify
git add docs/AUDIT.md docs/audits .dsh/skills/dsh-anyplugin-audit \
  scripts/audit-*.mjs scripts/check-audit*.mjs scripts/*-rules.test.mjs \
  scripts/check-decisions*.mjs scripts/check-architecture.mjs \
  package.json AGENTS.md docs/WORKFLOW.md .gitignore
git commit -m "audit: <date> pass"
git push -u origin <branch>
npm run gh-bot -- pr create --title "audit: <date> pass" --body-file <body>
npm run gh-bot -- pr comment <n> --body-file <reviewer-verdicts>
```

A report-only PR adds only `docs/AUDIT.md`, `docs/audits/`, and the skill. A
mechanism fix carries the code and its test. A finding that needs product code
gets an issue labelled `enhancement` (or `bug`) and a separate worker; the audit
does not edit feature files, push a ticket branch, or merge its own PR.

Completion: `verify` is green, the report and ledger are in the PR, every open
finding is tracked, and the PR names the two reviewers when it changed a
mechanism.

## Command discipline

The baseline is unambiguous: 86 % of bash calls began with `cd <dir> &&`, and
`sed`/`grep`/`cat` outnumbered the read/grep/glob tools roughly 10:1. The harness
already carries the directory and the file tools already carry line numbers.

| Instead of | Use |
| --- | --- |
| `cd <worktree> && npm run …` | `workdir: "<worktree>"` on the call |
| `sed -n 1,40p file` / `cat file` | `read` with `offset`/`limit` |
| `grep -n pattern file` | the `grep` tool (and `glob` to find files) |
| `npm run verify` after each edit | the narrow gate first: `check:decisions`, `check:arch`, one `node --test` file; `verify` once before push |

`npm run verify` is the pre-push gate, not a save button. 950 runs against 325
narrow checks in the 2026-11-22 window is the cost this table removes.

## When the pass is too big

Split when the previous `## Open` plus the new window no longer fit one sitting,
when two consecutive reports have disjoint areas (rig vs. process), or when you
catch yourself editing code to make a finding true. A split is a new scheduled
task with a narrow brief and a report prefix (`docs/audits/rig-YYYY-MM-DD.md`);
the ledger stays single. Record a split in `docs/AUDIT.md` §8 and, if it changes
who may merge, in `docs/DECISIONS.md`.
