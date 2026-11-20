/**
 * The host's typed failures.
 *
 * Four codes, matching the surface the host can refuse (D30; ARCHITECTURE
 * §7.7). They are deliberately coarse: the reason says exactly what happened,
 * and the code tells a caller which decision to revisit.
 *
 * Authored code errors (a ReferenceError at module scope, a throw from
 * `register`, a rejection from a handler) are *not* wrapped: the host must not
 * launder the mod's own stack. Every error here carries a reason, because
 * "fail loudly" is the feature.
 */

export type ModHostErrorCode =
  /** The graph reaches `.tsx`; JSX is planned and needs its own transform (D30). */
  | 'ERR_MOD_HOST_TSX'
  /** The host cannot find the root, the entry, or a module the graph names. */
  | 'ERR_MOD_HOST_MISSING'
  /** A file or specifier extension that D30 does not load. */
  | 'ERR_MOD_HOST_UNSUPPORTED_EXT'
  /**
   * The host could not link, evaluate or arm the mod: a specifier outside the
   * three D30 rules, a read/strip/syntax failure, a missing `register(on)`, or
   * a call after `dispose()`. The reason names the actual failure.
   */
  | 'ERR_MOD_HOST_LINK'

export interface ModHostErrorOptions {
  /** The file the failure belongs to, when there is one. */
  readonly file?: string
  /** The original error, kept for `error.cause`. */
  readonly cause?: unknown
}

export class ModHostError extends Error {
  readonly code: ModHostErrorCode
  readonly file: string | undefined
  /** The reason without the file prefix; the full message adds it. */
  readonly reason: string

  constructor(code: ModHostErrorCode, reason: string, options: ModHostErrorOptions = {}) {
    const message = options.file === undefined ? reason : `${options.file}: ${reason}`
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModHostError'
    this.code = code
    this.file = options.file
    this.reason = reason
  }
}

/** Short, stable rendering of an authored value for a host error message. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'function') return 'a function'
  return `a ${typeof value}`
}

/** `error.message` for an unknown thrown value, without assuming an Error. */
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

/** The `code` property of a Node system error, when it has one. */
export function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
