// The transcript fixture (#46): proves `$.session.messages()` carries the
// tool-result turn in the pinned shape, not just user/assistant text.
//
// DSH stores a tool result as its own `role: 'tool'` message. The pinned
// `SessionMessage` is a user message whose `toolResults` array holds the
// result block (d.ts:9260), and the assistant `toolUses` entry carries the
// observed `text`/`isError` once it exists (d.ts:10515). The same transcript is
// recorded at PostToolUse (the result has landed) and at Stop (the turn is
// over), so a mapper that drops the result message fails both points.
export function register(on: On): void {
  for (const event of ['classic.PostToolUse', 'classic.Stop'] as const) {
    on(event, async ($: Dollar, payload: unknown, next: Next) => {
      const key = event === 'classic.PostToolUse' ? 'transcript-post' : 'transcript-stop'
      await $.store.set(key, await $.session.messages())
      return next(payload)
    })
  }
}
