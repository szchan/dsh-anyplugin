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

File-shaped shapes also have a `<shape>.status.txt` holding the
`Status: ✘ loaded with errors` line the client prints for the plugin.
Manifest-shaped shapes print no `Status:` line (the plugin never loads), so
they have no status file and the dialect quotes none.

`node scripts/capture-monitor-errors.mjs --check` re-runs all shapes into a
temporary directory and diffs against this corpus. The conformance suite runs
that check against the pinned CLI on every `npm run verify`, so a pin bump that
changes a byte fails with the file's name instead of leaving this corpus stale.
