# dsh-anyplugin-ui

The optional AnyPlugin panel: a `dsh.client` bundle plus the small server half
that answers it. It lists the foreign plugins recorded in
`$DSH_HOME/anyplugin/installs.yml` (name, dialect, version, enablement) and
installs one from a local path.

It is a **separate package on purpose**. D61 names it a separately published
optional artifact; the root `dsh-anyplugin` tarball has a 180 KiB budget (D59)
and the client bundle belongs to the browser. Install this package only if you
want the UI:

```sh
npm install -g dsh-anyplugin-ui@0.2.0 dsh-anyplugin@0.2.0
# then add "dsh-anyplugin-ui" to dsh.profile.bundles in ~/.dsh/profiles/<name>/package.json
```

## Surface

- `GET /anyplugin/installs` — the lock as the panel table reads it.
- `POST /anyplugin/install` — `{"path": "/local/plugin"}`; the path goes through
  `dsh-anyplugin/install` (the same `installPlugin` the CLI calls), so the
  manifest, version, compile and grant checks are the CLI's. The panel ignores
  client-supplied scope/grant fields; an install writes the `user` layer.
- The panel registers itself in the `settings.section` slot through the shipped
  `ctx.slots.inject` handshake; no foreign code is loaded in the server process.
- The install route is same-origin only: `application/json` is required, a
  foreign `Origin` / cross-site `Sec-Fetch-Site` is refused, and the body is
  capped at 64 KiB while streaming.

The server half loads `dsh-anyplugin/install` — the subpath D61 ratifies —
lazily, so a profile that never opens the panel does not pay for the install
pipeline. `projectDir` defaults to the server's `cwd`; a web server started
outside the workspace must pass `projectDir` in the plugin config, otherwise
the project enablement layer is read from the wrong tree.

## Development

The client bundle is emitted by the repository's `scripts/build.mjs` from
`src/client/index.js` (esbuild, CJS wrapped in
`window.__ModuleLoader__.load`). `npm run check:ui` enforces the panel's own
64 KiB tarball ceiling and file list. `npm run pack:ui` stages `lib/`, points
`exports["."]` at `./lib/index.js` (the repository manifest keeps
`./src/index.ts` for R7) and prints the publishable tarball; the panel test
runs the copied package in that publish-time shape.
