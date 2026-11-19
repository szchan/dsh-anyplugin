#!/usr/bin/env bash
# The first of two matching PostToolUse hooks. Its marker (and the second
# script's) is the evidence that fan-out ran both, not just the first.
set -eu
cat >/dev/null
printf 'first' > "${CLAUDE_PLUGIN_DATA}/first.marker"
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"fanout: first"}}'
