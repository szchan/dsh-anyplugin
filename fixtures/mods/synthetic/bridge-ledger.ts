// The #46 ledger fixture: calls all 23 `$` sites the pinned `mods/diff` calls,
// in `scanModSource` order, and records `ran` or `refused:<code>` per site.
// The rows land in the bridge's durable store so the conformance test can read
// the exact order back after the turn.
const rows: string[] = []
let done = false

async function record(label: string, run: () => unknown): Promise<void> {
  try {
    await run()
    rows.push(`${label}:ran`)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    rows.push(`${label}:refused:${typeof code === 'string' ? code : 'UNKNOWN'}`)
  }
}

export function register(on: any): void {
  on('classic.PreToolUse', async ($: any, event: any, next: any) => {
    if (done) return next(event)
    done = true

    await record('clock.now', () => $.clock.now())
    await record('clock.after', () => {
      const timer = $.clock.after(60_000, () => {})
      timer.cancel()
    })
    await record('clock.every', () => {
      const timer = $.clock.every(60_000, () => {})
      timer.cancel()
    })
    await record('process.run', () => $.process.run(['git', '--version']))
    await record('fs.stat', () => $.fs.stat('ledger.txt'))
    await record('fs.list', () => $.fs.list('.'))
    await record('fs.read', () => $.fs.read('ledger.txt'))
    await record('store.get', () => $.store.get('bridge-seed'))
    await record('store.set', () => $.store.set('bridge-seed', { ok: true }))
    await record('settings.read', () => $.settings.read())
    await record('env.get', () => $.env.get('PATH'))
    await record('session.messages', () => $.session.messages())
    await record('ui.invalidate', () => $.ui.invalidate('ui.render'))
    await record('ui.status', () => $.ui.status('ledger'))
    await record('ui.log', () => $.ui.log('ledger'))
    await record('ui.open', () => $.ui.open({ id: 'ledger' }))
    await record('ui.close', () => $.ui.close({ id: 'ledger' }))
    await record('command.register', () => $.command.register({
      name: 'bridge-ledger',
      description: 'the #46 synthetic ledger',
    }))
    await record('session.id', () => $.session.id())
    await record('session.usage', () => $.session.usage())
    await record('telemetry.mark', () => $.telemetry.mark({ site: 'mark' }))
    await record('telemetry.log', () => $.telemetry.log({ site: 'log' }))
    await record('ui.resolve', () => $.ui.resolve({ surface: 'terminal', component: 'Pane' }))

    await $.store.set('bridge-ledger', rows)
    return next(event)
  })
}
