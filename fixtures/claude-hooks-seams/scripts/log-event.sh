#!/usr/bin/env bash
# One observable effect per lifecycle hook: record the payload this handler
# received, then append the event name to the plugin's data directory. The log
# line is written last on purpose — it is the completion marker the oracle waits
# for, so a payload file is always complete when its line exists.
set -eu
payload=$(cat)
mkdir -p "$CLAUDE_PLUGIN_DATA/payloads"
printf '%s\n' "$payload" > "$CLAUDE_PLUGIN_DATA/payloads/$1.json"
# CwdChanged fires several times on the probe run, and its payloads are the
# directories themselves: keep every one, so a count that comes up short names
# the record that is missing instead of only the number that is short.
if [ "$1" = "CwdChanged" ]; then
  printf '%s\n' "$payload" >> "$CLAUDE_PLUGIN_DATA/payloads/CwdChanged.jsonl"
fi
printf '%s\n' "$1" >> "$CLAUDE_PLUGIN_DATA/events.log"
