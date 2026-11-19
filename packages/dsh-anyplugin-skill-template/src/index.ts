/**
 * Claude Code skill argument substitution, as specified by the pinned skills
 * documentation (code.claude.com/docs/en/skills, claude-code@2.1.322).
 *
 * The engine is ours because the *channel* is missing: Claude's `Skill` tool
 * takes `{skill, args}` and substitutes before delivery, while DSH's `skill`
 * tool takes `{name}` only (`dsh-tool-skill/src/index.ts`, the `parameters`
 * block). So this module is proven against a recorded trace
 * (`Greet $name.` + `Ada` → `Greet Ada.`) and waits for the additive seam in
 * DECISIONS D17.
 *
 * Placeholder grammar (all forms appear in the skill body, not frontmatter):
 *
 * - `$ARGUMENTS` — the full argument string as typed.
 * - `$ARGUMENTS[N]` — argument N, zero-based.
 * - `$N` — shorthand for `$ARGUMENTS[N]`; `$0` is the first argument.
 * - `$name` — a name declared in the frontmatter `arguments` list, mapped to a
 *   position in order.
 *
 * Divergence worth remembering: commands are one-based (`$1` is the first
 * argument) and skills are zero-based (`$0` is). They are separate engines on
 * purpose — see `dsh-anyplugin-command-template`.
 */

/** One invocation's argument text, exactly as the user or the model typed it. */
export interface SkillInvocationArguments {
  /** The full argument string, before quoting is interpreted. */
  readonly raw?: string
  /** Names from the frontmatter `arguments` list, in declared order. */
  readonly names?: readonly string[]
}

/** Which placeholder forms actually received an argument. */
export interface SkillSubstitutionUse {
  /** `$ARGUMENTS` expanded a non-empty string. */
  readonly arguments: boolean
  /** An indexed form (`$N`, `$ARGUMENTS[N]`) found its position. */
  readonly indexed: boolean
  /** A declared name expanded (an empty expansion still counts). */
  readonly named: boolean
}

/** Result of rendering one skill body with one invocation's arguments. */
export interface SkillSubstitution {
  /** The model-facing body. */
  readonly text: string
  /** Which forms received an argument. */
  readonly used: SkillSubstitutionUse
  /** Whether the `ARGUMENTS:` trailer was appended. */
  readonly appended: boolean
}

/**
 * Split an argument string the way the client does: whitespace separates,
 * quotes group, and a backslash escapes the next character inside a token.
 * @param raw - the argument text as typed.
 * @returns the positional arguments, empty strings included when quoted.
 */
export function splitSkillArguments(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
        continue
      }
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        current += raw[i + 1]
        i += 1
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\' && i + 1 < raw.length) {
      current += raw[i + 1]
      i += 1
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) out.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/
const INDEXED = /^ARGUMENTS\[(\d+)\]/
const DIGITS = /^\d+/

type Token =
  | { readonly kind: 'arguments'; readonly length: number }
  | { readonly kind: 'indexed'; readonly length: number; readonly index: number }
  | { readonly kind: 'named'; readonly length: number; readonly name: string }

/**
 * Read the placeholder that starts at `at`, if one does. `names` gates which
 * `$name` tokens are placeholders at all: an undeclared `$foo` is literal text.
 */
function readToken(body: string, at: number, names: ReadonlySet<string>): Token | undefined {
  const rest = body.slice(at)
  const options = INDEXED.exec(rest)
  if (options) {
    return { kind: 'indexed', length: options[0].length, index: Number(options[1]) }
  }
  if (rest.startsWith('ARGUMENTS')) {
    return { kind: 'arguments', length: 'ARGUMENTS'.length }
  }
  const digits = DIGITS.exec(rest)
  if (digits) {
    return { kind: 'indexed', length: digits[0].length, index: Number(digits[0]) }
  }
  const name = NAME.exec(rest)
  if (name && names.has(name[0])) {
    return { kind: 'named', length: name[0].length, name: name[0] }
  }
  return undefined
}

/**
 * Render one skill body with one invocation's arguments.
 *
 * Substitution is single-pass: a value that itself contains `$1` is inserted
 * as literal text and never re-expanded. `${CLAUDE_*}` variables are replaced
 * after arguments by the client; we do not implement them here.
 *
 * @param body - the skill body after frontmatter removal.
 * @param invocation - the typed arguments and the declared argument names.
 * @returns the rendered body plus what actually expanded.
 */
export function substituteSkillArguments(
  body: string,
  invocation: SkillInvocationArguments = {},
): SkillSubstitution {
  const raw = invocation.raw ?? ''
  const names = invocation.names ?? []
  const args = splitSkillArguments(raw)
  const declared = new Set(names)
  const used = { arguments: false, indexed: false, named: false }
  let text = ''
  let i = 0
  while (i < body.length) {
    const ch = body[i] as string
    // `\\$1` keeps both backslashes and still expands; `\$1` escapes the token.
    if (ch === '\\' && body[i + 1] === '\\' && body[i + 2] === '$') {
      const token = readToken(body, i + 3, declared)
      if (token) {
        text += '\\\\'
        i += 2
        continue
      }
    }
    if (ch === '\\' && body[i + 1] === '$') {
      const token = readToken(body, i + 2, declared)
      if (token) {
        text += body.slice(i + 1, i + 1 + 1 + token.length)
        i += 2 + token.length
        continue
      }
    }
    if (ch === '$') {
      const token = readToken(body, i + 1, declared)
      if (token) {
        const end = i + 1 + token.length
        if (token.kind === 'arguments') {
          text += raw
          if (raw !== '') used.arguments = true
        } else if (token.kind === 'indexed') {
          const value = args[token.index]
          if (value === undefined) text += body.slice(i, end)
          else {
            text += value
            used.indexed = true
          }
        } else {
          const position = names.indexOf(token.name)
          text += args[position] ?? ''
          used.named = true
        }
        i = end
        continue
      }
    }
    text += ch
    i += 1
  }
  const appended = raw.trim() !== '' && !used.arguments && !used.indexed && !used.named
  if (appended) {
    text = `${text.trimEnd()}\n\nARGUMENTS: ${raw}`
  }
  return { text, used, appended }
}
