// #134: the pin declares `$.session.cwd: () => Promise<string>`
// (claude-code.d.ts:3339 @ 2.1.329). A load that found a live root seats that
// agent for the session.start invocation, so this handler calls the method and
// stores both its kind and the resolved directory. The conformance test reads
// the store back and asserts the pin's callable shape and the live session's
// own cwd, not the host process's.
export function register(on: any): void {
  on('session.start', async ($: any, event: any, next: any) => {
    const seen: Record<string, unknown> = { kind: typeof $.session.cwd }
    try {
      seen.cwd = await $.session.cwd()
    } catch (error) {
      seen.code = (error as { code?: unknown }).code
    }
    await $.store.set('session-cwd', seen)
    return next(event)
  })
}
