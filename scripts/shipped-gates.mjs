/**
 * The one list of conformance-gate modules and the one scanner for the shipped
 * `lib/`.
 *
 * The published CLI reaches the Claude oracle, the golden-inventory reader,
 * the IR inventory helpers and the trace differ only from `capture`, `verify`,
 * `diff` and `trace`. Those commands are checkout-only, so the build leaves
 * these modules external and `lib/cli.js` keeps a literal lazy import for each.
 * If one is bundled instead, the tarball silently carries an upstream probe;
 * `check:pack` and the tests both call this scanner, so the rule cannot drift
 * between the packaging config and the gate.
 */

/** Modules the published bin must load lazily; build.mjs externalises each. */
export const GATE_MODULES = ['oracles/claude.ts', 'oracles/file.ts', 'inventory.ts', 'trace.ts']

/**
 * Strings that only appear when a gate module is bundled. `INVENTORY_SCHEMA`
 * is what catches `inventory.ts` and `oracles/file.ts` (which imports it);
 * the other two catch the Claude probe and the trace differ.
 */
export const GATE_MARKERS = ['resolveClaudeBinary', 'claude --version', 'diffTraces', 'INVENTORY_SCHEMA']

/** The kernel entry is the only shipped file that may use `node:vm` modules. */
export const KERNEL_ENTRY = 'lib/materialize/hook.js'

/**
 * Check every shipped JavaScript file plus the CLI's lazy imports.
 *
 * @param {{ path: string, source: string }[]} files
 * @returns {string[]} failures, empty when the artifact is clean
 */
export function lintShippedLib(files) {
  const failures = []
  for (const { path, source } of files) {
    const carried = GATE_MARKERS.filter((marker) => source.includes(marker))
    if (carried.length > 0) failures.push(`${path} carries conformance-gate code: ${carried.join(', ')}`)
    if (path !== KERNEL_ENTRY && source.includes('SourceTextModule')) {
      failures.push(`${path} carries SourceTextModule; only the kernel entry may`)
    }
  }

  const cli = files.find((file) => file.path === 'lib/cli.js')
  for (const module of GATE_MODULES) {
    // esbuild keeps the specifier verbatim for an external relative import.
    if (cli !== undefined && !cli.source.includes(`import("./${module}")`)) {
      failures.push(`lib/cli.js does not load "./${module}" lazily; a packed command would need the conformance gate`)
    }
  }
  return failures
}
