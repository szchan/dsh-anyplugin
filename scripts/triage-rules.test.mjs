import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIssue, isOurs, roleOf, roleOfPullRequest } from './triage-rules.mjs'

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

test('a maintainer issue with no agent comment is a new ask', () => {
  assert.equal(classifyIssue(issue(), [], options).section, 'Maintainer asks (new)')
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
