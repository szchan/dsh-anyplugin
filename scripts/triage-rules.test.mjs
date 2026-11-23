import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIssue, inboxVerdict, isAgentFinding, isOurs, isReceipt, roleOf, roleOfIssue, roleOfPullRequest } from './triage-rules.mjs'

const options = { maintainers: ['szchan'], botLogin: 'szchan-bot' }
const issue = (extra = {}) => ({ number: 1, title: 'x', author: { login: 'szchan' }, labels: [], ...extra })
const labels = (...names) => names.map((name) => ({ name }))
const comment = (login, createdAt, body = '') => ({ author: { login }, createdAt, body })

test('an escalation the agent opened last is blocked on the human', () => {
  // The bug that hid #97: the section only filled when the maintainer answered.
  const verdict = classifyIssue(
    issue({ labels: labels('maintainer-question') }),
    [comment('szchan-bot', '2026-11-21T08:00:00Z', '<!-- dsh-anyplugin-agent --> asking')],
    options,
  )
  assert.equal(verdict.section, 'Blocked on a human')
})

test('a maintainer reply after the escalation resumes work', () => {
  const verdict = classifyIssue(
    issue({ labels: labels('maintainer-question') }),
    [comment('szchan-bot', '2026-11-21T08:00:00Z', '<!-- dsh-anyplugin-agent --> asking'), comment('szchan', '2026-11-21T09:00:00Z', 'approved')],
    options,
  )
  assert.equal(verdict.section, 'Maintainer answers (resume)')
})

test('a receipt after a maintainer reply does not count as the agent answering (#170/#175/#177)', () => {
  // The intake path posts "Seen." the moment the thread is picked up. Counting
  // it as a reply made an unanswered question look answered for a day.
  const verdict = classifyIssue(
    issue({ labels: labels('maintainer-question') }),
    [
      comment('szchan-bot', '2026-11-22T08:00:00Z', '<!-- dsh-anyplugin-agent --> asking'),
      comment('szchan', '2026-11-22T12:31:05Z', 'accepted, implement it'),
      comment('szchan-bot', '2026-11-22T12:45:39Z', '<!-- dsh-anyplugin-agent --> Seen. The master acts on this at its next turn boundary; this note exists so the reply is not a silent queue.'),
    ],
    options,
  )
  assert.equal(verdict.section, 'Maintainer answers (resume)')
  assert.equal(verdict.lastSpeaker, 'maintainer')
})

test('a receipt after the agent asked still leaves the escalation blocked', () => {
  const verdict = classifyIssue(
    issue({ labels: labels('maintainer-question') }),
    [
      comment('szchan-bot', '2026-11-22T08:00:00Z', '<!-- dsh-anyplugin-agent --> may I change the gate?'),
      comment('szchan-bot', '2026-11-22T08:01:00Z', '<!-- dsh-anyplugin-agent --> Seen. The master acts on this at its next turn boundary.'),
    ],
    options,
  )
  assert.equal(verdict.section, 'Blocked on a human')
})

test('a maintainer issue with no agent comment is a new ask', () => {
  assert.equal(classifyIssue(issue(), [], options).section, 'Maintainer asks (new)')
})

test('a bot-filed arch: finding is an agent finding, not a maintainer ask (D83)', () => {
  // The D82 reviewer files as the bot and `roleOf` reads the bot as a
  // maintainer: without the class this finding was printed in no section at
  // all, and a maintainer comment on it looked like a maintainer reply.
  const verdict = classifyIssue(
    issue({ author: { login: 'szchan-bot' }, title: 'arch: FEATURES row F4 points at a deleted file' }),
    [comment('szchan-bot', '2026-11-23T07:00:00Z', '<!-- dsh-anyplugin-agent --> the row points at a deleted file')],
    options,
  )
  assert.equal(verdict.section, 'Agent findings (review)')
  assert.equal(verdict.lastSpeaker, 'agent')
})

test('the finding class does not depend on the body-first-comment injection', () => {
  const verdict = classifyIssue(issue({ author: { login: 'szchan-bot' }, title: 'Arch: capitalised prefix still counts' }), [], options)
  assert.equal(verdict.section, 'Agent findings (review)')
})

test('a maintainer comment on a finding still resumes work (D83)', () => {
  const verdict = classifyIssue(
    issue({ author: { login: 'szchan-bot' }, title: 'arch: two writers share docs/TRIAGE.md' }),
    [comment('szchan-bot', '2026-11-23T07:00:00Z', '<!-- dsh-anyplugin-agent --> finding body'), comment('szchan', '2026-11-23T08:00:00Z', 'fix it')],
    options,
  )
  assert.equal(verdict.section, 'Maintainer answers (resume)')
  assert.equal(verdict.lastSpeaker, 'maintainer')
})

test('a finding the agent answered after the maintainer closes like any other thread', () => {
  const verdict = classifyIssue(
    issue({ author: { login: 'szchan-bot' }, title: 'arch: two writers share docs/TRIAGE.md' }),
    [
      comment('szchan', '2026-11-23T08:00:00Z', 'fix it'),
      comment('szchan-bot', '2026-11-23T08:30:00Z', '<!-- dsh-anyplugin-agent --> fixed in ticket/234'),
    ],
    options,
  )
  assert.equal(verdict.section, null)
})

test('a maintainer issue titled arch: is still a new ask, and a plain bot issue keeps today\'s behaviour', () => {
  // The class is author *and* title: identity is the account (TRIAGE §1), and
  // "everything the bot wrote" is deliberately not a finding.
  assert.equal(isAgentFinding(issue({ title: 'arch: my own note' }), options), false)
  assert.equal(classifyIssue(issue({ title: 'arch: my own note' }), [], options).section, 'Maintainer asks (new)')
  const plain = issue({ author: { login: 'szchan-bot' }, title: 'workflow: follow-up ticket' })
  assert.equal(isAgentFinding(plain, options), false)
  const verdict = classifyIssue(plain, [comment('szchan-bot', '2026-11-23T07:00:00Z', '<!-- dsh-anyplugin-agent --> follow-up ticket body')], options)
  assert.equal(verdict.section, null)
})

test('the queue reports a finding as agent work, not a maintainer ask', () => {
  assert.equal(roleOfIssue(issue({ author: { login: 'szchan-bot' }, title: 'arch: x' }), options), 'agent')
  assert.equal(roleOfIssue(issue({ author: { login: 'szchan-bot' }, title: 'workflow: y' }), options), 'maintainer')
  assert.equal(roleOfIssue(issue(), options), 'maintainer')
})

test('a ticket in progress with no PR is in flight, even when labelled from-maintainer', () => {
  const verdict = classifyIssue(issue({ labels: labels('from-maintainer', 'ticket/in-progress') }), [], options)
  assert.equal(verdict.section, 'In progress (no PR yet)')
})

test('an issue whose PR is open is in review, not an ask', () => {
  const verdict = classifyIssue(issue(), [], { ...options, linkedPr: true })
  assert.equal(verdict.section, 'In review (PR open)')
})

test('an external report with no agent reply is untriaged; one awaiting evidence is queued', () => {
  const report = issue({ author: { login: 'someone' } })
  assert.equal(classifyIssue(report, [], options).section, 'External, untriaged')
  const answered = classifyIssue(
    issue({ author: { login: 'someone' }, labels: labels('needs-evidence') }),
    [comment('szchan-bot', '2026-11-21T08:00:00Z', '<!-- dsh-anyplugin-agent --> please add a repro')],
    options,
  )
  assert.equal(answered.section, 'External, awaiting evidence')
})

test('a reply after the agent sends an external report back to triage', () => {
  const verdict = classifyIssue(
    issue({ author: { login: 'someone' }, labels: labels('needs-evidence') }),
    [comment('szchan-bot', '2026-11-21T08:00:00Z', '<!-- dsh-anyplugin-agent --> evidence?'), comment('someone', '2026-11-21T09:00:00Z', 'here it is')],
    options,
  )
  assert.equal(verdict.section, 'External, untriaged')
})

test('the bot is ours: its PR is not an external contribution, and labels still win', () => {
  assert.equal(isOurs('szchan-bot', options), true)
  assert.equal(roleOfPullRequest({ author: { login: 'szchan-bot' } }, options), 'maintainer')
  assert.equal(roleOfPullRequest({ author: { login: 'someone' } }, options), 'external')
  assert.equal(roleOf(issue({ author: { login: 'szchan-bot' } }), options), 'maintainer')
  assert.equal(roleOf(issue({ author: { login: 'szchan-bot' }, labels: labels('external') }), options), 'external')
})

test('the receipt matcher does not swallow a real agent answer', () => {
  // Match the fixed opening, not "Seen." generally — otherwise an answer that
  // begins with the word is discarded and the thread looks unanswered (D79).
  assert.equal(isReceipt({ body: 'Seen. Fixed in 123abc, tests added.' }), false)
  assert.equal(isReceipt({ body: ' Seen. The master acts on this at its next turn boundary; this note exists so the reply is not a silent queue.' }), true)
  assert.equal(isReceipt({ body: 'seen. the master acts on this at its next turn boundary' }), true)
})

test('a receipt after a maintainer answer does not close the row', () => {
  // This is the shape that distinguishes the fix: if a receipt counted as the
  // agent's reply, agentAfterMaintainer would be true and the row would read
  // "blocked" even though the maintainer answered after the agent's question
  // (reviewer #228: the earlier case could not tell the two apart).
  const verdict = classifyIssue(
    issue({ author: { login: 'szchan-bot' }, labels: labels('maintainer-question') }),
    [
      comment('szchan', '2026-11-22T08:00:00Z', 'may I change the gate?'),
      comment('szchan-bot', '2026-11-22T08:10:00Z', '<!-- dsh-anyplugin-agent --> which file?'),
      comment('szchan', '2026-11-22T08:20:00Z', 'src/x.ts, please'),
      comment('szchan-bot', '2026-11-22T08:30:00Z', '<!-- dsh-anyplugin-agent --> Seen. The master acts on this at its next turn boundary.'),
    ],
    options,
  )
  assert.equal(verdict.section, 'Maintainer answers (resume)')
})

test('a maintainer reply followed by a bystander does not resume, and the speaker is external', () => {
  const verdict = classifyIssue(
    issue({ author: { login: 'szchan-bot' }, labels: labels('maintainer-question') }),
    [
      comment('szchan-bot', '2026-11-22T08:00:00Z', '<!-- dsh-anyplugin-agent --> which file?'),
      comment('szchan', '2026-11-22T08:10:00Z', 'src/x.ts, please'),
      comment('szchan-bot', '2026-11-22T08:20:00Z', '<!-- dsh-anyplugin-agent --> one more question'),
      comment('someone', '2026-11-22T08:30:00Z', '+1'),
    ],
    options,
  )
  // The code fix is agentAfterMaintainer; reverting it would report "resume"
  // here even though the last human word is a bystander (reviewer #228).
  assert.equal(verdict.section, 'Blocked on a human')
  assert.equal(verdict.lastSpeaker, 'external')
})

test('a bystander does not unblock an escalation only a maintainer can answer', () => {
  const verdict = classifyIssue(
    issue({ author: { login: 'szchan-bot' }, labels: labels('maintainer-question') }),
    [
      comment('szchan-bot', '2026-11-22T08:00:00Z', '<!-- dsh-anyplugin-agent --> may I change the gate?'),
      comment('someone', '2026-11-22T08:20:00Z', '+1, same problem here'),
    ],
    options,
  )
  assert.equal(verdict.section, 'Blocked on a human')
})

test('the inbox exit contract counts asks, answers and unreadable threads', () => {
  const sections = (...names) => Object.fromEntries(names.map((name) => [name, [{ number: 1, title: 'x' }]]))
  assert.equal(inboxVerdict({}).exitCode, 0)
  assert.equal(inboxVerdict(sections('Maintainer asks (new)')).exitCode, 1)
  assert.equal(inboxVerdict(sections('Maintainer answers (resume)')).exitCode, 1)
  assert.equal(inboxVerdict(sections('Blocked on a human')).exitCode, 0)
  // A finding needs review/merge, not an answer: it is reported but does not
  // raise the round-start exit code (D83).
  const findings = inboxVerdict(sections('Agent findings (review)'))
  assert.equal(findings.exitCode, 0)
  assert.equal(findings.findings.length, 1)
  assert.equal(inboxVerdict(sections('Agent findings (review)'), [{ number: 2, message: 'EOF' }]).exitCode, 2)
  assert.equal(inboxVerdict(sections('Maintainer answers (resume)'), [{ number: 2, message: 'EOF' }]).exitCode, 2)
  assert.equal(inboxVerdict({}).summary, 'inbox: 0 thread(s) waiting, 0 escalation(s) open, 0 agent finding(s) to review, 0 thread(s) unreadable')
})
