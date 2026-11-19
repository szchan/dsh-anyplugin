# WORKFLOW.md — how more than one agent works on this repository

This file is the protocol. `AGENTS.md` says what the code must be; this says how
work moves. A worker that skips a step here produces a PR the master cannot
merge, which wastes the worker's whole branch.

## Roles

| Role | Owns | May not |
| --- | --- | --- |
| **master** | the ticket queue, assignments, reviews, merges, the coverage totals, `docs/DECISIONS.md`, and its own docs-only PRs | write feature code, push to `main` |
| **worker** (subagent) | one ticket, in its own worktree, on its own branch | merge, push to `main`, edit files outside its `Touches`, change a decision |
| **reviewer** (subagent) | one verdict per PR against the rubric below | merge, edit the branch |

Only the master merges. Only a worker pushes a branch. `main` is protected: PRs
only, the `verify` check must be green, history is linear (squash), no force
pushes.

## Isolation: one worktree per ticket

Never work in the primary checkout. It is the master's, and parallel workers in
the same directory overwrite each other's edits without any conflict marker ever
appearing.

Worktrees live **outside** the checkout. Two reasons, both learned the hard way:
`node --test` walks its working directory, so a checkout nested inside the repo
would run other branches' tests; and a sandboxed worker is usually allowed to
write only inside its assigned directory, so a sibling path may be read-only.

```bash
git fetch origin
dir=$(mktemp -d)/ticket-<n>
git worktree add "$dir" -b ticket/<n> origin/main    # the master creates it
cd "$dir"
```

The master creates the worktree and hands the worker its exact path — a worker
that picks its own path will pick one the sandbox refuses. Remove the worktree
after the merge (`git worktree remove <dir>`); the worker usually exits first,
and a leftover worktree holds a branch lock.

## Ticket lifecycle

```
ticket/ready ──claim──▶ ticket/in-progress ──PR──▶ ticket/review ──merge──▶ closed
                                   │
                                   └──blocked──▶ ticket/blocked (comment why)
```

1. Pick a `ticket/ready` issue. Comment `claiming` **before** the first edit —
   the comment is the lock. Then the master moves the label.
2. Read `docs/DECISIONS.md` for every decision the ticket names, and
   `docs/ARCHITECTURE.md` for the shape of the area.
3. Work only inside `Touches`. A file you need but did not declare is a signal:
   either say so in the PR body, or open a follow-up issue instead of widening
   the diff.
4. Run `npm run verify` in the worktree. It must be green **before** the PR
   opens, including the tests that need a harness. CI fetches both npm pins
   (0.2.2-rc.5 and 0.2.2-rc.2) and fails on a skip, but it cannot test your
   Desktop installation — so paste the local run in the PR.
5. Push the branch and open the PR with the template filled in. Then stop: do
   not merge, do not push more commits unless a review asks for them.

## Definition of done (a worker may not ship without all of these)

- the acceptance checkboxes in the ticket are observably true;
- `npm run verify` green locally (paste the summary line in the PR);
- every new behaviour has an assertion (a unit test, or a fixture row that moved
  because the behaviour really changed);
- coverage rows moved **only** when they became true — the totals are the
  master's to change and are reviewed as a claim, not as a number;
- `docs/ARCHITECTURE.md` still describes the code, and a new decision is written
  down rather than implied;
- `npm run check:arch` passes (the layer graph, no eval, ESM, manifests).

## Review rubric

The reviewer answers each line, then states **approve** or **request changes**:

1. **Ticket fit** — does the diff do this ticket, and only this ticket?
2. **Contract** — does it bend one of AGENTS.md §3's nine non-negotiables? Name
   the number if so. That is a request-changes, even if tests pass.
3. **Fidelity honesty** — is every annotation's `reason` specific? Is a row
   `match` only because something really ran? A row that turns green because a
   test stopped asserting is a regression, not progress.
4. **Shape** — are the changes inside the package that owns the concept? Does
   anything import across a layer it should not? `check:arch` catches the
   mechanical part; the reviewer judges the rest.
5. **Tests that could fail** — would these assertions fail if the behaviour were
   removed? Name one that would.
6. **Docs** — decision entry, architecture update, TODO burn-down.
7. **Noise** — unrelated formatting, debug leftovers, a second way to do
   something the repo already does one way.

The master reads the verdict and the diff stat, not the whole diff, and merges
or bounces. Two bounces on the same ticket means the ticket was underspecified:
the master rewrites it.

## What CI proves, and what it cannot

`verify` on GitHub runs `npm run check:arch`, fetches the DSH harness pins, and
runs `npm test` against each of them (`0.2.2-rc.5`, `0.2.2-rc.2`). A skipped
DSH-side test is a failed job: a shell guard checks `DSH_HARNESS_DIR` before
`npm test`.

- **Proves**: the tree still has its declared shape; pure packages behave; the
  fidelity oracle agrees with both pinned npm harnesses; nothing needs a secret;
  nothing needs this laptop.
- **Cannot prove**: the Desktop installation specifically (`DSH_INSTALL_DIR`),
  the asar access path, or the behavior face (`claude plugin eval` costs
  money). Those are local evidence and belong in the PR body. CI green is a
  floor, not the whole claim.

Do not "fix" a skipped test by making it not need the harness. Either it is a
pure test (then it belongs in a pure package) or it belongs to the oracle. In CI
a skip is a bug.

## Money and secrets

- No key in the repository, in an issue, in a PR, or in CI. The DeepSeek key
  lives at `~/.config/dsh-anyplugin/deepseek.key` and is read by a local script.
- `claude plugin eval` costs money per run. It is never part of CI. Run it only
  when a ticket asks for behavioural evidence, with `--runs 1 --max-cost-usd`.
- CI has no secrets and should never need one. A PR that adds a secret to CI is
  a request-changes.

## Escalation

Worker cannot proceed without a decision → comment `BLOCKED: <question>` on the
ticket, open nothing else, and stop. The master either answers in the issue (and
records a decision if it outlives the ticket) or rewrites the ticket. A worker
never resolves a blocked decision by choosing the easier path.
