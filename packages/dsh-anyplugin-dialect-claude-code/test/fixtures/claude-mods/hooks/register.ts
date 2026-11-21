// The smallest mod a dialect test needs: the entry imports one sibling module
// so the tree pin covers a nested file, not just the entry.
import { note } from './support/note.js'

export function register(on: On): void {
  on('session.start', async ($: Dollar) => {
    note()
    await $.clock.now()
  })
}
