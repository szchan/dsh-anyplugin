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
with a link to the commit/PR that did it. An item that was not worked is named
as blocked or explicitly accepted; it is not silently carried.

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
`new_once`, working directory the main checkout. The prompt must say: fetch
`origin/main`, create or reset `.agents/worktrees/audit-daily` on a fresh
branch, load this skill, always write the report and open a PR (even a
report-only pass), give every finding an action in the same pass, never approve,
merge, or close, and run the Monday mutation check (§7). Confirm the task in the
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
finding → what changed in this pass, or the issue/PR opened in this pass.

## Open
only blocked or deferred findings, each with a tracking issue, an owner, and
the condition that reopens it. Not a backlog.
```

Number new findings after the highest `F<n>` in the ledger. A finding that
already exists gets its entry updated, not a second id. New ledger entries quote
this report in `evidence`; the report quotes the JSON.

Every finding must leave this pass with an action: fixed in the PR, tracked by
an issue/PR opened in the same pass, or accepted with an owner and review date.
"Investigate later" is not an action.

Completion: every sentence in `## Findings` has a path, a count, or a quoted
sample; no sentence relies on memory.

## 5. Update the ledger, then gate it

Edit the JSON block in `docs/AUDIT.md` between the audit-ledger markers:

- `mechanism` ∈ `hook`, `ci`, `lint`, `skill`, `reviewer`, `docs`, `schedule`;
- `status` ∈ `enforced`, `reviewed`, `documented`, `dormant`, `open`, `retired`;
- `artifact`/`proof` are files that exist, and `proof` is not the artifact;
  `open` carries `tracking: "#<issue>"`;
- `enforced` means a hook/ci/lint mechanism with a proof file; `reviewed`
  means a recorded check exists (a schedule that only reports counts because
  the daily pass checks it); `documented` means prose only; `dormant` means
  implemented and tested but not installed (F1);
- move `updated` to today; never delete an entry (retire it with the reason);
- a new finding needs `node scripts/check-audit.mjs --update`, which also
  refreshes `docs/audit.lock.json`; a locked title/mechanism/artifact cannot
  change in place.

```bash
npm run check:audit
```

Completion: `check:audit` prints the entry/report counts and exits 0.

## 6. Ship the pass

`verify` needs the pinned environment from the main checkout
(`DSH_HARNESS_DIR`, `DSH_HARNESS_VERSION`, `CLAUDE_BIN`,
`ANYPLUGIN_MODS_TREE`, `ANYPLUGIN_MOD_TREE`; AGENTS.md §6). Without it the
suite skips, and a skip is a failed pass. Export them, then:

```bash
npm run verify
git add docs/AUDIT.md docs/audits .dsh/skills/dsh-anyplugin-audit \
  scripts/audit-*.mjs scripts/check-audit*.mjs scripts/*-rules.test.mjs \
  scripts/check-decisions*.mjs scripts/check-architecture.mjs \
  package.json AGENTS.md docs/WORKFLOW.md .gitignore
git commit -m "audit: <date> pass"
git push -u origin <branch>
npm run gh-bot -- pr create --title "audit: <date> pass" --body-file <body>
```

A report-only PR adds only `docs/AUDIT.md`, `docs/audits/`, and the skill. A
mechanism fix carries the code and its test. A finding that needs product code
gets an issue labelled `enhancement` (or `bug`) and a separate worker; the audit
does not edit feature files, push a ticket branch, approve, merge, or close its
own PR.

The report PR is opened in the same pass; there is no separate branch or
comment-only path for a daily report. The auditor may open issues and PRs, but
it does not approve, merge, or close them: the PR goes to the master's merge
path. Until the permission layer lands, this is a convention, and the report
says so when it matters.

Completion: `verify` is green, the report and ledger are in the PR, and every
open finding is tracked.

## 7. The Monday mutation check

Prose and a green gate can both be true while the mechanism is useless. Once a
week, pick one `enforced` entry, break its mechanism in a scratch copy (delete
the gate call, add the violating file, empty the proof), run the gate, and
confirm it reddens with the entry's message. Restore immediately; never commit
the break. Record the entry, the mutation, and the observed failure in
`## Actions`.

If the gate stays green, the entry's status or proof is wrong: shrink the claim,
fix the test, or move it to `reviewed`. A mutation that was not run is written
as "not run", not assumed green.

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
