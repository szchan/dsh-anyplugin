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
//   the panel package's `dsh.client` row, run the harness's real browser half
//   in a `vm`, import the served bundle through it, and render the registered
//   component against a `fetch` that calls the server half's own dispatch.
//
// Visual Electron pixels are out of scope (S21 records the same limit); this
// test proves the handshake and the data, not a screenshot.
import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

import { readEnablements, readInstalls } from '../../dsh-anyplugin-install/src/index.ts'
import { harnessSkipReason, resolveHarness } from '../../dsh-anyplugin-conformance/src/harness.ts'

const REPO = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const PANEL = join(REPO, 'packages', 'dsh-anyplugin-ui')
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
 * A profile-shaped temp root: the panel is copied into `node_modules/` (a
 * symlink would resolve the realpath and lose the `dsh-anyplugin` lookup), and
 * the published plugin is linked beside it so `dsh-anyplugin/install` resolves
 * through its `exports` map to the built `lib/install.js`.
 */
function makeBox() {
  const root = mkdtempSync(join(tmpdir(), 'anyplugin-ui-'))
  const home = join(root, 'home')
  const project = join(root, 'workspace')
  const empty = join(root, 'empty')
  for (const dir of [home, project, empty]) mkdirSync(dir, { recursive: true })
  const nodeModules = join(root, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  symlinkSync(REPO, join(nodeModules, 'dsh-anyplugin'), 'dir')
  cpSync(PANEL, join(nodeModules, 'dsh-anyplugin-ui'), {
    recursive: true,
    filter: (source) => !source.includes(`${sep}node_modules`),
  })
  // A profile can only import built JavaScript. The repo manifest keeps
  // exports["."] = ./src/index.ts (R7); the publish-time manifest points at
  // lib, and that is the shape a real install must use. Rewrite the copy only.
  const copied = join(nodeModules, 'dsh-anyplugin-ui', 'package.json')
  const manifest = JSON.parse(readFileSync(copied, 'utf8'))
  manifest.exports['.'] = './lib/index.js'
  writeFileSync(copied, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'anyplugin-ui-test', private: true })}\n`)
  return {
    root,
    home,
    project,
    empty,
    installs: join(home, 'anyplugin', 'installs.yml'),
    entry: join(nodeModules, 'dsh-anyplugin-ui', 'lib', 'index.js'),
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

function streamRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  stream.method = method
  stream.url = url
  stream.headers = body === undefined ? {} : { 'content-type': 'application/json' }
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

async function callHandler(handler, method, url, body) {
  const response = fakeResponse()
  await handler(streamRequest(method, url, body), response)
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
  const { routes, ctx } = mountServer(panel.apply, config)
  t.after(() => ctx.dispose())

  const listRoute = routes.find((route) => route.kind === 'prefix' && route.path === PREFIX)
  const installRoute = routes.find((route) => route.kind === 'exact' && route.path === `${PREFIX}/install`)
  assert.ok(listRoute, 'the panel registers the /anyplugin prefix')
  assert.ok(installRoute, 'the panel registers the POST install route')

  const empty = await listRoute.resource(new Request(`http://panel.invalid${PREFIX}/installs`))
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

  const listed = await listRoute.resource(new Request(`http://panel.invalid${PREFIX}/installs`))
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

  // Method rules and shapes through the same dispatch the routes use.
  assert.equal((await panel.dispatch(new Request(`http://panel.invalid${PREFIX}/install`))).status, 405)
  assert.equal((await panel.dispatch(new Request(`http://panel.invalid${PREFIX}/install`, { method: 'PUT' }))).status, 405)
  assert.equal((await panel.dispatch(new Request(`http://panel.invalid${PREFIX}/unknown`))).status, 404)
  const bad = await panel.dispatch(new Request(`http://panel.invalid${PREFIX}/install`, { method: 'POST', body: 'not json' }))
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'invalid-body')
  const huge = await panel.dispatch(
    new Request(`http://panel.invalid${PREFIX}/install`, { method: 'POST', body: 'x'.repeat(70 * 1024) }),
  )
  assert.equal(huge.status, 413)
  assert.equal((await huge.json()).code, 'body-too-large')
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
  const { ctx: serverCtx } = mountServer(panel.apply, config)
  t.after(() => serverCtx.dispose())

  // Install first, so the panel has something real to show.
  const install = await panel.dispatch(
    new Request(`http://panel.invalid${PREFIX}/install`, {
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
  await loader.create({ id: 'panel', name: 'dsh-anyplugin-ui', config: {} })
  await loader.await()
  await sleep(60)
  await ctx.plugin(ClientModuleRegistry)
  const registry = ctx.clientModules

  const graph = registry.graph()
  const entry = graph.entries.find((row) => row.id === 'dsh-anyplugin-ui')
  assert.ok(entry, 'the panel package composed a dsh.client row')
  assert.equal(registry.clientPath('dsh-anyplugin-ui'), join(box.root, 'node_modules', 'dsh-anyplugin-ui', 'lib', 'client.js'))

  const batch = graph.batches.flatMap((row) => row.entries).includes('dsh-anyplugin-ui')
    ? graph.batches.find((row) => row.entries.includes('dsh-anyplugin-ui')).url
    : graph.batches[0].url
  const served = await registry.fetchBundle(new Request(new URL(batch, 'http://dsh.invalid/')))
  assert.equal(served.status, 200)
  const bytes = await served.text()
  assert.match(bytes, /window\.__ModuleLoader__\.load\(/)
  assert.match(bytes, /settings\.section/)

  const { react, render } = hookRuntime()
  const client = await browser(harnessDir, registry, graph, { react })
  const exports = await client.import('dsh-anyplugin-ui')
  // The array was built in the vm realm; compare its contents, not its prototype.
  assert.deepEqual(Array.from(exports.inject), ['slots'])

  const registered = []
  exports.apply({
    slots: {
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
      inject(_key, register) {
        register()
      },
    },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'anyplugin-ui')
  assert.equal(registered[0].options.order, 45)
  assert.equal(registered[0].options.label(), 'AnyPlugin')

  // The panel's `fetch` is the server half's own dispatch: one JSON contract,
  // no second HTTP shape invented by the test.
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push([String(url), init.method ?? 'GET'])
    return panel.dispatch(new Request(new URL(url, 'http://panel.invalid'), init), config)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  let tree = render(registered[0].component, true)
  assert.match(textOf(tree), /AnyPlugin/)
  assert.match(textOf(tree), /No foreign plugins installed\./)
  await sleep(20)
  tree = render(registered[0].component)
  assert.match(textOf(tree), /skills-only/)
  assert.match(textOf(tree), /claude-code/)
  assert.match(textOf(tree), /0\.0\.1/)
  assert.match(textOf(tree), /enabled at user/)
  assert.deepEqual(calls, [[`${PREFIX}/installs`, 'GET']])

  const input = findAll(tree, (node) => node.type === 'input')[0]
  assert.ok(input, 'the panel renders the install path field')
  input.props.onChange({ target: { value: FIXTURE } })
  tree = render(registered[0].component)
  const form = findAll(tree, (node) => node.type === 'form')[0]
  assert.ok(form, 'the panel renders the install form')
  await form.props.onSubmit({ preventDefault() {} })
  await sleep(20)
  tree = render(registered[0].component)
  assert.match(textOf(tree), new RegExp(`installed ${ID}`))
  assert.deepEqual(calls.at(-1), [`${PREFIX}/install`, 'POST'])
})
