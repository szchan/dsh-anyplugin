/**
 * Hashing for exec artifacts (D25).
 *
 * A grant pins **bytes that will run**, never a path or an mtime:
 *
 * - hook whose `command` names a file inside the plugin root (an exec-form
 *   `command` + `args`, or a shell command with an absolute file operand after
 *   `${CLAUDE_PLUGIN_ROOT}` expansion): sha256 of that file's bytes. The argv
 *   that points at the file is not part of the hash — changing `--flag` does
 *   not require a new grant, changing the script does.
 * - hook with an inline shell command (`echo …`, `cat … | …`) or a file
 *   operand we cannot resolve unambiguously: sha256 of the command text exactly
 *   as it is handed to `sh -c` / `spawn`. There is no file to pin, so the text
 *   is the artifact. If a compound command also names files, the hash covers
 *   the text **and** every file operand's bytes, so neither a text edit nor a
 *   script edit can ride the old grant.
 * - `bin/`, `monitors/`, `mods/`: sha256 of the file bytes.
 *
 * `artifactHash` is always `sha256:<64 lowercase hex>`.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import type { IrHook } from '../../dsh-anyplugin-ir/src/index.ts'

/** `sha256:<hex>` over the given bytes. */
export function hashBytes(bytes: Uint8Array | string): string {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return `sha256:${digest}`
}

/** `sha256:<hex>` over a file's bytes. */
export function hashFile(file: string): string {
  return hashBytes(readFileSync(file))
}

/** For inline commands, so two different argv texts cannot collide in a test double. */
function hashCommandText(command: string, args?: readonly string[]): string {
  return hashBytes(args === undefined ? command : [command, ...args].join('\u0000'))
}

/** Composite for compound shell commands: the text plus the bytes it names. */
function hashComposite(command: string, files: readonly string[], root: string): string {
  const parts = [command]
  for (const file of files) parts.push(`${relativePath(root, file)}\u0000${hashFile(file)}`)
  return hashBytes(parts.join('\u0000'))
}

/** A shell composition operator or variable makes the first word not the whole program. */
const COMPOSITION = /[|&;<>()`]|\$/

/**
 * A deliberately small shell word splitter: quotes and backslash escapes are
 * honoured, expansions are not performed. Enough to find a file operand in a
 * `command:` string without pretending to be a shell.
 */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current.length > 0) words.push(current)
  return words
}

function expandRoot(value: string, root: string): string {
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root)
    .replace(/\$CLAUDE_PLUGIN_ROOT(?![A-Za-z0-9_])/g, root)
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** True when `file` is lexically inside `root`. Symlinks are followed by readFileSync; the bytes are the identity. */
function insideRoot(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function relativePath(root: string, file: string): string {
  return relative(root, file).split('\\').join('/')
}

export interface HookArtifact {
  artifactHash: string
  /** `hooks/hooks.json` for inline text, or the plugin-relative file that was hashed. */
  sourcePath: string
  /** `file` when bytes on disk were hashed, `inline` when the command text was. */
  mode: 'file' | 'inline'
}

/**
 * Hash what one command hook will actually run.
 *
 * Exec form (`args` present) names the program directly. Shell form is parsed
 * for the first absolute file operand inside the plugin root — an absolute path
 * is the only unambiguous file reference here, because the hook runner does not
 * set `cwd` to the plugin root. Everything else is pinned as command text.
 */
export function hashHook(root: string, hook: IrHook): HookArtifact {
  const command = hook.command
  if (command === undefined) throw new Error(`hook ${hook.event}#${hook.index} has no command`)
  // The dialect may hand us a relative root (tests, `rig report <dir>`), while
  // a real install is absolute. Resolve once so expansions can be compared.
  const base = resolve(root)

  if (hook.args !== undefined) {
    const candidate = expandRoot(command, base)
    if (isAbsolute(candidate) && insideRoot(base, candidate) && isFile(candidate)) {
      return { artifactHash: hashFile(candidate), sourcePath: relativePath(base, candidate), mode: 'file' }
    }
    return { artifactHash: hashCommandText(command, hook.args), sourcePath: hook.sourcePath, mode: 'inline' }
  }

  const words = shellWords(command)
  const operands: string[] = []
  for (const word of words) {
    if (word.startsWith('-')) continue
    const candidate = expandRoot(word, base)
    if (!isAbsolute(candidate)) continue
    if (!insideRoot(base, candidate)) continue
    if (!isFile(candidate)) continue
    operands.push(candidate)
  }
  const first = words.length > 0 ? expandRoot(words[0], base) : ''
  const composed = COMPOSITION.test(expandRoot(command, base))
  if (!composed && first !== '' && isAbsolute(first) && isFile(first) && insideRoot(base, first)) {
    return { artifactHash: hashFile(first), sourcePath: relativePath(base, first), mode: 'file' }
  }
  if (operands.length > 0) {
    return { artifactHash: hashComposite(command, operands, base), sourcePath: hook.sourcePath, mode: 'inline' }
  }
  return { artifactHash: hashCommandText(command), sourcePath: hook.sourcePath, mode: 'inline' }
}

/** The bytes argument exposed for tests and for UI previews. */
export function hookArtifactText(root: string, hook: IrHook): string {
  const artifact = hashHook(root, hook)
  if (artifact.mode === 'file') return readFileSync(resolve(root, artifact.sourcePath), 'utf8')
  return hook.command ?? ''
}
