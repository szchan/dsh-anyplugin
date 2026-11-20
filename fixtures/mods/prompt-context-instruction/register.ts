// A synthetic mod at the pinned `prompt.context` event (issue #69). It returns
// the result's `instructionFiles` half directly, not through next(e), so the
// route's unsupported-field record is exercised on the direct-return path.
export function register(on: On): void {
  on('prompt.context', async (_$: Dollar) => ({
    blocks: [{ name: 'direct-context', text: 'DIRECT-PROMPT-CONTEXT' }],
    instructionFiles: [{ path: 'CLAUDE.md', kind: 'project', content: 'direct instructions' }],
  }))
}
