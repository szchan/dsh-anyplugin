/**
 * The shell reader the guard uses. It is deliberately small: it splits a
 * command into segments, tokenizes a segment, and follows the two ways a
 * command hides another one — the `bash -c '<cmd>'` form and a leading
 * `sudo`/`env`/`command` prefix. It is not a shell: expansions, aliases and
 * functions are out of scope, and the guard's deny reasons say so.
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
    if (token === 'command' || token === 'nohup' || token === 'time' || token === 'exec' || token === 'builtin' || token === 'stdbuf') {
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
    // A subshell is still a command list: `(cd repo && touch x)` arrives as
    // `(cd repo` / `touch x)`, so the grouping parentheses are syntax, not
    // words. Stripping them lets the same cd-tracking and write rules apply.
    tokens[0] = tokens[0].replace(/^\(+/u, '')
    tokens[tokens.length - 1] = tokens[tokens.length - 1].replace(/\)+$/u, '')
    if (tokens.every((token) => token.length === 0)) continue
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
