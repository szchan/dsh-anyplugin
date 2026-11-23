// Pure classification rules for the tracker queue (docs/TRIAGE.md §2).
//
// `scripts/triage.mjs` is the only caller and does the GitHub I/O; this module
// is the decision table, so the two bugs it has already had — a human-blocked
// escalation filed as work, and a bot-authored PR filed as external — can be
// pinned by tests instead of by reading the output.

export const AGENT_MARK = '<!-- dsh-anyplugin-agent -->'
export const BOT_LOGIN = process.env.DSH_ANYPLUGIN_BOT_LOGIN ?? 'szchan-bot'

export const labelsOf = (node) => (node.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name))

export const hasLabel = (node, name) => labelsOf(node).includes(name)

/** The bot is ours. A PR it authored is not an external contribution. */
export const isOurs = (login, { maintainers, botLogin }) => login !== undefined && login !== '' && (maintainers.includes(login) || login === botLogin)

// Labels are authoritative when present; the author is the fallback so that a
// maintainer's issue is never queued as external just because labelling lagged.
export const roleOf = (node, options) => {
  if (hasLabel(node, 'from-maintainer')) return 'maintainer'
  if (hasLabel(node, 'external')) return 'external'
  return isOurs(node.author?.login, options) ? 'maintainer' : 'external'
}

const isAgentComment = (comment, options) =>
  comment.author?.login === options.botLogin || (comment.body ?? '').includes(AGENT_MARK)

// A receipt is "I have seen your message", not an answer. The intake path
// posts one the moment a session picks the thread up, and counting it as a
// reply makes a maintainer's unanswered question look answered — that is how
// #170/#175/#177 sat for a day (D79).
// The intake path's receipt has a fixed opening. Matching the whole opening —
// not just "Seen." — keeps an agent's real answer from being discarded; the
// two suffixes below are the ones observed on this repo (#170/#175/#177/#221).
export const RECEIPT_PATTERN = /^\s*(?:<!--\s*dsh-anyplugin-agent\s*-->\s*)?[Ss]een\.\s+[Tt]he master acts on this at its next turn boundary[\s\S]*$/u

export const isReceipt = (comment) => RECEIPT_PATTERN.test(comment.body ?? '')

const isAgentReply = (comment, options) => isAgentComment(comment, options) && !isReceipt(comment)

export const lastAgentComment = (list, options) => [...list].reverse().find((comment) => isAgentComment(comment, options))

/** The last agent comment that answered something, receipts excluded. */
export const lastAgentReply = (list, options) => [...list].reverse().find((comment) => isAgentReply(comment, options))

export const lastNonAgentComment = (list, options) =>
  [...list].reverse().find((comment) => !isAgentComment(comment, options))

// Only a maintainer's comment can unblock a thread. A bystander's "+1" on a
// bot escalation is a report, not an answer (docs/TRIAGE.md §6).
const lastMaintainerComment = (list, options) =>
  [...list].reverse().find((comment) => options.maintainers.includes(comment.author?.login ?? ''))

/**
 * One open issue -> the queue section it belongs to, or `null` when it is
 * somebody else's turn (an agent replied and the thread needs no further act).
 */
export const classifyIssue = (issue, comments, options) => {
  if (options.linkedPr === true) return { section: 'In review (PR open)', lastSpeaker: 'in flight' }
  if (hasLabel(issue, 'ticket/in-progress')) return { section: 'In progress (no PR yet)', lastSpeaker: 'in flight' }

  const who = roleOf(issue, options)
  const agent = lastAgentComment(comments, options)
  const reply = lastAgentReply(comments, options)
  const human = lastMaintainerComment(comments, options)
  const lastHuman = lastNonAgentComment(comments, options)
  // Ordering uses any human word for "someone replied after the agent"; the
  // right to *resume* an escalation belongs to a maintainer alone, so a
  // bystander's "+1" cannot move a row (reviewer finding on #228).
  const agentAfterHuman = reply !== undefined && (lastHuman === undefined || (reply.createdAt ?? '') > (lastHuman.createdAt ?? ''))
  const agentAfterMaintainer = reply !== undefined && (human === undefined || (reply.createdAt ?? '') > (human.createdAt ?? ''))
  // The speaker is the author of the last substantive comment (a receipt is
  // not speech), not a derived guess: a bystander after a maintainer must not
  // be reported as the maintainer.
  const last = [...comments].reverse().find((comment) => !isReceipt(comment))
  const lastSpeaker =
    last === undefined
      ? 'none'
      : isAgentComment(last, options)
        ? 'agent'
        : options.maintainers.includes(last.author?.login ?? '')
          ? 'maintainer'
          : 'external'

  // An escalation (docs/TRIAGE.md §6) is blocked on the human *while the agent
  // has the last word*: it asked, and nothing can move until the answer comes.
  // The opposite ordering is "Maintainer answers (resume)".
  if (hasLabel(issue, 'maintainer-question') && agent !== undefined) {
    // No maintainer word, or the agent has the last word after one: the
    // escalation is still open. Only a maintainer's later word resumes it.
    if (human === undefined || agentAfterMaintainer) return { section: 'Blocked on a human', lastSpeaker }
    return { section: 'Maintainer answers (resume)', lastSpeaker }
  }
  if (who === 'maintainer') {
    if (agent === undefined) return { section: 'Maintainer asks (new)', lastSpeaker }
    if (!agentAfterMaintainer && human !== undefined) return { section: 'Maintainer answers (resume)', lastSpeaker }
    return { section: null, lastSpeaker }
  }
  if (agent === undefined) return { section: 'External, untriaged', lastSpeaker }
  // The agent asked for evidence and the reporter has not answered yet.
  if (agentAfterHuman && hasLabel(issue, 'needs-evidence')) return { section: 'External, awaiting evidence', lastSpeaker }
  // Someone replied after the agent: that reply needs reading before anything else.
  return { section: 'External, untriaged', lastSpeaker }
}

/** PRs are a flat list; the role is the only classification. */
export const roleOfPullRequest = (pr, options) => (isOurs(pr.author?.login, options) ? 'maintainer' : 'external')

/**
 * What `npm run inbox` says and returns.
 *
 * 0 — nothing waits; 1 — a maintainer has the last substantive word (a reply or
 * a new ask); 2 — the tracker could not be read, so "nothing waits" would be a
 * lie. Receipts are not answers (D79).
 */
export const inboxVerdict = (sections, failures = []) => {
  const tag = (name) => (sections[name] ?? []).map((item) => ({ ...item, section: name }))
  const resume = tag('Maintainer answers (resume)')
  const asks = tag('Maintainer asks (new)')
  const blocked = tag('Blocked on a human')
  const waiting = [...asks, ...resume]
  return {
    waiting,
    blocked,
    failures,
    exitCode: failures.length > 0 ? 2 : waiting.length > 0 ? 1 : 0,
    summary: `inbox: ${waiting.length} thread(s) waiting, ${blocked.length} escalation(s) open, ${failures.length} thread(s) unreadable`,
  }
}
