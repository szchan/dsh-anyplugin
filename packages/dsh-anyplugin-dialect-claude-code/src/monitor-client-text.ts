/**
 * The pinned client's own error text for the monitor-declaration shapes the
 * dialect validates.
 *
 * This table is the single source of every client string a monitor refusal
 * quotes. It is not prose: every entry is a slice of a line captured from
 * `claude --plugin-dir <fixture> plugin list` at
 * `@anthropic-ai/claude-code@2.1.329`. The captured lines live in
 * `fixtures/claude-monitors-errors/observed/<shape>.txt`; regenerate them with
 * `node scripts/capture-monitor-errors.mjs` when the pin moves, review the
 * diff, and move this table with it. `monitors.test.mjs` asserts both links:
 * the emitted row contains the rendered entry, and the captured line contains
 * it.
 *
 * Two quirks of the captured bytes are deliberate:
 *
 *   - file-shaped errors are printed as a JSON error list whose quote glyphs
 *     are typographic (`\u201d`, with the JSON backslashes preserved) and whose
 *     single quotes are `\u2019`; manifest-shaped errors use straight quotes.
 *   - a long file-shaped error can be truncated by the CLI's renderer, so the
 *     `when` union entry quotes only the first client message.
 */
export const MONITOR_CLIENT_TEXT = {
  // File-shaped: `Error: monitors load failed from <plugin>: <this text>`
  fileUnknownKey: 'Unrecognized key: \\\u201d{key}\\\u201d',
  fileWhenFormat: 'Invalid string: must start with \\\u201don-skill-invoke:\\\u201d',
  fileWhenShort: 'on-skill-invoke: must specify a skill name',
  fileWhenUnion: 'Invalid input: expected \\\u201dalways\\\u201d',
  fileNotArray: 'Invalid input: expected array, received {shape}',
  fileNotObject: 'Invalid input: expected object, received {shape}',
  fileNotString: 'Invalid input: expected string, received {shape}',
  fileTooSmall: 'Too small: expected string to have >=1 characters',
  fileDuplicateName: 'Monitor names must be unique within a plugin',
  fileInvalidJson: 'JSON Parse error: Expected \u2019}\u2019',
  fileNotRegularFile: 'not a regular file, or too large',
  fileUnreadable: 'EACCES: permission denied, open \u2019{path}\u2019',
  fileMissing: 'ENOENT: no such file or directory, lstat \u2019{path}\u2019',
  // The `plugin list` status for a file-shaped rejection. Manifest-shaped
  // shapes print no Status line at all, so they get no entry here.
  fileStatus: 'Status: ✘ loaded with errors',

  // Manifest-shaped: `… Validation errors: <this text>`
  manifestUnknownKey: 'Unrecognized key: "{key}"',
  manifestWhenFormat: 'Invalid string: must start with "on-skill-invoke:"',
  manifestWhenShort: 'on-skill-invoke: must specify a skill name',
  manifestGeneric: 'Validation errors: monitors: Invalid input',
  manifestTooSmall: 'Too small: expected string to have >=1 characters',
  manifestDuplicateName: 'Monitor names must be unique within a plugin',
  manifestPathPrefix: 'Invalid string: must start with "./"',
} as const

export type MonitorClientTextKey = keyof typeof MONITOR_CLIENT_TEXT

/**
 * Render one captured client message, substituting the values the client
 * itself interpolates (a key name, a shape word, an absolute path).
 */
export function monitorClientText(
  key: MonitorClientTextKey,
  params: Record<string, string | number> = {},
): string {
  const template: string = MONITOR_CLIENT_TEXT[key]
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) throw new Error(`monitor client text ${key} needs {${name}}`)
    return String(params[name])
  })
}
