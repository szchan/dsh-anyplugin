// A rewrite that is not lossless JSON: `undefined` cannot survive
// JSON.stringify, so the seat must report a typed unsupported and run the
// original arguments, never silently drop the rewrite.
export function register(on: On): void {
  on('classic.PreToolUse', async ($: Dollar, event: unknown, next: Next) => {
    await $.clock.now()
    const envelope = event as Record<string, unknown>
    return next({ ...envelope, command: undefined })
  })
}
