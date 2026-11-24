# S25 — what renderer surface can a client plugin reach?

**Question.** A DSH *client* plugin — one that lives outside the installation,
like our panel — gets loaded into the page realm of the web shell. What can it
actually do there? At the pinned versions (`0.2.2-rc.2` Desktop, extracted tree;
`0.2.2-rc.5` npm), can it:

1. register a pane / render site of its own and be mounted by the host layout;
2. receive a DOM or React mount point and render arbitrary content into it;
3. receive keyboard and focus events, and move focus programmatically;
4. read layout size / observe resize;
5. request animation frames or otherwise pace redraws;
6. talk to the main process (where the mod host runs) over a declared channel,
   including a request/response round trip.

This is issue #280; it feeds the "derived renderer bridge" question in
`docs/ARCHITECTURE.md` §7.3/§10. The spike is throwaway; nothing here ships.

## Run it

```bash
node scripts/fetch-harness.mjs 0.2.2-rc.5
DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 DSH_HARNESS_VERSION=0.2.2-rc.5 \
  npm run spike:s25
```

The same command with `0.2.2-rc.2` runs the rc.2 pin. CI runs both pins (the
`S25 client-surface spike` steps in `.github/workflows/verify.yml`). Without
`DSH_HARNESS_DIR` the spike falls back to `DSH_INSTALL_DIR` and then to
`.harness/<version>`; the Desktop install only carries the packages the shipped
page prebuilds, so the fetched union is the supported path.

## Method

The spike does not invent a loading path. It reuses the two precedents already
in this repo:

- the **fixture** is a mod-shaped package (`package.json` with
  `dsh.bundle.patch` + `dsh.client.platform: 'web'` + `exports['./client']`,
  `cordis.patch.yml`, host half `index.js`, classic page-script client half
  `client/client.js`), exactly the shape the shipped panel uses
  (`packages/dsh-anyplugin-install`, D77/D81);
- the **host side** boots the real Cordis context, the real
  `cordis-plugin-loader`, and the real `dsh-client-modules` registry, then
  serves the fixture bundle through the same composed boot graph and
  `/plugins` route S21 measured. The bundle is executed by the harness's own
  browser-half module loader in a `node:vm` page realm, not by a reimplementation.

New for S25, and what makes the mount claim executable rather than a read:

- the **real client stack** is executed too: `dsh-client-ui-renderer` (its
  `SlotRegistry` and `createSlotRenderer`), `dsh-client-ui-layout` (the
  `AppFrame` root occupant), and `dsh-client-shortcuts` (the keyboard service),
  with the real `dsh-client-ui-slots`, `dsh-client-store`, and React 18.3.1 —
  the identity the Desktop frontend bundle pins;
- the page realm is **jsdom** (31.0.1), so the frame is mounted through
  `ctx.uiRenderer.mount(container)` and React renders for real. The published
  client stack is client-DOM-only: its bundled `useSyncExternalStore` shim
  passes no `getServerSnapshot`, so `react-dom/server` refuses to render it.
  jsdom is the probe's page, not the Desktop browser; that difference is listed
  under what is not proved;
- the host channel is a **real `dsh-host-webserver`** on an ephemeral loopback
  port, so the fixture's host half registers real routes and the round trip is a
  real `fetch`, not a stubbed route table.

The real web shell boots additional packages the spike does not need (session
UI, theme, locale). Those services are stubbed, and each stub is named where it
is used: `theme` (a snapshot the frame's `ThemePresenter` can read), `locale`
(identity translations + a boot-once locale face), the `session` scope adapter
(an absent session), the `sessions` root hook (an empty roster so
`DocumentTitle` can run), and the `dsh-client-ui-primitives` helpers the
shortcuts bundle requires (their `lib/index.js` imports CSS modules, which Node
cannot load; the two helpers are copied from the pinned source and the spike
checks they are anchored there). None of the stubs is on the path being
measured — the pane registration, the mount, the keyboard dispatch and the HTTP
round trip all run through the real artifacts.

## Answer

**A derived renderer bridge is partially buildable inside this repo.** A client
plugin outside the installation can own a keyed `main` pane and an additive
`shell.overlay` surface, be mounted by the real host layout, draw arbitrary
React content there, register configurable and fixed keyboard commands, and
round-trip HTTP with its own host half. It cannot get a host-owned DOM mount
point, a pane geometry feed, a focus primitive, or a redraw-pacing primitive;
those stay page-DOM work that the plugin does itself, and the *host-owned* layout
model, focus routing and invalidate throttling that §7.3 lists as still ahead are
outside what a client plugin can reach.

### Primitives available / primitives missing

| Capability | Verdict | Evidence anchor (pin) | What it would take to get it |
| --- | --- | --- | --- |
| 1. Register a pane / render site and be mounted by the host layout | **available** | `dsh-client-ui-layout/src/client/index.ts:197` (`'main': { kind: 'keyed', scope: 'root' }`), `:200` (`'shell.overlay': { kind: 'list', scope: 'root' }`), `AppFrame.tsx:49` (keyed outlet), `:281` (overlay outlet) @rc.2/rc.5; live: fixture registers both, `layout.selectPanel('s25-pane')` selects it, mounted frame renders it | Nothing new in the host: add `ctx.slots.inject('main'/'shell.overlay', …)` registrations to our client bundle (the panel already registers `settings.section`). A sidebar nav entry is the same pattern via the `sidebar.panellist` list slot (`dsh-client-ui-plugin-manager/src/client/index.ts:129-175`). |
| 2. Receive a DOM or React mount point and render arbitrary content | **partially** | React component seat: `AppFrame.tsx:49` + live mount; standard hooks observed in the pane: `usePanelInfo`, `useSessions`, `renderFactorySlot`; **no** container/node/domElement prop — the pane's kit carries no DOM node (live check, and `dsh-client-ui-renderer/src/client/registry.ts:37` describes seats, not nodes). Page realm is same-origin classic script: `dsh-client-modules/src/client/system.ts:28` (`document.head.append(el)`). | React content: already available. Raw DOM drawing: create your own container element inside the pane component (React ref / `document.createElement`) and draw into it — no host change, but also no host-provided mount point to draw into. |
| 3. Receive keyboard and focus events; move focus programmatically | **partially** | Declared keyboard surface: `ctx.shortcuts.register` / `registerFixed` / `observeFixedInput` (`dsh-client-shortcuts/src/client/index.ts`), context target/region/modal (`src/client/types.ts:13` `target: Element \| null`), DOM adapter `src/client/dom.ts:97`; live: real `KeyboardEvent` runs the fixture command and the fixed feed delivers `{code:'F9',region:'page',target:'BODY'}`. No focus primitive: `focusin` only resets pending sequences (`dom.ts:97`); no declared focus service was found in the installed client packages. | Keyboard commands: already available (declare defaults for the profiles we care about; Web defaults are restricted — `dsh-client-shortcuts/src/binding.ts:96`). Focus movement: use the DOM on the element the component rendered; a host focus-routing primitive does not exist and would be a host change (§7.3 "focus routing … still ahead"). |
| 4. Read layout size / observe resize | **partially** | No geometry prop on a keyed `main` entry (live: kit props are `usePanelInfo,useSessions,renderFactorySlot,children`). Width/viewport props exist only on the occupied single seats, e.g. `AppFrame.tsx:322` (`rightbar` gets `{width, viewportWidth, canShow}`); the frame itself measures with `ResizeObserver` + rAF (`AppFrame.tsx:143-155`) at rc.2/rc.5. | Observe the pane's own box in the page realm (`ResizeObserver` / `getBoundingClientRect` on our element, as the frame does); a host-declared pane geometry feed would be a host change. |
| 5. Request animation frames / pace redraws | **available in the page realm only** | The frame paces with `requestAnimationFrame` (`dsh-client-ui-layout/src/client/AppFrame.tsx:99`, rAF-throttled measure `:143-155`) and the bundle runs in the page realm (`dsh-client-modules/src/client/system.ts:28`) @rc.2/rc.5. No host pacing/invalidate-throttle API is declared for client plugins. | Use the page `requestAnimationFrame` in our component. Host-owned invalidate throttling is explicitly still ahead in §7.3; nothing in the client bundle exposes it. |
| 6. Talk to the main process over a declared channel, incl. request/response | **available (own host half); generic host RPC is not reachable** | Own HTTP routes: live real `dsh-host-webserver` on loopback — host half registers exact routes, `POST /s25/echo` returns the echoed body, `GET /s25/resource` returns 200, `POST` to a resource route is 405 (`dsh-host-webserver/src/index.ts:621` listen; `README.md:12` notes Desktop renders from `file://` and carries fetch over an IPC bridge); the shipped panel does exactly this (`packages/dsh-anyplugin-install/src/panel.ts:355`). The generic `ctx.remote` RPC is build-time fixed (`dsh-api-remotes` README: the client does not discover host services at runtime). | For our own channel: nothing — register `webServer` routes in the host half and `fetch` them from the client half (shipped pattern). For a generic third-party Remote namespace: a host change (explicit `/remote` value import + mount in the shell assembly). |

### What is proven live vs. read

**Run at both pins (`0.2.2-rc.5`, `0.2.2-rc.2`), 33 checks each:**

- the host half's routes are real: `dsh-host-webserver` listens on an ephemeral
  loopback port; `GET` resource 200, `POST` resource 405, `POST /s25/echo`
  round-trips a JSON body;
- the Loader composes a real boot graph entry for the fixture and serves its
  `client.js` with the immutable revision URL;
- the harness browser-half module system materializes the fixture as a client
  plugin, and its `apply(ctx)` runs against the real `ctx.slots` (renderer's
  `SlotRegistry` over the real `SlotCore`), real `ctx.shortcuts`, real `ctx.layout`;
- the real layout frame mounts through `ctx.uiRenderer.mount(container)` in jsdom
  with React 18.3.1 and renders the outside bundle's pane in the keyed `main`
  outlet (with the layout selection applied) and the overlay in
  `shell.overlay`, both in the same frame;
- `layout.selectPanel` accepts the outside pane and refuses an unknown id with
  `layout.selectPanel: main panel "…" is not registered`;
- a real DOM `KeyboardEvent` dispatched into the page runs the fixture's
  configurable command with the arbitrated binding, region and `BODY` target,
  consumes it (`defaultPrevented`), and the fixed-input feed delivers `F9` to
  `observeFixedInput`;
- the keyboard catalog reports the fixture binding for the detected profile.

**Read from the host API surface, not run:**

- the bundle becomes a same-origin classic page script in the *browser* page
  realm (`dsh-client-modules/src/client/system.ts:28`); the spike's page is
  jsdom, so real browser globals (pixels, real `document`, real event loop) are
  read, not observed;
- focus movement: no declared focus API exists; `focusin` only resets pending
  key sequences (`dsh-client-shortcuts/src/client/dom.ts:97`);
- pane geometry: no geometry prop reaches a keyed `main` entry (observed by the
  mounted pane's prop keys); the only layout-measurement source is the page DOM;
- the Desktop transport: `dsh-host-webserver/README.md:12` says Electron loads
  the dist over `file://` and carries fetch over an IPC bridge — the spike's
  loopback HTTP round trip does not exercise that bridge;
- the generic `ctx.remote` host RPC: capability set is fixed at build time
  (`dsh-api-remotes` README), so it is not a third-party channel without a host
  change.

**Not proved at all:**

- no pixels, no Desktop/Electron renderer, no real browser: the frame is real,
  the DOM is jsdom, and the spike never launches the Desktop UI;
- no Electron preload bridge (`window.dshDesktop`) was used — this spike
  deliberately stays on declared client surfaces; the shortcut service's
  Desktop input path was not exercised (the spike runs the Web runtime);
- session scope, theme runtime and locale plugin are stubbed (documented
  stubs), so claims about session-bound panes, live theming and translated
  labels are outside this spike;
- the host layout's own performance characteristics (rAF throttling, invalidate
  coalescing) are copied from the source anchors, not measured;
- nothing here measures drawing fidelity against Claude's TUI roles; that is
  S24 and the element-runtime gap in §7.3/§7.4.

## Files

- `run.mjs` — the executable probe (source-level anchors + host HTTP channel +
  Loader/bundle serving + client-stack boot + jsdom mount + keyboard dispatch).
- `fixtures/anyplugin-s25-surface/` — the outside-install-shaped fixture: host
  half `index.js` (two `webServer` routes), `package.json` (mod patch + client
  platform), `cordis.patch.yml`, classic page-script `client/client.js`
  registering a keyed `main` pane, a `shell.overlay` entry, one configurable
  command, one fixed command and an input observer.
