/**
 * The structured denial log (F16).
 *
 * A `tools/pre-execute` denial is the only moment a rule fires, and until this
 * file the only record was the prose in the tool result: the audit could count
 * `DENY` strings in transcripts, but agents run the guard's own tests, so that
 * count included the suite and could not answer "which rule fired on a real
 * call?". One JSON line per denial answers it without a second event path.
 *
 * Two properties are deliberate:
 *
 * - **Best-effort.** The verdict is the guard's contract; the record is an
 *   observation of it. A read-only checkout, a full disk, a FIFO or a bad
 *   override must not turn an allow into a deny (or a deny into a crash). The
 *   first failure is reported once per process and the guard continues.
 * - **Not the arguments blob.** The log is a redacted excerpt of what the rule
 *   judged, capped at 300 characters. Tokens, bearer/basic headers and long
 *   hex/base64 runs are replaced before the line is written; `arguments` is
 *   never serialized.
 *
 * The duplicate this suppresses is two *app-level* plugin loads (the same
 * plugin listed twice) seeing one call: `tools/pre-execute` is mounted
 * app-level only, and the per-agent seat is brief-only. Keying on
 * `session + callId` keeps that dedupe while leaving two sessions that happen
 * to share an id (they cannot in DSH, but the record must not depend on that
 * invariant) as two refusals.
 */
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mainCheckout } from './composition.ts'
import { writeTargets } from './policy.ts'

export type DenialRole = 'root' | 'worker'

export interface DenialInput {
  /** The call identity the host uses; the double mount passes it twice. */
  callId?: unknown
  role: DenialRole
  rule: string
  tool: string
  cwd?: string | null
  worktree?: string | null
  session?: string | null
  /** The raw command or write target; redacted and capped before writing. */
  subject: string
}

export interface DenialRecord {
  ts: string
  role: DenialRole
  rule: string
  tool: string
  cwd: string | null
  worktree: string | null
  session: string | null
  subject: string
}

const DENIAL_FILE = 'guard-denials.jsonl'
const MAX_SUBJECT = 300
const MAX_SEEN = 512
/** `packages/dsh-anyplugin-guard/src` -> the checkout the module lives in. */
const MODULE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

const seen = new Set<string>()
let warned = false

/**
 * Strip the shapes a credential takes in a command line. This is a guard
 * against accidental logging, not a classifier: an unknown token shape still
 * lands in the file, which is why the file stays inside gitignored `.audit/`.
 *
 * A 40-hex git sha is indistinguishable from a short key at this length, so it
 * is redacted too. The trade-off is deliberate: the rule, tool and role still
 * identify the record, and losing the sha from the excerpt is cheaper than
 * writing a credential to disk.
 */
export function redactSubject(value: string): string {
  return String(value ?? '')
    // Full tokens first, so the prefix goes with the body.
    .replace(/github_pat_[A-Za-z0-9_]{8,}/gu, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gu, '[redacted]')
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{4,}/gu, '[redacted]')
    .replace(/\bxsk-[A-Za-z0-9_-]{4,}/gu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=:-]{4,}/giu, 'Bearer [redacted]')
    .replace(/\b(Authorization:\s*Basic)\s+[A-Za-z0-9+/=_-]{4,}/giu, '$1 [redacted]')
    // Both spellings, and an unterminated quote: a shell may hand us either.
    .replace(/(--token(?:=|\s+))(?:"[^"]*"?|'[^']*'?|[^\s"']+)/gu, '$1[redacted]')
    // A 32+ hex run is a hash or a key; a 32+ base64/base64url run with no
    // separators is token-shaped. Ordinary paths and commands keep their
    // separators. Base64url's `-`/`_` are included so a blob that straddles
    // the cap cannot leak its tail.
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, '[redacted]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/gu, '[redacted]')
}

function clip(value: string, limit = MAX_SUBJECT): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

/**
 * The command or write target the rule judged — never the whole arguments
 * object. Kept separate from redaction so a test can prove the extraction
 * without a token fixture, and so a failure here cannot escape into the guard.
 */
export function denialSubject(tool: string, args: Record<string, unknown> | undefined): string {
  try {
    const record = args ?? {}
    const command =
      typeof record.command === 'string' ? record.command : typeof record.cmd === 'string' ? record.cmd : undefined
    if (command !== undefined) return command
    const targets = writeTargets(tool, record)
    if (targets.length > 0) return targets.join(' ')
    const path = typeof record.file_path === 'string' ? record.file_path : typeof record.path === 'string' ? record.path : ''
    return path
  } catch {
    return ''
  }
}

/** Walk up to the checkout; `.git` is a directory in a clone and a file in a worktree. */
function repositoryRoot(start: string): string | undefined {
  let current = resolve(start)
  for (;;) {
    try {
      if (existsSync(join(current, '.git'))) return current
    } catch {
      return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * The audit directory both the recorder and `scripts/audit-evidence.mjs` use.
 *
 * The override wins. Otherwise this is `<project root>/.audit`, where the
 * project root is the checkout that owns the repository's `.git` — not the
 * directory the module happens to sit in. The guard is often imported from a
 * linked worktree (`/tmp/anyplugin-wt/...`), and a log written there would be
 * invisible to the audit run from the main checkout. `mainCheckout` is the mod
 * host's derivation (D66). `scripts/audit-checkout.mjs` mirrors it for the audit
 * reader, and the layout test asserts the two agree rather than trusting the
 * duplicate.
 *
 * If git is unavailable, fall back to the nearest `.git` ancestor; if there is
 * none, the invocation directory is the last resort.
 */
export function auditDirectory(env: Record<string, string | undefined> = process.env, start = MODULE_ROOT): string {
  const override = typeof env.DSH_ANYPLUGIN_AUDIT_DIR === 'string' ? env.DSH_ANYPLUGIN_AUDIT_DIR.trim() : ''
  if (override !== '') return resolve(override)
  for (const candidate of [start, process.cwd()]) {
    const checkout = mainCheckout(candidate)
    if (checkout !== undefined) return join(checkout, '.audit')
    const walked = repositoryRoot(candidate)
    if (walked !== undefined) return join(walked, '.audit')
  }
  return join(resolve('.'), '.audit')
}

export function denialFile(env: Record<string, string | undefined> = process.env, start = MODULE_ROOT): string {
  return join(auditDirectory(env, start), DENIAL_FILE)
}

function firstSighting(callId: unknown, session: unknown): boolean {
  if ((typeof callId !== 'string' && typeof callId !== 'number') || String(callId) === '') return true
  const owner = typeof session === 'string' && session !== '' ? session : ''
  const key = `${owner}\u0000${String(callId)}`
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > MAX_SEEN) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

/** `O_NOFOLLOW` keeps a symlinked log from redirecting the write; `O_NONBLOCK` keeps a FIFO from hanging the guard. */
function appendFlags(): number {
  return (
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0)
  )
}

/**
 * Append one record. Returns it when it was written, `undefined` when the call
 * was a duplicate or the write failed; the caller must ignore both cases.
 */
export function recordDenial(input: DenialInput, env: Record<string, string | undefined> = process.env): DenialRecord | undefined {
  try {
    if (!firstSighting(input.callId, input.session)) return undefined
    const record: DenialRecord = {
      ts: new Date().toISOString(),
      role: input.role === 'worker' ? 'worker' : 'root',
      rule: String(input.rule ?? 'unknown'),
      tool: String(input.tool ?? ''),
      cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : null,
      worktree: typeof input.worktree === 'string' && input.worktree !== '' ? input.worktree : null,
      session: typeof input.session === 'string' && input.session !== '' ? input.session : null,
      subject: clip(redactSubject(input.subject ?? '')),
    }
    const file = denialFile(env)
    mkdirSync(dirname(file), { recursive: true })
    // One write on an O_APPEND descriptor: a concurrent process (another agent
    // in the same checkout) appends a whole line, not a splice of two.
    const fd = openSync(file, appendFlags())
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`)
      const line = `${JSON.stringify(record)}\n`
      const expected = Buffer.byteLength(line, 'utf8')
      const written = writeSync(fd, line)
      if (written !== expected) throw new Error(`short write to ${file}: ${written} of ${expected} bytes`)
    } finally {
      closeSync(fd)
    }
    return record
  } catch (error) {
    if (!warned) {
      warned = true
      const message = error instanceof Error ? error.message : String(error)
      console.error(`anyplugin-guard: denial log write failed; the verdict is unchanged (further failures are silent): ${message}`)
    }
    return undefined
  }
}
