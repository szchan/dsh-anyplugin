/**
 * Build-time stand-in for `dsh-anyplugin-mod-host` in the 0.1.0 package.
 *
 * The mods kernel (Claude's `mods/*.ts` loaded as authored, the `$` bridges,
 * the event adapters) is a v0.2 surface. Shipping the real host would bundle
 * `@babel/core` and the `.tsx` transform into a release that does not claim
 * mods, so the hook materializer is built against this stub instead.
 *
 * The classic-hook path never calls these functions — the emitter does not put
 * mods in a 0.1 config — but a hand-written entry can. In that case `loadMod`
 * throws, the materializer records a warning and keeps the classic hooks, and
 * `createModBridge`/`commandRegistryFromContext` only have to satisfy the
 * shapes the branch touches before the throw.
 */
export function createModBridge() {
  return {
    dispose() {},
    dollar: async () => ({}),
  }
}

export function commandRegistryFromContext() {
  return []
}

export async function loadMod() {
  throw new Error('mods are not available in dsh-anyplugin 0.1.0; the mods kernel ships in v0.2')
}
