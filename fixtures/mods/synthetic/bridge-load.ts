// Records what `$.session` looks like at load-time session.start. There is no
// agent yet (D32 §4), so the bridge must answer `messages() === []` and an
// empty `usage` object rather than inventing figures. It calls `usage()` twice
// so the test can prove the host reports each missing field once per load, not
// once per call.
const seen: Record<string, unknown> = {}
let done = false

export function register(on: any): void {
  on('session.start', async ($: any, event: any, next: any) => {
    if (done) return next(event)
    done = true
    try {
      seen.messages = await $.session.messages()
      seen.usageFirst = await $.session.usage()
      seen.usageSecond = await $.session.usage()
      try {
        await $.session.id()
        seen.id = 'ran'
      } catch (error) {
        seen.id = { code: (error as { code?: unknown }).code }
      }
      await $.store.set('bridge-load', seen)
    } catch (error) {
      await $.store.set('bridge-load', {
        failed: true,
        code: (error as { code?: unknown }).code,
        message: (error as Error).message,
      })
    }
    return next(event)
  })
}
