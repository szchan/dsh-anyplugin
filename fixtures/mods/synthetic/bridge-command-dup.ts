// Proves `command.register` reaches the shared DSH registry: the ledger fixture
// already registered `bridge-ledger`, so this mod's attempt must be a typed
// duplicate attributed to this mod, not a silent replacement.
export function register(on: any): void {
  on('classic.PreToolUse', async ($: any, event: any, next: any) => {
    try {
      await $.command.register({ name: 'bridge-ledger', description: 'duplicate' })
      await $.store.set('bridge-duplicate', { code: 'ran' })
    } catch (error) {
      await $.store.set('bridge-duplicate', {
        code: (error as { code?: unknown }).code,
        message: (error as Error).message,
      })
    }
    return next(event)
  })
}
