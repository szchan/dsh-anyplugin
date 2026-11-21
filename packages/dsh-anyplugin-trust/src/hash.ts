/**
 * Exec artifacts are **manifests** (D25).
 *
 * A grant pins code, not data:
 *
 * ```
 * artifact = { mode, invocation, command, files: [{ path, sha256, bytes }] }
 * hash     = sha256(mode, invocation, command, each code file's path + sha256)
 * ```
 *
 * `invocation` is the exact text/argv handed to the shell or `spawn`, and it is
 * hashed: changing a data operand's *name* is a different invocation. Only the
 * program is pinned by bytes:
 *
 * - `command[0]` when it resolves to a file inside the plugin root, or
 * - for a known interpreter, the first non-flag operand that resolves to a file
 *   inside the root (for `node fmt.js data.txt`, that is `fmt.js`).
 *
 * Every other operand is data: positional inputs, `--out` values, redirect
 * targets. Its bytes are not read and editing it does not invalidate the grant.
 * Interpreter eval payloads (`sh -c`, `node -e`, `python -m`, …) are code and
 * stay in the hashed text.
 *
 * Relative and outside-root **program** files are refused: hooks run with the
 * project directory as cwd, so `./hook.sh` would pin one file and execute
 * another. A relative/outside-root *data* operand is allowed; the hook's own
 * cwd decides what it means. A hook manifest keeps discovery order and
 * duplicate words; a mod's *tree* manifest is the one sorted artifact — see
 * `treeArtifact` for that derived rule (D52).
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { IrHook } from '../../dsh-anyplugin-ir/src/index.ts'

export type ArtifactMode = 'file' | 'text' | 'composite'

export interface ArtifactFile {
  /**
   * For a hook, the absolute path re-read before every spawn. For a mod tree,
   * the plugin-relative path re-read against the row's `pluginRoot`.
   */
  path: string
  /** sha256 of the file's bytes. */
  sha256: string
  bytes: number
}

export interface ArtifactManifest {
  mode: ArtifactMode
  /**
   * The exact command text (shell form) or argv (exec form), as handed to the
   * runner. Hashed: a changed flag, operand name, or order is a new artifact.
   */
  invocation: string | readonly string[]
  /**
   * Code-bearing text when the program is an eval payload, otherwise `''`.
   * Hashed. The bytes of `files` cover the program itself.
   */
  command: string | readonly string[]
  /** The program's files, in discovery order; duplicates are kept. */
  files: readonly ArtifactFile[]
}

export interface HookArtifact {
  artifactHash: string
  manifest: ArtifactManifest
  /** Plugin-relative file for a pure-file artifact, otherwise `hooks/hooks.json`. */
  sourcePath: string
  mode: ArtifactMode
  /** Set when no honest manifest can be resolved (relative/outside/missing program). */
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
 * Hash a manifest exactly as resolved: mode, exact invocation, code-bearing
 * command, then each program file's path and pinned hash in order.
 */
export function hashManifest(manifest: ArtifactManifest): string {
  const hash = createHash('sha256')
  hash.update('dsh-anyplugin/artifact@1\u0000')
  updateFramed(hash, 'mode:', manifest.mode)
  if (typeof manifest.invocation === 'string') {
    updateFramed(hash, 'invocation-text:', manifest.invocation)
  } else {
    updateFramed(hash, 'invocation-count:', String(manifest.invocation.length))
    for (const word of manifest.invocation) updateFramed(hash, 'invocation:', word)
  }
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
 *
 * A tree manifest stores **plugin-relative** paths (D52), so the caller hands
 * the root the manifest was made against. Hook manifests stored absolute
 * paths, which still work: an absolute path ignores `root`.
 */
export function hashManifestAtSpawn(manifest: ArtifactManifest, root?: string): string {
  const current: ArtifactManifest = {
    ...manifest,
    files: manifest.files.map((file) => entryAt(file.path, root)),
  }
  return hashManifest(current)
}

/** Read one manifest path, resolving a relative (tree) path against `root`. */
function entryAt(path: string, root?: string): ArtifactFile {
  const absolute = isAbsolute(path) || root === undefined ? path : resolve(root, path)
  const bytes = readFileSync(absolute)
  return { path, sha256: hashBytes(bytes), bytes: bytes.byteLength }
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
 * Every authored file under `dir` (recursive), as paths relative to `root`,
 * POSIX separators, **sorted in path order**. Directories are descended;
 * symlinks to files are included, symlinks to directories are not followed.
 *
 * Sorted paths are this repository's definition for a *tree* artifact. D25
 * fixes the manifest-is-code rule and says the file order is hashed; it does not
 * name an order, because until trees arrived every artifact was a resolved
 * program list. Path order is deterministic across filesystems and independent
 * of readdir order, which is the property a grant needs.
 */
export function listTreeFiles(root: string, dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTreeFiles(root, path))
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        if (!statSync(path).isFile()) continue
      } catch {
        continue
      }
      files.push(relative(root, path).split(sep).join('/'))
    }
  }
  return files.sort()
}

export interface TreeArtifact {
  artifactHash: string
  manifest: ArtifactManifest
  mode: ArtifactMode
  /** Number of files the tree pinned. */
  files: number
}

/** One tree that cannot be pinned honestly; `path` is plugin-relative. */
export interface TreeRefusal {
  path: string
  reason: string
}

export interface TreeOptions {
  /**
   * Absolute paths to leave out of the tree — the plugin's data directory.
   * `.git` and `node_modules` are always left out: neither is authored plugin
   * code, and a mod that imported dependency code would load bytes the grant
   * never reviewed.
   */
  exclude?: readonly string[]
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

/** `path` is `base` or below it (lexical). */
function within(base: string, path: string): boolean {
  const rel = relative(base, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The most a mod tree may occupy; the snapshot is held in memory once. */
export const MAX_TREE_BYTES = 64 * 1024 * 1024

export type TreeScan =
  | {
      ok: true
      files: ArtifactFile[]
      /**
       * The exact bytes every file had when it was hashed, keyed by
       * plugin-relative path. `loadMod` compiles from this map, so the digest
       * and the code that runs are one snapshot: nothing re-opens a path after
       * the scan (D52, M1).
       */
      contents: ReadonlyMap<string, Uint8Array>
    }
  | { ok: false; refusal: TreeRefusal }

/**
 * Walk the **whole plugin tree** (D52) and hash every authored file, in
 * ascending plugin-relative path order.
 *
 * Pinning only the entry's directory pins the wrong thing: a mod may import any
 * file under its root, so every file under the root is code-capable. Paths are
 * stored relative to the root and hashed as such, so the same bytes at two
 * checkout roots produce the same digest. A symlink whose realpath leaves the
 * root, or a directory symlink, is a typed refusal — never skipped.
 */
export function scanTree(root: string, options: TreeOptions = {}): TreeScan {
  const base = resolve(root)
  const excluded = (options.exclude ?? []).map((path) => resolve(path))
  const files: ArtifactFile[] = []
  const contents = new Map<string, Uint8Array>()
  let total = 0

  const walk = (dir: string): TreeRefusal | undefined => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      const path = relative(base, dir).split(sep).join('/')
      return { path, reason: `cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown'})` }
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      const path = relative(base, absolute).split(sep).join('/')
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue
      if (excluded.some((skip) => absolute === skip || absolute.startsWith(`${skip}${sep}`))) continue
      if (entry.isSymbolicLink()) {
        let real: string
        try {
          real = realpathSync(absolute)
        } catch (error) {
          return { path, reason: `symlink is unreadable (${(error as NodeJS.ErrnoException).code ?? 'unknown'})` }
        }
        if (!within(base, real)) {
          return {
            path,
            reason: `symlink resolves outside the plugin root (${real}); a mod loads only files the grant pins`,
          }
        }
        let target
        try {
          target = statSync(real)
        } catch (error) {
          return { path, reason: `symlink target is unreadable (${(error as NodeJS.ErrnoException).code ?? 'unknown'})` }
        }
        if (target.isDirectory()) {
          return { path, reason: 'directory symlink is refused: the loader would follow a tree the manifest cannot name' }
        }
        if (!target.isFile()) continue
        const bytes = readFileSync(absolute)
        total += bytes.byteLength
        if (total > MAX_TREE_BYTES) {
          return { path, reason: 'the tree is larger than the 64 MiB snapshot cap; the host will not hold a bigger map in memory' }
        }
        contents.set(path, bytes)
        files.push({ path, sha256: hashBytes(bytes), bytes: bytes.byteLength })
        continue
      }
      if (entry.isDirectory()) {
        const refusal = walk(absolute)
        if (refusal !== undefined) return refusal
        continue
      }
      if (!entry.isFile()) continue
      const bytes = readFileSync(absolute)
      total += bytes.byteLength
      if (total > MAX_TREE_BYTES) {
        return { path, reason: 'the tree is larger than the 64 MiB snapshot cap; the host will not hold a bigger map in memory' }
      }
      contents.set(path, bytes)
      files.push({ path, sha256: hashBytes(bytes), bytes: bytes.byteLength })
    }
    return undefined
  }

  const refusal = walk(base)
  if (refusal !== undefined) return { ok: false, refusal }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { ok: true, files, contents }
}

export type TreeResult = { ok: true; artifact: TreeArtifact } | { ok: false; refusal: TreeRefusal }

/**
 * Resolve a mod's artifact: **the plugin tree** (D52).
 *
 * `entry` is the plugin-relative loader entry (`hooks/register.ts`); it must be
 * one of the tree's files. `invocation` is that entry text, `command` is empty —
 * a mod is evaluated by the host, never spawned. A tree of one file is `file`
 * mode; anything larger is `composite`.
 */
export function treeArtifact(root: string, entry: string, options: TreeOptions = {}): TreeResult {
  const scan = scanTree(root, options)
  if (!scan.ok) return scan
  if (!scan.files.some((file) => file.path === entry)) {
    return { ok: false, refusal: { path: entry, reason: 'the entry is not one of the tree\'s files' } }
  }
  const manifest: ArtifactManifest = {
    mode: scan.files.length === 1 ? 'file' : 'composite',
    invocation: entry,
    command: '',
    files: scan.files,
  }
  return {
    ok: true,
    artifact: {
      artifactHash: hashManifest(manifest),
      manifest,
      mode: manifest.mode,
      files: scan.files.length,
    },
  }
}

/**
 * A deliberately small shell word splitter: quotes and backslash escapes are
 * honoured, expansions are not performed. Enough to find the program word
 * without pretending to be a shell.
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

/** Interpreters whose first non-flag operand names the program to run. */
const INTERPRETERS = new Set([
  'bash',
  'bun',
  'dash',
  'deno',
  'ksh',
  'node',
  'nodejs',
  'perl',
  'php',
  'pwsh',
  'python',
  'python3',
  'ruby',
  'sh',
  'zsh',
])

function isInterpreter(word: string): boolean {
  const name = basename(expandRoot(word, '')).toLowerCase()
  return INTERPRETERS.has(name) || /^python\d+(?:\.\d+)?$/.test(name)
}

/** Interpreter flags whose *value* is code, not a path. */
function evalFlag(executable: string, words: readonly string[], start: number): boolean {
  const program = basename(executable)
  // Only flags before the first operand belong to the interpreter. In
  // `node fmt.js -e x`, `-e` is an argument to fmt.js, not an eval flag.
  for (let index = start; index < words.length; index++) {
    const word = words[index] as string
    if (word === '--') return false
    if (!word.startsWith('-')) return false
    if (program === 'node' || program === 'nodejs') {
      if (word === '-e' || word === '--eval' || word === '-p' || word === '--print') return true
      if (word.startsWith('--eval=') || word.startsWith('--print=')) return true
    } else if (['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(program)) {
      if (word === '-c') return true
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word) && word.length > 2) return true
    } else if (['perl', 'ruby'].includes(program)) {
      if (word === '-e') return true
    } else if (program === 'php') {
      if (word === '-r') return true
    } else if (program === 'python' || program === 'python3' || /^python\d/.test(program)) {
      if (word === '-c' || word === '-m') return true
    }
  }
  return false
}
function shellHasEval(words: readonly string[]): boolean {
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string
    if (evalFlag(word, words, index + 1)) return true
  }
  return false
}

interface Program {
  file?: ArtifactFile
  unsupported?: string
}

function absoluteProgram(word: string, root: string): Program {
  const absolute = resolve(expandRoot(word, root))
  if (!insideRoot(root, absolute)) {
    return {
      unsupported: `program "${word}" is outside the plugin root; copy it in or use an absolute path inside \${CLAUDE_PLUGIN_ROOT}`,
    }
  }
  if (fileKind(absolute) !== 'file') {
    return { unsupported: `program "${word}" does not exist and cannot be pinned` }
  }
  return { file: fileEntry(absolute) }
}

function relativeProgram(word: string, root: string): Program {
  const relativeToRoot = fileKind(resolve(root, word)) === 'file'
  const relativeToCwd = fileKind(resolve(process.cwd(), word)) === 'file'
  if (!looksPathLike(word) && !relativeToRoot && !relativeToCwd) return {}
  return {
    unsupported: `program "${word}" is relative; hooks run with the project directory as cwd; use \${CLAUDE_PLUGIN_ROOT}/${word.replace(/^\.\//, '')}`,
  }
}

/**
 * Find the program word. `words[0]` can name the program directly, or name a
 * known interpreter whose first non-flag operand is the program. Everything
 * after that first operand is data.
 */
function programFor(words: readonly string[], root: string): Program {
  const first = words[0]
  if (first === undefined) return {}
  const expanded = expandRoot(first, root)
  if (isAbsolute(expanded)) return absoluteProgram(first, root)
  if (looksPathLike(first)) return relativeProgram(first, root)
  if (!isInterpreter(first)) return {}

  for (const word of words.slice(1)) {
    if (word === '--') continue
    if (word.startsWith('-')) continue
    if (isAbsolute(expandRoot(word, root))) return absoluteProgram(word, root)
    const candidate = resolve(root, word)
    const inRoot = fileKind(candidate) === 'file'
    const inCwd = fileKind(resolve(process.cwd(), word)) === 'file'
    if (looksPathLike(word) || inRoot || inCwd) return relativeProgram(word, root)
    // A non-file word is not the program; keep looking for the first operand
    // that resolves to a file.
  }
  return {}
}

const SHELL_OPERATORS = new Set(['|', '||', '&&', ';', '&'])

/**
 * A shell command can run several programs (`cat data | node fmt.js`). Pin the
 * program of each segment; data operands in every segment stay text. A refused
 * program in any segment refuses the whole artifact.
 */
function programsForShell(
  words: readonly string[],
  root: string,
): { files: ArtifactFile[]; unsupported?: string } {
  const files: ArtifactFile[] = []
  let segment: string[] = []
  const flush = (): string | undefined => {
    if (segment.length === 0) return undefined
    const program = programFor(segment, root)
    if (program.file !== undefined) files.push(program.file)
    segment = []
    return program.unsupported
  }
  for (const word of words) {
    if (SHELL_OPERATORS.has(word)) {
      const problem = flush()
      if (problem !== undefined) return { files, unsupported: problem }
      continue
    }
    segment.push(word)
  }
  const problem = flush()
  return { files, ...(problem === undefined ? {} : { unsupported: problem }) }
}

/**
 * Resolve one command hook into a manifest plus hash.
 *
 * Exec form (`args` present) and shell form share the same rule: the program
 * is code and is pinned; data operands are invocation text only. Eval payloads
 * are code text and pin no file.
 */
export function hashHook(root: string, hook: IrHook): HookArtifact {
  const command = hook.command
  if (command === undefined) throw new Error(`hook ${hook.event}#${hook.index} has no command`)
  const base = resolve(root)

  if (hook.args !== undefined) {
    const invocation = [command, ...hook.args]
    if (evalFlag(command, invocation, 1)) {
      const manifest: ArtifactManifest = { mode: 'text', invocation, command: invocation, files: [] }
      return {
        artifactHash: hashManifest(manifest),
        manifest,
        sourcePath: hook.sourcePath,
        mode: 'text',
      }
    }
    const program = programFor(invocation, base)
    const manifest: ArtifactManifest = {
      mode: program.file === undefined ? 'text' : invocation.length === 1 ? 'file' : 'composite',
      invocation,
      command: '',
      files: program.file === undefined ? [] : [program.file],
    }
    return {
      artifactHash: hashManifest(manifest),
      manifest,
      sourcePath:
        program.file === undefined ? hook.sourcePath : relativePath(base, program.file.path),
      mode: manifest.mode,
      ...(program.unsupported === undefined ? {} : { unsupported: program.unsupported }),
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

  const program = programsForShell(words, base)
  const manifest: ArtifactManifest = {
    mode: program.files.length === 0 ? 'text' : words.length === 1 ? 'file' : 'composite',
    invocation: command,
    command: '',
    files: program.files,
  }
  return {
    artifactHash: hashManifest(manifest),
    manifest,
    sourcePath:
      program.files.length === 1
        ? relativePath(base, (program.files[0] as ArtifactFile).path)
        : hook.sourcePath,
    mode: manifest.mode,
    ...(program.unsupported === undefined ? {} : { unsupported: program.unsupported }),
  }
}

/**
 * UI preview of the exact manifest, not a re-scan: the command line, mode, and
 * the pinned program files. A changed artifact is shown as a different line,
 * which is what the installer prompts with.
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
