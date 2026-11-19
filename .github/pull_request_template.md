## Ticket

Closes #

## What changed

<!-- One paragraph. What behaviour is different after this PR. -->

## Fidelity

<!-- Move rows only when they became true. Name the pin for any number. -->

- coverage rows moved: none / `surface:name:missing → match`
- annotations changed: none / <node> → <class>, because <reason>

## Evidence

```
# paste the tail of the command you ran
npm run verify
node --test packages/.../test/....
```

- [ ] `npm run verify` is green locally (including the harness oracle, if this
      touches a fixture or a materializer)
- [ ] no non-negotiable from AGENTS.md §3 was bent, or the bend is a new
      decision entry in this PR
- [ ] if a decision was made, `docs/DECISIONS.md` has it
- [ ] if the contract moved, `docs/ARCHITECTURE.md` moved in this PR

## Risk

<!-- What could break, and what makes that unlikely. -->
