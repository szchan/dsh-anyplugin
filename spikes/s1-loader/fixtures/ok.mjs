// S1 fixture: a plugin that applies cleanly and records its own lifecycle.
// Everything is reported through globalThis.__S1__ so the harness can observe
// ordering without reaching into cordis internals.
//
// NOTE: cordis has no `'dispose'` event — teardown is `ctx.effect(execute)`
// where `execute` returns the disposer. That is itself an S1 finding.
export const name = 's1-ok'

export default function s1ok(ctx, config) {
  const rec = (globalThis.__S1__ ??= { events: [] })
  const tag = config?.tag ?? 'anonymous'
  const id = ctx.fiber?.entry?.id ?? null
  ctx.effect(() => {
    rec.events.push({ type: 'apply', tag, id })
    return () => rec.events.push({ type: 'dispose', tag, id })
  })
}
