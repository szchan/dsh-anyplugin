---
name: dsh-anyplugin
description: Work in the dsh-anyplugin repository — take or review a ticket, change a fidelity claim, land a decision, or run the gates. Use whenever a task touches this repo's code, fixtures, docs, decisions, issue queue, or releases.
---

# dsh-anyplugin

A layer that runs Claude Code and Codex plugins inside DSH, at fidelity declared
per surface. The claim is the product.

The repository documents its own rules. Before editing, read `AGENTS.md`, then
`docs/WORKFLOW.md`, then the doc for the area you touch. This skill is only the
index and the habits CI cannot check.

## The loop

```bash
npm run triage                                  # what is ready
git worktree add /tmp/anyplugin-wt/ticket-<n> -b ticket/<n>
npm run check                                   # static checks, seconds
git push -u origin ticket/<n> && npm run ci     # CI is the gate; read it here
```

The suite runs in CI: it fetches both DSH pins and the pinned Claude CLI once,
and fails on a skip by design. Do not run `npm test`, `npm run verify`,
`npm run build` or `npm run bench` locally — the machine is shared (#175).

## Habits CI cannot enforce

- **Evidence over "it works".** A claim lands with a coverage row moved and its
  reason, a payload trace, or a test that goes red when the change is reverted.
- **Read the pin.** Payloads, type citations and counts are true only against
  the pinned version; a number without its pin is a rumour.
- **Hunt the two recurring lies:** fields that are parsed and then dropped, and
  prose that promises more than the code does.

## Where answers live

| Question | File |
| --- | --- |
| non-negotiables | `AGENTS.md` §3 |
| design, fidelity contract, seams | `docs/ARCHITECTURE.md` |
| why a rule exists; adding one | `docs/DECISIONS.md` (append-only) |
| ticket lifecycle, review rubric | `docs/WORKFLOW.md` |
| claim → proof ledger | `docs/FEATURES.md` |
| burn-down | `docs/TODO.md` |
| process audit | `docs/AUDIT.md` |
| releasing | `docs/RELEASING.md` |

Never merge your own PR; never push to `main`. Something needs a human: open a
`[HUMAN]` issue — chat is not a channel.
