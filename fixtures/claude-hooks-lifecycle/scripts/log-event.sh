#!/usr/bin/env bash
# One observable effect per lifecycle hook: record the payload this handler
# received, then append the event name to the plugin's data directory. The log
# line is written last on purpose — it is the completion marker the oracle waits
# for, so a payload file is always complete when its line exists.
set -eu
payload=$(cat)
mkdir -p "$CLAUDE_PLUGIN_DATA/payloads"
printf '%s\n' "$payload" > "$CLAUDE_PLUGIN_DATA/payloads/$1.json"
printf '%s\n' "$1" >> "$CLAUDE_PLUGIN_DATA/events.log"
