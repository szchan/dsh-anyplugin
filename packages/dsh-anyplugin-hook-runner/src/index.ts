// The plumbing between a Claude-style hook declaration and a decision this
// host can act on: build the payload, run the command, read the verdict.
//
// This package holds no policy about *where* a hook is mounted — the
// materializer owns that. Keeping the translation here means the payload shape
// and the exit-code contract can be tested against the recorded fixtures
// (D15) without booting a harness.
import { spawn } from 'node:child_process'

/** A hook handler as authored: a shell command, or an exec-form pair. */
export interface CommandHook {
  command: string
  /** When present the command runs without a shell (`sh -c` would re-split it). */
  args?: readonly string[]
  /** Seconds, as authored upstream. */
  timeout?: number
}

export interface HookRunResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** Why the process could not be started at all, when that happened. */
  spawnError?: string
}

export interface HookVerdict {
  /** Block the call (PreToolUse) or feed it back as an error (PostToolUse). */
  deny?: string
  /** Text the model reads on its next turn. */
  additionalContext?: string
  /** Something we could not carry; surfaced as a warning, never silently. */
  warn?: string
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Build the JSON a hook reads on stdin. Only fields this host can honestly
 * supply are present: a hook that branches on `session_id` sees it absent
 * rather than invented (D19).
 */
export function buildHookPayload(
  event: string,
  input: {
    toolName: string
    toolInput: unknown
    toolUseId: string
    toolResponse?: unknown
    cwd?: string
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    hook_event_name: event,
    cwd: input.cwd ?? process.cwd(),
    tool_name: input.toolName,
    tool_input: input.toolInput,
    tool_use_id: input.toolUseId,
  }
  if (input.toolResponse !== undefined) payload.tool_response = input.toolResponse
  return payload
}

/** Run one command handler with `payload` on stdin. Never throws. */
export async function runCommandHook(
  hook: CommandHook,
  payload: Record<string, unknown>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<HookRunResult> {
  const timeoutMs = options.timeoutMs ?? (hook.timeout === undefined ? DEFAULT_TIMEOUT_MS : hook.timeout * 1000)
  const useShell = hook.args === undefined
  const child = useShell
    ? spawn('sh', ['-c', hook.command], { cwd: options.cwd, env: options.env ?? process.env })
    : spawn(hook.command, [...(hook.args ?? [])], { cwd: options.cwd, env: options.env ?? process.env })

  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout?.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  return new Promise<HookRunResult>((resolve) => {
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout: stdout.join(''), stderr: stderr.join(''), timedOut, spawnError: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout: stdout.join(''), stderr: stderr.join(''), timedOut })
    })
    // A hook that exits without reading stdin must not crash on EPIPE.
    child.stdin?.on('error', () => {})
    child.stdin?.end(`${JSON.stringify(payload)}\n`)
  })
}

interface HookJson {
  continue?: boolean
  stopReason?: string
  decision?: string
  reason?: string
  systemMessage?: string
  suppressOutput?: boolean
  hookSpecificOutput?: {
    hookEventName?: string
    permissionDecision?: string
    permissionDecisionReason?: string
    additionalContext?: string
  }
}

/**
 * Translate one finished handler into a verdict.
 *
 * Upstream contract, as recorded from the 2.1.322 fixtures:
 *  - exit 2 blocks, and the reason is stderr;
 *  - exit 0 may carry JSON, whose `decision: "block"` or
 *    `hookSpecificOutput.permissionDecision: "deny"` blocks;
 *  - `hookSpecificOutput.additionalContext` (any exit) reaches the model;
 *  - any other non-zero exit is a non-blocking error.
 */
export function judgeHookResult(result: HookRunResult, event: string): HookVerdict {
  if (result.spawnError !== undefined) return { warn: `hook could not start: ${result.spawnError}` }
  if (result.timedOut) return { warn: `hook timed out after ${DEFAULT_TIMEOUT_MS / 1000}s` }

  if (result.exitCode === 2) {
    const reason = result.stderr.trim()
    return { deny: reason === '' ? `blocked by ${event} hook` : reason }
  }
  if (result.exitCode !== 0) {
    return { warn: `hook exited ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}` }
  }

  const text = result.stdout.trim()
  if (text === '') return {}

  let parsed: HookJson
  try {
    parsed = JSON.parse(text) as HookJson
  } catch {
    // Plain stdout is transcript-only upstream: it never reaches the model.
    return { warn: 'hook wrote non-JSON to stdout; ignored (upstream: transcript only)' }
  }

  const verdict: HookVerdict = {}
  const specific = parsed.hookSpecificOutput
  if (specific?.additionalContext !== undefined && specific.additionalContext !== '') {
    verdict.additionalContext = specific.additionalContext
  }
  if (parsed.continue === false) {
    verdict.warn = 'hook returned continue:false, which has no equivalent here; ignored'
  }
  if (parsed.decision === 'block') {
    verdict.deny = parsed.reason ?? `blocked by ${event} hook`
  } else if (specific?.permissionDecision === 'deny') {
    verdict.deny = specific.permissionDecisionReason ?? `blocked by ${event} hook`
  } else if (specific?.permissionDecision === 'ask' || specific?.permissionDecision === 'allow') {
    // `allow` grants nothing beyond what the host already decided, and `ask`
    // needs the approval seam; neither is expressible here.
    verdict.warn = `permissionDecision ${JSON.stringify(specific.permissionDecision)} has no equivalent here; ignored`
  }
  return verdict
}

/**
 * Upstream matcher grammar: a regular expression over the tool name, `*` or
 * absent for everything. A malformed pattern matches nothing rather than
 * everything — failing open on a bad regex would run a hook the author did not
 * intend.
 */
export function matcherMatches(pattern: string | undefined, name: string): boolean {
  if (pattern === undefined || pattern === '' || pattern === '*') return true
  try {
    return new RegExp(pattern).test(name)
  } catch {
    return false
  }
}
