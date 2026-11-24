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
 * - plain `fetch` for the host round trip (the panel's own channel).
 *
 * Everything it records lands on the page global so run.mjs can assert that
 * the bundle ran in the page realm rather than in a stub of it.
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
      return h('div', {
        'data-s25-pane': '',
        'data-s25-active': active === null ? '' : String(active),
        'data-s25-render-slot': typeof props.renderSlot === 'function' ? 'yes' : 'no',
        'data-s25-hooks': typeof props.usePanelInfo === 'function' ? 'yes' : 'no',
        // A DOM mount point is what a plugin would need to draw outside React;
        // record whether any kit prop hands one over.
        'data-s25-dom-prop': ['container', 'node', 'domNode', 'rootElement', 'hostElement']
          .some((name) => props[name] !== undefined) ? 'yes' : 'no',
        'data-s25-prop-keys': Object.keys(props).join(','),
      }, 'S25 pane')
    }

    function Overlay() {
      return h('div', { 'data-s25-overlay': '' }, 'S25 overlay')
    }

    return {
      inject: ['slots', 'shortcuts'],
      apply(ctx) {
        const page = window
        page.__S25__ = { applied: true, inject: this.inject }

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 's25-pane' }, Pane))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 's25-overlay' }, Overlay))

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
