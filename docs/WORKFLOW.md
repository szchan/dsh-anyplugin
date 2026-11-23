# WORKFLOW.md — how more than one agent works on this repository

This file is the protocol. `AGENTS.md` says what the code must be; this says how
work moves. A worker that skips a step here produces a PR the master cannot
merge, which wastes the worker's whole branch.

## Roles

| Role | Owns | May not |
| --- | --- | --- |
| **master** | the ticket queue, assignments, reviews, merges, the coverage totals, `docs/DECISIONS.md`, and its own docs-only PRs | write feature code, push to `main` |
| **integration runner** (subagent) | one dispatched PR: merging `origin/main` into its ticket branch, pushing that branch, polling `verify` by sha, updating the PR body, and cleaning up its worktree (§The integration runner) | merge, approve, push to `main`, edit code, change a decision |
| **worker** (subagent) | one ticket, in its own worktree, on its own branch | merge, push to `main`, edit files outside its `Touches`, change a decision |
| **reviewer** (subagent) | one verdict per PR against the rubric below | merge, edit the branch |
| **auditor** (scheduled) | the daily pass, audit tooling, process docs, and a gate/test that is the finding's fix | feature code, ticket branches, merging |
| **architecture reviewer** (scheduled) | one daily reading of the design against the code: what the architecture doc claims, what the tree does, and where the two diverge; files issues (or a docs-only PR) through the normal queue | merges, pushes to `main`, feature code, editing `docs/DECISIONS.md` |

Only the master merges, after the review verdicts. A worker, the auditor, or the
architecture reviewer pushes its own branch; the integration runner pushes only
the ticket branch it was dispatched with. `main` is protected: PRs only, the `verify` check must be green,
history is linear (squash), no force pushes. Every modelled `gh pr merge` that performs a merge must
carry `--match-head-commit <40-hex>` naming the reviewed head; the guard
refuses an unpinned modelled merge for every role. The pin prevents omission,
not review: it makes "what was reviewed" falsifiable, but it does not prove
the head was reviewed. A merge through another client (a script, `curl`, an
inline interpreter, a pre-existing git/client-side alias, or a raw GraphQL call)
is outside the guard's model. The guard rule is dormant until the
guard is installed (F1/F2); the obligation above stands either way.

The integration runner is a worker with a narrower job: it does the branch
update and `verify` polling the master used to do by hand, then reports a head.
It is not a second merge authority and it gives no verdict; §The integration
runner is its written role — input, steps, output, and stop cases (D73).

The auditor and the architecture reviewer are separate roles on purpose. The
auditor reads the queue and the transcripts, writes findings, and pushes
mechanism fixes; the architecture reviewer reads the design docs against the
tree, files issues, and does not implement a ticket or merge. A mechanism PR gets two independent verdicts (F17) and the
master merges it; an unresolved `weaker`/`not proven` verdict is a merge veto
for the master. A `not proven` verdict is re-run on the head and updated before
the veto applies (see §Review rubric, D86). That veto is policy, not a guard
check: no gate reads PR comments yet. `docs/AUDIT.md` §7 has the caps and the
alarm thresholds.

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
```

Every call after that sets the directory on the call — `workdir: "$dir"` — not
a `cd "$dir" &&` prefix. A `cd` only repeats the directory the call already
carries, and it is the same cost on every call; a command that must run in a
subdirectory passes that subdirectory as the workdir too. The difference is not
enforceable: a hook can see the literal `cd` but not whether it changes
directory on purpose (into a subdirectory, or before a command that must not run
at the top level), so this is a review convention, not a guard rule — the audit
carries it as an accepted risk (F13, D88).

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

### The integration runner

The integration runner (child name `integrator-*`) is the worker that does the
merge mechanics the master used to do by hand. The master dispatches it for one
PR with the PR number, the 40-hex head the reviewer verdicted, and the ticket
worktree path. It runs `npm run integrate -- <n> --head <40-hex>` for the
mechanics, refreshes the PR body and reports the head. It never merges, never
approves, never pushes `main`, and never changes a decision. `npm run integrate`
never merges, never force-pushes, never edits code and never resolves a conflict:
a conflict stops it, prints the conflicted paths and leaves the merge in the
worktree for a human. The master makes the one pinned `gh pr merge` call after
the runner reports (D66, D73).

Every command below runs from the ticket worktree: set `workdir` on the call,
not a `cd` prefix (§Isolation).

`npm run integrate -- <n> --head <40-hex>` performs steps 1–4 below and prints
the report; steps 5 and 6 are still the runner's own work. It exits 2 when it
refuses to start, with one actionable refusal line. It exits 1 when a step
failed: that report names the failed step and quotes the failed command's
output — git's own stderr where git produced one, which can be several lines —
plus the recovery step where the script knows one. `npm run` forwards only the
arguments after `--`, so the head follows it; `npm run integrate <n> <40-hex>`
is the same input as a second positional argument.

The head argument is the dispatched head — the sha the master dispatched and
the reviewer verdicted. It is required: the script checks it against the PR
head, so an integration run always names the reviewed commit, and a head pushed
after the verdict stops the run instead of being integrated silently.

1. **Preflight.** The script reads the PR with
   `npm run -s gh-bot -- pr view <n> --json
   state,isCrossRepository,baseRefName,headRefName,headRefOid` and refuses to
   start — exit 2, one line — when it is not open, comes from a fork, does not
   target `main`, or its head is not a 40-hex commit. It then compares
   `headRefOid` with the dispatched head it was given as `--head` and refuses
   when they differ: a head pushed after the verdict has no review, so it is not
   integrated. It then finds the worktree that checks out the PR's head branch
   with `git worktree list --porcelain` (`HEAD`, not the branch name alone, must
   be the dispatched head). If there is none it prints the exact
   `git worktree add` line the runner should have been given; the runner does
   not invent one. The located worktree must be the ticket worktree of the PR's
   head branch: `<root>/<branch with / replaced by ->`, with `<root>` =
   `${ANYPLUGIN_WORKTREE_ROOT:-/tmp/anyplugin-wt}` and branch `ticket/263`
   meaning `/tmp/anyplugin-wt/ticket-263`. The path follows the branch, not the
   PR number: the ticket number in it is the branch's, and the PR number can
   differ (PR #264 runs in `ticket-263`). The primary checkout, or any other
   linked worktree, is refused the same way: the runner never works in the
   primary checkout (§Isolation). That refusal prints the step that can actually
   succeed — `git worktree move <found> <expected>` for another linked worktree,
   and for the primary checkout `git -C <primary> switch main` followed by the
   `git worktree add <expected> <branch>` line, because git refuses to move the
   main working tree. A worktree at another head, a merge already in progress,
   unmerged paths or a dirty tree are refused with one line the same way.
2. **Bring `main` in.** The script runs `git fetch origin`, then
   `git merge-base --is-ancestor origin/main HEAD`: exit 0 means nothing to
   merge; exit 1 means the branch is behind, so it merges `origin/main`, pushes
   `HEAD:<branch>` once (one refspec, no force) and re-reads the PR head to
   prove the push landed. A conflict is not resolved: it prints the conflicted
   paths, leaves the merge in the worktree and pushes nothing.
3. **Resolve only additive conflicts.** Additive means both sides' lines are
   kept, nothing deleted or reworded. Only after a conflict stop, the runner
   finishes that merge by hand: edit only the conflicted files under `docs/`,
   `git add <paths>`, `git commit --no-edit`, then push once:
   `git push origin HEAD:<branch>` (one refspec, no redirection), and wait for
   that pushed head's `verify` with `npm run ci -- --head <sha>`. The pushed
   head is a new commit with no verdict: the runner reports it, and the master
   sends it to review (D86) rather than re-running `npm run integrate` under the
   old dispatched head — the script refuses a PR head that is not its `--head`.
   A conflict in `docs/DECISIONS.md` is
   not additive — the log is append-only and numbered — and a conflict outside
   `docs/` stops the run.
4. **Poll the pushed head.** The script runs `npm run ci -- --head <sha>` from
   the ticket worktree for the head it just reported, which waits for that
   commit's push run and exits 0 only
   on success; on red it names the failed steps as `<job> :: <step>`, and
   `--log-failed` adds the log tail. The push run is the only evidence (D83): a
   skipped or `pull_request` run does not count, and a run that does not appear
   within five minutes is a stop, never a reason to merge.
5. **Static checks.** `npm run check` — `check:arch`, `check:features`,
   `check:decisions`. Never the suite locally (D78).
6. **Refresh the body.** Read the current body with
   `npm run -s gh-bot -- pr view <n> --json body`, then post the file with
   `npm run -s gh-bot -- pr edit <n> --body-file <file>`. The runner updates
   facts only: the head and the `verify` run where the body records evidence, and
   `git diff --stat origin/main...HEAD` where it lists the change. A body whose
   `## Why` or claim table is missing, or contradicts the diff, is a
   stop-and-report, not an edit.

Report to the master (the human output is the merge line on stdout and progress
on stderr; `--json` prints one JSON document with `reviewedHead`, `head`,
`pushed`, `ci` and `mergeCommand` instead):

- the new 40-hex head, or "nothing to push" when the branch was already up to
  date;
- the `verify` run id and its conclusion from `npm run ci`, with the failed
  `<job> :: <step>` lines when it is red;
- the exact merge line for that head — the one `npm run integrate` printed
  (`gh pr merge <n> --squash --match-head-commit <40-hex>`, the D66 command; the
  master runs it through the bot as
  `npm run -s gh-bot -- pr merge <n> --squash --match-head-commit <40-hex>`,
  §Identity) — only after step 5 is green. The pin names the head that was
  polled; a head the runner pushed has no verdict yet, so the master sends it to
  review before running the line (D66, D86).

Stop and report instead of resolving: no worktree or branch (the printed
`git worktree add` line is the missing prerequisite), a PR head that is not the
dispatched head, a branch worktree that is not the ticket worktree under
`${ANYPLUGIN_WORKTREE_ROOT:-/tmp/anyplugin-wt}` (the primary checkout always is
one), a dirty tree or a merge in progress, a conflict that is not an additive
docs conflict, `verify` red, or a missing run. Name the failing command and
quote its output; the master re-dispatches a worker or takes the conflict.

After the master merges, the worktree is removed — the master removes it
(§Isolation), and a runner kept alive for that step runs
`git worktree remove <dir>` from the primary checkout. A leftover worktree holds
the branch lock.

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

### Re-running a `not proven` verdict

A `not proven` verdict is not the last word on a claim. The reviewer records the
command that would settle the claim as one verbatim line, re-runs that exact
command against the head under review — the command as written, not a
paraphrase of what it does — and posts the updated verdict as a follow-up
comment before the master merges. The re-run settles the claim as `proven`; or
as `weaker`, when the command settles a weaker property than the claim says; or
it leaves the claim `not proven`. The vocabulary stays those three words: a
re-run does not add a fourth state and does not add a claim.

A claim that is still `not proven` after the re-run keeps the PR out of the
merge queue: the master bounces it with the reason and does not merge around an
unresolved verdict. This step is policy, not a gate (D86): no gate reads PR
comments, and the merge pin names the head that must carry the updated verdict.

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

Only for the four human classes in `docs/TRIAGE.md` §6 does a worker comment
`BLOCKED: <question>` on the ticket, open nothing else, and stop — that section
holds the list, and this one references it instead of restating it (D87).

For every other decision the worker states the default it will proceed on in a
ticket comment *before* the work continues, and proceeds. The default is the
normal path, not an escape from it: "I am not sure" is not a human class, so it
does not buy a block.

A default that would bend §3 of `AGENTS.md` is not a default: that work stops
and goes out as a `[HUMAN]` issue under `docs/TRIAGE.md` §6. A worker never
resolves a human-class block by choosing the easier path, and never writes the
default after the fact — a default recorded after the work is a rationalisation
of it, so the comment has to land first and the reviewer reads the diff against
it.

The master either answers a `BLOCKED` ticket (and records a decision if it
outlives the ticket) or rewrites the ticket. The rewrite path stays for an
underspecified ticket: the master narrows or re-scopes it, and a worker does not
silently reinterpret it in the default's name.
