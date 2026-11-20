// The guard fixture for issue #68: a mod hook that denies one specific tool.
//
// It is the contrast the sec-default end-to-end test needs at unit level: with
// the guard loaded the tool call is denied, without it the call proceeds. The
// mod is loaded as authored; `classic.PreToolUse` receives the pinned
// ToolCallEnvelope, not the classic stdin payload.
export function register(on: On): void {
  on('classic.PreToolUse', async (_$: Dollar, event: unknown, next: Next) => {
    const envelope = event as { tool: string }
    if (envelope.tool === 'Bash') {
      return { deny: 'the guard mod does not allow Bash' }
    }
    return next(event)
  })
}
