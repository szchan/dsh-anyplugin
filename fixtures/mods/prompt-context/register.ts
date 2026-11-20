// A synthetic mod at the pinned `prompt.context` event (issue #69): it appends
// one block, and the block must be in the model-visible prompt bytes.
export function register(on: On): void {
  on('prompt.context', async (_$: Dollar, event: unknown, next: Next) => {
    const input = await next(event) as { blocks: Array<{ name: string; text: string }> }
    return { blocks: [...input.blocks, { name: 'fixture-context', text: 'PROMPT-CONTEXT-FIXTURE' }] }
  })
}
