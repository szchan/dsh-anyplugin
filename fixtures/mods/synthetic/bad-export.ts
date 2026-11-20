// Link-time failure: `value.ts` exports `label`, not `nope`. ESM resolves
// named imports during link(), before evaluation, so this must surface as a
// host error rather than a raw SyntaxError escaping the four-code taxonomy.
import { nope } from './value.js'

export function register(on: On): void {
  on('session.start', () => {
    void nope
  })
}
