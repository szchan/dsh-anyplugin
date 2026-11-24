#!/usr/bin/env node
/**
 * S25 — what renderer surface can a DSH client plugin actually reach from a
 * plugin that lives outside the host installation?
 *
 * Pins: DSH 0.2.2-rc.2 (Desktop, extracted tree) and 0.2.2-rc.5 (npm). The
 * spike runs against the fetched harness union at those pins (the same tree CI
 * installs) and reads source anchors out of it. A harness tree whose installed
 * `dsh-host-webserver` version does not match DSH_HARNESS_VERSION is refused, so
 * a run cannot label one pin's tree with another pin's name. It answers, in
 * order:
 *
 *   1. pane / render site  — does the host layout mount a pane registered by
 *      an outside bundle? (`main` keyed seat, `shell.overlay` additive seat)
 *   2. DOM / React mount   — what exactly is handed to the plugin's component,
 *      and what does the element tree it draws do under a real DOM click and a
 *      real focus call?
 *   3. keyboard / focus    — declared command + fixed-input surface; no focus
 *      service exists, focus movement stays page-DOM
 *   4. layout size / resize— only the occupied single seats get geometry props;
 *      a `main`/overlay entry gets none, and page-DOM observers are the fallback
 *   5. animation frames    — page realm only, no host pacing hook
 *   6. main-process channel— the plugin's own host half registers `webServer`
 *      HTTP routes; request/response round trip is executed over real HTTP, and
 *      the plugin client half calls the host half again from the page realm
 *
 * Method: the spike boots the pinned host halves for real (dsh-host-webserver,
 * cordis-plugin-loader + dsh-client-modules), then executes the pinned client
 * bundles in one `node:vm` page realm: the loader's own browser half,
 * dsh-client-ui-renderer (SlotRegistry + root React binding), dsh-client-ui-layout
 * (the AppFrame that owns the render sites) and dsh-client-shortcuts (the
 * declared keyboard surface). The fixture bundle is served through the host
 * `/plugins` route and imported through the real module system; its pane is then
 * selected and mounted into a jsdom page with the pinned React 18.3.1 DOM
 * binding, and it is exercised with real DOM MouseEvent, focus() and
 * KeyboardEvent calls.
 *
 * Not proven here (see README): a real browser/Electron window (script-element
 * injection is the read anchor), the Electron IPC fetch transport, layout
 * geometry inside a real viewport, and rAF pacing observed from plugin code.
 * Those are read from the host API surface, never presented as runs.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connect } from 'node:net'
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
/**
 * A check is either `live` (it executed something) or `read` (it only read the
 * pinned source). The two are counted separately so the summary cannot pass a
 * source read off as a run.
 */
const check = (name, ok, detail, kind = 'live') => {
  checks.push({ name, ok, detail, kind })
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${String(checks.length).padStart(2, '0')}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const readCheck = (name, ok, detail) => check(name, ok, detail, 'read')
async function attempt(name, fn, kind = 'live') {
  try {
    const result = await fn()
    check(name, result.ok === true, result.detail, kind)
  } catch (cause) {
    check(name, false, `threw: ${cause?.message ?? cause}`, kind)
  }
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
/** A raw HTTP request over a real TCP socket, so a listening assertion cannot be faked by a stub port. */
function rawRequest(port, path) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let received = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error(`raw request to 127.0.0.1:${port}${path} timed out`))
    })
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`))
    socket.on('data', (chunk) => { received += chunk })
    socket.on('end', () => resolvePromise(received))
    socket.on('error', reject)
  })
}
const statusLineOf = (raw) => (raw.split('\r\n')[0] ?? '').trim()
const bodyOf = (raw) => raw.slice(raw.indexOf('\r\n\r\n') + 4)

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
// Tree identity: the env label decides which pin the run is claimed against, so
// the tree must actually be that pin. `dsh-host-webserver/package.json` carries
// the installed version and is the first thing this spike boots, so a mismatch
// is refused before any measurement can be labelled with the other pin.
const treeVersion = JSON.parse(readFileSync(join(HARNESS, 'dsh-host-webserver', 'package.json'), 'utf8')).version
if (treeVersion !== VERSION) {
  fail(`DSH_HARNESS_DIR resolves the DSH ${treeVersion} tree at ${HARNESS}, but DSH_HARNESS_VERSION=${VERSION}; fetch the ${VERSION} tree with: node scripts/fetch-harness.mjs ${VERSION}`)
}
const requireFromHarness = createRequire(join(NODE_MODULES, 's25-resolve.cjs'))
const importPackage = (name) => import(pathToFileURL(join(HARNESS, name, 'lib', 'index.js')).href)
const source = (name, file) => readFileSync(join(HARNESS, name, 'src', file), 'utf8')
const readme = (name) => readFileSync(join(HARNESS, name, 'README.md'), 'utf8')
const renderSource = (name, file) => readFileSync(join(HARNESS, name, file), 'utf8')
console.log(`S25: harness ${HARNESS} (DSH ${VERSION}, tree version ${treeVersion})`)

// --------------------------------------------- anchors read from the API surface
async function sourceChecks() {
  const system = source('dsh-client-modules', 'client/system.ts')
  readCheck(
    'A bundle executes as a same-origin classic page script (page realm, not a sandbox)',
    system.includes("document.createElement('script')") && system.includes('document.head.append(el)'),
    anchorOf('dsh-client-modules', 'src/client/system.ts', 'document.head.append(el)', system),
  )

  const layoutIndex = source('dsh-client-ui-layout', 'client/index.ts')
  readCheck(
    'The host layout declares a keyed `main` seat and an additive `shell.overlay` list seat',
    layoutIndex.includes("'main': { kind: 'keyed', scope: 'root' },") &&
      layoutIndex.includes("'shell.overlay': { kind: 'list', scope: 'root' },"),
    `${anchorOf('dsh-client-ui-layout', 'src/client/index.ts', "'main': { kind: 'keyed', scope: 'root' },", layoutIndex)}, ${anchorOf('dsh-client-ui-layout', 'src/client/index.ts', "'shell.overlay': { kind: 'list', scope: 'root' },", layoutIndex)}`,
  )

  const appFrame = source('dsh-client-ui-layout', 'client/AppFrame.tsx')
  readCheck(
    'The frame renders the keyed `main` outlet and the additive overlay outlet',
    appFrame.includes("renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })") &&
      appFrame.includes("renderSlot('shell.overlay', {})"),
    `${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', "renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })", appFrame)}, ${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', "renderSlot('shell.overlay', {})", appFrame)}`,
  )
  readCheck(
    'A `main` entry receives no layout geometry; only the occupied `rightbar` seat gets width/viewport props',
    !appFrame.includes("renderSlot('main', { width") && appFrame.includes("renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 })"),
    anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', "renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 })", appFrame),
  )
  readCheck(
    'The frame measures itself with a rAF-throttled ResizeObserver (page-DOM pacing, no host hook)',
    appFrame.includes('new ResizeObserver') && appFrame.includes('requestAnimationFrame'),
    `${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', 'new ResizeObserver', appFrame)}, ${anchorOf('dsh-client-ui-layout', 'src/client/AppFrame.tsx', 'requestAnimationFrame', appFrame)}`,
  )

  const service = source('dsh-client-ui-layout', 'client/service.ts')
  readCheck(
    'The layout controller refuses a pane id that is not registered',
    service.includes('layout.selectPanel: main panel') && service.includes('is not registered'),
    anchorOf('dsh-client-ui-layout', 'src/client/service.ts', 'layout.selectPanel: main panel', service),
  )

  const registry = source('dsh-client-ui-renderer', 'client/registry.ts')
  readCheck(
    'The renderer provides ctx.slots (SlotRegistry) and reflects it as the root React binding',
    registry.includes('class SlotRegistry extends Service') && registry.includes("super(ctx, 'slots')"),
    anchorOf('dsh-client-ui-renderer', 'src/client/registry.ts', 'class SlotRegistry extends Service', registry),
  )
  readCheck(
    'Registering a second `root` entry is warned against; shell.overlay is the additive frame seat',
    registry.includes('shadows it') && registry.includes('shell.overlay'),
    anchorOf('dsh-client-ui-renderer', 'src/client/registry.ts', 'shadows it', registry),
  )

  const dom = source('dsh-client-shortcuts', 'client/dom.ts')
  const types = source('dsh-client-shortcuts', 'client/types.ts')
  readCheck(
    'Keyboard is a declared surface: command context carries region/modal/DOM target',
    types.includes('ShortcutContext') && types.includes('region: ShortcutRegion') && types.includes('target: Element | null'),
    anchorOf('dsh-client-shortcuts', 'src/client/types.ts', 'target: Element | null', types),
  )
  // Scan every installed client bundle for a `focus` service registration, not
  // one file for three strings: the negative claim is about the declared
  // surface, so it must cover what the pin actually ships.
  const services = []
  const clientPrefix = ['dsh', 'client', ''].join('-')
  for (const name of readdirSync(HARNESS).filter((entry) => entry.startsWith(clientPrefix))) {
    const lib = join(HARNESS, name, 'lib')
    if (!existsSync(lib)) continue
    for (const file of readdirSync(lib, { recursive: true })) {
      if (typeof file !== 'string' || !/\.(js|mjs)$/.test(file)) continue
      const text = readFileSync(join(lib, file), 'utf8')
      for (const match of text.matchAll(/\.provide\(\s*[`'"]([A-Za-z0-9_.:-]+)[`'"]/g)) services.push(match[1])
    }
  }
  const focusServices = [...new Set(services)].filter((name) => /focus/i.test(name))
  readCheck(
    'Focus is not a declared client surface: no installed client bundle provides a focus service',
    dom.includes("document.addEventListener('focusin', reset, true)") && focusServices.length === 0 && services.length > 0,
    anchorOf('dsh-client-shortcuts', 'src/client/dom.ts', "document.addEventListener('focusin', reset, true)", dom) + `; services provided by the installed client bundles: ${JSON.stringify([...new Set(services)].sort())}`,
  )

  const webserverReadme = readme('dsh-host-webserver')
  readCheck(
    'The host HTTP service is the browser channel; Electron carries fetch over an IPC bridge (read)',
    webserverReadme.includes('carries fetch over an IPC bridge') && webserverReadme.includes('file://'),
    anchorOf('dsh-host-webserver', 'README.md', 'carries fetch over an IPC bridge', webserverReadme),
  )

  const panelSource = readFileSync(join(REPO, 'packages', 'dsh-anyplugin-install', 'src', 'panel.ts'), 'utf8')
  readCheck(
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
  const dispose = async () => disposeContext(ctx)
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  let port
  try {
    port = await until(() => ctx.webServer?.port, 'the host webServer to listen', 8000)
  } catch (cause) {
    check('The pinned host boots a listening HTTP server on an ephemeral loopback port (raw TCP 404 envelope)', false, `threw: ${cause?.message ?? cause}`)
    return { origin: undefined, dispose }
  }
  const origin = `http://127.0.0.1:${port}`

  // The port number alone is not evidence that anything listens on it: a real
  // TCP client must receive an HTTP envelope from the socket. No fallback route
  // is registered, so the host owns the 404 for a path the fixture never served.
  await attempt('The pinned host boots a listening HTTP server on an ephemeral loopback port (raw TCP 404 envelope)', async () => {
    const raw = await rawRequest(port, '/s25/not-a-route')
    const statusLine = statusLineOf(raw)
    return {
      ok: Number.isInteger(port) && port > 0 && /^HTTP\/1\.1 404\b/.test(statusLine),
      detail: `port=${port} GET /s25/not-a-route over TCP -> ${statusLine} (${raw.length} bytes) ${anchorOf('dsh-host-webserver', 'src/index.ts', 'this.server.listen(this.config.port, this.config.host', source('dsh-host-webserver', 'index.ts'))}`,
    }
  })

  // Record what the outside host half registers through the real service method,
  // without trusting its return value. The routes are then fetched over the
  // listening socket, so check 15 depends on both the registrations and the
  // server that serves them.
  const originalRegister = ctx.webServer.register
  const registrations = []
  let hostHalfError
  try {
    ctx.webServer.register = function register(route) {
      const disposeRoute = originalRegister.call(this, route)
      registrations.push({
        kind: route?.kind,
        path: route?.path,
        resource: typeof route?.resource,
        handler: typeof route?.handler,
        disposer: typeof disposeRoute,
      })
      return disposeRoute
    }
    const hostHalf = await import(pathToFileURL(join(FIXTURE, 'index.js')).href)
    hostHalf.apply(ctx)
  } catch (cause) {
    hostHalfError = cause
  }
  await attempt('An outside host half registers its routes on the real webServer and they answer on its socket', async () => {
    const registered = hostHalfError === undefined
      && registrations.length === 2
      && registrations.every((route) => route.kind === 'exact' && route.disposer === 'function')
      && registrations.some((route) => route.path === '/s25/resource' && route.resource === 'function' && route.handler === 'undefined')
      && registrations.some((route) => route.path === '/s25/echo' && route.handler === 'function' && route.resource === 'undefined')
    const raw = await rawRequest(port, '/s25/resource')
    const statusLine = statusLineOf(raw)
    const body = bodyOf(raw)
    const served = /^HTTP\/1\.1 200\b/.test(statusLine) && body.includes('"route":"resource"')
    return {
      ok: registered && served,
      detail: hostHalfError === undefined
        ? `registered=${JSON.stringify(registrations)} GET /s25/resource over TCP -> ${statusLine} body~${body.length}b`
        : `host half threw: ${hostHalfError.message}`,
    }
  })

  await attempt('A resource route answers a real HTTP GET with the plugin Fetch Response', async () => {
    const resource = await fetch(`${origin}/s25/resource`)
    const resourceJson = await resource.json()
    return { ok: resource.status === 200 && resourceJson.ok === true, detail: `GET ${resource.status} ${JSON.stringify(resourceJson)}` }
  })
  await attempt('A resource route is GET/HEAD only; the host service owns the 405', async () => {
    const notAllowed = await fetch(`${origin}/s25/resource`, { method: 'POST' })
    return { ok: notAllowed.status === 405, detail: `POST ${notAllowed.status}` }
  })
  await attempt('A handler route round-trips a request body through the host process and back', async () => {
    const echo = await fetch(`${origin}/s25/echo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'ping-280' })
    const echoJson = await echo.json()
    return { ok: echo.status === 200 && echoJson.echo === 'ping-280' && echoJson.method === 'POST', detail: `POST ${echo.status} ${JSON.stringify(echoJson)}` }
  })
  return { origin, dispose }
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
function createPage(hostOrigin) {
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
  // jsdom has no fetch. The fixture client half still calls fetch itself; the
  // realm's fetch is Node's real implementation bridged into the page, so the
  // request crosses the same loopback socket the host half listens on. The
  // Electron IPC transport for fetch is read, not exercised (see README).
  const pageFetch = (input, init) => fetch(input instanceof URL ? input.href : input, init)
  window.__S25_HOST_ORIGIN__ = hostOrigin
  window.fetch = pageFetch
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
    fetch: pageFetch,
    Headers,
    Request,
    Response,
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
    MouseEvent: window.MouseEvent,
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

/**
 * Load the real pinned primitives helper sources instead of a hand-written copy.
 * The compiled primitives lib cannot be imported as a whole (48 CSS-module
 * imports and dependencies the harness union does not install), but the two
 * helpers the shortcuts bundle consumes are authored TypeScript with no CSS
 * imports; Node 24's type stripping loads them when they live outside
 * `node_modules`. `node_modules` is symlinked to the pin so `react` and
 * `./focus.ts` resolve to the pinned tree.
 */
async function loadPinnedPrimitivesHelpers() {
  const root = mkdtempSync(join(tmpdir(), 's25-helpers-'))
  for (const file of ['keyboard-composition.ts', 'useModalLayer.ts', 'focus.ts']) {
    writeFileSync(join(root, file), readFileSync(join(HARNESS, 'dsh-client-ui-primitives', 'src', file), 'utf8'))
  }
  symlinkSync(NODE_MODULES, join(root, 'node_modules'), 'dir')
  const keyboard = await import(pathToFileURL(join(root, 'keyboard-composition.ts')).href)
  const modal = await import(pathToFileURL(join(root, 'useModalLayer.ts')).href)
  return { root, modalSelector: modal.modalSelector, observeComposition: keyboard.observeComposition }
}

async function runPageChecks(graph, booted, host) {
  // The compiled primitives lib imports CSS modules, which Node cannot load, so
  // the module seed is the two real helper functions below (a partial module:
  // the rest of primitives is not loaded by this spike). The pinned declared
  // source is a read; the loaded behaviour is a live check.
  const primitivesComposition = source('dsh-client-ui-primitives', 'keyboard-composition.ts')
  const primitivesModal = source('dsh-client-ui-primitives', 'useModalLayer.ts')
  readCheck(
    'The pinned primitives source declares the two helpers the shortcuts bundle requires',
    primitivesModal.includes('export const modalSelector = ') &&
      primitivesModal.includes("from './keyboard-composition.ts'") &&
      primitivesComposition.includes('export function observeComposition(document: Document)') &&
      primitivesComposition.includes('compositionstart'),
    `${anchorOf('dsh-client-ui-primitives', 'src/useModalLayer.ts', 'export const modalSelector = ', primitivesModal)}, ${anchorOf('dsh-client-ui-primitives', 'src/keyboard-composition.ts', 'export function observeComposition', primitivesComposition)}`,
  )

  let helpers
  try {
    helpers = await loadPinnedPrimitivesHelpers()
  } catch (cause) {
    check('The real pinned primitives helpers load from the pin', false, `threw: ${cause?.message ?? cause}`)
  }

  const page = createPage(host.origin)
  const { sandbox, context } = page
  // React DOM (Node realm) resolves its page through globalThis at load time.
  const restorePageGlobals = installPageGlobals(page.window)

  // The helpers are exercised inside the page realm, against the same document
  // instance the pinned shortcuts bundle will observe.
  if (helpers !== undefined) {
    await attempt('The real pinned primitives helpers behave in the page realm (composition guard + modal selector)', async () => {
      const document = page.window.document
      const modalProbe = document.createElement('div')
      modalProbe.setAttribute('role', 'dialog')
      modalProbe.setAttribute('aria-modal', 'true')
      const menuProbe = document.createElement('div')
      menuProbe.setAttribute('role', 'menu')
      document.body.append(modalProbe, menuProbe)
      try {
        const matches = [...document.querySelectorAll(helpers.modalSelector)]
        const guard = helpers.observeComposition(document)
        document.dispatchEvent(new page.window.Event('compositionstart'))
        const during = guard.guards(new page.window.KeyboardEvent('keydown', { code: 'KeyP', key: 'p' }))
        document.dispatchEvent(new page.window.Event('compositionend'))
        document.dispatchEvent(new page.window.KeyboardEvent('keyup', { code: 'KeyP', key: 'p' }))
        const after = guard.guards(new page.window.KeyboardEvent('keydown', { code: 'KeyP', key: 'p' }))
        guard.dispose()
        return {
          ok: matches.length === 2 && matches[0] === modalProbe && matches[1] === menuProbe && during === true && after === false && String(helpers.observeComposition).includes('compositionstart'),
          detail: `modalSelector matched ${matches.length} probe nodes in order; composition guard ${during} then ${after}`,
        }
      } finally {
        modalProbe.remove()
        menuProbe.remove()
      }
    })
  }

  const seed = {
    react: requireFromHarness('react'),
    'react/jsx-runtime': requireFromHarness('react/jsx-runtime'),
    'react-dom': requireFromHarness('react-dom'),
    'react-dom/client': requireFromHarness('react-dom/client'),
    '@deepseek-ai/cordis': await importPackage('cordis'),
    '@deepseek-ai/dsh-client-store': await importPackage('dsh-client-store'),
    '@deepseek-ai/dsh-client-ui-slots': await importPackage('dsh-client-ui-slots'),
  }
  if (helpers !== undefined) {
    seed['@deepseek-ai/dsh-client-ui-primitives'] = {
      modalSelector: helpers.modalSelector,
      observeComposition: helpers.observeComposition,
    }
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
    'The pinned renderer provides ctx.slots as its SlotRegistry service with the uiRenderer mount face',
    clientCtx.slots?.constructor?.name === 'SlotRegistry' &&
      typeof clientCtx.slots?.register === 'function' &&
      typeof clientCtx.slots?.inject === 'function' &&
      typeof clientCtx.slots?.entries === 'function' &&
      typeof clientCtx.uiRenderer?.mount === 'function',
    `slots=${clientCtx.slots?.constructor?.name} register/inject/entries=${typeof clientCtx.slots?.register}/${typeof clientCtx.slots?.inject}/${typeof clientCtx.slots?.entries} uiRenderer.mount=${typeof clientCtx.uiRenderer?.mount}`,
  )
  const rootEntries = clientCtx.slots.entries('root')
  const rootOccupant = rootEntries[0]?.component
  check(
    'The pinned layout frame is seated as the single root occupant',
    rootEntries.length === 1 && typeof rootOccupant === 'function' && rootOccupant.name === 'AppFrame',
    `root entries=${rootEntries.length} occupant=${rootOccupant?.name ?? typeof rootOccupant}`,
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
  // Read the registrations back from the real registry instead of a fixture-set
  // flag: this is what the pane seat and overlay seat actually hold.
  const mainEntries = clientCtx.slots.entries('main')
  const overlayEntries = clientCtx.slots.entries('shell.overlay')
  const paneEntry = mainEntries.find((entry) => entry?.options?.key === 's25-pane')
  const overlayEntry = overlayEntries.find((entry) => entry?.options?.id === 's25-overlay')
  check(
    "The outside bundle's pane and overlay registrations are read back from the real slot registry",
    paneEntry !== undefined &&
      overlayEntry !== undefined &&
      clientCtx.slots.getVersion('main') > 0 &&
      clientCtx.slots.getVersion('shell.overlay') > 0,
    `main=[${mainEntries.map((entry) => entry?.options?.key ?? '?').join(',')}] overlay=[${overlayEntries.map((entry) => entry?.options?.id ?? '?').join(',')}] versions=${clientCtx.slots.getVersion('main')}/${clientCtx.slots.getVersion('shell.overlay')}`,
  )

  // The plugin client half calls fetch itself; the page realm's fetch is Node's
  // real one bridged in, so the request leaves the page realm over a socket and
  // the plugin's own host half answers it.
  await attempt('The plugin client half fetches its own host-half route from the page realm', async () => {
    const settled = await until(() => {
      const value = page.window.__S25_CLIENT_FETCH__
      return value !== undefined && value.state !== 'pending' ? value : undefined
    }, 'the client-half fetch to settle', 8000)
    return {
      ok: settled.state === 'done' && settled.status === 200 && settled.body?.ok === true && settled.body?.route === 'resource' && settled.via === 'page-realm',
      detail: JSON.stringify(settled),
    }
  })

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
    // Observed condition, not a fixed sleep: the frame and the outside pane have
    // both mounted.
    await until(
      () => container.querySelector('[data-s25-pane]') !== null && container.querySelector('[data-global-panel]') !== null,
      'the host frame and the outside pane to mount',
      8000,
    )
  } catch (cause) {
    mountedError = cause
  }
  const markup = mountedError === null ? container.innerHTML : ''
  check(
    'The host layout frame mounts the outside-install pane in a real DOM (React 18.3.1)',
    mountedError === null && container.querySelector('[data-s25-pane]') !== null && container.querySelector('[data-s25-active="s25-pane"]') !== null,
    mountedError === null ? `mounted markup bytes=${markup.length}` : `threw: ${mountedError.message}`,
  )

  // The pane's own element tree: container > text, button, input. The structure
  // is read from the live DOM, not from markers the fixture prints.
  const pane = container.querySelector('[data-s25-pane]')
  const tree = pane?.querySelector('[data-s25-container]')
  const treeChildren = tree === undefined || tree === null ? [] : [...tree.children]
  const shape = treeChildren
    .map((element) => `${element.tagName}${['data-s25-text', 'data-s25-button', 'data-s25-input'].map((marker) => (element.hasAttribute(marker) ? `[${marker}]` : '')).join('')}`)
    .join(' > ')
  check(
    'The keyed main pane draws a foreign element tree (container > text, button, input) with real markup bytes',
    shape === 'SPAN[data-s25-text] > BUTTON[data-s25-button] > INPUT[data-s25-input]' &&
      treeChildren[0]?.textContent === 'S25 pane text' &&
      treeChildren[1]?.textContent === 'S25 button' &&
      treeChildren[2]?.tagName === 'INPUT' &&
      markup.length > 200,
    `bytes=${markup.length} shape=${shape || '(none)'}`,
  )

  const beforeClick = page.window.__S25_PANE__?.renders ?? 0
  await attempt("A real DOM click dispatched at the pane's button runs its React handler and commits state", async () => {
    const button = container.querySelector('[data-s25-button]')
    if (button === null) throw new Error('the pane button was not mounted')
    const event = new page.window.MouseEvent('click', { bubbles: true, cancelable: true })
    const dispatched = button.dispatchEvent(event)
    await until(() => container.querySelector('[data-s25-pane]')?.getAttribute('data-s25-clicks') === '1', 'the click to commit a React state update', 8000)
    const clicks = container.querySelector('[data-s25-pane]')?.getAttribute('data-s25-clicks')
    const afterClick = page.window.__S25_PANE__?.renders ?? 0
    return {
      ok: clicks === '1' && afterClick > beforeClick,
      detail: `clicks=${clicks} renders ${beforeClick} -> ${afterClick} dispatched=${dispatched}`,
    }
  })

  await attempt('A real focus call lands on the pane input and its React focus handler runs', async () => {
    const input = container.querySelector('[data-s25-input]')
    if (input === null) throw new Error('the pane input was not mounted')
    let sawFocus = false
    input.addEventListener('focus', () => { sawFocus = true }, { once: true })
    input.focus()
    const active = page.window.document.activeElement
    await until(() => container.querySelector('[data-s25-pane]')?.getAttribute('data-s25-focused') === 'yes', 'the input focus to commit a React state update', 8000)
    const paneFocused = container.querySelector('[data-s25-pane]')?.getAttribute('data-s25-focused')
    return {
      ok: active === input && sawFocus && paneFocused === 'yes',
      detail: `activeElement=${active?.tagName ?? 'none'} focusEvent=${sawFocus} paneFocused=${paneFocused}`,
    }
  })

  const paneState = page.window.__S25_PANE__
  const propAllowlist = ['children', 'renderFactorySlot', 'usePanelInfo', 'useSessions']
  const unknownProps = (paneState?.propKeys ?? []).filter((key) => !propAllowlist.includes(key))
  check(
    'The pane receives only the standard hooks/props and no DOM node prop (no mount point is handed over)',
    Array.isArray(paneState?.propKeys) && paneState.propKeys.includes('usePanelInfo') && unknownProps.length === 0 && paneState.domProp === false,
    `prop keys=${JSON.stringify(paneState?.propKeys)} unknown=${JSON.stringify(unknownProps)} anyNodeOrElement=${paneState?.domProp}`,
  )

  const overlay = container.querySelector('[data-s25-overlay]')
  const frameOutlet = container.querySelector('[data-global-panel]')
  const outsidePane = container.querySelector('[data-s25-pane]')
  check(
    'The additive shell.overlay seat renders beside the frame without replacing it',
    overlay !== null && frameOutlet !== null && outsidePane !== null && !overlay.contains(outsidePane),
    `overlay=${overlay !== null} frameOutlet=${frameOutlet !== null} pane=${outsidePane !== null}`,
  )
  check(
    'The mounted frame runs on the React version both pins resolve (18.3.1)',
    seed.react?.version === '18.3.1' && seed['react-dom']?.version === '18.3.1',
    `react=${seed.react?.version} react-dom=${seed['react-dom']?.version}`,
  )

  // Keyboard: wait for the pinned registry to configure the fixture binding, then
  // deliver real DOM keyboard events through the jsdom page. A missing
  // registration is reported as red checks, not as an abort.
  let shortcutsReady = true
  try {
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
  } catch {
    shortcutsReady = false
  }
  const dispatch = (code, key, init) => {
    const event = new page.window.KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...init })
    page.window.document.body.dispatchEvent(event)
    return event
  }
  const event = dispatch('KeyP', 'p', { metaKey: true, altKey: true })
  check(
    'A real DOM keydown reaches the declared shortcut surface and runs the fixture command',
    shortcutsReady && page.window.__S25_RUNS__ === 1 && page.window.__S25_CONTEXT__?.region === 'page'
      && page.window.__S25_CONTEXT__?.target === 'BODY' && event.defaultPrevented,
    `bindingReady=${shortcutsReady} runs=${page.window.__S25_RUNS__} context=${JSON.stringify(page.window.__S25_CONTEXT__)} prevented=${event.defaultPrevented}`,
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

  await attempt('Unmounting the composed root empties the mount container', async () => {
    if (typeof unmount !== 'function') throw new Error('the mount did not return an unmount function')
    unmount()
    await until(() => container.innerHTML === '', 'the mount container to empty on unmount', 8000)
    return { ok: container.innerHTML === '', detail: `container bytes after unmount=${container.innerHTML.length}` }
  })

  restorePageGlobals()
  if (helpers !== undefined) rmSync(helpers.root, { recursive: true, force: true })
  await disposeContext(clientCtx)
}

async function main() {
  await sourceChecks()
  const host = await hostChannelChecks()

  let booted
  try {
    booted = await bootClientLoader()
    const graph = await serveChecks(booted)
    await runPageChecks(graph, booted, host)
  } finally {
    if (booted !== undefined) {
      await disposeContext(booted.ctx)
      rmSync(booted.root, { recursive: true, force: true })
    }
    await host.dispose()
  }

  const failed = checks.filter((row) => !row.ok)
  const reads = checks.filter((row) => row.kind === 'read').length
  const live = checks.length - reads
  console.log('')
  console.log(`S25 anchors (read at DSH ${VERSION}):`)
  for (const anchor of [...new Set(anchors)]) console.log(`  - ${anchor}`)
  console.log('')
  console.log(`S25: ${checks.length - failed.length}/${checks.length} checks passed at DSH ${VERSION} (${reads} source reads + ${live} executing checks)`)
  if (failed.length > 0) {
    for (const row of failed) console.log(`  FAILED: #${checks.indexOf(row) + 1} ${row.name} — ${row.detail}`)
    console.log('ANSWER: the measured claim did not hold; see the failed checks above.')
    process.exit(1)
  }
  console.log('ANSWER: a client plugin outside the install can own a pane (keyed main + additive shell.overlay), mount a React element tree (container/text/button/input) into the host frame whose real DOM click and focus handlers run, register keyboard commands, and round-trip HTTP through its own host half — including a fetch call the plugin client half makes from the page realm; focus movement, pane geometry and animation pacing have no declared host primitive and stay page-DOM.')
}

try {
  await main()
} catch (cause) {
  const failed = checks.filter((row) => !row.ok)
  console.log('')
  console.log(`S25: aborted by an unexpected error: ${cause?.stack ?? cause}`)
  console.log(`S25: ${checks.length - failed.length}/${checks.length} recorded checks passed before the abort at DSH ${VERSION}`)
  process.exit(1)
}
