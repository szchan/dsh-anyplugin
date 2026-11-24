// S16: every `agents/*.md` frontmatter face is either observed at the child or
// declared unsupported/planned with a reason. This file is the child-side
// anchor for the one implemented face: `skills` preloads the full skill body
// into the subagent's first user message, which is where Claude starts it.
//
// The observation is made through the materializer's public tool, the pinned
// harness's own agent loop and fork provider, and a stub adapter that records
// the request the child actually sent. Nothing here reads our emitted config to
// decide whether the effect happened; the config is only used to carry the
// agent into the harness.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { emitPlugin } from '../../dsh-anyplugin-emit/src/index.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'
import { loadFromHarness, probeAgentInvocationWithDsh } from '../src/oracles/dsh.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harness = resolveHarness()
const materializerUrl = (pkg) => pathToFileURL(join(repoRoot, 'packages', pkg, 'src', 'index.ts')).href
const materializers = {
  skill: materializerUrl('dsh-anyplugin-materialize-skill'),
  agents: materializerUrl('dsh-anyplugin-materialize-agents'),
}

const PLUGIN = 's16-faces-plugin'
const TASK = 'Do the S16 task.'
const SKILL_NAME = 's16-preload'
const SKILL_MARKER = 'S16-PRELOAD-BODY-9f2c'
const BODY = 'You are the S16 helper.'
// The materializer's provider label in the host envelope; the test renders the
// expected bytes with the pinned host function using this same label.
const SKILL_PROVIDER = 'anyplugin'

const FACES = {
  catalog: 'exact',
  invocation: 'equivalent',
  model: 'derived',
  effort: 'derived',
  tools: 'unsupported',
  maxTurns: 'unsupported',
  isolation: 'planned',
  skills: 'equivalent',
  memory: 'unsupported',
  background: 'unsupported',
  omitClaudeMd: 'unsupported',
  color: 'unsupported',
  autoCompactWindow: 'unsupported',
}

function makePlugin({ agentSkills = [SKILL_NAME], shipSkill = true } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'anyplugin-agent-faces-')), PLUGIN)
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'skills', SKILL_NAME), { recursive: true })
  if (shipSkill) {
    writeFileSync(
      join(root, 'skills', SKILL_NAME, 'SKILL.md'),
      `---\nname: ${SKILL_NAME}\ndescription: A skill the agent preloads.\n---\n${SKILL_MARKER}\n`,
    )
  }
  const skills = agentSkills.length === 0 ? '' : `skills: [${agentSkills.join(', ')}]\n`
  writeFileSync(
    join(root, 'agents', 'helper.md'),
    `---\nname: helper\ndescription: Helper that preloads a skill.\n${skills}` +
      'tools: Read, Grep\nmodel: sonnet\neffort: high\nmaxTurns: 2\nisolation: worktree\n' +
      'memory: user\nbackground: true\nomitClaudeMd: true\ncolor: red\nautoCompactWindow: 200000\n' +
      `---\n${BODY}\n`,
  )
  return root
}

const EMPTY_PLUGIN = 's16-empty-skill-plugin'
const EMPTY_SKILL = 'emptybody'

/** An agent whose only `skills:` entry ships a frontmatter-only SKILL.md. */
function makeEmptyBodyPlugin() {
  const root = join(mkdtempSync(join(tmpdir(), 'anyplugin-agent-faces-')), EMPTY_PLUGIN)
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'skills', EMPTY_SKILL), { recursive: true })
  writeFileSync(
    join(root, 'skills', EMPTY_SKILL, 'SKILL.md'),
    `---\nname: ${EMPTY_SKILL}\ndescription: A skill with no body.\n---\n`,
  )
  writeFileSync(
    join(root, 'agents', 'empty.md'),
    `---\nname: empty\ndescription: Helper whose preload has no body.\nskills: [${EMPTY_SKILL}]\n---\nYou are the empty-skill helper.\n`,
  )
  return root
}

const ZERO_PLUGIN = 's16-zero-skill-plugin'

/** An agent whose only `skills:` entry ships a zero-byte SKILL.md. */
function makeZeroBytePlugin() {
  const root = join(mkdtempSync(join(tmpdir(), 'anyplugin-agent-faces-')), ZERO_PLUGIN)
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'skills', 'blank'), { recursive: true })
  writeFileSync(join(root, 'skills', 'blank', 'SKILL.md'), '')
  writeFileSync(
    join(root, 'agents', 'zerobody.md'),
    '---\nname: zerobody\ndescription: Helper whose skill file is zero bytes.\nskills: [blank]\n---\nYou are the zero-byte helper.\n',
  )
  return root
}

const LOOP_PLUGIN = 's16-max-turns-plugin'

/** An agent with `maxTurns: 1`, used to observe whether the host caps turns. */
function makeLoopPlugin() {
  const root = join(mkdtempSync(join(tmpdir(), 'anyplugin-agent-faces-')), LOOP_PLUGIN)
  mkdirSync(join(root, 'agents'), { recursive: true })
  writeFileSync(
    join(root, 'agents', 'capped.md'),
    '---\nname: capped\ndescription: Helper with a declared turn cap.\nmaxTurns: 1\n---\nYou are the capped helper.\n',
  )
  return root
}

const declared = (agent) =>
  Object.fromEntries(Object.entries(agent.faces ?? {}).filter(([, face]) => face !== undefined).map(([name, face]) => [name, face.fidelity]))

test(
  'an agent skills preload reaches the child first request, after its body and before the task',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const root = makePlugin()
    const ir = readClaudePlugin(root, { source: 'plugin-dir:s16-faces' })
    const agent = ir.agents.find((item) => item.name === 'helper')
    assert.ok(agent, 'helper is in the IR')
    assert.deepEqual(declared(agent), FACES)
    for (const [face, annotation] of Object.entries(agent.faces)) {
      assert.ok(annotation.reason.trim().length > 0, `${face} carries a reason`)
    }
    // D91: a mapped alias is this layer's policy, never a Claude semantic. The
    // reason has to name both the alias it read and the route it chose, or a
    // reviewer cannot tell what was mapped.
    for (const face of ['model', 'effort']) {
      assert.match(agent.faces[face].reason, /policy \(D91\)/, `${face} names D91`)
      assert.match(agent.faces[face].reason, /not a Claude semantic/, `${face} denies Claude semantics`)
    }
    assert.match(agent.faces.model.reason, /`model: sonnet`/, 'the model face names the alias it mapped')
    assert.match(agent.faces.model.reason, /deepseek-flash/, 'the model face names the route it chose')
    assert.match(agent.faces.effort.reason, /`effort: high`/, 'the effort face names the declared effort')
    assert.deepEqual(agent.skillContents, [{ name: SKILL_NAME, content: `${SKILL_MARKER}\n` }])

    const { entry } = emitPlugin(ir, { materializers })
    assert.ok(entry, 'the agents child produced an entry')
    const probe = await probeAgentInvocationWithDsh({
      harnessDir: harness.harnessDir,
      entry,
      toolName: `${PLUGIN}:helper`,
      task: TASK,
    })

    const user = probe.child.messages.find((message) => message.role === 'user')
    assert.ok(user, 'the child sent a user request')
    const positions = [BODY, SKILL_MARKER, TASK].map((text) => user.text.indexOf(text))
    assert.deepEqual(
      positions.every((at) => at >= 0),
      true,
      `the child request carries body, skill and task: ${JSON.stringify(positions)}`,
    )
    assert.ok(positions[0] < positions[1], 'the persona body precedes the skill preload')
    assert.ok(positions[1] < positions[2], 'the skill preload precedes the task')
    // Byte-for-byte the host's own envelope: the expected string is rendered
    // by the pinned `renderSkillContent`, so a prefix insertion in the
    // materializer, or a host shape change, reddens this assertion.
    const { renderSkillContent } = await loadFromHarness(harness.harnessDir, 'dsh-skill/lib/index.js')
    const expectedEnvelope = renderSkillContent({
      name: SKILL_NAME,
      provider: SKILL_PROVIDER,
      resourceBase: undefined,
      content: `${SKILL_MARKER}\n`,
    })
    assert.ok(
      user.text.includes(expectedEnvelope),
      'the preload is byte-identical to the host renderSkillContent envelope',
    )
    // `includes` alone would accept a prefix before the envelope; the child
    // must see the persona and then the envelope, with nothing wedged in.
    const envelopeStart = user.text.indexOf(expectedEnvelope)
    assert.equal(user.text.slice(0, envelopeStart).trimEnd(), BODY, 'nothing but the persona precedes the envelope')
    assert.equal(user.text.split(expectedEnvelope).length - 1, 1, 'the envelope appears exactly once')
    // The whole message, not just the pieces: a suffix inserted between the
    // envelope and the task, or a duplicated block, reddens this line. The
    // host's own closing note (dsh-subagent/lib/index.js:422 @ 0.2.2-rc.5) is
    // not ours, so it is pinned verbatim rather than ignored.
    const HOST_NOTE =
      'Your final answer is delivered automatically if your parent is still online. ' +
      'Include the result and relevant evidence in that answer; the parent does not receive your full transcript, tool output, or reasoning. ' +
      'If your last action is a message to your parent, the completion notice omits your final answer; include the result and relevant evidence in that message.'
    assert.equal(
      user.text,
      [BODY + '\n', expectedEnvelope, TASK, HOST_NOTE].join('\n'),
      'the child user message is exactly the persona, the envelope, the task, and the host note',
    )
    // One child request: the agent answered, it did not loop. The maxTurns face
    // would be observable here if the host capped a child, and S16 proves it does not.
    assert.equal(probe.childRequests, 1)
    assert.equal(probe.stopReason, 'completed')
  },
)

test('a skill the plugin does not ship stays planned, with a named seam and no body', () => {
  const root = makePlugin({ agentSkills: ['absent-skill'], shipSkill: false })
  const ir = readClaudePlugin(root, { source: 'plugin-dir:s16-faces' })
  const agent = ir.agents.find((item) => item.name === 'helper')
  assert.ok(agent, 'helper is in the IR')
  assert.equal(agent.faces.skills.fidelity, 'planned')
  assert.match(agent.faces.skills.reason, /absent-skill/)
  assert.equal(agent.skillContents, undefined)
})

test('a zero-byte SKILL.md is reported as empty, not as missing', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'anyplugin-agent-faces-')), 's16-empty-skill-file')
  mkdirSync(join(root, 'skills', 'blank'), { recursive: true })
  writeFileSync(join(root, 'skills', 'blank', 'SKILL.md'), '')
  const ir = readClaudePlugin(root, { source: 'plugin-dir:s16-empty-file' })
  const row = ir.pending.find((item) => item.surface === 'skills' && item.name === 'blank')
  assert.ok(row, 'the empty skill slot is reported')
  assert.match(row.annotation.reason, /SKILL\.md is empty/)
  assert.doesNotMatch(row.annotation.reason, /no SKILL\.md/)
})

test(
  'a zero-byte SKILL.md attached to an agent is planned as empty, not as missing',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const root = makeZeroBytePlugin()
    const ir = readClaudePlugin(root, { source: 'plugin-dir:s16-zero-byte' })
    const agent = ir.agents.find((item) => item.name === 'zerobody')
    assert.ok(agent, 'zerobody is in the IR')
    assert.equal(agent.faces.skills.fidelity, 'planned', 'an empty file is not a preload')
    assert.match(agent.faces.skills.reason, /no body/, 'the reason says the skill has no body')
    assert.doesNotMatch(agent.faces.skills.reason, /not shipped/, 'the file is shipped, so it is not missing')
    assert.equal(agent.skillContents, undefined, 'a zero-byte body is not a preload')

    const { entry } = emitPlugin(ir, { materializers })
    const probe = await probeAgentInvocationWithDsh({
      harnessDir: harness.harnessDir,
      entry,
      toolName: `${ZERO_PLUGIN}:zerobody`,
      task: TASK,
    })
    const user = probe.child.messages.find((message) => message.role === 'user')
    assert.ok(user, 'the child sent a user request')
    assert.equal(user.text.includes('<skill_content'), false, 'the child request carries no skill claim it cannot keep')
  },
)

test('every frontmatter face is carried to the materializer as data, not silently dropped', () => {
  const root = makePlugin()
  const ir = readClaudePlugin(root, { source: 'plugin-dir:s16-faces' })
  const { entry } = emitPlugin(ir, { materializers })
  const child = entry.config.find((item) => item.id === 'agents')
  const emitted = child.config.agents[0]
  assert.equal(emitted.model, 'sonnet')
  assert.deepEqual(emitted.tools, ['Read', 'Grep'])
  assert.equal(emitted.effort, 'high')
  assert.equal(emitted.maxTurns, 2)
  assert.equal(emitted.isolation, 'worktree')
  assert.deepEqual(emitted.skills, [SKILL_NAME])
  assert.equal(emitted.memory, 'user')
  assert.equal(emitted.background, true)
  assert.equal(emitted.omitClaudeMd, true)
  assert.equal(emitted.color, 'red')
  assert.equal(emitted.autoCompactWindow, 200000)
})

test(
  'a skill with an empty body is planned, and no empty skill block reaches the child',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const root = makeEmptyBodyPlugin()
    const ir = readClaudePlugin(root, { source: 'plugin-dir:s16-empty' })
    const agent = ir.agents.find((item) => item.name === 'empty')
    assert.ok(agent, 'empty is in the IR')
    assert.equal(agent.faces.skills.fidelity, 'planned')
    assert.match(agent.faces.skills.reason, /no body/)
    assert.equal(agent.skillContents, undefined, 'an empty body is not a preload')

    const { entry } = emitPlugin(ir, { materializers })
    const probe = await probeAgentInvocationWithDsh({
      harnessDir: harness.harnessDir,
      entry,
      toolName: `${EMPTY_PLUGIN}:empty`,
      task: TASK,
    })
    const user = probe.child.messages.find((message) => message.role === 'user')
    assert.ok(user, 'the child sent a user request')
    assert.equal(user.text.includes('<skill_content'), false, 'the child request carries no skill claim it cannot keep')
  },
)

test(
  'maxTurns is not a host turn cap: a child declaring maxTurns: 1 still issues three requests',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const root = makeLoopPlugin()
    const ir = readClaudePlugin(root, { source: 'plugin-dir:s16-loop' })
    const agent = ir.agents.find((item) => item.name === 'capped')
    assert.ok(agent, 'capped is in the IR')
    assert.equal(agent.faces.maxTurns.fidelity, 'unsupported')
    assert.match(agent.faces.maxTurns.reason, /three model requests/)

    const { entry } = emitPlugin(ir, { materializers })
    const probe = await probeAgentInvocationWithDsh({
      harnessDir: harness.harnessDir,
      entry,
      toolName: `${LOOP_PLUGIN}:capped`,
      task: TASK,
      toolLoop: 2,
    })
    assert.equal(probe.childRequests, 3, 'two tool-call requests plus the answer')
    assert.equal(probe.stopReason, 'completed', 'the child ended normally, not partial at a cap')
  },
)
