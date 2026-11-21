/**
 * The shell reader the guard uses. It is deliberately small: it splits a
 * command into segments, tokenizes a segment, and follows the two ways a
 * command hides another one — the `bash -c '<cmd>'` form and a leading
 * `sudo`/`env`/`command` prefix. It is not a shell: expansions, aliases and
 * functions are out of scope, and the policy refuses constructs it cannot
 * model instead of judging a partial parse (the `shell-unmodelled` rule).
 *
 * Why it exists at all: the model runs `git push` and `gh pr merge` through a
 * shell tool, and the guard has to see the same words the shell will execute,
 * not the string as one blob. Every rule in `policy.ts` is stated over
 * segments, so a single segment `git push origin main` and the left half of
 * `git push origin main && npm test` take the same path.
 */

/** One command segment, with any nested `sh -c` body already parsed. */
export interface ShellSegment {
  /** The segment as written, before tokenizing. */
  raw: string
  /** Shell words with quotes removed; `['git', 'push', 'origin', 'main']`. */
  tokens: string[]
  /** Commands hidden in `bash -c '<body>'`, recursively. */
  children: ShellSegment[]
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell'])
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-T'])

/** Index of the last path component: `/usr/bin/git` → `git`. */
export function baseCommand(token: string | undefined): string {
  if (token === undefined) return ''
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  return slash >= 0 ? token.slice(slash + 1) : token
}

/**
 * Split on the operators that end a command. Quoted text is kept intact so a
 * `;` inside `bash -c 'a; b'` does not split the outer command.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[index + 1]
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1]
      index += 1
      continue
    }
    if ((char === '&' && command[index + 1] === '&') || (char === '|' && command[index + 1] === '|')) {
      segments.push(current)
      current = ''
      index += 1
      continue
    }
    if (char === '|' && (command[index - 1] === '>' || command[index - 1] === '&' || command[index - 1] === '<')) {
      // `>|` (clobber), `&>|` and `<|` are redirections, not pipelines.
      current += char
      continue
    }
    if (char === ';' || char === '|' || char === '\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/**
 * The segment with quoted regions blanked out. Redirect operators and control
 * characters only count outside quotes: `git commit -m "fix: a > b"` is one
 * quote, not a write, while `git commit -m x > out` really redirects.
 */
export function unquotedText(segment: string): string {
  let result = ''
  let quote: string | null = null
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (quote !== null) {
      result += ' '
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < segment.length) {
        result += ' '
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      result += ' '
      continue
    }
    if (char === '\\' && index + 1 < segment.length) {
      result += ' '
      index += 1
      continue
    }
    result += char
  }
  return result
}

const STDIN_FILES = new Set(['-', '/dev/stdin', '/dev/fd/0'])

/**
 * The file a shell segment would execute, if it names one. `-c` bodies are
 * already parsed as children; a redirect (`<`, `<<`, `<<<`, `>`, `&>`) ends the
 * scan so `bash <<< 'cmd'` is not mistaken for a script named `cmd`.
 */
export function shellScriptFile(tokens: string[]): string | undefined {
  const head = stripPrefix(tokens)
  if (head.length === 0 || !SHELLS.has(baseCommand(head[0]))) return undefined
  if (head.some((token, index) => index > 0 && (token === '-c' || /^-[A-Za-z]*c$/u.test(token)))) return undefined
  for (const token of head.slice(1)) {
    if (token.startsWith('<') || token.startsWith('>') || token === '&>' || token === '&>>') {
      return undefined
    }
    if (token.startsWith('-')) continue
    return STDIN_FILES.has(token) ? undefined : token
  }
  return undefined
}

/** A here-string or process substitution: stdin that the reader does not see. */
export function shellStdinHazard(command: string): string | undefined {
  const text = unquotedText(command)
  if (text.includes('<<<')) return 'a here-string feeds a shell from stdin, which the guard cannot read'
  if (/[<>]\(/u.test(text)) return 'process substitution hides a command list the guard cannot read'
  return undefined
}

/**
 * The quoting rule for `$`: inside single quotes every character is literal;
 * elsewhere a `$` starts an expansion when the next character can begin one
 * (`(`, `{`, `'`, a name start, a digit, or one of the special parameters
 * `? * @ # ! $ -`). A `$` at the end, or before `/`, a space or punctuation
 * that cannot start an expansion, is literal. `awk '{print $1}'`,
 * `sed 's/x$//'` and `echo '$HOME'` are therefore allowed; `"$HOME"`,
 * `$(…)`, `${…}` and backticks are refused. The rule is pinned in
 * `docs/ARCHITECTURE.md` so it does not drift from this scanner.
 */
export function expansionHazard(command: string): string | undefined {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
        continue
      }
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '`') return 'a backtick runs a command the guard cannot read'
      if (char === '$' && startsExpansion(command, index + 1)) return 'a double-quoted expansion hides the value'
      continue
    }
    if (char === "'") {
      quote = "'"
      continue
    }
    if (char === '"') {
      quote = '"'
      continue
    }
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '`') return 'a backtick runs a command the guard cannot read'
    if (char !== '$') continue
    const next = command[index + 1]
    if (next === "'") return "ANSI-C quoting ($'…') changes the words the shell sees"
    if (next === '(') return 'command substitution hides what will run'
    if (next === '{') return 'parameter expansion hides the value'
    if (startsExpansion(command, index + 1)) return 'shell expansion hides the value'
  }
  return undefined
}

function startsExpansion(command: string, index: number): boolean {
  const next = command[index]
  if (next === undefined) return false
  if (next === '(' || next === '{') return true
  if (/[A-Za-z_]/u.test(next)) return true
  if (/[0-9]/u.test(next)) return true
  return '?*@#!$-'.includes(next)
}

/** Shell-word split of one segment. Quotes group, they do not survive. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (quote !== null) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === '\\' && quote === '"' && index + 1 < segment.length) {
        current += segment[index + 1]
        index += 1
        started = true
        continue
      }
      current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < segment.length) {
      current += segment[index + 1]
      index += 1
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (started || current.length > 0) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started || current.length > 0) tokens.push(current)
  return tokens
}

/**
 * Drop the prefixes that do not change the command: `sudo`, `env`, `command`,
 * `nohup`, `time`, `exec`, `builtin`, `VAR=value` assignments and `--`.
 */
/**
 * Environment assignments in front of the command: `VAR=value git …`.
 * They are enough to redirect git config and exec paths, so a worker's git
 * segment is refused when this is non-empty. `env -i VAR=value git …` counts.
 */
export function leadingAssignments(tokens: string[]): string[] {
  const found: string[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      found.push(token)
      index += 1
      continue
    }
    if (token === 'env') {
      index += 1
      continue
    }
    if (token === '-i' || token === '--ignore-environment') {
      index += 1
      continue
    }
    if (token === '-u' || token === '--unset') {
      index += 2
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  return found
}

export function stripPrefix(tokens: string[]): string[] {
  const result = tokens.slice()
  let index = 0
  while (index < result.length) {
    const token = result[index]
    if (token === 'sudo') {
      index += 1
      while (index < result.length && result[index].startsWith('-')) {
        const flag = result[index]
        index += 1
        if (SUDO_VALUE_FLAGS.has(flag)) index += 1
      }
      continue
    }
    if (token === 'env') {
      index += 1
      // `env -i VAR=value cmd`, `env -u NAME cmd`: the command is still there.
      while (index < result.length) {
        const next = result[index]
        if (next === '-u' || next === '--unset') {
          index += 2
          continue
        }
        if (next.startsWith('-')) {
          index += 1
          continue
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(next)) {
          index += 1
          continue
        }
        break
      }
      continue
    }
    if (token === 'timeout') {
      index += 1
      while (index < result.length && result[index].startsWith('-')) {
        const flag = result[index]
        index += 1
        if (flag === '-s' || flag === '--signal' || flag === '-k' || flag === '--kill-after') index += 1
      }
      index += 1 // the duration
      continue
    }
    if (token === 'nice') {
      index += 1
      while (index < result.length) {
        const next = result[index]
        if (next === '-n' || next === '--adjustment') {
          index += 2
          continue
        }
        if (next.startsWith('-')) {
          index += 1
          continue
        }
        break
      }
      continue
    }
    if (token === 'xargs') {
      index += 1
      while (index < result.length && result[index].startsWith('-')) {
        const flag = result[index]
        index += 1
        if (['-I', '-n', '-P', '-s', '-L', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars'].includes(flag)) index += 1
      }
      continue
    }
    if (token === 'command' || token === 'nohup' || token === 'time' || token === 'exec' || token === 'builtin') {
      index += 1
      continue
    }
    if (token === '--') {
      index += 1
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1
      continue
    }
    break
  }
  return result.slice(index)
}

/**
 * Remove heredoc bodies before parsing. A heredoc body is data the command
 * writes, not a command the shell runs, and reading it as one would deny the
 * common `cat > notes.md <<'EOF' … EOF` for text that merely looks like a
 * command. The opener line stays, so its redirect target is still checked.
 */
export function stripHeredocs(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  let terminator: string | null = null
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null
      continue
    }
    kept.push(line)
    const opener = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/u)
    if (opener !== null) terminator = opener[2]
  }
  return kept.join('\n')
}

/**
 * Parse a command into segments, including the body of a `bash -c '<body>'`.
 * `depth` bounds the recursion so a hostile or generated string cannot nest
 * forever; four levels is more than any real invocation needs.
 */
export function parseSegments(command: string, depth = 0): ShellSegment[] {
  const segments: ShellSegment[] = []
  for (const raw of splitSegments(stripHeredocs(command))) {
    const tokens = tokenize(raw)
    if (tokens.length === 0) continue
    const head = stripPrefix(tokens)
    const children: ShellSegment[] = []
    if (depth < 4 && head.length > 1 && SHELLS.has(baseCommand(head[0]))) {
      // `bash -c`, and the combined forms `sh -lc` / `bash -ic`.
      const flag = head.findIndex((token, index) => index > 0 && (token === '-c' || /^-[A-Za-z]*c$/u.test(token)))
      if (flag > 0 && head[flag + 1] !== undefined) {
        children.push(...parseSegments(head[flag + 1], depth + 1))
      }
    }
    segments.push({ raw, tokens, children })
  }
  return segments
}
