// The second plugin's mod in the isolation test (#39). It must see a fresh `$`
// with no marker from alpha.ts, and its registrations must not appear in
// alpha's trace.
export function register(on: On): void {
  on('classic.PreToolUse', async ($: Dollar, event: unknown, next: Next) => {
    await $.clock.now()
    const dollar = $ as unknown as Record<string, unknown>
    if (dollar.__anyplugin_owner !== undefined) {
      throw new Error(`beta received a $ already owned by ${String(dollar.__anyplugin_owner)}`)
    }
    dollar.__anyplugin_owner = 'beta'
    return next({ ...(event as Record<string, unknown>), command: 'ls-beta' })
  })
}
