#!/usr/bin/env node
// Spikes only: record the exact stdin a real Claude Code hands a hook.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const label = process.argv[2] ?? 'unknown'
const dir = process.env.ANYPLUGIN_CAPTURE_DIR
if (!dir) {
  process.stderr.write('ANYPLUGIN_CAPTURE_DIR is not set\n')
  process.exit(1)
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk

const record = {
  label,
  argv: process.argv.slice(2),
  env: {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? null,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
  },
  cwd: process.cwd(),
  raw,
  payload: safeParse(raw),
}
mkdirSync(dir, { recursive: true })
appendFileSync(join(dir, `${label}.jsonl`), JSON.stringify(record) + '\n')

// Say nothing: an empty exit-0 hook must be a no-op for the harness.
process.exit(0)

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
