/**
 * The program name the user actually typed.
 *
 * The published `bin` is `dsh-anyplugin`; the conformance rig keeps its
 * historical `rig` spelling so a checkout's output and its documentation stay
 * stable. Deriving the name once, here, keeps `--help` and refusal hints
 * honest in both places instead of hard-coding one of them into shared text.
 */
import { basename } from 'node:path'

/**
 * `invoked` is `process.argv[1]` by default. An installed bin is reached
 * through its symlink, so `basename` is already `dsh-anyplugin`; the
 * packed-artifact gate and a direct `node lib/cli.js` show `cli.js`.
 */
export function invokedProgramName(invoked: string | undefined = process.argv[1]): string {
  if (invoked === undefined) return 'rig'
  const name = basename(invoked)
  if (name === 'rig.ts') return 'rig'
  if (name === 'cli.js' || name === 'cli.ts' || name === 'dsh-anyplugin') return 'dsh-anyplugin'
  return 'rig'
}

export const PROGRAM = invokedProgramName()
