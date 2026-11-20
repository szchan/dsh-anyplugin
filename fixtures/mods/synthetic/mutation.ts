// Isolation fixture: each handler writes to `$` and the next one reads. The
// host must ask its ModHost for a namespace per invocation; if it reused one,
// the second handler would observe `$.count === 1`.
export function register(on: On): void {
  on('first', ($: Dollar) => {
    $.count = 1
  })
  on('second', ($: Dollar) => $.count)
}
