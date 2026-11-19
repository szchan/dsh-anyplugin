#!/usr/bin/env bash
# A formatter hook, reduced to what this fixture can observe: it reads the
# PostToolUse payload from stdin and answers with one line of model context.
# Upstream does not run this (the tool schemas are resolved at runtime and the
# component list is captured without executing hooks), so the JSON is what the
# behavioural probe looks for, not something the golden inventory records.
cat >/dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"anyplugin-hook: PostToolUse fired"}}'
