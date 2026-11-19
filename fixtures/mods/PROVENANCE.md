# Mod fixtures: provenance

The mod scanner is tested against the mods that ship with Claude Code. Their
source is **not** copied into this repository: upstream `LICENSE.md` says
"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial
Terms of Service." Tests fetch the file at run time and skip with a recorded
reason when the network is unavailable (D14, D21).

## Pin

| Repository | Tag | Commit | License |
| --- | --- | --- | --- |
| https://github.com/anthropics/claude-code | `v2.1.322` | `6e1e44f6433bfa17d198e932bff53373aa229eea` | Upstream `LICENSE.md`, all rights reserved |

## Files read

| Path at the pin | Bytes | Used by |
| --- | --- | --- |
| `mods/diff/hooks/register.ts` | 33,891 | `packages/dsh-anyplugin-conformance/test/mod-scan.test.mjs` |

The scanner's ticket (issue #2) and ARCHITECTURE §7.3 call this file
`mods/diff/register.ts`. At the pin that path does not exist: `mods/diff/` has
`.claude-plugin/`, `README.md`, `hooks/` and `tests/`, and the register file is
under `hooks/`. The test pins the real path above. Anything that re-pins must
check the path again rather than trusting the ticket text.

## Re-pinning

1. Choose the new tag and resolve it to a commit (`git ls-remote --tags`, or the
   GitHub API).
2. Fetch the same path at that commit and confirm it still exists.
3. Update the commit in `packages/dsh-anyplugin-conformance/test/mod-scan.test.mjs`
   and the pinned counts only after reviewing the capability-list diff.
4. Update this table in the same commit. A fidelity claim without a recorded
   revision is not a claim (AGENTS.md §3.8).

No upstream source is vendored here. Do not add one.
