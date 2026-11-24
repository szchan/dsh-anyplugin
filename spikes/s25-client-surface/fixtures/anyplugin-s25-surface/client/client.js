/**
 * S25 fixture client half: a classic page script registered through the pinned
 * bundle loader (`window.__ModuleLoader__.load({id, factory})`), exactly the
 * shape the shipped panel uses (`packages/dsh-anyplugin-install/src/client/panel.js`,
 * D77/D81). The handler body below only uses the declared client surfaces:
 *
 * - `ctx.slots.inject` + `ctx.slots.register` — a `main` keyed pane and a
 *   `shell.overlay` list entry (the seats `dsh-client-ui-layout` declares);
 * - `ctx.shortcuts.register` / `registerFixed` / `observeFixedInput` — the
 *   declared keyboard command surface;
 * - `fetch` — the plugin issues the host round trip itself. jsdom has no fetch,
 *   so run.mjs bridges Node's real fetch into the page realm under
 *   `window.__S25_HOST_ORIGIN__`; the request still crosses a loopback socket to
 *   the plugin's own host half (the Electron IPC transport is read, not run).
 *
 * Everything it records lands on the page global so run.mjs can assert what the
 * mounted tree actually did rather than trusting a flag set before registration.
 */
window.__ModuleLoader__.load({
  id: 'anyplugin-s25-surface',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function Pane(props) {
      // `usePanelInfo` is a host-composed standard prop of a root-scope keyed
      // slot: the pane reads the host layout's selection through its own hook.
      const active = props.usePanelInfo(info => info.activePanelId)
      const [clicks, setClicks] = React.useState(0)
      const [focused, setFocused] = React.useState(false)
      const renders = React.useRef(0)
      renders.current += 1
      // A DOM mount point is what a plugin would need to draw outside React;
      // record whether any kit prop hands one over. The element tree below is
      // drawn with React only.
      const page = window
      const domProp = Object.values(props).some((value) => value instanceof page.Node || value instanceof page.Element)
      page.__S25_PANE__ = {
        renders: renders.current,
        propKeys: Object.keys(props).sort(),
        domProp,
        clicks,
        focused,
      }
      return h('div', {
        'data-s25-pane': '',
        'data-s25-active': active === null ? '' : String(active),
        'data-s25-hooks': typeof props.usePanelInfo === 'function' ? 'yes' : 'no',
        'data-s25-renders': String(renders.current),
        'data-s25-clicks': String(clicks),
        'data-s25-focused': focused ? 'yes' : 'no',
        'data-s25-prop-keys': Object.keys(props).join(','),
      },
      // The element tree the issue asks for: a container with text, a button
      // whose React handler commits state, and an input that takes DOM focus.
      h('div', { 'data-s25-container': '' },
        h('span', { 'data-s25-text': '' }, 'S25 pane text'),
        h('button', {
          type: 'button',
          'data-s25-button': '',
          onClick: () => setClicks(value => value + 1),
        }, 'S25 button'),
        h('input', {
          'data-s25-input': '',
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
        }),
      ))
    }

    function Overlay() {
      return h('div', { 'data-s25-overlay': '' }, 'S25 overlay')
    }

    return {
      inject: ['slots', 'shortcuts'],
      apply(ctx) {
        const page = window

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 's25-pane' }, Pane))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 's25-overlay' }, Overlay))

        // The plugin's own host channel: the client half calls fetch itself and
        // records the response the plugin's host half returned.
        const hostOrigin = page.__S25_HOST_ORIGIN__
        page.__S25_CLIENT_FETCH__ = { state: 'pending', origin: typeof hostOrigin === 'string' ? hostOrigin : null, via: 'page-realm' }
        if (typeof hostOrigin === 'string') {
          fetch(`${hostOrigin}/s25/resource`).then(async (response) => {
            page.__S25_CLIENT_FETCH__ = {
              state: 'done',
              status: response.status,
              ok: response.ok,
              body: await response.json(),
              via: 'page-realm',
            }
          }).catch((cause) => {
            page.__S25_CLIENT_FETCH__ = { state: 'error', message: String(cause?.message ?? cause), via: 'page-realm' }
          })
        } else {
          page.__S25_CLIENT_FETCH__ = { state: 'error', message: 'the harness did not provide window.__S25_HOST_ORIGIN__', via: 'page-realm' }
        }

        // A configurable command: the host arbitrates the default binding for
        // this profile and calls resolve() with the DOM target context.
        ctx.shortcuts.register({
          id: 's25.ping',
          label: () => 'S25 ping',
          aliases: ['s25 ping'],
          defaults: {
            'web:macos': { code: 'KeyP', modifiers: ['primary', 'alt'] },
            'web:windows': { code: 'KeyP', modifiers: ['primary', 'alt'] },
            'web:linux': { code: 'Slash', modifiers: ['primary'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: (context) => {
            page.__S25_CONTEXT__ = {
              region: context.region,
              modal: context.modal,
              target: context.target === null ? null : context.target.tagName,
            }
            return {
              status: 'handled',
              run: () => { page.__S25_RUNS__ = (page.__S25_RUNS__ ?? 0) + 1 },
            }
          },
        })

        // A fixed command: a read-only reference the page controls may advertise.
        ctx.shortcuts.registerFixed({
          id: 's25.fixed',
          label: () => 'S25 fixed',
          keys: ['F9'],
          bindings: [{ code: 'F9', modifiers: [] }],
          group: 'application',
        })
        // observeFixedInput is the declared input feed: the fixture receives
        // the arbitrated gesture plus the DOM target and can consume it.
        ctx.shortcuts.observeFixedInput((input) => {
          if (input.type === 'reset') return
          page.__S25_FIXED__ = {
            code: input.gesture.code,
            region: input.context.region,
            modal: input.context.modal,
            target: input.context.target === null ? null : input.context.target.tagName,
          }
          // Only the fixed command this pane owns consumes its gesture; the
          // configurable command's dispatch must see an unconsumed event.
          if (input.gesture.code === 'F9') input.consume()
        })
      },
    }
  },
})
