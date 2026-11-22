/**
 * S21 fixture client half: the official `dsh.client` bundle shape
 * (window.__ModuleLoader__.load({ id, factory })). It is a plain classic
 * script, never imported as an ES module.
 */
window.__ModuleLoader__.load({
  id: 'anyplugin-s21-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function Panel() {
      return h('div', { className: 'anyplugin-s21-panel' }, 'AnyPlugin S21 fixture panel')
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'anyplugin-s21-panel',
          order: 90,
          label: () => 'AnyPlugin',
        }, Panel))
      },
    }
  },
})
