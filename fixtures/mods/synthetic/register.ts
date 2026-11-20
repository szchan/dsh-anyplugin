import { answer, self } from './ask'
import { label } from './value.js'

// The published diff mod's `bind()` shape, minus the drawing: read usage, fall
// back to clock.now, register the command, then read messages. The three
// imports above prove the resolver's three behaviors at the same time.
export function register(on: On): void {
  on('session.start', async ($: Dollar, event: unknown, next: Next) => {
    const usage = await $.session.usage()
    const startedAt = usage?.startedAt ?? (await $.clock.now())
    await $.command.register({
      name: 'diff',
      description: `${label}:${answer}:${self.answer}:${startedAt}`,
    })
    await $.session.messages()
    return next(event)
  })
}
