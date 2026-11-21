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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { defaultMaterializers } from '../../dsh-anyplugin-emit/src/index.ts'
import {
  OUTPUT_STYLES_SCHEMA,
  OutputStyleActivationError,
  compileEntries,
  compileReport,
  outputStylesPath,
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
  default: '\nDefault style body: keep the host prompt and append this.\n',
  emptyForced: '   \n',
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
    ['empty-block contradiction', 'schema: "dsh-anyplugin/output-styles@1"\noutputStyles: {}\n  active: "a:b"\n'],
  ]
  for (const [label, text] of refused) {
    assert.throws(
      () => parseOutputStyles(text, '<test>'),
      (error) => error instanceof InstallsFileError && error.reason.length > 0,
      label,
    )
  }
})

test('a record that exists but cannot be read is a typed load error', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyplugin-activation-unreadable-'))
  const dir = join(home, 'anyplugin')
  mkdirSync(dir, { recursive: true })
  const file = outputStylesPath(home)
  try {
    // A readable record at the real profile path is how production finds it.
    writeFileSync(file, `schema: "${OUTPUT_STYLES_SCHEMA}"\noutputStyles:\n  active: "${PLUGIN}:append-style"\n`)
    assert.deepEqual(readActivation({ home }), {
      file,
      active: { plugin: PLUGIN, style: 'append-style' },
    })

    chmodSync(file, 0o000)
    assert.throws(
      () => readActivation({ home }),
      (error) => error instanceof InstallsFileError && error.file === file && /EACCES/.test(error.message),
      'mode 000 must be EACCES, not "no style"',
    )
    chmodSync(file, 0o600)
    rmSync(file)

    mkdirSync(file)
    assert.throws(
      () => readActivation({ home }),
      (error) => error instanceof InstallsFileError && error.file === file && /EISDIR/.test(error.message),
      'a directory at the record path must be EISDIR, not "no style"',
    )
  } finally {
    try {
      chmodSync(file, 0o600)
    } catch {}
    rmSync(home, { recursive: true, force: true })
  }
})

test('an empty or whitespace-only body is refused, never applied as a no-op', () => {
  const styles = [
    { name: 'empty', body: '' },
    { name: 'blank', body: '  \n\t' },
    { name: 'forced-blank', body: ' \n', forceForPlugin: true },
    { name: 'forced-good', body: 'good body' , forceForPlugin: true },
  ]
  const plugins = [{ name: PLUGIN, enabled: true, styles }]

  for (const style of ['empty', 'blank']) {
    const refused = resolveActivation(plugins, { file: '<test>', active: { plugin: PLUGIN, style } })
    assert.equal(refused.kind, 'refused', style)
    assert.equal(refused.code, 'empty-style', style)
    assert.match(refused.reason, /empty or whitespace-only/, style)
  }

  // A broken forced declaration is skipped in favour of the next forced style.
  const forced = resolveActivation(plugins, { file: '<test>' })
  assert.equal(forced.kind, 'active')
  assert.equal(forced.source, 'force')
  assert.equal(forced.style.name, 'forced-good')

  const onlyEmpty = resolveActivation([{ name: PLUGIN, enabled: true, styles: [styles[2]] }], { file: '<test>' })
  assert.equal(onlyEmpty.kind, 'refused')
  assert.equal(onlyEmpty.code, 'empty-style')
  assert.match(onlyEmpty.trace, /force-for-plugin .* was refused \(empty-style\)/)
})

test('an unreadable enabled plugin is a plugin-unreadable refusal with the read failure', () => {
  const resolved = resolveActivation(
    [{ name: PLUGIN, enabled: true, problem: 'readClaudePlugin: ENOENT: no such file or directory, open ...' }],
    { file: '<test>', active: { plugin: PLUGIN, style: 'append-style' } },
  )
  assert.equal(resolved.kind, 'refused')
  assert.equal(resolved.code, 'plugin-unreadable')
  assert.match(resolved.reason, /could not be read/)
  assert.match(resolved.reason, /ENOENT/)
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

test('the compiler refuses an empty forced style and reads a failed root as plugin-unreadable', () => {
  const explicitEmpty = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'empty-forced' } })
  assert.equal(explicitEmpty.activation.kind, 'refused')
  assert.equal(explicitEmpty.activation.code, 'empty-style')
  assert.equal(styleChild(explicitEmpty), undefined)

  // The fixture's broken forced declaration does not stop the working one.
  const forced = compile({ file: '<test>' })
  assert.equal(forced.activation.kind, 'active')
  assert.equal(forced.activation.style.name, 'forced-style')

  const missingRoot = join(REPO_ROOT, 'fixtures', 'claude-output-styles-activation-missing')
  const options = {
    materializers: defaultMaterializers(),
    enablements: enablements(),
    activation: { file: '<test>', active: { plugin: PLUGIN, style: 'append-style' } },
  }
  const report = compileReport(
    { schema: 'dsh-anyplugin/installs@1', plugins: [{ ...record(), root: missingRoot }] },
    options,
  )
  assert.equal(report.activation.kind, 'refused')
  assert.equal(report.activation.code, 'plugin-unreadable')
  assert.match(report.activation.reason, /could not be read/)
  assert.match(report.activation.reason, /ENOENT/)
  assert.equal(report.problems.length, 1)
})

test('compileEntries refuses a refused activation instead of compiling silently', () => {
  assert.throws(
    () => compileEntries(lock(), {
      materializers: defaultMaterializers(),
      enablements: enablements(),
      activation: { file: '<test>', active: { plugin: PLUGIN, style: 'nope' } },
    }),
    (error) =>
      error instanceof OutputStyleActivationError &&
      error.code === 'unknown-style' &&
      error.requested === `${PLUGIN}:nope`,
  )
})

test(
  'absent keep-coding-instructions appends, preserving the host prompt',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const compiled = compile({ file: '<test>', active: { plugin: PLUGIN, style: 'default-style' } })
    const child = styleChild(compiled)
    assert.ok(child, 'default-style child is emitted')
    assert.equal(child.config.keepCodingInstructions, undefined)
    assert.equal(child.config.complete, false)
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: compiled.entries[0],
      baseline: true,
    })
    assert.equal(typeof probe.baseline, 'string')
    assert.equal(probe.prompt, `${probe.baseline}\n\n${child.config.body}`)
  },
)

const replaceEntry = () =>
  compile({ file: '<test>', active: { plugin: PLUGIN, style: 'replace-style' } }).entries[0]

test(
  'main gets the style',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: replaceEntry(),
      baseline: true,
    })
    assert.equal(probe.prompt, BODIES.replace)
  },
)

test(
  'a sibling top-level agent gets the style',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: replaceEntry(),
      baseline: true,
      roles: ['sibling'],
    })
    assert.equal(probe.rolePrompts.sibling, BODIES.replace)
  },
)

test(
  'a fork of the main conversation gets the style',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: replaceEntry(),
      baseline: true,
      roles: ['fork'],
    })
    assert.equal(probe.rolePrompts.fork, BODIES.replace)
  },
)

test(
  'a subagent does not get the style',
  { skip: harness ? false : harnessSkipReason() },
  async () => {
    const probe = await probePromptWithDsh({
      harnessDir: harness.harnessDir,
      entry: replaceEntry(),
      baseline: true,
      roles: ['subagent'],
    })
    assert.equal(typeof probe.baseline, 'string')
    // With `complete: true`, applying the style to a subagent would replace its
    // whole prompt with the style body.
    assert.equal(probe.rolePrompts.subagent, probe.baseline)
    assert.ok(!probe.rolePrompts.subagent.includes(BODIES.replace))
  },
)
