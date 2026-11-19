// A minimal MCP server over the Streamable HTTP transport, for the HTTP arm of
// the MCP materializer. Zero dependencies on purpose: the fixture must be
// readable as the protocol, not as a framework.
//
// Stateless: every POST gets a JSON-RPC reply, no session id, no server-initiated
// messages. That is enough for tools/list and tools/call, which is the surface
// the materializer owns (D12).
import { createServer } from 'node:http'

const PROTOCOL_FALLBACK = '2025-06-18'

function reply(response, id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result })
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function failure(response, id, code, message) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function tools() {
  return [
    {
      name: 'echo',
      description: 'Echo the text back.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ]
}

function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    return {
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: 'http-probe', version: '0.0.0' },
      },
    }
  }
  if (method === 'tools/list') return { result: { tools: tools() } }
  if (method === 'tools/call') {
    const text = params?.arguments?.text ?? ''
    return {
      result: {
        content: [{ type: 'text', text: `echo: ${String(text)}` }],
      },
    }
  }
  return { error: { code: -32601, message: `method not found: ${String(method)}` } }
}

/** Start the server on an ephemeral port. Returns the URL and a closer. */
export async function startHttpServer(options = {}) {
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      // No server-initiated stream: the client must not wait for one.
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        failure(response, null, -32700, `parse error: ${error.message}`)
        return
      }
      // Notifications carry no id and expect no body.
      if (message.id === undefined) {
        response.writeHead(202)
        response.end()
        return
      }
      const { result, error } = handle(message)
      if (error) failure(response, message.id, error.code, error.message)
      else reply(response, message.id, result)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })

  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}
