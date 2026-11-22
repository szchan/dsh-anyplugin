#!/usr/bin/env node
// Spike S22 monitor body. The host is supposed to spawn this once and deliver
// each stdout line to the model as a task notification. Everything it can
// observe about its own life (start time, cwd, inherited plugin env, ticks,
// signals, exit) is appended to $S22_LOG as one JSON object per line, and the
// bytes it emits go to stdout/stderr so a capture can prove whether they ever
// reached the model.
//
// Usage (from a monitors.json command): monitor.mjs <label> <intervalMs> <lines>
import { appendFileSync } from 'node:fs'

const [label = 'monitor', intervalArg = '250', linesArg = '40'] = process.argv.slice(2)
const interval = Number(intervalArg)
const lines = Number(linesArg)
const logPath = process.env.S22_LOG
const startedAt = Date.now()

// Never write a credential into a trace: the client hands its whole env to a
// monitor, and the spike must not copy ANTHROPIC_AUTH_TOKEN anywhere.
const safeEnv = () => {
  const picked = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|KEY|SECRET|AUTH|PASSWORD/i.test(key)) continue
    if (key.startsWith('CLAUDE') || key === 'PWD' || key === 'HOME' || key === 'S22_LOG' || key === 'S22_MARKER') {
      picked[key] = value
    }
  }
  return picked
}

const log = (record) => {
  if (logPath === undefined || logPath === '') return
  appendFileSync(logPath, `${JSON.stringify({
    t: new Date().toISOString(),
    sinceStartMs: Date.now() - startedAt,
    pid: process.pid,
    ppid: process.ppid,
    label,
    ...record,
  })}\n`)
}

log({
  src: 'monitor',
  event: 'start',
  cwd: process.cwd(),
  argv: process.argv,
  execPath: process.execPath,
  node: process.version,
  env: safeEnv(),
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    log({ src: 'monitor', event: 'signal', signal })
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  })
}
process.on('exit', (code) => log({ src: 'monitor', event: 'exit', code }))

// A monitor is meant to outlive a turn. Emit the scripted beats, then idle
// until the host kills us (or the TTL fires so a broken host cannot leave a
// process behind forever).
const ttl = setTimeout(() => {
  log({ src: 'monitor', event: 'ttl-exit', ttlMs: 120_000 })
  process.exit(0)
}, 120_000)

for (let n = 1; n <= lines; n += 1) {
  await new Promise((resolve) => setTimeout(resolve, interval))
  const t = new Date().toISOString()
  process.stdout.write(`S22_MON ${label} ${n} ${t} pid=${process.pid}\n`)
  process.stderr.write(`S22_MON_STDERR ${label} ${n} ${t}\n`)
  log({ src: 'monitor', event: 'tick', n, emittedAt: t })
}
log({ src: 'monitor', event: 'beats-done', lines })
clearTimeout(ttl)
// Idle without keeping the event loop busy: the TTL timer above is what keeps
// the process alive now.
setTimeout(() => {
  log({ src: 'monitor', event: 'idle-timeout' })
  process.exit(0)
}, 120_000)
