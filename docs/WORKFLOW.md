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
| **architecture reviewer** (scheduled) | one daily reading of the design against the code: what the architecture doc claims, what the tree does, and where the two diverge; files issues (or a docs-only PR) through the normal queue | merges, pushes to `main`, feature code, editing `docs/DECISIONS.md` |

Only the master merges, after the review verdicts. A worker, the auditor, or the
architecture reviewer pushes its own branch. `main` is protected: PRs only, the `verify` check must be green,
history is linear (squash), no force pushes. Every modelled `gh pr merge` that performs a merge must
carry `--match-head-commit <40-hex>` naming the reviewed head; the guard
refuses an unpinned modelled merge for every role. The pin prevents omission,
not review: it makes "what was reviewed" falsifiable, but it does not prove
the head was reviewed. A merge through another client (a script, `curl`, an
inline interpreter, a pre-existing git/client-side alias, or a raw GraphQL call)
is outside the guard's model. The guard rule is dormant until the
guard is installed (F1/F2); the obligation above stands either way.

The auditor and the architecture reviewer are separate roles on purpose. The
auditor reads the queue and the transcripts, writes findings, and pushes
mechanism fixes; the architecture reviewer reads the design docs against the
tree, files issues, and does not implement a ticket or merge. A mechanism PR gets two independent verdicts (F17) and the
master merges it; an unresolved `weaker`/`not proven` verdict is a merge veto
for the master. That veto is policy, not a guard check: no gate reads PR
comments yet. `docs/AUDIT.md` §7 has the caps and the alarm thresholds.

The architecture reviewer is not the auditor. The auditor asks whether the
_process_ produced a bad change; the architecture reviewer asks whether the
_design_ still describes the code and where the next structural
improvement is. It loads `.dsh/skills/dsh-anyplugin/SKILL.md`, reads
`docs/ARCHITECTURE.md` §0/§2/§7, `docs/FEATURES.md`, `docs/DECISIONS.md` and
`docs/TODO.md` against the package map and the seams the code actually uses,
and then files **issues**, not code fixes: one issue per finding, naming the
commit it was read at, the file and line, the contract sentence it contradicts,
and the smallest change that would close it. It files each finding through
the bot with the title `arch: <finding>` and one existing `area/*` label —
never a new label — so the queue routes it as an agent finding without reading
prose (`docs/TRIAGE.md` §2, D85). It searches open issues first and
comments new evidence on the existing issue instead of re-filing it. A docs-only correction may go out
as a PR instead of an issue for that finding, through the normal flow (CI green,
reviewer verdict, master merges); anything touching code is a ticket. Its
evidence bar is the audit's finding bar, tightened: a path and a line at a
commit, not a path or a count (`docs/AUDIT.md` §5). It is triggered by the
session scheduler, not by CI; the task lives in `~/.dsh/storages/schedule.json`
and is recreated with `schedule_create` (see `docs/AUDIT.md` §2 for the same
operation for the auditor). CI cannot read design intent.

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
worktree. The wildcard only counts after a stem ending in `-`: a block written
before that grammar (or an exact entry for a worktree whose real name ends in
`*`, except one ending in exactly `-*`, which reads as the wildcard) names a
path, not a pattern, and status reports it as stale once it is gone. A live
ticket path containing a literal `*` makes status report `refused` and name
the rename remedy; reinstalling cannot make it readable. Install once from the
main checkout — a real install from a linked
worktree is refused, because git shares one hooks directory with the main
checkout; a submodule or `--separate-git-dir` checkout is its own main checkout
and is installed from there, while a linked worktree of either has no main
working tree git can name and is refused for a real install. `npm run guard:install -- --dry-run` from an
ordinary checkout composes the block and names the main checkout (from a linked
worktree of a submodule or `--separate-git-dir` repo it composes from the
invocation checkout, writing nothing); `npm run guard:status` reports `not-installed`,
`current`, `stale`, `refused` or `installed-with-stale-paths` (a literal path in the block
no longer exists, and the line names it), and prints the desired and installed
worktree lists separately. A directory whose path does not share that parent and
stem is not covered until the next install. If any discovered ticket worktree is
outside the shared parent and stem, the block keeps the exact list instead of a
pattern; one out-of-pattern worktree then makes the next install drop the
pattern for every future worktree until the next install. Review and verify
worktrees are deliberately not confinable.

The block also names the resolved git directory (`protectedRoots` when it is
outside the main working tree, and `gitDirectories` always). That is what stops
a pattern that happens to match a custom git dir — `sep-*` next to `sep-gitdir`
— from letting a worker overwrite the pre-push hook the install just wrote.
A worker write under `<gitdir>/config` or `<gitdir>/hooks/pre-push` is refused
by `git-dir-write`; a root write there is allowed, and the common dir covers
the per-worktree dirs of worktrees created later.

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
4. **Do not run the suite locally.** Push the branch: `verify` runs on every
   branch push (0.2.2-rc.5 and 0.2.2-rc.2, the pinned Claude CLI, one union
   fetch), one run per push event, and `npm run ci` tells you what it said. The
   push run is the only `verify` that counts (D83): branch protection matches the
   required context by name and producing app, not by workflow file, so a
   reviewer counts only the push run this repository's `verify.yml` produced for
   the head — a same-repo PR's push run, or for a fork the maintainer's push of
   its head onto a branch here. Local runs are limited to the static checks
   (`check:arch`, `check:features`, `check:decisions`), which read files and
   start no child processes. This is #175: the maintainer's machine is shared,
   and a botched local suite is a real cost.
5. Push the branch and open the PR with the template filled in. Then stop: do
   not merge, do not push more commits unless a review asks for them.

### Updating a stale PR

When `main` moves and the PR branch is behind, use `npm run pr:update <n>`:

1. it resolves the PR's head branch and head sha (`gh pr view`);
2. it reuses that branch's worktree when that worktree is already at the PR
   head, or makes a temporary one at `/tmp/anyplugin-wt/pr-<n>` (removed
   afterwards); before merging it refuses a worktree whose merge is already in
   progress, whose index has unmerged paths, or which has uncommitted changes,
   and it never runs `git merge --abort` on a conflict it did not create;
3. it merges `origin/main` — a conflict its own merge creates aborts that merge,
   checks the abort's exit status, and pushes nothing; a conflict that was
   already in the worktree is refused before any merge is attempted;
4. it pushes `HEAD:<branch>` and waits for `verify` on the new head; the wait
   counts the newest completed push run for that head and does not wait for a
   newer run that is still in progress (`scripts/ci-runs.mjs`);
5. on success it prints exactly
   `gh pr merge <n> --squash --match-head-commit <40-hex>`.

It never merges, approves or force-pushes, and it automates the same-repository
path only: it refuses a PR whose head branch is not in this repository (a fork's
branch is not ours to push; a fork's gate stays the maintainer's push of its head
onto a branch here, D83) or whose base is not `main`. Run the printed merge line
only after reading the diff; the script does not merge for you.

## Definition of done (a worker may not ship without all of these)

- the acceptance checkboxes in the ticket are observably true;
- the `verify` run on the PR head is green (link the run, not a local paste);
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

### A fork PR

A fork PR has no gate here at all until a maintainer pushes its head onto a
branch in this repository and that push run goes green (D83). The rule is
procedural, not enforced: branch protection matches a required check by context
name and the app that produced it, not by workflow file, so it cannot tell a run
this repository's `verify.yml` produced from one a contributor's
`on: pull_request` workflow produced. A `pull_request` run executes the workflow
file from the PR's merge commit, which the contributor controls, and its job can
be named anything — a check named `verify` from that run would satisfy branch
protection without running our tests. Reviewers therefore count only the push run
this repository's `verify.yml` produced for the head; `verify.yml` is push-only as
defence in depth, so the accidental second context is gone too. `npm run ci`
watches push runs only; a `pull_request` run on the same commit is never
evidence, and reopening a fork PR fires nothing. The recovery is the maintainer's
push of the head onto a branch here.

**A PR head can be missing its `verify` run**, a same-repo PR included, if the
branch was pushed while the workflow file was invalid. Five minutes without a
`verify` row is the signal (`scripts/ci-runs.mjs`'s 300 s appear timeout names
the number), and `npm run ci` fails fast with the push hint when the commit is
not on a remote branch here instead of waiting it out. For a same-repo PR, read
the push run for the commit (`npm run ci -- --head <sha>`). Recovery: change the
head so the `push` event fires again — push an empty commit
(`git commit --allow-empty -m "ci: re-run verify"`). Never merge without the
check and never bypass the rule; the status is the gate, the empty commit only
re-asks for it.

A same-repo PR's `verify` is its push run — one run per push event. If a commit
ever carries more than one push run, `npm run ci` reports the newest completed,
non-skipped run and does not wait for a newer run that is still in progress. The
`pull_request` trigger was removed because a skipped job still reports as a
passing check of its own name and a fork could name its own job `verify` (D83).

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
