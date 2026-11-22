// #134: the pin declares `$.session.cwd: () => Promise<string>`
// (claude-code.d.ts:3339 @ 2.1.329). A load that found a live root seats that
// agent for the session.start invocation, so this handler calls the method,
// records whether the raw return is a thenable, and stores the resolved
// directory. The conformance test reads the store back and asserts the pin's
// callable *and* async shape and the live session's own cwd, not the host
// process's: `await` alone would also accept a bare string.
export function register(on: any): void {
  on('session.start', async ($: any, event: any, next: any) => {
    const seen: Record<string, unknown> = { kind: typeof $.session.cwd }
    try {
      const answer = $.session.cwd()
      seen.promise = typeof (answer as { then?: unknown } | null)?.then === 'function'
      seen.cwd = await answer
    } catch (error) {
      seen.code = (error as { code?: unknown }).code
    }
    await $.store.set('session-cwd', seen)
    return next(event)
  })
}
