// A synthetic mod at the pinned `tool.call` event (issue #69). Its deny must
// stop the call in a real turn; the same turn without the mod must run it.
export function register(on: On): void {
  on('tool.call', { tool: 'Bash' }, async (_$: Dollar, event: unknown, _next: Next) => {
    const envelope = event as { tool: string }
    if (envelope.tool === 'Bash') {
      return { deny: 'the tool.call guard does not allow Bash' }
    }
    return { allow: true }
  })
}
