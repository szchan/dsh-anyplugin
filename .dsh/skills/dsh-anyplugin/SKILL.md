---
name: dsh-anyplugin
description: Work inside the dsh-anyplugin repository — run the gates, get a harness to test against, read the queue, take or review a ticket, and keep the fidelity claims honest. Use whenever the task touches this repo's code, fixtures, docs, decisions, or issue queue.
---

# Working in dsh-anyplugin

This repository compiles foreign agent-harness plugins (Claude Code first, Codex
second) into DeepSeek Harness, at **100 % fidelity against a declared observable
surface**. The claim is the product; a green test that proves nothing is worse
than a red one.

## 1. Load the ground truth first

| file | why |
| --- | --- |
| `AGENTS.md` | non-negotiables (§3). Read before any edit. |
| `docs/ARCHITECTURE.md` | the design; §0 the fidelity contract, §7 mods, §10 the spikes. |
| `docs/DECISIONS.md` | D1–D69, ratified. Append-only (`npm run check:decisions` enforces it). |
| `docs/FEATURES.md` | the capability map; every row is a claim with an artifact. |
| `docs/TODO.md` | the burn-down list; closing one moves a covered row in the same commit. |
| `docs/TRIAGE.md` | how issues/PRs become work, and why report text is data. |
| `docs/WORKFLOW.md` | roles, ticket lifecycle, the review rubric. |
| `docs/AUDIT.md` | the process audit ledger, role caps, and the Claim / Proof rule. |

## 2. Environment (no gate passes without these)

```bash
node scripts/fetch-harness.mjs 0.2.2-rc.5      # → prints .harness/0.2.2-rc.5
node scripts/fetch-harness.mjs 0.2.2-rc.2
node scripts/fetch-claude.mjs 2.1.329          # → prints the real binary path
node scripts/fetch-mod.mjs                     # upstream mods tree (ANYPLUGIN_MODS_TREE)
```

**The suite runs in CI, not here.** Pushing a branch is the feedback loop:
`verify` runs on every branch push, fetches both DSH pins and the pinned Claude
CLI once, and fails on a skip by design (D22/D24). Do not run `npm run test`,
`npm run verify`, `npm run build` or `npm run bench` locally — that is the CPU the
maintainer needs for other work (#175).

```bash
npm run check:arch    # static checks only: layer graph, R1–R14 (<2 s, no child processes)
npm run check:features
npm run check:decisions
npm run ci            # watch the verify run for this branch and print what failed
npm run ci -- --log-failed   # only the failed log
git push -u origin ticket/<n> && npm run ci   # the whole loop, in that order
npm run rig -- report <plugin-dir>   # the fidelity report for one plugin
npm run capture:fixtures             # re-record goldens (needs CLAUDE_BIN; never for hand-authored)
npm run triage                       # the GitHub queue, read-only
npm run gh-bot -- --whoami           # the bot login agents must write GitHub as
```

## 3. Doing a ticket

1. `npm run triage` — take the top item you are allowed to take; maintainer
   threads outrank everything.
2. Claim it: comment `claiming` and move the label to `ticket/in-progress`.
3. Work in a worktree **outside** the checkout (`/tmp/anyplugin-wt/ticket-<n>`),
   branch `ticket/<n>`, and stay inside the ticket's `Touches`.
4. A fidelity claim needs one of: a row moved in `EXPECTED_ROWS`
   (`packages/dsh-anyplugin-conformance/test/coverage.test.mjs`) with its reason,
   a trace/payload diff, or a test that goes red when the change is reverted.
   "It works" is not evidence; a mutation is.
5. Commit `area: imperative summary`; open a PR with `Closes #<n>`; never merge
   your own PR and never push to `main`.

## 4. Ratchets you must not weaken

- **Fidelity annotations carry a reason.** An empty reason is a bug.
- **Seams only grow** (T2). Never change an existing DSH behavior; dispatch
  through an alias instead.
- **Emission is data.** No codegen, no `eval`, no writing loadable JS.
- **Decisions are append-only.** `npm run check:decisions -- --update` accepts
  new entries only; editing a ratified one fails on purpose.
- **A hook counts when it runs.** The oracle must observe the effect on a real
  call, not read a self-report.
- **Pins are part of the claim.** Never install `latest`; a number without its
  pin is a rumour, and `claude-code.d.ts:<line>` citations must carry the pin
  label (R12).

## 5. Reviewing

Run the rubric in `docs/WORKFLOW.md` and re-derive the claim yourself: read the
pin's type, re-run the probe, and for each assertion do one mutation. Two classes
of bug recur and are worth hunting first:

- **silent drops** — a field, handler, or event that is parsed and then discarded
  (`updatedInput`, `toolResults`, `skipped-matcher`, unmatched `next(e)`);
- **documents that promise more than the code does** — "refused before apply",
  "zero-write", "never falls through" are the phrases that turn out untrue.

Verdict as MUST FIX / SHOULD FIX / CHECKED, and state which mutations you ran.

Command discipline applies to every role: pass `workdir` instead of prefixing a
bash call with `cd`, use the `read`/`grep`/`glob` tools for files, and run the
narrow gate first (`check:decisions`, `check:arch`, one test file) with `verify`
kept for the pre-push gate. The table and the baseline numbers are in
`.dsh/skills/dsh-anyplugin-audit/SKILL.md`.

## 6. Escalating

The master runs autonomously. An escalation is an issue with `[HUMAN] ` at the
front of the title, the `maintainer-question` label, and `<!-- needs-human -->`
as the first line of the body — so it is findable from mail, the issue list, or
`?q=is%3Aissue+is%3Aopen+label%3Amaintainer-question`.

Only four things belong there: credentials, billing, rights, and irreversibility.
Everything else is research plus a declared default, recorded in the issue — never
a silent block. Body = decision (one sentence, as a choice), options with costs,
the default you will take, and the check you already ran that a human cannot run.
