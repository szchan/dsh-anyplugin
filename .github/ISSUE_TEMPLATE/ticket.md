---
name: Ticket
about: One unit of work a subagent can finish and prove
labels: ticket/ready
---

## Goal

<!-- One sentence. What is true after this ticket that is not true now. -->

## Acceptance

<!-- Observable, testable. "The row skills:greet:match comes from a real run." -->

- [ ]
- [ ]

## Touches

<!-- Paths this ticket may modify. The master uses this to keep parallel work
     from colliding; stay inside it. If you need more, say so in the PR body. -->

```
packages/dsh-anyplugin-...
docs/...
```

## Must not

<!-- Things that look local but are decisions. e.g. "do not change the command
     name grammar", "do not add a second interception path". -->

## Context

<!-- Decisions, spikes, pitfalls. Link docs/DECISIONS.md entries by number. -->

## Proof

```
# the verify run on the PR head; push and read `npm run ci`
npm run ci
```
