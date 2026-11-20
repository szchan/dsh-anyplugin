// A synthetic mod at the pinned `tool.check` event (issue #69). The route is a
// measured refusal, so this handler must never be invoked: it would deny, and
// the turn's Bash call must still run.
export function register(on: On): void {
  on('tool.check', async () => ({ decision: 'deny', reason: 'the tool.check handler was invoked' }))
}
