#!/usr/bin/env node
/**
 * S24 — can a plugin register a terminal palette, and can it express every
 * colour in Claude Code's `themes/<slug>.json`?
 *
 * Recorded answer: PARTIAL. The documented client theme surface is real
 * (`ThemeRuntime.register` through `ctx.theme`) and accepts alias-token CSS
 * variables. Two of Claude's 72 named roles reach the terminal through that
 * surface: `text` -> `--dsw-alias-label-primary` and `background` ->
 * `--dsw-alias-bg-base`, which the layout presenter writes to `document.body`
 * and the terminal reads back as computed foreground/background. The other 70
 * roles have no DSH terminal counterpart, and the terminal's ANSI 16 are
 * written only from xterm OSC 4/104. F2 is therefore `planned`, with the
 * ANSI-16 palette as the named host gap.
 *
 * The assertions enumerate the real API surfaces and execute the terminal
 * class. They fail if the theme runtime or terminal grows a palette/ANSI
 * field, if the two-role CSS path disappears, or if the pinned Claude schema
 * drifts. They are not line-number snapshots.
 *
 * Pins:
 *   DSH  0.2.2-rc.2 and 0.2.2-rc.5
 *   Claude Code 2.1.329
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() ?? '0.2.2-rc.5'
const PINS = new Set(['0.2.2-rc.2', '0.2.2-rc.5'])
const CLAUDE_PIN = '2.1.329'
const PACKAGES = [
  'dsh-client-ui-theme',
  'dsh-client-ui-layout',
  'dsh-client-ui-sidebar-terminal',
]

const THEME_EXPORTS = ['SETTINGS_NS', 'ThemeRuntime', 'apply', 'inject']
const THEME_PROTOTYPE = [
  'constructor', 'getTheme', 'exportInspectTokens', 'setTheme', 'setFontSize',
  'adjustFontSizes', 'setFontFamily', 'write', 'adopt', 'register',
  'overrideTokens', 'buildSnapshot', 'composeActive', 'publish',
]
const THEME_OWN = [
  'ctx', 'host', 'themes', 'preference', 'fontSizes', 'fontFamilies',
  'revision', 'pendingWrites', 'snapshot', 'media', 'overrides', 'overrideSeq',
]
const SNAPSHOT_KEYS = ['preference', 'fontSizes', 'fontFamilies', 'active', 'themes', 'revision']
const ACTIVE_KEYS = ['id', 'colorScheme', 'tokens']
const CLAUDE_ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright',
  'magentaBright', 'cyanBright', 'whiteBright',
]
const TERMINAL_PROTOTYPE = ['constructor', 'update', 'cursor', 'dispose', 'apply']
const TERMINAL_OWN = ['terminal', 'defaults', 'indexed', 'special', 'subscriptions']
const UPDATE_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionForeground', 'selectionInactiveBackground',
]
const MAPPED_ROLES = {
  text: '--dsw-alias-label-primary',
  background: '--dsw-alias-bg-base',
}

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
]

// The light palette object from the pinned Claude Code binary. Every base
// palette carries the same 72 named TUI roles.
const CLAUDE_ROLES = [
  'autoAccept', 'autoAcceptShimmer', 'skill', 'bashBorder', 'claude',
  'claudeShimmer', 'claudeBlue_FOR_SYSTEM_SPINNER',
  'claudeBlueShimmer_FOR_SYSTEM_SPINNER', 'permission', 'permissionShimmer',
  'planMode', 'ide', 'promptBorder', 'promptBorderShimmer', 'text',
  'inverseText', 'inactive', 'inactiveShimmer', 'subtle', 'suggestion',
  'remember', 'background', 'success', 'error', 'warning', 'merged',
  'warningShimmer', 'diffAdded', 'diffRemoved', 'diffAddedDimmed',
  'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord',
  'red_FOR_SUBAGENTS_ONLY', 'blue_FOR_SUBAGENTS_ONLY',
  'green_FOR_SUBAGENTS_ONLY', 'yellow_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY', 'orange_FOR_SUBAGENTS_ONLY',
  'pink_FOR_SUBAGENTS_ONLY', 'cyan_FOR_SUBAGENTS_ONLY', 'professionalBlue',
  'chromeYellow', 'clawd_body', 'clawd_background', 'userMessageBackground',
  'userMessageBackgroundHover', 'composerSidebarBackground', 'selectionBg',
  'bashMessageBackgroundColor', 'memoryBackgroundColor', 'rate_limit_fill',
  'rate_limit_empty', 'fastMode', 'fastModeShimmer', 'effortUltra',
  'briefLabelYou', 'briefLabelClaude', 'rainbow_red', 'rainbow_orange',
  'rainbow_yellow', 'rainbow_green', 'rainbow_blue', 'rainbow_indigo',
  'rainbow_violet', 'rainbow_red_shimmer', 'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer', 'rainbow_green_shimmer', 'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer', 'rainbow_violet_shimmer',
]

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(message) {
  console.error(`S24: ${message}`)
  process.exit(2)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sortedEqual(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
}

function exportedNames(source) {
  const names = []
  for (const match of source.matchAll(
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu,
  )) names.push(match[1])
  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name) names.push(name)
    }
  }
  return names
}

function walkFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...walkFiles(path))
    else if (/\.(?:ts|tsx)$/u.test(entry) && !/\.d\.ts$/u.test(entry)) files.push(path)
  }
  return files
}

function candidateRoots(root) {
  return [
    join(root, 'node_modules', '@deepseek-ai'),
    join(root, '@deepseek-ai'),
    root,
    dirname(root),
  ]
}

function locateHarness() {
  const explicit = process.env.DSH_HARNESS_DIR?.trim()
  if (explicit) return resolve(explicit)
  const desktop = process.env.DSH_INSTALL_DIR?.trim()
  if (desktop) return resolve(desktop)
  const fetched = join(REPO, '.harness', VERSION)
  if (existsSync(fetched)) return fetched
  fail(`set DSH_HARNESS_DIR (a scripts/fetch-harness.mjs root) — tried ${fetched}`)
}

function locatePackages(root) {
  const roots = candidateRoots(root)
  const missing = PACKAGES.filter((name) => !roots.some((candidate) =>
    existsSync(join(candidate, name, 'package.json'))))
  if (missing.length > 0) {
    fail(`harness ${root} is missing ${missing.join(', ')}; the S24 probe needs the theme, layout and terminal packages in HARNESS_PACKAGES`)
  }
  return Object.fromEntries(PACKAGES.map((name) => [
    name,
    join(roots.find((candidate) => existsSync(join(candidate, name, 'package.json'))), name),
  ]))
}

function moduleLoader(file, react) {
  const registrations = []
  const quiet = { log() {}, info() {}, warn() {}, error() {} }
  const sandbox = {
    console: quiet,
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration)
        },
      },
    },
  }
  vm.createContext(sandbox)
  new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox)
  if (registrations.length !== 1) {
    throw new Error(`expected one __ModuleLoader__.load registration, got ${registrations.length}`)
  }
  const registration = registrations[0]
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: {} }
    return new Proxy({}, { get() { return () => {} } })
  })
  return { exports, registration }
}

function loadThemeBundle(file) {
  return moduleLoader(file, {
    createElement() {}, Fragment: {}, useState() { return [undefined, () => {}] },
    useEffect() {}, useLayoutEffect() {}, useMemo(fn) { return fn() },
    useRef(value) { return { current: value } }, useCallback(fn) { return fn },
  })
}

function loadTerminalBundle(file) {
  return moduleLoader(file, {
    createElement() {}, Fragment: {}, lazy(fn) { return fn }, Suspense: {},
    useState() { return [undefined, () => {}] }, useEffect() {},
    useLayoutEffect() {}, useMemo(fn) { return fn() },
    useRef(value) { return { current: value } }, useCallback(fn) { return fn },
  })
}

function runTerminalProbe(sourceFile) {
  const directory = mkdtempSync(join(tmpdir(), 's24-terminal-'))
  const copy = join(directory, 'terminal-theme.ts')
  writeFileSync(copy, readFileSync(sourceFile))
  const script = `
    import { pathToFileURL } from 'node:url'
    const { TerminalTheme } = await import(pathToFileURL(process.env.S24_TERMINAL_FILE).href)
    const handlers = []
    const terminal = {
      parser: { registerOscHandler(code, callback) { handlers.push({ code, callback }); return { dispose() {} } } },
      options: {},
    }
    const instance = new TerminalTheme(terminal)
    instance.update('#101014', '#f4f4f5')
    console.log(JSON.stringify({
      own: Object.getOwnPropertyNames(instance),
      proto: Object.getOwnPropertyNames(TerminalTheme.prototype),
      theme: terminal.options.theme,
      handlers: handlers.map((handler) => handler.code),
    }))
  `
  const result = spawnSync(process.execPath, [
    '--no-warnings', '--experimental-transform-types', '--input-type=module', '-e', script,
  ], {
    encoding: 'utf8',
    env: { ...process.env, S24_TERMINAL_FILE: copy },
    maxBuffer: 1024 * 1024,
  })
  rmSync(directory, { recursive: true, force: true })
  if (result.status !== 0) return { error: result.stderr.trim() || `exit ${result.status}` }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    return { error: `unparsable probe output: ${error.message}` }
  }
}

function findClaudePackage(binary) {
  const direct = dirname(binary)
  for (const candidate of [direct, join(direct, '..', 'claude-code')]) {
    const manifest = join(candidate, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      if (readJson(manifest).name === '@anthropic-ai/claude-code') return candidate
    } catch {
      // Not the package root; keep looking.
    }
  }
  return undefined
}

console.log('S24: can a plugin register a terminal palette?')
console.log(`DSH_HARNESS_VERSION=${VERSION}`)
if (!PINS.has(VERSION)) fail(`unsupported pin ${VERSION}; S24 is recorded for ${[...PINS].join(' and ')}`)

const harness = locateHarness()
const dirs = locatePackages(harness)
console.log(`DSH_HARNESS_DIR=${harness}`)
console.log(`CLAUDE_PIN=${CLAUDE_PIN}`)

const themeDir = dirs['dsh-client-ui-theme']
const layoutDir = dirs['dsh-client-ui-layout']
const terminalDir = dirs['dsh-client-ui-sidebar-terminal']
const themePkg = readJson(join(themeDir, 'package.json'))
const terminalPkg = readJson(join(terminalDir, 'package.json'))
check('theme package pinned', themePkg.version === VERSION, themePkg.version)
check('layout package pinned', readJson(join(layoutDir, 'package.json')).version === VERSION, VERSION)
check('terminal package pinned', terminalPkg.version === VERSION, terminalPkg.version)
check('theme package is an immediately-mounted web client plugin',
  themePkg.dsh?.client?.immediately === true && themePkg.dsh?.client?.platform === 'web',
  JSON.stringify(themePkg.dsh?.client))

// --- Theme side: a documented plugin surface, alias CSS only.
const themeSource = readFileSync(join(themeDir, 'src/client/index.ts'), 'utf8')
const themeReadme = readFileSync(join(themeDir, 'README.md'), 'utf8').replace(/\s+/gu, ' ')
check('documented plugin surface: ctx.theme registration exists',
  themeReadme.includes('A composition can register a third-party theme id with alias-token overrides through `ctx.theme`'))
check('theme service is provided by the package',
  themeSource.includes("ctx.provide('theme', theme)") &&
  themeSource.includes('theme: ThemeRuntime') &&
  themeSource.includes("declare module '@deepseek-ai/cordis'"))
check('theme tokens are CSS alias variables, not a palette',
  themeSource.includes('Alias-layer overrides applied as inline CSS variables over the base palette.'))

const builtinStart = themeSource.indexOf('const BUILTIN_INSPECT_TOKENS')
const builtinEnd = themeSource.indexOf('\n])', builtinStart)
if (builtinStart < 0 || builtinEnd < 0) fail('BUILTIN_INSPECT_TOKENS not found in the pinned theme source')
const builtinBlock = themeSource.slice(builtinStart, builtinEnd)
const builtinTokens = [...builtinBlock.matchAll(/name: '([^']+)'/gu)].map((match) => match[1])
check('theme inspector still advertises 14 curated CSS tokens', builtinTokens.length === 14, `${builtinTokens.length}`)
check('no curated token is an ANSI/terminal palette slot',
  builtinTokens.every((name) => !/ansi|terminal/iu.test(name)),
  builtinTokens.filter((name) => /ansi|terminal/iu.test(name)).join(', '))
check('the curated list is not the registration limit',
  themeSource.includes('ThemeTokens = Record<string, string>') &&
  themeSource.includes('register(definition: ThemeDefinition)'),
  'ThemeTokens accepts any CSS variable name')

const { exports: themeExports, registration: themeRegistration } =
  loadThemeBundle(join(themeDir, 'lib/client.js'))
check('client bundle registers the pinned package id',
  themeRegistration.id === '@deepseek-ai/dsh-client-ui-theme', themeRegistration.id)
check('theme client exports exactly SETTINGS_NS/ThemeRuntime/apply/inject',
  sortedEqual(Object.keys(themeExports), THEME_EXPORTS), Object.keys(themeExports).join(','))
check('ThemeRuntime prototype has exactly the recorded 14 members',
  sortedEqual(Object.getOwnPropertyNames(themeExports.ThemeRuntime.prototype), THEME_PROTOTYPE),
  Object.getOwnPropertyNames(themeExports.ThemeRuntime.prototype).join(','))
check('no ThemeRuntime member is a palette/ANSI API',
  Object.getOwnPropertyNames(themeExports.ThemeRuntime.prototype)
    .every((name) => !/(?:palette|ansi)/iu.test(name)))

const changes = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject() {},
  emit(event, snapshot) {
    changes.push({ event, snapshot })
  },
}
const host = {
  subscribe() { return () => {} },
  getSnapshot() { return { value: undefined } },
  set() { return Promise.resolve(true) },
}
const runtime = new themeExports.ThemeRuntime(ctx, host)
check('runtime starts from the built-in light/dark themes',
  runtime.getTheme().themes.map((theme) => theme.id).sort().join(',') === 'dark,light')
check('runtime own keys are exactly the recorded 12',
  sortedEqual(Object.getOwnPropertyNames(runtime), THEME_OWN),
  Object.getOwnPropertyNames(runtime).join(','))
check('no runtime field is a palette/ANSI slot',
  Object.getOwnPropertyNames(runtime).every((name) => !/(?:palette|ansi)/iu.test(name)))

const probeId = 's24-probe-dark'
const probeTokens = {
  '--dsw-alias-bg-base': '#101014',
  '--dsw-alias-label-primary': '#f4f4f5',
  '--dsw-alias-s24-probe': '#123456',
}
const disposeTheme = runtime.register({ id: probeId, colorScheme: 'dark', tokens: probeTokens })
check('a plugin-registered theme is accepted and returns a disposer', typeof disposeTheme === 'function')
runtime.setTheme(probeId)
const snapshot = runtime.getTheme()
check('the plugin theme becomes active', snapshot.active?.id === probeId, snapshot.active?.id)
check('the snapshot keeps exactly the six recorded keys',
  sortedEqual(Object.keys(snapshot), SNAPSHOT_KEYS), Object.keys(snapshot).join(','))
check('the active theme keeps only id/colorScheme/tokens plus optional icons',
  Object.keys(snapshot.active ?? {}).every((key) => [...ACTIVE_KEYS, 'icons'].includes(key)) &&
  ACTIVE_KEYS.every((key) => key in (snapshot.active ?? {})),
  Object.keys(snapshot.active ?? {}).join(','))
check('the active theme carries exactly the registered CSS tokens',
  JSON.stringify(snapshot.active?.tokens) === JSON.stringify(probeTokens),
  JSON.stringify(snapshot.active?.tokens))
check('the snapshot has no palette/ANSI channel',
  !('ansi' in (snapshot.active ?? {})) && !('palette' in (snapshot.active ?? {})),
  Object.keys(snapshot.active ?? {}).join(','))
const inspect = runtime.exportInspectTokens()
const dynamic = inspect.find((token) => token.name === '--dsw-alias-s24-probe')
check('an arbitrary alias token is exported as a CSS value',
  dynamic?.valueType === 'CSS value' && dynamic?.requiresLightAndDark === true,
  JSON.stringify(dynamic))
check('no inspected token is an ANSI palette slot',
  inspect.every((token) => !/ansi/iu.test(token.name)),
  inspect.filter((token) => /ansi/iu.test(token.name)).map((token) => token.name).join(', '))

// --- The two-role bridge: active tokens -> layout body -> terminal CSS -> xterm.
const presenter = readFileSync(join(layoutDir, 'src/client/theme-presenter.ts'), 'utf8')
const terminalCss = readFileSync(join(terminalDir, 'src/client/terminal.module.css'), 'utf8')
check('the layout presenter applies every active token to document.body',
  presenter.includes('for (const [name, value] of Object.entries(snapshot.active.tokens))') &&
  presenter.includes('body.style.setProperty(name, value)') &&
  presenter.includes('this.appliedTokens.push(name)'))
check('the terminal CSS consumes the two mapped aliases',
  terminalCss.includes('color: var(--dsw-alias-label-primary)') &&
  terminalCss.includes('background: var(--dsw-alias-bg-base)'))
check('exactly two of Claude\'s 72 roles are mapped',
  Object.keys(MAPPED_ROLES).length === 2 && CLAUDE_ROLES.length === 72,
  `${Object.keys(MAPPED_ROLES).length}/72`)
check('the two mapped roles are present in Claude\'s vocabulary',
  Object.keys(MAPPED_ROLES).every((role) => CLAUDE_ROLES.includes(role)))

// --- Terminal side: ANSI 16 are OSC-only; the theme supplies computed bg/fg and fonts.
const terminalSource = readFileSync(join(terminalDir, 'src/client/terminal-theme.ts'), 'utf8')
const terminalView = readFileSync(join(terminalDir, 'src/client/terminal.tsx'), 'utf8')
const terminalIndex = readFileSync(join(terminalDir, 'src/client/index.ts'), 'utf8')
const terminalNoComments = stripComments(terminalSource)

check('terminal theme update signature is background/foreground only',
  terminalSource.includes('update(background: string, foreground: string): void'))
check('terminal theme has no palette identifier outside comments',
  !/\b(?:palette|palettes)\b/iu.test(terminalNoComments) &&
  !/(?:registerPalette|setPalette|applyPalette|terminalPalette|themePalette)/u.test(terminalNoComments))
const updateStart = terminalSource.indexOf('update(background: string, foreground: string): void {')
const updateEnd = terminalSource.indexOf('\n  }', updateStart)
if (updateStart < 0 || updateEnd < 0) fail('update() not found in the pinned terminal source')
const updateBody = terminalSource.slice(updateStart, updateEnd)
check('update sets only the fixed seven xterm theme fields',
  updateBody.includes('background, foreground, cursor: foreground, cursorAccent: background,') &&
  updateBody.includes('selectionBackground: foreground, selectionForeground: background, selectionInactiveBackground: foreground,'))
check('update contains no ANSI colour names',
  !/\b(?:black|red|green|yellow|blue|magenta|cyan|white)\b/iu.test(updateBody))

const ansiArray = /const ansiKeys = \[([^\]]+)\] as const/u.exec(terminalSource)?.[1] ?? ''
const ansiNames = [...ansiArray.matchAll(/'([^']+)'/gu)].map((match) => match[1])
check('the terminal has exactly the 16 xterm ANSI slots',
  JSON.stringify(ansiNames) === JSON.stringify(ANSI_KEYS), ansiNames.join(','))

const applyStart = terminalSource.indexOf('  private apply(): void {')
const applyEnd = terminalSource.indexOf('\n  }', applyStart)
if (applyStart < 0 || applyEnd < 0) fail('private apply() not found in the pinned terminal source')
const applyBody = terminalSource.slice(applyStart, applyEnd)
check('ANSI slots are written only from the OSC-indexed map',
  applyBody.includes('for (const [index, color] of this.indexed)') &&
  applyBody.includes('theme[ansiKeys[index]!] = color'))
check('no theme/token input reaches the terminal palette',
  !/ctx\.theme|ThemeDefinition|--dsw-|theme\.tokens/iu.test(terminalSource))

const osc4 = terminalSource.indexOf('observe(4,')
const indexedSet = terminalSource.indexOf('this.indexed.set(')
const osc104 = terminalSource.indexOf('observe(104,')
const indexedDelete = terminalSource.indexOf('this.indexed.delete(')
check('OSC 4 is the only writer of ANSI entries',
  osc4 > -1 && indexedSet > osc4 && indexedSet < osc104 &&
  terminalSource.indexOf('this.indexed.set(', indexedSet + 1) === -1)
check('OSC 104 clears/deletes ANSI entries',
  indexedDelete > osc104 && terminalSource.includes('this.indexed.clear()'))

const updateCalls = [...terminalView.matchAll(/\.update\(([^)]*)\)/gu)]
check('the view calls update() with exactly two arguments',
  updateCalls.length === 1 && updateCalls[0][1].split(',').length === 2,
  updateCalls.map((match) => match[1]).join(' | '))
check('the view feeds only computed background/foreground to xterm',
  terminalView.includes('colors.current!.update(style.backgroundColor, style.color)'))
const themeReads = [...terminalView.matchAll(/theme\.([A-Za-z.]+)/gu)]
  .map((match) => match[1])
  .filter((read) => read !== 'ts')
check('the terminal reads only terminal font size/family from the theme',
  themeReads.length > 0 && themeReads.every((read) =>
    read === 'fontFamilies.terminal' || read === 'fontSizes.terminal'),
  [...new Set(themeReads)].join(','))
check('the terminal injects the theme service but never registers a palette',
  /export const inject = \[[^\]]*'theme'/u.test(terminalIndex) &&
  !/theme\.register|registerPalette|palette/iu.test(stripComments(terminalIndex)))

const terminalClient = loadTerminalBundle(join(terminalDir, 'lib/client.js'))
check('terminal client exports only apply/inject',
  sortedEqual(Object.keys(terminalClient.exports), ['apply', 'inject']),
  Object.keys(terminalClient.exports).join(','))

const terminalSources = walkFiles(join(terminalDir, 'src/client'))
check('the terminal client source tree is present', terminalSources.length >= 5, `${terminalSources.length} files`)
const exportedPaletteNames = terminalSources.flatMap((file) =>
  exportedNames(stripComments(readFileSync(file, 'utf8'))).filter((name) => /(?:palette|ansi)/iu.test(name)))
check('no terminal client export names a palette/ANSI API',
  exportedPaletteNames.length === 0, exportedPaletteNames.join(','))
const registrationCalls = terminalSources.flatMap((file) => {
  const source = stripComments(readFileSync(file, 'utf8'))
  return [...source.matchAll(/\b(registerPalette|setPalette|applyPalette|terminalPalette|themePalette)\b/gu)]
    .map((match) => `${file}:${match[1]}`)
})
check('no terminal client file registers a palette',
  registrationCalls.length === 0, registrationCalls.join(','))

const terminalProbe = runTerminalProbe(join(terminalDir, 'src/client/terminal-theme.ts'))
if (terminalProbe.error) {
  check('the real TerminalTheme class executes', false, terminalProbe.error)
} else {
  check('the real TerminalTheme class executes', true)
  check('TerminalTheme instance own keys are exactly the recorded five',
    sortedEqual(terminalProbe.own, TERMINAL_OWN), terminalProbe.own.join(','))
  check('TerminalTheme prototype is exactly constructor/update/cursor/dispose/apply',
    sortedEqual(terminalProbe.proto, TERMINAL_PROTOTYPE), terminalProbe.proto.join(','))
  check('the executed terminal has no palette/ANSI field',
    terminalProbe.own.every((name) => !/(?:palette|ansi)/iu.test(name)))
  check('update() writes exactly the seven xterm theme fields',
    sortedEqual(Object.keys(terminalProbe.theme ?? {}), UPDATE_KEYS),
    Object.keys(terminalProbe.theme ?? {}).join(','))
  check('the executed terminal theme has no ANSI-palette keys',
    Object.keys(terminalProbe.theme ?? {}).every((key) => !/ansi/iu.test(key)) &&
    !('extendedAnsi' in (terminalProbe.theme ?? {})))
  check('update() registers OSC 4 and OSC 104 handlers',
    terminalProbe.handlers.includes(4) && terminalProbe.handlers.includes(104),
    terminalProbe.handlers.join(','))
}

// --- Claude side: the theme JSON is 72 named TUI roles over six bases.
const claudeBinary = process.env.CLAUDE_BIN?.trim()
  ? resolve(process.env.CLAUDE_BIN.trim())
  : join(REPO, '.claude-code', CLAUDE_PIN, 'node_modules', '@anthropic-ai', 'claude-code-linux-x64', 'claude')
if (!existsSync(claudeBinary)) {
  check('pinned Claude binary exists', false, claudeBinary)
} else {
  console.log(`CLAUDE_BIN=${claudeBinary}`)
  const version = spawnSync(claudeBinary, ['--version'], { encoding: 'utf8' })
  check('Claude binary reports the pinned version',
    version.status === 0 && `${version.stdout}${version.stderr}`.includes(CLAUDE_PIN),
    `${version.stdout}${version.stderr}`.trim())

  const claudeText = readFileSync(claudeBinary, 'latin1')
  const switchCode = 'function TX(r){switch(r){case"light":return x;case"light-ansi":return I;' +
    'case"dark-ansi":return W;case"light-daltonized":return P;' +
    'case"dark-daltonized":return D;default:return w}}'
  check('six named base palettes, dark default', claudeText.includes(switchCode))

  const paletteStart = claudeText.indexOf('var x={autoAccept:')
  if (paletteStart < 0) fail('Claude light palette object not found in the pinned binary')
  let depth = 0
  let paletteEnd = -1
  for (let i = paletteStart + 'var x='.length; i < claudeText.length; i++) {
    if (claudeText[i] === '{') depth++
    else if (claudeText[i] === '}' && --depth === 0) { paletteEnd = i + 1; break }
  }
  if (paletteEnd < 0) fail('unterminated Claude palette object')
  const paletteLiteral = claudeText.slice(paletteStart + 'var x='.length, paletteEnd)
  const roles = [...paletteLiteral.matchAll(/(?:^|[,{])([A-Za-z_][A-Za-z0-9_]*):/gu)]
    .map((match) => match[1])
  check('Claude theme has exactly 72 named TUI roles', roles.length === 72, `${roles.length}`)
  check('Claude role names match the recorded vocabulary',
    sortedEqual(roles, CLAUDE_ROLES),
    roles.filter((role) => !CLAUDE_ROLES.includes(role)).join(',') || 'no extra roles')
  check('Claude roles include text and background but no ANSI slot',
    roles.includes('text') && roles.includes('background') &&
    roles.every((role) => !/ansi/iu.test(role)))
  check('Claude overrides accept rgb/#/ansi256/ansi:name and only existing keys',
    claudeText.includes('if(/^ansi256\\(\\d{1,3}\\)$/.test(r))return!0') &&
    claudeText.includes('if(r.startsWith("ansi:"))return u.has(r.slice(5))') &&
    claudeText.includes('for(let[n,g]of Object.entries(e))if(Object.hasOwn(r,n)&&Uce(g))i[n]=g'))
  check('Claude ANSI names are the 16 SGR names',
    CLAUDE_ANSI_NAMES.every((name) => claudeText.includes(`${name}:!0`)))
  check('Claude has no theme subcommand/flag',
    spawnSync(claudeBinary, ['--help'], { encoding: 'utf8' }).stdout
      ?.split('\n')
      .filter((line) => /^\s{1,8}(?:theme|--theme)\b/u.test(line)).length === 0)
  check('a theme file is not a fixture and no fixture was invented',
    !existsSync(join(HERE, 'fixtures')))

  const claudeRoot = findClaudePackage(claudeBinary)
  check('Claude npm package root found', Boolean(claudeRoot), claudeRoot ?? 'not found')
  if (claudeRoot) {
    check('pinned Claude package ships no themes/ directory', !existsSync(join(claudeRoot, 'themes')))
    const sdk = join(claudeRoot, 'sdk-tools.d.ts')
    check('sdk-tools.d.ts has no theme declaration',
      !existsSync(sdk) || !/theme/iu.test(readFileSync(sdk, 'utf8')))
  }
}

const failed = checks.filter((entry) => !entry.ok)
console.log('\nS24 anchors:')
console.log(`  ${terminalDir}/src/client/terminal-theme.ts      (update() has no palette argument; ANSI only from this.indexed/OSC 4)`)
console.log(`  ${terminalDir}/src/client/terminal.tsx           (only computed background/foreground feed xterm)`)
console.log(`  ${layoutDir}/src/client/theme-presenter.ts       (active CSS tokens are written to document.body)`)
console.log(`  ${terminalDir}/src/client/terminal.module.css    (terminal consumes --dsw-alias-label-primary / --dsw-alias-bg-base)`)
console.log(`  ${themeDir}/src/client/index.ts                  (tokens are alias-layer CSS variables)`)
console.log(`  ${claudeBinary}                                  (72 TUI roles; six bases; no ANSI-index token)`)

if (failed.length > 0) {
  console.error(`\nS24 FAIL: ${failed.length} of ${checks.length} assertions failed; the recorded answer is no longer true.`)
  process.exit(1)
}
console.log(`\nS24 PASS: ${checks.length} assertions.`)
console.log('ANSWER: no plugin-registerable ANSI palette. A plugin can register alias-token CSS themes through ctx.theme; 2 of Claude\'s 72 roles reach the terminal through computed foreground/background, 70 have no DSH terminal counterpart, and the ANSI 16 are written only by OSC 4/104. F2 stays planned, with the ANSI-16 palette as the named host gap (D75).')
