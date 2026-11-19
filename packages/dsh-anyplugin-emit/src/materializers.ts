/**
 * The materializer set this build ships, named once.
 *
 * Two readers need the same answer: `emitPlugin` places a child only when the
 * caller passed the seam, and `rig report` must pass the real set or its
 * "skipped" line is a lie about our own build (S10 review). The map lives here
 * so a new `packages/dsh-anyplugin-materialize-*` is a one-line change; R11 in
 * `scripts/check-architecture.mjs` checks the map against the tree in both
 * directions.
 */
import type { Materializers } from './index.ts'

export const DEFAULT_MATERIALIZERS = {
  skill: 'dsh-anyplugin-materialize-skill',
  agents: 'dsh-anyplugin-materialize-agents',
  mcp: 'dsh-anyplugin-materialize-mcp',
  hooks: 'dsh-anyplugin-materialize-hook',
  // Commands are emitted through the skill materializer's model face today
  // (D10); this package is the human-face half and has no emit child yet, so
  // the key is inert. It stays in the map so R11 can account for every
  // materializer package rather than silently exempting one.
  command: 'dsh-anyplugin-materialize-command',
} as const

/** Absolute module specifier for a sibling materializer package. */
export function materializerUrl(packageName: string): string {
  return new URL(`../../${packageName}/src/index.ts`, import.meta.url).href
}

/** Emit-ready map: surface → the materializer package's entry module. */
export function defaultMaterializers(): Materializers {
  return Object.fromEntries(
    Object.entries(DEFAULT_MATERIALIZERS).map(([surface, packageName]) => [surface, materializerUrl(packageName)]),
  )
}
