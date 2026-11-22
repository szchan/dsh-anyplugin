#!/usr/bin/env node
// Spike S22 hook body. It writes the same file as monitor.mjs, so one trace
// interleaves host events (session start, tool use, turn end) with whatever a
// monitor did. For PreToolUse it also reads the session transcript and counts
// monitor markers already in it: that is how the spike answers "is a monitor
// line visible to a hook, in the same step or a later one".
//
// It must stay silent on stdout: hook stdout is parsed by the host.
import { appendFileSync, readFileSync, statSync } from 'node:fs'

const logPath = process.env.S22_LOG
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const raw = Buffer.concat(chunks).toString('utf8')

const record = {
  t: new Date().toISOString(),
  src: 'hook',
  arg: process.argv[2] ?? null,
  rawBytes: Buffer.byteLength(raw),
}

try {
  const payload = JSON.parse(raw)
  record.event = payload.hook_event_name ?? 'unknown'
  record.sessionId = payload.session_id
  record.cwd = payload.cwd
  record.promptId = payload.prompt_id
  record.toolName = payload.tool_name
  record.stdin = payload

  if (typeof payload.transcript_path === 'string') {
    try {
      const stat = statSync(payload.transcript_path)
      const text = readFileSync(payload.transcript_path, 'utf8')
      record.transcript = {
        path: payload.transcript_path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        bytes: Buffer.byteLength(text),
        monitorMentions: (text.match(/S22_MON/g) ?? []).length,
      }
    } catch (error) {
      record.transcriptError = String(error)
    }
  }
} catch (error) {
  record.event = 'unparseable'
  record.parseError = String(error)
  record.raw = raw
}

if (logPath !== undefined && logPath !== '') {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`)
}
