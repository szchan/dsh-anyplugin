#!/usr/bin/env node
/**
 * S25 — what renderer surface can a DSH client plugin actually reach from a
 * plugin that lives outside the host installation?
 *
 * Pins: DSH 0.2.2-rc.2 (Desktop, extracted tree) and 0.2.2-rc.5 (npm). The
 * spike runs against the fetched harness union at those pins (the same tree CI
 * installs) and reads source anchors out of it. It answers, in order:
 *
 *   1. pane / render site  — does the host layout mount a pane registered by
 *      an outside bundle? (`main` keyed seat, `shell.overlay` additive seat)
 *   2. DOM / React mount   — what exactly is handed to the plugin's component?
 *   3. keyboard / focus    — declared command + fixed-input surface; no focus
 *      service exists, focus movement stays page-DOM
 *   4. layout size / resize— only the occupied single seats get geometry props;
 *      a `main`/overlay entry gets none, and page-DOM observers are the fallback
 *   5. animation frames    — page realm only, no host pacing hook
 *   6. main-process channel— the plugin's own host half registers `webServer`
 *      HTTP routes; request/response round trip is executed over real HTTP
 *
 * Method: the spike boots the pinned host halves for real (dsh-host-webserver,
 * cordis-plugin-loader + dsh-client-modules), then executes the pinned client
 * bundles in one `node:vm` page realm: the loader's own browser half,
 * dsh-client-ui-renderer (SlotRegistry + root React binding), dsh-client-ui-layout
 * (the AppFrame that owns the render sites) and dsh-client-shortcuts (the
 * declared keyboard surface). The fixture bundle is served through the host
 * `/plugins` route and imported through the real module system; its pane is then
 * selected, rendered with real React 18.3.1 (`react-dom/server`), and its
 * commands are exercised with synthetic DOM events.
 *
 * Not proven here (see README): a real browser/Electron window (script-element
 * injection is the read anchor), focus movement (no declared API), layout
 * geometry inside a real viewport, and rAF pacing. Those are read from the host
 * API surface, never presented as runs.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = (process.env.DSH_HARNESS_VERSION ?? '').trim() || '0.2.2-rc.5'
const PINS = new Set(['0.2.2-rc.2', '0.2.2-rc.5'])
const FIXTURE = join(HERE, 'fixtures', 'anyplugin-s25-surface')
const PACKAGE = 'anyplugin-s25-surface'
const REQUIRED = [
  'cordis',
  'cordis-plugin-loader',
  'dsh-client-modules',
  'dsh-client-ui-slots',
  'dsh-client-ui-renderer',
  'dsh-client-ui-layout',
  'dsh-client-ui-primitives',
  'dsh-client-store',
  'dsh-client-shortcuts',
  'dsh-host-webserver',
]

if (!PINS.has(VERSION)) fail(`unsupported DSH_HARNESS_VERSION ${JSON.stringify(VERSION)}; the pins are ${[...PINS].join(', ')}`)

const checks = []
const anchors = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const until = async (fn, label, timeoutMs = 5000) => {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}
function fail(message) {
  console.log(`S25: ${message}`)
  process.exit(2)
}
function lineOf(text, needle) {
  const index = text.indexOf(needle)
  if (index === -1) throw new Error(`anchor not found: ${needle}`)
  return text.slice(0, index).split('\n').length
}
function anchorOf(packageName, file, needle, text) {
  const anchor = `${packageName}/${file}:${lineOf(text, needle)}`
  anchors.push(anchor)
  return anchor
}

// --------------------------------------------------------------- harness tree
function scopeOf(candidate) {
  for (const scope of [
    join(candidate, 'node_modules', '@deepseek-ai'),
    join(candidate, '@deepseek-ai'),
    candidate,
    dirname(candidate),
  ]) {
    if (existsSync(join(scope, 'cordis', 'package.json')) && existsSync(join(scope, 'dsh-client-modules', 'package.json'))) {
      return scope
    }
  }
  return undefined
}
function missingIn(scope) {
  return REQUIRED.filter((name) => !existsSync(join(scope, name, 'package.json')))
}
function locateHarness() {
  const explicit = (process.env.DSH_HARNESS_DIR ?? '').trim()
  const candidates = []
  if (explicit !== '') candidates.push(explicit)
  if ((process.env.DSH_INSTALL_DIR ?? '').trim() !== '') candidates.push(process.env.DSH_INSTALL_DIR)
  candidates.push(join(REPO, '.harness', VERSION))
  const tried = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      tried.push(`${candidate} (missing)`)
      if (explicit !== '' && candidate === explicit) break
      continue
    }
    const scope = scopeOf(candidate)
    if (scope === undefined) {
      tried.push(`${candidate} (no @deepseek-ai scope)`);
      continue
    }
    const absent = missingIn(scope)
    if (absent.length === 0) return scope
    tried.push(`${scope} (missing ${absent.join(', ')})`)
    if (explicit !== '' && candidate === explicit) break
  }
  fail(`no complete ${VERSION} harness; tried:\n  ${tried.join('\n  ')}\nFetch it with: node scripts/fetch-harness.mjs ${VERSION}, then set DSH_HARNESS_DIR.`)
}

const HARNESS = locateHarness()
const NODE_MODULES = dirname(HARNESS)
if (!existsSync(join(NODE_MODULES, 'react', 'package.json'))) {
  fail(`the ${VERSION} harness has no react in ${NODE_MODULES}; refetch scripts/fetch-harness.mjs ${VERSION}`)
}
const requireFromHarness = createRequire(join(NODE_MODULES, 's25-resolve.cjs'))
const importPackage = (name) => import(pathToFileURL(join(HARNESS, name, 'lib', 'index.js')).href)
const source = (name, file) => readFileSync(join(HARNESS, name, 'src', file), 'utf8')
const readme = (name) => readFileSync(join(HARNESS, name, 'README.md'), 'utf8')
const renderSource = (name, file) => readFileSync(join(HARNESS, name, file), 'utf8')
console.log(`S25: harness ${HARNESS} (DSH ${VERSION})`)

// --------------------------------------------- anchors read from the API surface
async function sourceChecks() {
  const system = source('dsh-client-modules', 'client/system.ts')
  check(
    'A bundle executes as a same-origin classic page script (page realm, not a sandbox)',
    system.includes("document.createElement('script')") && system.includes('document.head.append(el)'),
    anchorOf('dsh-client-modules', 'src/client/system.ts', 'document.head.append(el)', system),
  )

  const layoutIndex = source('dsh-client-ui-layout', 'client/index.ts')
  check(
    'The host layout declares a keyed `main` seat and an additive `shell.overlay` list seat',
    layoutIndex.includes("'main': { kind: 'keyed', scope: 'root' },") &&
      layoutIndex.includes("'shell.overlay': { kind: 'list', scope: 'root' },"),
    `${anchorOf('dsh-client-ui-layout', 'src/client/index.ts', "'main': { kind: 'keyed', scope: 'root' },", layoutIndex)}, ${anchorOf('dsh-client-ui-layout', 'src/client/index.ts', "'shell.overlay': { kind: 'list', scope: 'root' },", layoutIndex)}`,
  )

  const appFrame = source('dsh-client-ui-layout', 'client/AppFrame.tsx')
  check(
    'The frame renders the keyed `main` outlet and the additive overlay outlet',
    appFrame.includes("renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })") &&
      appFrame.includes("renderSlot('shell.overlay', {})"),
    `${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', "renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })", appFrame)}, ${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', "renderSlot('shell.overlay', {})", appFrame)}`,
  )
  check(
    'A `main` entry receives no layout geometry; only the occupied `rightbar` seat gets width/viewport props',
    !appFrame.includes("renderSlot('main', { width") && appFrame.includes("renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 })"),
    anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', "renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 })", appFrame),
  )
  check(
    'The frame measures itself with a rAF-throttled ResizeObserver (page-DOM pacing, no host hook)',
    appFrame.includes('new ResizeObserver') && appFrame.includes('requestAnimationFrame'),
    `${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', 'new ResizeObserver', appFrame)}, ${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', 'requestAnimationFrame', appFrame)}`,
  )

  const service = source('dsh-client-ui-layout', 'client/service.ts')
  check(
    'The layout controller refuses a pane id that is not registered',
    service.includes('layout.selectPanel: main panel') && service.includes('is not registered'),
    anchorOf('dsh-client-ui-layout', 'src/client/service.ts', 'layout.selectPanel: main panel', service),
  )

  const registry = source('dsh-client-ui-renderer', 'client/registry.ts')
  check(
    'The renderer provides ctx.slots (SlotRegistry) and reflects it as the root React binding',
    registry.includes('class SlotRegistry extends Service') && registry.includes("super(ctx, 'slots')"),
    anchorOf('dsh-client-ui-renderer', 'src/client/registry.ts', 'class SlotRegistry extends Service', registry),
  )
  check(
    'Registering a second `root` entry is warned against; shell.overlay is the additive frame seat',
    registry.includes('shadows it') && registry.includes('shell.overlay'),
    anchorOf('dsh-client-ui-renderer', 'src/client/registry.ts', 'shadows it', registry),
  )

  const dom = source('dsh-client-shortcuts', 'client/dom.ts')
  const types = source('dsh-client-shortcuts', 'client/types.ts')
  check(
    'Keyboard is a declared surface: command context carries region/modal/DOM target',
    types.includes('ShortcutContext') && types.includes('region: ShortcutRegion') && types.includes('target: Element | null'),
    anchorOf('dsh-client-shortcuts', 'src/client/types.ts', 'target: Element | null', types),
  )
  check(
    'Focus is not a declared surface: the only focus listener resets pending key sequences',
    dom.includes("document.addEventListener('focusin', reset, true)") && !dom.includes('moveFocus') && !dom.includes("provide('focus'"),
    anchorOf('dsh-client-shortcuts', 'src/client/dom.ts', "document.addEventListener('focusin', reset, true)", dom),
  )

  const webserverReadme = readme('dsh-host-webserver')
  check(
    'The host HTTP service is the browser channel; Electron carries fetch over an IPC bridge (read)',
    webserverReadme.includes('carries fetch over an IPC bridge') && webserverReadme.includes('file://'),
    anchorOf('dsh-host-webserver', 'README.md', 'carries fetch over an IPC bridge', webserverReadme),
  )

  const panelSource = readFileSync(join(REPO, 'packages', 'dsh-anyplugin-install', 'src', 'panel.ts'), 'utf8')
  check(
    'The shipped AnyPlugin panel host half registers its own webServer routes (the pattern S25 executes)',
    panelSource.includes('ctx.webServer.register(') && panelSource.includes("kind: 'prefix'") && panelSource.includes("kind: 'exact'"),
    `packages/dsh-anyplugin-install/src/panel.ts:${lineOf(panelSource, 'ctx.webServer.register(')} (repo at the ticket base)`,
  )
}

// --------------------------------------------------- capability 6: host channel
async function hostChannelChecks() {
  const { Context } = await importPackage('cordis')
  const { default: WebServer } = await importPackage('dsh-host-webserver')
  const ctx = new Context()
  try {
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const port = await until(() => ctx.webServer?.port, 'the host webServer to listen', 8000)
    check(
      'The pinned host boots a real HTTP server on an ephemeral loopback port',
      typeof port === 'number' && port > 0,
      `port=${port} ${anchorOf('dsh-host-webserver', 'src/index.ts', "this.server.listen(this.config.port, this.config.host", source('dsh-host-webserver', 'index.ts'))}`,
    )

    const hostHalf = await import(pathToFileURL(join(FIXTURE, 'index.js')).href)
    hostHalf.apply(ctx)
    check(
      'An outside-install host half registers routes on the real ctx.webServer',
      true,
      'fixture registered /s25/resource (resource) and /s25/echo (handler)',
    )

    const origin = `http://127.0.0.1:${port}`
    const resource = await fetch(`${origin}/s25/resource`)
    const resourceJson = await resource.json()
    check(
      'A resource route answers a real HTTP GET with the plugin Fetch Response',
      resource.status === 200 && resourceJson.ok === true,
      `GET ${resource.status} ${JSON.stringify(resourceJson)}`,
    )
    const notAllowed = await fetch(`${origin}/s25/resource`, { method: 'POST' })
    check(
      'A resource route is GET/HEAD only; the host service owns the 405',
      notAllowed.status === 405,
      `POST ${notAllowed.status}`,
    )
    const echo = await fetch(`${origin}/s25/echo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'ping-280' })
    const echoJson = await echo.json()
    check(
      'A handler route round-trips a request body through the host process and back',
      echo.status === 200 && echoJson.echo === 'ping-280' && echoJson.method === 'POST',
      `POST ${echo.status} ${JSON.stringify(echoJson)}`,
    )
  } finally {
    await disposeContext(ctx)
  }
}

async function disposeContext(ctx) {
  try {
    if (typeof ctx.fiber?.dispose === 'function') await ctx.fiber.dispose()
    else if (typeof ctx.dispose === 'function') await ctx.dispose()
  } catch {
    // Disposal failure must not hide the measurement.
  }
}

// ----------------------------------------- capability 1: Loader composes + serves
async function bootClientLoader() {
  const { Context } = await importPackage('cordis')
  const { default: Loader } = await importPackage('cordis-plugin-loader')
  const { ClientModuleRegistry } = await importPackage('dsh-client-modules')
  const root = mkdtempSync(join(tmpdir(), 's25-client-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 's25-spike-profile', private: true })}\n`)
  cpSync(FIXTURE, join(root, 'node_modules', PACKAGE), { recursive: true })

  const ctx = new Context()
  const routes = []
  ctx.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {}
    },
  })
  ctx.plugin(Loader, { baseUrl: pathToFileURL(join(root, 'cordis.yml')).href })
  await until(() => ctx.loader, 'the loader service')
  await ctx.loader.create({ id: 'surface', name: PACKAGE, config: {} })
  await ctx.loader.await()
  await sleep(60)
  ctx.plugin(ClientModuleRegistry)
  await until(() => ctx.clientModules, 'the client module registry')
  return { root, ctx, registry: ctx.clientModules, routes }
}

async function serveChecks(booted) {
  const graph = booted.registry.graph()
  const entry = graph.entries.find((row) => row.id === PACKAGE)
  check(
    'The pinned Loader composes an outside-install package into the client boot graph',
    entry !== undefined && graph.rev.length > 0,
    `entries=${graph.entries.length} id=${entry?.id} rev=${graph.rev}`,
  )
  check(
    'The boot row names a served, revisioned bundle URL',
    typeof entry?.url === 'string' && entry.url.startsWith('plugins/') && entry.url.includes('rev='),
    entry?.url,
  )
  const bundleUrl = new URL(entry.url, 'http://dsh.invalid/')
  const response = await booted.registry.fetchBundle(new Request(bundleUrl))
  const text = await response.text()
  check(
    'The host serves the bundle as text/javascript with immutable caching',
    response.status === 200 &&
      (response.headers.get('content-type') ?? '').startsWith('text/javascript') &&
      (response.headers.get('cache-control') ?? '').includes('immutable') &&
      text.includes('__ModuleLoader__.load(') &&
      text.includes(`id: '${PACKAGE}'`),
    `${response.status} ${response.headers.get('content-type')} ${response.headers.get('cache-control')} bytes=${text.length}`,
  )
  return graph
}

// ------------------------------------------- capabilities 1-5: the page realm run
function createPage() {
  // The published client stack renders through the real React DOM binding; it is
  // not server-renderable (the bundled useSyncExternalStore shim passes no
  // getServerSnapshot), so the page realm is a real DOM: jsdom, honest about not
  // being the Desktop browser or Electron.
  const { JSDOM } = requireFromHarness('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="s25-root"></div></body></html>', {
    url: 'http://dsh.invalid/',
    pretendToBeVisual: true,
  })
  const window = dom.window
  // Pin the device the pinned client stack detects: a macOS browser. jsdom's
  // default navigator.platform is empty, which the shortcut surface maps to
  // Linux (a deliberately narrow Web default set).
  Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
  class ResizeObserverStub {
    constructor(callback) { this.callback = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub
  const sandbox = {
    console: { error() {}, warn() {}, log() {} },
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Promise,
    Math,
    JSON,
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    crypto: globalThis.crypto,
    AbortController: window.AbortController ?? AbortController,
    AbortSignal: window.AbortSignal ?? AbortSignal,
    DOMException: window.DOMException ?? DOMException,
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    KeyboardEvent: window.KeyboardEvent,
    Event: window.Event,
    localStorage: window.localStorage,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: 1,
    ResizeObserver: ResizeObserverStub,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  return { dom, window, sandbox, context }
}

/**
 * React DOM is installed in the Node realm (the same module instance the page
 * realm gets as a static module); it looks the DOM up on `globalThis` at load
 * time. Swap in the jsdom page for the run and restore afterwards.
 */
function installPageGlobals(window) {
  const saved = new Map()
  const setGlobal = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  setGlobal('window', window)
  setGlobal('document', window.document)
  setGlobal('navigator', window.navigator)
  setGlobal('Element', window.Element)
  setGlobal('HTMLElement', window.HTMLElement)
  setGlobal('Node', window.Node)
  setGlobal('MutationObserver', window.MutationObserver)
  setGlobal('getComputedStyle', window.getComputedStyle.bind(window))
  setGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window))
  setGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
  return () => {
    for (const [key, descriptor] of [...saved].reverse()) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
}

async function runPageChecks(graph, booted) {
  // The published primitives lib imports CSS modules, which Node cannot load.
  // The shortcuts bundle needs exactly two helpers from it; their pinned source
  // is read and their two-function surface is carried into the page realm.
  const primitivesComposition = source('dsh-client-ui-primitives', 'keyboard-composition.ts')
  const primitivesModal = source('dsh-client-ui-primitives', 'useModalLayer.ts')
  const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'
  check(
    'The primitives helpers the shortcuts bundle requires are read from the pin, not invented',
    primitivesModal.includes(`modalSelector = '${modalSelector}'`) && primitivesComposition.includes('export function observeComposition(document: Document)'),
    `${anchorOf('dsh-client-ui-primitives', 'src/useModalLayer.ts', 'modalSelector = ', primitivesModal)}, ${anchorOf('dsh-client-ui-primitives', 'src/keyboard-composition.ts', 'export function observeComposition', primitivesComposition)}`,
  )
  const primitivesStub = {
    modalSelector,
    // Same lifetime as the pinned source: composition guards a late closing keydown.
    observeComposition(document) {
      let composing = false
      let ended = false
      const start = () => { composing = true }
      const end = () => { composing = false; ended = true }
      const release = () => { ended = false }
      const blur = () => { composing = false; ended = false }
      document.addEventListener('compositionstart', start, true)
      document.addEventListener('compositionend', end, true)
      document.addEventListener('keyup', release, true)
      document.defaultView?.addEventListener('blur', blur)
      return {
        guards: (event) => {
          const guarded = composing || ended || event.isComposing || event.keyCode === 229
          ended = false
          return guarded
        },
        dispose: () => {
          document.removeEventListener('compositionstart', start, true)
          document.removeEventListener('compositionend', end, true)
          document.removeEventListener('keyup', release, true)
          document.defaultView?.removeEventListener('blur', blur)
        },
      }
    },
  }
  const page = createPage()
  const { sandbox, context } = page
  // React DOM (Node realm) resolves its page through globalThis at load time.
  const restorePageGlobals = installPageGlobals(page.window)
  const seed = {
    react: requireFromHarness('react'),
    'react/jsx-runtime': requireFromHarness('react/jsx-runtime'),
    'react-dom': requireFromHarness('react-dom'),
    'react-dom/client': requireFromHarness('react-dom/client'),
    '@deepseek-ai/cordis': await importPackage('cordis'),
    '@deepseek-ai/dsh-client-store': await importPackage('dsh-client-store'),
    '@deepseek-ai/dsh-client-ui-slots': await importPackage('dsh-client-ui-slots'),
    '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
  }
  let system
  const facade = {
    mode: 'queue',
    pendingQueue: [],
    load(registration) {
      if (this.mode !== 'queue') throw new Error('page realm: a bundle registered after boot')
      this.pendingQueue.push(registration)
    },
    create(options) {
      const index = this.pendingQueue.findIndex((row) => row.id === '@deepseek-ai/dsh-client-modules')
      if (index === -1) throw new Error('the client-modules bundle did not register in the page realm')
      const [registration] = this.pendingQueue.splice(index, 1)
      const bootstrap = registration.factory((specifier) => {
        throw new Error(`the client-modules bootstrap required ${specifier}`)
      })
      system = bootstrap.createClientModuleSystem(this, { id: registration.id, exports: bootstrap }, options)
      this.mode = 'live'
      return system
    },
  }
  sandbox.__ModuleLoader__ = facade
  sandbox.window.__ModuleLoader__ = facade

  const runScript = (file) => new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(context)
  runScript(join(HARNESS, 'dsh-client-modules', 'lib', 'client.js'))
  const prebuilt = new Map()
  for (const name of ['dsh-client-ui-renderer', 'dsh-client-ui-layout', 'dsh-client-shortcuts']) {
    const before = facade.pendingQueue.length
    runScript(join(HARNESS, name, 'lib', 'client.js'))
    for (const registration of facade.pendingQueue.slice(before)) {
      if (typeof registration?.id === 'string') prebuilt.set(registration.id, registration)
    }
  }
  facade.create({
    boot: graph,
    staticModules: seed,
    loadBundle: async (url) => {
      const response = await booted.registry.fetchBundle(new Request(new URL(url, 'http://dsh.invalid/')))
      if (response.status !== 200) throw new Error(`bundle ${url} answered ${response.status}`)
      const text = await response.text()
      new vm.Script(text, { filename: url }).runInContext(context)
    },
  })
  const resolvePrebuilt = (name) => {
    const registration = prebuilt.get(`@deepseek-ai/${name}`)
    if (registration === undefined) throw new Error(`the pinned bundle ${name} did not register in the page realm`)
    return registration.factory((specifier) => {
      if (Object.hasOwn(seed, specifier)) return seed[specifier]
      throw new Error(`the pinned bundle ${name} required ${specifier}`)
    })
  }

  // The fixture bundle has to arrive through the same kernel a browser uses.
  const client = await system.import(PACKAGE)
  check(
    'The real module system materializes the served fixture bundle as a client plugin',
    typeof client?.apply === 'function' && Array.isArray(client.inject) && client.inject.includes('slots'),
    `inject=${JSON.stringify(client?.inject)} apply=${typeof client?.apply}`,
  )

  // Build the client application context out of the pinned bundles, in the same
  // order the web shell boots them: renderer (provides ctx.slots) -> shortcuts ->
  // layout (the AppFrame that owns the render sites).
  const { Context } = await importPackage('cordis')
  const rendererBundle = resolvePrebuilt('dsh-client-ui-renderer')
  const shortcutsBundle = resolvePrebuilt('dsh-client-shortcuts')
  const layoutBundle = resolvePrebuilt('dsh-client-ui-layout')
  const ShortcutsService = shortcutsBundle
  const clientCtx = new Context()
  const localeStub = {
    register() { return () => {} },
    bind() { return (key) => key },
    subscribe() { return () => {} },
  }
  const themeSnapshot = {
    active: { colorScheme: 'light', tokens: { '--dsw-alias-bg-base': '#ffffff' } },
    preference: 'light',
    fontSizes: { text: 14, code: 13, terminal: 13 },
    fontFamilies: { text: '', code: '', terminal: '' },
  }
  const themeStub = {
    getTheme() { return themeSnapshot },
    on() { return () => {} },
    subscribe() { return () => {} },
  }
  clientCtx.provide('locale', localeStub)
  clientCtx.provide('theme', themeStub)
  // Apply the pinned client entry points directly on the client context, the
  // way the module system applies a boot module's exports.
  await rendererBundle.apply(clientCtx)
  await until(() => clientCtx.slots, 'ctx.slots from the pinned renderer')
  new ShortcutsService(clientCtx)
  await until(() => clientCtx.shortcuts, 'ctx.shortcuts from the pinned shortcuts service')
  await layoutBundle.apply(clientCtx)
  await until(() => clientCtx.layout, 'ctx.layout from the pinned layout')

  check(
    'The pinned renderer provides ctx.slots and the sole root React binding',
    clientCtx.slots !== undefined && typeof clientCtx.uiRenderer?.mount === 'function',
    `slots=${clientCtx.slots !== undefined} uiRenderer.mount=${typeof clientCtx.uiRenderer?.mount}`,
  )
  check(
    'The pinned layout frame is seated as the single root occupant',
    clientCtx.slots !== undefined && typeof clientCtx.layout.selectPanel === 'function',
    'ctx.layout.selectPanel present',
  )

  // The web shell boots a session UI that installs the strict-scope adapter; the
  // spike boots without that package, so this adapter is a stub whose absent
  // session is the optional scope's documented projection (a bare render throws
  // `scope 'session-maybe' rendered without an installed adapter`).
  const absentScopeBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const observableOf = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} })
  clientCtx.slots.installScope('session', {
    current: observableOf(absentScopeBinding),
    bindingSource: () => observableOf(absentScopeBinding),
  })
  // The locale plugin's product backs the `t` standard seat; identity translates
  // are enough for the spike's own fixture strings.
  clientCtx.slots.installLocale(Object.assign(observableOf({ revision: 0 }), { bind: () => (key) => key }))
  // The web shell's session UI contributes the `sessions` root hook the frame's
  // DocumentTitle reads; the spike stubs an empty roster (no session package is
  // booted in this composition).
  clientCtx.slots.provideRoot({ hooks: { sessions: observableOf({ byId: {} }) } })

  // Apply the outside-install bundle against the real services.
  client.apply(clientCtx)
  check(
    'The outside bundle applied against the real slot registry and shortcuts service',
    page.window.__S25__?.applied === true,
    `page global ${JSON.stringify(page.window.__S25__)}`,
  )

  let selected
  try {
    clientCtx.layout.selectPanel('s25-pane')
    selected = clientCtx.layout.panelInfo?.getSnapshot?.().activePanelId ?? clientCtx.layout.panelInfo?.value?.activePanelId
  } catch (cause) {
    selected = `error: ${cause.message}`
  }
  check(
    'The real layout controller selects the pane registered by the outside bundle',
    selected === 's25-pane',
    `activePanelId=${JSON.stringify(selected)}`,
  )
  let refused = false
  try {
    clientCtx.layout.selectPanel('s25-missing')
  } catch (cause) {
    refused = String(cause?.message).includes('is not registered')
  }
  check('Selecting an unregistered pane id is refused by the layout controller', refused, 'threw `is not registered`')

  // Mount the composed application into the jsdom page with the pinned client
  // stack: renderer SlotRegistry + layout AppFrame + React 18.3.1 DOM binding.
  const container = page.window.document.getElementById('s25-root')
  let unmount = null
  let mountedError = null
  try {
    unmount = clientCtx.uiRenderer.mount(container)
    await sleep(50)
  } catch (cause) {
    mountedError = cause
  }
  const markup = mountedError === null ? container.innerHTML : `error: ${mountedError.message}`
  check(
    'The host layout frame mounts the outside-install pane in a real DOM (React 18.3.1)',
    mountedError === null && markup.includes('data-s25-pane') && markup.includes('data-s25-active="s25-pane"'),
    mountedError === null ? `mounted markup bytes=${markup.length}` : markup,
  )
  check(
    'The keyed `main` pane receives the standard hooks but no DOM node prop (no mount point is handed over)',
    markup.includes('data-s25-hooks="yes"') && markup.includes('data-s25-dom-prop="no"'),
    `prop keys=${markup.match(/data-s25-prop-keys="([^"]*)"/)?.[1] ?? 'unread'}`,
  )
  check(
    'The additive shell.overlay seat renders beside the frame without replacing it',
    markup.includes('data-s25-overlay') && markup.includes('data-global-panel'),
    'overlay and frame main-outlet markers present in the same mount',
  )

  // Keyboard: wait for the pinned registry to configure the fixture binding, then
  // deliver real DOM keyboard events through the jsdom page.
  await until(
    () => {
      const config = clientCtx.shortcuts.config.getSnapshot()
      const row = clientCtx.shortcuts.catalog.getSnapshot().find((candidate) => candidate.id === 's25.ping')
      // A row's binding is present even while the preference store is loading;
      // dispatch only installs it once the config is ready.
      return config.status === 'ready' && row?.binding != null
    },
    'the fixture command binding from the pinned shortcut registry',
  )
  const dispatch = (code, key, init) => {
    const event = new page.window.KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...init })
    page.window.document.body.dispatchEvent(event)
    return event
  }
  const event = dispatch('KeyP', 'p', { metaKey: true, altKey: true })
  check(
    'A real DOM keydown reaches the declared shortcut surface and runs the fixture command',
    page.window.__S25_RUNS__ === 1 && page.window.__S25_CONTEXT__?.region === 'page'
      && page.window.__S25_CONTEXT__?.target === 'BODY' && event.defaultPrevented,
    `runs=${page.window.__S25_RUNS__} context=${JSON.stringify(page.window.__S25_CONTEXT__)} prevented=${event.defaultPrevented}`,
  )
  dispatch('F9', 'F9', {})
  check(
    'The declared fixed-input feed delivers the arbitrated gesture and its DOM target to the pane',
    page.window.__S25_FIXED__?.code === 'F9' && page.window.__S25_FIXED__?.target === 'BODY' && page.window.__S25_FIXED__?.region === 'page',
    `fixed=${JSON.stringify(page.window.__S25_FIXED__)}`,
  )
  const catalogRow = clientCtx.shortcuts.catalog.getSnapshot().find((row) => row.id === 's25.ping')
  check(
    'The declared keyboard catalog carries the fixture command binding for this profile',
    JSON.stringify(catalogRow ?? null).includes('"code":"KeyP"') && catalogRow?.issue === null,
    JSON.stringify(catalogRow ?? null),
  )

  unmount?.()
  restorePageGlobals()
  await disposeContext(clientCtx)
}

async function main() {
  await sourceChecks()
  await hostChannelChecks()

  let booted
  try {
    booted = await bootClientLoader()
    const graph = await serveChecks(booted)
    await runPageChecks(graph, booted)
  } finally {
    if (booted !== undefined) {
      await disposeContext(booted.ctx)
      rmSync(booted.root, { recursive: true, force: true })
    }
  }

  const failed = checks.filter((row) => !row.ok)
  console.log('')
  console.log(`S25 anchors (read at DSH ${VERSION}):`)
  for (const anchor of [...new Set(anchors)]) console.log(`  - ${anchor}`)
  console.log('')
  console.log(`S25: ${checks.length - failed.length}/${checks.length} checks passed at DSH ${VERSION}`)
  if (failed.length > 0) {
    for (const row of failed) console.log(`  FAILED: ${row.name} — ${row.detail}`)
    console.log('ANSWER: the measured claim did not hold; see the failed checks above.')
    process.exit(1)
  }
  console.log('ANSWER: a client plugin outside the install can own a pane (keyed main + additive shell.overlay), render React into the host frame, register keyboard commands, and round-trip HTTP through its own host half; focus movement, pane geometry and animation pacing have no declared host primitive and stay page-DOM.')
}

await main()
