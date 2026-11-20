export function register(on: On): void {
  on('first', () => 1)
  on('second', 'matcher-value', ($: Dollar, event: unknown, next: Next) => next(event))
}
