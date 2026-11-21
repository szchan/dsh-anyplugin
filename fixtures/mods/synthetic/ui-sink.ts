// The #75 headless-turn fixture: a mod opens a pane at session.start, draws a
// pinned `Text` tree through its `ui.render` Pane hook, and asks for one more
// drawing with `ui.invalidate('ui.render')`. The drawing counter is in the
// text, so a reread of the tree proves the hook ran again — and `ui-temp`
// is opened and closed in the same turn, so the pane list proves `ui.close`.
// The tree hook's matcher names `props`, and a wildcard `ui.*` hook wraps the
// chain, so one turn proves the pin's matcher grammar and pattern dispatch
// rather than an exact event-name string compare.
// Nothing draws: the sink records and the `mod_ui` tool reads back.
let renders = 0

export function register(on: any): void {
  on('session.start', async ($: any, event: any, next: any) => {
    $.ui.status('ui sink proof')
    $.ui.log('ui sink proof', { to: 'debug' })
    $.ui.invalidate('ui.render')
    await $.ui.open({ id: 'ui-proof', title: 'UI proof' })
    await $.ui.open({ id: 'ui-temp' })
    await $.ui.close({ id: 'ui-temp' })
    $.ui.invalidate('ui.render')
    return next(event)
  })

  // A pattern, not an event name: the sink dispatches through the kernel, so
  // the same glob expansion the classic chain uses selects this hook.
  on('ui.*', ($: any, event: any, next: any) => {
    if (typeof event?.requestId === 'string') $.ui.log(`ui.* render ${event.requestId}`)
    return next(event)
  })

  // `isFocused` is false in the sink's Pane props, so the pin's matcher
  // grammar must not run this hook. If it ever did, the log would say so.
  on('ui.render', { component: 'Pane', props: { isFocused: true } }, ($: any, event: any, next: any) => {
    $.ui.log(`props miss ${event.requestId}`)
    return next(event)
  })

  // The pin's `props` leaf is a partial match over the request props
  // (claude-code.d.ts:7460-7545 @ 2.1.329); the title matches, so this hook runs.
  on('ui.render', { component: 'Pane', props: { title: 'UI proof' } }, ($: any, event: any, next: any) => {
    if (event.requestId !== 'ui-proof') return next(event)
    renders += 1
    const { Box, Text } = $.ui.resolve(event)
    return Box({ flexDirection: 'column' }, Text({ color: 'green' }, `headless proof ${renders}`))
  })
}
