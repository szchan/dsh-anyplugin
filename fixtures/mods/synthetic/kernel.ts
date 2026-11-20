// The shared-chain fixture (#36): the mod half of one runChain trace.
//
// The adapter maps these `classic.*` names onto the kernel's classic points, so
// a classic settings hook on the same host event and this mod run in one chain.
// `classic.PreToolUse` receives ToolCallEnvelope (d.ts:10081-10093), not the
// classic stdin payload; the adapter rebuilds it and turns the rewrite back.
export function register(on: On): void {
  on('classic.PreToolUse', async ($: Dollar, event: unknown, next: Next) => {
    const envelope = event as { tool: string; tool_use_id: string; command: string }
    await $.clock.now()
    if (envelope.tool !== 'Bash' || envelope.tool_use_id !== 'toolu_1' || envelope.command !== 'ls') {
      throw new Error(`unexpected PreToolUse envelope: ${JSON.stringify(envelope)}`)
    }
    return next({ ...envelope, command: 'ls -la' })
  })

  on('classic.PostToolUse', async ($: Dollar, event: unknown, next: Next) => {
    const payload = event as Record<string, unknown>
    await $.session.messages()
    return next({ ...payload, mod_marker: 'seen' })
  })
}
