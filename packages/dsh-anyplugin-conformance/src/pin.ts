/**
 * The upstream versions this rig compares against.
 *
 * A pin is part of the claim (AGENTS.md §3.8): every golden is captured at one
 * named version and a run at another version must not look like a pass. The
 * constant here is the one place the version lives, so the CI fetch, the guard
 * and the tests cannot drift apart — bumping the pin is one edit plus a golden
 * recapture (D8, D24).
 */

/** The npm package the upstream oracle's binary comes from. */
export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code'

/** The Claude Code release every `.inventory/claude-code@<version>.json` was captured at. */
export const CLAUDE_CODE_PIN = { tool: 'claude-code', version: '2.1.322' } as const
