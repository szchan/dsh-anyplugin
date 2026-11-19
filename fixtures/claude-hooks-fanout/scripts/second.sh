#!/usr/bin/env bash
# The second matching PostToolUse hook. Running it after the first is the
# behaviour under test.
set -eu
cat >/dev/null
printf 'second' > "${CLAUDE_PLUGIN_DATA}/second.marker"
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"fanout: second"}}'
