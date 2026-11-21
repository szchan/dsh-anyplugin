/**
 * The SubagentStart brief, as injected context.
 *
 * The pin has no `SubagentStartRequest.instructions` field (S10), and a
 * system-prompt route needs an agent preset the worker was not started with.
 * The one seam that can deliver text at spawn time is `agent/pre-step`: its
 * waterfall returns `{kind: 'enter', messages}` and whatever is appended there
 * reaches the first model step. So the brief is a message, not a prose file
 * the worker is told to read — a file can be skipped, a message is in context.
 *
 * What it carries is the state that would otherwise be re-derived by hand:
 * the worktree path the worker owns, the ratchet totals it must not move, the
 * rows the ratchet is still red on, and the four call-time rules the guard
 * enforces. The guard records the worktree path from the same text, so the
 * brief and the enforcement cannot disagree.
 */
import { randomUUID } from 'node:crypto'
import { isInside, type BriefConfig } from './policy.ts'

export interface BriefInput {
  worktree?: string
  cwd?: string
  config: BriefConfig | false
}

/** Render the brief block. Missing pieces are omitted, never invented. */
export function renderBrief(input: BriefInput): string {
  const lines: string[] = ['<anyplugin-guard-brief>']
  if (input.worktree !== undefined) {
    lines.push(`Worktree: ${input.worktree}`)
    lines.push(
      `Write only inside that worktree, with absolute paths. The session cwd${input.cwd === undefined ? '' : ` (${input.cwd})`} is not automatically your worktree.`,
    )
  } else {
    lines.push('Worktree: not recorded for this agent; pass absolute paths and stay inside the ticket worktree.')
  }
  const brief = input.config === false ? undefined : input.config
  if (brief !== undefined && brief.ratchet.length > 0) {
    const fixtures = brief.fixtures === undefined ? '' : `, ${brief.fixtures}`
    lines.push(`Coverage ratchet (packages/dsh-anyplugin-conformance/test/coverage.test.mjs): ${brief.ratchet.join(' / ')}${fixtures}.`)
  }
  if (brief !== undefined && brief.open.length > 0) {
    lines.push(`Open ratchet rows: ${brief.open.join(', ')}.`)
  }
  lines.push(
    'Call-time rules: push only the ticket branch, never main; open a PR, never merge one; docs/DECISIONS.md is append-only through `node scripts/check-decisions.mjs --update` and the proposed entry text belongs in the PR body; do not move coverage totals.',
  )
  lines.push(
    'Shell subset: one command list per call. `&&`, `||`, `|` and redirections (including `2>&1`) are modelled. Grouping, a background `&`, command substitution, backticks and unquoted `$` expansion are refused; put them in a script file and run `bash scripts/<file>`.',
  )
  lines.push('</anyplugin-guard-brief>')
  return lines.join('\n')
}

/**
 * A user message the agent loop accepts.
 *
 * This reproduces `createUserMessage` from the pinned `dsh-llm` exactly —
 * a branded UUID id, the text block, and `source.kind = 'user'` — because the
 * plugin cannot import that constructor: it is loaded out of tree from this
 * repository, whose hoisted `@deepseek-ai/dsh-llm` is the stale `latest`
 * (0.0.1-rc.1, not the pin), and adding a second pinned host copy is outside
 * this ticket (D8). The live test boots the real loop at the pin and shows the
 * loop accepts this message: `dsh-agent-loop/lib/index.js:873` reads
 * `message.source.kind` on every appended message, and a message without
 * `source` throws before the first model call. `runtime-context` is the
 * snapshot kind the loop consumes differently; a queued prompt is `user`.
 */
export interface GuardUserMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' }
}

export function textMessage(text: string): GuardUserMessage {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]) as Array<{ type: 'text'; text: string }>,
    source: Object.freeze({ kind: 'user' }),
  })
}

/** Text of every message a pre-step payload carries, for worktree discovery. */
export function messageText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text)
      }
    }
  }
  return parts.join('\n')
}

/**
 * Which worktree this worker owns, from the first step it takes.
 *
 * The spawn payload carries no worktree (S9: `{runId, provider,
 * parentSessionId, id, local}`). A worktree is accepted from exactly two
 * places, never from a branch name: the prompt may name a configured worktree
 * path literally (a master delegates with "worktree `/tmp/…`"), or the
 * session cwd may already be a configured worktree root. A branch name is not
 * a path — a reviewer's prompt names the branch under review, and inferring
 * from it would hand the reviewer the author's worktree. With neither source,
 * nothing is recorded and the confinement denies every write: fail closed.
 */
export function chooseWorktree(input: { text: string; cwd?: string; worktrees: string[] }): string | undefined {
  const worktrees = input.worktrees.map((path) => path.replace(/\/+$/u, '')).filter((path) => path.length > 0)
  if (worktrees.length === 0) return undefined
  if (input.text.length > 0) {
    const mentioned = worktrees.filter((path) => input.text.includes(path))
    if (mentioned.length === 1) return mentioned[0]
    if (mentioned.length > 1) return undefined
  }
  if (input.cwd !== undefined) {
    const inside = worktrees.filter((path) => isInside(path, input.cwd as string))
    if (inside.length === 1) return inside[0]
  }
  return undefined
}
