/**
 * D30's resolver, extended by the D38 proposal: an extensionless relative
 * import tries the file form before the directory form.
 *
 * The pinned `diff` graph (S13) uses four specifier shapes:
 *
 * - extensionless relative imports (`'./ask'`) and `'.'` / `'./'` self-imports;
 * - a `.js` specifier, which resolves to the `.ts` file beside it;
 * - a `.jsx` specifier, which resolves to the `.tsx` file beside it
 *   (resolution succeeds; the loader applies the classic transform from D34).
 *
 * At the 2.1.329 pin, `sec-default` imports `'./reads-as-org-tool'` — a sibling
 * `.ts` file with no extension. Refusing that was our gap, not upstream's:
 * their loader serves it. The order is Node's file-then-directory order, and it
 * is load-bearing:
 *
 *   `<spec>.ts`, `<spec>.tsx`, `<spec>/index.ts`, `<spec>/index.tsx`
 *
 * File before directory is also the only order that keeps the D34 `.tsx`
 * transform working for `views` → `views/index.tsx`. Bare self-imports (`'.'`,
 * `'..'`, a trailing slash) keep the older directory-index behavior: they name
 * a directory, not a file.
 *
 * Every miss is a typed error, never a skip.
 */
import { statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import { ModHostError, codeOf, messageOf } from './errors.ts'

export type ModResolutionBehavior =
  | 'extensionless-file'
  | 'directory-index'
  | 'js-to-ts'
  | 'jsx-to-tsx'

export interface ResolveModSpecifierOptions {
  /** The specifier exactly as authored. */
  readonly specifier: string
  /** The importing file, absolute. */
  readonly parent: string
  /** The mod root; resolution may not leave it. */
  readonly root: string
}

export interface ResolvedModSpecifier {
  /** The existing file the specifier denotes, absolute. */
  readonly file: string
  /** Which D30/D38 behavior proved it. */
  readonly behavior: ModResolutionBehavior
}

const RULE: Record<ModResolutionBehavior, string> = {
  'extensionless-file': 'extensionless file import → .ts or .tsx file',
  'directory-index': 'extensionless directory import → index.ts or index.tsx',
  'js-to-ts': '.js specifier → .ts file',
  'jsx-to-tsx': '.jsx specifier → .tsx file',
}

const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/

/**
 * Resolve one authored specifier. Throws a `ModHostError`:
 *
 * - `ERR_MOD_HOST_LINK` when the specifier is not relative or has no D30 rule;
 * - `ERR_MOD_HOST_TSX` when the specifier names `.tsx` directly;
 * - `ERR_MOD_HOST_UNSUPPORTED_EXT` for another extension;
 * - `ERR_MOD_HOST_MISSING` when no proved candidate exists.
 */
export function resolveModSpecifier(options: ResolveModSpecifierOptions): ResolvedModSpecifier {
  const { specifier, parent } = options
  const root = resolve(options.root)

  if (typeof specifier !== 'string' || specifier.length === 0) {
    throw new ModHostError('ERR_MOD_HOST_LINK', 'empty module specifier', { file: parent })
  }

  if (!isRelativeSpecifier(specifier)) {
    const kind = specifier.startsWith('node:')
      ? 'Node builtin'
      : URL_SCHEME.test(specifier)
        ? 'URL'
        : 'bare'
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      `cannot resolve ${kind} specifier '${specifier}': a mod may import only relative authored files (D30)`,
      { file: parent },
    )
  }

  const base = dirname(parent)
  const extension = extname(specifier)

  if (extension === '.js') {
    return prove(resolve(base, `${specifier.slice(0, -'.js'.length)}.ts`), 'js-to-ts', specifier, parent, root)
  }
  if (extension === '.jsx') {
    return prove(
      resolve(base, `${specifier.slice(0, -'.jsx'.length)}.tsx`),
      'jsx-to-tsx',
      specifier,
      parent,
      root,
    )
  }
  if (extension === '') {
    return resolveExtensionless(specifier, base, parent, root)
  }
  if (extension === '.tsx') {
    throw new ModHostError(
      'ERR_MOD_HOST_TSX',
      `a direct .tsx specifier is not a D30/D34 resolution rule: '${specifier}' names ${resolve(base, specifier)}; authored JSX imports spell '.jsx' (D30)`,
      { file: parent },
    )
  }
  throw new ModHostError(
    'ERR_MOD_HOST_UNSUPPORTED_EXT',
    `cannot load '${specifier}': D30/D34 define extensionless imports and .js/.jsx rewrites, not '${extension}'`,
    { file: parent },
  )
}

/**
 * The extensionless rule. A bare self-import or a trailing slash names a
 * directory (`index.ts` only); anything else is a file-then-directory search.
 */
function resolveExtensionless(
  specifier: string,
  base: string,
  parent: string,
  root: string,
): ResolvedModSpecifier {
  const directoryOnly =
    specifier === '.' || specifier === '..' || specifier.endsWith('/')

  if (directoryOnly) {
    const index = resolve(base, specifier, 'index.ts')
    return prove(index, 'directory-index', specifier, parent, root, [index])
  }

  const candidates = [
    { file: resolve(base, `${specifier}.ts`), behavior: 'extensionless-file' as const },
    { file: resolve(base, `${specifier}.tsx`), behavior: 'extensionless-file' as const },
    { file: resolve(base, specifier, 'index.ts'), behavior: 'directory-index' as const },
    { file: resolve(base, specifier, 'index.tsx'), behavior: 'directory-index' as const },
  ]

  for (const candidate of candidates) {
    if (!isWithin(root, candidate.file)) {
      throw new ModHostError(
        'ERR_MOD_HOST_LINK',
        `'${specifier}' resolves outside the mod root (${candidate.file})`,
        { file: parent },
      )
    }
    const state = statCandidate(candidate.file, parent)
    if (state === 'missing') continue
    return { file: candidate.file, behavior: candidate.behavior }
  }

  throw new ModHostError(
    'ERR_MOD_HOST_MISSING',
    `cannot resolve '${specifier}': ${RULE['directory-index']} expected ${candidates
      .map((candidate) => candidate.file)
      .join(' or ')}, none exists`,
    { file: parent },
  )
}

/** Prove one candidate and return it, or throw the typed reason it failed. */
function prove(
  candidate: string,
  behavior: ModResolutionBehavior,
  specifier: string,
  parent: string,
  root: string,
  expected?: readonly string[],
): ResolvedModSpecifier {
  if (!isWithin(root, candidate)) {
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      `'${specifier}' resolves outside the mod root (${candidate})`,
      { file: parent },
    )
  }
  const state = statCandidate(candidate, parent)
  if (state === 'missing') {
    const expectedText = (expected ?? [candidate]).join(' or ')
    throw new ModHostError(
      'ERR_MOD_HOST_MISSING',
      `cannot resolve '${specifier}': ${RULE[behavior]} expected ${expectedText}, which does not exist`,
      { file: parent },
    )
  }
  return { file: candidate, behavior }
}

/** `missing` only for ENOENT/ENOTDIR; anything else is a loud link failure. */
function statCandidate(candidate: string, parent: string): 'file' | 'missing' {
  let stat
  try {
    stat = statSync(candidate)
  } catch (cause) {
    const code = codeOf(cause)
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      `cannot resolve '${candidate}': ${messageOf(cause)}`,
      { file: parent, cause },
    )
  }
  if (!stat.isFile()) {
    throw new ModHostError(
      'ERR_MOD_HOST_MISSING',
      `cannot resolve '${candidate}': landed on a path that is not a file`,
      { file: parent },
    )
  }
  return 'file'
}

/** A specifier the linker should treat as relative. */
export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
  )
}

/** Whether `file` is the root itself or lives under it (lexical, not realpath). */
export function isWithin(root: string, file: string): boolean {
  const rel = relative(resolve(root), resolve(file))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
