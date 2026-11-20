import type { On } from 'claude-code'

/**
 * Catches a throw from the authored hook. The pin gives the catch handler a
 * `N & Caught`: `next.called` before replay, `next.error` as frozen data, and
 * a replay that returns the last `next` result without running beneath again.
 */
export function register(on: On): void {
  on('session.start', async (_$, event, next) => {
    await next(event)
    throw new Error('mod-authored boom')
  }).catch(async ($: { report?: (value: unknown) => void }, _event, next: any) => {
    if (typeof $.report !== 'function') throw new Error('contract fixture needs $.report')
    const calledBefore = next.called
    const replayed = await next({ ignored: true })
    $.report({
      kind: next.error.kind,
      message: next.error.message,
      budget: next.error.budget,
      frozenError: Object.isFrozen(next.error),
      calledBefore,
      calledAfter: next.called,
      replayed,
    })
    return { caught: true }
  })
}
