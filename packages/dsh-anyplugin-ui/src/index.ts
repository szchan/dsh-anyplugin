/**
 * The AnyPlugin panel's server half.
 *
 * It is a *reader of our own lifecycle API*: the grid is `listPlugins`, the
 * install form is `installPlugin`, the same functions the `dsh-anyplugin`
 * command calls. The panel never reads `installs.yml` with its own parser and
 * never writes a file itself — one writer per store (D49) stays true, and a
 * refusal is the same typed `InstallCliError` the CLI prints.
 *
 * The route answers only two things:
 *
 *   GET  /anyplugin/installs  what the lock and the enabled layers say today
 *   POST /anyplugin/install   install one plugin from a local directory
 *
 * The request comes from a browser, so the trust boundary is narrow: the only
 * client input is a path, the path is read through `installPlugin` (realpath,
 * manifest, version, compiler refusals), and scope/grant fields on the body
 * are ignored — the install always writes the `user` layer, exactly `install`.
 * The lock is re-read on every request; there is no cache to go stale.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'dsh-anyplugin-ui'

/** The web server; the panel is inert without it. */
export const inject = ['webServer']

export interface Config {
  /** The lock file. Default `$DSH_HOME/anyplugin/installs.yml`. */
  installs?: string
  /** `$DSH_HOME` override. */
  home?: string
  /** Workspace whose enablement layers apply. Default `process.cwd()`. */
  projectDir?: string
}

const PREFIX = '/anyplugin'
const INSTALLS = '/anyplugin/installs'
const INSTALL = '/anyplugin/install'
const MAX_BODY_BYTES = 64 * 1024

function paths(config: Config) {
  const home = config.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    home,
    projectDir: config.projectDir ?? process.cwd(),
    config: config.installs ?? join(home, 'anyplugin', 'installs.yml'),
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ ok: false, code: 'method-not-allowed', reason: `use ${allow}` }) + '\n', {
    status: 405,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      allow,
      'cache-control': 'no-store',
    },
  })
}

/** The lifecycle entry is lazy: a profile that never opens the panel pays nothing. */
async function lifecycle(): Promise<{
  listPlugins: (options: ReturnType<typeof paths>) => {
    ok: boolean
    file: string
    plugins: Array<Record<string, unknown> & { effective?: { enabled?: boolean; scope?: string | null } }>
  }
  installPlugin: (options: Record<string, unknown>) => Record<string, unknown>
}> {
  // Published by the `dsh-anyplugin` package's `./install` export; the panel is
  // an optional bundle that peers on the plugin, never on the private sources.
  return (await import('dsh-anyplugin/install')) as never
}

function summarize(plugin: Record<string, unknown> & { effective?: { enabled?: boolean; scope?: string | null } }) {
  const effective = plugin.effective ?? {}
  return {
    id: plugin.id,
    name: plugin.name,
    dialect: plugin.dialect,
    version: plugin.version,
    root: plugin.root,
    ...(plugin.source === undefined ? {} : { source: plugin.source }),
    enabledScopes: plugin.enabledScopes ?? [],
    enabled: effective.enabled === true,
    scope: effective.scope ?? null,
    ...(plugin.error === undefined ? {} : { error: plugin.error }),
  }
}

async function list(config: Config): Promise<Response> {
  try {
    const { listPlugins } = await lifecycle()
    const result = listPlugins(paths(config))
    return json({
      ok: result.ok,
      file: result.file,
      plugins: result.plugins.map((plugin) => summarize(plugin)),
    })
  } catch (error) {
    return json({ ok: false, code: 'read-failed', reason: reasonOf(error) }, 500)
  }
}

async function install(request: Request, config: Config): Promise<Response> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    return json({ ok: false, code: 'body-too-large', reason: `the install body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json({ ok: false, code: 'invalid-body', reason: 'the install body is not JSON' }, 400)
  }
  const path = typeof body === 'object' && body !== null ? (body as { path?: unknown }).path : undefined
  if (typeof path !== 'string' || path.trim() === '') {
    return json({ ok: false, code: 'invalid-body', reason: 'the install body needs a string "path"' }, 400)
  }
  // Everything else on the body (scope, grants, dialect, force) is deliberately
  // not read: the CLI's install defaults are the panel's contract.
  try {
    const { installPlugin } = await lifecycle()
    const result = installPlugin({
      pluginDir: path,
      config: paths(config).config,
      home: paths(config).home,
      projectDir: paths(config).projectDir,
      scope: 'user',
    })
    return json(result)
  } catch (error) {
    const typed = error as { name?: string; code?: string; hint?: string }
    if (typed?.name === 'InstallCliError' && typeof typed.code === 'string') {
      return json({ ok: false, code: typed.code, reason: reasonOf(error), ...(typed.hint === undefined ? {} : { hint: typed.hint }) }, 400)
    }
    return json({ ok: false, code: 'install-failed', reason: reasonOf(error) }, 500)
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One Fetch request in, one Fetch response out; the host's resource route uses this directly. */
export async function dispatch(request: Request, config: Config = {}): Promise<Response> {
  const url = new URL(request.url, 'http://anyplugin.invalid')
  if (url.pathname === INSTALLS) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
    return list(config)
  }
  if (url.pathname === INSTALL) {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return install(request, config)
  }
  return json({ ok: false, code: 'not-found', reason: `no route ${url.pathname}` }, 404)
}

function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  return headers
}

/**
 * A node handler for the one mutating route. `handler` routes own the full
 * response because a resource route only answers GET and HEAD; the body is
 * forwarded as a stream so the same `dispatch` path is the one under test.
 */
export function installRoute(config: Config = {}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET'
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const forwarded = new Request(`http://anyplugin.invalid${request.url ?? '/'}`, {
      method,
      headers: headersOf(request),
      ...(hasBody ? { body: request as unknown as ReadableStream, duplex: 'half' } : {}),
    } as RequestInit)
    const result = await dispatch(forwarded, config)
    response.writeHead(result.status, Object.fromEntries(result.headers))
    const bytes = Buffer.from(await result.arrayBuffer())
    response.end(method === 'HEAD' ? undefined : bytes)
  }
}

interface WebServerLike {
  register(route: unknown): () => void
}

interface PluginContextLike {
  effect(setup: () => () => void, label: string): void
  webServer: WebServerLike
}

export function apply(ctx: PluginContextLike, config: Config = {}): void {
  ctx.effect(() => {
    const offPanel = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      resource: (request: Request) => dispatch(request, config),
    })
    const offInstall = ctx.webServer.register({
      kind: 'exact',
      path: INSTALL,
      handler: installRoute(config),
    })
    return () => {
      offInstall()
      offPanel()
    }
  }, 'dsh-anyplugin-ui: panel routes')
}
