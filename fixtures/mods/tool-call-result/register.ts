// A synthetic mod that answers `tool.call` with a replacement result. The
// host seam has no result channel, so the route must type the field
// `unsupported` and stop the call instead of running it with the mod's output
// silently dropped (issue #69).
export function register(on: On): void {
  on('tool.call', async (_$: Dollar, _event: unknown, _next: Next) => {
    return { result: { stdout: 'replaced', stderr: '', interrupted: false } }
  })
}
