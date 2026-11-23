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
export const isReceipt = (comment) =>
  /^\s*(<!--\s*dsh-anyplugin-agent\s*-->\s*)?Seen\./u.test(comment.body ?? '')

const isAgentReply = (comment, options) => isAgentComment(comment, options) && !isReceipt(comment)

export const lastAgentComment = (list, options) => [...list].reverse().find((comment) => isAgentComment(comment, options))

/** The last agent comment that answered something, receipts excluded. */
export const lastAgentReply = (list, options) => [...list].reverse().find((comment) => isAgentReply(comment, options))

export const lastNonAgentComment = (list, options) =>
  [...list].reverse().find((comment) => !isAgentComment(comment, options))

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
  const human = lastNonAgentComment(comments, options)
  const agentAfterHuman = reply !== undefined && (human === undefined || reply.createdAt > human.createdAt)
  const lastSpeaker = reply === undefined ? (human === undefined ? 'none' : 'maintainer') : agentAfterHuman ? 'agent' : 'maintainer'

  // An escalation (docs/TRIAGE.md §6) is blocked on the human *while the agent
  // has the last word*: it asked, and nothing can move until the answer comes.
  // The opposite ordering is "Maintainer answers (resume)".
  if (hasLabel(issue, 'maintainer-question') && agent !== undefined && (agentAfterHuman || reply === undefined)) {
    return { section: 'Blocked on a human', lastSpeaker }
  }
  if (who === 'maintainer') {
    if (agent === undefined) return { section: 'Maintainer asks (new)', lastSpeaker }
    if (!agentAfterHuman) return { section: 'Maintainer answers (resume)', lastSpeaker }
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
