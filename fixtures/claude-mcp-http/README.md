# claude-mcp-http

A fixture for the HTTP arm of the MCP materializer (D12). Claude's side only
declares the server; the tool schema is resolved at runtime, which is why the
golden says `not counted`.

`http-server.mjs` is a zero-dependency Streamable HTTP MCP server: stateless,
JSON responses, no server-initiated stream, one tool (`echo`). The test starts
it on an ephemeral port and hands the URL in through `${ANYPLUGIN_MCP_URL}` —
the fixture deliberately does not pin a port, and the variable exercises the
same expansion an author would use.

`claude-mcp-http` is not loaded by `claude` in any test; only `plugin details`
is asked for its inventory.
