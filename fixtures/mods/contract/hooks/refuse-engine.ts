import type { On } from 'claude-code'

/** `engine.create` has no budget at the pin, so `.catch` on it is refused. */
export function register(on: On): void {
  on('engine.create', () => undefined).catch(() => undefined)
}
