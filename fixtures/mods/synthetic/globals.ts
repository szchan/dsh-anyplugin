export function register(on: On): void {
  on('globals', () => ({
    process: typeof process,
    url: typeof URL,
    dollar: typeof $,
  }))
}
