/**
 * Hashing for exec artifacts (D25).
 *
 * A grant pins **bytes that will run**, never a path or an mtime:
 *
 * - a hook whose command names a file (exec-form `command`/`args`, or a shell
 *   command with a file operand inside the plugin root after
 *   `${CLAUDE_PLUGIN_ROOT}` expansion): sha256 over that file's bytes. Every
 *   file operand is pinned, including `node /abs/script.js` and
 *   `cd "${CLAUDE_PLUGIN_ROOT}" && ./script.sh`. Flags are not artifacts:
 *   changing `--flag` does not require a new grant, changing a script or data
 *   file the command names does.
 * - a hook with no file operand (`echo …`, `cat … | …` with nothing on disk):
 *   sha256 of the command text exactly as it is handed to `sh -c` / `spawn`.
 *   A compound command that names files pins both its structure (the pipeline,
 *   not its flags) and every file operand's bytes, so neither a text edit nor a
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

/**
 * Composite for commands that name files: the command's *structure* plus the
 * bytes of every file operand, never the flags. A pure flag change is not an
 * artifact change (D25), but adding/removing a pipeline stage is.
 */
function hashComposite(structure: string, files: readonly string[]): string {
  const parts = [structure]
  for (const hash of files.map(hashFile).sort()) parts.push(hash)
  return hashBytes(parts.join('\u0000'))
}

/**
 * A deliberately small shell word splitter: quotes and backslash escapes are
 * honoured, expansions are not performed. Enough to find file operands in a
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

/**
 * Resolve one word to a file operand under the plugin root, if it is one.
 *
 * Absolute paths (after `${CLAUDE_PLUGIN_ROOT}` expansion) are accepted. A
 * relative word is accepted when it looks like a path (`.`, `..`, or a slash)
 * or when `bare` is set (an exec-form argument may be `scripts/hook.js`). A
 * flag is never a file operand, and neither is a bare command name such as
 * `node` — otherwise a file named like the interpreter would be pinned by
 * accident.
 */
function fileOperand(word: string, root: string, bare: boolean): string | undefined {
  if (word === '' || word.startsWith('-')) return undefined
  const candidate = expandRoot(word, root)
  if (isAbsolute(candidate)) {
    return insideRoot(root, candidate) && isFile(candidate) ? candidate : undefined
  }
  if (!bare && !word.startsWith('.') && !word.includes('/')) return undefined
  const resolved = resolve(root, candidate)
  return insideRoot(root, resolved) && isFile(resolved) ? resolved : undefined
}

/** The shell words that are structure rather than flags or file operands. */
function shellStructure(words: readonly string[], files: readonly Map<number, string>): string {
  const structure: string[] = []
  let skipFlagValue = false
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string
    if (files.has(index)) {
      skipFlagValue = false
      continue
    }
    if (skipFlagValue) {
      skipFlagValue = false
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      skipFlagValue = !word.includes('=')
      continue
    }
    structure.push(word)
  }
  return structure.join(' ')
}

export interface HookArtifact {
  artifactHash: string
  /** `hooks/hooks.json` for inline text, or the plugin-relative file that was hashed. */
  sourcePath: string
  /** `file` when bytes on disk were hashed, `inline` when the command text/structure was. */
  mode: 'file' | 'inline'
}

/**
 * Hash what one command hook will actually run.
 *
 * Exec form (`args` present) names its program and file arguments directly;
 * shell form is parsed into words and every file operand is resolved under the
 * plugin root, including a relative `./script.sh` after `cd
 * "${CLAUDE_PLUGIN_ROOT}"`. Flags and other argv are not artifacts: changing
 * `--flag` does not need a new grant, changing a file the command names does.
 *
 * When no file operand can be resolved the command text itself is the
 * artifact, because there is nothing else to pin.
 */
export function hashHook(root: string, hook: IrHook): HookArtifact {
  const command = hook.command
  if (command === undefined) throw new Error(`hook ${hook.event}#${hook.index} has no command`)
  // The dialect may hand us a relative root (tests, `rig report <dir>`), while
  // a real install is absolute. Resolve once so expansions can be compared.
  const base = resolve(root)

  if (hook.args !== undefined) {
    const files = new Set<string>()
    const commandFile = fileOperand(command, base, false)
    if (commandFile !== undefined) files.add(commandFile)
    for (const arg of hook.args) {
      const file = fileOperand(arg, base, true)
      if (file !== undefined) files.add(file)
    }
    if (files.size > 0) {
      const list = [...files]
      if (list.length === 1) {
        return { artifactHash: hashFile(list[0]), sourcePath: relativePath(base, list[0]), mode: 'file' }
      }
      return {
        artifactHash: hashComposite('', list),
        sourcePath: list.length === 1 ? relativePath(base, list[0] as string) : hook.sourcePath,
        mode: list.length === 1 ? 'file' : 'inline',
      }
    }
    return { artifactHash: hashCommandText(command, hook.args), sourcePath: hook.sourcePath, mode: 'inline' }
  }

  const words = shellWords(command)
  const filesByWord = new Map<number, string>()
  for (let index = 0; index < words.length; index++) {
    const file = fileOperand(words[index] as string, base, false)
    if (file !== undefined) filesByWord.set(index, file)
  }
  const files = [...new Set(filesByWord.values())]
  if (files.length > 0) {
    const structure = shellStructure(words, filesByWord)
    if (files.length === 1 && structure === '') {
      return { artifactHash: hashFile(files[0]), sourcePath: relativePath(base, files[0]), mode: 'file' }
    }
    return {
      artifactHash: hashComposite(structure, files),
      sourcePath: hook.sourcePath,
      mode: 'inline',
    }
  }
  return { artifactHash: hashCommandText(command), sourcePath: hook.sourcePath, mode: 'inline' }
}

/** The bytes argument exposed for tests and for UI previews. */
export function hookArtifactText(root: string, hook: IrHook): string {
  const artifact = hashHook(root, hook)
  if (artifact.mode === 'file') return readFileSync(resolve(root, artifact.sourcePath), 'utf8')
  return hook.command ?? ''
}
