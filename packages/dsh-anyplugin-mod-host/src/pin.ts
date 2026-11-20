/**
 * The pinned upstream artifacts the conformance suite loads (D30 / S13).
 *
 * `DIFF_MOD_PIN` is the one artifact the host was first measured against:
 * `register.ts` from the `diff` mod of Claude Code 2.1.322. The bytes and hash
 * make "loads the diff mod" a claim about one file, not about whatever
 * upstream's `main` is today. `scripts/fetch-mod.mjs` checks the pin; the tests
 * only read the fetched tree.
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
  /** S13: .tsx modules in the directory; D34 loads these through the classic transform. */
  tsxFiles: 21,
} as const

/**
 * The five upstream mods that ship under `mods/` at the same pin (#55).
 *
 * The pin is a release, not a path: `mods/easel` and `mods/hipaa-default` were
 * added to upstream `main` after `2.1.322`, so fetching them from `main` would
 * measure a different API specification (AGENTS §3.9: the declarations at the
 * pin are the spec). They are recorded in `docs/TODO.md` as a pin bump.
 *
 * `treeSha256` covers the whole fetched `mods/` tree (1,396 files): files are
 * walked recursively, sorted by tree-relative POSIX path with code-unit order,
 * and each is hashed as `<path>\0<size>\0<bytes>\0`. `gitTree` is the upstream
 * tree object id, checked before the checkout is moved into `.mods/`. Both make
 * a partial, pruned or edited checkout fail here rather than in a test.
 */
export const UPSTREAM_MODS_PIN = {
  version: '2.1.322',
  commit: '6e1e44f6433bfa17d198e932bff53373aa229eea',
  /** Repository-relative directory holding every mod and its spec. */
  directory: 'mods',
  /** Upstream git tree object for `mods/` at the commit (SHA-1, git's id). */
  gitTree: '8816d16f4af64b9350f73de95e87a99cfc5f745e',
  /** SHA-256 of the materialized `mods/` tree, algorithm in the comment above. */
  treeSha256: 'a69aa16e92d936dd2026812debd7615d7d8ad9296fd628213fd78b65d4e9d3dc',
  /** The five mods present at the pin, in tree order; entry is relative to the mod. */
  mods: [
    {
      name: 'agents-md',
      entry: 'hooks/register.ts',
      entrySha256: 'b095abea27ece42ac37c613cc3f06a7a45380d80cc028c5c7a4fabbaeea7c153',
    },
    {
      name: 'diff',
      entry: 'hooks/register.ts',
      entrySha256: 'cce8adf7b3218f33347707ffbfb25ff3294c184d440dfb49fa540656146debab',
    },
    {
      name: 'privacy',
      entry: 'hooks/register.ts',
      entrySha256: 'ba6190b0bc99e997d9dd08ec042ec5220788fcc1bb8d25fca4ebae8040bdf01d',
    },
    {
      name: 'sec-default',
      entry: 'hooks/register.ts',
      entrySha256: '4e599a4ba86b0133c25ec473293014e85ed874fdf5fafdef961f11196dafeb2c',
    },
    {
      name: 'telemetry',
      entry: 'hooks/register.ts',
      entrySha256: '15ab988c2490c1d0cbe0f82b8fdc1f460b9e868655ebd2a3e27be47e4a3bff91',
    },
  ],
} as const
