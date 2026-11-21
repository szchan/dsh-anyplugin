// Output-style activation (ticket #77) has two halves, and this file asserts
// both: the profile record is parsed and resolved as a *selection* (never a
// silent no-op, never a fallback after an explicit refusal), and the selected
// body actually becomes prompt bytes at agent start through the S11 seam.
//
// The end-to-end cases boot the pinned harness and read the composed system
// prompt of a real turn (the model is a stub adapter). That is the only honest
// observation for prompt text: no inventory API exposes an output style, and
// `claude plugin details` does not list one at 2.1.322 (D37).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { defaultMaterializers } from '../../dsh-anyplugin-emit/src/index.ts'
import {
  OUTPUT_STYLES_SCHEMA,
  compileReport,
  parseOutputStyles,
  readActivation,
  resolveActivation,
} from '../../dsh-anyplugin-install/src/index.ts'
import { InstallsFileError } from '../../dsh-anyplugin-install/src/installs.ts'
import { harnessSkipReason, resolveHarness } from '../src/harness.ts'
import { probePromptWithDsh } from '../src/oracles/prompt.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE = join(REPO_ROOT, 'fixtures', 'claude-output-styles-activation')
const PIN = `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`
const PLUGIN = 'output-styles-activation'
const BODIES = {
  append: '\nAppend style body: answer in terse bullets and name the file you read.\n',
  replace: '\nReplace style body: reply only with a haiku about the prompt.\n',
  forced: '\nForced style body: every answer starts with FORCED-STYLE.\n',
  inactive: '\nInactive style body: this text must never reach a prompt.\n',
}

const harness = resolveHarness()

function record() {
  return {
    dialect: 'claude-code',
    name: PLUGIN,
    version: '0.0.1',
    root: FIXTURE,
    dataDir: FIXTURE,
    pin: PIN,
  }
}

function lock() {
  return { schema: 'dsh-anyplugin/installs@1', plugins: [record()] }
}

function enablements(enabled = true) {
  return {
    user: {
      plugins: {
        [`claude-code:${PLUGIN}`]: { enabled, grants: [] },
      },
    },
  }
}

function compile(activation, options = {}) {
  return compileReport(lock(), {
    materializers: defaultMaterializers(),
    enablements: enablements(),
    activation,
    ...options,
  })
}

/** The emitted child is id-qualified by the install layer (`…#outputStyle`). */
function styleChild(report) {
  const children = report.entries[0]?.config ?? []
  return children.find((child) => child.id.endsWith('#outputStyle'))
}

test('the activation record parser accepts only the canonical shape', () => {
  assert.equal(OUTPUT_STYLES_SCHEMA, 'dsh-anyplugin/output-styles@1')

  const parsed = parseOutputStyles(
    'schema: "dsh-anyplugin/output-styles@1"\noutputStyles:\n  active: "output-styles-activation:append-style"\n',
    '<test>',
  )
  assert.deepEqual(parsed, {
    file: '<test>',
    active: { plugin: PLUGIN, style: 'append-style' },
  })

  // An empty record and the `{}` form both mean "no explicit activation".
  assert.deepEqual(parseOutputStyles('schema: "dsh-anyplugin/output-styles@1"\noutputStyles: {}\n', '<test>'), {
    file: '<test>',
  })

  const home = mkdtempSync(join(tmpdir(), 'anyplugin-activation-'))
  try {
    assert.deepEqual(readActivation({ home }), { file: join(home, 'anyplugin', 'output-styles.yml') })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  const refused = [
    ['unknown field', 'schema: "dsh-anyplugin/output-styles@1"\noutputStyles:\n  active: "a:b"\n  mode: "x"\n'],
    ['two active rows', 'schema: "dsh-anyplugin/output-styles@1"\noutputStyles:\n  active: "a:b"\n  active: "a:c"\n'],
    ['missing colon', 'schema: "dsh-anyplugin/output-styles@1"\noutputStyles:\n  active: "append-style"\n'],
    ['padded style', 'schema: "dsh-anyplugin/output-styles@1"\noutputStyles:\n  active: "a: b"\n'],
    ['empty style', 'schema: "dsh-anyplugin/output-styles@1"\noutputStyles:\n  active: "a:"\n'],
    ['wrong schema', 'schema: "dsh-anyplugin/output-styles@2"\noutputStyles:\n  active: "a:b"\n'],
    ['no block', 'schema: "dsh-anyplugin/output-styles@1"\n'],
    ['empty file', ''],
  ]
  for (const [label, text] of refused) {
    assert.throws(
      () => parseOutputStyles(text, '<test>'),
      (error) => error instanceof InstallsFileError && error.reason.length > 0,
      label,
    )
  }
})

test('the resolver never turns an explicit refusal into a force activation', () => {
  /** @type {import('../../dsh-anyplugin-install/src/output-styles.ts').ActivationPlugin[]} */
  const plugins = [
    {
      name: PLUGIN,
      enabled: true,
      styles: [
        { name: 'append-style', body: BODIES.append, keepCodingInstructions: true },
        { name: 'forced-style', body: BODIES.forced, forceForPlugin: true },
      ],
    },
  ]

  const explicit = resolveActivation(plugins, {
    file: '<test>',
    active: { plugin: PLUGIN, style: 'append-style' },
  })
  assert.equal(explicit.kind, 'active')
  assert.equal(explicit.source, 'explicit')
  assert.equal(explicit.style.name, 'append-style')
  assert.match(explicit.trace, /explicit record wins/)

  const refused = resolveActivation(plugins, {
    file: '<test>',
    active: { plugin: PLUGIN, style: 'no-such-style' },
  })
  assert.equal(refused.kind, 'refused')
  assert.equal(refused.code, 'unknown-style')
  assert.match(refused.reason, /append-style/)
  assert.doesNotMatch(refused.trace, /force-for-plugin ".*" applies/)

  const forced = resolveActivation(plugins, { file: '<test>' })
  assert.equal(forced.kind, 'active')
  assert.equal(forced.source, 'force')
  assert.equal(forced.style.name, 'forced-style')
  assert.match(forced.trace, /force-for-plugin "output-styles-activation:forced-style" applies/)

  assert.equal(resolveActivation([{ name: PLUGIN, enabled: false }], { file: '<test>' }).kind, 'none')
  assert.deepEqual(
    resolveActivation([], { file: '<test>', active: { plugin: 'missing', style: 'x' } }),
    {
      kind: 'refused',
      code: 'unknown-plugin',
      requested: 'missing:x',
      reason: 'no installed plugin is named "missing"',
      trace:
        'explicit activation "missing:x" from <test> was refused (unknown-plugin): no installed plugin is named "missing"; force-for-plugin is not consulted after an explicit refusal',
    },
  )
})

test('a refused activation produces a typed refusal and no style child', () => {
  const report = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'nope' } })
  assert.deepEqual(report.problems, [])
  assert.equal(report.activation.kind, 'refused')
  assert.equal(report.activation.code, 'unknown-style')
  assert.equal(styleChild(report), undefined)

  const disabled = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'append-style' } }, {
    enablements: enablements(false),
  })
  assert.equal(disabled.entries.length, 0)
  assert.equal(disabled.activation.kind, 'refused')
  assert.equal(disabled.activation.code, 'plugin-disabled')
})

test('the compiler emits the selected style with its composition flag', () => {
  const append = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'append-style' } })
  assert.equal(append.activation.kind, 'active')
  assert.equal(append.activation.source, 'explicit')
  const appendChild = styleChild(append)
  assert.ok(appendChild, 'append-style child is emitted')
  assert.equal(appendChild.config.body, BODIES.append)
  assert.equal(appendChild.config.complete, false)
  assert.equal(appendChild.config.keepCodingInstructions, true)
  assert.equal(appendChild.config.source, 'explicit')
  assert.match(appendChild.config.trace, /explicit record wins/)

  const replace = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'replace-style' } })
  assert.equal(styleChild(replace).config.complete, true)
  assert.equal(styleChild(replace).config.keepCodingInstructions, false)

  const forced = compile({ file: '<test>' })
  assert.equal(forced.activation.kind, 'active')
  assert.equal(forced.activation.source, 'force')
  assert.equal(styleChild(forced).config.source, 'force')
  assert.equal(styleChild(forced).config.complete, true)
})

test(
  'keep-coding-instructions true appends the body after the host prompt',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const compiled = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'append-style' } })
    const child = styleChild(compiled)
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: compiled.entries[0],
      baseline: true,
    })

    assert.equal(typeof probe.baseline, 'string')
    assert.equal(probe.prompt, `${probe.baseline}\n\n${child.config.body}`)
    assert.ok(probe.prompt.includes(BODIES.append))
    assert.ok(!probe.prompt.includes(BODIES.forced))
    assert.ok(!probe.prompt.includes(BODIES.inactive))
  },
)

test(
  'keep-coding-instructions false replaces the whole prompt with the body',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const compiled = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'replace-style' } })
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: compiled.entries[0],
      baseline: true,
    })

    assert.equal(probe.prompt, BODIES.replace)
    assert.equal(typeof probe.baseline, 'string')
    assert.notEqual(probe.prompt, probe.baseline)
  },
)

test(
  'force-for-plugin applies without an explicit record, and only that body',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const compiled = compile({ file: '<test>' })
    assert.equal(compiled.activation.source, 'force')
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: compiled.entries[0],
      baseline: true,
    })

    assert.equal(probe.prompt, BODIES.forced)
    assert.ok(!probe.prompt.includes(BODIES.append))
    assert.ok(!probe.prompt.includes(BODIES.inactive))
  },
)

test(
  'a refused activation leaves the composed prompt unchanged',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const compiled = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'nope' } })
    assert.equal(compiled.activation.kind, 'refused')
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: compiled.entries[0],
      baseline: true,
    })

    assert.equal(probe.prompt, probe.baseline)
    assert.ok(!probe.prompt.includes(BODIES.append))
    assert.ok(!probe.prompt.includes(BODIES.inactive))
    assert.ok(!probe.prompt.includes('Inactive style body'))
    assert.equal(styleChild(compiled), undefined)
    // The refusal is typed, and the body really is in the fixture (so the
    // negative control is not passing because the file is empty).
    assert.equal(readFileSync(join(FIXTURE, 'output-styles', 'inactive.md'), 'utf8').includes('Inactive style body'), true)
  },
)
