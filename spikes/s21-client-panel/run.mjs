// S21: can a third-party bundle register a client module through
// `window.__ModuleLoader__.load({ id, factory })` and be mounted by the Desktop
// UI and by `dsh web`, with the bundle served by the host's `/plugins` route
// from an enabled Loader entry, without rebuilding the harness? (issue #147)
//
// The question is not "does the harness have a client API" (it does:
// `@deepseek-ai/dsh-client-modules` is a dual-face package). The question is
// whether *we* can use it as a third party. The spike therefore does not read
// the docs and stop; it boots the pinned host halves and drives the exact
// handshake a browser shell performs:
//
//   1. boot a real cordis `Context` + the real `Loader`, with a fixture package
//      under `fixtures/node_modules/` that declares `dsh.client` and exports
//      `./client` (the shape the harness documents for third-party bundles);
//   2. boot the host half of `dsh-client-modules`, which composes every enabled
//      Loader entry into `window.__DSH_BOOT__` and registers a `/plugins` route
//      on the injected `webServer` (a probe service here);
//   3. fetch the advertised combo URL through that route and check the bytes,
//      cache headers, HEAD, 404 and 405 behaviour;
//   4. execute the harness's *browser* half (`lib/client.js`) inside a `vm`
//      sandbox, hand it the composed boot graph, and let it import the fixture
//      through the served URL — the same `loadBundle` callback a browser uses;
//   5. call the materialized plugin's `apply(ctx)` with a slot probe and render
//      the registered component;
//   6. mutate the fixture four ways and keep the exact refusal of each.
//
// A negative answer would be a passing spike: the checks would record the
// composition refusing the third-party package, and the report would answer
// "no". The positive path passing is what makes S21 a yes.
//
// Run:
//   node scripts/fetch-harness.mjs 0.2.2-rc.5
//   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
//     node spikes/s21-client-panel/run.mjs
//
// The spike stays: it is the artifact behind the S21 row in
// docs/ARCHITECTURE.md §10 and must be re-run when the pin moves.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VERSION = process.env.DSH_HARNESS_VERSION?.trim() || '0.2.2-rc.5'
const FIXTURE = join(HERE, 'fixtures', 'node_modules', 'anyplugin-s21-panel')
const PACKAGE = 'anyplugin-s21-panel'
const QUESTION =
  'can a third-party bundle register a client module through window.__ModuleLoader__.load({ id, factory }) and be mounted by the Desktop UI and by dsh web, with the bundle served by the host\'s /plugins route from an enabled Loader entry, without rebuilding the harness?'

// Packages this spike imports (not just reads).
const REQUIRED = ['cordis', 'cordis-plugin-loader', 'dsh-client-modules']

function candidates(root) {
  return [join(root, 'node_modules', '@deepseek-ai'), join(root, '@deepseek-ai'), root, dirname(root)]
}
function missingIn(candidate) {
  return REQUIRED.filter((name) => !existsSync(join(candidate, name, 'package.json')))
}
function locateHarness() {
  const explicit = process.env.DSH_HARNESS_DIR?.trim()
  if (explicit) {
    const root = resolve(explicit)
    const candidate = candidates(root).find((dir) => missingIn(dir).length === 0)
    if (candidate === undefined) {
      console.error(`DSH_HARNESS_DIR=${root} is set but unusable (missing: ${missingIn(candidates(root)[0]).join(', ')})`)
      console.error('the S21 packages are in the fetched union; run: node scripts/fetch-harness.mjs 0.2.2-rc.5')
      process.exit(2)
    }
    return { dir: candidate, source: 'DSH_HARNESS_DIR' }
  }
  const roots = []
  const install = process.env.DSH_INSTALL_DIR?.trim()
  if (install) roots.push([resolve(install), 'DSH_INSTALL_DIR'])
  roots.push([join(REPO, '.harness', VERSION), '.harness'])
  for (const [root, source] of roots) {
    const candidate = candidates(root).find((dir) => missingIn(dir).length === 0)
    if (candidate !== undefined) return { dir: candidate, source }
  }
  console.error(`no usable harness: ${roots.map(([root, source]) => `${source}=${root}`).join(', ')}`)
  console.error(`missing: ${missingIn(candidates(roots[0][0])[0]).join(', ')}`)
  console.error('run: node scripts/fetch-harness.mjs 0.2.2-rc.5')
  process.exit(2)
}

const { dir: HARNESS, source: HARNESS_SOURCE } = locateHarness()
const pkg = (name) => import(pathToFileURL(join(HARNESS, name, 'lib', 'index.js')).href)
const source = (name, file) => readFileSync(join(HARNESS, name, 'src', file), 'utf8')
const versionOf = (name) => JSON.parse(readFileSync(join(HARNESS, name, 'package.json'), 'utf8')).version
const lineOf = (text, needle) => {
  const index = text.indexOf(needle)
  return index === -1 ? -1 : text.slice(0, index).split('\n').length
}

const { Context } = await pkg('cordis')
const { default: Loader } = await pkg('cordis-plugin-loader')
const { ClientModuleRegistry } = await pkg('dsh-client-modules')

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
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
const readJson = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const writeJson = (dir, value) => writeFileSync(join(dir, 'package.json'), `${JSON.stringify(value, null, 2)}\n`)

/**
 * Boot one host generation: temp profile root + fixture package + Loader entry +
 * the real client-module registry. `mutate(dir)` rewrites the copied fixture
 * before the Loader sees it.
 */
async function boot({ mutate = () => {}, entryId = 'panel', entryName = PACKAGE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 's21-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 's21-spike-profile', private: true })}\n`)
  const dir = join(root, 'node_modules', PACKAGE)
  cpSync(FIXTURE, dir, { recursive: true })
  mutate(dir)

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
  const loader = ctx.loader
  await loader.create({ id: entryId, name: entryName, config: {} })
  await loader.await()
  await sleep(60)

  let error = null
  try {
    await ctx.plugin(ClientModuleRegistry)
  } catch (cause) {
    error = cause
  }
  return { root, ctx, loader, registry: ctx.clientModules, routes, error }
}

async function dispose(booted) {
  try {
    await booted.ctx.dispose()
  } catch {
    // A disposal failure must not hide the measurement; the temp root goes anyway.
  }
  rmSync(booted.root, { recursive: true, force: true })
}

/**
 * The browser shell as far as module registration is concerned: the page's
 * `window.__ModuleLoader__` queue facade, the harness's own client bundle, and
 * a `loadBundle` that fetches through the host route instead of the network.
 */
function browser(registry, graph) {
  const seed = { react: { createElement: (type, props, ...children) => ({ type, props, children }) } }
  const document = {
    createElement: () => ({ set src(_) {}, set async(_) {}, addEventListener() {}, remove() {} }),
    head: { append() {} },
    querySelectorAll: () => [],
  }
  const sandbox = { console: { error() {}, warn() {}, log() {} }, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout, Promise, document }
  sandbox.window = sandbox
  const context = vm.createContext(sandbox)
  let system
  let imported = false
  const facade = {
    mode: 'queue',
    pendingQueue: [],
    load(registration) {
      if (this.mode !== 'queue') throw new Error('client-modules: the shell accepted a bundle after boot')
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
      imported = true
      this.mode = 'live'
      return system
    },
  }
  sandbox.__ModuleLoader__ = facade
  sandbox.window.__ModuleLoader__ = facade

  const modulesBundle = join(HARNESS, 'dsh-client-modules', 'lib', 'client.js')
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

  return {
    get booted() {
      return imported
    },
    async import(specifier) {
      return system.import(specifier)
    },
    apply(exports) {
      const registered = []
      const injected = []
      const ctx = {
        slots: {
          inject(key, register) {
            injected.push(key)
            register()
          },
          register(options, component) {
            registered.push({ options, component })
            return () => {}
          },
        },
      }
      exports.apply(ctx)
      return { injected, registered }
    },
  }
}

async function main() {
  const anchors = {
    route: `dsh-client-modules/src/index.ts:${lineOf(source('dsh-client-modules', 'index.ts'), "const PLUGIN_ROUTE = '/plugins'")}`,
    routeRegistration: `dsh-client-modules/src/index.ts:${lineOf(source('dsh-client-modules', 'index.ts'), 'webCtx.webServer.register({ kind: \'prefix\', path: PLUGIN_ROUTE')}`,
    fetchBundle: `dsh-client-modules/src/index.ts:${lineOf(source('dsh-client-modules', 'index.ts'), 'async fetchBundle(request: Request): Promise<Response>')}`,
    compose: `dsh-client-modules/src/index.ts:${lineOf(source('dsh-client-modules', 'index.ts'), 'private compose(): WebBootGraph')}`,
    missingExport: `dsh-client-modules/src/index.ts:${lineOf(source('dsh-client-modules', 'index.ts'), 'declares dsh.client but exports no "./client" bundle')}`,
    createSystem: `dsh-client-modules/src/client/index.ts:${lineOf(source('dsh-client-modules', 'client/index.ts'), 'export function createClientModuleSystem(')}`,
    missedModule: `dsh-client-modules/src/client/system.ts:${lineOf(source('dsh-client-modules', 'client/system.ts'), 'missed the module table')}`,
  }

  // ---------------------------------------------------------------- positive
  const positive = await boot()
  let graph
  let batch
  try {
    const fiber = positive.loader.resolve('panel')?.fiber
    check(
      'an enabled Loader entry resolves a package that declares dsh.client',
      Boolean(fiber),
      `entry "panel" -> ${join(positive.root, 'node_modules', PACKAGE)} @ ${versionOf('dsh-client-modules')}`,
    )
    check(
      'the registry starts without a harness edit and registers the /plugins prefix route',
      positive.registry !== undefined &&
        positive.routes.some((route) => route.kind === 'prefix' && route.path === '/plugins'),
      `routes=${JSON.stringify(positive.routes.map((route) => ({ kind: route.kind, path: route.path })))}`,
    )

    graph = positive.registry.graph()
    batch = graph.batches.find((row) => row.entries.includes(PACKAGE))
    const entry = graph.entries.find((row) => row.id === PACKAGE)
    check(
      'the host composes the package into window.__DSH_BOOT__',
      graph.rev.length > 0 && entry !== undefined && batch !== undefined,
      `rev=${graph.rev} release=${graph.release?.version}/${graph.release?.commit}`,
    )
    check(
      'the composed row advertises a revisioned /plugins URL',
      entry?.url.startsWith(`plugins/??${PACKAGE}/client.js&rev=`) === true &&
        /^[0-9a-f]{12}$/.test(entry.rev),
      `url=${entry?.url} rev=${entry?.rev}`,
    )
    const disk = positive.registry.clientPath(PACKAGE)
    check(
      'clientPath resolves the prebuilt bundle on disk',
      disk === join(positive.root, 'node_modules', PACKAGE, 'client', 'client.js') &&
        readFileSync(disk, 'utf8').includes(`id: '${PACKAGE}'`),
      disk,
    )

    const request = new Request(new URL(batch.url, 'http://dsh.invalid/'))
    const response = await positive.registry.fetchBundle(request)
    const body = await response.text()
    check(
      'the host serves the bundle from /plugins with an immutable cache header',
      response.status === 200 &&
        response.headers.get('content-type') === 'text/javascript; charset=utf-8' &&
        response.headers.get('cache-control') === 'public, max-age=31536000, immutable',
      `${response.status} ${response.headers.get('content-type')} ${response.headers.get('cache-control')} ${body.length} B`,
    )
    check(
      'the served bytes are the client factory, not a rewritten module',
      body.includes('window.__ModuleLoader__.load') && body.includes('AnyPlugin S21 fixture panel'),
      `contains the registration and the fixture text`,
    )
    const head = await positive.registry.fetchBundle(new Request(request.url, { method: 'HEAD' }))
    check(
      'HEAD answers the same status without a body',
      head.status === 200 && (await head.text()) === '',
      `${head.status}, ${(await head.text()).length} B body`,
    )
    const stale = await positive.registry.fetchBundle(
      new Request(new URL(batch.url.replace(/rev=[0-9a-f]+/u, 'rev=000000000000'), 'http://dsh.invalid/')),
    )
    check('a URL for an unknown revision is 404, not a static file read', stale.status === 404, `${stale.status}`)
    const post = await positive.registry.fetchBundle(new Request(request.url, { method: 'POST' }))
    check('the bundle route is read-only', post.status === 405, `${post.status}`)

    // ------------------------------------------------------- browser shell
    const shell = browser(positive.registry, graph)
    const client = await shell.import(PACKAGE)
    check(
      'the harness browser half materializes the served bundle as a cordis plugin',
      client.inject?.includes('slots') === true && typeof client.apply === 'function',
      `inject=${JSON.stringify(client.inject)} apply=${typeof client.apply}`,
    )
    const mounted = shell.apply(client)
    check(
      'apply registers the fixture panel in settings.section',
      mounted.injected[0] === 'settings.section' &&
        mounted.registered[0]?.options.name === 'settings.section' &&
        mounted.registered[0]?.options.id === PACKAGE,
      `injected=${JSON.stringify(mounted.injected)} registered=${mounted.registered[0]?.options.id}`,
    )
    const tree = mounted.registered[0].component()
    check(
      'the registered component renders from the platform React seed only',
      tree?.type === 'div' && tree.props?.className === PACKAGE && tree.children?.[0] === 'AnyPlugin S21 fixture panel',
      `${tree?.type}.${tree?.props?.className}(${JSON.stringify(tree?.children)})`,
    )

    // The row exists only while the Loader entry is active: removing the entry
    // must drop the boot row, which is the "from an enabled Loader entry" half.
    await positive.loader.remove('panel')
    await until(() => positive.registry.graph().entries.length === 0, 'the removed entry to leave the boot graph', 3000)
    check(
      'removing the Loader entry drops the boot row (the bundle is not served from a stale table)',
      positive.registry.graph().entries.length === 0,
      `entries=${positive.registry.graph().entries.length}`,
    )
  } finally {
    await dispose(positive)
  }

  // --------------------------------------------------------------- mutations
  const mutations = []
  const mutation = async (name, expected, mutate) => {
    let observed = ''
    let ok = false
    let booted
    try {
      booted = await boot({ mutate })
      const result = await mutate.observe(booted)
      observed = result.observed
      ok = expected.test(observed)
    } catch (cause) {
      observed = cause?.message ?? String(cause)
      ok = expected.test(observed)
    } finally {
      if (booted !== undefined) await dispose(booted)
    }
    mutations.push({ name, expected: expected.source, observed, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  mutation ${name} — ${observed}`)
  }
  const noDshClient = (dir) => {
    const manifest = readJson(dir)
    delete manifest.dsh.client
    writeJson(dir, manifest)
  }
  noDshClient.observe = async (booted) => ({
    observed: `entries=${booted.error === null ? booted.registry.graph().entries.length : `error ${booted.error.message}`}`,
  })
  await mutation('the package does not declare dsh.client', /^entries=0$/u, noDshClient)

  const platformNode = (dir) => {
    const manifest = readJson(dir)
    manifest.dsh.client.platform = 'node'
    writeJson(dir, manifest)
  }
  platformNode.observe = noDshClient.observe
  await mutation('dsh.client.platform is node, not web', /^entries=0$/u, platformNode)

  const noClientExport = (dir) => {
    const manifest = readJson(dir)
    delete manifest.exports['./client']
    writeJson(dir, manifest)
  }
  noClientExport.observe = async (booted) => ({ observed: booted.error?.message ?? 'no error' })
  await mutation(
    'the package declares dsh.client but exports no ./client',
    /declares dsh\.client but exports no "\.\/client" bundle/u,
    noClientExport,
  )

  const wrongId = (dir) => {
    const file = join(dir, 'client', 'client.js')
    writeFileSync(file, readFileSync(file, 'utf8').replace(`id: '${PACKAGE}'`, `id: '${PACKAGE}-other'`))
  }
  wrongId.observe = async (booted) => {
    const shell = browser(booted.registry, booted.registry.graph())
    try {
      await shell.import(PACKAGE)
      return { observed: 'import resolved' }
    } catch (cause) {
      return { observed: cause.message }
    }
  }
  await mutation(
    'the served bundle registers a different id',
    /loaded without registering "anyplugin-s21-panel"/u,
    wrongId,
  )

  const report = {
    harness: HARNESS,
    source: HARNESS_SOURCE,
    version: versionOf('dsh-client-modules'),
    pins: ['0.2.2-rc.5', '0.2.2-rc.2'],
    question: QUESTION,
    answer:
      'yes on both pins: an enabled Loader entry whose package declares dsh.client { platform: "web" } and exports a built ./client bundle is composed into window.__DSH_BOOT__ and served from /plugins; the harness browser half materializes the factory and cordis applies the returned plugin to a slot — no harness file changes. The host serves built bytes only, so the bundle must be built by the package before install; and when the Node-internals addon is unavailable the Loader resolves the manifest through require("<name>/package.json"), so the package must export ./package.json.',
    anchors,
    checks,
    mutations,
    notes: [
      'The browser half is executed in a vm context with a stub window.__ModuleLoader__ queue and a stub document, not in Electron. Pixel rendering is not exercised; the Desktop UI and `dsh web` share this module table, and the shell that boots it is outside this spike.',
      'The probe webServer is a plain service that records the register() call; the real webServer route requires the same { kind: "prefix", path: "/plugins" } registration, which the pinned source performs at the anchor above.',
      'The fixture is copied into a temp profile root because a bare Loader name resolves through the baseUrl package scope; the spike never writes into the harness tree.',
    ],
  }
  mkdirSync(join(HERE, 'out'), { recursive: true })
  writeFileSync(join(HERE, 'out', 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const failed = [...checks, ...mutations].filter((entry) => !entry.ok)
  console.log(`\n${checks.length + mutations.length - failed.length}/${checks.length + mutations.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
