# claude-monitors-errors

This directory is evidence, not a plugin. It holds the pinned client's own
`Error:` / `Failed to load plugin` lines for the monitor-declaration shapes the
dialect validates, one line per shape in `observed/`.

`packages/dsh-anyplugin-dialect-claude-code/src/monitor-client-text.ts` quotes
these lines in the carried `unsupported` row's reason, and
`packages/dsh-anyplugin-dialect-claude-code/test/monitors.test.mjs` checks that
every table entry is contained in the captured line. `PROVENANCE.md` names the
pin, the capture command and the two verdicts.

The directory has no `.claude-plugin/plugin.json` and no `.inventory` golden on
purpose: it is not a fixture the oracle can inventory, it is the corpus that
keeps the quoted text honest.
