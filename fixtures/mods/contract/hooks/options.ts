import type { On, PluginOptions } from 'claude-code'

/**
 * Reads the fields the manifest declares. `plugin.json` in this fixture uses
 * the same `instructionFiles` declaration as `agents-md` at the pin, plus one
 * number and one boolean so both other pinned value kinds are exercised.
 */
export function register(on: On, options: PluginOptions): void {
  on('session.start', ($: { report?: (value: unknown) => void }) => {
    if (typeof $.report !== 'function') throw new Error('contract fixture needs $.report')
    $.report({
      keys: Object.keys(options),
      frozen: Object.isFrozen(options),
      instructionFiles: options.instructionFiles,
      instructionFilesType: typeof options.instructionFiles,
      retries: options.retries,
      retriesType: typeof options.retries,
      strict: options.strict,
      strictType: typeof options.strict,
    })
    return { ok: true }
  })
}
