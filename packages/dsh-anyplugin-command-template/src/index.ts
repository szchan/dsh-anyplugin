/**
 * Command template expansion — the pure half of the command materializer.
 *
 * A Claude Code command is a prompt template: the user types
 * `/plugin:name some args`, and the body is expanded and *sent as a user
 * message*. DSH commands run against the receiving agent without sending
 * anything to the model, so the expansion itself has to be reproduced exactly
 * whenever the submit seam lands — and it has to be testable now, without it.
 *
 * Expansion rules (documented Claude semantics, not yet behaviour-verified —
 * see ARCHITECTURE §10.4 "still open"):
 *
 * - `$ARGUMENTS` → the whole argument string, trimmed.
 * - `$1` … `$9` → positional arguments.
 * - no placeholder at all → the arguments are appended after a blank line.
 *
 * Deliberately dumb: substitution happens inside code fences and inside quoted
 * prose too, because the upstream substitution is textual as well.
 */
export interface CommandExpansion {
  /** The expanded body. */
  text: string
  /** The argument string, trimmed, as substituted for `$ARGUMENTS`. */
  args: string
  /** Which placeholder families the body used. */
  used: 'none' | 'arguments' | 'positional' | 'both'
  /** Positional placeholders the caller did not supply, in order, unique. */
  missing: string[]
}

const POSITIONAL = /\$([1-9])/g

/**
 * Shell-like split: whitespace separated, `'…'` and `"…"` group, `\` escapes
 * the next character. Empty arguments produced by explicit quotes are kept
 * (`a "" b` → three tokens) because a positional slot must not silently shift.
 */
export function splitArguments(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: string | undefined
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (char === '\\' && quote !== "'" && i + 1 < raw.length) {
      current += raw[++i]
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

export function expandCommandTemplate(body: string, rawInput: string): CommandExpansion {
  const args = rawInput.trim()
  const tokens = splitArguments(args)
  const hasArguments = body.includes('$ARGUMENTS')
  const matches = [...body.matchAll(POSITIONAL)]
  const hasPositional = matches.length > 0

  const missing: string[] = []
  let text = body.replace(POSITIONAL, (whole, digit: string) => {
    const index = Number(digit) - 1
    const value = tokens[index]
    if (value === undefined) {
      if (!missing.includes(whole)) missing.push(whole)
      return ''
    }
    return value
  })
  if (hasArguments) text = text.split('$ARGUMENTS').join(args)

  const used: CommandExpansion['used'] =
    hasArguments && hasPositional
      ? 'both'
      : hasArguments
        ? 'arguments'
        : hasPositional
          ? 'positional'
          : 'none'

  if (used === 'none' && args !== '') {
    text = `${text.trimEnd()}\n\n${args}`
  }

  return { text, args, used, missing }
}
