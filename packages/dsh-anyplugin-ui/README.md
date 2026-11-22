# dsh-anyplugin-ui

The optional AnyPlugin panel: a `dsh.client` bundle plus the small server half
that answers it. It lists the foreign plugins recorded in
`$DSH_HOME/anyplugin/installs.yml` (name, dialect, version, enablement) and
installs one from a local path.

It is a **separate package on purpose**. The root `dsh-anyplugin` tarball has a
180 KiB budget (D59); the client bundle belongs to the browser and would not
fit. Install this package only if you want the UI:

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
- The panel registers itself in the `settings.section` slot; no foreign code is
  loaded in the server process.

The server half loads `dsh-anyplugin/install` lazily, so a profile that never
opens the panel does not pay for the install pipeline.

## Development

The client bundle is emitted by the repository's `scripts/build.mjs` from
`src/client/index.js` (esbuild, CJS wrapped in
`window.__ModuleLoader__.load`). The package's published manifest must point
`exports["."]` at `./lib/index.js`; the repository manifest keeps
`./src/index.ts` for tests (R7), and the publish step rewrites that field.
