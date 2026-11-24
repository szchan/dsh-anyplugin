/**
 * S25 fixture host half.
 *
 * The point is not the payload: it is that a package living outside the host
 * installation gets its own routes on the pinned `webServer` service, which is
 * the same service the shipped AnyPlugin panel uses
 * (`packages/dsh-anyplugin-install/src/panel.ts:355-362`). The run.mjs boots the
 * real `dsh-host-webserver` on an ephemeral loopback port, hands this `apply`
 * the service through a real cordis Context, and then round-trips HTTP through
 * it, so the read claim ("the panel's route pattern is reachable") is replaced
 * by an executed one at the pin.
 */

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // A resource route answers GET/HEAD only (the pinned service owns the 405).
  ctx.webServer.register({
    kind: 'exact',
    path: '/s25/resource',
    resource: async () => new Response(JSON.stringify({ ok: true, route: 'resource' }), {
      headers: { 'content-type': 'application/json' },
    }),
  })
  // A handler route owns the whole response: this is the request/response
  // round trip the shipped panel uses for its mutating install route.
  ctx.webServer.register({
    kind: 'exact',
    path: '/s25/echo',
    handler: async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const payload = JSON.stringify({ echo: body, method: request.method })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(payload)
    },
  })
}
