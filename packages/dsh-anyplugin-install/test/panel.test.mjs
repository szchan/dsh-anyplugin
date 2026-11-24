// The panel's whole claim: a profile's foreign plugins are listed from the
// lock, an install goes through the *same* lifecycle API as the CLI, and the
// client half really is a `dsh.client` bundle the host's module system serves.
//
// Two halves, two proofs:
//
// - server: boot the panel plugin against a probe `webServer`, call the routes
//   it registers, install `fixtures/claude-skills-only` through the published
//   `dsh-anyplugin/install` export, and check the lock, the layers, the typed
//   refusals and the method rules. A client-supplied `scope`/`grants` must not
//   change the written layer.
// - client: boot the pinned `Loader` + `ClientModuleRegistry`, let it compose
//   the root package's `dsh.client` row, run the harness's real browser half
//   in a `vm`, import the served bundle through it, and render the registered
//   component against a `fetch` that calls the server half's own dispatch.
//
// Visual Electron pixels are out of scope (S21 records the same limit); this
// test proves the handshake and the data, not a screenshot.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

import { readEnablements, readInstalls } from '../../dsh-anyplugin-install/src/index.ts'
import { harnessSkipReason, resolveHarness } from '../../dsh-anyplugin-conformance/src/harness.ts'

const REPO = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const FIXTURE = join(REPO, 'fixtures', 'claude-skills-only')
const ID = 'claude-code:skills-only'
const PREFIX = '/anyplugin'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, label, timeoutMs = 5000) => {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

/**
 * A profile-shaped temp root. The repo is linked as the published
 * `dsh-anyplugin` package and imported from its built `lib/`. The panel is part
 * of that same artifact (D77), so there is no second package to copy, and the
 * server half's `dsh-anyplugin/install` self-reference resolves through the
 * manifest's `exports` map.
 */
function makeBox() {
  const root = mkdtempSync(join(tmpdir(), 'anyplugin-panel-'))
  const home = join(root, 'home')
  const project = join(root, 'workspace')
  const empty = join(root, 'empty')
  for (const dir of [home, project, empty]) mkdirSync(dir, { recursive: true })
  const nodeModules = join(root, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  symlinkSync(REPO, join(nodeModules, 'dsh-anyplugin'), 'dir')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'anyplugin-panel-test', private: true })}\n`)
  return {
    root,
    home,
    project,
    empty,
    installs: join(home, 'anyplugin', 'installs.yml'),
    entry: join(nodeModules, 'dsh-anyplugin', 'lib', 'index.js'),
  }
}

async function loadPanel(box) {
  // The built entry, not the TypeScript source: Node refuses to strip types
  // under node_modules, and this is the artifact a profile would import.
  return import(pathToFileURL(box.entry).href)
}

function mountServer(apply, config) {
  const routes = []
  const disposers = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  }
  const ctx = {
    webServer,
    effect(setup) {
      disposers.push(setup())
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  apply(ctx, config)
  return { routes, ctx }
}

function streamRequest(method, url, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  stream.method = method
  stream.url = url
  const merged = body === undefined ? {} : { 'content-type': 'application/json' }
  // A real HTTP/1.1 request always carries Host; the panel's loopback gate
  // reads it, so the probe supplies the same default a browser would.
  merged.host = '127.0.0.1:4123'
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete merged[name]
    else merged[name] = value
  }
  stream.headers = merged
  return stream
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body)
    },
  }
}

async function callHandler(handler, method, url, body, headers = {}) {
  const response = fakeResponse()
  await handler(streamRequest(method, url, body, headers), response)
  let json
  try {
    json = JSON.parse(response.body.toString('utf8'))
  } catch {
    json = undefined
  }
  return { status: response.status, headers: response.headers, json, body: response.body }
}

function hookRuntime() {
  const states = []
  let index = 0
  let effects = []
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        states[slot] = typeof next === 'function' ? next(states[slot]) : next
      }
      return [states[slot], set]
    },
    useEffect(effect) {
      effects.push(effect)
    },
  }
  const render = (component, runEffects = false) => {
    index = 0
    effects = []
    const tree = component()
    if (runEffects) for (const effect of effects) effect()
    return tree
  }
  return { react, render }
}

function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object' && 'type' in node) {
    flatten(node.children ?? [], out)
    return out
  }
  out.push(String(node))
  return out
}

const textOf = (tree) => flatten(tree).join(' ')

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if ('type' in node && predicate(node)) out.push(node)
  findAll(node.children ?? [], predicate, out)
  return out
}

/**
 * The browser shell S21 proved: the page's `window.__ModuleLoader__` queue, the
 * harness's own client bundle, and a `loadBundle` that fetches through the host
 * route. The only extra here is a React with hooks, because the panel is real.
 */
async function browser(harnessDir, registry, graph, seed) {
  const document = {
    createElement: () => ({ set src(_) {}, set async(_) {}, addEventListener() {}, remove() {} }),
    head: { append() {} },
    querySelectorAll: () => [],
  }
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    setTimeout,
    clearTimeout,
    Promise,
    document,
    // The panel calls the page's `fetch`; the test stubs it in the host realm
    // after boot, so the vm delegate must look it up at call time.
    fetch: (...args) => globalThis.fetch(...args),
  }
  sandbox.window = sandbox
  const context = vm.createContext(sandbox)
  let system
  const facade = {
    mode: 'queue',
    pendingQueue: [],
    load(registration) {
      this.pendingQueue.push(registration)
    },
    create(options) {
      const index = this.pendingQueue.findIndex((row) => row.id === '@deepseek-ai/dsh-client-modules')
      if (index === -1) throw new Error('the client-modules bundle did not register')
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
  const modulesBundle = join(harnessDir, 'dsh-client-modules', 'lib', 'client.js')
  new vm.Script(readFileSync(modulesBundle, 'utf8'), { filename: modulesBundle }).runInContext(context)
  facade.create({
    boot: graph,
    staticModules: seed,
    loadBundle: async (url) => {
      const response = await registry.fetchBundle(new Request(new URL(url, 'http://dsh.invalid/')))
      if (response.status !== 200) throw new Error(`bundle ${url} answered ${response.status}`)
      new vm.Script(await response.text(), { filename: url }).runInContext(context)
    },
  })
  return { import: (specifier) => system.import(specifier) }
}

test('server half lists the lock and installs through the published lifecycle API', async (t) => {
  const box = makeBox()
  t.after(() => rmSync(box.root, { recursive: true, force: true }))
  const panel = await loadPanel(box)
  const config = { installs: box.installs, home: box.home, projectDir: box.project }
  const { routes, ctx } = mountServer(panel.applyPanel, config)
  t.after(() => ctx.dispose())

  const listRoute = routes.find((route) => route.kind === 'prefix' && route.path === PREFIX)
  const installRoute = routes.find((route) => route.kind === 'exact' && route.path === `${PREFIX}/install`)
  assert.ok(listRoute, 'the panel registers the /anyplugin prefix')
  assert.ok(installRoute, 'the panel registers the POST install route')

  const empty = await listRoute.resource(new Request(`http://127.0.0.1${PREFIX}/installs`))
  assert.equal(empty.status, 200)
  assert.deepEqual(await empty.json(), { ok: true, file: box.installs, plugins: [] })

  // The install body carries a scope and a grant the panel must ignore: the
  // client is not allowed to choose either (D49: the install writes what the
  // CLI's defaults choose, and grants are the trust store's).
  const installed = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE, scope: 'project', grants: ['mod:evil'], dialect: 'codex' }),
  )
  assert.equal(installed.status, 200, JSON.stringify(installed.json))
  assert.equal(installed.json.ok, true)
  assert.equal(installed.json.plugin, ID)
  assert.equal(installed.json.action, 'added')
  assert.equal(installed.json.enablement.scope, 'user')

  const lock = readInstalls(box.installs)
  assert.equal(lock.plugins.length, 1)
  assert.equal(lock.plugins[0].name, 'skills-only')
  const layers = readEnablements({ projectDir: box.project, home: box.home })
  assert.equal(layers.user?.plugins[ID]?.enabled, true, 'the user layer enables the install')
  assert.equal(layers.project, undefined, 'a client-sent scope did not write a project layer')

  const listed = await listRoute.resource(new Request(`http://127.0.0.1${PREFIX}/installs`))
  assert.equal(listed.status, 200)
  const body = await listed.json()
  assert.equal(body.plugins.length, 1)
  assert.equal(body.plugins[0].id, ID)
  assert.equal(body.plugins[0].dialect, 'claude-code')
  assert.equal(body.plugins[0].version, '0.0.1')
  assert.equal(body.plugins[0].enabled, true)
  assert.equal(body.plugins[0].scope, 'user')

  // A refusal is the lifecycle API's typed refusal, and it must not touch the
  // lock bytes (the panel does not write on a path it could not install).
  const before = readFileSync(box.installs)
  const refused = await callHandler(installRoute.handler, 'POST', `${PREFIX}/install`, JSON.stringify({ path: box.empty }))
  assert.equal(refused.status, 400)
  assert.equal(refused.json.ok, false)
  assert.equal(typeof refused.json.code, 'string')
  assert.equal(typeof refused.json.reason, 'string')
  assert.deepEqual(readFileSync(box.installs), before, 'a refused install left installs.yml untouched')

  // The install mutation is browser-reachable: a cross-site page must not be
  // able to use it as a blind write, and a CORS-safelisted text/plain body must
  // not slip past a JSON check.
  const beforeGuards = readFileSync(box.installs)
  const crossSite = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' },
  )
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.code, 'cross-origin')
  assert.deepEqual(readFileSync(box.installs), beforeGuards, 'a cross-origin install wrote nothing')
  assert.equal(crossSite.headers.connection, 'close', 'a refused mutation closes the connection')

  // DNS rebinding: the page has its own name in Host *and* Origin, so an
  // own-origin comparison alone would pass. The Host gate refuses the name.
  const rebound = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { host: 'evil.example:4123', origin: 'http://evil.example:4123', 'sec-fetch-site': 'same-origin' },
  )
  assert.equal(rebound.status, 403)
  assert.equal(rebound.json.code, 'host-not-allowed')
  assert.deepEqual(readFileSync(box.installs), beforeGuards, 'a rebound install wrote nothing')

  const reboundRead = await listRoute.resource(
    new Request('http://127.0.0.1' + PREFIX + '/installs', {
      headers: { host: 'evil.example:4123', origin: 'http://evil.example:4123' },
    }),
  )
  assert.equal(reboundRead.status, 403, 'the read route has the same host gate')
  assert.equal((await reboundRead.json()).code, 'host-not-allowed')

  const plain = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { 'content-type': 'text/plain' },
  )
  assert.equal(plain.status, 415)
  assert.equal(plain.json.code, 'unsupported-media-type')

  const untyped = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { 'content-type': null },
  )
  assert.equal(untyped.status, 415)
  assert.equal(untyped.json.code, 'unsupported-media-type')

  const crossSiteNoOrigin = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { 'sec-fetch-site': 'cross-site' },
  )
  assert.equal(crossSiteNoOrigin.status, 403)

  const sameOrigin = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { host: '127.0.0.1:4123', origin: 'http://127.0.0.1:4123' },
  )
  assert.equal(sameOrigin.status, 200, JSON.stringify(sameOrigin.json))
  assert.equal(sameOrigin.json.action, 'unchanged')

  // A trailing dot is legal in a Host header; without normalization it would
  // be a false 403 on an otherwise loopback request.
  const dotted = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { host: '127.0.0.1.:4123', origin: 'http://127.0.0.1:4123' },
  )
  assert.equal(dotted.status, 200, JSON.stringify(dotted.json))

  const ipv6 = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { host: '[::1]:4123', origin: 'http://[::1]:4123' },
  )
  assert.equal(ipv6.status, 200, JSON.stringify(ipv6.json))

  const localhost = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { host: 'localhost:4123', origin: 'http://localhost:4123' },
  )
  assert.equal(localhost.status, 200, JSON.stringify(localhost.json))

  // A non-loopback name is refused unless the plugin explicitly lists it.
  const nonLoopback = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    JSON.stringify({ path: FIXTURE }),
    { host: 'dev.internal:4123', origin: 'http://dev.internal:4123' },
  )
  assert.equal(nonLoopback.status, 403)
  assert.equal(nonLoopback.json.code, 'host-not-allowed')

  const allowedConfig = { ...config, allowedHosts: ['dev.internal'] }
  const allowed = await panel.dispatchPanel(
    new Request('http://127.0.0.1' + PREFIX + '/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'dev.internal:4123', origin: 'http://dev.internal:4123' },
      body: JSON.stringify({ path: FIXTURE }),
    }),
    allowedConfig,
  )
  assert.equal(allowed.status, 200, JSON.stringify(await allowed.clone().json()))
  const allowedRead = await panel.dispatchPanel(
    new Request('http://127.0.0.1' + PREFIX + '/installs', { headers: { host: 'dev.internal:4123' } }),
    allowedConfig,
  )
  assert.equal(allowedRead.status, 200)

  // The declared length rejects an oversized body before the body stream is
  // even touched; the chunked path is cancelled while streaming, counting
  // bytes rather than UTF-16 units. Both use a duck-typed request so the test
  // measures the panel's reader, not undici's own pump.
  let bodyReads = 0
  const declaredRequest = {
    url: `http://127.0.0.1${PREFIX}/install`,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'content-length': String(70 * 1024) }),
    get body() {
      bodyReads += 1
      return null
    },
  }
  const declaredResponse = await panel.dispatchPanel(declaredRequest)
  assert.equal(declaredResponse.status, 413)
  assert.equal(bodyReads, 0, 'the declared-length path never touched the body')

  let chunkedReads = 0
  let chunkedCancelled = 0
  const chunk = Buffer.from('€'.repeat(8000)) // 24,000 bytes, 8,000 UTF-16 units
  const chunkedRequest = {
    url: `http://127.0.0.1${PREFIX}/install`,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      getReader() {
        return {
          async read() {
            chunkedReads += 1
            return chunkedReads > 100 ? { done: true, value: undefined } : { done: false, value: chunk }
          },
          async cancel() {
            chunkedCancelled += 1
          },
        }
      },
    },
  }
  const chunkedResponse = await panel.dispatchPanel(chunkedRequest)
  assert.equal(chunkedResponse.status, 413)
  assert.ok(chunkedReads <= 3, `the chunked body was cancelled early (reads: ${chunkedReads})`)
  assert.equal(chunkedCancelled, 1, 'the over-limit stream was cancelled')

  // Through the node handler the refused request gets Connection: close, so
  // the client does not keep a body in flight against a response already sent.
  const oversize = await callHandler(
    installRoute.handler,
    'POST',
    `${PREFIX}/install`,
    'x'.repeat(70 * 1024),
    { 'content-length': String(70 * 1024) },
  )
  assert.equal(oversize.status, 413)
  assert.equal(oversize.headers.connection, 'close')

  // projectDir is the profile's workspace: a committed project layer can
  // disable the plugin, and the panel reports that decision, not the user one.
  mkdirSync(join(box.project, '.dsh'), { recursive: true })
  writeFileSync(join(box.project, '.dsh', 'anyplugin.yml'), 'plugins:\n  claude-code:skills-only: { enabled: false }\n')
  const overridden = await listRoute.resource(new Request(`http://127.0.0.1${PREFIX}/installs`))
  const overriddenBody = await overridden.json()
  assert.equal(overriddenBody.plugins[0].enabled, false)
  assert.equal(overriddenBody.plugins[0].scope, 'project')
  rmSync(join(box.project, '.dsh'), { recursive: true, force: true })

  // A 200 can still carry a refusal inside the transplant report; the panel
  // passes the report through rather than hiding it.
  const hooks = await panel.dispatchPanel(
    new Request('http://127.0.0.1' + PREFIX + '/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(REPO, 'fixtures', 'claude-hooks-mcp') }),
    }),
    config,
  )
  const hooksBody = await hooks.json()
  assert.equal(hooks.status, 200, JSON.stringify(hooksBody))
  assert.equal(hooksBody.report.totals.refused, 1)

  // Method rules and shapes through the same dispatch the routes use.
  assert.equal((await panel.dispatchPanel(new Request(`http://127.0.0.1${PREFIX}/install`))).status, 405)
  assert.equal((await panel.dispatchPanel(new Request(`http://127.0.0.1${PREFIX}/install`, { method: 'PUT' }))).status, 405)
  assert.equal((await panel.dispatchPanel(new Request(`http://127.0.0.1${PREFIX}/unknown`))).status, 404)
  const bad = await panel.dispatchPanel(new Request(`http://127.0.0.1${PREFIX}/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  }))
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'invalid-body')
  const huge = await panel.dispatchPanel(
    new Request(`http://127.0.0.1${PREFIX}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(70 * 1024),
    }),
  )
  assert.equal(huge.status, 413)
  assert.equal((await huge.json()).code, 'body-too-large')
})

test('the controller mounts the panel before it checks for a lock', async () => {
  const box = makeBox()
  try {
    const panel = await loadPanel(box)
    const config = { installs: join(box.home, 'anyplugin', 'installs.yml'), home: box.home, projectDir: box.project }
    // A bare probe shaped like the pin's `webServer` service: the controller's
    // own inject callback is what applies the panel, so applying it here first
    // would register the routes twice. No test boots a real web server (the
    // harness tree is never started with one), so this asserts the controller
    // asks for ['webServer'] and that the panel registers the two routes in
    // the documented `register({ kind, path, resource | handler })` shape.
    const mounted = mountServer(() => {}, config)
    let asked
    await panel.apply(
      {
        loader: {},
        get() {
          return undefined
        },
        inject(names, callback) {
          asked = names
          callback(mounted.ctx)
        },
      },
      config,
    )
    // A fresh profile has no installs.yml yet; the panel is how its first
    // plugin gets installed, so the mount must precede the early return.
    assert.deepEqual(asked, ['webServer'])
    assert.deepEqual(mounted.routes.map((route) => route.path), [PREFIX, `${PREFIX}/install`])
    assert.equal(existsSync(config.installs), false)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('client half is a served dsh.client bundle and renders the lock', async (t) => {
  const harness = resolveHarness()
  const skip = harness === undefined
    ? harnessSkipReason()
    : !existsSync(join(harness.harnessDir, 'dsh-client-modules', 'lib', 'client.js'))
      ? 'the harness tree has no dsh-client-modules; run `node scripts/fetch-harness.mjs <version>`'
      : false
  if (skip) {
    t.skip(skip)
    return
  }
  const harnessDir = harness.harnessDir

  const box = makeBox()
  t.after(() => rmSync(box.root, { recursive: true, force: true }))
  const panel = await loadPanel(box)
  const config = { installs: box.installs, home: box.home, projectDir: box.project }
  const { ctx: serverCtx } = mountServer(panel.applyPanel, config)
  t.after(() => serverCtx.dispose())

  // Install first, so the panel has something real to show.
  const install = await panel.dispatchPanel(
    new Request(`http://127.0.0.1${PREFIX}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: FIXTURE }),
    }),
    config,
  )
  const installBody = await install.json()
  assert.equal(install.status, 200, JSON.stringify(installBody))

  const { Context } = await import(pathToFileURL(join(harnessDir, 'cordis', 'lib', 'index.js')).href)
  const { default: Loader } = await import(pathToFileURL(join(harnessDir, 'cordis-plugin-loader', 'lib', 'index.js')).href)
  const { ClientModuleRegistry } = await import(pathToFileURL(join(harnessDir, 'dsh-client-modules', 'lib', 'index.js')).href)

  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
  })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.plugin(Loader, { baseUrl: pathToFileURL(join(box.root, 'cordis.yml')).href })
  const loader = await until(() => ctx.loader, 'the loader service')
  // The same row now carries both halves (D77): boot it with the temp profile's
  // paths so the controller reconciles the lock the direct dispatch just wrote.
  await loader.create({
    id: 'panel',
    name: 'dsh-anyplugin',
    config: { installs: box.installs, home: box.home, projectDir: box.project },
  })
  await loader.await()
  await sleep(60)
  await ctx.plugin(ClientModuleRegistry)
  const registry = ctx.clientModules

  const graph = registry.graph()
  const entry = graph.entries.find((row) => row.id === 'dsh-anyplugin')
  assert.ok(entry, 'the root package composed a dsh.client row')
  // The loader resolves the package symlink to the checkout it points at, so
  // the served file is the real package location, not the box's link.
  const packageRoot = realpathSync(join(box.root, 'node_modules', 'dsh-anyplugin'))
  assert.equal(registry.clientPath('dsh-anyplugin'), join(packageRoot, 'lib', 'client.js'))

  const batch = graph.batches.flatMap((row) => row.entries).includes('dsh-anyplugin')
    ? graph.batches.find((row) => row.entries.includes('dsh-anyplugin')).url
    : graph.batches[0].url
  const served = await registry.fetchBundle(new Request(new URL(batch, 'http://dsh.invalid/')))
  assert.equal(served.status, 200)
  const bytes = await served.text()
  assert.match(bytes, /window\.__ModuleLoader__\.load\(/)
  assert.match(bytes, /settings\.section/)

  const { react, render } = hookRuntime()
  const client = await browser(harnessDir, registry, graph, { react })
  const exports = await client.import('dsh-anyplugin')
  // The array was built in the vm realm; compare its contents, not its prototype.
  assert.deepEqual(Array.from(exports.inject), ['slots', 'shortcuts'])

  const declared = new Set()
  const registered = []
  const shortcuts = []
  const slots = {
    register(options, component) {
      // The shipped SlotCore's rule: a bare register throws until a parent (or
      // this plugin's own `inject`) declares the slot.
      if (!declared.has(options.name)) {
        throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
      }
      registered.push({ options, component })
      return () => {
        const index = registered.findIndex((row) => row.options === options)
        if (index !== -1) registered.splice(index, 1)
      }
    },
    inject(name, factory) {
      declared.add(name)
      const cleanup = factory()
      return () => {
        cleanup?.()
        declared.delete(name)
      }
    },
  }
  // The pin's declarable-command service: a register returns its disposer.
  const shortcutsService = {
    register(command) {
      shortcuts.push(command)
      return () => {
        const index = shortcuts.indexOf(command)
        if (index !== -1) shortcuts.splice(index, 1)
      }
    },
  }
  const dispose = exports.apply({ slots, shortcuts: shortcutsService })
  // Three registrations: the settings section, the keyed `main` pane and the
  // additive overlay line. The bridge is additive; it does not replace either.
  assert.equal(registered.length, 3)
  const settings = registered.find((row) => row.options.name === 'settings.section')
  const pane = registered.find((row) => row.options.name === 'main')
  const overlay = registered.find((row) => row.options.name === 'shell.overlay')
  assert.ok(settings && pane && overlay)
  assert.equal(settings.options.id, 'anyplugin-ui')
  assert.equal(settings.options.order, 45)
  assert.equal(settings.options.label(), 'AnyPlugin')
  assert.equal(pane.options.key, 'anyplugin.renderer')
  assert.equal(overlay.options.id, 'anyplugin.renderer')
  assert.ok(declared.has('settings.section'), 'the client declared the slot before registering')
  assert.ok(declared.has('main') && declared.has('shell.overlay'), 'the bridge declared its two mounting slots')
  // One keyboard command goes through the real `ctx.shortcuts` service shape.
  assert.equal(shortcuts.length, 1)
  assert.equal(shortcuts[0].id, 'anyplugin.renderer.request')
  // Arrays built in the vm realm carry the vm's prototypes; compare contents.
  assert.deepEqual(Array.from(shortcuts[0].regions), ['page'])
  assert.equal(typeof shortcuts[0].resolve, 'function')

  // The panel's `fetch` is the server half's own dispatch: one JSON contract,
  // no second HTTP shape invented by the test.
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push([String(url), init.method ?? 'GET'])
    return panel.dispatchPanel(new Request(new URL(url, 'http://127.0.0.1'), init), config)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  let tree = render(settings.component, true)
  assert.match(textOf(tree), /AnyPlugin/)
  assert.match(textOf(tree), /No foreign plugins installed\./)
  await sleep(20)
  tree = render(settings.component)
  assert.match(textOf(tree), /skills-only/)
  assert.match(textOf(tree), /claude-code/)
  assert.match(textOf(tree), /0\.0\.1/)
  assert.match(textOf(tree), /enabled at user/)
  assert.deepEqual(calls, [[`${PREFIX}/installs`, 'GET']])

  const input = findAll(tree, (node) => node.type === 'input')[0]
  assert.ok(input, 'the panel renders the install path field')
  input.props.onChange({ target: { value: FIXTURE } })
  tree = render(settings.component)
  const form = findAll(tree, (node) => node.type === 'form')[0]
  assert.ok(form, 'the panel renders the install form')
  await form.props.onSubmit({ preventDefault() {} })
  await sleep(20)
  tree = render(settings.component)
  assert.match(textOf(tree), new RegExp(`installed ${ID}`))
  assert.deepEqual(calls.at(-1), [`${PREFIX}/install`, 'POST'])

  // The hooks fixture carries an exec component the default trust rules
  // refuse; the install still succeeds, and the panel must say so instead of
  // showing a bare "installed".
  const hooksPath = join(REPO, 'fixtures', 'claude-hooks-mcp')
  const hooksInstall = await panel.dispatchPanel(
    new Request('http://127.0.0.1' + PREFIX + '/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: hooksPath }),
    }),
    config,
  )
  const hooksBody = await hooksInstall.json()
  const refusing = hooksBody.report.components.find((component) => component.refused)
  assert.equal(hooksBody.report.totals.refused, 1)
  assert.ok(refusing?.reason, 'the refused component carries a reason')
  input.props.onChange({ target: { value: hooksPath } })
  tree = render(settings.component)
  const hooksForm = findAll(tree, (node) => node.type === 'form')[0]
  await hooksForm.props.onSubmit({ preventDefault() {} })
  await sleep(20)
  tree = render(settings.component)
  assert.match(textOf(tree), /installed claude-code:hooks-mcp; 1 component refused/)
  assert.ok(textOf(tree).includes(refusing.reason), 'the panel shows the refusing reason')
  assert.deepEqual(calls.at(-1), [`${PREFIX}/install`, 'POST'])

  // Disposing the plugin runs the cleanup the inject handshake returned.
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(registered.length, 0, 'the slot registrations were removed on dispose')
  assert.equal(shortcuts.length, 0, 'the keyboard command was disposed with the plugin')
})
