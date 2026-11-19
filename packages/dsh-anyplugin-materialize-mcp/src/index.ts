/**
 * MCP materializer — the plugin's MCP servers, connected by us (D12).
 *
 * Why not `dsh-mcp-client`: it namespaces tools as `mcp__<serverName>__<tool>`
 * and caps `serverName` at 32 characters, so Claude's plugin-scoped name
 * `mcp__plugin_<plugin>_<server>__<tool>` would be truncated or hashed. S5
 * showed the cap is that plugin's config schema, not the runtime, so this
 * materializer connects directly and registers the exact name.
 *
 * Consequences we own (D12): connection lifecycle, reconnect, cancellation and
 * timeouts. The budget rule is enforced here because the runtime does not
 * enforce it: a name that cannot be presented to a model is `unsupported`, never
 * renamed.
 */

export const name = 'anyplugin-materialize-mcp'
export const inject = ['tools']

/** The contract both Claude and the model provider apply to a tool name. */
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface Config {
  /** The upstream plugin name; it is part of every tool name. */
  plugin?: string
  /** Directory holding `@modelcontextprotocol/client`, when a bare import fails. */
  sdkRoot?: string
  servers?: McpServerConfig[]
}

/** `mcp__plugin_<plugin>_<server>__<raw>`, byte for byte like Claude Code. */
export function composeToolName(plugin: string, server: string, raw: string): string {
  return `mcp__plugin_${plugin}_${server}__${raw}`
}

/**
 * Return why a composed name cannot be presented, or `undefined` when it can.
 * Over budget is reported, never repaired: a renamed tool is a passing smoke
 * test and a false claim (D11).
 */
export function toolNameProblem(plugin: string, server: string, raw: string): string | undefined {
  const composed = composeToolName(plugin, server, raw)
  if (!TOOL_NAME.test(composed)) {
    return `tool name ${JSON.stringify(composed)} (${composed.length} chars) does not match ${String(TOOL_NAME)} — the provider would reject it`
  }
  return undefined
}

/** `${NAME}` and `${NAME:-default}` from `process.env`; anything else is literal. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, key: string, fallback?: string) => {
    const found = env[key]
    if (found !== undefined) return found
    return fallback ?? ''
  })
}

function expandRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (record === undefined) return undefined
  const expanded: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) expanded[key] = expandEnv(value)
  return expanded
}

interface Sdk {
  Client: any
  StdioClientTransport: any
  StreamableHTTPClientTransport: any
}

async function loadModule(specifier: string, sdkRoot: string | undefined, file: string): Promise<any> {
  try {
    return await import(specifier)
  } catch (error) {
    if (sdkRoot === undefined) throw error
    return import(new URL(`file://${sdkRoot}/@modelcontextprotocol/client/dist/${file}`).href)
  }
}

async function loadSdk(sdkRoot: string | undefined): Promise<Sdk> {
  const [client, stdio] = await Promise.all([
    loadModule('@modelcontextprotocol/client', sdkRoot, 'index.mjs'),
    loadModule('@modelcontextprotocol/client/stdio', sdkRoot, 'stdio.mjs'),
  ])
  return {
    Client: client.Client,
    StreamableHTTPClientTransport: client.StreamableHTTPClientTransport,
    StdioClientTransport: stdio.StdioClientTransport,
  }
}

function transportOf(server: McpServerConfig, sdk: Sdk): any {
  if (server.transport === 'stdio') {
    return new sdk.StdioClientTransport({
      command: server.command,
      args: server.args,
      env: expandRecord(server.env),
      cwd: server.cwd,
    })
  }
  return new sdk.StreamableHTTPClientTransport(new URL(server.url as string), {
    requestInit: server.headers === undefined ? undefined : { headers: expandRecord(server.headers) },
  })
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text)
    .join('\n')
}

/** The canonical result shape: text plus any structured payload. */
function output() {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    },
    render(_args: unknown, value: any) {
      return [{ type: 'text', text: textOf(value?.content) }]
    },
  }
}

function definition(ctx: any, client: any, publicName: string, tool: any) {
  return {
    name: publicName,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? { type: 'object' },
    output: output(),
    async execute(args: unknown, execution?: { signal?: AbortSignal }) {
      const result = await client.callTool(
        { name: tool.name, arguments: args ?? {} },
        execution?.signal === undefined ? undefined : { signal: execution.signal },
      )
      if (result?.isError === true) throw new Error(textOf(result.content) || `MCP tool ${tool.name} failed`)
      return result
    },
  }
}

/**
 * Connect one server, register its tools, and return a disposer that removes
 * every registration and closes the client.
 *
 * Registration happens after `tools/list`, so it is asynchronous; the disposer
 * is synchronous and safe to call before the listing resolves (it aborts, and
 * a listing that lands later sees `closed`).
 */
function attach(ctx: any, server: McpServerConfig, plugin: string, sdkRoot: string | undefined): () => void {
  let closed = false
  const disposers: Array<() => void> = []
  let client: any

  const start = async () => {
    const sdk = await loadSdk(sdkRoot)
    client = new sdk.Client({ name: 'dsh-anyplugin', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transportOf(server, sdk))
    // Disposed while the handshake was in flight: nothing will observe these
    // tools, so close the transport instead of leaving a child process behind.
    if (closed) {
      await client.close().catch(() => {})
      return
    }
    const listed = await client.listTools()
    if (closed) return
    for (const tool of listed.tools ?? []) {
      const problem = toolNameProblem(plugin, server.name, tool.name)
      if (problem !== undefined) {
        ctx.logger?.warn?.(`anyplugin-mcp(${server.name}): ${problem}`)
        continue
      }
      disposers.push(ctx.tools.register(definition(ctx, client, composeToolName(plugin, server.name, tool.name), tool)))
    }
  }

  void start().catch((error: unknown) => {
    if (closed) return
    const message = error instanceof Error ? error.message : String(error)
    // A server that cannot start is a visible degradation, not a silent one.
    ctx.logger?.warn?.(`anyplugin-mcp(${server.name}): ${message}`)
  })

  return () => {
    closed = true
    for (const dispose of disposers.splice(0)) dispose()
    const closing = client?.close?.()
    if (closing !== undefined && typeof closing.catch === 'function') closing.catch(() => {})
  }
}

export function apply(ctx: any, config: Config = {}): void {
  const plugin = config.plugin ?? 'unknown'
  for (const server of config.servers ?? []) {
    ctx.effect(() => attach(ctx, server, plugin, config.sdkRoot))
  }
}
