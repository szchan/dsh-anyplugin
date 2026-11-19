/**
 * Exec artifacts are **manifests** (D25).
 *
 * A grant pins one resolution, not a promise to discover operands again at
 * spawn time:
 *
 * ```
 * artifact = { mode, invocation, command, files: [{ path, sha256, bytes }] }
 * hash     = sha256(mode, command, then every file's path + sha256, in order)
 * ```
 *
 * Resolution happens once, here. `invocation` is the exact text/argv handed to
 * the shell or `spawn` (for the UI and for the materializer's drift check); it
 * is not part of the hash. `command` is the code-bearing structure with flags
 * and file operands removed, so changing `--verbose` does not require a new
 * grant while changing a pipeline, an inline payload, or a file does.
 *
 * Order and duplicates are kept: `cp a b` and `cp b a` are different
 * artifacts. Nothing is sorted and no `Set` collapses a repeated operand.
 *
 * Relative file operands are refused. The runner's cwd is the project
 * directory (that is what upstream hooks see), so `./hook.sh` in a hook is
 * ambiguous per project and hashing it against the plugin root would pin one
 * file while executing another. The refusal names the fix
 * (`${CLAUDE_PLUGIN_ROOT}/…`). Absolute file operands inside the plugin root
 * are pinned; absolute operands outside it are refused.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import type { IrHook } from '../../dsh-anyplugin-ir/src/index.ts'

export type ArtifactMode = 'file' | 'text' | 'composite'

export interface ArtifactFile {
  /** Absolute path, exactly the path re-read before every spawn. */
  path: string
  /** sha256 of the file's bytes. */
  sha256: string
  bytes: number
}

export interface ArtifactManifest {
  mode: ArtifactMode
  /**
   * The exact command text (shell form) or argv (exec form). Kept for the
   * prompt, the UI, and the materializer's "the config still names this
   * invocation" check. Not hashed: argv flags are not artifacts.
   */
  invocation: string | readonly string[]
  /**
   * The code-bearing structure: a shell command with flags and file operands
   * removed, or the executable plus non-file argv words. Empty for a pure
   * file artifact. This *is* hashed, in order, followed by `files`.
   */
  command: string | readonly string[]
  /** Ordered; duplicates are kept. */
  files: readonly ArtifactFile[]
}

export interface HookArtifact {
  artifactHash: string
  manifest: ArtifactManifest
  /** Plugin-relative file for a pure-file artifact, otherwise `hooks/hooks.json`. */
  sourcePath: string
  mode: ArtifactMode
  /** Set when no honest manifest can be resolved (relative/outside/missing operand). */
  unsupported?: string
}

/** `sha256:<hex>` over the given bytes. */
export function hashBytes(bytes: Uint8Array | string): string {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return `sha256:${digest}`
}

/** `sha256:<hex>` over a file's bytes. */
export function hashFile(file: string): string {
  return hashBytes(readFileSync(file))
}

function updateFramed(hash: ReturnType<typeof createHash>, label: string, value: string): void {
  hash.update(`${label}${Buffer.byteLength(value)}\u0000`)
  hash.update(value)
  hash.update('\u0000')
}

/**
 * Hash a manifest exactly as resolved: mode, code-bearing command, then each
 * file's path and pinned hash in order. No sorting; a duplicate operand is
 * hashed twice.
 */
export function hashManifest(manifest: ArtifactManifest): string {
  const hash = createHash('sha256')
  hash.update('dsh-anyplugin/artifact@1\u0000')
  updateFramed(hash, 'mode:', manifest.mode)
  if (typeof manifest.command === 'string') {
    updateFramed(hash, 'text:', manifest.command)
  } else {
    updateFramed(hash, 'argv-count:', String(manifest.command.length))
    for (const word of manifest.command) updateFramed(hash, 'argv:', word)
  }
  for (const file of manifest.files) {
    updateFramed(hash, 'file-path:', file.path)
    updateFramed(hash, 'file-hash:', file.sha256)
  }
  return `sha256:${hash.digest('hex')}`
}

/** Read a file into the manifest shape; one read, so size and hash agree. */
function fileEntry(file: string): ArtifactFile {
  const bytes = readFileSync(file)
  return { path: file, sha256: hashBytes(bytes), bytes: bytes.byteLength }
}

/**
 * Re-read exactly the manifest's paths and return the current hash. This never
 * re-parses the command. Throws if a pinned file is gone or unreadable.
 */
export function hashManifestAtSpawn(manifest: ArtifactManifest): string {
  const current: ArtifactManifest = {
    ...manifest,
    files: manifest.files.map((file) => fileEntry(file.path)),
  }
  return hashManifest(current)
}

/** Hash a whole file as a pure-file manifest (bin/monitor/mod rows). */
export function fileArtifact(file: string): { artifactHash: string; manifest: ArtifactManifest } {
  const manifest: ArtifactManifest = {
    mode: 'file',
    invocation: file,
    command: '',
    files: [fileEntry(file)],
  }
  return { artifactHash: hashManifest(manifest), manifest }
}

/**
 * A deliberately small shell word splitter: quotes and backslash escapes are
 * honoured, expansions are not performed. Enough to find file operands without
 * pretending to be a shell.
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

function insideRoot(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function relativePath(root: string, file: string): string {
  return relative(root, file).split('\\').join('/')
}

/** Flags that name an output, not an input: their value is never an operand. */
const OUTPUT_FLAGS = new Set([
  '--out',
  '--output',
  '--outfile',
  '--log',
  '--log-file',
  '-o',
  '-O',
  '--dest',
  '--destination',
  '--target',
  '--prefix',
  '--cache',
  '--cache-dir',
])

const KNOWN_FILE_COMMANDS = new Set([
  'cat',
  'chmod',
  'chown',
  'cp',
  'dash',
  'install',
  'ln',
  'mkdir',
  'mv',
  'node',
  'nodejs',
  'perl',
  'php',
  'python',
  'python3',
  'rm',
  'rmdir',
  'ruby',
  'sh',
  'source',
  'tar',
  'test',
  'touch',
  'unzip',
  'zsh',
  'bash',
])

const REDIRECTIONS = new Set(['>', '>>', '2>', '2>>', '&>', '<', '<<', '<<<'])

/** Interpreter flags whose *value* is the code, not a flag. */
function evalFlag(executable: string, words: readonly string[], start: number): boolean {
  const program = basename(executable)
  for (let index = start; index < words.length; index++) {
    const word = words[index] as string
    if (program === 'node' || program === 'nodejs') {
      if (word === '-e' || word === '--eval' || word === '-p' || word === '--print') return true
      if (word.startsWith('--eval=') || word.startsWith('--print=')) return true
    } else if (['sh', 'bash', 'dash', 'zsh', 'ksh', 'python', 'python3'].includes(program)) {
      if (word === '-c') return true
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word) && word.length > 2) return true
    } else if (['perl', 'ruby'].includes(program)) {
      if (word === '-e') return true
    } else if (program === 'php') {
      if (word === '-r') return true
    }
  }
  return false
}

function looksPathLike(word: string): boolean {
  if (word === '.' || word === '..') return true
  if (word.startsWith('./') || word.startsWith('../') || word.startsWith('/')) return true
  if (word.includes('/') || word.includes('\\')) return true
  return /\.[A-Za-z0-9]{1,8}$/.test(word)
}

function fileKind(file: string): 'file' | 'missing' | 'directory' {
  try {
    const stat = statSync(file)
    if (stat.isFile() || stat.isSymbolicLink()) return 'file'
    return 'directory'
  } catch {
    return 'missing'
  }
}

interface Resolution {
  files: ArtifactFile[]
  /** Code-bearing words retained after flags/operands are removed. */
  structure: string[]
  /** The first reason this artifact cannot be honestly pinned. */
  unsupported?: string
}

function resolveOperand(
  word: string,
  root: string,
  base: string,
): { kind: 'file'; entry: ArtifactFile } | { kind: 'skip' } | { kind: 'unsupported'; reason: string } {
  if (word === '' || word.startsWith('-')) return { kind: 'skip' }
  const candidate = expandRoot(word, root)
  if (isAbsolute(candidate)) {
    const absolute = resolve(candidate)
    if (!insideRoot(root, absolute)) {
      return {
        kind: 'unsupported',
        reason: `file "${word}" is outside the plugin root; copy it in or use an absolute path inside \${CLAUDE_PLUGIN_ROOT}`,
      }
    }
    const kind = fileKind(absolute)
    if (kind === 'missing') {
      return { kind: 'unsupported', reason: `file "${word}" does not exist and cannot be pinned` }
    }
    if (kind === 'directory') return { kind: 'skip' }
    return { kind: 'file', entry: fileEntry(absolute) }
  }

  // Relative. Existence is checked only to decide whether a bare word is an
  // operand; either way a relative operand is refused, because the hook runs
  // with the project directory as cwd, not the plugin root.
  const likely =
    looksPathLike(word) ||
    (KNOWN_FILE_COMMANDS.has(basename(base)) &&
      (fileKind(resolve(root, candidate)) === 'file' || fileKind(resolve(process.cwd(), candidate)) === 'file'))
  if (!likely) return { kind: 'skip' }
  return {
    kind: 'unsupported',
    reason: `relative operand "${word}" is ambiguous because hooks run with the project directory as cwd; use \${CLAUDE_PLUGIN_ROOT}/${word.replace(/^\.\//, '')}`,
  }
}

function isOutputFlag(word: string): boolean {
  const name = word.includes('=') ? word.slice(0, word.indexOf('=')) : word
  return OUTPUT_FLAGS.has(name)
}

function looksLikeFlagValue(word: string, root: string): boolean {
  if (word.startsWith('-')) return false
  if (looksPathLike(word)) return false
  return (
    fileKind(resolve(root, word)) !== 'file' &&
    fileKind(resolve(process.cwd(), word)) !== 'file'
  )
}

/**
 * Resolve an exec-form `command` + `args` array. The first word may itself be
 * a file (a script path); `args` are walked with minimal flag semantics.
 */
function resolveExec(root: string, command: string, args: readonly string[]): Resolution {
  const words = [command, ...args]
  if (evalFlag(command, words, 1)) {
    return {
      files: [],
      structure: words.slice(),
      // eval payloads are code: the exact argv is the structure.
      ...(words.length === 0 ? {} : {}),
    }
  }

  const files: ArtifactFile[] = []
  const structure: string[] = []
  let unsupported: string | undefined
  const executable = resolveOperand(command, root, command)
  if (executable.kind === 'file') files.push(executable.entry)
  else if (executable.kind === 'unsupported') unsupported = executable.reason
  else structure.push(command)

  for (let index = 0; index < args.length; index++) {
    const word = args[index] as string
    if (word.startsWith('-')) {
      if (isOutputFlag(word)) {
        if (!word.includes('=')) index += 1
        continue
      }
      if (word.includes('=')) continue
      const next = args[index + 1]
      if (next !== undefined && looksLikeFlagValue(next, root)) index += 1
      continue
    }
    const resolved = resolveOperand(word, root, command)
    if (resolved.kind === 'file') files.push(resolved.entry)
    else if (resolved.kind === 'unsupported') unsupported ??= resolved.reason
    // Exec-form argv words that are neither files nor the executable are
    // invocation arguments, not artifacts: `node hook.js --mode prod` and
    // `node hook.js --mode dev` run the same bytes and share a grant.
  }

  return { files, structure, ...(unsupported === undefined ? {} : { unsupported }) }
}

function shellHasEval(words: readonly string[]): boolean {
  for (let index = 0; index < words.length; index++) {
    if (evalFlag(words[index] as string, words, index + 1)) return true
  }
  return false
}

/**
 * Resolve a shell command string. `cd` and redirections are structure, not
 * artifacts; flags are not artifacts; every other file-looking operand is.
 */
function resolveShell(root: string, command: string): Resolution {
  const words = shellWords(command)
  if (shellHasEval(words)) {
    return { files: [], structure: [command] }
  }

  const files: ArtifactFile[] = []
  const structure: string[] = []
  let unsupported: string | undefined
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string
    if (word === 'cd') {
      structure.push(word)
      const next = words[index + 1]
      if (next !== undefined) {
        structure.push(next)
        index += 1
      }
      continue
    }
    if (REDIRECTIONS.has(word)) {
      structure.push(word)
      const next = words[index + 1]
      if (next !== undefined) {
        structure.push(next)
        index += 1
      }
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      if (isOutputFlag(word)) {
        if (!word.includes('=')) index += 1
        continue
      }
      if (word.includes('=')) continue
      const next = words[index + 1]
      if (next !== undefined && looksLikeFlagValue(next, root)) index += 1
      // Flags are not structure: changing one does not change the artifact.
      continue
    }
    if (word === '|' || word === '||' || word === '&&' || word === ';' || word === '&') {
      structure.push(word)
      continue
    }
    const resolved = resolveOperand(word, root, words[0] ?? '')
    if (resolved.kind === 'file') files.push(resolved.entry)
    else if (resolved.kind === 'unsupported') unsupported ??= resolved.reason
    else structure.push(word)
  }

  return { files, structure, ...(unsupported === undefined ? {} : { unsupported }) }
}

function sourcePathFor(root: string, hook: IrHook, files: readonly ArtifactFile[], structure: readonly string[]): string {
  if (files.length === 1 && structure.length === 0) return relativePath(root, files[0].path)
  return hook.sourcePath
}

/**
 * Resolve one command hook into a manifest plus hash.
 *
 * Exec form (`args` present) and shell form share the same refusal rules:
 * relative operands are unsupported, absolute operands outside the root are
 * unsupported, and an interpreter eval payload (`sh -c`, `node -e`) is hashed
 * as exact code text rather than treated as a flag.
 */
export function hashHook(root: string, hook: IrHook): HookArtifact {
  const command = hook.command
  if (command === undefined) throw new Error(`hook ${hook.event}#${hook.index} has no command`)
  const base = resolve(root)

  if (hook.args !== undefined) {
    const words = [command, ...hook.args]
    const resolution = resolveExec(base, command, hook.args)
    const manifest = buildManifest(words, resolution)
    return {
      artifactHash: hashManifest(manifest),
      manifest,
      sourcePath: sourcePathFor(base, hook, resolution.files, resolution.structure),
      mode: manifest.mode,
      ...(resolution.unsupported === undefined ? {} : { unsupported: resolution.unsupported }),
    }
  }

  const words = shellWords(command)
  if (shellHasEval(words)) {
    const manifest: ArtifactManifest = { mode: 'text', invocation: command, command, files: [] }
    return {
      artifactHash: hashManifest(manifest),
      manifest,
      sourcePath: hook.sourcePath,
      mode: 'text',
    }
  }

  const resolution = resolveShell(base, command)
  const manifest = buildManifest(command, resolution)
  return {
    artifactHash: hashManifest(manifest),
    manifest,
    sourcePath: sourcePathFor(base, hook, resolution.files, resolution.structure),
    mode: manifest.mode,
    ...(resolution.unsupported === undefined ? {} : { unsupported: resolution.unsupported }),
  }
}

function buildManifest(
  invocation: string | readonly string[],
  resolution: Resolution,
): ArtifactManifest {
  const mode: ArtifactMode =
    resolution.files.length === 0
      ? 'text'
      : resolution.structure.length === 0
        ? 'file'
        : 'composite'
  return {
    mode,
    invocation,
    command: resolution.structure.length === 0 ? '' : resolution.structure,
    files: resolution.files,
  }
}

/**
 * UI preview of the exact manifest, not a re-scan: the command line, mode, and
 * every pinned file with its hash. A changed artifact is shown as a different
 * line, which is what the installer prompts with.
 */
export function hookArtifactText(root: string, hook: IrHook): string {
  const artifact = hashHook(root, hook)
  const invitation =
    typeof artifact.manifest.invocation === 'string'
      ? artifact.manifest.invocation
      : artifact.manifest.invocation.map((word) => JSON.stringify(word)).join(' ')
  const files = artifact.manifest.files.map((file) => `${file.path} ${file.sha256}`).join(', ')
  return `${artifact.mode}: ${invitation}${files.length > 0 ? ` [${files}]` : ''}${artifact.unsupported === undefined ? '' : ` (unsupported: ${artifact.unsupported})`}`
}
