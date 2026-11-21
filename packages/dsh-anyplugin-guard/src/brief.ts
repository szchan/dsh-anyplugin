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
  lines.push('</anyplugin-guard-brief>')
  return lines.join('\n')
}

/** The message shape `agent/pre-step` appends to its default continuation. */
export function textMessage(text: string): { role: 'user'; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'user', content: [{ type: 'text', text }] }
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
 * parentSessionId, id, local}`), so the only reliable source is the prompt the
 * worker was spawned with. The order is deliberate: an explicit absolute path
 * wins, a `ticket/<n>` branch resolves against the installer's worktree names,
 * a session cwd that is already inside a worktree is accepted, and a single
 * configured worktree is the fallback. With none of those, nothing is
 * recorded and every write outside a configured worktree is denied — fail
 * closed, not open.
 */
export function chooseWorktree(input: { text: string; cwd?: string; worktrees: string[] }): string | undefined {
  const worktrees = input.worktrees.map((path) => path.replace(/\/+$/u, ''))
  if (worktrees.length === 0) return undefined
  if (input.text.length > 0) {
    const mentioned = worktrees.filter((path) => input.text.includes(path)).sort((a, b) => b.length - a.length)
    if (mentioned.length > 0) return mentioned[0]
    const tickets = new Set([...input.text.matchAll(/\bticket\/(\d+)\b/gu)].map((match) => match[1]))
    if (tickets.size === 1) {
      const [ticket] = tickets
      const named = worktrees.filter((path) => path.split('/').some((part) => part === `ticket-${ticket}`))
      if (named.length === 1) return named[0]
    }
  }
  if (input.cwd !== undefined) {
    const inside = worktrees.filter((path) => isInside(path, input.cwd as string))
    if (inside.length === 1) return inside[0]
  }
  return worktrees.length === 1 ? worktrees[0] : undefined
}
