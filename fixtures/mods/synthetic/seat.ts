// The seated-mod fixture (#39): a load-time session.start and a tool rewrite
// that depends on the session it is running in.
//
// `session.start` proves the loader point fires before the first turn. The
// PreToolUse handler reads the agent's own message log through `$.session`, so
// a leak between two agents is observable in the rewrite the tool receives:
// the first root's call becomes `ls-first`, the second root's `ls-second`.
export function register(on: On): void {
  on('session.start', async ($: Dollar, event: unknown, next: Next) => {
    await $.clock.now()
    return next(event)
  })

  on('classic.PreToolUse', async ($: Dollar, event: unknown, next: Next) => {
    const envelope = event as { tool: string; command: string }
    const messages = (await $.session.messages()) as Array<{
      content?: Array<{ type?: string; text?: string }>
    }>
    const text = messages
      .flatMap((message) => message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join(' ')
    if (envelope.tool !== 'Bash' || !String(envelope.command).startsWith('ls')) {
      throw new Error(`unexpected PreToolUse envelope: ${JSON.stringify(envelope)}`)
    }
    const marker = text.includes('second') ? 'second' : 'first'
    return next({ ...envelope, command: `ls-${marker}` })
  })
}
