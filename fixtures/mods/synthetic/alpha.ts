// One of two plugins' mods in the isolation test (#39). Each handler gets the
// `$` its own plugin host built for this invocation; a `$` shared across
// plugin entries would carry this marker into beta.ts and fail its check.
export function register(on: On): void {
  on('classic.PreToolUse', async ($: Dollar, event: unknown, next: Next) => {
    await $.clock.now()
    const dollar = $ as unknown as Record<string, unknown>
    if (dollar.__anyplugin_owner !== undefined) {
      throw new Error(`alpha received a $ already owned by ${String(dollar.__anyplugin_owner)}`)
    }
    dollar.__anyplugin_owner = 'alpha'
    return next({ ...(event as Record<string, unknown>), command: 'ls-alpha' })
  })
}
