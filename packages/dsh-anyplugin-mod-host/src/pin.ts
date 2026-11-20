/**
 * The pinned upstream artifacts the conformance suite loads (D30 / S13).
 *
 * `DIFF_MOD_PIN` is the one artifact the host was first measured against:
 * `register.ts` from the `diff` mod of Claude Code 2.1.329. The bytes and hash
 * make "loads the diff mod" a claim about one file, not about whatever
 * upstream's `main` is today. `scripts/fetch-mod.mjs` checks the pin; the tests
 * only read the fetched tree.
 *
 * The `.ts` / `.tsx` counts are this pin's measurements of the directory
 * (584 / 21; S13 measured 579 / 21 at 2.1.322); they make a partial or pruned
 * checkout fail loudly instead of shrinking the graph silently.
 */
export const DIFF_MOD_PIN = {
  version: '2.1.329',
  commit: 'f9e4d1e5753ccffcffdd832f047d72be000396a6',
  /** Repository-relative directory holding the mod (its root is the entry's dir). */
  directory: 'mods/diff/hooks',
  /** Entry, relative to the fetched mod root. */
  entry: 'register.ts',
  entryBytes: 35_661,
  entrySha256: '26ffa181d586e5d242e146f21a2a10dd657c5d9e69973282b7a1a5d410889d86',
  /** S13: .ts modules in the directory (reachable and not). */
  tsFiles: 584,
  /** S13: .tsx modules in the directory; D34 loads these through the classic transform. */
  tsxFiles: 21,
} as const

/**
 * The seven upstream mods that ship under `mods/` at the same pin (#58).
 *
 * The pin is a release, not a path: `mods/easel` and `mods/hipaa-default` only
 * exist from `2.1.329` on, so fetching `mods/` from upstream `main` would
 * measure a different API specification (AGENTS §3.9: the declarations at the
 * pin are the spec).
 *
 * `treeSha256` covers the whole fetched `mods/` tree (3,272 files): files are
 * walked recursively, sorted by tree-relative POSIX path with code-unit order,
 * and each is hashed as `<path>\0<size>\0<bytes>\0`. `gitTree` is the upstream
 * tree object id, checked before the checkout is moved into `.mods/`. Both make
 * a partial, pruned or edited checkout fail here rather than in a test.
 */
export const UPSTREAM_MODS_PIN = {
  version: '2.1.329',
  commit: 'f9e4d1e5753ccffcffdd832f047d72be000396a6',
  /** Repository-relative directory holding every mod and its spec. */
  directory: 'mods',
  /** Upstream git tree object for `mods/` at the commit (SHA-1, git's id). */
  gitTree: '46805ca1d6bdc543a11770233cbb061592a88237',
  /** SHA-256 of the materialized `mods/` tree, algorithm in the comment above. */
  treeSha256: '3e319ddcde6837af2724b7ebfe3ea422f2fa72e2cb9125aeb69ea143033817cb',
  /** The seven mods present at the pin, in tree order; entry is relative to the mod. */
  mods: [
    {
      name: 'agents-md',
      entry: 'hooks/register.ts',
      entrySha256: '15f37507321d6d508fc236748f74bcafdea74c36c653d82c268ad7c39440887c',
    },
    {
      name: 'diff',
      entry: 'hooks/register.ts',
      entrySha256: '26ffa181d586e5d242e146f21a2a10dd657c5d9e69973282b7a1a5d410889d86',
    },
    {
      name: 'easel',
      entry: 'hooks/register.ts',
      entrySha256: '560f70a8959fb3f18e712910ed74c0414fed2aa9ef8ef80419c3158e4d1dc5e2',
    },
    {
      name: 'hipaa-default',
      entry: 'hooks/register.ts',
      entrySha256: 'dfa17f145e72176712d6841396ce0e9fd593a3c17ae6b9f01e5fd93721efc387',
    },
    {
      name: 'privacy',
      entry: 'hooks/register.ts',
      entrySha256: '3286f426e8bc3ba8516d63d4be1cbb4318b2f006242c99f77508cc10b46d0ea0',
    },
    {
      name: 'sec-default',
      entry: 'hooks/register.ts',
      entrySha256: '7efbe1e3054e7d7c221faee338d45ff881eef40cd0a47eccb40f89d938cf09fd',
    },
    {
      name: 'telemetry',
      entry: 'hooks/register.ts',
      entrySha256: '4ba2e27d6cff2d187840a7bfa4a0b479a6881a8730790333feee1a6b2142b096',
    },
  ],
} as const
