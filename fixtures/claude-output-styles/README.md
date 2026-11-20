# claude-output-styles

Hand-authored, not observed. There is no `claude plugin details` output to copy
here: at the pinned Claude Code 2.1.322, the component inventory prints no
output-style line (D29), so a captured golden would be empty and could not
anchor a single row. This fixture therefore has **no `.inventory` golden** and
is excluded from the oracle loop in `fixtures.test.mjs`. Its assertion lives in
`packages/dsh-anyplugin-conformance/test/output-styles-carry.test.mjs`: the
carried body is compared byte for byte, and hashed, against these files.

Two styles exercise the two identities the dialect reads:

- `output-styles/precise.md` declares `name: concise-review`, which differs from
  the file stem, so the frontmatter name wins.
- `output-styles/plain.md` has no `name:`, so the file stem (`plain`) is the
  identity, as the host does.

The bodies are deliberately boring prompt text: they prove the bytes survive,
not that the style is useful.
