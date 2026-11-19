// A minimal MCP stdio server used by fixtures.
//
// It exists so an MCP fixture can be *connected*, not merely declared: Claude
// lists a server without talking to it (`tool schemas resolved at runtime`),
// but DSH has to speak the protocol to register anything. Keeping it hand-rolled
// and dependency-free means the fixture does not drift with an SDK version and
// can be spawned by any host.
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout.

import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'ok',
    description: 'A tool whose composed name fits the shared 64-character limit.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'a_tool_name_that_is_far_too_long_for_the_budget',
    description: 'Its composed name exceeds 64 characters, so the materializer must refuse it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const handle = (message) => {
  if (message.id === undefined) return // a notification; nothing to answer
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      // Echo the client's version: this server has no version-specific behavior,
      // and refusing a version would test the fixture instead of the host.
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe', version: '1.0.0' },
        },
      })
      return
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `ok: ${String(params?.arguments?.text ?? '')}` }] },
      })
      return
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  try {
    handle(JSON.parse(line))
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
})
