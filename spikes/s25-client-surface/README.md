# S25 — what renderer surface can a client plugin reach?

**Question.** A DSH *client* plugin — one that lives outside the installation,
like our panel — gets loaded into the page realm of the web shell. What can it
actually do there? At the pinned versions (`0.2.2-rc.2` Desktop, extracted tree;
`0.2.2-rc.5` npm), can it:

1. register a pane / render site of its own and be mounted by the host layout;
2. draw its own React element tree there (a container with text, a button and an
   input) and get real DOM click and focus events;
3. receive keyboard events, and move focus itself on the elements it drew;
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

node scripts/fetch-harness.mjs 0.2.2-rc.2
DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.2 DSH_HARNESS_VERSION=0.2.2-rc.2 \
  npm run spike:s25
```

CI runs both pins (the `S25 client-surface spike` steps in
`.github/workflows/verify.yml`). Without `DSH_HARNESS_DIR` the spike falls back
to `DSH_INSTALL_DIR` and then to `.harness/<version>`; the Desktop install only
carries the packages the shipped page prebuilds, so the fetched union is the
supported path. The spike reads the installed `dsh-host-webserver` version out
of the resolved tree and refuses to run unless it equals
`DSH_HARNESS_VERSION`, so pointing a run at one pin's tree while naming the
other fails at startup instead of labelling the output with the wrong pin.

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
  the version both fetched pins resolve, asserted from the loaded React, not
  assumed;
- the page realm is **jsdom** (31.0.1), so the frame is mounted through
  `ctx.uiRenderer.mount(container)` and React renders for real. The page's DOM
  events are real jsdom objects: a synthesized `MouseEvent` click runs the
  pane's React handler, `HTMLElement.focus()` moves `document.activeElement`
  and fires its React focus handler, and `KeyboardEvent` drives the shortcut
  surface. The published client stack is client-DOM-only: its bundled
  `useSyncExternalStore` shim passes no `getServerSnapshot`, so
  `react-dom/server` refuses to render it. jsdom is the probe's page, not the
  Desktop browser; that difference is listed under what is not proved;
- the host channel is a **real `dsh-host-webserver`** on an ephemeral loopback
  port, so the fixture's host half registers real routes and the probe checks
  them over a raw TCP socket as well as `fetch`, not a stubbed route table. The
  fixture's client half then calls its own host route with `fetch` from inside
  the page realm; jsdom has no `fetch`, so the probe injects the Node realm's
  `fetch` into the page and records the round trip (the Electron IPC transport
  that serves this in the Desktop shell is read, not exercised).

The real web shell boots additional packages the spike does not need (session
UI, theme, locale). Those services are stubbed, and each stub is named where it
is used: `theme` (a snapshot the frame's `ThemePresenter` can read), `locale`
(identity translations + a boot-once locale face), the `session` scope adapter
(an absent session) and the `sessions` root hook (an empty roster so
`DocumentTitle` can run). The `dsh-client-ui-primitives` module is a **partial
seed**, and it *is* on the keyboard path: the shortcuts bundle requires only
`modalSelector` and `observeComposition` from it, and those two helpers are
loaded from the pinned package's authored TypeScript for real (copied out of
the tree so Node can import them with type stripping), seeded into the page
realm as that module, and then executed and asserted from the page (check 22:
the selector matches a dialog and a menu in order; the composition guard goes
true during composition and false after it). The rest of the module's exports
(its CSS-module imports, markdown and terminal helpers) are not loaded. The
theme/locale/session stubs are not on the pane, mount, DOM-event, keyboard or
HTTP paths the executing checks measure.

## Answer

**A derived renderer bridge is partially buildable inside this repo.** A client
plugin outside the installation can own a keyed `main` pane and an additive
`shell.overlay` surface, be mounted by the real host layout, draw a React
element tree there (a container holding text, a button and an input; a real DOM
click runs the button's React handler and commits state, and a real `focus()`
call lands on the input and runs its React focus handler), register
configurable and fixed keyboard commands, and round-trip HTTP with its own host
half — including a `fetch` the plugin's client half issues from the page realm.
It cannot get a host-owned DOM mount point, a pane geometry feed, a focus
primitive, or a redraw-pacing primitive;
those stay page-DOM work that the plugin does itself, and the *host-owned* layout
model, focus routing and invalidate throttling that §7.3 lists as still ahead are
outside what a client plugin can reach.

### Primitives available / primitives missing

| Capability | Verdict | Evidence anchor (pin) | What it would take to get it |
| --- | --- | --- | --- |
| 1. Register a pane / render site and be mounted by the host layout | **available** | `dsh-client-ui-layout/src/client/index.ts:197` (`'main': { kind: 'keyed', scope: 'root' }`), `:200` (`'shell.overlay': { kind: 'list', scope: 'root' }`), `AppFrame.tsx:49` (keyed outlet), `:281` (overlay outlet) @rc.2/rc.5; live: fixture registers both, `layout.selectPanel('s25-pane')` selects it, mounted frame renders it | Nothing new in the host: add `ctx.slots.inject('main'/'shell.overlay', …)` registrations to our client bundle (the panel already registers `settings.section`). A sidebar nav entry is the same pattern via the `sidebar.panellist` list slot (`dsh-client-ui-plugin-manager/src/client/index.ts:129-175`). |
| 2. Receive a DOM or React mount point and draw its own React element tree | **partially** | React component seat: `AppFrame.tsx:49` + live mount; standard hooks observed in the pane: `usePanelInfo`, `useSessions`, `renderFactorySlot` (prop-key allowlist asserted exactly, live). The mounted pane draws `div[data-s25-container]` with text, a button and an input (live: markup bytes 1301, tag sequence asserted), a real DOM click runs the button's React handler and commits state, and a real `focus()` call lands on the input and runs its React focus handler. **No** container/node/domElement prop — no prop value is a `Node`/`Element` and the prop-key set is asserted (live; `dsh-client-ui-renderer/src/client/registry.ts:37` describes seats, not nodes). Page realm is same-origin classic script: `dsh-client-modules/src/client/system.ts:28` (`document.head.append(el)`). | React content: already available — the pane draws its own element tree and its own handlers. Raw DOM mount point: no host-provided node; create your own container inside the pane component (React ref / `document.createElement`) — no host change, but also no host-owned mount point to draw into. |
| 3. Receive keyboard events and move focus on its own elements | **partially** | Declared keyboard surface: `ctx.shortcuts.register` / `registerFixed` / `observeFixedInput` (`dsh-client-shortcuts/src/client/index.ts`), context target/region/modal (`src/client/types.ts:13` `target: Element \| null`), DOM adapter `src/client/dom.ts:97`; live: real `KeyboardEvent` runs the fixture command and the fixed feed delivers `{code:'F9',region:'page',target:'BODY'}`. Focus itself is page-DOM: live, `input.focus()` on the element the pane drew moves `document.activeElement` and runs its React handler. No focus primitive: `focusin` only resets pending sequences (`dom.ts:97`); no declared focus service was found in the installed client packages. | Keyboard commands: already available (declare defaults for the profiles we care about; Web defaults are restricted — `dsh-client-shortcuts/src/binding.ts:96`). Focus movement: use the DOM on the element the component rendered; a host focus-routing primitive does not exist and would be a host change (§7.3 "focus routing … still ahead"). |
| 4. Read layout size / observe resize | **partially** | No geometry prop on a keyed `main` entry (live: kit props are `usePanelInfo,useSessions,renderFactorySlot,children`). Width/viewport props exist only on the occupied single seats, e.g. `AppFrame.tsx:322` (`rightbar` gets `{width, viewportWidth, canShow}`); the frame itself measures with `ResizeObserver` + rAF (`AppFrame.tsx:143-155`) at rc.2/rc.5. | Observe the pane's own box in the page realm (`ResizeObserver` / `getBoundingClientRect` on our element, as the frame does); a host-declared pane geometry feed would be a host change. |
| 5. Request animation frames / pace redraws | **available in the page realm only** | The frame paces with `requestAnimationFrame` (`dsh-client-ui-layout/src/client/AppFrame.tsx:99`, rAF-throttled measure `:143-155`) and the bundle runs in the page realm (`dsh-client-modules/src/client/system.ts:28`) @rc.2/rc.5. No host pacing/invalidate-throttle API is declared for client plugins. | Use the page `requestAnimationFrame` in our component. Host-owned invalidate throttling is explicitly still ahead in §7.3; nothing in the client bundle exposes it. |
| 6. Talk to the main process over a declared channel, incl. request/response | **available (own host half; the client half's fetch is proven from the page realm); generic host RPC is not reachable** | Own HTTP routes: live real `dsh-host-webserver` on loopback — the spy sees the host half register two exact routes with function disposers, a raw TCP request to the socket returns a 404 envelope for an unrouted path, `GET /s25/resource` returns 200, `POST` to it is 405, `POST /s25/echo` echoes the body (`dsh-host-webserver/src/index.ts:621` listen; `README.md:12` notes Desktop renders from `file://` and carries fetch over an IPC bridge); the fixture's **client half then calls** its own route with `fetch` from the page realm and records `{status:200, body:{ok:true}, via:'page-realm'}` (live). jsdom has no `fetch`, so the probe injects the Node realm's `fetch` into the page; the Electron IPC transport that serves this in the Desktop shell is read from the README, not exercised. The shipped panel does the host half exactly this way (`packages/dsh-anyplugin-install/src/panel.ts:355`). The generic `ctx.remote` RPC is build-time fixed (`dsh-api-remotes` README: the client does not discover host services at runtime). | For our own channel: nothing — register `webServer` routes in the host half and `fetch` them from the client half (shipped pattern; the spike proves the round trip through a page-realm `fetch` call). For a generic third-party Remote namespace: a host change (explicit `/remote` value import + mount in the shell assembly). |

### What is proven live vs. read

**Run at both pins (`0.2.2-rc.5`, `0.2.2-rc.2`): 40 checks each — 13 source
reads + 27 executing checks.**

The 13 source reads are checks 1–12 and 21; every bullet below runs. Seventeen
of the 27 executing checks — the ones a review questioned — were shown to be
non-vacuous by mutating the spike or its fixture and watching that check go red
(the landing PR records the mutation table: M1–M9). The other ten execute but
were not mutation-tested, so their non-vacuity is not claimed.
What executes:

- the host half's routes are real: `dsh-host-webserver` listens on an ephemeral
  loopback port (a raw TCP `GET` of an unrouted path gets an HTTP 404 envelope),
  the host half's two exact registrations are observed through the real
  `webServer.register`, and `GET` resource 200, `POST` resource 405,
  `POST /s25/echo` round-trips a JSON body;
- the plugin's client half issues its own `fetch` from the page realm to its
  host half's `/s25/resource` and records the 200 response body and origin;
- the Loader composes a real boot graph entry for the fixture and serves its
  `client.js` with the immutable revision URL;
- the harness browser-half module system materializes the fixture as a client
  plugin, and its `apply(ctx)` runs against the real `ctx.slots` (renderer's
  `SlotRegistry` over the real `SlotCore`), real `ctx.shortcuts`, real `ctx.layout`;
- the outside pane and overlay registrations are read back from that registry
  (`entries('main')`/`entries('shell.overlay')`, key `s25-pane`, id
  `s25-overlay`), and the frame's single `root` occupant is the real `AppFrame`;
- the pinned primitives helpers are executed in the page: the real
  `modalSelector` matches a dialog and a menu in order, and the real
  `observeComposition` guard goes true during composition and false after it;
- the real layout frame mounts through `ctx.uiRenderer.mount(container)` in jsdom
  with React 18.3.1 (asserted from the loaded React) and renders the outside
  bundle's pane in the keyed `main` outlet (with the layout selection applied)
  and the overlay in `shell.overlay`, both in the same frame; unmounting empties
  the container;
- the pane draws a foreign element tree — a container with text, a button and an
  input — whose markup bytes and tag sequence are asserted; a real `MouseEvent`
  click runs the button's React handler and commits state (`clicks=1`, render
  count increments); a real `input.focus()` makes it `document.activeElement`
  and runs its React focus handler; the pane's prop keys are exactly the
  standard hooks/factory-children seat and no prop value is a `Node`/`Element`;
- `layout.selectPanel` accepts the outside pane and refuses an unknown id with
  `layout.selectPanel: main panel "…" is not registered`;
- a real DOM `KeyboardEvent` dispatched into the page runs the fixture's
  configurable command with the arbitrated binding, region and `BODY` target,
  consumes it (`defaultPrevented`), and the fixed-input feed delivers `F9` to
  `observeFixedInput`;
- the keyboard catalog reports the fixture binding for the detected profile.

**Read from the host API surface, not run (checks 1–12 and 21):**

- the bundle becomes a same-origin classic page script in the *browser* page
  realm (`dsh-client-modules/src/client/system.ts:28`); the spike's page is
  jsdom, so real browser globals (pixels, real `document`, real event loop) are
  read, not observed;
- focus movement has no declared API: no installed `dsh-client-*` bundle
  provides a focus service (the check scans every installed client library);
  `focusin` only resets pending key sequences
  (`dsh-client-shortcuts/src/client/dom.ts:97`);
- pane geometry: no geometry prop reaches a keyed `main` entry (observed by the
  mounted pane's prop keys); the only layout-measurement source is the page DOM;
- the Desktop transport: `dsh-host-webserver/README.md:12` says Electron loads
  the dist over `file://` and carries fetch over an IPC bridge — the spike's
  loopback HTTP round trip and page-realm `fetch` do not exercise that bridge;
- the generic `ctx.remote` host RPC: capability set is fixed at build time
  (`dsh-api-remotes` README), so it is not a third-party channel without a host
  change;
- the primitives module's declared export shape: the probe loads the two
  helpers the shortcuts bundle requires and asserts their behaviour, but does
  not load the module's CSS-module imports, markdown or terminal helpers.

**Not proved at all:**

- no pixels, no Desktop/Electron renderer, no real browser: the frame is real,
  the DOM is jsdom, and the spike never launches the Desktop UI;
- no Electron preload bridge (`window.dshDesktop`) was used — this spike
  deliberately stays on declared client surfaces; the shortcut service's
  Desktop input path was not exercised (the spike runs the Web runtime), and the
  Electron IPC transport behind the page's `fetch` was not exercised either —
  the probe injects the Node realm's `fetch` into jsdom;
- session scope, theme runtime and locale plugin are stubbed (documented
  stubs), so claims about session-bound panes, live theming and translated
  labels are outside this spike;
- no plugin-issued `requestAnimationFrame` was observed: the plugin declares no
  redraw-pacing primitive to call, and the frame's own rAF throttling and
  invalidate coalescing are copied from the source anchors, not measured;
- nothing here measures drawing fidelity against Claude's TUI roles; that is
  S24 and the element-runtime gap in §7.3/§7.4.

## Files

- `run.mjs` — the executable probe (source-level anchors + host HTTP channel +
  Loader/bundle serving + client-stack boot + jsdom mount + real click/focus/
  keyboard events + tree-identity gate).
- `fixtures/anyplugin-s25-surface/` — the outside-install-shaped fixture: host
  half `index.js` (two `webServer` routes), `package.json` (mod patch + client
  platform), `cordis.patch.yml`, classic page-script `client/client.js`
  registering a keyed `main` pane that draws a container/text/button/input tree
  with React click and focus handlers, a `shell.overlay` entry, one configurable
  command, one fixed command, an input observer and a page-realm `fetch` call
  to its own host half.
