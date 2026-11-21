// The #75 headless-turn fixture: a mod opens a pane at session.start, draws a
// pinned `Text` tree through its `ui.render` Pane hook, and asks for one more
// drawing with `ui.invalidate('ui.render')`. The drawing counter is in the
// text, so a reread of the tree proves the hook ran again — and `ui-temp`
// is opened and closed in the same turn, so the pane list proves `ui.close`.
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

  on('ui.render', { component: 'Pane' }, ($: any, e: any, next: any) => {
    if (e.requestId !== 'ui-proof') return next(e)
    renders += 1
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column' }, Text({ color: 'green' }, `headless proof ${renders}`))
  })
}
