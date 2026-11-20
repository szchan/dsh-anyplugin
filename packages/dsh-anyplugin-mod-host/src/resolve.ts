/**
 * D30's resolver: exactly three resolution behaviors, no candidate fallbacks.
 *
 * The pinned `diff` graph (S13) uses four specifier shapes, which exercise
 * these three behaviors:
 *
 * - extensionless relative imports (`'./ask'`) and `'.'` / `'./'` self-imports
 *   resolve to `<dir>/index.ts`;
 * - a `.js` specifier resolves to the `.ts` file beside it;
 * - a `.jsx` specifier resolves to the `.tsx` file beside it (resolution
 *   succeeds; the loader then refuses the extension as planned).
 *
 * There is deliberately no exact-file fallback and no `index.js` variant: the
 * spike measured zero uses of anything else (737 / 246 / 21 at the pin), and
 * D30 makes the three rules the host's whole obligation. Every miss is a typed
 * error, never a skip.
 */
import { statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import { ModHostError, codeOf, messageOf } from './errors.ts'

export type ModResolutionBehavior = 'directory-index' | 'js-to-ts' | 'jsx-to-tsx'

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
  /** Which of D30's three behaviors proved it. */
  readonly behavior: ModResolutionBehavior
}

const RULE: Record<ModResolutionBehavior, string> = {
  'directory-index': 'extensionless directory import → index.ts',
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
 * - `ERR_MOD_HOST_MISSING` when the proved candidate does not exist.
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
  let behavior: ModResolutionBehavior
  let candidate: string

  if (extension === '.js') {
    behavior = 'js-to-ts'
    candidate = resolve(base, `${specifier.slice(0, -'.js'.length)}.ts`)
  } else if (extension === '.jsx') {
    behavior = 'jsx-to-tsx'
    candidate = resolve(base, `${specifier.slice(0, -'.jsx'.length)}.tsx`)
  } else if (extension === '') {
    behavior = 'directory-index'
    candidate = resolve(base, specifier, 'index.ts')
  } else if (extension === '.tsx') {
    throw new ModHostError(
      'ERR_MOD_HOST_TSX',
      `.tsx is planned, not loadable: '${specifier}' names the JSX module ${resolve(base, specifier)} (D30, ARCHITECTURE §7.7)`,
      { file: parent },
    )
  } else {
    throw new ModHostError(
      'ERR_MOD_HOST_UNSUPPORTED_EXT',
      `cannot load '${specifier}': D30 defines extensionless directory imports and .js/.jsx rewrites, not '${extension}'`,
      { file: parent },
    )
  }

  if (!isWithin(root, candidate)) {
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      `'${specifier}' resolves outside the mod root (${candidate})`,
      { file: parent },
    )
  }

  let stat
  try {
    stat = statSync(candidate)
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') {
      throw new ModHostError(
        'ERR_MOD_HOST_MISSING',
        `cannot resolve '${specifier}': ${RULE[behavior]} expected ${candidate}, which does not exist`,
        { file: parent, cause },
      )
    }
    throw new ModHostError(
      'ERR_MOD_HOST_LINK',
      `cannot resolve '${specifier}': ${messageOf(cause)} (${candidate})`,
      { file: parent, cause },
    )
  }

  if (!stat.isFile()) {
    throw new ModHostError(
      'ERR_MOD_HOST_MISSING',
      `cannot resolve '${specifier}': ${RULE[behavior]} landed on ${candidate}, which is not a file`,
      { file: parent },
    )
  }

  return { file: candidate, behavior }
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
