# Provenance — the client's monitor error lines

`observed/<shape>.txt` is one line printed by the pinned Claude Code client
when it loads a plugin whose monitor declaration the client rejects.
`<plugin>` replaces the throwaway plugin directory; nothing else is edited.

- Pinned client: `@anthropic-ai/claude-code@2.1.329` (the native binary the
  conformance suite resolves through `CLAUDE_CODE_PIN`; D24). No model call is
  made — `claude --plugin-dir <dir> plugin list` only loads the plugin and
  prints the loader's verdict.
- Capture command:

  ```bash
  CLAUDE_BIN=<pin>/claude node scripts/capture-monitor-errors.mjs
  ```

  The script builds the 29 shapes under `captured/` (gitignored, like every
  `fixtures/**/captured/` drop zone, AGENTS.md §8), runs the client, scrubs the
  temp path and writes `observed/<shape>.txt`. Review the diff before
  committing it.
- Source of truth: `packages/dsh-anyplugin-dialect-claude-code/src/monitor-client-text.ts`
  quotes these lines; `packages/dsh-anyplugin-dialect-claude-code/test/monitors.test.mjs`
  asserts every rendered table entry is a substring of the matching observed
  line, so a fabricated string cannot pass.
- Two verdicts are represented:
  - file-shaped (`Error: monitors load failed from …:`), where the plugin loads
    with errors and keeps serving its other components;
  - manifest-shaped (`✘ Failed to load plugin: … Validation errors: …`), where
    the plugin does not load at all.
