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
| **auditor** (scheduled) | the daily pass, audit tooling, process docs, and a gate/test that is the finding's fix | feature code, ticket branches, merging |

Only the master merges, after the review verdicts. A worker or the auditor pushes
its own branch. `main` is protected: PRs only, the `verify` check must be green,
history is linear (squash), no force pushes. Once #163 lands, a master merge also
pins the reviewed head.

The auditor is a separate role on purpose. It reads the queue and the
transcripts, writes findings, and pushes mechanism fixes; it does not implement a
ticket or merge. A mechanism PR gets two independent verdicts (F17) and the
master merges it; an unresolved `weaker`/`not proven` verdict is a merge veto
for the master. That veto is policy, not a guard check: no gate reads PR
comments yet. `docs/AUDIT.md` §7 has the caps and the alarm thresholds.

### Identity

An agent never posts as the human. Every GitHub write — issue comment, review,
label, branch, PR — goes through the bot account:

```bash
node scripts/gh-bot.mjs --whoami                      # login + its repository permissions
node scripts/gh-bot.mjs issue comment 80 --body "…"   # any `gh` verb passes through
node scripts/gh-bot.mjs pr create --title … --body …
```

The token lives in `~/.config/dsh-anyplugin/gh-bot.token` (classic PAT, scopes
`repo` and `workflow`, created on `szchan-bot`), never in the repository and
never in an Actions secret: the agents that need it run on this machine, and a
secret in Actions is invisible to them.

Two consequences worth stating: a PR authored by `szchan-bot` was written by an
agent, and a comment by `szchan` is a human decision. If a bot write fails with
`Resource not accessible by personal access token`, the token is read-only or its
repository access is empty — check `--whoami` before assuming a permission
problem in the repository.

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
root=${ANYPLUGIN_WORKTREE_ROOT:-/tmp/anyplugin-wt}
mkdir -p "$root"
dir=$root/ticket-<n>
git worktree add "$dir" -b ticket/<n> origin/main    # the master creates it
cd "$dir"
```

The shared parent and the `ticket-<n>` stem matter to the guard:
`npm run guard:install` writes one pattern (`$root/ticket-*`), not a snapshot of
the worktrees that existed when it ran, so a directory matching it is admitted
without a reinstall — including a worktree the master creates later. The pattern
is a namespace matcher, not a git-worktree attestation: any directory named
`ticket-*` under `$root` is confinable even if git never created it as a
worktree. Install once from the main checkout — a real install from a ticket
worktree is refused, because git shares one hooks directory with the main
checkout. `npm run guard:install -- --dry-run` from anywhere composes the block
and names the main checkout; `npm run guard:status` reports `not-installed`,
`current`, `stale` or `installed-with-stale-paths` (a literal path in the block
no longer exists, and the line names it), and prints the desired and installed
worktree lists separately. A directory whose path does not share that parent and
stem is not covered until the next install. If any discovered ticket worktree is
outside the shared parent and stem, the block keeps the exact list instead of a
pattern; one out-of-pattern worktree then makes the next install drop the
pattern for every future worktree until the next install. Review and verify
worktrees are deliberately not confinable.

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
   opens, including the tests that need a harness or the upstream CLI. CI
   fetches the pinned Claude CLI and both npm pins (0.2.2-rc.5 and 0.2.2-rc.2)
   once; the fetch installs the union the suite and spikes need, so there is no
   per-step install. CI fails on a skip, but it cannot test your Desktop
   installation — so paste the local run in the PR. CI and the reference
   machine run Node 24; the profile-mount test needs `module.registerHooks`
   (Node >= 22.15) and skips with a reason naming that version on older Node.
   The package's published engine floor stays 22.14 — the floor describes the
   package, not the suite. The mod-coverage test also reads the fetched mod
   tree: run `node scripts/fetch-mod.mjs` once, or set `ANYPLUGIN_MODS_TREE` to
   an already-fetched tree. Without it `computeCoverage` throws with the fetch
   instruction; it does not skip.
5. Push the branch and open the PR with the template filled in. Then stop: do
   not merge, do not push more commits unless a review asks for them.

## Definition of done (a worker may not ship without all of these)

- the acceptance checkboxes in the ticket are observably true;
- `npm run verify` green locally (paste the summary line in the PR);
- every new behaviour has an assertion (a unit test, or a fixture row that moved
  because the behaviour really changed);
- the PR body states each behavioural claim in a `Claim | Proof` table, the proof
  naming the assertion (or `file:line`) that would fail if the claim were false;
  a claim with no such assertion is deleted or shrunk, not reviewed as prose;
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
   removed? Name one that would. Check the `Claim | Proof` table: a proof that
   tests a weaker property than its claim is a request-changes (F5 in
   `docs/AUDIT.md`).
6. **Docs** — decision entry, architecture update, TODO burn-down.
7. **Noise** — unrelated formatting, debug leftovers, a second way to do
   something the repo already does one way.

The master reads the verdict and the diff stat, not the whole diff, and merges
or bounces. Two bounces on the same ticket means the ticket was underspecified:
the master rewrites it.

## What CI proves, and what it cannot

`verify` on GitHub runs `npm run check:arch`, installs the pinned Claude Code
CLI, fetches the DSH harness pins, and runs `npm run verify` against each of
them (`0.2.2-rc.5`, `0.2.2-rc.2`). A skipped DSH-side test is a failed job: a
shell guard checks `DSH_HARNESS_DIR` before running the suite. The upstream
half is guarded the same way: `CLAUDE_BIN` must be set and its `--version` must
match the pin before the suite runs.

- **Proves**: the tree still has its declared shape; pure packages behave; the
  fidelity oracle agrees with both pinned npm harnesses and with the pinned
  Claude Code CLI; nothing needs a secret; nothing needs this laptop.
- **Cannot prove**: the Desktop installation specifically (`DSH_INSTALL_DIR`),
  the asar access path, or the behavior face (`claude plugin eval` costs
  money). Those are local evidence and belong in the PR body. CI green is a
  floor, not the whole claim.

**A pull request can land without a `verify` run.** GitHub has been
observed not to schedule `pull_request` workflows for a PR opened through the
API right after its branch push: intake and the label job run, `verify` never
appears, and the merge stays blocked waiting for a check that will not come.
Two minutes without a `verify` row is the signal. Recovery: push an empty
commit so the head changes (`git commit --allow-empty -m "ci: re-run verify"`)
and wait for the new run. Never merge without the check and never bypass the
rule; the status is the gate, the empty commit only re-asks for it.

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
