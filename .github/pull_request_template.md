## Ticket

Closes #

## Why

<!-- One paragraph. What is wrong for the user today, and why this PR now. -->

## What changed

<!-- One paragraph. What behaviour is different after this PR, and how. -->

## Scope

<!-- Paths touched. If this is wider than the ticket's `Touches`, say why. -->

## Claim | Proof

<!-- One row per behavioural claim. The proof names the assertion, command, or
     file:line that would fail if the claim were false. A claim with no such
     proof is deleted or shrunk, not reviewed as prose (docs/WORKFLOW.md,
     "Definition of done"). -->

| Claim | Proof |
| --- | --- |
|  |  |

## Fidelity

<!-- Move rows only when they became true. Name the pin for any number. -->

- coverage rows moved: none / `surface:name:missing → match`
- annotations changed: none / <node> → <class>, because <reason>

## Evidence

<!-- The `verify` run on this PR head, not a local paste. AGENTS.md §5 forbids
     running the suite locally: push the branch and read `npm run ci`. -->

```
# the tail of the verify run for this PR head
npm run ci
```

- [ ] the `verify` check is green on this PR head (link the run: ...)
- [ ] that run reported 0 skipped
- [ ] no non-negotiable from AGENTS.md §3 was bent, or the bend is a new
      decision entry in this PR
- [ ] if a decision was made, `docs/DECISIONS.md` has it
- [ ] if the contract moved, `docs/ARCHITECTURE.md` moved in this PR

## Risk

<!-- What could break, and what makes that unlikely. -->
