/**
 * The narrow classic JSX transform for `.tsx` mod modules (D34).
 *
 * This is deliberately not a bundler, a preset or a general transpiler. It
 * rewrites JSX syntax to `h(...)` / `Fragment` calls and nothing else, then the
 * host applies the same in-memory type strip it applies to `.ts`. The classic
 * pragma in the file's own leading comment block is the gate:
 *
 * - `@jsx h` is required, exactly the identifier `h`;
 * - `@jsxRuntime`, when present, must be `classic`;
 * - `@jsxFrag`, when present, must be `Fragment`.
 *
 * A file that fails the gate is refused with `ERR_MOD_HOST_TSX`; the mod's
 * `.tsx` extension is not a licence to transform it some other way. The
 * transform is AST-preserving, not byte- or position-preserving: Babel parses
 * the module and reprints it, so whitespace, quote style and source positions
 * are not claimed (D34, D30). The scanner never sees this output: it scans the
 * authored file, which is the trust surface (`dsh-anyplugin-mod-scan`).
 *
 * The realm globals are intentionally minimal: `h` returns a plain
 * `{ type, props, children }` descriptor and `Fragment` is a marker symbol.
 * There is no element runtime, no reconciler and no rendering here (D32/D34).
 */
import { transformSync } from '@babel/core'
import transformReactJsx from '@babel/plugin-transform-react-jsx'

import { ModHostError, messageOf } from './errors.ts'

/** The realm's fragment marker. Nodes built with `<>...</>` reference it. */
export const FRAGMENT: unique symbol = Symbol.for('dsh-anyplugin.mod.fragment')

/** What `h()` hands authored code. Not a renderable element: no renderer exists. */
export interface ModElement {
  readonly type: unknown
  readonly props: unknown
  readonly children: readonly unknown[]
}

/** The classic factory the transform emits. No validation, no rendering. */
export function h(type: unknown, props: unknown, ...children: unknown[]): ModElement {
  return { type, props, children }
}

/** The globals a `.tsx` mod realm receives. Nothing else is added. */
export function jsxRealmGlobals(): { h: typeof h; Fragment: typeof FRAGMENT } {
  return { h, Fragment: FRAGMENT }
}

/**
 * The leading comment block of a module: comments and whitespace before the
 * first token. A pragma anywhere later in the file is not a file pragma.
 */
function leadingCommentBlock(source: string): string {
  const comments: string[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\uFEFF') {
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index)
      const end = newline === -1 ? source.length : newline
      comments.push(source.slice(index + 2, end))
      index = end
      continue
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2)
      if (close === -1) break
      comments.push(source.slice(index + 2, close))
      index = close + 2
      continue
    }
    break
  }
  return comments.join('\n')
}

function directiveValues(block: string, directive: string): string[] {
  const pattern = new RegExp(`@${directive}\\s+([^\\s*]+)`, 'g')
  return [...block.matchAll(pattern)].map((match) => match[1])
}

/**
 * Enforce the classic pragma descended from the file's own comment block.
 * `file` is named in the typed refusal.
 */
export function assertClassicPragma(source: string, file: string): void {
  const block = leadingCommentBlock(source)
  if (block.length === 0) {
    throw new ModHostError(
      'ERR_MOD_HOST_TSX',
      'a .tsx module must declare the classic pragma (@jsx h) in its leading comment block; JSX is not type stripping (D34)',
      { file },
    )
  }
  const jsx = directiveValues(block, 'jsx')
  if (jsx.length === 0) {
    throw new ModHostError(
      'ERR_MOD_HOST_TSX',
      'a .tsx module must declare the classic pragma (@jsx h) in its leading comment block; JSX is not type stripping (D34)',
      { file },
    )
  }
  for (const value of jsx) {
    if (value !== 'h') {
      throw new ModHostError(
        'ERR_MOD_HOST_TSX',
        `unsupported JSX pragma @jsx ${value}: only the identifier h is loadable (D34)`,
        { file },
      )
    }
  }
  for (const value of directiveValues(block, 'jsxRuntime')) {
    if (value !== 'classic') {
      throw new ModHostError(
        'ERR_MOD_HOST_TSX',
        `unsupported JSX runtime @jsxRuntime ${value}: only the classic runtime is loadable (D34)`,
        { file },
      )
    }
  }
  for (const value of directiveValues(block, 'jsxFrag')) {
    if (value !== 'Fragment') {
      throw new ModHostError(
        'ERR_MOD_HOST_TSX',
        `unsupported JSX fragment pragma @jsxFrag ${value}: only Fragment is loadable (D34)`,
        { file },
      )
    }
  }
}

/**
 * Rewrite JSX synchronously and return the module source before type stripping.
 * The caller strips types exactly as it does for `.ts`.
 */
export function transformTsx(source: string, file: string): string {
  assertClassicPragma(source, file)
  let code: string | null | undefined
  try {
    const result = transformSync(source, {
      filename: file,
      configFile: false,
      babelrc: false,
      browserslistConfigFile: false,
      sourceType: 'module',
      comments: true,
      compact: false,
      parserOpts: { plugins: ['jsx', 'typescript'] },
      plugins: [
        [
          transformReactJsx,
          {
            runtime: 'classic',
            pragma: 'h',
            pragmaFrag: 'Fragment',
          },
        ],
      ],
    })
    code = result?.code
  } catch (cause) {
    throw new ModHostError('ERR_MOD_HOST_LINK', `classic JSX transform failed: ${messageOf(cause)}`, {
      file,
      cause,
    })
  }
  if (typeof code !== 'string') {
    throw new ModHostError('ERR_MOD_HOST_LINK', 'the classic JSX transform produced no code', { file })
  }
  return code
}
