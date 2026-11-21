# claude-output-styles-activation

Hand-authored, not observed. At the 2.1.322 pin, `claude plugin details` printed
no output-style line (D29), so there is **no `.inventory` golden** here and the
fixture is excluded from the oracle loop in `fixtures.test.mjs` (its name is in
`scripts/hand-authored-fixtures.mjs` for the same reason). The evidence for
ticket #77 is the composed system prompt: `output-styles-activation.test.mjs`
boots the pinned harness, loads the emitted entry, runs a real turn on a stub
adapter, and compares the prompt bytes the model received.

The fixture is a real plugin with a small skill so the group entry always has a
child and the negative controls boot the same path as the positive ones. Four
styles cover the activation matrix:

- `output-styles/append.md` — `keep-coding-instructions: true`; the body is
  appended after the host prompt.
- `output-styles/replace.md` — `keep-coding-instructions: false`; the body
  replaces the whole prompt (`complete: true`).
- `output-styles/forced.md` — `force-for-plugin: true` and
  `keep-coding-instructions: false`; applies when no explicit record exists.
- `output-styles/inactive.md` — no composition keys and never activated; the
  negative control for "a style that is not selected leaves no bytes".

The bodies are deliberately boring prompt text with leading and trailing
blank lines; they prove the bytes survive and that a body is not trimmed by the
carry.
