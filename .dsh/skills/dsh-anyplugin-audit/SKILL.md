---
name: dsh-anyplugin-audit
description: Run the daily process audit for dsh-anyplugin — collect evidence, find recurring agent errors, update the finding ledger, and push hooks/lint/CI/skill fixes. Use for the scheduled audit, after a bad merge or regression, or when asked why agents keep making the same mistake.
---

# The dsh-anyplugin process audit

`npm run verify` gates the product. This skill gates the process: **is it
learning?** The charter — what is audited, cadence, the report template, the
ledger vocabulary, role caps, limits — is `docs/AUDIT.md`. This file is the
procedure.

A pass produces evidence, a few findings, and an action for each. It is not a
diary and not a code sprint.

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

The script prints a digest and writes `.audit/evidence-<date>.json`. Read the
JSON for the numbers you will quote; the digest is the summary.

Use the window since the previous report, not a fixed day: compare today with
the latest report filename and pass that many days (at least 1). Say the window
in `## Evidence`. If GitHub is unavailable, record that and use git only.

The digest prints the schedule's rrule, target and last delivery. If the daily
task is missing, recreate it — daily 09:00 `America/Los_Angeles`, target
`new_once`, working directory the main checkout — with a prompt that says:
fetch `origin/main`, reset `.agents/worktrees/audit-daily` on a fresh branch,
load this skill, always open a PR, give every finding an action, never approve,
merge or close, and run §7.

For PR detail the digest only counts comments; read the bodies:

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

Then check **roles**, which is its own surface (`docs/AUDIT.md` §7): take the
eight largest sessions with their `cwd`, compare each root's **window** count
(the column the digest prints) with the ~1,500 tool-call cap, and check the top
write paths for a session writing outside its role. Print the lifetime count
too, but do not judge on it: a lead that runs for a month always exceeds a
lifetime cap (D73). The digest excludes a seeded fork's inherited prefix from
`window` and `lifetime` (the `inherited` column shows what it removed) and names
a seeded session whose cut cannot be read instead of counting it; never add a
prefix back into a role total (F21). A root over the window cap is a finding
even when the work succeeded; name the split (a scheduled audit, a narrower
ticket, or an integration runner that polls CI and updates branches but never
merges, D73).

Completion: each shape is either "no instance in this window" with the search you
ran, or a finding with a path or a count; every root over the cap has a finding
or a recorded "under cap" line.

## 4. Write the report

`docs/audits/YYYY-MM-DD.md`, with the template and finding numbering from
`docs/AUDIT.md` §5. Two rules this skill adds: every finding leaves with an
action (fixed in the PR, tracked by an issue/PR opened in the same pass, or
accepted with an owner and review date — "investigate later" is not an action),
and every sentence in `## Findings` has a path, a count, or a quoted sample.

## 5. Update the ledger, then gate it

The schema, the status meanings and append-only are `docs/AUDIT.md` §11. New
entries need `node scripts/check-audit.mjs --update`, which also refreshes
`docs/audit.lock.json`; a locked title, mechanism or artifact cannot change in
place. Then `npm run check:audit` prints the entry/report counts and must exit 0.
An `accepted` entry carries `owner` and `reviewBy` (a real `YYYY-MM-DD` day) and
appears in the report's `## Open`, together with every `open` and `dormant`
entry; the gate checks that membership, so the report is the next pass's
checklist.

## 6. Ship the pass

`verify` needs the pinned environment from `AGENTS.md` §6; without it the suite
skips and a skip is a failed pass. Stage what you touched — a report-only PR is
`docs/AUDIT.md`, `docs/audits/` and this skill. The PR goes to the master's
merge path: the auditor never approves, merges, or closes it, and a finding that
needs product code gets an issue and a separate worker.

Completion: `verify` green, report and ledger in the PR, every open finding
tracked, and every open, dormant or accepted finding in the report's `## Open`.

## 7. The Monday mutation check

Prose and a green gate can both be true while the mechanism is useless. Once a
week, pick one `enforced` entry, break its mechanism in a scratch copy (delete
the gate call, add the violating file, empty the proof), run the gate, and
confirm it reddens with the entry's message. Restore immediately; never commit
the break. Record the entry, the mutation and the observed failure in
`## Actions`.

If the gate stays green, the entry's status or proof is wrong: shrink the claim,
fix the test, or move it to `reviewed`. A mutation that was not run is written
as "not run", not assumed green.

## Command discipline

| Instead of | Use |
| --- | --- |
| `cd <worktree> && npm run …` | `workdir: "<worktree>"` on the call |
| `sed -n 1,40p file` / `cat file` | `read` with `offset`/`limit` |
| `grep -n pattern file` | the `grep` tool (and `glob` to find files) |
| `npm run verify` after each edit | the narrow gate first; `verify` once before push |

`npm run verify` is the pre-push gate, not a save button.

## When the pass is too big

Split when the previous `## Open` plus the new window no longer fit one sitting,
when two consecutive reports have disjoint areas (rig vs. process), or when you
catch yourself editing code to make a finding true. A split is a new scheduled
task with a narrow brief and a report prefix (`docs/audits/rig-YYYY-MM-DD.md`);
the ledger stays single. Record a split in `docs/AUDIT.md` §8 and, if it changes
who may merge, in `docs/DECISIONS.md`.
