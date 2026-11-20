import type { On, PluginOptions } from 'claude-code'

/** The manifest's required `channel` has no activation value; the load refuses. */
export function register(on: On, options: PluginOptions): void {
  void options.channel
  on('session.start', () => undefined)
}
