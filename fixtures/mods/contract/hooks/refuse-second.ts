import type { On } from 'claude-code'

/** The pinned Registration takes one `.catch`; a second is refused. */
export function register(on: On): void {
  const registration = on('session.start', () => undefined)
  registration.catch(() => undefined)
  registration.catch(() => undefined)
}
