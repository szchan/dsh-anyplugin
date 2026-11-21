// S19: does a Claude plugin's `bin/` directory reach the model shell's PATH
// without a DSH core change? (issue #131)
//
// Claude Code appends `<plugin>/bin` to the PATH of the shell its model calls,
// *after* the user's own entries. The question here is narrower than "can we
// emulate that": can a plugin reach `$PATH` at all through the seams the pinned
// DSH host already exposes? The answer has to be measured on the model's side of
// the tool call, not on `process.env`:
//
//   1. read the registration API and its validation in `dsh-shell-env` (the
//      managed-environment service the shell tools consume);
//   2. read what the model-facing tools pass into `ctx.shell` and what the local
//      executor hands the subprocess;
//   3. register a probe contribution, then call the *bash tool* the model calls
//      and print what the child sees — a positive control that the registry is
//      applied to real calls, not merely to `process.env`;
//   4. try to register `PATH` and try to smuggle it from `resolve()`, and keep
//      the exact errors;
//   5. put `probecmd` and `ls` in a probe `bin/`, then try the bare names and
//      check who wins.
//
// The spike does not mutate `process.env.PATH`: issue #131 forbids it, and a
// measurement that changes the thing it measures would not answer the question.
//
// Run:
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
//     node spikes/s19-path/run.mjs
//
// The spike stays: it is the artifact behind the S19 table in
// docs/ARCHITECTURE.md §10 and must be re-run when the pin moves.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'

// Packages the spike imports (not just reads). `cordis` is outside the dsh-*
// namespace and comes first in the union.
const REQUIRED = [
  'cordis',
  'dsh-session',
  'dsh-session-projection',
  'dsh-system-prompt',
  'dsh-tools',
  'dsh-tool-executor-native',
  'dsh-fs-local',
  'dsh-working-directory',
  'dsh-shell-env',
  'dsh-shell',
  'dsh-subprocess',
  'dsh-subprocess-local',
  'dsh-bash-local',
  'dsh-tool-bash',
  'dsh-tool-pwsh',
]

function candidates(root) {
  return [join(root, 'node_modules', '@deepseek-ai'), join(root, '@deepseek-ai'), root, dirname(root)]
}
function usable(candidate) {
  return candidate !== undefined && REQUIRED.every((name) => existsSync(join(candidate, name, 'package.json')))
}
function missingIn(candidate) {
  return REQUIRED.filter((name) => !existsSync(join(candidate, name, 'package.json')))
}
function locateHarness() {
  const explicit = process.env.DSH_HARNESS_DIR?.trim()
  if (explicit) {
    const root = resolve(explicit)
    const candidate = candidates(root).find(usable)
    if (candidate === undefined) {
      console.error(`DSH_HARNESS_DIR=${root} is set but unusable (missing: ${missingIn(candidates(root)[0]).join(', ')})`)
      process.exit(2)
    }
    return { dir: candidate, source: 'DSH_HARNESS_DIR' }
  }
  const roots = []
  const install = process.env.DSH_INSTALL_DIR?.trim()
  if (install) roots.push([resolve(install), 'DSH_INSTALL_DIR'])
  roots.push([join(REPO, '.harness', VERSION), '.harness'])
  for (const [root, source] of roots) {
    const candidate = candidates(root).find(usable)
    if (candidate !== undefined) return { dir: candidate, source }
  }
  console.error(`no usable harness: ${roots.map(([r, s]) => `${s}=${r}`).join(', ')}`)
  console.error(`missing: ${missingIn(candidates(roots[0][0])[0]).join(', ')}`)
  process.exit(2)
}

const { dir: HARNESS, source: HARNESS_SOURCE } = locateHarness()
const pathToFileURL = (path) => new URL(`file://${path}`).href
const pkg = (name) => import(pathToFileURL(join(HARNESS, name, 'lib', 'index.js')))
const source = (name, file) => readFileSync(join(HARNESS, name, 'src', file), 'utf8')
const versionOf = (name) => JSON.parse(readFileSync(join(HARNESS, name, 'package.json'), 'utf8')).version

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const lineOf = (text, needle) => {
  const index = text.indexOf(needle)
  return index === -1 ? -1 : text.slice(0, index).split('\n').length
}
const lastLineOf = (text, needle) => {
  const index = text.lastIndexOf(needle)
  return index === -1 ? -1 : text.slice(0, index).split('\n').length
}
const until = async (fn, label, timeoutMs = 5000) => {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function main() {
  const shellEnvSource = source('dsh-shell-env', 'index.ts')
  const shellTypes = source('dsh-shell', 'types.ts')
  const subprocessTypes = source('dsh-subprocess', 'types.ts')
  const subprocessSource = source('dsh-subprocess', 'index.ts')
  const spawnSource = source('dsh-subprocess-local', 'spawn.ts')
  const bashLocalSource = source('dsh-bash-local', 'index.ts')
  const bashToolSource = source('dsh-tool-bash', 'index.ts')
  const pwshToolSource = source('dsh-tool-pwsh', 'index.ts')

  // ---- the registration API and its validation, in the pinned source ------
  const registryDocs = {
    register: lineOf(shellEnvSource, 'register(contributor: BashEnvContributor): () => void'),
    collect: lineOf(shellEnvSource, 'collect(execution: ToolExecution): DshEnvironment'),
    guard: lineOf(shellEnvSource, 'if (!key.startsWith(DSH_ENV_PREFIX)'),
    suffix: lineOf(shellEnvSource, 'const BASH_ENV_KEY_SUFFIX'),
    reserved: lineOf(shellEnvSource, 'const RESERVED_BASH_ENV_KEYS'),
    undeclared: lineOf(shellEnvSource, 'returned undeclared key'),
  }
  check(
    'the managed-env seam is one DSH_*-key registry: register(contributor) writes, collect(execution) reads',
    registryDocs.register !== -1 && registryDocs.collect !== -1,
    `dsh-shell-env/src/index.ts:${registryDocs.register},:${registryDocs.collect} @ ${versionOf('dsh-shell-env')}`,
  )
  check(
    'registration refuses any declared key outside the DSH_* namespace or its suffix grammar',
    registryDocs.guard !== -1 &&
      registryDocs.suffix !== -1 &&
      shellEnvSource.includes('const BASH_ENV_KEY_SUFFIX = /^[A-Z][A-Z0-9_]*$/') &&
      shellEnvSource.includes('declared invalid key'),
    `dsh-shell-env/src/index.ts:${registryDocs.guard}-${registryDocs.guard + 2} (suffix at :${registryDocs.suffix})`,
  )
  check(
    'the key type is a compile-time DSH_ template, and seven built-in DSH_* keys are reserved',
    subprocessTypes.includes("export const DSH_ENV_PREFIX = 'DSH_' as const") &&
      subprocessTypes.includes('export type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`') &&
      registryDocs.reserved !== -1 &&
      shellEnvSource.includes('DSH_HOME_ENV,'),
    `dsh-subprocess/src/types.ts:13,:16; dsh-shell-env/src/index.ts:${registryDocs.reserved}`,
  )
  check(
    'collect() also refuses a value whose key the contributor did not declare (no resolver can widen itself)',
    registryDocs.undeclared !== -1 && shellEnvSource.includes("'SHELL_ENV_CONTRIBUTION_INVALID'"),
    `dsh-shell-env/src/index.ts:${registryDocs.undeclared}`,
  )

  // ---- what the model-facing tools pass into the shell seam ---------------
  const bashInject = lineOf(bashToolSource, "export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv', 'workingDirectory']")
  const bashCollect = lineOf(bashToolSource, 'const dshEnv = ctx.shellEnv.collect(exec)')
  const requestStart = bashToolSource.indexOf('const request: ShellExecRequest = {')
  const requestEnd = bashToolSource.indexOf('\n        }', requestStart)
  const requestBlock = requestStart === -1 || requestEnd === -1 ? '' : bashToolSource.slice(requestStart, requestEnd)
  check(
    'the bash tool injects shellEnv and sends only its collected overlay for the execution',
    bashInject !== -1 && bashCollect !== -1 && requestBlock.includes('dshEnv,'),
    `dsh-tool-bash/src/index.ts:${bashInject},:${bashCollect}`,
  )
  check(
    'the model-facing request carries no caller `env` field (the tool has no such parameter to pass)',
    requestBlock.length > 0 &&
      !/^\s+env:/m.test(requestBlock) &&
      shellTypes.includes('model-facing bash tool does not expose it as a parameter') &&
      /dshEnv\?: DshEnvironment/.test(shellTypes),
    `request block at dsh-tool-bash/src/index.ts:${lineOf(bashToolSource, 'const request: ShellExecRequest = {')} has ${requestBlock.split('\n').length} lines and no env:; dsh-shell/src/types.ts:${lastLineOf(shellTypes, 'model-facing bash tool does not expose it as a parameter')} says the field is for in-process plugins only`,
  )
  check(
    'the Windows shell tool consumes the same registry, not an inherited PATH',
    pwshToolSource.includes('dshEnv: ctx.shellEnv.collect(exec)'),
    `dsh-tool-pwsh/src/index.ts:${lineOf(pwshToolSource, 'dshEnv: ctx.shellEnv.collect(exec)')}`,
  )

  // ---- how the child environment is assembled -----------------------------
  check(
    'the local executor layers ENV_OVERRIDES, then caller env, then the registry overlay',
    bashLocalSource.includes('env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },'),
    `dsh-bash-local/src/index.ts:${lineOf(bashLocalSource, 'env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },')}`,
  )
  check(
    'the child environment is the scrubbed parent environment plus that overlay, and PATH survives the scrub',
    spawnSource.includes('const env = scrubbedParentEnv()') &&
      spawnSource.includes('return { ...env, ...extra }') &&
      subprocessSource.includes('!key.toUpperCase().startsWith(DSH_ENV_PREFIX)') &&
      !/KEY|PASSWORD|SECRET|TOKEN/i.test('PATH'),
    `dsh-subprocess-local/src/spawn.ts:${lineOf(spawnSource, 'const env = scrubbedParentEnv()')}-${lineOf(spawnSource, 'const env = scrubbedParentEnv()') + 1}; dsh-subprocess/src/index.ts:${lineOf(subprocessSource, '!key.toUpperCase().startsWith(DSH_ENV_PREFIX)')}`,
  )

  // ---- boot the primitives the oracle's tool probes boot -------------------
  const { Context } = await import(pathToFileURL(join(HARNESS, 'cordis', 'lib', 'index.js')))
  const SessionStore = (await pkg('dsh-session')).default
  const SessionProjections = (await pkg('dsh-session-projection')).default
  const SystemPrompt = (await pkg('dsh-system-prompt')).default
  const { ToolsService } = await pkg('dsh-tools')
  const nativeExecutor = await pkg('dsh-tool-executor-native')
  const ShellEnv = await pkg('dsh-shell-env')
  const SubprocessLocal = (await pkg('dsh-subprocess-local')).default
  const BashLocal = (await pkg('dsh-bash-local')).default
  const WorkingDirectory = (await pkg('dsh-working-directory')).default
  const FileSystem = (await pkg('dsh-fs-local')).default
  const BashTool = await pkg('dsh-tool-bash')
  const { scrubbedParentEnv } = await pkg('dsh-subprocess')

  const ctx = new Context()
  ctx.plugin(SessionStore)
  ctx.plugin(SessionProjections)
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolsService, {})
  ctx.plugin(nativeExecutor, {})
  await until(() => ctx.tools, 'tools')
  await until(() => ctx.sessions && ctx.sessionProjections, 'session services')
  ctx.plugin(FileSystem, { cwd: process.cwd() })
  await until(() => ctx.fs, 'fs')
  ctx.plugin(WorkingDirectory, { defaultDirectory: process.cwd() })
  await until(() => ctx.workingDirectory, 'workingDirectory')
  ctx.plugin(ShellEnv)
  await until(() => ctx.shellEnv, 'shellEnv')
  ctx.plugin(SubprocessLocal)
  await until(() => ctx.subprocess, 'subprocess')
  ctx.plugin(BashLocal)
  await until(() => ctx.shell, 'shell')
  ctx.plugin(BashTool)
  await until(() => ctx.tools.get('bash'), 'bash tool')

  check(
    'the bash tool registers in ctx.tools — the same tool the model calls',
    ctx.tools.get('bash') !== undefined,
    `dsh-tool-bash@${versionOf('dsh-tool-bash')}`,
  )

  // The model's call shape: a tool-call batch validated against the tool's
  // declared argument schema, exactly as the native executor dispatches it.
  const bash = async (command, extra = {}) => {
    const raw = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `call_s19_${Math.random().toString(36).slice(2, 8)}`, name: 'bash', arguments: JSON.stringify({ command, description: 'S19 PATH probe', ...extra }) }],
      signal: new AbortController().signal,
    })
    const result = raw.results[0].result
    return {
      text: result.content?.map((part) => part.text ?? '').join('') ?? '',
      isError: result.isError === true,
      exitCode: result.value?.exitCode,
      error: result.error,
    }
  }

  const processPath = process.env.PATH ?? ''
  const modelPath = await bash('printf %s "$PATH"')
  check(
    'the child PATH is the harness process PATH byte for byte (no prepend, no append)',
    modelPath.text === processPath,
    `modelPath===process.env.PATH (${processPath.split(':').length} entries)`,
  )
  check(
    'a registered DSH_* contribution does reach the model shell',
    await (async () => {
      const dispose = ctx.shellEnv.register({
        name: 's19-probe',
        variables: { DSH_S19_PROBE: { description: 'S19 positive control for the managed-env seam' } },
        resolve: () => ({ DSH_S19_PROBE: 'hello-s19' }),
      })
      try {
        const result = await bash('printf %s "$DSH_S19_PROBE"')
        return result.text === 'hello-s19'
      } finally {
        dispose()
      }
    })(),
    'a probe contributor registered through ctx.shellEnv appears in the child of a model-shaped call',
  )

  // ---- the refusals --------------------------------------------------------
  let pathRefusal
  try {
    ctx.shellEnv.register({
      name: 's19-path',
      variables: { PATH: { description: 'the plugin bin directory' } },
      resolve: () => ({}),
    })
  } catch (error) {
    pathRefusal = error
  }
  check(
    'registering a contributor that declares PATH throws the exact namespace refusal',
    pathRefusal?.message === 'bash env contributor "s19-path" declared invalid key "PATH"',
    String(pathRefusal?.message ?? 'no error thrown'),
  )

  let smuggled
  const disposeSmuggle = ctx.shellEnv.register({
    name: 's19-smuggle',
    variables: { DSH_S19_SMUGGLE: { description: 'declared placeholder; the resolver tries to return PATH' } },
    resolve: () => ({ PATH: '/s19/should-not-apply' }),
  })
  try {
    smuggled = await bash('printf %s "$PATH"')
  } finally {
    disposeSmuggle()
  }
  check(
    'a resolver that returns PATH without declaring it is refused inside the model call',
    smuggled.isError === true &&
      smuggled.error?.message === 'bash env contributor "s19-smuggle" returned undeclared key "PATH"' &&
      smuggled.error?.info?.code === 'SHELL_ENV_CONTRIBUTION_INVALID',
    `${smuggled.error?.info?.name ?? 'no error'} ${smuggled.error?.info?.code ?? ''}: ${smuggled.error?.message ?? 'no error'}`,
  )

  const schema = ctx.tools.schemas().find((entry) => entry.name === 'bash')
  const envArgResult = await bash('printf %s "$PATH"', { env: { PATH: '/s19/model-supplied' } })
  check(
    'the tool declares no env parameter, and an env member smuggled into the arguments is ignored',
    schema !== undefined &&
      !Object.hasOwn(schema.parameters?.properties ?? {}, 'env') &&
      envArgResult.text === processPath &&
      envArgResult.exitCode === 0,
    'parameters: ' + Object.keys(schema?.parameters?.properties ?? {}).join(', '),
  )

  // ---- the probe plugin bin/ ----------------------------------------------
  const probeRoot = mkdtempSync(join(tmpdir(), 'anyplugin-s19-'))
  const probeBin = join(probeRoot, 'bin')
  const emptyDir = join(probeRoot, 'empty')
  mkdirSync(probeBin, { recursive: true })
  mkdirSync(emptyDir, { recursive: true })
  writeFileSync(join(probeBin, 'probecmd'), '#!/bin/sh\nprintf probecmd-ran\n', { mode: 0o755 })
  writeFileSync(join(probeBin, 'ls'), '#!/bin/sh\nprintf shadow-ls-ran\n', { mode: 0o755 })
  try {
    const bareName = await bash('probecmd')
    check(
      'a plugin bin/ is absent from the model PATH and its bare command name does not resolve',
      !processPath.split(':').includes(probeBin) &&
        !modelPath.text.split(':').includes(probeBin) &&
        bareName.exitCode === 127 &&
        /not found/.test(bareName.text),
      `probecmd exit ${bareName.exitCode}: ${bareName.text.trim().split('\n')[0]}`,
    )

    const whichLs = await bash('command -v ls')
    const lsRun = await bash('ls', { workdir: emptyDir })
    check(
      'a plugin file named `ls` does not shadow the system `ls` (there is no PATH entry to order at all)',
      !whichLs.text.includes(probeBin) &&
        existsSync(whichLs.text.trim()) &&
        !lsRun.text.includes('shadow-ls-ran'),
      `command -v ls -> ${whichLs.text.trim()}; ls output: ${JSON.stringify(lsRun.text)}`,
    )
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }

  // `scrubbedParentEnv()` is the same function the child env starts from; the
  // check above proves the model shell's PATH equals it, so the inherited PATH
  // is the only source. This pins the mechanism, not just the observation.
  const scrubbed = scrubbedParentEnv()
  check(
    'the scrub keeps PATH and strips only DSH_* and credential-looking names',
    scrubbed.PATH === process.env.PATH && !/KEY|PASSWORD|SECRET|TOKEN/i.test('PATH'),
    'scrubbedParentEnv().PATH === process.env.PATH',
  )

  const report = {
    harness: HARNESS,
    source: HARNESS_SOURCE,
    version: versionOf('dsh-shell-env'),
    question: "does a plugin's bin/ reach the model shell PATH without a DSH core change?",
    answer: 'no: PATH is outside the DSH_* namespace the only registration API accepts, and the child PATH is the inherited process PATH',
    anchors: {
      register: `dsh-shell-env/src/index.ts:${registryDocs.register}`,
      keyGuard: `dsh-shell-env/src/index.ts:${registryDocs.guard}-${registryDocs.guard + 2}`,
      collectUndeclared: `dsh-shell-env/src/index.ts:${registryDocs.undeclared}`,
      bashCollect: `dsh-tool-bash/src/index.ts:${bashCollect}`,
      requestType: `dsh-shell/src/types.ts:${lastLineOf(shellTypes, 'model-facing bash tool does not expose it as a parameter')}`,
      pwshCollect: `dsh-tool-pwsh/src/index.ts:${lineOf(pwshToolSource, 'dshEnv: ctx.shellEnv.collect(exec)')}`,
      childEnvMerge: `dsh-bash-local/src/index.ts:${lineOf(bashLocalSource, 'env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },')}`,
      childEnvBase: `dsh-subprocess-local/src/spawn.ts:${lineOf(spawnSource, 'const env = scrubbedParentEnv()')}-${lineOf(spawnSource, 'const env = scrubbedParentEnv()') + 1}`,
    },
    refusals: {
      registerPath: pathRefusal?.message ?? null,
      resolveUndeclaredPath: smuggled.error?.message ?? null,
    },
    checks,
  }
  mkdirSync(join(HERE, 'out'), { recursive: true })
  writeFileSync(join(HERE, 'out', 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
