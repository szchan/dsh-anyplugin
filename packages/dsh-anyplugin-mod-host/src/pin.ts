/**
 * The pinned upstream mod the differential test loads (D30 / S13).
 *
 * This is the one artifact the host is measured against: `register.ts` from the
 * `diff` mod of Claude Code 2.1.322. The bytes and hash make "loads the diff
 * mod" a claim about one file, not about whatever upstream's `main` is today.
 * `scripts/fetch-mod.mjs` checks the pin; the tests only read the fetched tree.
 *
 * The `.ts` / `.tsx` counts are S13's measurements of this directory (579 / 21);
 * they make a partial or pruned checkout fail loudly instead of shrinking the
 * graph silently.
 */
export const DIFF_MOD_PIN = {
  version: '2.1.322',
  commit: '6e1e44f6433bfa17d198e932bff53373aa229eea',
  /** Repository-relative directory holding the mod (its root is the entry's dir). */
  directory: 'mods/diff/hooks',
  /** Entry, relative to the fetched mod root. */
  entry: 'register.ts',
  entryBytes: 33_891,
  entrySha256: 'cce8adf7b3218f33347707ffbfb25ff3294c184d440dfb49fa540656146debab',
  /** S13: .ts modules in the directory (reachable and not). */
  tsFiles: 579,
  /** S13: .tsx modules in the directory; the host refuses these as planned. */
  tsxFiles: 21,
} as const
