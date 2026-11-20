import type { On } from 'claude-code'

/** A `.catch` value that is not a handler is refused at registration. */
export function register(on: On): void {
  ;(on('session.start', () => undefined) as { catch(handler: unknown): void }).catch(null)
}
