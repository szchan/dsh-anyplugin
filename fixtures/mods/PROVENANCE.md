# Mod fixtures: provenance

The mod scanner is tested against the mods that ship with Claude Code. Their
source is **not** copied into this repository: upstream `LICENSE.md` says
"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial
Terms of Service." Tests fetch the file at run time and skip with a recorded
reason when the network is unavailable (D14, D21).

## Pin

| Repository | Tag | Commit | License |
| --- | --- | --- | --- |
| https://github.com/anthropics/claude-code | `v2.1.329` | `f9e4d1e5753ccffcffdd832f047d72be000396a6` | Upstream `LICENSE.md`, all rights reserved |

## Files read

| Path at the pin | Bytes | Used by |
| --- | --- | --- |
| `mods/agents-md/hooks/register.ts` | 10,006 | `fixtures/mods/upstream.json`, `packages/dsh-anyplugin-conformance/test/upstream-mods.test.mjs` |
| `mods/diff/hooks/register.ts` | 35,661 | `fixtures/mods/diff/fixture.json`, `packages/dsh-anyplugin-conformance/test/{mod-scan,mods}.test.mjs`, `packages/dsh-anyplugin-mod-host/test/diff-mod.test.mjs` |
| `mods/easel/hooks/register.ts` | 7,106 | `fixtures/mods/upstream.json`, `packages/dsh-anyplugin-conformance/test/upstream-mods.test.mjs` |
| `mods/hipaa-default/hooks/register.ts` | 1,290 | `fixtures/mods/upstream.json`, `packages/dsh-anyplugin-conformance/test/upstream-mods.test.mjs` |
| `mods/privacy/hooks/register.ts` | 3,894 | `fixtures/mods/upstream.json`, `packages/dsh-anyplugin-conformance/test/upstream-mods.test.mjs` |
| `mods/sec-default/hooks/register.ts` | 21,900 | `fixtures/mods/upstream.json`, `packages/dsh-anyplugin-conformance/test/upstream-mods.test.mjs` |
| `mods/telemetry/hooks/register.ts` | 13,933 | `fixtures/mods/upstream.json`, `packages/dsh-anyplugin-conformance/test/upstream-mods.test.mjs` |

The scanner's ticket (issue #2) and ARCHITECTURE §7.3 call the diff file
`mods/diff/register.ts`. At the pin that path does not exist: `mods/diff/` has
`.claude-plugin/`, `README.md`, `hooks/` and `tests/`, and the register file is
under `hooks/`. The tests pin the real path above. Anything that re-pins must
check the path again rather than trusting the ticket text.

At 2.1.329 `sec-default` **loads** after the D38 resolver fallback:
`policy/names-org-tool.ts` and
`policy/managed-tools-restored/managed-tools-restored.ts` import
`./reads-as-org-tool` without an extension, and that path is a *file*. D30's
resolver served only a directory index, so the host refused with
`ERR_MOD_HOST_MISSING` — our gap, since upstream's loader serves the file.
The host now tries `<spec>.ts`, `<spec>.tsx`, `<spec>/index.ts`,
`<spec>/index.tsx` in that order (file before directory; D38 proposal), and
the row records the observed **45 registrations**. No row is refused at this
pin.

## Re-pinning

1. Choose the new tag and resolve it to a commit (`git ls-remote --tags`, or the
   GitHub API).
2. Fetch `mods/` at that commit and confirm the entry paths still exist and the
   mod set is what the table claims.
3. Update the commit, entry hashes, tree hash and counts in
   `packages/dsh-anyplugin-mod-host/src/pin.ts`; `scripts/fetch-mod.mjs`
   verifies the fetched tree against them.
4. Re-run the seven-mod measurement and update `fixtures/mods/upstream.json`:
   loaded rows carry the observed registrations; a refused row carries the
   exact host `code`, the file, and the message. Review the scanner diff before
   touching counts.
5. Update this table in the same commit. A fidelity claim without a recorded
   revision is not a claim (AGENTS.md §3.8).

No upstream source is vendored here. Do not add one.
